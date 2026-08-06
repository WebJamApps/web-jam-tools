// diff.ts — web-jam-tools venue-tag-diff (see web-jam-tools issue for this
// feature: a proposed set of venue tag changes had no repeatable way to
// verify it was actually applied to the production venue database).
//
// `classifyVenueTags` is the pure core: given an already-parsed tag proposal
// array and an already-parsed live-venue array (both plain JSON, already
// fetched/read by the caller), it joins on `_id` and classifies each
// proposal row as matched / diverged / missing. No network, no filesystem —
// fully unit-testable. Only src/venue-tag-diff/cli.ts touches the network
// (`GET /venue`) or the filesystem (token file, proposal file).
//
// Only the six tag fields below are ever read or reported. Venue contact
// fields (email, phone, contactName) are never touched by this module, by
// design — see cli.ts for the "never print contact data" rule.

/** The tag fields a proposal is compared on. Order also drives report order. */
export const TAG_FIELDS = [
  "inScope",
  "bookingStatus",
  "interested",
  "venueType",
  "outreachEligible",
  "needsReview",
] as const;

export type TagField = typeof TAG_FIELDS[number];

/** A venue record as returned by `GET /venue`. Only `_id`/`name`/tag fields matter here. */
export interface LiveVenue {
  _id: string;
  name?: string;
  [key: string]: unknown;
}

/** A row from the tag proposal file. May carry only a subset of TAG_FIELDS. */
export interface ProposalVenue {
  _id: string;
  name?: string;
  [key: string]: unknown;
}

/** One tag field that differs between the proposal and the live record. */
export interface FieldDivergence {
  field: TagField;
  proposed: unknown;
  live: unknown;
}

/** A proposal row present in both proposal and live data, but with >=1 differing field. */
export interface DivergedRow {
  id: string;
  name: string;
  diffs: FieldDivergence[];
}

/** A proposal row whose `_id` has no matching live venue. */
export interface MissingRow {
  id: string;
  name: string;
}

export interface VenueTagDiffResult {
  /** Count of proposal rows whose every present tag field equals the live value. */
  matchedCount: number;
  diverged: DivergedRow[];
  missing: MissingRow[];
}

/**
 * Pure diff: join `proposals` -> `live` on `_id` and classify each proposal
 * row as matched (every tag field present in the proposal equals the live
 * value), diverged (at least one differs), or missing (no live venue with
 * that `_id`). A proposal row carrying only a subset of TAG_FIELDS is only
 * compared on the fields it actually has.
 */
export function classifyVenueTags(
  proposals: ProposalVenue[],
  live: LiveVenue[],
): VenueTagDiffResult {
  const byId = new Map(live.map((v) => [v._id, v]));

  let matchedCount = 0;
  const diverged: DivergedRow[] = [];
  const missing: MissingRow[] = [];

  for (const p of proposals) {
    const l = byId.get(p._id);
    if (!l) {
      missing.push({ id: p._id, name: p.name ?? "?" });
      continue;
    }

    const diffs: FieldDivergence[] = [];
    for (const field of TAG_FIELDS) {
      if (!(field in p)) continue; // proposal row only carries a subset of fields
      if (p[field] !== l[field]) {
        diffs.push({ field, proposed: p[field], live: l[field] });
      }
    }

    if (diffs.length > 0) {
      diverged.push({ id: p._id, name: p.name ?? "?", diffs });
    } else {
      matchedCount++;
    }
  }

  return { matchedCount, diverged, missing };
}
