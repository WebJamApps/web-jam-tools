import crypto from "node:crypto";
import type {
  BatchDispatchResult,
  CheckRepliesResult,
  DraftFingerprintItem,
  EmailTemplate,
  Gate1ApprovalRecord,
  Gate2ApprovalRecord,
  OutreachCampaignRecord,
  PitchPreview,
  TargetWeekend,
} from "./types.ts";
import { parseTargetWeekend } from "./parser.ts";

export const DEFAULT_BACKEND_URL = "https://webjamsalem.herokuapp.com";

export interface BackendConfigOptions {
  backendUrl?: string;
  token?: string;
}

export interface BackendConfig {
  baseUrl: string;
  token?: string;
}

/**
 * Resolve the backend URL and Bearer token from options, env vars, or local token file.
 */
export async function resolveBackendConfig(
  options: BackendConfigOptions = {},
): Promise<BackendConfig> {
  const baseUrl = (
    options.backendUrl ||
    Deno.env.get("WEB_JAM_BACK_URL") ||
    DEFAULT_BACKEND_URL
  ).replace(/\/+$/, "");

  let token = options.token || Deno.env.get("WEB_JAM_LLM_TOKEN");
  if (!token) {
    try {
      const home = Deno.env.get("HOME");
      if (home) {
        token = (await Deno.readTextFile(`${home}/Dropbox/web-jam-llms/web-jam-llm.token`)).trim();
      }
    } catch {
      // ignore if token file is not accessible
    }
  }

  return { baseUrl, token };
}

export function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

export interface DispatchBatchOptions extends BackendConfigOptions {
  weekend: TargetWeekend;
  venueIds: string[];
  templateType?: string;
  bookingPeriod?: string;
}

/**
 * Dispatch batch outreach pitches to approved candidate venue IDs via POST /outreach/batch
 */
export async function dispatchBatchOutreach(
  options: DispatchBatchOptions,
  fetchFn: typeof fetch = fetch,
): Promise<BatchDispatchResult> {
  const { baseUrl, token } = await resolveBackendConfig(options);
  const url = `${baseUrl}/outreach/batch`;

  const payload = {
    venueIds: options.venueIds,
    targetDates: `${options.weekend.start} to ${options.weekend.end}`,
    targetWeekend: {
      start: options.weekend.start,
      end: options.weekend.end,
    },
    templateType: options.templateType,
    bookingPeriod: options.bookingPeriod,
  };

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Outreach batch dispatch returned HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    return {
      requested: data.requested ?? options.venueIds.length,
      sent: data.sent ?? 0,
      skipped: data.skipped ?? [],
      records: data.records ?? [],
    };
  } catch (err) {
    console.error(`[book-gig] Error dispatching outreach batch: ${(err as Error).message}`);
    throw err;
  }
}

/**
 * Trigger reply scan on Gmail via POST /outreach/check-replies
 */
