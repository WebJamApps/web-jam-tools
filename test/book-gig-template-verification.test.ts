// test/book-gig-template-verification.test.ts — Fixture tests for D-50 template fidelity
// verification: every rendered email must be checked against its stored Template record, with
// variation strictly confined to declared placeholders and the free-form [Custom Body] slot.

import { assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import {
  BACKEND_DARK_WRAPPER_END,
  BACKEND_DARK_WRAPPER_START,
  BACKEND_FOOTER_HTML,
  DARK_WRAPPER_END,
  DARK_WRAPPER_START,
  renderPitch,
  renderPitchesFromBackend,
  resolveBookingPeriod,
  resolveVenueTemplateType,
  stripDarkWrapper,
  verificationOptionsFromTweaks,
  verifyBatchAgainstTemplates,
  verifyPitchAgainstTemplate,
  wrapDarkEmail,
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

Deno.test("resolveVenueTemplateType: falls back to MidRangeCafeBar when venue has no explicit venueType or templateOverride", () => {
  const unclassified = coldVenue({ venueType: undefined, templateOverride: undefined });
  assertEquals(resolveVenueTemplateType(unclassified), "MidRangeCafeBar");

  const coffeeShop = coldVenue({ venueType: "CoffeeShop" as unknown as undefined });
  assertEquals(resolveVenueTemplateType(coffeeShop), "MidRangeCafeBar");

  const brewery = coldVenue({ venueType: "Brewery" as unknown as undefined });
  assertEquals(resolveVenueTemplateType(brewery), "PubFestivalBrewery");

  const override = coldVenue({ templateOverride: "Originals" });
  assertEquals(resolveVenueTemplateType(override), "Originals");
});

Deno.test("verifyPitchAgainstTemplate: accommodates backend footerHtml when template.footerPhotoRef is present", () => {
  const templateWithPhoto: EmailTemplate = {
    ...FIXTURE_TEMPLATE,
    footerPhotoRef: "footer-josh-maria",
  };
  const venue = coldVenue();
  const pitch = renderPitch(venue, WEEKEND, {}, [templateWithPhoto]);

  // Case 1: Backend pitch preview includes BACKEND_FOOTER_HTML
  const pitchWithFooter: PitchEmail = {
    ...pitch,
    htmlBody: `${pitch.htmlBody}${BACKEND_FOOTER_HTML}`,
  };
  const violation = verifyPitchAgainstTemplate(
    pitchWithFooter,
    venue,
    WEEKEND,
    {},
    [templateWithPhoto],
  );
  assertEquals(violation, null);

  // Case 2: Local pitch without footerHtml still passes
  const violationLocal = verifyPitchAgainstTemplate(
    pitch,
    venue,
    WEEKEND,
    {},
    [templateWithPhoto],
  );
  assertEquals(violationLocal, null);

  // Case 3: Template without footerPhotoRef refuses pitch that carries BACKEND_FOOTER_HTML
  const violationWithoutRef = verifyPitchAgainstTemplate(
    pitchWithFooter,
    venue,
    WEEKEND,
    {},
    [FIXTURE_TEMPLATE],
  );
  assertNotEquals(violationWithoutRef, null);
  assertEquals(
    violationWithoutRef!.reason.includes("diverges from stored template"),
    true,
  );
});

Deno.test("verifyPitchAgainstTemplate: handles 'there' contact name fallback without divergence", () => {
  const venue = coldVenue({ contactName: "" });

  // Render locally (which uses "Hi,")
  const localPitch = renderPitch(venue, WEEKEND, {}, TEMPLATES);
  assertEquals(localPitch.htmlBody!.includes("<p>Hi,</p>"), true);
  assertEquals(verifyPitchAgainstTemplate(localPitch, venue, WEEKEND, {}, TEMPLATES), null);

  // Simulate backend render (which substitutes "there" for [Contact Name], yielding "<p>Hi there,</p>")
  const backendPitch: PitchEmail = {
    ...localPitch,
    htmlBody: localPitch.htmlBody!.replace("<p>Hi,</p>", "<p>Hi there,</p>"),
  };
  assertEquals(verifyPitchAgainstTemplate(backendPitch, venue, WEEKEND, {}, TEMPLATES), null);

  // An invented greeting still fails closed
  const corruptedPitch: PitchEmail = {
    ...localPitch,
    htmlBody: localPitch.htmlBody!.replace("<p>Hi,</p>", "<p>Hi stranger,</p>"),
  };
  const violation = verifyPitchAgainstTemplate(corruptedPitch, venue, WEEKEND, {}, TEMPLATES);
  assertNotEquals(violation, null);
  assertEquals(violation!.reason.includes("diverges from stored template"), true);
});

Deno.test("verifyPitchAgainstTemplate: greets first word of multi-word contactName and matches backend (#1007, D-69)", () => {
  const venue = coldVenue({ contactName: "Liza Crowder" });

  // Render locally (which predicts first word "Liza")
  const localPitch = renderPitch(venue, WEEKEND, {}, TEMPLATES);
  assertEquals(localPitch.htmlBody!.includes("<p>Hi Liza,</p>"), true);
  assertEquals(localPitch.htmlBody!.includes("<p>Hi Liza Crowder,</p>"), false);
  assertEquals(verifyPitchAgainstTemplate(localPitch, venue, WEEKEND, {}, TEMPLATES), null);

  // Backend render also greets first word "Hi Liza,"
  const backendHtmlBody =
    `<p>Hi Liza,</p>\n<p>We'd love to bring our acoustic set to The Test Room.</p>\n<p>We have October 16–18, 2026 available for October 2026.</p>\n<p>Thanks for considering us.</p>`;
  const backendPitch: PitchEmail = {
    venueId: venue._id!,
    venueName: venue.name,
    to: venue.email!,
    subject: "Performance Inquiry: Josh and Maria — Acoustic Duo for October 2026 — The Test Room",
    body:
      "Hi Liza,\n\nWe'd love to bring our acoustic set to The Test Room.\n\nWe have October 16–18, 2026 available for October 2026.\n\nThanks for considering us.",
    htmlBody: backendHtmlBody,
    templateType: "PubFestivalBrewery",
    templateStage: "cold",
  };
  assertEquals(verifyPitchAgainstTemplate(backendPitch, venue, WEEKEND, {}, TEMPLATES), null);

  // Stale rendered email containing full name "Hi Liza Crowder," fails verification
  const stalePitch: PitchEmail = {
    ...localPitch,
    htmlBody: localPitch.htmlBody!.replace("<p>Hi Liza,</p>", "<p>Hi Liza Crowder,</p>"),
  };
  const violation = verifyPitchAgainstTemplate(stalePitch, venue, WEEKEND, {}, TEMPLATES);
  assertNotEquals(violation, null);
  assertEquals(violation!.reason.includes("diverges from stored template"), true);
});

Deno.test("verifyPitchAgainstTemplate: fails closed when candidate venue record is missing or corrupted", () => {
  const venue = coldVenue();
  const pitch = renderPitch(venue, WEEKEND, {}, TEMPLATES);

  // Missing _id
  const corruptedVenue = { ...venue, _id: "" } as CandidateVenue;
  const violation = verifyPitchAgainstTemplate(pitch, corruptedVenue, WEEKEND, {}, TEMPLATES);
  assertNotEquals(violation, null);
  assertEquals(violation!.reason.includes("missing or corrupted"), true);
});

Deno.test("renderPitchesFromBackend: forwards calculated bookingPeriod to fetchPitchPreviews", async () => {
  let requestedUrl = "";
  const mockFetch: typeof fetch = (input) => {
    requestedUrl = typeof input === "string" ? input : (input as Request).url;
    return Promise.resolve(
      new Response(
        JSON.stringify([
          {
            venueId: "venue-cold-1",
            venueName: "The Test Room",
            subject:
              "Performance Inquiry: Josh and Maria — Acoustic Duo for October 2026 — The Test Room",
            body: "<p>Hi there,</p><p>Acoustic Duo</p>",
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  const venue = coldVenue();
  const pitches = await renderPitchesFromBackend([venue], WEEKEND, {}, mockFetch);

  assertEquals(pitches.length, 1);
  assertStringIncludes(requestedUrl, "bookingPeriod=October+2026");
  assertStringIncludes(requestedUrl, "targetDates=October+16%E2%80%9318%2C+2026");
});

const BACKEND_BODY_EMPTY_SLOT =
  "\n<p>We have October 16–18, 2026 available for October 2026.</p>\n<p>Thanks for considering us.</p>";
const BACKEND_COLD_INTRO =
  "<p>Hi Alex,</p>\n<p>We'd love to bring our acoustic set to The Test Room.</p>";

Deno.test("verifyPitchAgainstTemplate: passes a backend render whose stage differs from the local prediction", () => {
  // Backend rendered the returning template (e.g. the venue has a replied outreach) while the
  // local gig-history prediction still declares cold.
  const venue = coldVenue();
  const returningRender = renderPitch(
    coldVenue({ reason: { lastGigDate: "2026-01-10" } }),
    WEEKEND,
    {},
    TEMPLATES,
  );
  assertEquals(returningRender.templateStage, "returning");
  const declaredCold: PitchEmail = { ...returningRender, templateStage: "cold" };
  assertEquals(verifyPitchAgainstTemplate(declaredCold, venue, WEEKEND, {}, TEMPLATES), null);

  // Backend falls back to the cold template when the type has no returning variant.
  const coldOnly = [FIXTURE_TEMPLATE];
  const returning = returningVenue();
  const coldRender = renderPitch(returning, WEEKEND, {}, coldOnly);
  const declaredReturning: PitchEmail = { ...coldRender, templateStage: "returning" };
  assertEquals(
    verifyPitchAgainstTemplate(declaredReturning, returning, WEEKEND, {}, coldOnly),
    null,
  );

  // Prose matching neither stage is still refused, reported against the declared stage.
  const invented: PitchEmail = {
    ...declaredCold,
    htmlBody: declaredCold.htmlBody!.replace("last time", "at the festival"),
  };
  const violation = verifyPitchAgainstTemplate(invented, venue, WEEKEND, {}, TEMPLATES);
  assertNotEquals(violation, null);
  assertStringIncludes(violation!.reason, "PubFestivalBrewery/cold");
});

Deno.test("renderPitch: falls back to the same type's cold template, never another stage's copy", () => {
  const returningPitch = renderPitch(returningVenue(), WEEKEND, {}, [FIXTURE_TEMPLATE]);
  assertEquals(returningPitch.templateType, "PubFestivalBrewery");
  assertEquals(returningPitch.templateStage, "cold");

  // A cold venue whose pool only holds returning copy must not receive "last time" prose.
  const coldPitch = renderPitch(coldVenue(), WEEKEND, {}, [RETURNING_TEMPLATE]);
  assertEquals(coldPitch.templateStage, "cold");
  assertEquals(coldPitch.htmlBody!.includes("last time"), false);
});

Deno.test("verifyPitchAgainstTemplate: accepts a customIntro rendered the way the backend renders it", () => {
  const venue = coldVenue();
  const base = renderPitch(venue, WEEKEND, {}, TEMPLATES);
  const customIntro = "Hey Alex — Matt's sister said to write.\n\nWe'd love a date.";
  const backendPitch: PitchEmail = {
    ...base,
    htmlBody:
      `<p>Hey Alex — Matt&#39;s sister said to write.</p>\n<p>We&#39;d love a date.</p>${BACKEND_BODY_EMPTY_SLOT}`,
  };
  assertEquals(
    verifyPitchAgainstTemplate(backendPitch, venue, WEEKEND, { customIntro }, TEMPLATES),
    null,
  );

  // The raw, unescaped text is not what the backend sends, so it is refused.
  const rawPitch: PitchEmail = {
    ...base,
    htmlBody: `${customIntro}${BACKEND_BODY_EMPTY_SLOT}`,
  };
  assertNotEquals(
    verifyPitchAgainstTemplate(rawPitch, venue, WEEKEND, { customIntro }, TEMPLATES),
    null,
  );
});

Deno.test("verifyPitchAgainstTemplate: accepts a backend customBody with no newline after the intro", () => {
  const venue = coldVenue();
  const base = renderPitch(venue, WEEKEND, {}, TEMPLATES);
  const backendPitch: PitchEmail = {
    ...base,
    htmlBody: `${BACKEND_COLD_INTRO}<p>We drove past your marquee.</p>${BACKEND_BODY_EMPTY_SLOT}`,
  };
  assertEquals(verifyPitchAgainstTemplate(backendPitch, venue, WEEKEND, {}, TEMPLATES), null);
});

Deno.test("verificationOptionsFromTweaks: carries each tweaked venue's customIntro into verification", () => {
  const tweakedVenue = coldVenue({ _id: "venue-tweaked" });
  const plainVenue = coldVenue({ _id: "venue-plain", name: "Plain Room" });
  const options = verificationOptionsFromTweaks([tweakedVenue, plainVenue], [
    { venueId: "venue-tweaked", customIntro: "Hi again!" },
    { venueName: "Plain Room", customBody: "Body only." },
  ]);
  assertEquals(options, { "venue-tweaked": { customIntro: "Hi again!" } });
});

Deno.test("resolveBookingPeriod: recovers month and year from the weekend start when unparsed", () => {
  assertEquals(resolveBookingPeriod(WEEKEND), "October 2026");
  assertEquals(resolveBookingPeriod(WEEKEND, "Fall 2026"), "Fall 2026");
  const unparsed = { ...WEEKEND, year: 0, month: 0, start: "2027-01-08" };
  assertEquals(resolveBookingPeriod(unparsed), "January 2027");
});

Deno.test("stripDarkWrapper: strips exact wrapper start and end correctly", () => {
  const inner = "<p>Hello world</p>";
  const wrapped = `${DARK_WRAPPER_START}${inner}${DARK_WRAPPER_END}`;
  assertEquals(stripDarkWrapper(wrapped), inner);

  // Trimming tolerance
  const padded = `  ${DARK_WRAPPER_START}${inner}${DARK_WRAPPER_END} \n`;
  assertEquals(stripDarkWrapper(padded), inner);

  // Unwrapped string is returned untouched
  assertEquals(stripDarkWrapper(inner), inner);

  // Corrupted / altered wrapper is not stripped
  const corrupted = `<table bgcolor="#000000">${inner}</table>`;
  assertEquals(stripDarkWrapper(corrupted), corrupted);
});

Deno.test("verifyPitchAgainstTemplate: accepts a faithful render wrapped in backend dark-mode markup", () => {
  const venue = coldVenue();
  const pitch = renderPitch(venue, WEEKEND, {}, TEMPLATES);
  const wrappedPitch: PitchEmail = {
    ...pitch,
    htmlBody: wrapDarkEmail(pitch.htmlBody!),
  };

  const violation = verifyPitchAgainstTemplate(wrappedPitch, venue, WEEKEND, {}, TEMPLATES);
  assertEquals(violation, null);
});

Deno.test("verifyPitchAgainstTemplate: accepts an unwrapped faithful render (backward-compatible)", () => {
  const venue = coldVenue();
  const pitch = renderPitch(venue, WEEKEND, {}, TEMPLATES);

  // Pitch without wrapper (e.g. older stored draft or local preview) passes cleanly
  const violation = verifyPitchAgainstTemplate(pitch, venue, WEEKEND, {}, TEMPLATES);
  assertEquals(violation, null);
});

Deno.test("verifyPitchAgainstTemplate: handles backend dark wrapper when footer table is also present inside it", () => {
  const templateWithPhoto: EmailTemplate = {
    ...FIXTURE_TEMPLATE,
    footerPhotoRef: "footer-josh-maria",
  };
  const venue = coldVenue();
  const pitch = renderPitch(venue, WEEKEND, {}, [templateWithPhoto]);

  // Backend wrap order: footer is appended first, then whole email is wrapped in dark mode
  const wrappedWithFooter: PitchEmail = {
    ...pitch,
    htmlBody: wrapDarkEmail(`${pitch.htmlBody}${BACKEND_FOOTER_HTML}`),
  };

  const violation = verifyPitchAgainstTemplate(
    wrappedWithFooter,
    venue,
    WEEKEND,
    {},
    [templateWithPhoto],
  );
  assertEquals(violation, null);

  // Unexpected footer inside dark wrapper is still refused if template has no footerPhotoRef
  const violationWithoutRef = verifyPitchAgainstTemplate(
    wrappedWithFooter,
    venue,
    WEEKEND,
    {},
    [FIXTURE_TEMPLATE],
  );
  assertNotEquals(violationWithoutRef, null);
  assertStringIncludes(violationWithoutRef!.reason, "diverges from stored template");
});

Deno.test("verifyPitchAgainstTemplate: refuses batch when inner content diverges despite correct dark wrapper", () => {
  const venue = coldVenue();
  const pitch = renderPitch(venue, WEEKEND, {}, TEMPLATES);

  const corruptedInner = pitch.htmlBody!.replace(
    "Thanks for considering us.",
    "Thanks for considering us. Invented rogue line here!",
  );
  const wrappedCorrupted: PitchEmail = {
    ...pitch,
    htmlBody: wrapDarkEmail(corruptedInner),
  };

  const violation = verifyPitchAgainstTemplate(wrappedCorrupted, venue, WEEKEND, {}, TEMPLATES);
  assertNotEquals(violation, null);
  assertStringIncludes(violation!.reason, "diverges from stored template");
});

Deno.test("verifyPitchAgainstTemplate: refuses batch when dark wrapper is altered or corrupted", () => {
  const venue = coldVenue();
  const pitch = renderPitch(venue, WEEKEND, {}, TEMPLATES);

  // Altered wrapper markup (e.g. altered background color or unauthorized attributes)
  const alteredStart = BACKEND_DARK_WRAPPER_START.replace('bgcolor="#121212"', 'bgcolor="#333333"');
  const corruptedPitch: PitchEmail = {
    ...pitch,
    htmlBody: `${alteredStart}${pitch.htmlBody}${BACKEND_DARK_WRAPPER_END}`,
  };

  const violation = verifyPitchAgainstTemplate(corruptedPitch, venue, WEEKEND, {}, TEMPLATES);
  assertNotEquals(violation, null);
  assertStringIncludes(violation!.reason, "diverges from stored template");
});

Deno.test("verifyBatchAgainstTemplates: batch with dark-wrapped emails passes verification", () => {
  const venueA = coldVenue({ _id: "venue-batch-dark-a" });
  const venueB = returningVenue({ _id: "venue-batch-dark-b" });
  const pitchA = renderPitch(venueA, WEEKEND, {}, TEMPLATES);
  const pitchB = renderPitch(venueB, WEEKEND, {}, TEMPLATES);

  const wrappedA: PitchEmail = { ...pitchA, htmlBody: wrapDarkEmail(pitchA.htmlBody!) };
  const wrappedB: PitchEmail = { ...pitchB, htmlBody: wrapDarkEmail(pitchB.htmlBody!) };

  const result = verifyBatchAgainstTemplates(
    [wrappedA, wrappedB],
    [venueA, venueB],
    WEEKEND,
    TEMPLATES,
  );

  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("stripDarkWrapper: normalizes inline link colors added by dark wrapper back to baseline", () => {
  const innerWithLinks = '<p>Check <a href="https://example.com">our site</a> for details.</p>';
  const wrapped = wrapDarkEmail(innerWithLinks);
  assertStringIncludes(wrapped, 'style="color:#4fc3f7;"');
  assertEquals(stripDarkWrapper(wrapped), innerWithLinks);
});

Deno.test("verifyPitchAgainstTemplate: accepts dark-wrapped emails with links modified by applyInlineLinkColor", () => {
  const templateWithLinks: EmailTemplate = {
    type: "MidRangeCafeBar",
    stage: "cold",
    subject: "Performance Inquiry — Josh and Maria",
    introHtml: "<p>Hi [Contact Name],</p>",
    bodyHtml:
      '<p>Samples at <a href="https://joshandmariamusic.com">joshandmariamusic.com</a>.</p>',
  };
  const venue = coldVenue({ venueType: "MidRangeCafeBar" });
  const basePitch = renderPitch(venue, WEEKEND, {}, [templateWithLinks]);
  const wrappedPitch: PitchEmail = {
    ...basePitch,
    htmlBody: wrapDarkEmail(basePitch.htmlBody!),
  };

  const violation = verifyPitchAgainstTemplate(wrappedPitch, venue, WEEKEND, {}, [
    templateWithLinks,
  ]);
  assertEquals(violation, null);

  // Divergent link text inside dark wrapper is still caught and refused
  const corruptedInner = basePitch.htmlBody!.replace(
    'href="https://joshandmariamusic.com"',
    'href="https://roguesite.example.com"',
  );
  const corruptedWrapped: PitchEmail = {
    ...basePitch,
    htmlBody: wrapDarkEmail(corruptedInner),
  };
  const violationCorrupted = verifyPitchAgainstTemplate(corruptedWrapped, venue, WEEKEND, {}, [
    templateWithLinks,
  ]);
  assertNotEquals(violationCorrupted, null);
  assertStringIncludes(violationCorrupted!.reason, "diverges from stored template");
});

Deno.test("verifyPitchAgainstTemplate: accepts a faithful render whose template already styles a link with the wrapper link colour", () => {
  // Regression guard. The backend leaves an <a> alone when the template already declares a color:
  // of its own, so removing that colour from the rendered side alone dropped it from the render
  // while the skeleton kept it — refusing an email that is in fact faithful. #4fc3f7 is this repo's
  // own accent colour (src/book-gig/html.ts), so a template styling a link for dark mode lands on
  // exactly this value.
  const templateWithWrapperColourLink: EmailTemplate = {
    ...FIXTURE_TEMPLATE,
    bodyHtml:
      `[Custom Body]\n<p>Hear us at <a href="https://joshandmariamusic.com" style="color:#4fc3f7;">our site</a>.</p>\n<p>Thanks for considering us.</p>`,
  };
  const venue = coldVenue();
  const pitch = renderPitch(venue, WEEKEND, {}, [templateWithWrapperColourLink]);
  const wrapped: PitchEmail = { ...pitch, htmlBody: wrapDarkEmail(pitch.htmlBody!) };

  const violation = verifyPitchAgainstTemplate(wrapped, venue, WEEKEND, {}, [
    templateWithWrapperColourLink,
  ]);
  assertEquals(violation, null);

  // A real divergence inside that same template is still refused — the fix narrows nothing.
  const diverged: PitchEmail = {
    ...pitch,
    htmlBody: wrapDarkEmail(
      pitch.htmlBody!.replace("Thanks for considering us.", "Invented text."),
    ),
  };
  const divergedViolation = verifyPitchAgainstTemplate(diverged, venue, WEEKEND, {}, [
    templateWithWrapperColourLink,
  ]);
  assertNotEquals(divergedViolation, null);
});
