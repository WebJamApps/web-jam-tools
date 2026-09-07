// src/book-gig/outreach_api.ts — Backend API client for /outreach endpoints

import type {
  BatchDispatchResult,
  CheckRepliesResult,
  EmailTemplate,
  Gate1ApprovalRecord,
  OutreachCampaignRecord,
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
 * Fetch Gate 1 target venue-set approval record via GET /outreach/approval/venue-set/:batchId
 */
export async function fetchGate1Approval(
  batchIdOrWeekend: string,
  options: BackendConfigOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<Gate1ApprovalRecord | null> {
  const { baseUrl, token } = await resolveBackendConfig(options);
  const cleanId = encodeURIComponent(batchIdOrWeekend.trim());
  const url = `${baseUrl}/outreach/approval/venue-set/${cleanId}`;

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
      console.warn(`[book-gig] fetchGate1Approval returned HTTP ${res.status}: ${errText}`);
      return null;
    }

    const data = await res.json();
    return data as Gate1ApprovalRecord;
  } catch (err) {
    console.warn(`[book-gig] Error fetching Gate 1 approval: ${(err as Error).message}`);
    return null;
  }
}
