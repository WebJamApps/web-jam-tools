// src/book-gig/venue_link.ts — Exact normalized-name gig-to-venue linking machinery (web-jam-tools#898)
//
// Shared venue<->gig matching logic mirroring web-jam-back/src/lib/gig-venue-link.ts (D-26):
// A gig links to a venue via `venueId` first; failing that, an EXACT normalized-name match
// (case/punctuation-insensitive) against `venue.name` — NEVER fuzzy. Ambiguous matches
// (matching multiple venues or multiple gigs) resolve to nothing (refuse to guess).

import { type BackendConfigOptions, buildHeaders, resolveBackendConfig } from "./outreach_api.ts";

export interface LinkableGig {
  _id?: unknown;
  venueId?: unknown;
  venue?: string;
  datetime?: Date | string;
  [key: string]: unknown;
}

export interface LinkableVenue {
  _id?: unknown;
  name?: string;
  [key: string]: unknown;
}

export interface LinkGigResult {
  venueName: string;
  venueId?: string;
  matchedGigId?: string;
  status: "linked" | "already-linked" | "no-match" | "ambiguous" | "venue-not-found";
  message: string;
}

// Prod `gig.venue` values may come from TinyMCE rich-text fields with HTML tags or entities.
// Both must be stripped/decoded BEFORE punctuation/case normalization.
const HTML_TAG_RE = /<[^>]*>/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const NAMED_ENTITY_RE = /&([a-zA-Z]+);/g;
const NUMERIC_ENTITY_RE = /&#(\d+);/g;
const HEX_ENTITY_RE = /&#x([0-9a-fA-F]+);/g;

/**
 * Decodes common HTML entities (named, decimal, hex).
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(HEX_ENTITY_RE, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(NUMERIC_ENTITY_RE, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(NAMED_ENTITY_RE, (m, name: string) => NAMED_ENTITIES[name] ?? m);
}

const PUNCTUATION_RE = /[^\p{L}\p{N}\s]/gu;

/**
 * Strips HTML tags, decodes entities, lowercases, strips punctuation, and collapses whitespace.
 * Exactly mirrors web-jam-back/src/lib/gig-venue-link.ts.
 */
