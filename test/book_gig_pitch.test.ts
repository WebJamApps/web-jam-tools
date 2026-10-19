import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  DEFAULT_TEMPLATES,
  detectConversationContext,
  formatNextGigDate,
  renderCustomHtml,
  renderPitch,
  renderPitchesFromBackend,
  resolveConversationIntro,
  resolveIntroHtml,
  resolveVenueStage,
  synthesizeCustomBodyHook,
  validateVoiceRules,
  verificationOptionsFromTweaks,
  verifyBatchAgainstTemplates,
} from "../src/book-gig/pitch.ts";
import {
  BatchDispatchError,
  computeDraftFingerprint,
  dispatchBatchOutreach,
} from "../src/book-gig/outreach_api.ts";
import { Gate2ReviewSession } from "../src/book-gig/gate2.ts";
import type {
  CandidateVenue,
  EmailTemplate,
  PitchEmail,
  TargetWeekend,
} from "../src/book-gig/types.ts";

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

Deno.test("resolveVenueStage: resolves to returning when venue has lastGig object with datetime or date", () => {
  const venueWithDatetime: CandidateVenue = {
    _id: "v_lastgig_dt",
    name: "Datetime Venue",
    lastGig: {
      _id: "g1",
      datetime: "2022-07-17T00:00:00.000Z",
      date: "Jul 17, 2022",
    },
  };
  assertEquals(resolveVenueStage(venueWithDatetime), "returning");

  const venueWithDateOnly: CandidateVenue = {
    _id: "v_lastgig_d",
    name: "Date Only Venue",
    lastGig: {
      _id: "g2",
      date: "Jul 17, 2022",
    },
  };
  assertEquals(resolveVenueStage(venueWithDateOnly), "returning");
});

Deno.test("resolveVenueStage: notes mentioning a past performance do not make a venue returning without a linked gig (D-34)", () => {
  const venueWithNotes: CandidateVenue = {
    _id: "v_notes_played",
    name: "Notes Venue",
    notes: "Type of gig: brewery\nLast played: 45396\nComments: Great room",
  };
  assertEquals(resolveVenueStage(venueWithNotes), "cold");
});

Deno.test("resolveVenueStage: resolves to cold by default when neither past gig nor returning option is present", () => {
  const venue: CandidateVenue = {
    _id: "v6",
    name: "Plain Cold Venue",
  };
  assertEquals(resolveVenueStage(venue), "cold");
});

Deno.test("detectConversationContext: selects opener from touches and ignores notes words (D-68, #995)", () => {
  // 1. Venue with a call touch (phone opener)
  assertEquals(
    detectConversationContext({
      _id: "v_call_touch",
      name: "Call Venue",
      touches: [{ type: "call", date: "2026-05-09" }],
    }),
    "phone",
  );

  // 2. Venue with a visit touch (in-person opener)
  assertEquals(
    detectConversationContext({
      _id: "v_visit_touch",
      name: "Visit Venue",
      touches: [{ type: "visit", date: "2026-05-09" }],
    }),
    "in-person",
  );

  // 3. Venue with neither touch type but notes text containing "called" or "phone"
  // (Hamlet Vineyards defect regression: legacy metadata or notes text must NOT select conversation opener)
  assertEquals(
    detectConversationContext({
      _id: "v_hamlet_vineyards",
      name: "Hamlet Vineyards",
      notes: "Date called: 2026-05-09. Spoke with manager on phone.",
      contactNotes: "Called Dave to check fall availability",
      bookingNotes: "Phone: (540) 555-1234",
      priorContactNotes: "visited the venue last Saturday",
      touches: [],
    }),
    null,
  );

  // Also null when touches is undefined or carries non-conversation touch types
  assertEquals(
    detectConversationContext({
      _id: "v_hamlet_vineyards_no_touches",
      name: "Hamlet Vineyards",
      notes: "Date called: 2026-05-09",
    }),
    null,
  );
  assertEquals(
    detectConversationContext({
      _id: "v_email_only",
      name: "Email Only Venue",
      notes: "called last month",
      touches: [{ type: "email", date: "2026-07-22" }],
    }),
    null,
  );

  // 4. Venue with both a call and a visit touch:
  // Resolves deterministically by most recent touch date
  assertEquals(
    detectConversationContext({
      _id: "v_both_visit_newer",
      name: "Both Touches - Visit Newer",
      touches: [
        { type: "call", date: "2026-04-10" },
        { type: "visit", date: "2026-06-01" },
      ],
    }),
    "in-person",
  );

  assertEquals(
    detectConversationContext({
      _id: "v_both_call_newer",
      name: "Both Touches - Call Newer",
      touches: [
        { type: "visit", date: "2026-04-10" },
        { type: "call", date: "2026-06-01" },
      ],
    }),
    "phone",
  );

  // When dates are tied or absent, deterministically picks the latest recorded touch in the array
  assertEquals(
    detectConversationContext({
      _id: "v_both_same_date",
      name: "Both Touches - Same Date",
      touches: [
        { type: "call", date: "2026-05-01" },
        { type: "visit", date: "2026-05-01" },
      ],
    }),
    "in-person",
  );

  assertEquals(
    detectConversationContext({
      _id: "v_both_no_date",
      name: "Both Touches - No Date",
      touches: [
        { type: "visit" },
        { type: "call" },
      ],
    }),
    "phone",
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
    venueType: "PubFestivalBrewery",
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
    venueType: "PubFestivalBrewery",
    reason: { lastGigDate: "2025-05-10" },
  };

  const pitch = renderPitch(venue, weekend);
  assertEquals(pitch.templateStage, "returning");
  assertStringIncludes(pitch.subject, "Back at Sample Pub");
  assertStringIncludes(pitch.body, "we had a blast playing Sample Pub last time");
  assertEquals(validateVoiceRules(pitch.body).valid, true);
});

