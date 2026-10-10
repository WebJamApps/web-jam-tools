// skills/venue-mining/verify.ts
// Step 4 verification & candidate enrichment pipeline for /venue-mining.
// Evaluates size fit, address availability, automated venueType classification, and outreach eligibility.
import {
  type CanonicalVenueType,
  formatProposalTable,
  inferVenueType,
  isCanonicalVenueType,
  isUsableStreetAddress,
  type MinedVenueCandidate,
  type VenueTypeInferenceOptions,
  type VenueTypeInferenceResult,
} from "./venue-mining-core.ts";

export type VenueVerificationStatus = "ready" | "skipped_missing_address" | "unfit_size";

export interface VerifiedVenueResult {
  status: VenueVerificationStatus;
  candidate: MinedVenueCandidate;
  venueType?: CanonicalVenueType;
  inferenceResult: VenueTypeInferenceResult;
  outreachEligible: boolean;
  skippedReason?: string;
}

export interface VerificationBatchResult {
  total: number;
  ready: MinedVenueCandidate[];
  skipped: Array<{ candidate: MinedVenueCandidate; reason: string }>;
  proposalTable: string;
}

export interface VerificationOptions extends VenueTypeInferenceOptions {
  sweepProvenance?: string;
}

// Keywords indicating venues that are too large or unfit for acoustic duo live music (Rule 21)
const UNFIT_VENUE_PATTERNS: RegExp[] = [
  /\barena\b/i,
  /\bstadium\b/i,
  /\bcoliseum\b/i,
  /\bconvention\s+center\b/i,
  /\bamphitheater\b/i,
  /\bamphitheatre\b/i,
  /\bperforming\s+arts\s+center\b/i,
  /\bcivic\s+center\b/i,
];

/**
 * Checks if a candidate is size-fit for the acoustic duo live-music roster.
 * Large halls, arenas, stadiums, and civic centers are dropped cleanly per Rule 21.
 */
export function checkSizeFit(candidate: MinedVenueCandidate): { fit: boolean; reason?: string } {
  const text = `${candidate.name} ${candidate.description || ""} ${candidate.notes || ""}`;
  for (const pattern of UNFIT_VENUE_PATTERNS) {
    if (pattern.test(text)) {
      return {
        fit: false,
        reason: `Unfit venue size/type matching pattern ${pattern}`,
      };
    }
  }
  return { fit: true };
}

/**
 * Determines outreach eligibility based on email source and inbox type per SKILL.md.
 * - Probed domain: evaluated first. True only if explicit affirmative venue identity
 *   or approval evidence exists (candidate.identityConfirmed === true or candidate.approved === true);
 *   never derived from unrestricted prose substrings. Otherwise false (requires verified venue identity).
 *   Domains containing "website" cannot bypass.
 * - Published link (Google Maps, Google Places, publication, venue website): viable email -> true.
 * - Unknown provenance: false (requires verified source evidence rather than email presence alone).
 * - Wrong-purpose inbox (catering@, private-parties@, weddings@) or no email -> false.
 */
export function determineOutreachEligibility(
  candidate: MinedVenueCandidate,
): { outreachEligible: boolean; reason: string } {
  const email = (candidate.email || "").trim().toLowerCase();
  if (!email) {
    return { outreachEligible: false, reason: "No email address found" };
  }

  // Reject obviously wrong-purpose inboxes
  if (
    email.startsWith("catering@") ||
    email.startsWith("weddings@") ||
    email.startsWith("private-parties@") ||
    email.startsWith("privateparties@") ||
    email.startsWith("donations@") ||
    email.startsWith("jobs@") ||
    email.startsWith("press@")
  ) {
    return { outreachEligible: false, reason: "Wrong-purpose inbox" };
  }

  const emailSource = (candidate.emailSource || "").trim().toLowerCase();
  if (!emailSource) {
    return {
      outreachEligible: false,
      reason: "Missing email source provenance requires verified source evidence",
    };
  }

  // 1. Probed domain provenance must be evaluated BEFORE generic "website" substring matching.
  // Probed domains require explicit affirmative venue identity evidence (identityConfirmed === true)
  // or explicit approval (approved === true) before enabling outreach per D-49.
  // Never derive approval from unrestricted prose substrings or truthiness of untyped/falsy values.
  if (emailSource.includes("probed")) {
    const isIdentified = candidate.identityConfirmed === true ||
      candidate.approved === true;
    return {
      outreachEligible: isIdentified,
      reason: isIdentified
        ? "Probed domain with confirmed identity"
        : "Probed domain requires verified venue identity",
    };
  }

  // 2. Published link sources
  if (
    emailSource.includes("google maps") ||
    emailSource.includes("google places") ||
    emailSource.includes("publication") ||
    emailSource.includes("venue website") ||
    emailSource.includes("website")
  ) {
    return { outreachEligible: true, reason: "Published link source" };
  }

  // 3. Unknown or unverified provenance must require verified source evidence
  return {
    outreachEligible: false,
    reason: "Unverified email source provenance requires verified source evidence",
  };
}

