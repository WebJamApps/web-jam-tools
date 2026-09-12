// test/book-gig-template-verification.test.ts — Fixture tests for D-50 template fidelity
// verification: every rendered email must be checked against its stored Template record, with
// variation strictly confined to declared placeholders and the free-form [Custom Body] slot.

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  renderPitch,
  verifyBatchAgainstTemplates,
  verifyPitchAgainstTemplate,
} from "../src/book-gig/pitch.ts";
import type {
  CandidateVenue,
  EmailTemplate,
  PitchEmail,
  TargetWeekend,
} from "../src/book-gig/types.ts";

const WEEKEND: TargetWeekend = {
  start: "2026-10-16",
  end: "2026-10-18",
  rawText: "Oct 16-18 2026",
  label: "October 16–18, 2026",
  year: 2026,
  month: 10,
  days: [16, 17, 18],
};

const FIXTURE_TEMPLATE: EmailTemplate = {
  type: "PubFestivalBrewery",
  stage: "cold",
  subject: "Performance Inquiry: Josh and Maria — Acoustic Duo for [Booking Period] — [Venue Name]",
  introHtml:
    `<p>Hi [Contact Name],</p>\n<p>We'd love to bring our acoustic set to [Venue Name].</p>`,
  bodyHtml:
    `[Custom Body]\n<p>We have [Target Dates] available for [Booking Period].</p>\n<p>Thanks for considering us.</p>`,
};

const RETURNING_TEMPLATE: EmailTemplate = {
  type: "PubFestivalBrewery",
  stage: "returning",
  subject: "Back at [Venue Name] this [Booking Period]? — Josh & Maria",
  introHtml: `<p>Hi [Contact Name],</p>\n<p>We had a blast at [Venue Name] last time.</p>`,
  bodyHtml: `[Custom Body]\n<p>We're booking [Booking Period] — is [Target Dates] open?</p>`,
};

const TEMPLATES: EmailTemplate[] = [FIXTURE_TEMPLATE, RETURNING_TEMPLATE];

function coldVenue(overrides: Partial<CandidateVenue> = {}): CandidateVenue {
  return {
    _id: "venue-cold-1",
    name: "The Test Room",
    email: "booking@testroom.example",
    venueType: "PubFestivalBrewery",
    contactName: "Alex",
    ...overrides,
  };
}

function returningVenue(overrides: Partial<CandidateVenue> = {}): CandidateVenue {
  return {
    _id: "venue-returning-1",
    name: "The Return Stage",
    email: "booking@returnstage.example",
    venueType: "PubFestivalBrewery",
    contactName: "Sam",
    reason: { lastGigDate: "2026-01-10" },
    ...overrides,
  };
}

Deno.test("verifyPitchAgainstTemplate: a faithful render with no custom body passes", () => {
  const venue = coldVenue();
  const pitch = renderPitch(venue, WEEKEND, {}, TEMPLATES);
  const violation = verifyPitchAgainstTemplate(pitch, venue, WEEKEND, {}, TEMPLATES);
  assertEquals(violation, null);
});

Deno.test("verifyPitchAgainstTemplate: a faithful render with a declared custom body passes", () => {
  const venue = coldVenue({ _id: "venue-cold-2" });
  const pitch = renderPitch(venue, WEEKEND, {
    personalHook: "We drove past your marquee last week.",
  }, TEMPLATES);
  const violation = verifyPitchAgainstTemplate(
    pitch,
    venue,
    WEEKEND,
    { personalHook: "We drove past your marquee last week." },
    TEMPLATES,
  );
  assertEquals(violation, null);
  // Sanity: the custom body text really did make it into the rendered email.
  assertEquals(pitch.htmlBody!.includes("We drove past your marquee last week."), true);
});

Deno.test("verifyPitchAgainstTemplate: a returning-venue render passes against the returning template", () => {
  const venue = returningVenue();
  const pitch = renderPitch(venue, WEEKEND, {}, TEMPLATES);
  assertEquals(pitch.templateStage, "returning");
  const violation = verifyPitchAgainstTemplate(pitch, venue, WEEKEND, {}, TEMPLATES);
  assertEquals(violation, null);
});

