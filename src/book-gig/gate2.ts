// src/book-gig/gate2.ts — Gate 2 interactive review loop & draft copy approval enforcement (D-44, D-45, D-50)

import type {
  CandidateVenue,
  DraftFingerprintItem,
  Gate2ApprovalRecord,
  PitchEmail,
  TargetLocation,
  TargetWeekend,
  VenueTweak,
} from "./types.ts";
import {
  type BackendConfigOptions,
  computeDraftFingerprint,
  fetchGate2Approval,
  recordGate2Approval,
} from "./outreach_api.ts";
import { renderPitchesFromBackend } from "./pitch.ts";
import { matchesVenueFilter } from "./parser.ts";

export interface Gate2SessionOptions {
  weekend: TargetWeekend;
  location?: TargetLocation;
  candidates: CandidateVenue[];
  pitches: PitchEmail[];
  backendConfig?: BackendConfigOptions;
  fetchFn?: typeof fetch;
}

/**
 * Validates whether user-supplied input constitutes an explicit, affirmative
 * approval of the entire batch of draft emails in its entirety (D-45).
 *
 * Strict invariants:
 * - Approval is NEVER inferred from silence, empty input, or whitespace.
 * - Approval is NEVER inferred from tweak requests ("change venue X", "tweak Olde Salem").
 * - Approval is NEVER inferred from partial reviews ("Olde Salem looks good", "approved venue 1").
 * - Approval is NEVER inferred from venue-list approval ("I approve the venues", Gate 1).
 * - Approval is NEVER inferred from ambiguous passing remarks ("ok", "nice", "looks fine", "continue").
 */
export function isExplicitWholeBatchApproval(input: unknown): boolean {
  if (typeof input !== "string") return false;
  const trimmed = input.trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();

  // 1. Tweak requests cannot be approvals
  if (
    lower.includes("tweak") ||
    lower.includes("change") ||
    lower.includes("rewrite") ||
    lower.includes("modify") ||
    lower.includes("edit") ||
    lower.includes("custom body")
  ) {
    return false;
  }

  // 2. Venue-list / Gate 1 approvals cannot satisfy Gate 2
  if (
    lower.includes("gate 1") ||
    lower.includes("gate1") ||
    lower.includes("venue list") ||
    lower.includes("candidate list") ||
    lower.includes("target venues") ||
    lower.includes("approved the venues") ||
    lower.includes("approve the venues") ||
    lower.includes("venues approved")
  ) {
    return false;
  }

  // 3. Partial approval of individual venues cannot satisfy whole-batch approval
  if (
    /\b(for|only|just|except)\s+[a-z0-9]/i.test(lower) ||
    /\b(venue\s+\d+|venue\s+[a-z]+)/i.test(lower) ||
    /\b(looks\s+good\s+for|approved\s+for)\b/i.test(lower)
  ) {
    return false;
  }

  // 4. Bare passing remarks or conversational acknowledgments are not approvals
  const bareRemarks = [
    "ok",
    "okay",
    "k",
    "fine",
    "looks fine",
    "looks good",
    "looks okay",
    "sounds good",
    "nice",
    "cool",
    "checking",
    "reviewing",
    "next",
    "proceed",
    "continue",
    "go ahead",
    "send",
  ];
  if (bareRemarks.includes(lower)) {
    return false;
  }

  // 5. Positive whole-batch explicit approval patterns
  const wholeBatchPatterns = [
    /\b(approve|approved|approving)\s+(all|every|the\s+whole|the\s+entire|each\s+and\s+every)\s+(drafts?|emails?|pitches?|copy|batch)\b/i,
    /\b(approve|approved|approving)\s+(them\s+all|all\s+of\s+them)\s+(in\s+(their\s+)?entirety|in\s+full)\b/i,
    /\b(all|every)\s+(drafts?|emails?|pitches?|copy)\s+(are\s+)?(approved|explicitly\s+approved)\b/i,
    /\b(whole\s+batch|entire\s+batch)\s+(drafts?\s+)?(is\s+)?(approved|explicitly\s+approved)\b/i,
    /\bexplicitly\s+approve\s+(all|the\s+whole\s+batch|drafts?)\b/i,
    /\bapprove\s+the\s+whole\s+batch\b/i,
    /\bdrafts\s+approved\s+in\s+(their\s+)?entirety\b/i,
    /\bapproved\s+all\s+in\s+(their\s+)?entirety\b/i,
  ];

  return wholeBatchPatterns.some((p) => p.test(lower));
}

/**
 * Gate 2 Review Session: holds the interactive review loop, applies per-venue
 * custom-slot tweaks, re-renders copy without altering other venues, and
 * records server-side fingerprints only on explicit whole-batch approval (D-44, D-45).
 */
export class Gate2ReviewSession {
  weekend: TargetWeekend;
  location?: TargetLocation;
  candidates: CandidateVenue[];
  pitches: PitchEmail[];
  tweaks: Map<string, VenueTweak> = new Map();
  status: "holding" | "tweaked" | "approved" = "holding";
  gate2Record?: Gate2ApprovalRecord;
  private backendConfig?: BackendConfigOptions;
  private fetchFn: typeof fetch;