export async function checkGmailReplies(
  options: BackendConfigOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<CheckRepliesResult> {
  const { baseUrl, token } = await resolveBackendConfig(options);
  const url = `${baseUrl}/outreach/check-replies`;

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: buildHeaders(token),
      body: "{}",
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[book-gig] check-replies returned HTTP ${res.status}: ${errText}`);
      return { checked: 0, matched: 0, classified: 0, bounced: 0 };
    }

    const data = await res.json();
    return {
      checked: data.checked ?? 0,
      matched: data.matched ?? 0,
      classified: data.classified ?? 0,
      bounced: data.bounced ?? 0,
    };
  } catch (err) {
    console.warn(`[book-gig] Error checking replies: ${(err as Error).message}`);
    return { checked: 0, matched: 0, classified: 0, bounced: 0 };
  }
}

/**
 * Fetch pending unreviewed replies and bounces via GET /outreach/replies/pending
 */
export async function fetchPendingReplies(
  options: BackendConfigOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<OutreachCampaignRecord[]> {
  const { baseUrl, token } = await resolveBackendConfig(options);
  const url = `${baseUrl}/outreach/replies/pending`;

  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: buildHeaders(token),
    });

    if (!res.ok) {
      console.warn(
        `[book-gig] pending replies query returned HTTP ${res.status}: ${res.statusText}`,
      );
      return [];
    }

    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn(`[book-gig] Error fetching pending replies: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Fetch all outreach campaign records via GET /outreach (supports venueId / status filters)
 */
export async function fetchOutreachCampaigns(
  options: BackendConfigOptions & { venueId?: string; status?: string } = {},
  fetchFn: typeof fetch = fetch,
): Promise<OutreachCampaignRecord[]> {
  const { baseUrl, token } = await resolveBackendConfig(options);
  const params = new URLSearchParams();
  if (options.venueId) params.set("venueId", options.venueId);
  if (options.status) params.set("status", options.status);
  const queryStr = params.toString();
  const url = `${baseUrl}/outreach${queryStr ? `?${queryStr}` : ""}`;

  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: buildHeaders(token),
    });

    if (!res.ok) {
      console.warn(`[book-gig] outreach list query returned HTTP ${res.status}: ${res.statusText}`);
      return [];
    }

    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn(`[book-gig] Error fetching outreach list: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Fetch venue directory from GET /venue to build an ID-to-metadata mapping.
 */
export async function fetchVenueMap(
  options: BackendConfigOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, { name: string; city?: string; usState?: string }>> {
  const { baseUrl, token } = await resolveBackendConfig(options);
  const url = `${baseUrl}/venue`;
  const map = new Map<string, { name: string; city?: string; usState?: string }>();

  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: buildHeaders(token),
    });

    if (!res.ok) {
      return map;
    }

    const data = await res.json();
    if (Array.isArray(data)) {
      for (const v of data) {
        if (v && v._id) {
          map.set(String(v._id), {
            name: v.name || "",
            city: v.city,
            usState: v.usState,
          });
        }
      }
    }
  } catch {
    // Best-effort mapping; swallow errors
  }

  return map;
}

export interface FetchPitchPreviewsOptions extends BackendConfigOptions {
  venueIds: string[];
  templateType?: string;
  targetDates?: string;
  bookingPeriod?: string;
  customBody?: string;
  customIntro?: string;
}

/**
 * Fetch the backend's own rendering of each venue's pitch draft via the batch
 * form of GET /outreach/preview?venueIds=id1,id2,... (web-jam-tools#948).
 *
 * This calls the exact function (`buildPitchEmail`) that composes what
 * `POST /outreach/batch` mails, so the subject/body returned here are
 * byte-identical to the dispatched email rather than a second, separately
 * implemented rendering that can drift from it (design doc load-bearing
 * premise 17). Venue ids the backend cannot resolve are simply absent from
 * the returned array rather than causing the whole request to fail.
 */
export async function fetchPitchPreviews(
  options: FetchPitchPreviewsOptions,
  fetchFn: typeof fetch = fetch,
): Promise<PitchPreview[]> {
  if (!Array.isArray(options.venueIds) || options.venueIds.length === 0) {
    return [];
  }

  const { baseUrl, token } = await resolveBackendConfig(options);
  const params = new URLSearchParams();
  params.set("venueIds", options.venueIds.join(","));
  if (options.templateType) params.set("templateType", options.templateType);
  if (options.targetDates) params.set("targetDates", options.targetDates);
  if (options.bookingPeriod) params.set("bookingPeriod", options.bookingPeriod);
  if (options.customBody) params.set("customBody", options.customBody);
  if (options.customIntro) params.set("customIntro", options.customIntro);
  const url = `${baseUrl}/outreach/preview?${params.toString()}`;

  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: buildHeaders(token),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[book-gig] pitch preview query returned HTTP ${res.status}: ${errText}`);
      return [];
    }

    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn(`[book-gig] Error fetching pitch previews: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Fetch active email templates via GET /template
 */
export async function fetchTemplates(
  options: BackendConfigOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<EmailTemplate[]> {
  const { baseUrl, token } = await resolveBackendConfig(options);
  const url = `${baseUrl}/template`;

  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: buildHeaders(token),
    });

    if (!res.ok) {
      console.warn(`[book-gig] template query returned HTTP ${res.status}: ${res.statusText}`);
      return [];
    }

    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn(`[book-gig] Error fetching email templates: ${(err as Error).message}`);
    return [];
  }
}

export interface RecordGate1ApprovalOptions extends BackendConfigOptions {
  batchId?: string;
  weekend: TargetWeekend | string;
  targetWeekend?: {
    start: string | Date;
    end: string | Date;
  };
  venueIds: string[];
  approver?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
  /** Called with how the requested set relates to the stored one, before the write. */
  onRevision?: (outcome: Gate1RevisionOutcome) => void;
}

/**
 * How a requested Gate 1 venue set relates to the one already stored for the batch.
 *
 * - `new` — nothing was stored for this batch yet.
 * - `identical` — same set; re-recording is an idempotent no-op.
 * - `widening` — every stored venue is still present and at least one was added (D-54 allows it).
 * - `non-widening` — a stored venue was removed or replaced (D-54 refuses it).
 */
export type Gate1RevisionOutcome = "new" | "identical" | "widening" | "non-widening";

/**
 * Classify a requested venue set against the stored one (D-54).
 *
 * Compares by set membership, so ordering and duplicates never make an otherwise identical
 * set look like a revision.
 */
export function classifyGate1Revision(
  storedIds: string[],
  requestedIds: string[],
): Gate1RevisionOutcome {
  const stored = new Set(storedIds.map(String));
  const requested = new Set(requestedIds.map(String));

  if (stored.size === 0) return "new";

  // Any stored venue missing from the request is a removal or a replacement, not a widening.
  const keepsEveryStoredVenue = [...stored].every((id) => requested.has(id));
  if (!keepsEveryStoredVenue) return "non-widening";

  return requested.size === stored.size ? "identical" : "widening";
}

/**
 * Record Gate 1 target venue-set approval via POST /outreach/approval/venue-set
 * (Authorizes ONLY the target venue set and nothing else; independent of Gate 2 copy approval).
 */
export async function recordGate1Approval(
  options: RecordGate1ApprovalOptions,
  fetchFn: typeof fetch = fetch,
): Promise<Gate1ApprovalRecord> {
  if (!Array.isArray(options.venueIds) || options.venueIds.length === 0) {
    throw new Error("venueIds must be a non-empty array of venue IDs");
  }

  let weekendStr: string;
  let targetWeekend = options.targetWeekend;

  if (typeof options.weekend === "string") {
    const parsed = parseTargetWeekend(options.weekend.trim());
    weekendStr = `${parsed.start}-to-${parsed.end}`;
    if (!targetWeekend) {
      targetWeekend = { start: parsed.start, end: parsed.end };
    }
  } else {
    weekendStr = `${options.weekend.start}-to-${options.weekend.end}`;
    if (!targetWeekend) {
      targetWeekend = { start: options.weekend.start, end: options.weekend.end };
    }
  }

  const batchId = (options.batchId || weekendStr).trim();
  const approver = (options.approver || "Josh").trim();

  // The backend upserts Gate 1 approval records on batchId/weekend (web-jam-back#1078
  // "model/outreach: record the venue-set approval and the per-email draft fingerprints
  // as two independent batch approvals"), so a second --record-gate1 run for the same
  // weekend rewrites whatever is stored — exactly what web-jam-back#1079 "model/outreach:
  // refuse batch dispatch unless both approvals exist and match this batch" checks dispatch
  // against. D-54 (web-jam-tools#959 "book-gig: provide a deliberate path to revise an
  // already-recorded Gate 1 venue-set approval") gives that rewrite four outcomes, below.
  const lookup = await lookupGate1Approval(batchId, options, fetchFn);

  // Outcome 4: the lookup could not determine whether a prior approval exists. Refuse
  // (fail closed) WITHOUT posting. Proceeding here would replace an approval through the
  // backend's upsert on the strength of a failed network call.
  if (lookup.status === "indeterminate") {
    throw new Error(
      `Cannot determine whether a Gate 1 venue-set approval already exists for batch ` +
        `'${batchId}': ${lookup.reason}. Refusing to record — an approval that cannot be read ` +
        `cannot be safely revised, and recording anyway would silently overwrite it through the ` +
        `backend's upsert on the weekend key. Re-run once the backend is reachable.`,
    );
  }

  let revision: Gate1RevisionOutcome = "new";

  if (lookup.status === "found") {
    const storedIds = (lookup.record.venueIds || []).map(String);
    const requestedIds = options.venueIds.map(String);
    revision = classifyGate1Revision(storedIds, requestedIds);

    // Outcome 3: a non-widening difference — a stored venue was removed or replaced.
    if (revision === "non-widening") {
      const requestedSet = new Set(requestedIds);
      const dropped = storedIds.filter((id) => !requestedSet.has(id));
      throw new Error(
        `Gate 1 venue-set approval already exists for batch '${batchId}' and the requested set ` +
          `is not a widening of it (stored: ${storedIds.join(", ") || "none"}; requested: ${
            requestedIds.join(", ")
          }; dropped: ${dropped.join(", ")}). Per D-54 an approved set may be widened by adding ` +
          `venues, but removing or replacing an approved venue is refused — nothing was recorded. ` +
          `Re-run with every stored venue still present, or record a different batch.`,
      );
    }

    // Outcome 2: a widening. Print the stored set beside the new one BEFORE writing, so the
    // change is visible rather than implicit (design Step 4, "An approved venue set can be
    // widened afterwards").
    if (revision === "widening") {
      const added = requestedIds.filter((id) => !new Set(storedIds).has(id));
      console.log(`\n📋 Widening the stored Gate 1 venue set for batch '${batchId}':`);
      console.log(`  • Stored (${storedIds.length}):    ${storedIds.join(", ") || "none"}`);
      console.log(`  • Requested (${requestedIds.length}): ${requestedIds.join(", ")}`);
      console.log(`  • Added (${added.length}):      ${added.join(", ")}`);
      console.log(
        `  Dispatch will reach only the venues in the approved set carrying no outreach\n` +
          `  record for this weekend, so widening never re-mails an already-pitched venue.`,
      );
    }
  }

  options.onRevision?.(revision);

  const payload: Record<string, unknown> = {
    batchId,
    weekend: weekendStr,
    venueIds: options.venueIds,
    approver,
  };

  if (targetWeekend) {
    payload.targetWeekend = {
      start: targetWeekend.start instanceof Date
        ? targetWeekend.start.toISOString()
        : targetWeekend.start,
      end: targetWeekend.end instanceof Date ? targetWeekend.end.toISOString() : targetWeekend.end,
    };
  }

  if (options.notes !== undefined) {
    payload.notes = options.notes;
  }

  if (options.metadata !== undefined) {
    payload.metadata = options.metadata;
  }

  const { baseUrl, token } = await resolveBackendConfig(options);
  const url = `${baseUrl}/outreach/approval/venue-set`;

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gate 1 venue-set approval returned HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    return data as Gate1ApprovalRecord;
  } catch (err) {
    console.error(`[book-gig] Error recording Gate 1 approval: ${(err as Error).message}`);
    throw err;
  }
}

