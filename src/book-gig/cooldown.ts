// src/book-gig/cooldown.ts — Seasonal cooldown holds and resume-booking dates (web-jam-tools#878)

import { type BackendConfigOptions, buildHeaders, resolveBackendConfig } from "./outreach_api.ts";
import { normalizeVenueName } from "./venue_link.ts";
import type { VenueHoldResult } from "./types.ts";

export interface HoldVenueRecord {
  _id?: unknown;
  name?: string;
  city?: string;
  usState?: string;
  resumeBooking?: string;
  bookedThrough?: string;
  [key: string]: unknown;
}

export interface ParsedHoldDate {
  resumeBooking: string;
  bookedThrough: string;
  eligibleDate: string;
}

/**
 * Strips diacritics and accents for robust fuzzy matching (e.g. Château -> Chateau).
 */
export function foldDiacritics(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Normalizes venue query or name: strips HTML/punctuation/whitespace and folds diacritics.
 */
export function normalizeHoldName(text: string | undefined | null): string {
  return foldDiacritics(normalizeVenueName(text));
}

/**
 * Parse and validate a resume date string (YYYY-MM-DD or YYYY-M-D).
 * Computes:
 * - resumeBooking: ISO string at UTC midnight (e.g. "2027-01-01T00:00:00.000Z")
 * - bookedThrough: ISO string at the end of the previous day (e.g. "2026-12-31T23:59:59.999Z")
 * - eligibleDate: formatted YYYY-MM-DD string
 */
export function parseHoldDate(dateStr: string): ParsedHoldDate {
  if (!dateStr || !dateStr.trim()) {
    throw new Error("Missing required resume date for --hold. Expected YYYY-MM-DD.");
  }
  const trimmed = dateStr.trim();
  const match = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) {
    throw new Error(`Invalid date format "${dateStr}". Expected YYYY-MM-DD.`);
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid calendar date "${dateStr}". Month must be 1-12 and day 1-31.`);
  }

  const resumeUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const resumeDate = new Date(resumeUtc);

  if (
    resumeDate.getUTCFullYear() !== year ||
    resumeDate.getUTCMonth() !== month - 1 ||
    resumeDate.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date "${dateStr}".`);
  }

  const resumeBooking = resumeDate.toISOString();
  const bookedThrough = new Date(resumeUtc - 1).toISOString();
  const eligibleDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  return { resumeBooking, bookedThrough, eligibleDate };
}

export type VenueResolution =
  | { success: true; venue: HoldVenueRecord }
  | { success: false; error: string; candidates?: HoldVenueRecord[] };

/**
 * Resolves target venue by exact ID, exact name, normalized name, or fuzzy substring.
 * In case of ambiguity or non-existence, returns descriptive error and candidates.
 */
export function resolveHoldVenue(
  query: string,
  venues: HoldVenueRecord[],
): VenueResolution {
  const trimmed = (query || "").trim();
  if (!trimmed) {
    return { success: false, error: "Missing venue query." };
  }

  // 1. Exact ID match (case-insensitive)
  const idMatches = venues.filter(
    (v) => String(v._id || "").toLowerCase() === trimmed.toLowerCase(),
  );
  if (idMatches.length === 1) {
    return { success: true, venue: idMatches[0] };
  }
  if (idMatches.length > 1) {
    return {
      success: false,
      error: `Ambiguous venue ID "${trimmed}". Multiple venues match this ID:`,
      candidates: idMatches,
    };
  }

  // 2. Exact full name match (case-insensitive, trimmed)
  const exactNameMatches = venues.filter(
    (v) => (v.name || "").trim().toLowerCase() === trimmed.toLowerCase(),
  );
  if (exactNameMatches.length === 1) {
    return { success: true, venue: exactNameMatches[0] };
  }
  if (exactNameMatches.length > 1) {
    return {
      success: false,
      error: `Ambiguous venue query "${trimmed}". Multiple venues have this exact name:`,
      candidates: exactNameMatches,
    };
  }

  // 3. Normalized name match (strips punctuation, extra spaces, HTML entities, diacritics)
  const normQuery = normalizeHoldName(trimmed);
  if (normQuery) {
    const normMatches = venues.filter((v) => normalizeHoldName(v.name) === normQuery);
    if (normMatches.length === 1) {
      return { success: true, venue: normMatches[0] };
    }
    if (normMatches.length > 1) {
      return {
        success: false,
        error: `Ambiguous venue query "${trimmed}". Multiple venues match this normalized name:`,
        candidates: normMatches,
      };
    }
  }

  // 4. Fuzzy / substring match
  if (normQuery && normQuery.length >= 2) {
    const fuzzyMatches = venues.filter((v) => {
      const normV = normalizeHoldName(v.name);
      if (!normV) return false;
      return normV.includes(normQuery) || normQuery.includes(normV);
    });
    if (fuzzyMatches.length === 1) {
      return { success: true, venue: fuzzyMatches[0] };
    }
    if (fuzzyMatches.length > 1) {
      return {
        success: false,
        error: `Ambiguous venue query "${trimmed}". Multiple matches found:`,
        candidates: fuzzyMatches,
      };
    }
  }

  return {
    success: false,
    error: `Venue "${trimmed}" not found in venue database.`,
  };
}