/**
 * Verifies and enriches a single venue candidate during Step 4.
 * 1. Checks size fit.
 * 2. Checks street address availability (skipped venue if missing).
 * 3. Infers venueType using keyword heuristics with fallback.
 * 4. Determines outreachEligible.
 * 5. Appends provenance context to notes.
 */
export function verifyAndEnrichVenue(
  candidate: MinedVenueCandidate,
  options?: VerificationOptions,
): VerifiedVenueResult {
  const sizeCheck = checkSizeFit(candidate);
  if (!sizeCheck.fit) {
    const inference = inferVenueType(candidate, options);
    return {
      status: "unfit_size",
      candidate: { ...candidate, status: "Unfit Size" },
      venueType: inference.venueType,
      inferenceResult: inference,
      outreachEligible: false,
      skippedReason: sizeCheck.reason,
    };
  }

  const rawAddress = (candidate.address || candidate.streetAddress || "").trim();
  const inference = inferVenueType(candidate, options);
  const eligibility = determineOutreachEligibility(candidate);

  if (!isUsableStreetAddress(rawAddress)) {
    return {
      status: "skipped_missing_address",
      candidate: {
        ...candidate,
        venueType: inference.venueType,
        outreachEligible: eligibility.outreachEligible,
        status: "Missing Address",
      },
      venueType: inference.venueType,
      inferenceResult: inference,
      outreachEligible: eligibility.outreachEligible,
      skippedReason: rawAddress
        ? `Unusable street address ("${rawAddress}" is a placeholder or PO Box, or generic downtown location; physical address required)`
        : "No usable street address found after exhausting sources",
    };
  }

  const address = rawAddress;

  let notes = (candidate.notes || "").trim();
  if (options?.sweepProvenance && !notes.includes(options.sweepProvenance)) {
    notes = notes ? `${notes} | ${options.sweepProvenance}` : options.sweepProvenance;
  }

  const enrichedCandidate: MinedVenueCandidate = {
    ...candidate,
    address,
    venueType: inference.venueType,
    outreachEligible: eligibility.outreachEligible,
    notes,
    status: "Ready",
  };

  return {
    status: "ready",
    candidate: enrichedCandidate,
    venueType: inference.venueType,
    inferenceResult: inference,
    outreachEligible: eligibility.outreachEligible,
  };
}

/**
 * Verifies and enriches a batch of raw mined candidates.
 * Separates candidates into ready and skipped pools, and generates
 * the Step 5 proposal table for review.
 */
export function verifyAndEnrichCandidates(
  candidates: readonly MinedVenueCandidate[],
  options?: VerificationOptions,
): VerificationBatchResult {
  const ready: MinedVenueCandidate[] = [];
  const skipped: Array<{ candidate: MinedVenueCandidate; reason: string }> = [];

  for (const c of candidates) {
    const verified = verifyAndEnrichVenue(c, options);
    if (verified.status === "ready") {
      ready.push(verified.candidate);
    } else {
      skipped.push({
        candidate: verified.candidate,
        reason: verified.skippedReason || "Skipped verification",
      });
    }
  }

  const proposalTable = formatProposalTable(ready, { detailed: true });

  return {
    total: candidates.length,
    ready,
    skipped,
    proposalTable,
  };
}