Deno.test("renderPitch: uses returning template when venue has lastGig object", () => {
  const weekend: TargetWeekend = {
    start: "2027-01-08",
    end: "2027-01-10",
    rawText: "Jan 8-10 2027",
    label: "January 8–10, 2027",
    year: 2027,
    month: 1,
    days: [8, 9, 10],
  };

  const venue: CandidateVenue = {
    _id: "v_olde_salem",
    name: "Olde Salem Brewery",
    city: "Salem",
    usState: "VA",
    email: "ben@oldesalembrewing.com",
    venueType: "PubFestivalBrewery",
    lastGig: {
      _id: "g_olde_salem",
      datetime: "2022-07-17T00:00:00.000Z",
      date: "Jul 17, 2022",
    },
  };

  const pitch = renderPitch(venue, weekend);
  assertEquals(pitch.templateStage, "returning");
  assertStringIncludes(pitch.subject, "Back at Olde Salem Brewery this January 2027?");
  assertStringIncludes(pitch.body, "we had a blast playing Olde Salem Brewery last time");
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
    venueType: "PubFestivalBrewery",
    contactName: "Matt",
    priorGigs: [{ gigId: "g1", date: "2025-06-20" }],
  };

  const pitch = renderPitch(venue, weekend);
  assertEquals(pitch.templateStage, "returning");
  assertStringIncludes(pitch.subject, "Back at Olde Salem Brewing");
  assertStringIncludes(pitch.body, "Hi Matt,");
  assertStringIncludes(
    pitch.body,
    'It\'s Josh from "Josh and Maria" — we had a blast playing Olde Salem Brewing last time and would love to get back on your calendar.',
  );
  assertEquals(validateVoiceRules(pitch.body).valid, true);
});

Deno.test("renderPitch: generates tailored phone conversation intro when touches include call", () => {
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
    touches: [{ type: "call" }],
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

Deno.test("renderPitch: generates tailored in-person conversation intro when touches include visit", () => {
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
    touches: [{ type: "visit" }],
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
    venueType: "PubFestivalBrewery",
  };

  const pitch = renderPitch(venue, weekend);
  assertEquals(pitch.templateStage, "cold");
  assertStringIncludes(pitch.subject, "Performance Inquiry: Josh and Maria");
  assertStringIncludes(pitch.body, "We still have a few October 2026 dates open");
  assertEquals(validateVoiceRules(pitch.body).valid, true);
});

Deno.test("synthesizeCustomBodyHook: notes do not produce conversation reference with or without conversation intro (D-68, #995)", () => {
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

  // With conversation intro active: mentions checking back, no conversation follow-up sentence
  const hookWithIntro = synthesizeCustomBodyHook(venue, weekend, { hasConversationIntro: true });
  assertStringIncludes(
    hookWithIntro,
    "You mentioned checking back around this time for open dates",
  );
  assertEquals(hookWithIntro.includes("Following up on our earlier conversation"), false);

  // Without conversation intro active: still mentions checking back, and does NOT claim earlier conversation
  const hookWithoutIntro = synthesizeCustomBodyHook(venue, weekend, {
    hasConversationIntro: false,
  });
  assertStringIncludes(
    hookWithoutIntro,
    "You mentioned checking back around this time for open dates",
  );
  assertEquals(hookWithoutIntro.includes("Following up on our earlier conversation"), false);
});

Deno.test("detectConversationContext: does not trigger in-person context for website or social media visits", () => {
  assertEquals(
    detectConversationContext({
      _id: "v_web",
      name: "Web Venue",
      notes: "visited their website to check live music schedule",
    }),
    null,
  );

  assertEquals(
    detectConversationContext({
      _id: "v_fb",
      name: "FB Venue",
      notes: "visited Facebook page and saw they host acoustic music",
    }),
    null,
  );

  assertEquals(
    detectConversationContext({
      _id: "v_ig",
      name: "Instagram Venue",
      notes: "visited instagram profile",
    }),
    null,
  );

  // Notes mentioning in-person visits without touches do NOT trigger in-person
  assertEquals(
    detectConversationContext({
      _id: "v_inperson_notes_only",
      name: "Real Visit Venue",
      notes: "visited the venue last Saturday",
    }),
    null,
  );

  assertEquals(
    detectConversationContext({
      _id: "v_inperson_notes_them",
      name: "Them Visit Venue",
      notes: "visited them to introduce our duo",
    }),
    null,
  );

  // But structured visit touches DO trigger in-person
  assertEquals(
    detectConversationContext({
      _id: "v_inperson_real",
      name: "Real Visit Venue",
      notes: "visited the venue last Saturday",
      touches: [{ type: "visit" }],
    }),
    "in-person",
  );

  assertEquals(
    detectConversationContext({
      _id: "v_inperson_them",
      name: "Them Visit Venue",
      notes: "visited them to introduce our duo",
      touches: [{ type: "visit" }],
    }),
    "in-person",
  );
});

Deno.test("renderPitch: respects caller-supplied custom templates array for returning stage", () => {
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
    _id: "v_custom_ret",
    name: "Custom Brewery",
    city: "Salem",
    usState: "VA",
    email: "booking@custombrewery.com",
    venueType: "PubFestivalBrewery",
    contactName: "Alex",
    reason: { lastGigDate: "2025-06-15" },
  };

  const customTemplates = [
    {
      type: "PubFestivalBrewery" as const,
      stage: "returning" as const,
      subject: "Playing [Venue Name] again — Josh & Maria",
      introHtml:
        `<p>Hi [Contact Name],</p>\n<p>It's Josh from "Josh and Maria" — checking back in with our friends at [Venue Name] for [Target Dates].</p>`,
      bodyHtml:
        `<p>We really loved our last show and would love to return for a 2-3 hour acoustic set.</p>\n<p>Best,<br>Josh</p>`,
    },
  ];

  const pitch = renderPitch(venue, weekend, {}, customTemplates);
  assertEquals(pitch.templateStage, "returning");
  assertStringIncludes(pitch.subject, "Playing Custom Brewery again — Josh & Maria");
  assertStringIncludes(pitch.body, "Hi Alex,");
  assertStringIncludes(
    pitch.body,
    "checking back in with our friends at Custom Brewery for October 16–18, 2026.",
  );
  assertStringIncludes(pitch.body, "We really loved our last show and would love to return");
  assertEquals(validateVoiceRules(pitch.body).valid, true);
});