/**
 * Outcome of a Gate 1 approval lookup, keeping "no prior approval exists" distinct from
 * "I could not find out" (D-54, web-jam-tools#959 "book-gig: provide a deliberate path to
 * revise an already-recorded Gate 1 venue-set approval").
 *
 * `fetchGate1Approval` collapses the last two into `null`, which is safe for a caller that
 * only wants to display a record but NOT for the re-record guard: the backend upserts on the
 * weekend key, so treating an unreadable lookup as "absent" silently replaces a prior
 * approval. Guard callers must use `lookupGate1Approval` and refuse on `indeterminate`.
 */
export type Gate1ApprovalLookup =
  | { status: "found"; record: Gate1ApprovalRecord }
  | { status: "absent" }
  | { status: "indeterminate"; reason: string };

/**
 * Look up the Gate 1 venue-set approval for a batch via
 * GET /outreach/approval/venue-set/:batchId, distinguishing all three outcomes.
 *
 * Only a genuine HTTP 404 means "absent". Every other failure — a non-2xx status, an
 * unparseable body, an expired token, a dropped connection — is `indeterminate`, because the
 * caller cannot tell from it whether a prior approval exists.
 */
export async function lookupGate1Approval(
  batchIdOrWeekend: string,
  options: BackendConfigOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<Gate1ApprovalLookup> {
  const { baseUrl, token } = await resolveBackendConfig(options);
  const cleanId = encodeURIComponent(batchIdOrWeekend.trim());
  const url = `${baseUrl}/outreach/approval/venue-set/${cleanId}`;

  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: buildHeaders(token),
    });

    if (res.status === 404) {
      return { status: "absent" };
    }

    if (!res.ok) {
      const errText = await res.text();
      return {
        status: "indeterminate",
        reason: `lookup returned HTTP ${res.status}: ${errText}`,
      };
    }

    try {
      const data = await res.json();
      return { status: "found", record: data as Gate1ApprovalRecord };
    } catch (err) {
      return {
        status: "indeterminate",
        reason: `lookup returned an unparseable response body: ${(err as Error).message}`,
      };
    }
  } catch (err) {
    return {
      status: "indeterminate",
      reason: `lookup could not be completed: ${(err as Error).message}`,
    };
  }
}