  constructor(options: Gate2SessionOptions) {
    this.weekend = options.weekend;
    this.location = options.location;
    this.candidates = [...options.candidates];
    this.pitches = [...options.pitches];
    this.backendConfig = options.backendConfig;
    this.fetchFn = options.fetchFn || fetch;
  }

  /**
   * Identifies an eligible candidate matching `venueQuery` (by _id or name).
   */
  findCandidate(venueQuery: string): CandidateVenue | undefined {
    const trimmed = venueQuery.trim();
    return this.candidates.find(
      (c) =>
        (c._id && String(c._id) === trimmed) ||
        (c.name && c.name.toLowerCase() === trimmed.toLowerCase()) ||
        matchesVenueFilter(c, [trimmed]),
    );
  }

  /**
   * Applies a copy tweak to a single venue, re-renders that venue's draft
   * through backend custom slots, and leaves all other venues' copy strictly
   * untouched (D-44).
   *
   * A tweak breaks any previously recorded Gate 2 approval and re-opens the gate.
   */
  async applyTweak(
    venueQuery: string,
    tweak: { customBody?: string; customIntro?: string; notes?: string },
  ): Promise<PitchEmail> {
    const candidate = this.findCandidate(venueQuery);
    if (!candidate) {
      throw new Error(
        `No eligible candidate venue found matching '${venueQuery}' to tweak draft copy`,
      );
    }

    const venueId = String(candidate._id);
    const existingTweak = this.tweaks.get(venueId) || {};
    const updatedTweak: VenueTweak = {
      venueId,
      venueName: candidate.name,
      customBody: tweak.customBody !== undefined ? tweak.customBody : existingTweak.customBody,
      customIntro: tweak.customIntro !== undefined ? tweak.customIntro : existingTweak.customIntro,
      notes: tweak.notes !== undefined ? tweak.notes : existingTweak.notes,
    };

    this.tweaks.set(venueId, updatedTweak);

    // Re-render pitches with the updated tweaks map
    const newPitches = await renderPitchesFromBackend(
      this.candidates,
      this.weekend,
      {
        backendUrl: this.backendConfig?.backendUrl,
        token: this.backendConfig?.token,
        tweaks: this.tweaks,
      },
      this.fetchFn,
    );

    this.pitches = newPitches;
    this.status = "tweaked";
    // A tweak breaks prior approval: re-open Gate 2
    this.gate2Record = undefined;

    const updatedPitch = this.pitches.find((p) => String(p.venueId) === venueId);
    if (!updatedPitch) {
      throw new Error(`Failed to retrieve re-rendered pitch for venue '${candidate.name}'`);
    }

    return updatedPitch;
  }

  /**
   * Computes content fingerprints for every draft in the batch.
   */
  computeFingerprints(): DraftFingerprintItem[] {
    return this.pitches.map((p) => ({
      venueId: p.venueId,
      fingerprint: computeDraftFingerprint({
        subject: p.subject,
        body: p.htmlBody || p.body,
      }),
      subject: p.subject,
    }));
  }

  /**
   * Closes Gate 2 upon explicit, affirmative whole-batch approval and records
   * draft copy fingerprints server-side in web-jam-back (D-45).
   *
   * Refuses to record if explicit approval is missing.
   */
  async approveWholeBatch(options: {
    approver?: string;
    notes?: string;
    explicitApproval: boolean;
    batchId?: string;
  }): Promise<Gate2ApprovalRecord> {
    if (!options.explicitApproval) {
      throw new Error(
        "Gate 2 approval forbidden: approval cannot be inferred from silence, partial reviews, " +
          "tweak submissions, or venue-list approval. Explicit affirmative whole-batch approval is required.",
      );
    }

    if (this.pitches.length === 0) {
      throw new Error("Cannot approve empty draft batch: no pitch drafts to approve");
    }

    const draftFingerprints = this.computeFingerprints();
    const batchId = options.batchId || `${this.weekend.start}-to-${this.weekend.end}`;
    const approver = (options.approver || "Josh").trim();

    const record = await recordGate2Approval(
      {
        backendUrl: this.backendConfig?.backendUrl,
        token: this.backendConfig?.token,
        batchId,
        weekend: this.weekend,
        draftFingerprints,
        approver,
        notes: options.notes ||
          `Gate 2 draft copy approval (${draftFingerprints.length} email draft(s) approved)`,
      },
      this.fetchFn,
    );

    this.status = "approved";
    this.gate2Record = record;
    return record;
  }

  isApproved(): boolean {
    return this.status === "approved" && Boolean(this.gate2Record);
  }
}

/**
 * Asserts that Gate 2 draft copy approval exists server-side for the target
 * batch before outreach dispatch (--send) may proceed (D-39, D-41).
 */
export async function assertGate2ApprovedForDispatch(
  batchIdOrWeekend: string,
  options: BackendConfigOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<Gate2ApprovalRecord> {
  const record = await fetchGate2Approval(batchIdOrWeekend, options, fetchFn);
  if (!record) {
    throw new Error(
      `Batch dispatch refused: Gate 2 draft copy approval is missing for batch '${batchIdOrWeekend}'. ` +
        `Inspect pitch drafts in the HTML review artifact and record Gate 2 approval via --record-gate2 first.`,
    );
  }
  return record;
}
