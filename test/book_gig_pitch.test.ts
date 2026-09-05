// test/book_gig_pitch.test.ts — Unit tests for /book-gig pitch stage resolution and rendering

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  detectConversationContext,
  renderPitch,
  resolveVenueStage,
  synthesizeCustomBodyHook,
  validateVoiceRules,
} from "../src/book-gig/pitch.ts";
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

Deno.test("resolveVenueStage: resolves to returning when venue has priorGigs array", () => {
  const venueWithGigs: CandidateVenue = {
    _id: "v_prior",
    name: "Prior Gigs Venue",
    priorGigs: [{ gigId: "g1", date: "2024-05-10" }],
  };
  assertEquals(resolveVenueStage(venueWithGigs), "returning");

  const venueEmptyGigs: CandidateVenue = {
    _id: "v_empty",
    name: "Empty Gigs Venue",
    priorGigs: [],
  };
  assertEquals(resolveVenueStage(venueEmptyGigs), "cold");
});

Deno.test("resolveVenueStage: resolves to cold by default when neither past gig nor returning option is present", () => {
  const venue: CandidateVenue = {
    _id: "v6",
    name: "Plain Cold Venue",
  };
  assertEquals(resolveVenueStage(venue), "cold");
});

Deno.test("detectConversationContext: detects phone, in-person, general, or null context cleanly", () => {
  // Phone conversation
  assertEquals(
    detectConversationContext({
      _id: "v_phone",
      name: "Phone Venue",
      contactNotes: "Spoke with manager on phone call last Tuesday",
    }),
    "phone",
  );

  // In-person conversation
  assertEquals(
    detectConversationContext({
      _id: "v_inperson",
      name: "In Person Venue",
      bookingNotes: "Connected in person at the brewery",
    }),
    "in-person",
  );

  // General conversation
  assertEquals(
    detectConversationContext({
      _id: "v_gen",
      name: "General Conversation Venue",
      priorContactNotes: "Had an earlier conversation about fall music dates",
    }),
    "general",
  );

  // Phone number label only (not a conversation)
  assertEquals(
    detectConversationContext({
      _id: "v_num",
      name: "Number Venue",
      notes: "Phone: (540) 555-1234. Nice outdoor patio.",
    }),
    null,
  );
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

Deno.test("renderPitch: generates dynamic warm returning phrasing and subject line for returning venue", () => {
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
    _id: "v_ret",
    name: "Olde Salem Brewing",
    city: "Salem",
    usState: "VA",
    email: "booking@oldesalem.com",
    contactName: "Matt",
    priorGigs: [{ gigId: "g1", date: "2025-06-20" }],
  };

  const pitch = renderPitch(venue, weekend);
  assertEquals(pitch.templateStage, "returning");
  assertStringIncludes(pitch.subject, "Back at Olde Salem Brewing");
  assertStringIncludes(pitch.body, "Hi Matt,");
  assertStringIncludes(
    pitch.body,
    "It's Josh from \"Josh and Maria\" — it's always great playing for you guys at Olde Salem Brewing",
  );
  assertStringIncludes(pitch.body, "would love to return on October 16–18, 2026");
  assertEquals(validateVoiceRules(pitch.body).valid, true);
});

Deno.test("renderPitch: generates tailored phone conversation intro when notes indicate spoken phone call", () => {
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
    _id: "v_phone_test",
    name: "Sample Pub",
    city: "Salem",
    usState: "VA",
    email: "booking@samplepub.com",
    contactName: "Dave",
    contactNotes: "Spoke with manager on phone call last Tuesday about booking",
  };

  const pitch = renderPitch(venue, weekend);
  assertStringIncludes(pitch.body, "Hi Dave,");
  assertStringIncludes(
    pitch.body,
    "Following up on our recent phone conversation — wanted to check if October 16–18, 2026 might work for an acoustic set at Sample Pub.",
  );
  // Ensure no duplicate follow up sentence
  assertEquals(pitch.body.includes("Following up on our earlier conversation"), false);
  assertEquals(validateVoiceRules(pitch.body).valid, true);
});

Deno.test("renderPitch: generates tailored in-person conversation intro when notes indicate connecting in person", () => {
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
    _id: "v_inperson_test",
    name: "Sample Pub",
    city: "Salem",
    usState: "VA",
    email: "booking@samplepub.com",
    contactName: "Sarah",
    bookingNotes: "Connected in person at the pub last weekend",
  };

  const pitch = renderPitch(venue, weekend);
  assertStringIncludes(pitch.body, "Hi Sarah,");
  assertStringIncludes(
    pitch.body,
    "Following up on connecting in person — wanted to check if October 16–18, 2026 might work for an acoustic set at Sample Pub.",
  );
  assertEquals(pitch.body.includes("Following up on our earlier conversation"), false);
  assertEquals(validateVoiceRules(pitch.body).valid, true);
});

Deno.test("renderPitch: falls back to cold template when no notes or prior gigs are recorded", () => {
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
    _id: "v_plain_cold",
    name: "Plain Cold Pub",
    city: "Salem",
    usState: "VA",
    email: "booking@plaincoldpub.com",
  };

  const pitch = renderPitch(venue, weekend);
  assertEquals(pitch.templateStage, "cold");
  assertStringIncludes(pitch.subject, "Performance Inquiry: Josh and Maria");
  assertStringIncludes(pitch.body, "We still have a few October 2026 dates open");
  assertEquals(validateVoiceRules(pitch.body).valid, true);
});

Deno.test("synthesizeCustomBodyHook: avoids duplicate conversation follow-up sentence when conversation intro is active", () => {
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
    _id: "v_hold",
    name: "Hold Venue",
    notes: "Spoke with owner: booked through summer, follow up in October",
  };

  // With conversation intro active: avoids duplicate "Following up on our earlier conversation"
  const hookWithIntro = synthesizeCustomBodyHook(venue, weekend, { hasConversationIntro: true });
  assertStringIncludes(
    hookWithIntro,
    "You mentioned checking back around this time for open dates",
  );
  assertEquals(hookWithIntro.includes("Following up on our earlier conversation"), false);

  // Without conversation intro active: retains full follow-up hook
  const hookWithoutIntro = synthesizeCustomBodyHook(venue, weekend, {
    hasConversationIntro: false,
  });
  assertStringIncludes(hookWithoutIntro, "Following up on our earlier conversation");
});