Deno.test("verifyPitchAgainstTemplate: recognizes the deterministic phone-conversation intro variant", () => {
  const venue = returningVenue({
    _id: "venue-phone-1",
    contactNotes: "Called the venue and spoke with the owner about a return date.",
  });
  const pitch = renderPitch(venue, WEEKEND, {}, TEMPLATES);
  // Confirm the phone-conversation intro override actually kicked in (diverges from the raw
  // template's own introHtml), so this test is exercising the variant it claims to.
  assertNotEquals(pitch.htmlBody!.includes("We had a blast at"), true);
  const violation = verifyPitchAgainstTemplate(pitch, venue, WEEKEND, {}, TEMPLATES);
  assertEquals(violation, null);
});

Deno.test("verifyPitchAgainstTemplate: catches undeclared invented text spliced into the body", () => {
  const venue = coldVenue({ _id: "venue-cold-3" });
  const pitch = renderPitch(venue, WEEKEND, {}, TEMPLATES);

  // Simulate a divergent render: prose was inserted that came from neither the stored
  // template nor a declared placeholder substitution.
  const corrupted: PitchEmail = {
    ...pitch,
    htmlBody: pitch.htmlBody!.replace(
      "Thanks for considering us.",
      "Thanks for considering us. As seen on TV!",
    ),
  };

  const violation = verifyPitchAgainstTemplate(corrupted, venue, WEEKEND, {}, TEMPLATES);
  assertNotEquals(violation, null);
  assertEquals(violation!.reason.includes("diverges from stored template"), true);
});

Deno.test("verifyPitchAgainstTemplate: catches a divergent subject line", () => {
  const venue = coldVenue({ _id: "venue-cold-4" });
  const pitch = renderPitch(venue, WEEKEND, {}, TEMPLATES);

  const corrupted: PitchEmail = {
    ...pitch,
    subject: "URGENT: Book us now!!! — " + pitch.subject,
  };

  const violation = verifyPitchAgainstTemplate(corrupted, venue, WEEKEND, {}, TEMPLATES);
  assertNotEquals(violation, null);
  assertEquals(violation!.reason.includes("Subject diverges"), true);
});

Deno.test("verifyPitchAgainstTemplate: refuses when the declared template cannot be found", () => {
  const venue = coldVenue({ _id: "venue-cold-5" });
  const pitch = renderPitch(venue, WEEKEND, {}, TEMPLATES);

  const corrupted: PitchEmail = {
    ...pitch,
    // "OnlineForm" has no entry in the fixture pool or in DEFAULT_TEMPLATES, so this claim
    // cannot be resolved to any stored record at all.
    templateType: "OnlineForm",
    templateStage: "cold",
  };

  const violation = verifyPitchAgainstTemplate(corrupted, venue, WEEKEND, {}, TEMPLATES);
  assertNotEquals(violation, null);
  assertEquals(violation!.reason.includes("No stored Template record found"), true);
});

Deno.test("verifyBatchAgainstTemplates: a clean batch passes with no violations", () => {
  const venueA = coldVenue({ _id: "venue-batch-a" });
  const venueB = returningVenue({ _id: "venue-batch-b" });
  const pitchA = renderPitch(venueA, WEEKEND, {}, TEMPLATES);
  const pitchB = renderPitch(venueB, WEEKEND, {}, TEMPLATES);

  const result = verifyBatchAgainstTemplates(
    [pitchA, pitchB],
    [venueA, venueB],
    WEEKEND,
    TEMPLATES,
  );

  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("verifyBatchAgainstTemplates: one divergent render refuses the whole batch, naming the venue", () => {
  const venueA = coldVenue({ _id: "venue-batch-c" });
  const venueB = coldVenue({ _id: "venue-batch-d", name: "The Corrupted Room" });
  const pitchA = renderPitch(venueA, WEEKEND, {}, TEMPLATES);
  const pitchB = renderPitch(venueB, WEEKEND, {}, TEMPLATES);

  const corruptedB: PitchEmail = {
    ...pitchB,
    htmlBody: pitchB.htmlBody!.replace(
      "Thanks for considering us.",
      "Thanks for considering us. Limited time offer, act now!",
    ),
  };

  const result = verifyBatchAgainstTemplates(
    [pitchA, corruptedB],
    [venueA, venueB],
    WEEKEND,
    TEMPLATES,
  );

  assertEquals(result.valid, false);
  assertEquals(result.violations.length, 1);
  assertEquals(result.violations[0].venueId, "venue-batch-d");
  assertEquals(result.violations[0].venueName, "The Corrupted Room");
});