export function normalizeVenueName(name: string | undefined | null): string {
  return decodeHtmlEntities((name || "").replace(HTML_TAG_RE, " "))
    .toLowerCase()
    .replace(PUNCTUATION_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build normalizedName -> venue _id (string), INCLUDING ONLY names unambiguous
 * across the given venue list (exactly one venue owns that normalized name).
 */
export function buildUnambiguousNameIndex(venues: LinkableVenue[]): Map<string, string> {
  const counts = new Map<string, string[]>();
  for (const v of venues) {
    const key = normalizeVenueName(v.name);
    if (!key) continue;
    const ids = counts.get(key) || [];
    ids.push(String(v._id));
    counts.set(key, ids);
  }
  const index = new Map<string, string>();
  for (const [key, ids] of counts) {
    if (ids.length === 1) index.set(key, ids[0]);
  }
  return index;
}

/**
 * Resolve which venue (by _id string) a gig belongs to, or null when unresolvable.
 */
export function resolveGigVenueId(
  gig: LinkableGig,
  nameIndex: Map<string, string>,
): string | null {
  if (gig.venueId) return String(gig.venueId);
  const key = normalizeVenueName(gig.venue);
  if (!key) return null;
  return nameIndex.get(key) || null;
}

/**
 * Executes a case-by-case gig linking for a single named venue (Decision D-26, web-jam-tools#898).
 * Resolves the venue, finds the matching gig via exact-normalized-name matching, and writes venueId.
 */
export async function executeLinkGig(
  venueName: string,
  options: BackendConfigOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<LinkGigResult> {
  if (!venueName || !venueName.trim()) {
    return {
      venueName: "",
      status: "no-match",
      message: "Missing required venue name for --link-gig.",
    };
  }

  const { baseUrl, token } = await resolveBackendConfig(options);
  const headers = buildHeaders(token);
  const targetNorm = normalizeVenueName(venueName);

  // 1. Fetch all venues to find the target venue record
  const venueRes = await fetchFn(`${baseUrl}/venue`, { headers });
  if (!venueRes.ok) {
    throw new Error(`Failed to fetch venues: HTTP ${venueRes.status} ${venueRes.statusText}`);
  }
  const rawVenues = (await venueRes.json()) as LinkableVenue[];
  const matchingVenues = rawVenues.filter((v) => normalizeVenueName(v.name) === targetNorm);

  if (matchingVenues.length === 0) {
    return {
      venueName,
      status: "venue-not-found",
      message: `Venue "${venueName}" not found in venue database.`,
    };
  }

  if (matchingVenues.length > 1) {
    return {
      venueName,
      status: "ambiguous",
      message:
        `Venue name "${venueName}" is ambiguous (${matchingVenues.length} venues found). Refusing to guess.`,
    };
  }

  const targetVenue = matchingVenues[0];
  const targetVenueId = String(targetVenue._id);

  // 2. Fetch gigs (prefer artist=josh scope, fall back to unscoped /gig)
  let gigRes = await fetchFn(`${baseUrl}/gig?artist=josh`, { headers });
  if (!gigRes.ok) {
    gigRes = await fetchFn(`${baseUrl}/gig`, { headers });
  }
  if (!gigRes.ok) {
    throw new Error(`Failed to fetch gigs: HTTP ${gigRes.status} ${gigRes.statusText}`);
  }
  const rawGigs = (await gigRes.json()) as LinkableGig[];

  // 3. Find matching gigs for targetVenue
  const matchingGigs = rawGigs.filter((g) => normalizeVenueName(g.venue) === targetNorm);

  if (matchingGigs.length === 0) {
    return {
      venueName: targetVenue.name || venueName,
      venueId: targetVenueId,
      status: "no-match",
      message: `No matching gig found for venue "${
        targetVenue.name || venueName
      }". No write performed.`,
    };
  }

  // If multiple matching gigs exist:
  if (matchingGigs.length > 1) {
    const allLinked = matchingGigs.every((g) =>
      Boolean(g.venueId) && String(g.venueId) === targetVenueId
    );
    if (allLinked) {
      return {
        venueName: targetVenue.name || venueName,
        venueId: targetVenueId,
        status: "already-linked",
        message: `Gig for venue "${
          targetVenue.name || venueName
        }" is already linked (venueId: ${targetVenueId}). No write performed.`,
      };
    }
    return {
      venueName: targetVenue.name || venueName,
      venueId: targetVenueId,
      status: "ambiguous",
      message: `Ambiguous match: venue "${
        targetVenue.name || venueName
      }" matches ${matchingGigs.length} gigs. Refusing to guess. No write performed.`,
    };
  }

  // Exactly one matching gig found:
  const targetGig = matchingGigs[0];
  const targetGigId = String(targetGig._id);

  if (
    targetGig.venueId && (String(targetGig.venueId) === targetVenueId || Boolean(targetGig.venueId))
  ) {
    return {
      venueName: targetVenue.name || venueName,
      venueId: targetVenueId,
      matchedGigId: targetGigId,
      status: "already-linked",
      message: `Gig for venue "${
        targetVenue.name || venueName
      }" is already linked (venueId: ${targetGig.venueId}). No write performed.`,
    };
  }

  // 4. Update the gig's venueId via PATCH /gig/:id (fallback to PUT if router only exposes PUT)
  let updateRes = await fetchFn(`${baseUrl}/gig/${targetGigId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ venueId: targetVenueId }),
  });

  if (updateRes.status === 404 || updateRes.status === 405) {
    updateRes = await fetchFn(`${baseUrl}/gig/${targetGigId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ venueId: targetVenueId }),
    });
  }

  if (!updateRes.ok) {
    const errText = await updateRes.text();
    throw new Error(
      `Failed to link gig ${targetGigId} to venue ${targetVenueId}: HTTP ${updateRes.status} ${errText}`,
    );
  }

  return {
    venueName: targetVenue.name || venueName,
    venueId: targetVenueId,
    matchedGigId: targetGigId,
    status: "linked",
    message: `Linked gig "${targetGig.venue || targetGigId}" to venue "${
      targetVenue.name || venueName
    }" (venueId: ${targetVenueId}).`,
  };
}