Deno.test("renderPitch: combines returning stage with conversation context in intro", () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  // Phone + returning
  const phoneVenue: CandidateVenue = {
    _id: "v_ret_phone",
    name: "River Taphouse",
    city: "Salem",
    usState: "VA",
    email: "booking@rivertaphouse.com",
    contactName: "Sam",
    contactNotes: "Called manager on the phone to check on fall availability",
    touches: [{ type: "call" }],
    reason: { lastGigDate: "2025-08-10" },
  };
  const phonePitch = renderPitch(phoneVenue, weekend);
  assertEquals(phonePitch.templateStage, "returning");
  assertStringIncludes(phonePitch.body, "Hi Sam,");
  assertStringIncludes(
    phonePitch.body,
    "Following up on our recent phone conversation — it's always great playing for you guys at River Taphouse, and we'd love to return on October 16–18, 2026.",
  );
  assertEquals(validateVoiceRules(phonePitch.body).valid, true);

  // In-person + returning
  const inPersonVenue: CandidateVenue = {
    _id: "v_ret_inperson",
    name: "River Taphouse",
    city: "Salem",
    usState: "VA",
    email: "booking@rivertaphouse.com",
    contactName: "Sam",
    bookingNotes: "Stopped by and met in person to discuss dates",
    touches: [{ type: "visit" }],
    reason: { lastGigDate: "2025-08-10" },
  };
  const inPersonPitch = renderPitch(inPersonVenue, weekend);
  assertEquals(inPersonPitch.templateStage, "returning");
  assertStringIncludes(
    inPersonPitch.body,
    "Following up on connecting in person — it's always great playing for you guys at River Taphouse, and we'd love to return on October 16–18, 2026.",
  );
  assertEquals(validateVoiceRules(inPersonPitch.body).valid, true);

  // Notes without touches + returning -> gets default returning opener, notes text never selects an opener (D-68)
  const notesVenue: CandidateVenue = {
    _id: "v_ret_notes",
    name: "River Taphouse",
    city: "Salem",
    usState: "VA",
    email: "booking@rivertaphouse.com",
    contactName: "Sam",
    notes: "Had an earlier conversation about fall dates, called on phone last week",
    reason: { lastGigDate: "2025-08-10" },
  };
  const notesPitch = renderPitch(notesVenue, weekend);
  assertEquals(notesPitch.templateStage, "returning");
  assertStringIncludes(
    notesPitch.body,
    "It's Josh from \"Josh and Maria\" — Maria and I really enjoyed our last show at River Taphouse, and we'd love to come back.",
  );
  assertEquals(notesPitch.body.includes("Following up on our earlier conversation"), false);
  assertEquals(notesPitch.body.includes("Following up on our recent phone conversation"), false);
  assertEquals(notesPitch.body.includes("Following up on connecting in person"), false);
  assertEquals(validateVoiceRules(notesPitch.body).valid, true);
});

Deno.test("renderPitch: generates distinct type-appropriate returning phrasing for Originals and MidRangeCafeBar", () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  // Originals
  const originalsVenue: CandidateVenue = {
    _id: "v_orig",
    name: "Listening Room",
    city: "Roanoke",
    usState: "VA",
    venueType: "Originals",
    email: "booking@listeningroom.com",
    contactName: "Claire",
    reason: { lastGigDate: "2025-04-12" },
  };
  const origPitch = renderPitch(originalsVenue, weekend);
  assertEquals(origPitch.templateStage, "returning");
  assertStringIncludes(origPitch.body, "Hi Claire,");
  assertStringIncludes(
    origPitch.body,
    "It's Josh — my wife Maria and I (the husband-wife acoustic duo \"Josh and Maria\") had such a good time the last time we played Listening Room, and we'd love to come back.",
  );
  assertEquals(validateVoiceRules(origPitch.body).valid, true);

  // MidRangeCafeBar
  const cafeVenue: CandidateVenue = {
    _id: "v_cafe",
    name: "Corner Cafe",
    city: "Blacksburg",
    usState: "VA",
    venueType: "MidRangeCafeBar",
    email: "booking@cornercafe.com",
    contactName: "Leo",
    reason: { lastGigDate: "2025-05-20" },
  };
  const cafePitch = renderPitch(cafeVenue, weekend);
  assertEquals(cafePitch.templateStage, "returning");
  assertStringIncludes(cafePitch.body, "Hi Leo,");
  assertStringIncludes(
    cafePitch.body,
    "It's Josh from \"Josh and Maria\" — Maria and I really enjoyed our last show at Corner Cafe, and we'd love to come back.",
  );
  assertEquals(validateVoiceRules(cafePitch.body).valid, true);
});