/**
 * Fetch Gate 1 target venue-set approval record via GET /outreach/approval/venue-set/:batchId.
 *
 * Returns `null` both when no approval exists and when the lookup could not be completed.
 * Use `lookupGate1Approval` instead wherever that distinction decides whether to write.
 */
export async function fetchGate1Approval(
  batchIdOrWeekend: string,
  options: BackendConfigOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<Gate1ApprovalRecord | null> {
  const lookup = await lookupGate1Approval(batchIdOrWeekend, options, fetchFn);

  if (lookup.status === "found") {
    return lookup.record;
  }

  if (lookup.status === "indeterminate") {
    console.warn(`[book-gig] fetchGate1Approval could not determine state: ${lookup.reason}`);
  }

  return null;
}

/**
 * Compute SHA-256 draft content fingerprint (matching web-jam-back's computeDraftFingerprint, D-39, D-41).
 */
export function computeDraftFingerprint(
  content: string | { subject?: string; body?: string },
): string {
  const normalized = typeof content === "string"
    ? content.trim()
    : `${(content.subject || "").trim()}\n\n${(content.body || "").trim()}`;
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

export interface RecordGate2ApprovalOptions extends BackendConfigOptions {
  batchId?: string;
  weekend: TargetWeekend | string;
  targetWeekend?: {
    start: string | Date;
    end: string | Date;
  };
  draftFingerprints: DraftFingerprintItem[];
  approver?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Record Gate 2 draft copy approval via POST /outreach/approval/draft-fingerprints
 * (Authorizes ONLY the draft copy via content fingerprints and nothing else; independent of Gate 1 venue-set approval).
 */
export async function recordGate2Approval(
  options: RecordGate2ApprovalOptions,
  fetchFn: typeof fetch = fetch,
): Promise<Gate2ApprovalRecord> {
  if (!Array.isArray(options.draftFingerprints) || options.draftFingerprints.length === 0) {
    throw new Error("draftFingerprints must be a non-empty array");
  }

  for (const fp of options.draftFingerprints) {
    if (!fp.venueId || typeof fp.venueId !== "string" || !fp.venueId.trim()) {
      throw new Error(`invalid venueId in draftFingerprints: '${fp.venueId}'`);
    }
    if (!fp.fingerprint || typeof fp.fingerprint !== "string" || !fp.fingerprint.trim()) {
      throw new Error(`fingerprint is required for venueId '${fp.venueId}'`);
    }
  }

  let weekendStr: string;
  let targetWeekend = options.targetWeekend;

  if (typeof options.weekend === "string") {
    const parsed = parseTargetWeekend(options.weekend.trim());
    weekendStr = `${parsed.start}-to-${parsed.end}`;
    if (!targetWeekend) {
      targetWeekend = { start: parsed.start, end: parsed.end };
    }
  } else {
    weekendStr = `${options.weekend.start}-to-${options.weekend.end}`;
    if (!targetWeekend) {
      targetWeekend = { start: options.weekend.start, end: options.weekend.end };
    }
  }

  const batchId = (options.batchId || weekendStr).trim();
  const approver = (options.approver || "Josh").trim();

  // Refuse silent overwrite if an existing Gate 2 approval exists for the same batch with different fingerprints
  const existing = await fetchGate2Approval(batchId, options, fetchFn);
  if (existing) {
    const existingMap = new Map(
      (existing.draftFingerprints || []).map((f) => [String(f.venueId), f.fingerprint]),
    );
    const newMap = new Map(
      options.draftFingerprints.map((f) => [String(f.venueId), f.fingerprint]),
    );
    const sameFps = existingMap.size === newMap.size &&
      [...existingMap.entries()].every(([id, fp]) => newMap.get(id) === fp);
    if (!sameFps) {
      throw new Error(
        `Gate 2 draft fingerprint approval already exists for batch '${batchId}' with different ` +
          `fingerprints. Refusing to silently overwrite a prior approval — recording revised ` +
          `draft copy for this batch is a decision Josh must make explicitly, not something this ` +
          `command does automatically.`,
      );
    }
  }

  const payload: Record<string, unknown> = {
    batchId,
    weekend: weekendStr,
    draftFingerprints: options.draftFingerprints,
    approver,
  };

  if (targetWeekend) {
    payload.targetWeekend = {
      start: targetWeekend.start instanceof Date
        ? targetWeekend.start.toISOString()
        : targetWeekend.start,
      end: targetWeekend.end instanceof Date ? targetWeekend.end.toISOString() : targetWeekend.end,
    };
  }

  if (options.notes !== undefined) {
    payload.notes = options.notes;
  }

  if (options.metadata !== undefined) {
    payload.metadata = options.metadata;
  }

  const { baseUrl, token } = await resolveBackendConfig(options);
  const url = `${baseUrl}/outreach/approval/draft-fingerprints`;

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gate 2 draft copy approval returned HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    return data as Gate2ApprovalRecord;
  } catch (err) {
    if ((err as Error).message.includes("Gate 2 draft copy approval returned HTTP")) {
      throw err;
    }
    throw new Error(`Failed to record Gate 2 draft copy approval: ${(err as Error).message}`);
  }
}

/**
 * Fetch Gate 2 draft copy approval record via GET /outreach/approval/draft-fingerprints/:batchId
 */
export async function fetchGate2Approval(
  batchIdOrWeekend: string,
  options: BackendConfigOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<Gate2ApprovalRecord | null> {
  const { baseUrl, token } = await resolveBackendConfig(options);
  const cleanId = encodeURIComponent(batchIdOrWeekend.trim());
  const url = `${baseUrl}/outreach/approval/draft-fingerprints/${cleanId}`;

  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: buildHeaders(token),
    });

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[book-gig] fetchGate2Approval returned HTTP ${res.status}: ${errText}`);
      return null;
    }

    const data = await res.json();
    return data as Gate2ApprovalRecord;
  } catch (err) {
    console.warn(`[book-gig] Error fetching Gate 2 approval: ${(err as Error).message}`);
    return null;
  }
}
