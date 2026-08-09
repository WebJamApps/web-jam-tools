// venue_tag_diff.test.ts — web-jam-tools venue-tag-diff
//
// Unit tests for the pure classifier in src/venue-tag-diff/diff.ts. No
// network, no filesystem — every case is hand-built fixture data.

import { assertEquals } from "@std/assert";
import {
  classifyVenueTags,
  type LiveVenue,
  type ProposalVenue,
} from "../src/venue-tag-diff/diff.ts";

const LIVE: LiveVenue[] = [
  {
    _id: "v1",
    name: "The Blue Note",
    inScope: true,
    bookingStatus: "open",
    interested: true,
    venueType: "bar",
    outreachEligible: true,
    needsReview: false,
  },
  {
    _id: "v2",
    name: "Riverside Hall",
    inScope: false,
    bookingStatus: "closed",
    interested: false,
    venueType: "hall",
    outreachEligible: false,
    needsReview: true,
  },
];

Deno.test("classifyVenueTags: exact match on every field counts as matched", () => {
  const proposal: ProposalVenue[] = [
    {
      _id: "v1",
      name: "The Blue Note",
      inScope: true,
      bookingStatus: "open",
      interested: true,
      venueType: "bar",
      outreachEligible: true,
      needsReview: false,
    },
  ];
  const result = classifyVenueTags(proposal, LIVE);
  assertEquals(result.matchedCount, 1);
  assertEquals(result.diverged, []);
  assertEquals(result.missing, []);
});

Deno.test("classifyVenueTags: each field diverging is reported individually", () => {
  const fields: Array<[keyof ProposalVenue, unknown]> = [
    ["inScope", false],
    ["bookingStatus", "pending"],
    ["interested", false],
    ["venueType", "venue"],
    ["outreachEligible", false],
    ["needsReview", true],
  ];
  for (const [field, proposedValue] of fields) {
    const proposal: ProposalVenue[] = [
      {
        _id: "v1",
        name: "The Blue Note",
        inScope: true,
        bookingStatus: "open",
        interested: true,
        venueType: "bar",
        outreachEligible: true,
        needsReview: false,
        [field]: proposedValue,
      },
    ];
    const result = classifyVenueTags(proposal, LIVE);
    assertEquals(result.matchedCount, 0, `expected ${field} divergence to fail the match`);
    assertEquals(result.diverged.length, 1);
    assertEquals(result.diverged[0].name, "The Blue Note");
    assertEquals(result.diverged[0].diffs, [
      { field, proposed: proposedValue, live: LIVE[0][field as string] },
    ]);
  }
});

Deno.test("classifyVenueTags: a proposal row can diverge on multiple fields at once", () => {
  const proposal: ProposalVenue[] = [
    { _id: "v2", name: "Riverside Hall", inScope: true, needsReview: false },
  ];
  const result = classifyVenueTags(proposal, LIVE);
  assertEquals(result.diverged.length, 1);
  const diffFields = result.diverged[0].diffs.map((d) => d.field).sort();
  assertEquals(diffFields, ["inScope", "needsReview"]);
});

Deno.test("classifyVenueTags: a proposal row whose _id is absent from live is MISSING", () => {
  const proposal: ProposalVenue[] = [{ _id: "ghost", name: "Vanished Venue", inScope: true }];
  const result = classifyVenueTags(proposal, LIVE);
  assertEquals(result.matchedCount, 0);
  assertEquals(result.diverged, []);
  assertEquals(result.missing, [{ id: "ghost", name: "Vanished Venue" }]);
});

Deno.test("classifyVenueTags: missing row falls back to '?' when name is absent", () => {
  const proposal: ProposalVenue[] = [{ _id: "ghost" }];
  const result = classifyVenueTags(proposal, LIVE);
  assertEquals(result.missing, [{ id: "ghost", name: "?" }]);
});

Deno.test("classifyVenueTags: a proposal row carrying only a subset of fields is compared on those only", () => {
  // v2 diverges on inScope/bookingStatus/interested/venueType/outreachEligible/needsReview
  // vs a fully-matching proposal, but this row only asserts venueType — so it
  // must match even though the other fields would have diverged.
  const proposal: ProposalVenue[] = [{ _id: "v2", name: "Riverside Hall", venueType: "hall" }];
  const result = classifyVenueTags(proposal, LIVE);
  assertEquals(result.matchedCount, 1);
  assertEquals(result.diverged, []);
});

Deno.test("classifyVenueTags: a subset-field row still reports divergence for the fields it carries", () => {
  const proposal: ProposalVenue[] = [{ _id: "v2", name: "Riverside Hall", venueType: "bar" }];
  const result = classifyVenueTags(proposal, LIVE);
  assertEquals(result.diverged.length, 1);
  assertEquals(result.diverged[0].diffs, [{ field: "venueType", proposed: "bar", live: "hall" }]);
});

Deno.test("classifyVenueTags: an empty proposal array yields all-zero counts", () => {
  const result = classifyVenueTags([], LIVE);
  assertEquals(result, { matchedCount: 0, diverged: [], missing: [] });
});

Deno.test("classifyVenueTags: an empty live array reports every proposal row as missing", () => {
  const proposal: ProposalVenue[] = [
    { _id: "v1", name: "The Blue Note", inScope: true },
    { _id: "v2", name: "Riverside Hall", inScope: false },
  ];
  const result = classifyVenueTags(proposal, []);
  assertEquals(result.matchedCount, 0);
  assertEquals(result.diverged, []);
  assertEquals(result.missing.length, 2);
});