Deno.test("resolveVenueStage: nextGig.datetime with no past-gig evidence resolves to upcoming", () => {
  const venue: CandidateVenue = {
    _id: "u1",
    name: "Debut Venue",
    nextGig: { datetime: "2099-10-17T23:00:00.000Z" },
  };
  assertEquals(resolveVenueStage(venue), "upcoming");
  assertEquals(
    resolveVenueStage({ _id: "u1b", name: "Date Only", nextGig: { date: "2099-10-17" } }),
    "upcoming",
  );
});

Deno.test("resolveVenueStage: bookingStatus booked with no past-gig evidence resolves to upcoming", () => {
  const venue: CandidateVenue = { _id: "u2", name: "Booked Venue", bookingStatus: "booked" };
  assertEquals(resolveVenueStage(venue), "upcoming");
});

Deno.test("resolveVenueStage: past-gig evidence beats upcoming-gig evidence", () => {
  const withLastAndNext: CandidateVenue = {
    _id: "u3",
    name: "Both Venue",
    lastGig: { datetime: "2025-05-10T23:00:00.000Z" },
    nextGig: { datetime: "2099-10-17T23:00:00.000Z" },
  };
  assertEquals(resolveVenueStage(withLastAndNext), "returning");

  const bookedWithHistory: CandidateVenue = {
    _id: "u4",
    name: "Booked And Played",
    bookingStatus: "booked",
    reason: { lastGigDate: "2025-05-10" },
  };
  assertEquals(resolveVenueStage(bookedWithHistory), "returning");
  assertEquals(
    resolveVenueStage({ _id: "u5", name: "Option", bookingStatus: "booked" }, {
      isReturningVenue: true,
    }),
    "returning",
  );
});

Deno.test("resolveVenueStage: a nextGig with neither datetime nor date and no booking stays cold", () => {
  assertEquals(resolveVenueStage({ _id: "u6", name: "Empty Next", nextGig: {} }), "cold");
});

const UPCOMING_TEMPLATE: EmailTemplate = {
  type: "PubFestivalBrewery",
  stage: "upcoming",
  subject: "See you [Next Gig Date] at [Venue Name]",
  introHtml: `<p>Hi [Contact Name],</p>\n<p>We are looking forward to [Next Gig Date].</p>`,
  bodyHtml: `<p>Is [Target Dates] open too?</p>`,
};

const UPCOMING_WEEKEND: TargetWeekend = {
  start: "2026-10-16",
  end: "2026-10-18",
  rawText: "Oct 16-18 2026",
  label: "October 16–18, 2026",
  year: 2026,
  month: 10,
  days: [16, 17, 18],
};

Deno.test("formatNextGigDate: formats in America/New_York like the backend", () => {
  const v: CandidateVenue = {
    _id: "n1",
    name: "N",
    nextGig: { datetime: "2099-10-17T23:00:00.000Z" },
  };
  assertEquals(formatNextGigDate(v), "Saturday, October 17");
  assertEquals(
    formatNextGigDate({
      _id: "n2",
      name: "N",
      nextGig: { datetime: new Date("2099-10-17T23:00:00.000Z") },
    }),
    "Saturday, October 17",
  );
});

Deno.test("formatNextGigDate: falls back when the datetime is missing, date-only, or invalid", () => {
  assertEquals(formatNextGigDate({ _id: "n3", name: "N" }), "our upcoming show");
  assertEquals(
    formatNextGigDate({ _id: "n4", name: "N", nextGig: { date: "2099-10-17" } }),
    "our upcoming show",
  );
  assertEquals(
    formatNextGigDate({ _id: "n5", name: "N", nextGig: { datetime: "not-a-date" } }),
    "our upcoming show",
  );
});

Deno.test("renderPitch: [Next Gig Date] renders the date, or the fallback, and never the literal token", () => {
  const withDate: CandidateVenue = {
    _id: "r1",
    name: "Debut Room",
    venueType: "PubFestivalBrewery",
    contactName: "Pat",
    nextGig: { datetime: "2099-10-17T23:00:00.000Z" },
  };
  const pitch = renderPitch(withDate, UPCOMING_WEEKEND, {}, [UPCOMING_TEMPLATE]);
  assertEquals(pitch.templateStage, "upcoming");
  assertStringIncludes(pitch.subject, "See you Saturday, October 17 at Debut Room");
  assertStringIncludes(pitch.body, "Saturday, October 17");
  assertEquals(pitch.body.includes("[Next Gig Date]"), false);
  assertEquals(pitch.subject.includes("[Next Gig Date]"), false);

  const noDate: CandidateVenue = { ...withDate, _id: "r2", nextGig: null, bookingStatus: "booked" };
  const fallback = renderPitch(noDate, UPCOMING_WEEKEND, {}, [UPCOMING_TEMPLATE]);
  assertStringIncludes(fallback.subject, "See you our upcoming show at Debut Room");
  assertStringIncludes(fallback.body, "our upcoming show");
  assertEquals(fallback.body.includes("[Next Gig Date]"), false);
});

