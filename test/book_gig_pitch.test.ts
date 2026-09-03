// test/book_gig_pitch.test.ts — Unit tests for /book-gig pitch stage resolution and rendering

import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderPitch, resolveVenueStage, validateVoiceRules } from "../src/book-gig/pitch.ts";
import type { CandidateVenue, TargetWeekend } from "../src/book-gig/types.ts";

Deno.test("resolveVenueStage: resolves to cold when relationshipStage is set but no linked past gig exists", () => {
  // Venue with relationshipStage: "returning" but reason.lastGigDate unset
  const venueNoReason: CandidateVenue = {
    _id: "v1",
    name: "Test Venue",
    relationshipStage: "returning",
  };
  assertEquals(resolveVenueStage(venueNoReason), "cold");

  // Venue with relationshipStage: "returning" and reason.lastGigDate = "never"
  const venueNever: CandidateVenue = {
    _id: "v2",
    name: "Test Venue 2",
    relationshipStage: "returning",
    reason: { lastGigDate: "never" },
  };
  assertEquals(resolveVenueStage(venueNever), "cold");
});

Deno.test("resolveVenueStage: resolves to returning when reason.lastGigDate is set", () => {
  const venue: CandidateVenue = {
    _id: "v3",
    name: "Returning Venue",
    reason: { lastGigDate: "2025-05-10" },
  };
  assertEquals(resolveVenueStage(venue), "returning");
});

Deno.test("resolveVenueStage: resolves to returning when options.isReturningVenue is true", () => {
  const venueCold: CandidateVenue = {
    _id: "v4",
    name: "Cold Venue",
  };
  assertEquals(resolveVenueStage(venueCold, { isReturningVenue: true }), "returning");

  const venueNever: CandidateVenue = {
    _id: "v5",
    name: "Cold Venue 2",
    reason: { lastGigDate: "never" },
  };
  assertEquals(resolveVenueStage(venueNever, { isReturningVenue: true }), "returning");
});

Deno.test("resolveVenueStage: resolves to cold by default when neither past gig nor returning option is present", () => {
  const venue: CandidateVenue = {
    _id: "v6",
    name: "Plain Cold Venue",
  };
  assertEquals(resolveVenueStage(venue), "cold");
});

Deno.test("renderPitch: uses cold template when venue has relationshipStage: 'returning' but no past gig", () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  const venue: CandidateVenue = {
    _id: "v7",
    name: "Sample Pub",
    city: "Salem",
    usState: "VA",
    email: "booking@samplepub.com",
    relationshipStage: "returning",
  };

  const pitch = renderPitch(venue, weekend);
  assertEquals(pitch.templateStage, "cold");
  assertStringIncludes(pitch.subject, "Sample Pub");
  assertStringIncludes(pitch.subject, "October 2026");
  assertStringIncludes(pitch.body, "We still have a few October 2026 dates open");
  assertEquals(validateVoiceRules(pitch.body).valid, true);
});

Deno.test("renderPitch: uses returning template when venue has linked past gig", () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  const venue: CandidateVenue = {
    _id: "v8",
    name: "Sample Pub",
    city: "Salem",
    usState: "VA",
    email: "booking@samplepub.com",
    reason: { lastGigDate: "2025-05-10" },
  };

  const pitch = renderPitch(venue, weekend);
  assertEquals(pitch.templateStage, "returning");
  assertStringIncludes(pitch.subject, "Back at Sample Pub");
  assertStringIncludes(pitch.body, "we had a blast playing Sample Pub last time");
  assertEquals(validateVoiceRules(pitch.body).valid, true);
});
