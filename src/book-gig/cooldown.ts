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

export interface VenueHoldDates {
  untilDate?: string;
  bookedThroughDate?: string;
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
 * Sets resumeBooking: ISO string at UTC midnight (e.g. "2027-01-01T00:00:00.000Z").
 */
export function parseResumeBookingDate(dateStr: string): string {
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

  return resumeDate.toISOString();
}

/**
 * Parse and validate a booked-through date string (YYYY-MM-DD or YYYY-M-D).
 * Sets bookedThrough: ISO string at the end of the specified day (e.g. "2026-12-31T23:59:59.999Z").
 */
export function parseBookedThroughDate(dateStr: string): string {
  if (!dateStr || !dateStr.trim()) {
    throw new Error("Missing required date for --booked-through. Expected YYYY-MM-DD.");
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

  const bookedUtc = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  const bookedDate = new Date(bookedUtc);

  if (
    bookedDate.getUTCFullYear() !== year ||
    bookedDate.getUTCMonth() !== month - 1 ||
    bookedDate.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date "${dateStr}".`);
  }

  return bookedDate.toISOString();
}

export type VenueResolution =
  | { success: true; venue: HoldVenueRecord }
  | { success: false; error: string; candidates?: HoldVenueRecord[] };

/**
 * Resolves target venue by exact ID, exact name, or exact normalized name.
 * Aligns with --link-gig exact resolution; refuses unconfirmed fuzzy/substring matches to prevent silent mutations on write paths.
 * If exact match fails, returns available candidate matches (if any) or not found error.
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

  // Exact resolution failed. Look for candidate matches (forward substring >= 3 chars) to aid error reporting,
  // but NEVER auto-select them on write paths to prevent unconfirmed silent mutations (e.g. "Spot" mutating "The Spot on Kirk").
  const partialMatches = normQuery && normQuery.length >= 3
    ? venues.filter((v) => {
      const normV = normalizeHoldName(v.name);
      return normV ? normV.includes(normQuery) : false;
    })
    : [];

  if (partialMatches.length > 0) {
    return {
      success: false,
      error: `Venue "${trimmed}" not found by exact ID or name. Available candidates:`,
      candidates: partialMatches,
    };
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
 * Sets seasonal cooldown hold or booked-through dates on a target venue via PATCH /venue/:id.
 * If only untilDate is provided, writes ONLY resumeBooking (at UTC 00:00:00.000Z).
 * If only bookedThroughDate is provided, writes ONLY bookedThrough (at UTC 23:59:59.999Z).
 * If both are explicitly provided, writes both. Neither implies or defaults the other!
 */
export async function executeVenueHold(
  venueQuery: string,
  dates: VenueHoldDates,
  options: BackendConfigOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<VenueHoldResult> {
  if (!venueQuery || !venueQuery.trim()) {
    throw new Error("Missing required venue identifier for --hold.");
  }

  const untilDateStr = dates?.untilDate;
  const bookedThroughDateStr = dates?.bookedThroughDate;

  if (!untilDateStr && !bookedThroughDateStr) {
    throw new Error(
      "Missing required date for venue hold. Specify --until <YYYY-MM-DD> (for resumeBooking) or --booked-through <YYYY-MM-DD> (for bookedThrough).",
    );
  }

  let resumeBooking: string | undefined;
  let eligibleDate: string | undefined;
  if (untilDateStr) {
    resumeBooking = parseResumeBookingDate(untilDateStr);
    const d = new Date(resumeBooking);
    eligibleDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${
      String(d.getUTCDate()).padStart(2, "0")
    }`;
  }

  let bookedThrough: string | undefined;
  if (bookedThroughDateStr) {
    bookedThrough = parseBookedThroughDate(bookedThroughDateStr);
  }

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
  const payload: Record<string, string> = {};
  if (resumeBooking) {
    payload.resumeBooking = resumeBooking;
  }
  if (bookedThrough) {
    payload.bookedThrough = bookedThrough;
  }

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
  let message = "";
  if (resumeBooking && bookedThrough) {
    message =
      `Recorded contact hold (until ${eligibleDate}) and booked-through date (through ${bookedThroughDateStr}) on "${venueName}".`;
  } else if (resumeBooking) {
    message = `Placed contact hold on "${venueName}" until ${eligibleDate} (resumeBooking).`;
  } else {
    message =
      `Recorded booked-through date on "${venueName}" through ${bookedThroughDateStr} (bookedThrough).`;
  }

  return {
    venueId: targetVenueId,
    venueName,
    resumeBooking,
    bookedThrough,
    eligibleDate,
    message,
  };
}