Deno.test("resolveIntroHtml: upcoming gets the same conversation intros as cold, never the returning ones", () => {
  for (const ctx of ["phone", "in-person", "general", null] as const) {
    const upcoming = resolveIntroHtml(UPCOMING_TEMPLATE, "upcoming", ctx);
    const cold = resolveIntroHtml(UPCOMING_TEMPLATE, "cold", ctx);
    assertEquals(upcoming, cold);
    if (ctx) {
      assertEquals(upcoming === resolveIntroHtml(UPCOMING_TEMPLATE, "returning", ctx), false);
    }
  }
});

Deno.test("renderPitch: notes mentioning spoke with, contacted, or 2027 do not produce conversation reference without structured touches", () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  // 1. Spoke with manager in notes, but empty touches[] -> no conversation reference
  const spokeVenue: CandidateVenue = {
    _id: "v_spoke_notes",
    name: "Spoke Venue",
    email: "booking@spokevenue.com",
    contactName: "Dave",
    notes: "Spoke with manager about live music dates",
    touches: [],
  };
  const spokePitch = renderPitch(spokeVenue, weekend);
  assertEquals(spokePitch.body.includes("Following up on our earlier conversation"), false);
  assertEquals(spokePitch.body.includes("Following up on our recent phone conversation"), false);
  assertEquals(spokePitch.body.includes("Following up on connecting in person"), false);
  assertEquals(validateVoiceRules(spokePitch.body).valid, true);

  // 2. Follow up / 2027 in notes, empty touches[] -> mentions checking back, but NO conversation reference
  const followUpVenue: CandidateVenue = {
    _id: "v_followup_notes",
    name: "Followup Venue",
    email: "booking@followup.com",
    contactName: "Sarah",
    notes: "Follow up in 2027; booked through end of year",
    touches: [],
  };
  const followUpPitch = renderPitch(followUpVenue, weekend);
  assertStringIncludes(
    followUpPitch.body,
    "You mentioned checking back around this time for open dates — we'd love to see if we can get on the calendar for October 16–18, 2026.",
  );
  assertEquals(followUpPitch.body.includes("Following up on our earlier conversation"), false);
  assertEquals(followUpPitch.body.includes("Following up on our recent phone conversation"), false);
  assertEquals(followUpPitch.body.includes("Following up on connecting in person"), false);
  assertEquals(validateVoiceRules(followUpPitch.body).valid, true);

  // 3. Exact Hamlet Vineyards regression: legacy "Date called:" note and email exchange, empty touches[]
  const hamletVenue: CandidateVenue = {
    _id: "v_hamlet_regression",
    name: "Hamlet Vineyards",
    email: "va@hamletvineyards.com",
    contactName: "Liza Crowder",
    notes:
      "Type of gig: Vineyard\nComments: Sent pitch email regarding Sunday afternoons 2026-05-09\nStatus (sheet): [S]\nDate called: 2026-05-09\nNotes: Sent pitch email regarding Sunday afternoons to va@hamletvineyards.com on 2026-05-09.\n\n[2026-07-22] Liza Crowder: 2026 music calendar is fully booked. Reconnect for 2027 season.",
    touches: [],
  };
  const hamletPitch = renderPitch(hamletVenue, weekend);
  assertEquals(hamletPitch.body.includes("Following up on our earlier conversation"), false);
  assertEquals(hamletPitch.body.includes("Following up on our recent phone conversation"), false);
  assertEquals(hamletPitch.body.includes("Following up on connecting in person"), false);
  assertEquals(validateVoiceRules(hamletPitch.body).valid, true);
});