/**
 * Format candidate list for console or error message.
 */
export function formatCandidatesList(candidates: HoldVenueRecord[]): string {
  return candidates
    .map((c) => {
      const loc = [c.city, c.usState].filter(Boolean).join(", ");
      const locStr = loc ? `, Location: ${loc}` : "";
      return `  • ${c.name || "(unnamed)"} (ID: ${String(c._id)}${locStr})`;
    })
    .join("\n");
}

/**
 * Sets seasonal cooldown hold dates on a target venue via PATCH /venue/:id.
 */
export async function executeVenueHold(
  venueQuery: string,
  untilDateStr: string,
  options: BackendConfigOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<VenueHoldResult> {
  if (!venueQuery || !venueQuery.trim()) {
    throw new Error("Missing required venue identifier for --hold.");
  }
  if (!untilDateStr || !untilDateStr.trim()) {
    throw new Error(
      "Missing required resume date for --hold. Specify --until <YYYY-MM-DD> or --resume <YYYY-MM-DD>.",
    );
  }

  const { resumeBooking, bookedThrough, eligibleDate } = parseHoldDate(untilDateStr);

  const { baseUrl, token } = await resolveBackendConfig(options);
  const headers = buildHeaders(token);

  // 1. Fetch live venues
  const venueRes = await fetchFn(`${baseUrl}/venue`, { headers });
  if (!venueRes.ok) {
    throw new Error(`Failed to fetch venues: HTTP ${venueRes.status} ${venueRes.statusText}`);
  }

  const rawData = await venueRes.json();
  let venues: HoldVenueRecord[] = [];
  if (Array.isArray(rawData)) {
    venues = rawData as HoldVenueRecord[];
  } else if (rawData && typeof rawData === "object") {
    const obj = rawData as Record<string, unknown>;
    venues = (obj.venues ?? obj.data ?? []) as HoldVenueRecord[];
  }

  // 2. Resolve target venue
  const resolution = resolveHoldVenue(venueQuery, venues);
  if (!resolution.success) {
    if (resolution.candidates && resolution.candidates.length > 0) {
      const formatted = formatCandidatesList(resolution.candidates);
      throw new Error(
        `${resolution.error}\n${formatted}\nPlease specify exact venue ID or full name.`,
      );
    }
    throw new Error(resolution.error);
  }

  const targetVenue = resolution.venue;
  const targetVenueId = String(targetVenue._id);

  // 3. Update venue via PATCH /venue/:id
  const patchUrl = `${baseUrl}/venue/${targetVenueId}`;
  const payload = {
    resumeBooking,
    bookedThrough,
  };

  const patchRes = await fetchFn(patchUrl, {
    method: "PATCH",
    headers,
    body: JSON.stringify(payload),
  });

  if (!patchRes.ok) {
    const errText = await patchRes.text();
    throw new Error(`Failed to update venue ${targetVenueId}: HTTP ${patchRes.status} ${errText}`);
  }

  const venueName = targetVenue.name || venueQuery;
  return {
    venueId: targetVenueId,
    venueName,
    resumeBooking,
    bookedThrough,
    eligibleDate,
    message: `Placed seasonal cooldown hold on "${venueName}" until ${eligibleDate}.`,
  };
}