Deno.test("renderPitchesFromBackend: forwards touch-based conversation opener as customIntro to canonical preview renderer", async () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  const capturedRequests: Array<{ url: string; query: Record<string, string> }> = [];

  const mockFetch: typeof fetch = (input) => {
    const urlStr = typeof input === "string" ? input : (input as Request).url;
    const urlObj = new URL(urlStr);
    const query: Record<string, string> = {};
    for (const [k, v] of urlObj.searchParams.entries()) {
      query[k] = v;
    }
    capturedRequests.push({ url: urlStr, query });

    const venueIds = (query.venueIds || "").split(",").filter(Boolean);
    const results = venueIds.map((id) => {
      let bodyHtml = "<p>Hi there,</p><p>Acoustic Duo</p>";
      if (query.customIntro) {
        bodyHtml = renderCustomHtml(query.customIntro);
      }
      return {
        venueId: id,
        venueName: `Venue ${id}`,
        subject:
          `Performance Inquiry: Josh and Maria — Acoustic Duo for October 2026 — Venue ${id}`,
        body: bodyHtml,
      };
    });

    return Promise.resolve(
      new Response(JSON.stringify(results), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const callVenue: CandidateVenue = {
    _id: "venue-call",
    name: "Call Brewery",
    email: "booking@callbrewery.com",
    contactName: "Dave",
    touches: [{ type: "call" }],
  };

  const visitVenue: CandidateVenue = {
    _id: "venue-visit",
    name: "Visit Tavern",
    email: "booking@visittavern.com",
    contactName: "Sarah",
    touches: [{ type: "visit" }],
  };

  const noTouchVenue1: CandidateVenue = {
    _id: "venue-notouch-1",
    name: "Quiet Pub",
    email: "booking@quietpub.com",
    notes: "Date called: 2026-05-09. Spoke with manager on phone.",
    touches: [],
  };

  const noTouchVenue2: CandidateVenue = {
    _id: "venue-notouch-2",
    name: "Still Pub",
    email: "booking@stillpub.com",
    touches: [],
  };

  const pitches = await renderPitchesFromBackend(
    [callVenue, visitVenue, noTouchVenue1, noTouchVenue2],
    weekend,
    {},
    mockFetch,
  );

  assertEquals(pitches.length, 4);

  // 1. Call venue gets its own preview request with the phone opener forwarded as customIntro
  const callReq = capturedRequests.find((r) => r.query.venueIds === "venue-call");
  assertEquals(Boolean(callReq), true);
  assertEquals(callReq!.query.customIntro?.includes("Hi Dave,"), true);
  assertEquals(
    callReq!.query.customIntro?.includes("Following up on our recent phone conversation"),
    true,
  );
  assertEquals(
    callReq!.query.customIntro?.includes("acoustic set at Call Brewery"),
    true,
  );

  // 2. Visit venue gets its own preview request with the in-person opener forwarded as customIntro
  const visitReq = capturedRequests.find((r) => r.query.venueIds === "venue-visit");
  assertEquals(Boolean(visitReq), true);
  assertEquals(visitReq!.query.customIntro?.includes("Hi Sarah,"), true);
  assertEquals(
    visitReq!.query.customIntro?.includes("Following up on connecting in person"),
    true,
  );
  assertEquals(
    visitReq!.query.customIntro?.includes("acoustic set at Visit Tavern"),
    true,
  );

  // 3. No-touch venues are batched together with no customIntro forwarded
  const noTouchReq = capturedRequests.find((r) =>
    r.query.venueIds?.includes("venue-notouch-1") && r.query.venueIds?.includes("venue-notouch-2")
  );
  assertEquals(Boolean(noTouchReq), true);
  assertEquals(noTouchReq!.query.customIntro, undefined);

  // 4. Rendered pitch email objects preserve the phone/visit opener in body and fields
  const callPitch = pitches.find((p) => p.venueId === "venue-call");
  assertStringIncludes(callPitch!.body, "Following up on our recent phone conversation");
  assertEquals(
    callPitch?.customIntro?.includes("Following up on our recent phone conversation"),
    true,
  );

  const visitPitch = pitches.find((p) => p.venueId === "venue-visit");
  assertStringIncludes(visitPitch!.body, "Following up on connecting in person");
  assertEquals(visitPitch?.customIntro?.includes("Following up on connecting in person"), true);

  const noTouchPitch = pitches.find((p) => p.venueId === "venue-notouch-1");
  assertEquals(noTouchPitch!.body.includes("Following up on our recent phone conversation"), false);
  assertEquals(noTouchPitch!.body.includes("Following up on connecting in person"), false);
  assertEquals(noTouchPitch!.body.includes("Following up on our earlier conversation"), false);
  assertEquals(noTouchPitch?.customIntro, undefined);

  // 5. Verification options accurately resolve customIntro for call/visit venues
  const vOpts = verificationOptionsFromTweaks(
    [callVenue, visitVenue, noTouchVenue1, noTouchVenue2],
    undefined,
    weekend,
    DEFAULT_TEMPLATES,
  );
  assertEquals(Boolean(vOpts["venue-call"]?.customIntro), true);
  assertEquals(Boolean(vOpts["venue-visit"]?.customIntro), true);
  assertEquals(vOpts["venue-notouch-1"], undefined);
  assertEquals(vOpts["venue-notouch-2"], undefined);
});

Deno.test("resolveConversationIntro: returns plain-text intro for call and visit, and undefined when no context", () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  const callVenue: CandidateVenue = {
    _id: "v_call_direct",
    name: "Call Brewery",
    contactName: "Dave",
    touches: [{ type: "call" }],
  };
  const callIntro = resolveConversationIntro(callVenue, weekend);
  assertEquals(
    callIntro,
    "Hi Dave,\n\nFollowing up on our recent phone conversation — wanted to check if October 16–18, 2026 might work for an acoustic set at Call Brewery.",
  );

  const visitVenue: CandidateVenue = {
    _id: "v_visit_direct",
    name: "Visit Tavern",
    contactName: "Sarah",
    touches: [{ type: "visit" }],
  };
  const visitIntro = resolveConversationIntro(visitVenue, weekend);
  assertEquals(
    visitIntro,
    "Hi Sarah,\n\nFollowing up on connecting in person — wanted to check if October 16–18, 2026 might work for an acoustic set at Visit Tavern.",
  );

  const noTouchVenue: CandidateVenue = {
    _id: "v_none_direct",
    name: "Plain Pub",
    touches: [],
  };
  assertEquals(resolveConversationIntro(noTouchVenue, weekend), undefined);
});

Deno.test("renderPitchesFromBackend: returning call venue with apostrophes and ampersands passes template verification with escaped HTML", async () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  const returningVenueWithAmp: CandidateVenue = {
    _id: "venue-mac-bobs",
    name: "Mac & Bob's Restaurant",
    email: "booking@macandbobs.com",
    contactName: "Dave",
    touches: [{ type: "call" }],
    reason: { lastGigDate: "2026-01-10" },
    venueType: "PubFestivalBrewery",
  };

  // Mock backend GET /outreach/preview:
  // Mirrors buildPitchEmail / renderCustomHtml which escapes & to &amp; and ' to &#39;.
  const mockFetch: typeof fetch = (input) => {
    const urlStr = typeof input === "string" ? input : (input as Request).url;
    const urlObj = new URL(urlStr);
    const customIntro = urlObj.searchParams.get("customIntro") || "";
    const renderedIntro = renderCustomHtml(customIntro);

    const template = DEFAULT_TEMPLATES.find(
      (t) => t.type === "PubFestivalBrewery" && t.stage === "returning",
    )!;
    const bodyResolved = template.bodyHtml!
      .replaceAll("[Booking Period]", "October 2026")
      .replaceAll("[Target Dates]", "October 16–18, 2026")
      .replace("[Custom Body]\n", "");
    const body = `${renderedIntro}\n${bodyResolved}`;

    const results = [
      {
        venueId: "venue-mac-bobs",
        venueName: "Mac & Bob's Restaurant",
        subject: "Back at Mac & Bob's Restaurant this October 2026? — Josh & Maria",
        body,
      },
    ];

    return Promise.resolve(
      new Response(JSON.stringify(results), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const pitches = await renderPitchesFromBackend(
    [returningVenueWithAmp],
    weekend,
    { templates: DEFAULT_TEMPLATES },
    mockFetch,
  );

  assertEquals(pitches.length, 1);
  const pitch = pitches[0];
  assertEquals(pitch.customIntro !== undefined, true);
  assertStringIncludes(pitch.customIntro!, "Following up on our recent phone conversation");
  // Backend preview rendered with escaped it&#39;s, we&#39;d, &amp;
  assertStringIncludes(pitch.htmlBody || "", "it&#39;s");
  assertStringIncludes(pitch.htmlBody || "", "we&#39;d");
  assertStringIncludes(pitch.htmlBody || "", "Mac &amp; Bob&#39;s Restaurant");

  // 1. With effective generated intros passed to verificationOptionsFromTweaks:
  const verificationOpts = verificationOptionsFromTweaks(
    [returningVenueWithAmp],
    undefined,
    weekend,
    DEFAULT_TEMPLATES,
  );
  assertEquals(Boolean(verificationOpts["venue-mac-bobs"]?.customIntro), true);

  const verificationResult = verifyBatchAgainstTemplates(
    pitches,
    [returningVenueWithAmp],
    weekend,
    DEFAULT_TEMPLATES,
    verificationOpts,
  );
  assertEquals(verificationResult.valid, true);
  assertEquals(verificationResult.violations.length, 0);

  // 2. Proving the regression: without weekend passed (old behavior omitting customIntro),
  // template verification fails due to unescaped HTML comparison.
  const oldOpts = verificationOptionsFromTweaks([returningVenueWithAmp]);
  assertEquals(oldOpts["venue-mac-bobs"], undefined);
  const failedResult = verifyBatchAgainstTemplates(
    pitches,
    [returningVenueWithAmp],
    weekend,
    DEFAULT_TEMPLATES,
    oldOpts,
  );
  assertEquals(failedResult.valid, false);
  assertEquals(failedResult.violations.length, 1);
  assertStringIncludes(
    failedResult.violations[0].reason,
    "Rendered body diverges from stored template",
  );
});

// The server requires the whole remaining Gate 1/Gate 2 set before any send,
// then checks each rendered fingerprint using the inputs persisted at preflight.
for (const mutation of ["none", "missing-opener", "changed-body", "venue-subset"]) {
  Deno.test(`mixed-venue preview/approval/dispatch contract: ${mutation}`, async () => {
    const weekend: TargetWeekend = {
      start: "2026-10-16",
      end: "2026-10-18",
      rawText: "Oct 16-18 2026",
      label: "October 16–18, 2026",
      year: 2026,
      month: 10,
      days: [16, 17, 18],
    };
    const candidates: CandidateVenue[] = [
      { _id: "call", name: "Call Brewery", contactName: "Dave", touches: [{ type: "call" }] },
      { _id: "visit", name: "Visit Tavern", contactName: "Sarah", touches: [{ type: "visit" }] },
      { _id: "standard", name: "Standard Venue", notes: "Date called: 2026-05-09", touches: [] },
      { _id: "tweak", name: "Tweaked Venue", touches: [] },
    ].map((c) => ({ ...c, email: c._id + "@example.com", venueType: "PubFestivalBrewery" }));
    const venueIds = candidates.map((c) => c._id!);
    const approved = new Map<string, string>();
    const preflightCalls: Record<string, unknown>[] = [];
    const sendCalls: Record<string, unknown>[] = [];
    const persisted = new Map<string, PitchEmail>();
    const sent: string[] = [];
    const reply = (data: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(data), { status }));
    const render = (
      venueId: string,
      slots: { customIntro?: string; customBody?: string } = {},
    ): PitchEmail => {
      const venue = candidates.find((c) => c._id === venueId)!;
      // Simulate the server's custom-slot renderer, which does not infer conversation
      // context. The companion backend regression exercises the real renderer and mailer.
      const intro = slots.customIntro
        ? renderCustomHtml(slots.customIntro)
        : `<p>Hi ${venue.contactName || "there"},</p><p>Default opener.</p>`;
      const htmlBody = `${intro}\n<p>Booking for ${weekend.label}.</p>\n${
        slots.customBody ? renderCustomHtml(slots.customBody) : ""
      }`;
      return {
        venueId,
        venueName: venue.name,
        to: venue.email!,
        subject: `Inquiry: ${venue.name}`,
        body: htmlBody,
        htmlBody,
      };
    };
    const fingerprint = (pitch: PitchEmail) =>
      computeDraftFingerprint({ subject: pitch.subject, body: pitch.htmlBody! });

    const mockFetch: typeof fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/outreach/preview") {
        const slots = {
          customIntro: url.searchParams.get("customIntro") || undefined,
          customBody: url.searchParams.get("customBody") || undefined,
        };
        return reply(
          url.searchParams.get("venueIds")!.split(",").map((id) => {
            const pitch = render(id, slots);
            return {
              venueId: id,
              venueName: pitch.venueName,
              subject: pitch.subject,
              body: pitch.htmlBody,
            };
          }),
        );
      }
      if (url.pathname === "/outreach/approval/draft-fingerprints") {
        if (!init?.method || init.method === "GET") {
          return reply({ message: "No approval found" }, 404);
        }
        const body = JSON.parse(init.body as string);
        for (const item of body.draftFingerprints) approved.set(item.venueId, item.fingerprint);
        return reply({ ...body, _id: "gate2-record" });
      }
      if (url.pathname === "/outreach/batch/preflight") {
        const body = JSON.parse(init?.body as string);
        preflightCalls.push(body);
        const actualSet = new Set(body.venueIds);
        if (actualSet.size !== venueIds.length || !venueIds.every((id) => actualSet.has(id))) {
          return reply({ message: "Gate 1 venue-set approval does not match batch venueIds" }, 403);
        }
        if (approved.size !== actualSet.size) {
          return reply({ message: "Gate 2 venue set mismatch" }, 403);
        }
        const customizations: Array<
          { venueId: string; customIntro?: string; customBody?: string }
        > = body.venueCustomizations || [];
        for (const id of body.venueIds) {
          const slots = customizations.find((c) => c.venueId === id) || {};
          const pitch = render(id, slots);
          if (fingerprint(pitch) !== approved.get(id)) {
            return reply({ message: "Gate 2 draft fingerprint mismatch: " + id }, 403);
          }
          persisted.set(id, pitch);
        }
        return reply({ dispatchId: "mixed-dispatch", venueCount: venueIds.length });
      }
      if (url.pathname === "/outreach/batch") {
        const body = JSON.parse(init?.body as string);
        sendCalls.push(body);
        assertEquals(body, { dispatchId: "mixed-dispatch" });
        // Simulate a time-limited send: all copy has passed preflight before the first call.
        assertEquals(persisted.size, venueIds.length);
        const id = venueIds[sent.length];
        assertEquals(fingerprint(persisted.get(id)!), approved.get(id));
        sent.push(id);
        return reply({
          sent: 1,
          remaining: venueIds.length - sent.length,
          skipped: [],
          records: [{ venueId: id }],
        });
      }
      throw new Error("Unexpected request: " + url);
    };
    const config = { backendUrl: "https://test.local", token: "test-token" };
    const pitches = await renderPitchesFromBackend(candidates, weekend, {
      ...config,
      tweaks: [{ venueId: "tweak", customBody: "My son lives nearby." }],
    }, mockFetch);
    assertEquals(pitches.length, 4);
    assertStringIncludes(pitches[0].customIntro!, "phone conversation");
    assertStringIncludes(pitches[1].customIntro!, "connecting in person");
    assertEquals(pitches[2].customIntro, undefined);
    assertEquals(pitches[3].customBody, "My son lives nearby.");
    const session = new Gate2ReviewSession({
      weekend,
      candidates,
      pitches,
      fetchFn: mockFetch,
      backendConfig: config,
    });
    await session.approveWholeBatch({
      approver: "Josh",
      batchId: "mixed-batch",
      explicitApproval: true,
    });
    assertEquals(approved.size, 4);

    if (mutation === "missing-opener") pitches[1].customIntro = undefined;
    if (mutation === "changed-body") pitches[3].customBody = "Changed after approval.";
    const options = {
      ...config,
      weekend,
      venueIds: mutation === "venue-subset" ? venueIds.slice(0, 2) : venueIds,
      pitches,
    };
    if (mutation === "none") {
      const result = await dispatchBatchOutreach(options, mockFetch);
      assertEquals(result.sent, 4);
      assertEquals(sent, venueIds);
      assertEquals(sendCalls.length, 4);
    } else {
      const err = await assertRejects(
        () => dispatchBatchOutreach(options, mockFetch),
        BatchDispatchError,
      );
      assertEquals(err.stage, "preflight");
      assertEquals(err.partialResult.sent, 0);
      assertEquals(sendCalls.length, 0);
    }
    assertEquals(preflightCalls.length, 1);
    if (mutation !== "venue-subset") assertEquals(preflightCalls[0].venueIds, venueIds);
    if (mutation === "none") {
      assertEquals(preflightCalls[0].venueCustomizations, [
        { venueId: "call", customIntro: pitches[0].customIntro },
        { venueId: "visit", customIntro: pitches[1].customIntro },
        { venueId: "tweak", customBody: pitches[3].customBody },
      ]);
    }
  });
}
