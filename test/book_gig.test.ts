// test/book_gig.test.ts — Unit tests for /book-gig skill and CLI

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  matchesVenueFilter,
  METRO_SURROUNDING,
  parseBookGigArgs,
  parseLocation,
  parseTargetWeekend,
} from "../src/book-gig/parser.ts";
import {
  assessDensity,
  fetchCandidates,
  filterAndRankCandidates,
  formatCandidateBreakdown,
  formatExcludedAuditSummary,
  formatMonthDay,
  formatMonthDayYear,
  formatMonthYear,
  getCandidateBreakdown,
  identifyCandidateBadge,
  isPitchableCandidate,
  renderCandidateTable,
} from "../src/book-gig/candidates.ts";
import {
  BANNED_VOICE_WORDS,
  DEFAULT_TEMPLATES,
  htmlToPlainText,
  renderPitch,
  validateVoiceRules,
  verifyPitchAgainstTemplate,
} from "../src/book-gig/pitch.ts";
import { formatDraftPayload, mergeWeekendRuns } from "../src/book-gig/gmail.ts";
import {
  BATCH_CHUNK_SIZE,
  BatchDispatchError,
  checkGmailReplies,
  dispatchBatchOutreach,
  fetchOutreachCampaigns,
  fetchPendingReplies,
  fetchTemplates,
  fetchVenueMap,
} from "../src/book-gig/outreach_api.ts";
import {
  DRAFT_PREVIEW_DARK_STYLE,
  extractRunDataFromHtml,
  formatPay,
  renderDarkHtml,
  renderStatusBadge,
  SORTING_SCRIPT,
} from "../src/book-gig/html.ts";
import { openHtmlInBrowser } from "../src/book-gig/browser.ts";
import {
  deduplicateCampaignsByVenue,
  formatLocationDisplay,
  matchesWeekend,
  runBookGigCli,
} from "../src/book-gig/cli.ts";
import {
  buildUnambiguousNameIndex,
  decodeHtmlEntities,
  executeLinkGig,
  normalizeVenueName,
  resolveGigVenueId,
} from "../src/book-gig/venue_link.ts";
import { executeTouchConversion } from "../src/book-gig/convert_touches.ts";
import type {
  BookGigResult,
  CandidateVenue,
  EmailTemplate,
  OutreachCampaignRecord,
  TargetWeekend,
} from "../src/book-gig/types.ts";

Deno.test("parseTargetWeekend: parses natural date ranges", () => {
  const w1 = parseTargetWeekend("Oct 16-18 2026");
  assertEquals(w1.start, "2026-10-16");
  assertEquals(w1.end, "2026-10-18");
  assertEquals(w1.year, 2026);
  assertEquals(w1.month, 10);
  assertEquals(w1.days, [16, 17, 18]);
  assertEquals(w1.label, "October 16–18, 2026");

  const w2 = parseTargetWeekend("weekend of October 16-18, 2026");
  assertEquals(w2.start, "2026-10-16");
  assertEquals(w2.end, "2026-10-18");
});

Deno.test("parseTargetWeekend: parses ISO dates and ranges", () => {
  const w1 = parseTargetWeekend("2026-10-16");
  assertEquals(w1.start, "2026-10-16");
  assertEquals(w1.end, "2026-10-18");

  const w2 = parseTargetWeekend("2026-10-16 to 2026-10-18");
  assertEquals(w2.start, "2026-10-16");
  assertEquals(w2.end, "2026-10-18");
});

Deno.test("parseTargetWeekend: throws on invalid input", () => {
  assertThrows(() => {
    parseTargetWeekend("");
  });
  assertThrows(() => {
    parseTargetWeekend("someday next summer");
  });
});

Deno.test("parseLocation: parses zipcodes, City/State, and metro slugs", () => {
  const loc1 = parseLocation("24502");
  assertEquals(loc1?.zip, "24502");
  assertEquals(loc1?.city, "Lynchburg");
  assertEquals(loc1?.metroSlug, "lynchburg");

  const loc2 = parseLocation("Lynchburg, VA");
  assertEquals(loc2?.city, "Lynchburg");
  assertEquals(loc2?.state, "VA");
  assertEquals(loc2?.metroSlug, "lynchburg");

  const loc3 = parseLocation("roanoke");
  assertEquals(loc3?.city, "Roanoke");
  assertEquals(loc3?.metroSlug, "roanoke");

  const loc4 = parseLocation(undefined);
  assertEquals(loc4, null);
});

Deno.test("parseLocation: parses multi-city comma lists, and conjunctions, and surrounding areas", () => {
  // Comma-separated list of cities
  const loc1 = parseLocation("Lynchburg, Blacksburg, Martinsville, Salem, Roanoke");
  assertEquals(loc1?.cities, ["Lynchburg", "Blacksburg", "Martinsville", "Salem", "Roanoke"]);
  assertEquals(loc1?.city, "Lynchburg");
  assertEquals(loc1?.state, "VA");
  assertEquals(loc1?.includeSurrounding, undefined);

  // Multi-city with 'and' conjunction
  const loc2 = parseLocation("Lynchburg and Roanoke");
  assertEquals(loc2?.cities, ["Lynchburg", "Roanoke"]);
  assertEquals(loc2?.includeSurrounding, undefined);

  // Multi-city with "and surrounding areas"
  const loc3 = parseLocation(
    "Lynchburg, Blacksburg, Martinsville, Salem, Roanoke, and surrounding areas",
  );
  assertEquals(loc3?.cities, ["Lynchburg", "Blacksburg", "Martinsville", "Salem", "Roanoke"]);
  assertEquals(loc3?.includeSurrounding, true);
  assert(loc3?.surroundingCities !== undefined);
  // Check surrounding cities populated from regional metros strictly within perimeter
  assert(loc3.surroundingCities.includes("Floyd"));
  assert(loc3.surroundingCities.includes("Radford"));
  assert(loc3.surroundingCities.includes("Christiansburg"));
  assert(loc3.surroundingCities.includes("Forest"));
  assert(loc3.surroundingCities.includes("Bedford"));
  assert(loc3.surroundingCities.includes("Vinton"));
  assert(loc3.surroundingCities.includes("Bassett"));
  assert(loc3.surroundingCities.includes("Pembroke"));
  assert(loc3.surroundingCities.includes("Pulaski"));
  assert(loc3.surroundingCities.includes("Giles"));
  assert(loc3.surroundingCities.includes("Wirtz"));
  assert(loc3.surroundingCities.includes("Huddleston"));
  assert(loc3.surroundingCities.includes("Axton"));
  assert(loc3.surroundingCities.includes("Ridgeway"));
  assert(loc3.surroundingCities.includes("Fieldale"));
  // Excluded towns beyond perimeter (Marion) and target cities
  assertEquals(loc3.surroundingCities.includes("Marion"), false);
  assertEquals(loc3.surroundingCities.includes("Salem"), false);
  assertEquals(loc3.surroundingCities.includes("Roanoke"), false);

  // Single city with surrounding areas
  const loc4 = parseLocation("Lynchburg and surrounding areas");
  assertEquals(loc4?.cities, ["Lynchburg"]);
  assertEquals(loc4?.includeSurrounding, true);
  assert(loc4?.surroundingCities?.includes("Forest"));
  assert(loc4?.surroundingCities?.includes("Bedford"));
});

Deno.test("parseLocation: rejects numeric year and arbitrary non-zip numbers", () => {
  assertEquals(parseLocation("2026"), null);
  assertEquals(parseLocation("2027"), null);
  assertEquals(parseLocation("123"), null);
  assertEquals(parseLocation("999999"), null);
  assertEquals(parseLocation("2026-10-16"), null);
});

Deno.test("parseBookGigArgs: splits CLI arguments and extracts --send / --replies flags", () => {
  const res1 = parseBookGigArgs(["Oct", "16-18", "2026", "Lynchburg,", "VA"]);
  assertEquals(res1.mode, "preview");
  assertEquals(res1.weekend?.start, "2026-10-16");
  assertEquals(res1.weekend?.year, 2026);
  assertEquals(res1.location?.city, "Lynchburg");

  const res2 = parseBookGigArgs(["2026-10-16", "24502"]);
  assertEquals(res2.mode, "preview");
  assertEquals(res2.weekend?.start, "2026-10-16");
  assertEquals(res2.weekend?.year, 2026);
  assertEquals(res2.location?.zip, "24502");

  const res3 = parseBookGigArgs(["--send", "Oct 16-18 2026", "Lynchburg, VA"]);
  assertEquals(res3.mode, "send");
  assertEquals(res3.weekend?.start, "2026-10-16");
  assertEquals(res3.weekend?.year, 2026);
  assertEquals(res3.location?.city, "Lynchburg");

  const res4 = parseBookGigArgs(["--replies", "Oct 16-18 2026"]);
  assertEquals(res4.mode, "replies");
  assertEquals(res4.weekend?.start, "2026-10-16");
  assertEquals(res4.weekend?.year, 2026);
  assertEquals(res4.location, undefined);

  const res5 = parseBookGigArgs(["--check-replies"]);
  assertEquals(res5.mode, "replies");
  assertEquals(res5.weekend, undefined);

  const res6 = parseBookGigArgs([]);
  assertEquals(res6.mode, "preview");
  assertEquals(res6.weekend, undefined);
  assertEquals(res6.location, undefined);

  // Acceptance Criterion 1: parseBookGigArgs(["Oct", "16-18", "2026"]) and parseBookGigArgs(["Oct 16-18 2026"])
  const res7 = parseBookGigArgs(["Oct", "16-18", "2026"]);
  assertEquals(res7.mode, "preview");
  assertEquals(res7.weekend?.year, 2026);
  assertEquals(res7.weekend?.start, "2026-10-16");
  assertEquals(res7.weekend?.end, "2026-10-18");
  assertEquals(res7.location, undefined);

  const res8 = parseBookGigArgs(["Oct 16-18 2026"]);
  assertEquals(res8.mode, "preview");
  assertEquals(res8.weekend?.year, 2026);
  assertEquals(res8.weekend?.start, "2026-10-16");
  assertEquals(res8.weekend?.end, "2026-10-18");
  assertEquals(res8.location, undefined);
});

Deno.test("filterAndRankCandidates: prioritizes matching location and retains regional candidates", () => {
  const sampleVenues: CandidateVenue[] = [
    {
      _id: "1",
      name: "Apocalypse Ale Works",
      city: "Forest",
      usState: "VA",
      address: "1257 Burnbridge Rd, Forest, VA 24551",
      email: "info@apocalypse.com",
    },
    {
      _id: "2",
      name: "Parkway Brewing",
      city: "Salem",
      usState: "VA",
      address: "739 Kessler Mill Rd, Salem, VA 24153",
      email: "info@parkway.com",
    },
    {
      _id: "3",
      name: "Waterman's Grill",
      city: "Lynchburg",
      usState: "VA",
      address: "Main St, Lynchburg, VA 24502",
      email: "booking@watermans.com",
    },
  ];

  // Target Lynchburg
  const loc = parseLocation("Lynchburg, VA")!;
  const filtered = filterAndRankCandidates(sampleVenues, loc);

  const pitchable = filtered.filter(isPitchableCandidate);
  assertEquals(pitchable.length, 2);
  assertEquals(pitchable[0].name, "Waterman's Grill"); // Direct city match
  assertEquals(pitchable[1].name, "Apocalypse Ale Works"); // Surrounding Forest match
  assertEquals(pitchable.some((v) => v.name === "Parkway Brewing"), false); // Unrelated metro excluded from pitchable

  assertEquals(filtered.length, 3);
  const parkway = filtered.find((v) => v.name === "Parkway Brewing")!;
  assertEquals(parkway.isExcluded, true);
  assertEquals(parkway.exclusionReason, "outside-target-area");
  assertEquals(parkway.statusBadge, "[Outside Target Area]");
});

Deno.test("filterAndRankCandidates: dynamic multi-city filtering for NC/SC metros", () => {
  const ncVenues: CandidateVenue[] = [
    {
      _id: "nc1",
      name: "Sugar Creek Brewing",
      city: "Charlotte",
      usState: "NC",
      address: "215 Southside Dr, Charlotte, NC 28217",
      email: "party@sugarcreekbrewing.com",
    },
    {
      _id: "nc2",
      name: "Gaston Pour House",
      city: "Gastonia",
      usState: "NC",
      address: "170 S South St, Gastonia, NC 28052",
      email: "gph@gastonpourhouse.com",
    },
    {
      _id: "nc3",
      name: "South Point Social",
      city: "Belmont",
      usState: "NC",
      address: "200 N Main St, Belmont, NC 28012",
      email: "southpointsocial@gmail.com",
    },
    {
      _id: "nc4",
      name: "Olde Salem Brewing",
      city: "Salem",
      usState: "VA",
      address: "21 E Main St, Salem, VA 24153",
      email: "booking@oldesalem.com",
    },
  ];

  const loc = parseLocation("Charlotte, Gastonia, Belmont, NC")!;
  const filtered = filterAndRankCandidates(ncVenues, loc);

  const pitchable = filtered.filter(isPitchableCandidate);
  assertEquals(pitchable.length, 3);
  assertEquals(pitchable.some((v) => v.city === "Charlotte"), true);
  assertEquals(pitchable.some((v) => v.city === "Gastonia"), true);
  assertEquals(pitchable.some((v) => v.city === "Belmont"), true);
  assertEquals(pitchable.some((v) => v.city === "Salem"), false);

  assertEquals(filtered.length, 4);
  const salem = filtered.find((v) => v.city === "Salem")!;
  assertEquals(salem.isExcluded, true);
  assertEquals(salem.exclusionReason, "out-of-state");
  assertEquals(salem.statusBadge, "[Out of State]");
});

Deno.test("filterAndRankCandidates: multi-city and surrounding area ranking and exclusion of non-target metros", () => {
  const venues: CandidateVenue[] = [
    {
      _id: "v1",
      name: "The Milestone Club",
      city: "Charlotte",
      usState: "NC",
      address: "3400 Tuckaseegee Rd, Charlotte, NC 28208",
      email: "booking@themilestoneclub.com",
    },
    {
      _id: "v2",
      name: "Clementine Cafe",
      city: "Harrisonburg",
      usState: "VA",
      address: "153 S Main St, Harrisonburg, VA 22801",
      email: "booking@clementinecafe.com",
    },
    {
      _id: "v3",
      name: "Olde Salem Brewing",
      city: "Salem",
      usState: "VA",
      address: "21 E Main St, Salem, VA 24153",
      email: "booking@oldesalem.com",
    },
    {
      _id: "v4",
      name: "Rising Silo Brewery",
      city: "Blacksburg",
      usState: "VA",
      address: "2351 Glade Rd, Blacksburg, VA 24060",
      email: "booking@risingsilo.com",
    },
    {
      _id: "v5",
      name: "The Wooden Pickle",
      city: "Marion",
      usState: "VA",
      address: "102 E Main St, Marion, VA 24354",
      email: "info@thewoodenpickle.com",
    },
    {
      _id: "v6",
      name: "Apocalypse Ale Works",
      city: "Forest",
      usState: "VA",
      address: "1257 Burnbridge Rd, Forest, VA 24551",
      email: "info@apocalypse.com",
    },
    {
      _id: "v7",
      name: "Foothills Brewing",
      city: "Salem",
      usState: "NC",
      address: "638 W 4th St, Salem, NC 27101",
      email: "booking@foothillsbrewing.com",
    },
    {
      _id: "v8",
      name: "Charleston Music Hall",
      city: "Charleston",
      usState: "SC",
      address: "37 John St, Charleston, SC 29403",
      email: "booking@charlestonmusichall.com",
    },
    {
      _id: "v9",
      name: "Dogtown Roadhouse",
      city: "Floyd",
      usState: "VA",
      address: "302 S Locust St, Floyd, VA 24091",
      email: "booking@dogtownroadhouse.com",
    },
  ];

  const loc = parseLocation(
    "Lynchburg, Blacksburg, Martinsville, Salem, Roanoke, and surrounding areas",
  )!;
  const filtered = filterAndRankCandidates(venues, loc);
  const pitchable = filtered.filter(isPitchableCandidate);

  // Exact matches first (Blacksburg, Salem VA), then surrounding (Forest VA, Floyd VA)
  assertEquals(pitchable.length, 4);
  assertEquals(pitchable[0].name, "Olde Salem Brewing"); // Exact Salem VA match
  assertEquals(pitchable[1].name, "Rising Silo Brewery"); // Exact Blacksburg VA match
  assertEquals(pitchable[2].name, "Apocalypse Ale Works"); // Surrounding Forest VA match
  assertEquals(pitchable[3].name, "Dogtown Roadhouse"); // Surrounding Floyd VA match

  // Non-target metros, far-out towns (Marion, Harrisonburg), and out-of-state venues (Charlotte NC, Salem NC, Charleston SC) must be excluded from pitchable
  assertEquals(pitchable.some((v) => v.city === "Charlotte"), false);
  assertEquals(pitchable.some((v) => v.city === "Harrisonburg"), false);
  assertEquals(pitchable.some((v) => v.city === "Marion"), false);
  assertEquals(pitchable.some((v) => v.usState === "NC"), false);
  assertEquals(pitchable.some((v) => v.usState === "SC"), false);
  assertEquals(pitchable.some((v) => v._id === "v5"), false); // Marion VA excluded
  assertEquals(pitchable.some((v) => v._id === "v7"), false); // Salem NC excluded
  assertEquals(pitchable.some((v) => v._id === "v8"), false); // Charleston SC excluded

  // All 9 venues are retained in filtered with named exclusion reasons
  assertEquals(filtered.length, 9);
  assertEquals(filtered.find((v) => v._id === "v1")?.exclusionReason, "out-of-state");
  assertEquals(filtered.find((v) => v._id === "v2")?.exclusionReason, "outside-target-area");
  assertEquals(filtered.find((v) => v._id === "v5")?.exclusionReason, "outside-target-area");
  assertEquals(filtered.find((v) => v._id === "v7")?.exclusionReason, "out-of-state");
  assertEquals(filtered.find((v) => v._id === "v8")?.exclusionReason, "out-of-state");
});

Deno.test("formatLocationDisplay: formats multi-city and surrounding area descriptions", () => {
  const loc1 = parseLocation("Lynchburg, Blacksburg, Martinsville, Salem, Roanoke");
  assertEquals(
    formatLocationDisplay(loc1 ?? undefined),
    "Lynchburg, Blacksburg, Martinsville, Salem, Roanoke",
  );

  const loc2 = parseLocation(
    "Lynchburg, Blacksburg, Martinsville, Salem, Roanoke, and surrounding areas",
  );
  assertEquals(
    formatLocationDisplay(loc2 ?? undefined),
    "Lynchburg, Blacksburg, Martinsville, Salem, Roanoke (and surrounding regional areas)",
  );

  const loc3 = parseLocation("Salem, VA");
  assertEquals(formatLocationDisplay(loc3 ?? undefined), "Salem, VA");

  const loc4 = parseLocation("Salem and surrounding areas");
  assertEquals(
    formatLocationDisplay(loc4 ?? undefined),
    "Salem, VA (and surrounding regional areas)",
  );

  assertEquals(formatLocationDisplay(undefined), "All Regional Metros (~3.5h drive)");
});

Deno.test("assessDensity: flags sparse density and suggests metro for venue-mining", () => {
  const venues: CandidateVenue[] = [
    { _id: "1", name: "Waterman's Grill", city: "Lynchburg", usState: "VA" },
  ];
  const loc = parseLocation("Lynchburg, VA")!;

  const density = assessDensity(venues, loc, 3);
  assertEquals(density.count, 1);
  assertEquals(density.isSparse, true);
  assertEquals(density.suggestedMetro, "lynchburg");
});

Deno.test("validateVoiceRules: rejects banned words and corporate phrasing", () => {
  for (const banned of BANNED_VOICE_WORDS) {
    const text = `Hi, we have an ${banned} event coming up.`;
    const res = validateVoiceRules(text);
    assertEquals(res.valid, false, `Expected banned word "${banned}" to fail validation`);
  }

  const corporateText = "Dear Booking Manager, We are writing to ask about booking at your spot.";
  const resCorp = validateVoiceRules(corporateText);
  assertEquals(resCorp.valid, false);
  assert(resCorp.violations.length >= 2);
});

Deno.test("renderPitch: generates warm, compliant pitch emails", () => {
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
    _id: "v1",
    name: "Starr Hill Brewery",
    city: "Roanoke",
    usState: "VA",
    email: "roanoke@starrhill.com",
    secondaryEmail: "booking@starrhill.com",
    venueType: "PubFestivalBrewery",
  };

  const pitch = renderPitch(venue, weekend);
  assertEquals(pitch.to, "roanoke@starrhill.com");
  assertEquals(pitch.secondaryTo, "booking@starrhill.com");
  assertStringIncludes(pitch.subject, "October 2026");
  assertStringIncludes(pitch.subject, "Starr Hill Brewery");
  assertStringIncludes(pitch.body, "Josh and Maria");
  assertStringIncludes(pitch.body, "joshandmariamusic.com");

  // Validate voice rules pass
  const validation = validateVoiceRules(pitch.body);
  assertEquals(validation.valid, true);
});

Deno.test("renderPitch: generates returning venue pitch with custom contact and hook", () => {
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
    _id: "v2",
    name: "Olde Salem Brewing",
    city: "Salem",
    usState: "VA",
    email: "booking@oldesalem.com",
    reason: { lastGigDate: "2026-06-15", spacingNote: "Played 4 months ago" },
  };

  const pitch = renderPitch(venue, weekend, {
    contactName: "Kevin",
    personalHook: "We loved playing your anniversary party last year!",
    isReturningVenue: true,
  });

  assertStringIncludes(pitch.body, "Hi Kevin,");
  assertStringIncludes(pitch.body, "We loved playing your anniversary party last year!");
  assertStringIncludes(pitch.body, "Josh and Maria");
  assertEquals(validateVoiceRules(pitch.body).valid, true);
});

Deno.test("formatDraftPayload: formats a pitch as a Gmail draft payload", () => {
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
    _id: "v1",
    name: "Parkway Brewing",
    city: "Salem",
    usState: "VA",
    email: "info@parkway.com",
  };

  const pitch = renderPitch(venue, weekend);
  const payload = formatDraftPayload(pitch);

  assertEquals(payload.to, "info@parkway.com");
  assertEquals(payload.subject, pitch.subject);
  assertEquals(payload.body, pitch.body);
});

Deno.test("renderDarkHtml: writes a draft's backend-rendered HTML in full into a sandboxed iframe, byte-identical to what dispatch sends (#948)", () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  const htmlBody = `<p>Hi Kevin,</p><p>We'd love to play &amp; bring live music at "Parkway".</p>`;

  const result: BookGigResult = {
    mode: "preview",
    weekend,
    candidates: [],
    density: { count: 0, isSparse: false },
    pitches: [
      {
        venueId: "v1",
        venueName: "Parkway Brewing",
        to: "info@parkway.com",
        subject: "Sub",
        body: 'Hi Kevin, We\'d love to play & bring live music at "Parkway".',
        htmlBody,
      },
    ],
  };

  const html = renderDarkHtml(result);

  // The complete backend HTML is written into the artifact, not summarized,
  // truncated, or re-rendered — escaped only as required for the srcdoc
  // attribute, so decoding it reproduces the exact backend markup.
  const expectedEscaped = htmlBody
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
  assertStringIncludes(html, `srcdoc="${DRAFT_PREVIEW_DARK_STYLE}${expectedEscaped}"`);
  assertStringIncludes(html, "pitch-body-frame");
  // The draft renders with scripting disabled — never a script-enabled sandbox.
  assertStringIncludes(html, 'sandbox="allow-same-origin"');
  assertEquals(html.includes("allow-scripts"), false);
  assertStringIncludes(html, "Copy Email");
  assertStringIncludes(
    html,
    '<pre class="pitch-body-raw" id="pitch-body-1-plain" style="display: none;">',
  );
  assertStringIncludes(
    html,
    "navigator.clipboard.writeText(document.getElementById('pitch-body-1-plain').innerText)",
  );
});

Deno.test("renderDarkHtml: email preview frames render with dark surface token, dark color-scheme, and injected dark style block (D-71, #999)", () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  const htmlBody1 = "<p>Hi Alex, We'd love to play at <strong>Parkway</strong>.</p>";
  const htmlBody2 =
    '<p>Hi Sam, Checking in about <a href="https://example.com">available dates</a>.</p>';

  const result: BookGigResult = {
    mode: "preview",
    weekend,
    candidates: [
      { _id: "v1", name: "Parkway Brewing", email: "info@parkway.com" },
      { _id: "v2", name: "Second Venue", email: "info@second.com" },
    ],
    density: { count: 2, isSparse: false },
    pitches: [
      {
        venueId: "v1",
        venueName: "Parkway Brewing",
        to: "info@parkway.com",
        subject: "Sub 1",
        body: "Body 1",
        htmlBody: htmlBody1,
      },
      {
        venueId: "v2",
        venueName: "Second Venue",
        to: "info@second.com",
        subject: "Sub 2",
        body: "Body 2",
        htmlBody: htmlBody2,
      },
    ],
  };

  const html = renderDarkHtml(result);

  // (a) Does not contain color-scheme: light or background-color: #ffffff on iframe.pitch-body-frame
  const iframeCssMatch = html.match(/iframe\.pitch-body-frame\s*\{([^}]+)\}/);
  assert(iframeCssMatch, "iframe.pitch-body-frame CSS rule must exist in renderDarkHtml output");
  const iframeCss = iframeCssMatch[1];
  assertEquals(iframeCss.includes("color-scheme: light"), false);
  assertEquals(iframeCss.includes("background-color: #ffffff"), false);

  // (b) Contains color-scheme: dark and background-color: var(--bg-surface) on that rule
  assertStringIncludes(iframeCss, "color-scheme: dark");
  assertStringIncludes(iframeCss, "background-color: var(--bg-surface)");

  // (c) Every srcdoc begins with the injected dark <style> block followed by the unchanged escaped htmlBody
  const srcdocMatches = Array.from(html.matchAll(/srcdoc="([^"]*)"/g));
  assertEquals(srcdocMatches.length, 2);

  const escapeExpected = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

  for (const [idx, m] of srcdocMatches.entries()) {
    const srcdocVal = m[1];
    assert(
      srcdocVal.startsWith(DRAFT_PREVIEW_DARK_STYLE),
      `srcdoc #${idx + 1} must start with DRAFT_PREVIEW_DARK_STYLE`,
    );
    const expectedEscaped = escapeExpected(idx === 0 ? htmlBody1 : htmlBody2);
    assertEquals(
      srcdocVal,
      `${DRAFT_PREVIEW_DARK_STYLE}${expectedEscaped}`,
    );
  }

  // Ensure sandbox remains unchanged with allow-same-origin only
  const sandboxMatches = Array.from(html.matchAll(/sandbox="([^"]*)"/g));
  assertEquals(sandboxMatches.length, 2);
  for (const sm of sandboxMatches) {
    assertEquals(sm[1], "allow-same-origin");
  }
  assertEquals(html.includes("allow-scripts"), false);
});

Deno.test("renderDarkHtml: falls back to a plain-text pitch-body block when no backend HTML rendering is available", () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  const result: BookGigResult = {
    mode: "preview",
    weekend,
    candidates: [],
    density: { count: 0, isSparse: false },
    pitches: [
      {
        venueId: "v1",
        venueName: "No HTML Venue",
        to: "info@example.com",
        subject: "Sub",
        body: "Plain text only body.",
      },
    ],
  };

  const html = renderDarkHtml(result);
  assertStringIncludes(html, '<pre class="pitch-body"');
  assertStringIncludes(html, "Plain text only body.");
  // The CSS rule for the iframe variant is always present in the stylesheet,
  // but no <iframe> element itself is emitted when there is no HTML draft.
  assertEquals(html.includes("<iframe"), false);
});
Deno.test("renderDarkHtml: includes Contact Person and Phone in the rendered report (#874)", () => {
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
    _id: "v1",
    name: "Parkway Brewing",
    city: "Salem",
    usState: "VA",
    email: "lezlie@parkwaybrewing.com",
    contactName: "Lezlie Snyder",
    phone: "540-555-1234",
  };

  const pitch = renderPitch(venue, weekend);
  assertEquals(pitch.contactName, "Lezlie Snyder");
  assertEquals(pitch.phone, "540-555-1234");

  const result = {
    mode: "preview" as const,
    weekend,
    candidates: [venue],
    density: { count: 1, isSparse: false },
    pitches: [pitch],
  };

  const html = renderDarkHtml(result);
  assertStringIncludes(html, "<!DOCTYPE html>");
  assertStringIncludes(html, "Parkway Brewing");
  assertStringIncludes(html, "--bg-primary: #121212");
  assertStringIncludes(html, 'name="viewport"');
  assertStringIncludes(html, "Copy Email");
  assertStringIncludes(html, "<th>Contact Person</th>");
  assertStringIncludes(html, "<th>Phone</th>");
  assertStringIncludes(html, "<td>Lezlie Snyder</td>");
  assertStringIncludes(html, '<a href="tel:540-555-1234" class="email-link">540-555-1234</a>');
  assertStringIncludes(html, "Contact: <strong>Lezlie Snyder</strong>");
  assertStringIncludes(
    html,
    'Tel: <a href="tel:540-555-1234" class="meta-email">540-555-1234</a>',
  );
});

Deno.test("mergeWeekendRuns: accumulates multiple batches for the same weekend into a single consolidated result (#876, #955)", () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  const venue1: CandidateVenue = {
    _id: "v1",
    name: "Parkway Brewing",
    city: "Salem",
    usState: "VA",
    email: "info@parkway.com",
    contactName: "Lezlie",
    phone: "540-111-1111",
  };
  const venue2: CandidateVenue = {
    _id: "v2",
    name: "Olde Salem Brewery",
    city: "Salem",
    usState: "VA",
    email: "booking@oldesalem.com",
    contactName: "Mark",
    phone: "540-222-2222",
  };

  const pitch1 = renderPitch(venue1, weekend);
  const pitch2 = renderPitch(venue2, weekend);

  // Batch 1: 2 candidates, both sent
  const batch1: BookGigResult = {
    mode: "send",
    weekend,
    candidates: [venue1, venue2],
    density: { count: 2, isSparse: true, suggestedMetro: "roanoke" },
    pitches: [pitch1, pitch2],
    batchDispatch: {
      requested: 2,
      sent: 2,
      skipped: [],
      records: [{ venueId: "v1" }, { venueId: "v2" }],
    },
  };

  // Batch 2: 2 different candidates for the same weekend, 1 sent, 1 skipped
  const venue3: CandidateVenue = {
    _id: "v3",
    name: "The Glass House",
    city: "Lynchburg",
    usState: "VA",
    email: "booking@glasshouse.com",
  };
  const venue4: CandidateVenue = {
    _id: "v4",
    name: "Riverviews Artspace",
    city: "Lynchburg",
    usState: "VA",
    email: "info@riverviews.net",
  };

  const pitch3 = renderPitch(venue3, weekend);
  const pitch4 = renderPitch(venue4, weekend);

  const batch2: BookGigResult = {
    mode: "send",
    weekend,
    candidates: [venue3, venue4],
    density: { count: 2, isSparse: true, suggestedMetro: "lynchburg" },
    pitches: [pitch3, pitch4],
    batchDispatch: {
      requested: 2,
      sent: 1,
      skipped: [{
        venueId: "v4",
        venueName: "Riverviews Artspace",
        reason: "Invalid booking email",
      }],
      records: [{ venueId: "v3" }],
    },
  };

  const merged = mergeWeekendRuns(
    { candidates: batch1.candidates, pitches: batch1.pitches, batchDispatch: batch1.batchDispatch },
    batch2,
  );

  assertEquals(merged.candidates.length, 4);
  assertEquals(merged.pitches.length, 4);
  assertEquals(merged.batchDispatch?.requested, 4);
  assertEquals(merged.batchDispatch?.sent, 3);
  assertEquals(merged.batchDispatch?.skipped.length, 1);

  const consolidatedHtml = renderDarkHtml(merged);
  assertStringIncludes(consolidatedHtml, '<tr data-venue-id="v1">');
  assertStringIncludes(consolidatedHtml, '<tr data-venue-id="v2">');
  assertStringIncludes(consolidatedHtml, '<tr data-venue-id="v3">');
  assertStringIncludes(consolidatedHtml, '<tr data-venue-id="v4">');
  assertStringIncludes(consolidatedHtml, "3 dispatched");
  assertStringIncludes(consolidatedHtml, "1 venues");
  assertStringIncludes(consolidatedHtml, "3 of 4 venue pitch emails sent");
  assertStringIncludes(consolidatedHtml, "Invalid booking email");
});

Deno.test("mergeWeekendRuns: deduplicates candidate rows and pitch cards by venueId across batches (#876)", () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  const venueA_old: CandidateVenue = {
    _id: "vA",
    name: "Venue A",
    city: "Salem",
    usState: "VA",
    email: "old@venuea.com",
    contactName: "Old Contact",
    phone: "111-111-1111",
  };
  const venueB: CandidateVenue = {
    _id: "vB",
    name: "Venue B",
    city: "Salem",
    usState: "VA",
    email: "booking@venueb.com",
  };

  const venueA_new: CandidateVenue = {
    _id: "vA",
    name: "Venue A",
    city: "Salem",
    usState: "VA",
    email: "new@venuea.com",
    contactName: "Alice Updated",
    phone: "999-999-9999",
  };
  const venueC: CandidateVenue = {
    _id: "vC",
    name: "Venue C",
    city: "Roanoke",
    usState: "VA",
    email: "contact@venuec.com",
  };

  const pitchA_old = renderPitch(venueA_old, weekend);
  const pitchB = renderPitch(venueB, weekend);
  const pitchA_new = renderPitch(venueA_new, weekend);
  const pitchC = renderPitch(venueC, weekend);

  const batch1: BookGigResult = {
    mode: "send",
    weekend,
    candidates: [venueA_old, venueB],
    density: { count: 2, isSparse: true },
    pitches: [pitchA_old, pitchB],
    batchDispatch: { requested: 2, sent: 2, skipped: [], records: [] },
  };
  const batch2: BookGigResult = {
    mode: "send",
    weekend,
    candidates: [venueA_new, venueC],
    density: { count: 2, isSparse: true },
    pitches: [pitchA_new, pitchC],
    batchDispatch: { requested: 2, sent: 2, skipped: [], records: [] },
  };

  const merged = mergeWeekendRuns(
    { candidates: batch1.candidates, pitches: batch1.pitches, batchDispatch: batch1.batchDispatch },
    batch2,
  );

  // Should have 3 candidates total (Venue A, Venue B, Venue C) - not 4
  assertEquals(merged.candidates.length, 3);
  assertEquals(merged.pitches.length, 3);
  assertEquals(merged.batchDispatch?.requested, 4);
  assertEquals(merged.batchDispatch?.sent, 4);

  // Venue A details should be updated to new contact and email
  const mergedVenueA = merged.candidates.find((c) => c._id === "vA");
  assertEquals(mergedVenueA?.email, "new@venuea.com");
  assertEquals(mergedVenueA?.contactName, "Alice Updated");
  assertEquals(mergedVenueA?.phone, "999-999-9999");

  const html = renderDarkHtml(merged);
  // Verify only one data-venue-id="vA" in candidate rows
  const matchesA = html.match(/<tr data-venue-id="vA">/g);
  assertEquals(matchesA?.length, 1);

  // Verify only one pitch card for vA
  const pitchCardsA = html.match(/data-venue-id="vA"/g);
  // 1 in candidate table row + 1 in pitch card = 2 total occurrences
  assertEquals(pitchCardsA?.length, 2);
});

Deno.test("mergeWeekendRuns: purges pitch cards for venues that became excluded or placed on seasonal hold", () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  const venueEligible: CandidateVenue = {
    _id: "v1",
    name: "Open Brewery",
    email: "open@brewery.com",
    isExcluded: false,
  };
  const venueOnHold: CandidateVenue = {
    _id: "v2",
    name: "Held Brewery",
    email: "held@brewery.com",
    isExcluded: false,
  };

  const pitch1 = renderPitch(venueEligible, weekend);
  const pitch2 = renderPitch(venueOnHold, weekend);

  const existing = {
    candidates: [venueEligible, venueOnHold],
    pitches: [pitch1, pitch2],
  };

  // Second run: venueOnHold was placed on seasonal hold (isExcluded: true)
  const current: BookGigResult = {
    mode: "preview",
    weekend,
    candidates: [
      venueEligible,
      {
        ...venueOnHold,
        isExcluded: true,
        statusBadge: "[Seasonal Hold: Mar 2027]",
        exclusionReason: "seasonal-hold",
      },
    ],
    density: { count: 1, isSparse: true },
    pitches: [pitch1],
  };

  const merged = mergeWeekendRuns(existing, current);
  assertEquals(merged.candidates.length, 2);
  assertEquals(merged.pitches.length, 1);
  assertEquals(merged.pitches[0].venueId, "v1");
});

Deno.test("mergeWeekendRuns: deduplicates skipped venues by venueId across batches (#876)", () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  const venue1: CandidateVenue = { _id: "v1", name: "Venue 1" };
  const venue2: CandidateVenue = { _id: "v2", name: "Venue 2" };
  const pitch1 = renderPitch(venue1, weekend);
  const pitch2 = renderPitch(venue2, weekend);

  const batch1: BookGigResult = {
    mode: "send",
    weekend,
    candidates: [venue1],
    density: { count: 1, isSparse: true },
    pitches: [pitch1],
    batchDispatch: {
      requested: 1,
      sent: 0,
      skipped: [{ venueId: "v1", venueName: "Venue 1", reason: "Initial error" }],
      records: [],
    },
  };

  const batch2: BookGigResult = {
    mode: "send",
    weekend,
    candidates: [venue2],
    density: { count: 1, isSparse: true },
    pitches: [pitch2],
    batchDispatch: {
      requested: 2,
      sent: 1,
      skipped: [
        { venueId: "v1", venueName: "Venue 1", reason: "Updated skip reason" },
        { venueId: "v2", venueName: "Venue 2", reason: "Bounced" },
      ],
      records: [],
    },
  };

  const merged = mergeWeekendRuns(
    { candidates: batch1.candidates, pitches: batch1.pitches, batchDispatch: batch1.batchDispatch },
    batch2,
  );

  // Cumulative: requested = 1 + 2 = 3, sent = 0 + 1 = 1, skipped = 2 deduplicated
  assertEquals(merged.batchDispatch?.requested, 3);
  assertEquals(merged.batchDispatch?.sent, 1);
  assertEquals(merged.batchDispatch?.skipped.length, 2);

  const html = renderDarkHtml(merged);
  assertStringIncludes(html, "Skipped Venues (2)");
  assertStringIncludes(html, "Updated skip reason");
  assertStringIncludes(html, "Bounced");
});

Deno.test("extractRunDataFromHtml: extracts and parses run data embedded in a published report", () => {
  const sampleHtml = `
<html>
<body>
  <script id="book-gig-run-data" type="application/json">
  {"candidates": [{"_id": "v2", "name": "Venue 2"}], "pitches": [], "batchDispatch": {"requested": 2, "sent": 2, "skipped": [], "records": []}}
  </script>
</body>
</html>
`;
  const parsedHtml = extractRunDataFromHtml(sampleHtml);
  assert(parsedHtml);
  assert(parsedHtml.candidates);
  assertEquals(parsedHtml.candidates.length, 1);
  assertEquals(parsedHtml.candidates[0].name, "Venue 2");
  assertEquals(parsedHtml.batchDispatch?.requested, 2);
});

Deno.test("mergeWeekendRuns: merges candidates, pitches, tallies and density cleanly", () => {
  const existing = {
    candidates: [
      { _id: "v1", name: "Venue 1", city: "Roanoke", usState: "VA" },
      { _id: "v2", name: "Venue 2", city: "Salem", usState: "VA", payAmount: 150 },
    ],
    pitches: [
      { venueId: "v1", venueName: "Venue 1", to: "v1@a.com", subject: "S1", body: "B1" },
      { venueId: "v2", venueName: "Venue 2", to: "v2@a.com", subject: "S2", body: "B2" },
    ],
    batchDispatch: {
      requested: 2,
      sent: 2,
      skipped: [],
      records: [{ venueId: "v1" }, { venueId: "v2" }],
    },
    reportUrl: "https://www.web-jam.com/outreach/report/2026-10-16-to-2026-10-18",
  };

  const current: BookGigResult = {
    mode: "send",
    weekend: {
      start: "2026-10-16",
      end: "2026-10-18",
      rawText: "Oct 16-18 2026",
      label: "October 16–18, 2026",
      year: 2026,
      month: 10,
      days: [16, 17, 18],
    },
    candidates: [
      {
        _id: "v2",
        name: "Venue 2",
        city: "Salem",
        usState: "VA",
        payAmount: 200,
        contactName: "Bob",
      },
      { _id: "v3", name: "Venue 3", city: "Lynchburg", usState: "VA" },
    ],
    density: { count: 2, isSparse: true },
    pitches: [
      {
        venueId: "v2",
        venueName: "Venue 2",
        to: "v2@a.com",
        subject: "S2-Updated",
        body: "B2-Updated",
      },
      { venueId: "v3", venueName: "Venue 3", to: "v3@a.com", subject: "S3", body: "B3" },
    ],
    batchDispatch: {
      requested: 2,
      sent: 1,
      skipped: [{ venueId: "v3", venueName: "Venue 3", reason: "Skip" }],
      records: [{ venueId: "v2" }],
    },
  };

  const merged = mergeWeekendRuns(existing, current);
  assertEquals(merged.candidates.length, 3);
  assertEquals(merged.candidates[1].payAmount, 200);
  assertEquals(merged.candidates[1].contactName, "Bob");
  assertEquals(merged.pitches.length, 3);
  assertEquals(merged.pitches[1].subject, "S2-Updated");
  assertEquals(merged.batchDispatch?.requested, 4);
  assertEquals(merged.batchDispatch?.sent, 3);
  assertEquals(merged.batchDispatch?.skipped.length, 1);
  assertEquals(merged.density.count, 3);
  assertEquals(merged.density.isSparse, false);
  assertEquals(
    merged.reportUrl,
    "https://www.web-jam.com/outreach/report/2026-10-16-to-2026-10-18",
  );
});

Deno.test("renderStatusBadge: returns appropriate CSS classes for all outreach statuses", () => {
  assertStringIncludes(renderStatusBadge("sent"), "badge-sent");
  assertStringIncludes(renderStatusBadge("replied"), "badge-replied");
  assertStringIncludes(renderStatusBadge("interested"), "badge-interested");
  assertStringIncludes(renderStatusBadge("booked"), "badge-booked");
  assertStringIncludes(renderStatusBadge("not-interested"), "badge-not-interested");
  assertStringIncludes(renderStatusBadge("no-response"), "badge-no-response");
  assertStringIncludes(renderStatusBadge("target-filled"), "badge-target-filled");
  assertStringIncludes(renderStatusBadge("bounced"), "badge-bounced");
  assertStringIncludes(renderStatusBadge("sent", "bounce"), "badge-bounced");
});

Deno.test("renderDarkHtml: generates responsive Dark Mode HTML with live campaigns and pending replies", () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  const campaigns: OutreachCampaignRecord[] = [
    {
      _id: "c1",
      venueId: "v1",
      venueName: "The Spot on Kirk",
      location: "Roanoke, VA",
      status: "replied",
      sentAt: "2026-08-10T10:00:00Z",
      replySnippet: "We'd love to host you on Saturday!",
      suggestion: {
        intent: "Interested / Booking Offer",
        confidence: 0.95,
        action: "Confirm booking",
        notes: "Offered Oct 17 slot.",
      },
    },
    {
      _id: "c2",
      venueId: "v2",
      venueName: "Big Lick Brewing",
      location: "Roanoke, VA",
      status: "sent",
      sentAt: "2026-08-11T12:00:00Z",
    },
  ];

  const resultWithReplies = {
    mode: "replies" as const,
    weekend,
    candidates: [],
    density: { count: 0, isSparse: false },
    pitches: [],
    repliesTracking: {
      checkReplies: { checked: 2, matched: 1, classified: 1, bounced: 0 },
      pendingReplies: [campaigns[0]],
      campaigns,
    },
  };

  const html = renderDarkHtml(resultWithReplies);
  assertStringIncludes(html, "The Spot on Kirk");
  assertStringIncludes(html, "Big Lick Brewing");
  assertStringIncludes(html, "We&#039;d love to host you on Saturday!");
  assertStringIncludes(html, "badge-replied");
  assertStringIncludes(html, "Confirm booking");
  assertStringIncludes(html, "95%");
  assertStringIncludes(html, "Outreach Response & Reply Tracking");

  // Batch Dispatch Result HTML
  const resultWithBatch = {
    mode: "send" as const,
    weekend,
    candidates: [],
    density: { count: 0, isSparse: false },
    pitches: [],
    batchDispatch: {
      requested: 2,
      sent: 1,
      skipped: [{ venueId: "v3", venueName: "Skipped Place", reason: "no email" }],
      records: [],
    },
  };

  const batchHtml = renderDarkHtml(resultWithBatch);
  assertStringIncludes(batchHtml, "Batch Outreach Dispatch");
  assertStringIncludes(batchHtml, "Skipped Place");
  assertStringIncludes(batchHtml, "no email");
  assertStringIncludes(batchHtml, "1 dispatched");
});

Deno.test("renderDarkHtml: embeds interactive client-side column sorting CSS and script (#881)", () => {
  const result = {
    mode: "preview" as const,
    weekend: {
      start: "2026-10-16",
      end: "2026-10-18",
      rawText: "Oct 16-18 2026",
      label: "October 16–18, 2026",
      year: 2026,
      month: 10,
      days: [16, 17, 18],
    },
    candidates: [
      {
        _id: "v1",
        name: "Olde Salem Brewing",
        city: "Salem",
        usState: "VA",
        contactName: "Kevin",
        phone: "540-555-0101",
        email: "booking@oldesalem.com",
        reason: { spacingNote: "Eligible (60+ days)" },
      },
      {
        _id: "v2",
        name: "The Glass House",
        city: "Lynchburg",
        usState: "VA",
        contactName: "Sarah",
        phone: "434-555-0102",
        email: "events@glasshouse.com",
        reason: { spacingNote: "Eligible (60+ days)" },
      },
    ],
    density: { count: 2, isSparse: false },
    pitches: [],
  };

  const html = renderDarkHtml(result);

  // Verify sortable CSS is present
  assertStringIncludes(html, "table.candidate-table th.sortable-th");
  assertStringIncludes(html, "cursor: pointer;");
  assertStringIncludes(html, ".sort-indicator");
  assertStringIncludes(html, "th[data-sort-dir] .sort-indicator");

  // Verify inline sorting script is embedded
  assertStringIncludes(html, "<script>");
  assertStringIncludes(html, "initTableSorting");
  assertStringIncludes(html, "data-sort-dir");
  assertStringIncludes(html, "localeCompare");
  assertStringIncludes(html, "</script>");

  // Verify SORTING_SCRIPT contains column sorting logic and arrow toggles
  assertStringIncludes(SORTING_SCRIPT, "data-sort-dir");
  assertStringIncludes(SORTING_SCRIPT, "▲");
  assertStringIncludes(SORTING_SCRIPT, "▼");
  assertStringIncludes(SORTING_SCRIPT, "sortable-th");
  assertStringIncludes(SORTING_SCRIPT, "localeCompare");
});

Deno.test("renderDarkHtml: loads /outreach/table-sort.js for CSP compliance and re-indexes row numbers on sort (#938)", () => {
  const result: BookGigResult = {
    mode: "preview",
    weekend: {
      start: "2026-10-16",
      end: "2026-10-18",
      rawText: "Oct 16-18 2026",
      label: "October 16–18, 2026",
      year: 2026,
      month: 10,
      days: [16, 17, 18],
    },
    candidates: [
      {
        _id: "v1",
        name: "Olde Salem Brewing",
        city: "Salem",
        usState: "VA",
        contactName: "Kevin",
        phone: "540-555-0101",
        email: "booking@oldesalem.com",
      },
      {
        _id: "v2",
        name: "The Glass House",
        city: "Lynchburg",
        usState: "VA",
        contactName: "Sarah",
        phone: "434-555-0102",
        email: "events@glasshouse.com",
      },
    ],
    density: { count: 2, isSparse: false },
    pitches: [],
  };

  const html = renderDarkHtml(result);

  // Assert external script is included for CSP compliance
  assertStringIncludes(html, '<script src="/outreach/table-sort.js?v=2"></script>');

  // Assert SORTING_SCRIPT contains offline guard / fallback
  assertStringIncludes(SORTING_SCRIPT, 'typeof initTableSorting === "function"');
  assertStringIncludes(SORTING_SCRIPT, "window.initTableSorting");

  // Assert SORTING_SCRIPT contains row re-indexing logic
  assertStringIncludes(SORTING_SCRIPT, ".num-col");
  assertStringIncludes(SORTING_SCRIPT, "idx + 1");

  // Verify SORTING_SCRIPT offline fallback guards against double-initialization
  const mockWindowWithScript: { initTableSorting: () => string } = {
    initTableSorting: () => "preloaded",
  };
  const fnA = new Function("window", "document", "initTableSorting", SORTING_SCRIPT);
  fnA(
    mockWindowWithScript,
    { readyState: "complete", querySelectorAll: () => [] },
    mockWindowWithScript.initTableSorting,
  );
  assertEquals(mockWindowWithScript.initTableSorting(), "preloaded");

  const mockWindowOffline: { initTableSorting?: unknown } = {};
  const fnB = new Function("window", "document", "initTableSorting", SORTING_SCRIPT);
  fnB(mockWindowOffline, { readyState: "complete", querySelectorAll: () => [] }, undefined);
  assertEquals(typeof mockWindowOffline.initTableSorting, "function");

  // Verify sort re-indexes row numbers 1..N
  type Listener = (e?: unknown) => void;
  interface MockEl {
    tagName: string;
    className: string;
    classList: { add: (c: string) => void };
    textContent: string;
    innerText: string;
    children: MockEl[];
    getAttribute: (name: string) => string | null;
    setAttribute: (name: string, val: string) => void;
    removeAttribute: (name: string) => void;
    addEventListener: (evt: string, cb: Listener) => void;
    trigger: (evt: string) => void;
    appendChild: (child: MockEl) => void;
    querySelector: (sel: string) => MockEl | null;
    querySelectorAll: (sel: string) => MockEl[];
  }

  function createMockElement(tagName: string, className = ""): MockEl {
    const listeners: Record<string, Listener[]> = {};
    const attrs: Record<string, string> = {};
    const children: MockEl[] = [];
    const el: MockEl = {
      tagName,
      className,
      classList: {
        add: (c: string) => {
          el.className += " " + c;
        },
      },
      textContent: "",
      innerText: "",
      children,
      getAttribute: (name: string) => attrs[name] || null,
      setAttribute: (name: string, val: string) => {
        attrs[name] = val;
      },
      removeAttribute: (name: string) => {
        delete attrs[name];
      },
      addEventListener: (evt: string, cb: Listener) => {
        listeners[evt] = listeners[evt] || [];
        listeners[evt].push(cb);
      },
      trigger: (evt: string) => {
        (listeners[evt] || []).forEach((cb) => cb());
      },
      appendChild: (child: MockEl) => {
        const idx = children.indexOf(child);
        if (idx !== -1) children.splice(idx, 1);
        children.push(child);
      },
      querySelector: (sel: string): MockEl | null => {
        if (sel === ".sort-indicator") {
          return children.find((c) => c.className === "sort-indicator") || null;
        }
        if (sel === ".num-col") {
          return children.find((c) => c.className === "num-col") || null;
        }
        if (sel === "td[colspan]") {
          return children.find((c) => Boolean(c.getAttribute("colspan"))) || null;
        }
        if (sel === "tbody") return children.find((c) => c.tagName === "tbody") || null;
        return null;
      },
      querySelectorAll: (sel: string): MockEl[] => {
        if (sel === "thead th") {
          return children.filter((c) => c.tagName === "thead").flatMap((th) =>
            th.children.filter((c) => c.tagName === "th")
          );
        }
        if (sel === "tr") return children.filter((c) => c.tagName === "tr");
        return [];
      },
    };
    return el;
  }

  const table = createMockElement("table", "candidate-table");
  const thead = createMockElement("thead");
  const thNum = createMockElement("th");
  thNum.textContent = "#";
  const thName = createMockElement("th");
  thName.textContent = "Venue Name";
  thead.appendChild(thNum);
  thead.appendChild(thName);
  table.appendChild(thead);

  const tbody = createMockElement("tbody");

  // Row 1: # 1, Name Z
  const r1 = createMockElement("tr");
  const c1_0 = createMockElement("td", "num-col");
  c1_0.textContent = "1";
  c1_0.innerText = "1";
  const c1_1 = createMockElement("td");
  c1_1.textContent = "Zoo";
  c1_1.innerText = "Zoo";
  r1.appendChild(c1_0);
  r1.appendChild(c1_1);
  tbody.appendChild(r1);

  // Row 2: # 2, Name A
  const r2 = createMockElement("tr");
  const c2_0 = createMockElement("td", "num-col");
  c2_0.textContent = "2";
  c2_0.innerText = "2";
  const c2_1 = createMockElement("td");
  c2_1.textContent = "Apex";
  c2_1.innerText = "Apex";
  r2.appendChild(c2_0);
  r2.appendChild(c2_1);
  tbody.appendChild(r2);

  table.appendChild(tbody);

  const mockDoc = {
    readyState: "complete",
    createElement: (tag: string) => createMockElement(tag),
    querySelectorAll: (sel: string) => sel === "table.candidate-table" ? [table] : [],
    addEventListener: () => {},
  };

  const mockWin = {};
  const fn = new Function("window", "document", "initTableSorting", SORTING_SCRIPT);
  fn(mockWin, mockDoc, undefined);

  // Click Name header to sort ascending: Apex first (#1), Zoo second (#2)
  thName.trigger("click");
  assertEquals(tbody.children[0].children[1].textContent, "Apex");
  assertEquals(tbody.children[0].children[0].textContent, "1");
  assertEquals(tbody.children[1].children[1].textContent, "Zoo");
  assertEquals(tbody.children[1].children[0].textContent, "2");

  // Click Name header again to sort descending: Zoo first (#1), Apex second (#2)
  thName.trigger("click");
  assertEquals(tbody.children[0].children[1].textContent, "Zoo");
  assertEquals(tbody.children[0].children[0].textContent, "1");
  assertEquals(tbody.children[1].children[1].textContent, "Apex");
  assertEquals(tbody.children[1].children[0].textContent, "2");
});

Deno.test("renderDarkHtml: includes Pay column, states New vs Returning outright, and provides full width with tablet breakpoint (#896)", () => {
  const result = {
    mode: "preview" as const,
    weekend: {
      start: "2026-10-16",
      end: "2026-10-18",
      rawText: "Oct 16-18 2026",
      label: "October 16–18, 2026",
      year: 2026,
      month: 10,
      days: [16, 17, 18],
    },
    candidates: [
      {
        _id: "v1",
        name: "Parkway Brewing",
        city: "Salem",
        usState: "VA",
        contactName: "Lezlie",
        phone: "540-555-0101",
        email: "lezlie@parkwaybrewing.com",
        payAmount: 150,
        reason: { lastGigDate: "2026-06-15" },
      },
      {
        _id: "v2",
        name: "Olde Salem Brewing",
        city: "Salem",
        usState: "VA",
        contactName: "Kevin",
        phone: "540-555-0102",
        email: "booking@oldesalem.com",
        payAmount: 0.01,
        reason: { lastGigDate: null },
      },
      {
        _id: "v3",
        name: "The Glass House",
        city: "Lynchburg",
        usState: "VA",
        contactName: "Sarah",
        phone: "434-555-0103",
        email: "events@glasshouse.com",
        reason: {},
      },
      {
        _id: "v4",
        name: "Community Hall",
        city: "Roanoke",
        usState: "VA",
        payAmount: 0,
        reason: {},
      },
      {
        _id: "v5",
        name: "Negative Int Venue",
        city: "Roanoke",
        usState: "VA",
        payAmount: -5,
        reason: {},
      },
      {
        _id: "v6",
        name: "Negative Dec Venue",
        city: "Roanoke",
        usState: "VA",
        payAmount: -5.5,
        reason: {},
      },
      {
        _id: "v7",
        name: "Non-finite Venue",
        city: "Roanoke",
        usState: "VA",
        payAmount: NaN,
        reason: {},
      },
    ],
    density: { count: 7, isSparse: false },
    pitches: [],
  };

  const html = renderDarkHtml(result);

  // 1. Pay column in table header and cells
  assertStringIncludes(html, "<th>Pay</th>");
  assertStringIncludes(html, "<td>$150</td>");
  assertStringIncludes(html, "<td>$0.01</td>");
  assertStringIncludes(html, "<td>$0</td>");
  assertStringIncludes(html, "<td>-$5</td>");
  assertStringIncludes(html, "<td>-$5.50</td>");
  assertStringIncludes(html, "<td>—</td>");

  // 2. Reworded Spacing Status badge stating Returning / New outright
  assertStringIncludes(html, "Returning · Last: Jun 15");
  assertStringIncludes(html, "badge-returning");
  assertStringIncludes(html, "Returning");
  assertStringIncludes(html, ">New</span>");
  assertStringIncludes(html, "badge-eligible");

  // 3. Fallback table when candidates are empty
  const emptyResult = {
    ...result,
    candidates: [],
  };
  const emptyHtml = renderDarkHtml(emptyResult);
  assertStringIncludes(emptyHtml, "<th>Pay</th>");
  assertStringIncludes(emptyHtml, '<td colspan="8"');

  // 4. Responsive styling: full width container & tablet breakpoint
  assertStringIncludes(html, "width: 100%;");
  assert(!html.includes("max-width: 960px;"));
  assertStringIncludes(html, "@media (max-width: 1024px)");
  assertStringIncludes(html, "min-width: 850px;");
  assertStringIncludes(html, "@media (max-width: 600px)");
});

Deno.test("formatPay: handles positive, negative, zero, non-finite, and nullish amounts", () => {
  // Positive integers and decimals
  assertEquals(formatPay(150), "$150");
  assertEquals(formatPay(0.01), "$0.01");

  // Zero
  assertEquals(formatPay(0), "$0");

  // Negative integers and decimals
  assertEquals(formatPay(-5), "-$5");
  assertEquals(formatPay(-5.5), "-$5.50");

  // Non-finite values
  assertEquals(formatPay(NaN), "—");
  assertEquals(formatPay(Infinity), "—");
  assertEquals(formatPay(-Infinity), "—");

  // Undefined and null
  assertEquals(formatPay(undefined), "—");
  assertEquals(formatPay(null), "—");
});

Deno.test("dispatchBatchOutreach: sends POST /outreach/batch with correct payload and headers", async () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  let capturedUrl = "";
  let capturedBody: Record<string, unknown> = {};
  let capturedAuth = "";

  const mockFetch: typeof fetch = (url, init) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init?.body || "{}"));
    capturedAuth = (init?.headers as Record<string, string>)?.["Authorization"] || "";

    return Promise.resolve(
      new Response(
        JSON.stringify({
          requested: 2,
          sent: 2,
          skipped: [],
          records: [{ _id: "rec1" }, { _id: "rec2" }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  };

  const res = await dispatchBatchOutreach(
    {
      weekend,
      venueIds: ["v1", "v2"],
      backendUrl: "https://test.local",
      token: "secret-token",
    },
    mockFetch,
  );

  assertEquals(capturedUrl, "https://test.local/outreach/batch");
  assertEquals(capturedAuth, "Bearer secret-token");
  assertEquals(capturedBody.venueIds, ["v1", "v2"]);
  assertEquals(capturedBody.targetDates, "October 16–18, 2026");
  assertEquals(capturedBody.bookingPeriod, "October 2026");
  assertEquals(capturedBody.targetWeekend, { start: "2026-10-16", end: "2026-10-18" });
  assertEquals(res.sent, 2);
  assertEquals(res.requested, 2);
});

Deno.test("dispatchBatchOutreach: slices 60 venues into sequential chunks of 25, 25, 10 and aggregates results (#1107)", async () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  const venueIds = Array.from({ length: 60 }, (_, i) => `venue-${i + 1}`);
  const capturedPayloads: Record<string, unknown>[] = [];
  const progressCalls: { chunkIndex: number; totalChunks: number; chunkSize: number }[] = [];

  const mockFetch: typeof fetch = (_url, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    capturedPayloads.push(body);
    const chunkVenues = body.venueIds as string[];
    const chunkSent = chunkVenues.length > 20 ? chunkVenues.length - 1 : chunkVenues.length;
    const chunkSkipped = chunkVenues.length > 20
      ? [{ venueId: chunkVenues[0], venueName: `Skipped ${chunkVenues[0]}`, reason: "opt-out" }]
      : [];

    return Promise.resolve(
      new Response(
        JSON.stringify({
          requested: chunkVenues.length,
          sent: chunkSent,
          skipped: chunkSkipped,
          records: Array.from(
            { length: chunkSent },
            (_, idx) => ({ _id: `rec-${chunkVenues[idx]}` }),
          ),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  };

  const res = await dispatchBatchOutreach(
    {
      weekend,
      venueIds,
      onChunkProgress: (chunkIndex, totalChunks, chunkSize) => {
        progressCalls.push({ chunkIndex, totalChunks, chunkSize });
      },
    },
    mockFetch,
  );

  // Assert 3 chunks sequentially dispatched
  assertEquals(capturedPayloads.length, 3);
  assertEquals((capturedPayloads[0].venueIds as string[]).length, 25);
  assertEquals((capturedPayloads[0].venueIds as string[])[0], "venue-1");
  assertEquals((capturedPayloads[0].venueIds as string[])[24], "venue-25");

  assertEquals((capturedPayloads[1].venueIds as string[]).length, 25);
  assertEquals((capturedPayloads[1].venueIds as string[])[0], "venue-26");
  assertEquals((capturedPayloads[1].venueIds as string[])[24], "venue-50");

  assertEquals((capturedPayloads[2].venueIds as string[]).length, 10);
  assertEquals((capturedPayloads[2].venueIds as string[])[0], "venue-51");
  assertEquals((capturedPayloads[2].venueIds as string[])[9], "venue-60");

  // Assert progress callback was called for each chunk
  assertEquals(progressCalls, [
    { chunkIndex: 1, totalChunks: 3, chunkSize: 25 },
    { chunkIndex: 2, totalChunks: 3, chunkSize: 25 },
    { chunkIndex: 3, totalChunks: 3, chunkSize: 10 },
  ]);

  // Assert aggregation (24 + 24 + 10 = 58 sent, 2 skipped, 60 requested)
  assertEquals(res.requested, 60);
  assertEquals(res.sent, 58);
  assertEquals(res.skipped.length, 2);
  assertEquals(res.records.length, 58);
});

Deno.test("dispatchBatchOutreach: halts on chunk refusal (HTTP 403) and reports partial sent count (#1107)", async () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  const venueIds = Array.from({ length: 60 }, (_, i) => `venue-${i + 1}`);
  let callCount = 0;

  const mockFetch: typeof fetch = (_url, init) => {
    callCount++;
    const body = JSON.parse(String(init?.body || "{}"));
    const chunkVenues = body.venueIds as string[];

    if (callCount === 1) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            requested: 25,
            sent: 25,
            skipped: [],
            records: Array.from({ length: 25 }, (_, idx) => ({ _id: `rec-${chunkVenues[idx]}` })),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    // Chunk 2 refuses with HTTP 403 Gate 2 refusal
    return Promise.resolve(
      new Response(
        "Gate 2 draft copy approval invalid or missing for batch",
        { status: 403, headers: { "Content-Type": "text/plain" } },
      ),
    );
  };

  const err = await assertRejects(
    async () => {
      await dispatchBatchOutreach({ weekend, venueIds }, mockFetch);
    },
    BatchDispatchError,
  );

  // Assert call count halted at chunk 2 (chunk 3 never called)
  assertEquals(callCount, 2);
  assertEquals(err.status, 403);
  assertEquals(err.chunkIndex, 2);
  assertEquals(err.totalChunks, 3);
  assertEquals(err.partialResult.sent, 25);
  assertEquals(err.partialResult.requested, 25);
  assertEquals(err.partialResult.records.length, 25);
  assertStringIncludes(err.message, "HTTP 403 on chunk 2/3 (25 venue(s))");
  assertStringIncludes(err.message, "Gate 2 draft copy approval invalid");
  assertStringIncludes(err.message, "Previously sent: 25 venue(s)");
});

Deno.test("dispatchBatchOutreach: fails closed on network failure during chunked dispatch (#1107)", async () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  const venueIds = Array.from({ length: 60 }, (_, i) => `venue-${i + 1}`);
  let callCount = 0;

  const mockFetch: typeof fetch = (_url, init) => {
    callCount++;
    const body = JSON.parse(String(init?.body || "{}"));
    const chunkVenues = body.venueIds as string[];

    if (callCount === 1) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            requested: 25,
            sent: 25,
            skipped: [],
            records: Array.from({ length: 25 }, (_, idx) => ({ _id: `rec-${chunkVenues[idx]}` })),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    // Chunk 2 experiences network failure / socket timeout
    return Promise.reject(new Error("Connection reset by peer"));
  };

  const err = await assertRejects(
    async () => {
      await dispatchBatchOutreach({ weekend, venueIds }, mockFetch);
    },
    BatchDispatchError,
  );

  // Assert call count halted at chunk 2 (chunk 3 never attempted)
  assertEquals(callCount, 2);
  assertEquals(err.status, undefined);
  assertEquals(err.chunkIndex, 2);
  assertEquals(err.totalChunks, 3);
  assertEquals(err.partialResult.sent, 25);
  assertStringIncludes(err.message, "network error on chunk 2/3 (25 venue(s))");
  assertStringIncludes(err.message, "Connection reset by peer");
  assertStringIncludes(err.message, "Previously sent: 25 venue(s)");
});

Deno.test("dispatchBatchOutreach: handles empty venueIds, exact chunk boundary, and custom chunkSize option (#1107)", async () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  let callCount = 0;
  const mockFetch: typeof fetch = () => {
    callCount++;
    return Promise.resolve(
      new Response(
        JSON.stringify({ requested: 5, sent: 5, skipped: [], records: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  // 0. BATCH_CHUNK_SIZE constant is 25
  assertEquals(BATCH_CHUNK_SIZE, 25);

  // 1. Empty venueIds returns zero result without calling fetch
  const emptyRes = await dispatchBatchOutreach({ weekend, venueIds: [] }, mockFetch);
  assertEquals(callCount, 0);
  assertEquals(emptyRes, { requested: 0, sent: 0, skipped: [], records: [] });

  // 2. Exactly 25 venueIds produces exactly 1 chunk
  const exactly25 = Array.from({ length: 25 }, (_, i) => `v-${i + 1}`);
  const exactRes = await dispatchBatchOutreach({ weekend, venueIds: exactly25 }, mockFetch);
  assertEquals(callCount, 1);
  assertEquals(exactRes.sent, 5);

  // 3. Custom chunkSize: 12 venues with chunkSize = 5 yields 3 chunks (5, 5, 2)
  callCount = 0;
  const twelveVenues = Array.from({ length: 12 }, (_, i) => `v-${i + 1}`);
  await dispatchBatchOutreach({ weekend, venueIds: twelveVenues, chunkSize: 5 }, mockFetch);
  assertEquals(callCount, 3);
});

Deno.test("runBookGigCli: halts and logs partial summary when chunk dispatch fails in --send mode (#1107)", async () => {
  const venues = Array.from({ length: 30 }, (_, i) => ({
    _id: `v-${i + 1}`,
    name: `Venue ${i + 1}`,
    email: `booking${i + 1}@venue.com`,
    city: "Salem",
    usState: "VA",
    outreachEligible: true,
  }));

  let batchCalls = 0;
  const mockFetch: typeof fetch = (url) => {
    const u = String(url);
    if (u.includes("/venue/candidates") || u.includes("/outreach/candidates")) {
      return Promise.resolve(
        new Response(JSON.stringify(venues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/outreach/preview")) {
      const w: TargetWeekend = {
        start: "2026-10-16",
        end: "2026-10-18",
        rawText: "Oct 16-18 2026",
        label: "October 16–18, 2026",
        year: 2026,
        month: 10,
        days: [16, 17, 18],
      };
      return Promise.resolve(
        new Response(
          JSON.stringify(venues.map((v) => {
            const p = renderPitch(v, w);
            return {
              venueId: v._id,
              venueName: v.name,
              to: v.email,
              subject: p.subject,
              body: p.htmlBody || p.body,
            };
          })),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (u.includes("/template")) {
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/outreach/batch")) {
      batchCalls++;
      if (batchCalls === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ requested: 25, sent: 25, skipped: [], records: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response("Gate 2 refusal", { status: 403, headers: { "Content-Type": "text/plain" } }),
      );
    }
    if (u.includes("/outreach/report")) {
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, url: "https://web-jam.com/report/1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const mockOpener = () => Promise.resolve(true);

  const err = await assertRejects(
    async () => {
      await runBookGigCli(
        ["--send", "Oct 16-18 2026", "Salem, VA", "--confirm-drafts", "--no-open"],
        mockFetch,
        mockOpener,
      );
    },
    BatchDispatchError,
  );

  assertEquals(batchCalls, 2);
  assertEquals(err.status, 403);
  assertEquals(err.chunkIndex, 2);
  assertEquals(err.partialResult.sent, 25);
});

Deno.test("checkGmailReplies, fetchPendingReplies, fetchOutreachCampaigns, and fetchVenueMap: mocked backend API interactions", async () => {
  const mockFetch: typeof fetch = (url) => {
    const u = String(url);
    if (u.includes("/outreach/check-replies")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ checked: 3, matched: 1, classified: 1, bounced: 0 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (u.includes("/outreach/replies/pending")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            { _id: "o1", venueId: "v1", status: "replied", replySnippet: "We have space!" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (u.includes("/outreach")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              _id: "o1",
              venueId: "v1",
              status: "replied",
              targetDates: "2026-10-16 to 2026-10-18",
            },
            { _id: "o2", venueId: "v2", status: "sent", targetDates: "2026-10-16 to 2026-10-18" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (u.includes("/venue")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            { _id: "v1", name: "Venue One", city: "Salem", usState: "VA" },
            { _id: "v2", name: "Venue Two", city: "Roanoke", usState: "VA" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };

  const check = await checkGmailReplies({ backendUrl: "https://test.local" }, mockFetch);
  assertEquals(check.checked, 3);
  assertEquals(check.matched, 1);

  const pending = await fetchPendingReplies({ backendUrl: "https://test.local" }, mockFetch);
  assertEquals(pending.length, 1);
  assertEquals(pending[0]._id, "o1");

  const campaigns = await fetchOutreachCampaigns({ backendUrl: "https://test.local" }, mockFetch);
  assertEquals(campaigns.length, 2);

  const venueMap = await fetchVenueMap({ backendUrl: "https://test.local" }, mockFetch);
  assertEquals(venueMap.get("v1")?.name, "Venue One");
  assertEquals(venueMap.get("v2")?.city, "Roanoke");
});

Deno.test("fetchCandidates: fetches candidates with bare array and handles error status", async () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  const mockVenues: CandidateVenue[] = [
    { _id: "1", name: "Macado's", city: "Roanoke", usState: "VA", email: "info@macados.com" },
  ];

  let capturedUrl1 = "";
  // Bare array response
  const mockFetch1: typeof fetch = (_url: string | URL | Request) => {
    const u = String(_url);
    if (u.includes("/outreach/candidates")) {
      capturedUrl1 = u;
    }
    return Promise.resolve(
      new Response(JSON.stringify(mockVenues), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const candidates1 = await fetchCandidates(
    { weekend, backendUrl: "https://test.local", token: "fake-token" },
    mockFetch1,
  );
  assertEquals(candidates1.length, 1);
  assertEquals(candidates1[0].name, "Macado's");
  assertStringIncludes(capturedUrl1, "targetDates=2026-10-16%20to%202026-10-18");
  assertStringIncludes(capturedUrl1, "targetWeekend[start]=2026-10-16");
  assertStringIncludes(capturedUrl1, "targetWeekend[end]=2026-10-18");

  // Wrapped candidates object response
  let capturedUrl2 = "";
  const mockFetchWrapped: typeof fetch = (_url: string | URL | Request) => {
    const u = String(_url);
    if (u.includes("/outreach/candidates")) {
      capturedUrl2 = u;
    }
    return Promise.resolve(
      new Response(JSON.stringify({ candidates: mockVenues }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const candidatesWrapped = await fetchCandidates(
    { weekend, backendUrl: "https://test.local" },
    mockFetchWrapped,
  );
  assertEquals(candidatesWrapped.length, 1);
  assertEquals(candidatesWrapped[0].name, "Macado's");
  assertStringIncludes(capturedUrl2, "targetWeekend[start]=2026-10-16");
  assertStringIncludes(capturedUrl2, "targetWeekend[end]=2026-10-18");

  // Error status response
  const mockFetch2: typeof fetch = (_url: string | URL | Request) => {
    return Promise.resolve(
      new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );
  };

  const candidates2 = await fetchCandidates(
    { weekend, backendUrl: "https://test.local" },
    mockFetch2,
  );
  assertEquals(candidates2.length, 0);
});

Deno.test("runBookGigCli: executes in discovery, --send, and --replies modes with mocked fetch", async () => {
  const mockVenues: CandidateVenue[] = [
    {
      _id: "v1",
      name: "Olde Salem Brewing",
      city: "Salem",
      usState: "VA",
      email: "booking@oldesalem.com",
      outreachEligible: true,
    },
  ];

  const mockFetch: typeof fetch = (url, _init) => {
    const u = String(url);
    if (u.includes("/outreach/candidates")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/outreach/batch")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            requested: 1,
            sent: 1,
            skipped: [],
            records: [{ _id: "outreach1" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (u.includes("/outreach/check-replies")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ checked: 1, matched: 1, classified: 1, bounced: 0 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (u.includes("/outreach/replies/pending")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              _id: "o1",
              venueId: "v1",
              status: "replied",
              targetDates: "2026-10-16 to 2026-10-18",
              targetWeekend: { start: "2026-10-16", end: "2026-10-18" },
              replySnippet: "Oct 17 works great!",
              suggestion: { action: "Confirm date", intent: "Booking Offer", confidence: 0.9 },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (u.includes("/outreach/preview")) {
      const rendered = renderPitch(mockVenues[0], {
        start: "2026-10-16",
        end: "2026-10-18",
        rawText: "Oct 16-18 2026",
        label: "October 16–18, 2026",
        year: 2026,
        month: 10,
        days: [16, 17, 18],
      });
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              venueId: "v1",
              venueName: "Olde Salem Brewing",
              subject: rendered.subject,
              body: rendered.htmlBody || rendered.body,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (u.includes("/outreach")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              _id: "o1",
              venueId: "v1",
              status: "replied",
              sentAt: "2026-08-10T10:00:00Z",
              targetDates: "2026-10-16 to 2026-10-18",
              replySnippet: "Oct 17 works great!",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (u.includes("/venue")) {
      return Promise.resolve(
        new Response(
          JSON.stringify(mockVenues),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const mockOpener = () => Promise.resolve(true);

  // Discovery mode (default)
  const resultDiscovery = await runBookGigCli(
    ["Oct 16-18 2026", "Salem, VA"],
    mockFetch,
    mockOpener,
  );
  assertEquals(resultDiscovery.mode, "preview");
  assertEquals(resultDiscovery.weekend?.start, "2026-10-16");
  assertEquals(resultDiscovery.candidates.length, 1);
  assertEquals(resultDiscovery.pitches.length, 1);

  // Batch send mode (--send)
  const resultSend = await runBookGigCli(
    ["--send", "Oct 16-18 2026", "Salem, VA", "--confirm-drafts"],
    mockFetch,
    mockOpener,
  );
  assertEquals(resultSend.mode, "send");
  assertEquals(resultSend.batchDispatch?.sent, 1);
  assertEquals(resultSend.batchDispatch?.requested, 1);

  // Replies tracking mode (--replies)
  const resultReplies = await runBookGigCli(
    ["--replies", "Oct 16-18 2026"],
    mockFetch,
    mockOpener,
  );
  assertEquals(resultReplies.mode, "replies");
  assertEquals(resultReplies.repliesTracking?.checkReplies.matched, 1);
  assertEquals(resultReplies.repliesTracking?.campaigns.length, 1);
  assertEquals(resultReplies.repliesTracking?.pendingReplies.length, 1);
});

Deno.test("matchesVenueFilter: correctly matches venues by _id or name", () => {
  const v1: CandidateVenue = {
    _id: "64a123",
    name: "Olde Salem Brewing",
    city: "Salem",
    usState: "VA",
  };
  const v2: CandidateVenue = {
    _id: "v2",
    name: "Waterman's Grill",
    city: "Lynchburg",
    usState: "VA",
  };

  // Match by ID
  assertEquals(matchesVenueFilter(v1, ["64a123"]), true);
  assertEquals(matchesVenueFilter(v2, ["v2"]), true);

  // Match by Name (case-insensitive)
  assertEquals(matchesVenueFilter(v1, ["olde salem brewing"]), true);
  assertEquals(matchesVenueFilter(v2, ["Waterman's Grill"]), true);
  assertEquals(matchesVenueFilter(v2, ["watermans grill"]), true); // punctuation stripped match

  // Non-matching
  assertEquals(matchesVenueFilter(v1, ["v2", "Another Venue"]), false);
  assertEquals(matchesVenueFilter(v1, []), false);
});

Deno.test("parseBookGigArgs: parses --venues, --include, --skip, and --exclude flags", () => {
  const res1 = parseBookGigArgs([
    "--send",
    "Oct 16-18 2026",
    "Lynchburg, VA",
    "--venues",
    "v1,v2",
  ]);
  assertEquals(res1.mode, "send");
  assertEquals(res1.includeVenues, ["v1", "v2"]);
  assertEquals(res1.excludeVenues, undefined);
  assertEquals(res1.weekend?.start, "2026-10-16");
  assertEquals(res1.location?.city, "Lynchburg");

  const res2 = parseBookGigArgs([
    "--send",
    "Oct 16-18 2026",
    "--include=v1,v2",
    "--skip=v3",
  ]);
  assertEquals(res2.mode, "send");
  assertEquals(res2.includeVenues, ["v1", "v2"]);
  assertEquals(res2.excludeVenues, ["v3"]);

  const res3 = parseBookGigArgs([
    "--send",
    "Oct 16-18 2026",
    "--skip",
    "Olde Salem Brewing, Parkway Brewing",
  ]);
  assertEquals(res3.mode, "send");
  assertEquals(res3.excludeVenues, ["Olde Salem Brewing", "Parkway Brewing"]);

  const res4 = parseBookGigArgs([
    "--send",
    "Oct 16-18 2026",
    "--exclude",
    "v1",
  ]);
  assertEquals(res4.excludeVenues, ["v1"]);
});

Deno.test("parseBookGigArgs: parses compound date and multi-city expressions and explicit --cities flags", () => {
  // Single compound expression argument
  const res1 = parseBookGigArgs([
    "Oct 16-18 and Lynchburg, Blacksburg, Martinsville, Salem, Roanoke, and surrounding areas",
  ]);
  assertEquals(res1.mode, "preview");
  assertEquals(res1.weekend?.start, "2026-10-16");
  assertEquals(res1.weekend?.end, "2026-10-18");
  assertEquals(res1.location?.cities, [
    "Lynchburg",
    "Blacksburg",
    "Martinsville",
    "Salem",
    "Roanoke",
  ]);
  assertEquals(res1.location?.includeSurrounding, true);

  // Explicit --cities flag
  const res2 = parseBookGigArgs([
    "Oct 16-18 2026",
    "--cities",
    "Lynchburg, Blacksburg, Martinsville, Salem, Roanoke",
  ]);
  assertEquals(res2.weekend?.start, "2026-10-16");
  assertEquals(res2.location?.cities, [
    "Lynchburg",
    "Blacksburg",
    "Martinsville",
    "Salem",
    "Roanoke",
  ]);

  // Explicit --locations flag with = syntax
  const res3 = parseBookGigArgs([
    "--locations=Lynchburg, Blacksburg",
    "Oct 16-18 2026",
  ]);
  assertEquals(res3.weekend?.start, "2026-10-16");
  assertEquals(res3.location?.cities, ["Lynchburg", "Blacksburg"]);

  // Explicit --location flag
  const res4 = parseBookGigArgs([
    "--location",
    "Lynchburg, VA",
    "Oct 16-18 2026",
  ]);
  assertEquals(res4.weekend?.start, "2026-10-16");
  assertEquals(res4.location?.city, "Lynchburg");
  assertEquals(res4.location?.state, "VA");
});

Deno.test("runBookGigCli: filters candidates in --send mode when --venues or --skip is provided", async () => {
  const mockVenues: CandidateVenue[] = [
    {
      _id: "v1",
      name: "Olde Salem Brewing",
      city: "Salem",
      usState: "VA",
      email: "booking@oldesalem.com",
    },
    {
      _id: "v2",
      name: "Parkway Brewing",
      city: "Salem",
      usState: "VA",
      email: "info@parkway.com",
    },
    {
      _id: "v3",
      name: "The Spot on Kirk",
      city: "Roanoke",
      usState: "VA",
      email: "booking@thespotonkirk.org",
    },
  ];

  let lastDispatchedIds: string[] = [];
  const mockFetch: typeof fetch = (url, init) => {
    const u = String(url);
    if (u.includes("/outreach/candidates")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/outreach/batch")) {
      const body = JSON.parse(String(init?.body || "{}"));
      lastDispatchedIds = body.venueIds;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            requested: body.venueIds.length,
            sent: body.venueIds.length,
            skipped: [],
            records: body.venueIds.map((id: string) => ({ _id: `outreach_${id}` })),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const mockOpener = () => Promise.resolve(true);

  // Test 1: Send all without --venues / --skip
  const resAll = await runBookGigCli(
    ["--send", "Oct 16-18 2026", "--confirm-drafts"],
    mockFetch,
    mockOpener,
  );
  assertEquals(resAll.batchDispatch?.sent, 3);
  assertEquals(lastDispatchedIds, ["v1", "v2", "v3"]);

  // Test 2: Send with --venues (approved subset by ID)
  const resSubsetId = await runBookGigCli(
    ["--send", "Oct 16-18 2026", "--confirm-drafts", "--venues", "v1,v3"],
    mockFetch,
    mockOpener,
  );
  assertEquals(resSubsetId.batchDispatch?.sent, 2);
  assertEquals(lastDispatchedIds, ["v1", "v3"]);

  // Test 3: Send with --venues (approved subset by Name)
  const resSubsetName = await runBookGigCli(
    ["--send", "Oct 16-18 2026", "--confirm-drafts", "--venues", "Parkway Brewing"],
    mockFetch,
    mockOpener,
  );
  assertEquals(resSubsetName.batchDispatch?.sent, 1);
  assertEquals(lastDispatchedIds, ["v2"]);

  // Test 4: Send with --skip (exclude specific ID)
  const resSkip = await runBookGigCli(
    ["--send", "Oct 16-18 2026", "--confirm-drafts", "--skip", "v2"],
    mockFetch,
    mockOpener,
  );
  assertEquals(resSkip.batchDispatch?.sent, 2);
  assertEquals(lastDispatchedIds, ["v1", "v3"]);

  // Test 5: Send with non-matching --venues
  const resNone = await runBookGigCli(
    ["--send", "Oct 16-18 2026", "--confirm-drafts", "--venues", "non-existent-id"],
    mockFetch,
    mockOpener,
  );
  assertEquals(resNone.batchDispatch?.sent, 0);
  assertEquals(resNone.batchDispatch?.requested, 0);

  // Test 6: Send mode automatically filters out venues with isExcluded: true
  const mockVenuesWithExcluded: CandidateVenue[] = [
    {
      _id: "v1",
      name: "Olde Salem Brewing",
      city: "Salem",
      usState: "VA",
      email: "booking@oldesalem.com",
      isExcluded: false,
    },
    {
      _id: "v-hold",
      name: "Hold Brewery",
      city: "Salem",
      usState: "VA",
      email: "hold@brewery.com",
      isExcluded: true,
      statusBadge: "[Seasonal Hold: Jan 2027]",
    },
  ];
  const mockFetchWithExcluded: typeof fetch = (url, init) => {
    const u = String(url);
    if (u.includes("/outreach/candidates")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenuesWithExcluded), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/outreach/batch")) {
      const body = JSON.parse(String(init?.body || "{}"));
      lastDispatchedIds = body.venueIds;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            requested: body.venueIds.length,
            sent: body.venueIds.length,
            skipped: [],
            records: body.venueIds.map((id: string) => ({ _id: `outreach_${id}` })),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  const resExcluded = await runBookGigCli(
    ["--send", "Oct 16-18 2026", "--confirm-drafts"],
    mockFetchWithExcluded,
    mockOpener,
  );
  assertEquals(resExcluded.batchDispatch?.sent, 1);
  assertEquals(lastDispatchedIds, ["v1"]);
});

Deno.test("openHtmlInBrowser: executes shell command with active display", async () => {
  let capturedCmd = "";
  let capturedEnv: Record<string, string> = {};

  const mockExec = (cmd: string, env: Record<string, string>) => {
    capturedCmd = cmd;
    capturedEnv = env;
    return Promise.resolve({ success: true, code: 0 });
  };

  const opened = await openHtmlInBrowser("/tmp/test-artifact.html", {
    display: ":1.0",
    execCommand: mockExec,
  });

  assertEquals(opened, true);
  assertStringIncludes(
    capturedCmd,
    'DISPLAY=":1.0" google-chrome "file:///tmp/test-artifact.html"',
  );
  assertEquals(capturedEnv["DISPLAY"], ":1.0");

  // Error handling
  const failingExec = () => {
    return Promise.reject(new Error("Command failed"));
  };
  const failed = await openHtmlInBrowser("/tmp/test-artifact.html", {
    execCommand: failingExec,
  });
  assertEquals(failed, false);
});

Deno.test("parseBookGigArgs: parses --no-open flag properly", () => {
  const res1 = parseBookGigArgs(["Oct 16-18 2026", "--no-open"]);
  assertEquals(res1.noOpen, true);
  assertEquals(res1.weekend?.start, "2026-10-16");

  const res2 = parseBookGigArgs(["--send", "Oct 16-18 2026", "--no-open"]);
  assertEquals(res2.mode, "send");
  assertEquals(res2.noOpen, true);

  const res3 = parseBookGigArgs(["--replies", "--no-open"]);
  assertEquals(res3.mode, "replies");
  assertEquals(res3.noOpen, true);
});

Deno.test("runBookGigCli: auto-opens HTML review artifact in Chrome unless --no-open is passed", async () => {
  const mockVenues: CandidateVenue[] = [
    {
      _id: "v1",
      name: "Olde Salem Brewing",
      city: "Salem",
      usState: "VA",
      email: "booking@oldesalem.com",
    },
  ];

  const mockFetch: typeof fetch = (url) => {
    const u = String(url);
    if (u.includes("/outreach/candidates")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/template")) {
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  let openedPath = "";
  const mockBrowserOpener = (htmlPath: string) => {
    openedPath = htmlPath;
    return Promise.resolve(true);
  };

  // Test auto-open on normal run
  const resOpen = await runBookGigCli(
    ["Oct 16-18 2026", "Salem, VA"],
    mockFetch,
    mockBrowserOpener,
  );
  assertEquals(resOpen.openedBrowser, true);
  assert(resOpen.htmlPath !== undefined);
  assertStringIncludes(openedPath, "book-gig-run-2026-10-16-to-2026-10-18.html");

  // Test --no-open bypasses browser opening
  openedPath = "";
  const resNoOpen = await runBookGigCli(
    ["Oct 16-18 2026", "Salem, VA", "--no-open"],
    mockFetch,
    mockBrowserOpener,
  );
  assertEquals(resNoOpen.openedBrowser, undefined);
  assertEquals(openedPath, "");
});

Deno.test("fetchTemplates: returns templates from GET /template", async () => {
  const mockTemplates: EmailTemplate[] = [
    {
      _id: "t1",
      type: "PubFestivalBrewery",
      stage: "cold",
      subject: "Live music inquiry — [Venue Name]",
      introHtml: "<p>Hi [Contact Name],</p>",
      bodyHtml: "<p>We'd love to play [Venue Name] on [Target Dates].</p>",
      active: true,
    },
  ];

  const mockFetch: typeof fetch = (input) => {
    const url = String(input);
    if (url.includes("/template")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockTemplates), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };

  const templates = await fetchTemplates({}, mockFetch);
  assertEquals(templates.length, 1);
  assertEquals(templates[0].type, "PubFestivalBrewery");
  assertEquals(templates[0].stage, "cold");
});

Deno.test("fetchTemplates: handles API error and returns empty array", async () => {
  const mockFetch: typeof fetch = () => {
    return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
  };

  const templates = await fetchTemplates({}, mockFetch);
  assertEquals(templates, []);
});

Deno.test("htmlToPlainText: converts HTML formatting, links, and entities cleanly", () => {
  const html = `
    <p>Hi Matt,</p>
    <p>We'd love to play <b>Olde Salem Brewing</b> &amp; bring live music.</p>
    <ul>
      <li><a href="https://web-jam.com/song1">Proud Mary (CCR) — live at Olde Salem</a></li>
      <li><a href="https://joshandmariamusic.com">joshandmariamusic.com</a></li>
    </ul>
    <p>Thanks,<br />Josh &amp; Maria</p>
  `;

  const plain = htmlToPlainText(html);
  assertStringIncludes(plain, "Hi Matt,");
  assertStringIncludes(plain, "Olde Salem Brewing & bring live music.");
  assertStringIncludes(
    plain,
    "• Proud Mary (CCR) — live at Olde Salem (https://web-jam.com/song1)",
  );
  assertStringIncludes(plain, "• joshandmariamusic.com");
  assertStringIncludes(plain, "Thanks,\nJosh & Maria");
  assertEquals(plain.includes("<p>"), false);
  assertEquals(plain.includes("<ul>"), false);
  assertEquals(plain.includes("<b>"), false);
});

Deno.test("renderPitch: substitutes tokens and renders canonical template copy", () => {
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
    _id: "v_pub",
    name: "Parkway Brewing Company",
    city: "Salem",
    usState: "VA",
    email: "booking@parkwaybrewing.com",
    venueType: "PubFestivalBrewery",
    contactName: "Mike",
  };

  const pitch = renderPitch(venue, weekend, {}, DEFAULT_TEMPLATES);

  // Verify tokens were substituted
  assertStringIncludes(pitch.subject, "October 2026");
  assertStringIncludes(pitch.subject, "Parkway Brewing Company");
  assertStringIncludes(pitch.body, "Hi Mike,");
  assertStringIncludes(pitch.body, "Parkway Brewing Company");
  assertStringIncludes(pitch.body, "October 16–18, 2026");
  assertEquals(pitch.body.includes("[Contact Name]"), false);
  assertEquals(pitch.body.includes("[Venue Name]"), false);
  assertEquals(pitch.body.includes("[Target Dates]"), false);
  assertEquals(pitch.body.includes("[Booking Period]"), false);
  assertEquals(pitch.body.includes("[Custom Body]"), false);

  // Verify voice rules pass
  const validation = validateVoiceRules(pitch.body);
  assertEquals(validation.valid, true);
});

Deno.test("renderPitch: injects prior contact context into custom body for returning venue with notes", () => {
  const weekend: TargetWeekend = {
    start: "2027-01-15",
    end: "2027-01-17",
    rawText: "Jan 15-17 2027",
    label: "January 15–17, 2027",
    year: 2027,
    month: 1,
    days: [15, 16, 17],
  };

  const venue: CandidateVenue = {
    _id: "v_olde_salem",
    name: "Olde Salem Brewery",
    city: "Salem",
    usState: "VA",
    email: "matt@oldesalembrewing.com",
    venueType: "PubFestivalBrewery",
    contactName: "Matt Kimble",
    notes:
      "Spoke with Matt Kimble: booked through 2026, follow up in January 2027 when booking opens.",
  };

  const pitch = renderPitch(venue, weekend, {}, DEFAULT_TEMPLATES);

  assertStringIncludes(pitch.body, "Hi Matt,");
  assertEquals(pitch.body.includes("Hi Matt Kimble,"), false);
  assertStringIncludes(pitch.body, "Following up on our earlier conversation");
  assertStringIncludes(pitch.body, "January 15–17, 2027");
  assertEquals(pitch.body.includes("[Custom Body]"), false);

  const validation = validateVoiceRules(pitch.body);
  assertEquals(validation.valid, true);
});

Deno.test("renderPitch: greets only the first word of a multi-word contactName (#1007, D-69)", () => {
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
    _id: "v_liza",
    name: "Parkway Brewing Company",
    city: "Salem",
    usState: "VA",
    email: "booking@parkwaybrewing.com",
    venueType: "PubFestivalBrewery",
    contactName: "Liza Crowder",
  };

  const pitch = renderPitch(venue, weekend, {}, DEFAULT_TEMPLATES);
  assertStringIncludes(pitch.body, "Hi Liza,");
  assertEquals(pitch.body.includes("Hi Liza Crowder,"), false);
  assertEquals(pitch.body.includes("[Contact Name]"), false);
  assertEquals(validateVoiceRules(pitch.body).valid, true);
});

Deno.test("verifyPitchAgainstTemplate: predicts empty contactName as 'Hi,' fallback (#1007)", () => {
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
    _id: "v_empty_contact",
    name: "The Spot on Kirk",
    city: "Roanoke",
    usState: "VA",
    email: "info@thespotonkirk.org",
    venueType: "Originals",
    contactName: "",
  };

  const localPitch = renderPitch(venue, weekend, {}, DEFAULT_TEMPLATES);
  assertStringIncludes(localPitch.htmlBody!, "<p>Hi,</p>");
  assertEquals(localPitch.htmlBody!.includes("[Contact Name]"), false);
  assertEquals(verifyPitchAgainstTemplate(localPitch, venue, weekend, {}, DEFAULT_TEMPLATES), null);
});

Deno.test("renderPitch: formats greeting cleanly when contactName is empty", () => {
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
    _id: "v_unnamed",
    name: "The Spot on Kirk",
    city: "Roanoke",
    usState: "VA",
    email: "info@thespotonkirk.org",
    venueType: "Originals",
  };

  const pitch = renderPitch(venue, weekend, {}, DEFAULT_TEMPLATES);
  assertStringIncludes(pitch.body, "Hi,\n");
  assertEquals(pitch.body.includes("[Contact Name]"), false);
  assertEquals(pitch.body.includes("Hi there,"), false);
  assertEquals(validateVoiceRules(pitch.body).valid, true);
});

// Tests for --link-gig mode (web-jam-tools#898, Decision D-26)

Deno.test("decodeHtmlEntities and normalizeVenueName accurately normalize HTML & punctuation", () => {
  assertEquals(
    decodeHtmlEntities("&quot;Rock &amp; Roll&#39;s &lt;Best&gt;&quot;"),
    '"Rock & Roll\'s <Best>"',
  );
  assertEquals(
    normalizeVenueName('<p><a href="https://example.com">Slow Play &amp; Brewing!</a></p>'),
    "slow play brewing",
  );
  assertEquals(
    normalizeVenueName("The Spot on Kirk (Roanoke, VA)!"),
    "the spot on kirk roanoke va",
  );
  assertEquals(normalizeVenueName(""), "");
  assertEquals(normalizeVenueName(undefined), "");
  assertEquals(normalizeVenueName(null), "");
});

Deno.test("buildUnambiguousNameIndex and resolveGigVenueId index unique venues and resolve gigs", () => {
  const venues = [
    { _id: "v1", name: "The Spot on Kirk" },
    { _id: "v2", name: "Twin Creeks" },
    { _id: "v3", name: "Twin Creeks" }, // duplicate / ambiguous
  ];

  const index = buildUnambiguousNameIndex(venues);
  assertEquals(index.get("the spot on kirk"), "v1");
  assertEquals(index.has("twin creeks"), false); // excluded because ambiguous

  // Gig with venueId already set wins immediately
  assertEquals(resolveGigVenueId({ venueId: "v99", venue: "Any" }, index), "v99");

  // Gig with matching venue name resolves
  assertEquals(
    resolveGigVenueId({ venue: "<p>The Spot on Kirk</p>" }, index),
    "v1",
  );

  // Ambiguous venue name resolves to null
  assertEquals(
    resolveGigVenueId({ venue: "Twin Creeks" }, index),
    null,
  );

  // Unlisted venue resolves to null
  assertEquals(
    resolveGigVenueId({ venue: "Non Existent Place" }, index),
    null,
  );
});

Deno.test("parseBookGigArgs: parses --link-gig mode with various argument patterns", () => {
  const p1 = parseBookGigArgs(["--link-gig", "The Spot on Kirk"]);
  assertEquals(p1.mode, "link-gig");
  assertEquals(p1.linkVenueName, "The Spot on Kirk");

  const p2 = parseBookGigArgs(["--link-gig=Olde Salem Brewing"]);
  assertEquals(p2.mode, "link-gig");
  assertEquals(p2.linkVenueName, "Olde Salem Brewing");

  const p3 = parseBookGigArgs(["--link", "Hamlet Vineyards"]);
  assertEquals(p3.mode, "link-gig");
  assertEquals(p3.linkVenueName, "Hamlet Vineyards");

  const p4 = parseBookGigArgs(["Village Grill", "--link-gig"]);
  assertEquals(p4.mode, "link-gig");
  assertEquals(p4.linkVenueName, "Village Grill");

  const p5 = parseBookGigArgs(["--link-gig"]);
  assertEquals(p5.mode, "link-gig");
  assertEquals(p5.linkVenueName, undefined);
});

Deno.test("executeLinkGig: clean match links gig and issues PATCH /gig/:id", async () => {
  const mockVenues = [{ _id: "v1", name: "The Spot on Kirk" }];
  const mockGigs = [{ _id: "g1", venue: "<p>The Spot on Kirk</p>", venueId: null }];
  const calls: Array<{ url: string; method?: string; body?: string }> = [];

  const mockFetch: typeof fetch = (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    calls.push({ url: u, method, body: init?.body ? String(init.body) : undefined });

    if (u.includes("/venue")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/gig/") && method === "PATCH") {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/gig")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockGigs), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const result = await executeLinkGig("The Spot on Kirk", {}, mockFetch);
  assertEquals(result.status, "linked");
  assertEquals(result.venueId, "v1");
  assertEquals(result.matchedGigId, "g1");
  assertStringIncludes(result.message, "Linked gig");

  const patchCall = calls.find((c) => c.method === "PATCH");
  assertEquals(patchCall !== undefined, true);
  assertStringIncludes(patchCall?.url || "", "/gig/g1");
  assertStringIncludes(patchCall?.body || "", '"venueId":"v1"');
});

Deno.test("executeLinkGig: already-linked gig reports status and makes no write", async () => {
  const mockVenues = [{ _id: "v1", name: "The Spot on Kirk" }];
  const mockGigs = [{ _id: "g1", venue: "The Spot on Kirk", venueId: "v1" }];
  const calls: Array<{ url: string; method?: string }> = [];

  const mockFetch: typeof fetch = (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    calls.push({ url: u, method });

    if (u.includes("/venue")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/gig")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockGigs), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const result = await executeLinkGig("The Spot on Kirk", {}, mockFetch);
  assertEquals(result.status, "already-linked");
  assertStringIncludes(result.message, "already linked");
  assertEquals(calls.some((c) => c.method === "PATCH" || c.method === "PUT"), false);
});

Deno.test("executeLinkGig: gig linked to a different venue reports conflict and makes no write", async () => {
  const mockVenues = [{ _id: "v1", name: "The Spot on Kirk" }];
  const mockGigs = [{ _id: "g1", venue: "The Spot on Kirk", venueId: "v2" }];
  const calls: Array<{ url: string; method?: string }> = [];

  const mockFetch: typeof fetch = (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    calls.push({ url: u, method });

    if (u.includes("/venue")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/gig")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockGigs), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const result = await executeLinkGig("The Spot on Kirk", {}, mockFetch);
  assertEquals(result.status, "conflict");
  assertEquals(result.venueId, "v1");
  assertEquals(result.matchedGigId, "g1");
  assertStringIncludes(result.message, "already linked to a different venue (venueId: v2)");
  assertStringIncludes(result.message, "Refusing to overwrite conflicting link");
  assertEquals(calls.some((c) => c.method === "PATCH" || c.method === "PUT"), false);
});

Deno.test("executeLinkGig: ambiguous matching gigs reports ambiguity and makes no write", async () => {
  const mockVenues = [{ _id: "v1", name: "The Spot on Kirk" }];
  const mockGigs = [
    { _id: "g1", venue: "The Spot on Kirk", venueId: null },
    { _id: "g2", venue: "The Spot on Kirk", venueId: null },
  ];
  const calls: Array<{ url: string; method?: string }> = [];

  const mockFetch: typeof fetch = (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    calls.push({ url: u, method });

    if (u.includes("/venue")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/gig")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockGigs), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const result = await executeLinkGig("The Spot on Kirk", {}, mockFetch);
  assertEquals(result.status, "ambiguous");
  assertStringIncludes(result.message, "Ambiguous match");
  assertEquals(calls.some((c) => c.method === "PATCH" || c.method === "PUT"), false);
});

Deno.test("executeLinkGig: no matching gig reports no-match and makes no write", async () => {
  const mockVenues = [{ _id: "v1", name: "The Spot on Kirk" }];
  const mockGigs = [{ _id: "g1", venue: "Different Venue", venueId: null }];
  const calls: Array<{ url: string; method?: string }> = [];

  const mockFetch: typeof fetch = (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    calls.push({ url: u, method });

    if (u.includes("/venue")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/gig")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockGigs), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const result = await executeLinkGig("The Spot on Kirk", {}, mockFetch);
  assertEquals(result.status, "no-match");
  assertStringIncludes(result.message, "No matching gig found");
  assertEquals(calls.some((c) => c.method === "PATCH" || c.method === "PUT"), false);
});

Deno.test("executeLinkGig: unknown venue reports venue-not-found", async () => {
  const mockVenues = [{ _id: "v1", name: "The Spot on Kirk" }];
  const mockFetch: typeof fetch = (url) => {
    if (String(url).includes("/venue")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("[]", { status: 200 }));
  };

  const result = await executeLinkGig("Non Existent Venue", {}, mockFetch);
  assertEquals(result.status, "venue-not-found");
  assertStringIncludes(result.message, "not found in venue database");
});

Deno.test("runBookGigCli: executes --link-gig mode cleanly and handles missing venue name", async () => {
  const mockVenues = [{ _id: "v1", name: "Olde Salem Brewing" }];
  const mockGigs = [{ _id: "g1", venue: "Olde Salem Brewing", venueId: null }];

  const mockFetch: typeof fetch = (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    if (u.includes("/venue")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/gig/") && method === "PATCH") {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/gig")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockGigs), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  // Successful run
  const res = await runBookGigCli(["--link-gig", "Olde Salem Brewing"], mockFetch);
  assertEquals(res.mode, "link-gig");
  assertEquals(res.linkGig?.status, "linked");
  assertEquals(res.linkGig?.venueId, "v1");

  // Missing venue name throws error
  await assertRejects(
    async () => {
      await runBookGigCli(["--link-gig"], mockFetch);
    },
    Error,
    "Missing venue name for --link-gig",
  );
});

Deno.test("formatMonthYear & formatMonthDay: correctly formats dates for badges", () => {
  assertEquals(formatMonthYear("2027-01-01"), "Jan 2027");
  assertEquals(formatMonthYear("2027-01-15T00:00:00.000Z"), "Jan 2027");
  assertEquals(formatMonthYear(new Date("2027-01-01T00:00:00.000Z")), "Jan 2027");
  assertEquals(formatMonthYear("Jan 2027"), "Jan 2027");

  assertEquals(formatMonthDay("2026-11-20"), "Nov 20");
  assertEquals(formatMonthDay("2026-11-20T00:00:00.000Z"), "Nov 20");
  assertEquals(formatMonthDay(new Date("2026-11-20T00:00:00.000Z")), "Nov 20");
  assertEquals(formatMonthDay("Nov 20"), "Nov 20");
  assertEquals(formatMonthDay("Sent Oct 10"), "Oct 10");
  assertEquals(formatMonthDay("2026-10-10"), "Oct 10");
});

Deno.test("identifyCandidateBadge: identifies Seasonal Hold for future resumeBooking (#879)", () => {
  const refDate = new Date("2026-10-01T00:00:00.000Z");

  const venue: CandidateVenue = {
    _id: "v1",
    name: "Olde Salem Brewery",
    resumeBooking: "2027-01-01",
  };

  const badge = identifyCandidateBadge(venue, refDate);
  assertEquals(badge.badge, "[Seasonal Hold: Jan 2027]");
  assertEquals(badge.cssClass, "badge-seasonal-hold");
  assertEquals(badge.isExcluded, true);

  // Fallback to bookedThrough
  const venueBt: CandidateVenue = {
    _id: "v2",
    name: "Wintergreen Resort",
    bookedThrough: "2027-02-15",
  };
  const badgeBt = identifyCandidateBadge(venueBt, refDate);
  assertEquals(badgeBt.badge, "[Seasonal Hold: Feb 2027]");
  assertEquals(badgeBt.cssClass, "badge-seasonal-hold");
  assertEquals(badgeBt.isExcluded, true);
});

Deno.test("identifyCandidateBadge: identifies Gig Spacing exclusion for ±2 month window (#879)", () => {
  const refDate = new Date("2026-10-01T00:00:00.000Z");

  const venue: CandidateVenue = {
    _id: "v1",
    name: "Parkway Brewing",
    conflictingGigDate: "2026-11-20",
  };

  const badge = identifyCandidateBadge(venue, refDate);
  assertEquals(badge.badge, "[Gig Spacing: Nov 20 Show]");
  assertEquals(badge.cssClass, "badge-gig-spacing");
  assertEquals(badge.isExcluded, true);

  // Via reason spacingNote
  const venueNote: CandidateVenue = {
    _id: "v2",
    name: "Starr Hill Brewery",
    reason: { spacingNote: "Gig on 2026-09-15 Show" },
  };
  const badgeNote = identifyCandidateBadge(venueNote, refDate);
  assertEquals(badgeNote.badge, "[Gig Spacing: Sep 15 Show]");
  assertEquals(badgeNote.cssClass, "badge-gig-spacing");
  assertEquals(badgeNote.isExcluded, true);
});

Deno.test("identifyCandidateBadge: identifies Direct Chat Active for outreachEligible: false with notes (#879)", () => {
  const refDate = new Date("2026-10-01T00:00:00.000Z");

  const venue: CandidateVenue = {
    _id: "v1",
    name: "The Glass House",
    outreachEligible: false,
    notes: "Direct phone conversation with booking manager on Monday",
  };

  const badge = identifyCandidateBadge(venue, refDate);
  assertEquals(badge.badge, "[Direct Chat Active]");
  assertEquals(badge.cssClass, "badge-direct-chat");
  assertEquals(badge.isExcluded, true);

  const venuePrior: CandidateVenue = {
    _id: "v2",
    name: "Riverviews Artspace",
    outreachEligible: false,
    notes: "Chatting directly about holiday showcase",
  };
  const badgePrior = identifyCandidateBadge(venuePrior, refDate);
  assertEquals(badgePrior.badge, "[Direct Chat Active]");
  assertEquals(badgePrior.cssClass, "badge-direct-chat");
  assertEquals(badgePrior.isExcluded, true);
});

Deno.test("identifyCandidateBadge: unvetted or declined venue with outreachEligible: false and no direct chat notes is NOT badged [Direct Chat Active] (#879)", () => {
  const refDate = new Date("2026-10-01T00:00:00.000Z");

  const unvettedVenue: CandidateVenue = {
    _id: "v-unvetted",
    name: "Unvetted Bar & Grill",
    outreachEligible: false,
    notes: "Needs liquor license verification before booking",
  };
  const badgeUnvetted = identifyCandidateBadge(unvettedVenue, refDate);
  assertNotEquals(badgeUnvetted.badge, "[Direct Chat Active]");
  assertNotEquals(badgeUnvetted.cssClass, "badge-direct-chat");

  const declinedVenue: CandidateVenue = {
    _id: "v-declined",
    name: "Declined Lounge",
    outreachEligible: false,
    notes: "Permanently declined live music events",
  };
  const badgeDeclined = identifyCandidateBadge(declinedVenue, refDate);
  assertNotEquals(badgeDeclined.badge, "[Direct Chat Active]");
  assertNotEquals(badgeDeclined.cssClass, "badge-direct-chat");

  const emptyNotesVenue: CandidateVenue = {
    _id: "v-empty",
    name: "Blank Notes Pub",
    outreachEligible: false,
  };
  const badgeEmpty = identifyCandidateBadge(emptyNotesVenue, refDate);
  assertNotEquals(badgeEmpty.badge, "[Direct Chat Active]");
  assertNotEquals(badgeEmpty.cssClass, "badge-direct-chat");
});

Deno.test("identifyCandidateBadge: identifies Cooldown Active for replied pitches within 7 days (#879)", () => {
  const refDate = new Date("2026-10-15T00:00:00.000Z");

  const venue: CandidateVenue = {
    _id: "v-replied",
    name: "Harvester Performance Center",
    cooldownRepliedDate: "2026-10-12",
  };

  const badge = identifyCandidateBadge(venue, refDate);
  assertEquals(badge.badge, "[Cooldown Active: Replied Oct 12]");
  assertEquals(badge.cssClass, "badge-cooldown");
  assertEquals(badge.isExcluded, true);
});

Deno.test("identifyCandidateBadge: identifies Cooldown Active for pitches sent within 7 days (#879)", () => {
  const refDate = new Date("2026-10-15T00:00:00.000Z");

  // Pitched on Oct 10 (5 days ago, within 7-day cooldown)
  const venue: CandidateVenue = {
    _id: "v1",
    name: "Harvester Performance Center",
    cooldownSentDate: "2026-10-10",
  };

  const badge = identifyCandidateBadge(venue, refDate);
  assertEquals(badge.badge, "[Cooldown Active: Sent Oct 10]");
  assertEquals(badge.cssClass, "badge-cooldown");
  assertEquals(badge.isExcluded, true);

  // Via sentAt
  const venueSentAt: CandidateVenue = {
    _id: "v2",
    name: "5 Points Music Sanctuary",
    sentAt: "2026-10-12T10:00:00.000Z",
  };
  const badgeSentAt = identifyCandidateBadge(venueSentAt, refDate);
  assertEquals(badgeSentAt.badge, "[Cooldown Active: Sent Oct 12]");
  assertEquals(badgeSentAt.cssClass, "badge-cooldown");
  assertEquals(badgeSentAt.isExcluded, true);
});

Deno.test("identifyCandidateBadge: handles eligible returning and new venues (#879)", () => {
  const refDate = new Date("2026-10-01T00:00:00.000Z");

  const returningVenue: CandidateVenue = {
    _id: "v1",
    name: "Olde Salem Brewing",
    reason: { lastGigDate: "2026-06-15" },
  };
  const badgeReturning = identifyCandidateBadge(returningVenue, refDate);
  assertEquals(badgeReturning.badge, "Returning · Last: Jun 15");
  assertEquals(badgeReturning.cssClass, "badge-returning");
  assertEquals(badgeReturning.isExcluded, false);

  const priorYearVenue: CandidateVenue = {
    _id: "v-prior",
    name: "Parkway Brewing",
    reason: { lastGigDate: "2019-11-17T05:00:00.000Z" },
  };
  const badgePrior = identifyCandidateBadge(priorYearVenue, refDate);
  assertEquals(badgePrior.badge, "Returning · Last: Nov 17, 2019");
  assertEquals(badgePrior.cssClass, "badge-returning");
  assertEquals(badgePrior.isExcluded, false);

  const newVenue: CandidateVenue = {
    _id: "v2",
    name: "Brand New Brewery",
    reason: {},
  };
  const badgeNew = identifyCandidateBadge(newVenue, refDate);
  assertEquals(badgeNew.badge, "New");
  assertEquals(badgeNew.cssClass, "badge-eligible");
  assertEquals(badgeNew.isExcluded, false);

  // Real backend candidate with resumeBookingExpired: false must NOT be marked as on hold
  const realCandidate: CandidateVenue = {
    _id: "v3",
    name: "Normal Active Venue",
    city: "Roanoke",
    usState: "VA",
    reason: {
      lastGigDate: null,
      gigIntervalMonths: 2,
      nearestGigMonthsAway: null,
      spacingNote: "no gigs yet",
      resumeBookingExpired: false,
    },
  };
  const realBadge = identifyCandidateBadge(realCandidate, refDate);
  assertEquals(realBadge.badge, "no gigs yet");
  assertEquals(realBadge.cssClass, "badge-eligible");
  assertEquals(realBadge.isExcluded, false);

  // Venue where past hold has expired is eligible
  const expiredHoldCandidate: CandidateVenue = {
    _id: "v4",
    name: "Past Hold Venue",
    city: "Roanoke",
    usState: "VA",
    reason: {
      lastGigDate: null,
      gigIntervalMonths: 2,
      nearestGigMonthsAway: null,
      spacingNote: "clear — nearest gig ~3.5 mo away",
      resumeBookingExpired: true,
    },
  };
  const expiredBadge = identifyCandidateBadge(expiredHoldCandidate, refDate);
  assertEquals(expiredBadge.badge, "clear — nearest gig ~3.5 mo away");
  assertEquals(expiredBadge.cssClass, "badge-eligible");
  assertEquals(expiredBadge.isExcluded, false);
});

Deno.test("filterAndRankCandidates: populates granular status badges and reasoning on candidate venues (#879)", () => {
  const refDate = new Date("2026-10-01T00:00:00.000Z");
  const candidates: CandidateVenue[] = [
    {
      _id: "v1",
      name: "Olde Salem Brewery",
      city: "Salem",
      usState: "VA",
      resumeBooking: "2027-01-01",
    },
    {
      _id: "v2",
      name: "Parkway Brewing",
      city: "Salem",
      usState: "VA",
      conflictingGigDate: "2026-11-20",
    },
    {
      _id: "v3",
      name: "Direct Chat Taphouse",
      city: "Salem",
      usState: "VA",
      outreachEligible: false,
      notes: "Spoke with owner directly",
    },
    {
      _id: "v4",
      name: "Cooldown Tavern",
      city: "Salem",
      usState: "VA",
      cooldownSentDate: "2026-09-28",
    },
    {
      _id: "v5",
      name: "Eligible Returning Spot",
      city: "Salem",
      usState: "VA",
      email: "spot@salem.com",
      reason: { lastGigDate: "2026-06-15" },
    },
    {
      _id: "v6",
      name: "Fresh New Venue",
      city: "Salem",
      usState: "VA",
      email: "fresh@salem.com",
      reason: {},
    },
    {
      _id: "v7",
      name: "No Email Spot",
      city: "Salem",
      usState: "VA",
      email: "",
    },
  ];

  const loc = parseLocation("Salem, VA")!;
  const filtered = filterAndRankCandidates(candidates, loc, { referenceDate: refDate });

  assertEquals(filtered.length, 7);

  const hold = filtered.find((v) => v._id === "v1")!;
  assertEquals(hold.statusBadge, "[Seasonal Hold: Jan 2027]");
  assertEquals(hold.isExcluded, true);
  assertEquals(hold.reason?.exclusionReason, "[Seasonal Hold: Jan 2027]");

  const spacing = filtered.find((v) => v._id === "v2")!;
  assertEquals(spacing.statusBadge, "[Gig Spacing: Nov 20 Show]");
  assertEquals(spacing.isExcluded, true);
  assertEquals(spacing.reason?.exclusionReason, "[Gig Spacing: Nov 20 Show]");

  const chat = filtered.find((v) => v._id === "v3")!;
  assertEquals(chat.statusBadge, "[Direct Chat Active]");
  assertEquals(chat.isExcluded, true);
  assertEquals(chat.reason?.exclusionReason, "[Direct Chat Active]");

  const cooldown = filtered.find((v) => v._id === "v4")!;
  assertEquals(cooldown.statusBadge, "[Cooldown Active: Sent Sep 28]");
  assertEquals(cooldown.isExcluded, true);

  const returning = filtered.find((v) => v._id === "v5")!;
  assertEquals(returning.statusBadge, "Returning · Last: Jun 15");
  assertEquals(returning.isExcluded, false);

  const fresh = filtered.find((v) => v._id === "v6")!;
  assertEquals(fresh.statusBadge, "New");
  assertEquals(fresh.isExcluded, false);

  const noEmail = filtered.find((v) => v._id === "v7")!;
  assertEquals(noEmail.statusBadge, "[No Booking Email]");
  assertEquals(noEmail.isExcluded, true);
  assertEquals(noEmail.exclusionReason, "no-booking-email");
});

Deno.test("filterAndRankCandidates: does not mutate input candidate objects and preserves spacingNote (#879)", () => {
  const refDate = new Date("2026-10-01T00:00:00.000Z");
  const originalCandidate: CandidateVenue = {
    _id: "v100",
    name: "Unmutated Venue",
    city: "Salem",
    usState: "VA",
    email: "unmutated@venue.com",
    reason: {
      lastGigDate: null,
      gigIntervalMonths: 2,
      nearestGigMonthsAway: null,
      spacingNote: "no gigs yet",
      resumeBookingExpired: false,
    },
  };

  const loc = parseLocation("Salem, VA")!;
  const candidates = [originalCandidate];
  const filtered = filterAndRankCandidates(candidates, loc, { referenceDate: refDate });

  // Input candidate object was not mutated
  assertEquals(originalCandidate.statusBadge, undefined);
  assertEquals(originalCandidate.isExcluded, undefined);
  assertEquals(originalCandidate.reason?.spacingNote, "no gigs yet");
  assertEquals(originalCandidate.reason?.statusBadge, undefined);

  // Filtered candidate receives statusBadge and preserves spacingNote
  assertEquals(filtered[0].statusBadge, "no gigs yet");
  assertEquals(filtered[0].isExcluded, false);
  assertEquals(filtered[0].reason?.spacingNote, "no gigs yet");

  // Re-running is idempotent
  const secondPass = filterAndRankCandidates(candidates, loc, { referenceDate: refDate });
  assertEquals(secondPass[0].statusBadge, "no gigs yet");
  assertEquals(secondPass[0].isExcluded, false);
});

Deno.test("renderCandidateTable & renderDarkHtml: surfaces granular badges in terminal and HTML artifacts (#879)", () => {
  const refDate = new Date("2026-10-01T00:00:00.000Z");
  const candidates: CandidateVenue[] = [
    {
      _id: "v1",
      name: "Olde Salem Brewery",
      city: "Salem",
      usState: "VA",
      email: "booking@oldesalem.com",
      resumeBooking: "2027-01-01",
    },
    {
      _id: "v2",
      name: "Parkway Brewing",
      city: "Salem",
      usState: "VA",
      email: "info@parkway.com",
      conflictingGigDate: "2026-11-20",
    },
    {
      _id: "v3",
      name: "Direct Chat Taphouse",
      city: "Salem",
      usState: "VA",
      email: "chat@taphouse.com",
      outreachEligible: false,
      notes: "Spoke with owner directly",
    },
    {
      _id: "v4",
      name: "Cooldown Tavern",
      city: "Salem",
      usState: "VA",
      email: "info@cooldown.com",
      cooldownSentDate: "2026-09-28",
    },
  ];

  // 1. Terminal candidate table (uncolored check)
  const terminalPlain = renderCandidateTable(candidates, { color: false, referenceDate: refDate });
  assertStringIncludes(terminalPlain, "Spacing Status");
  assertStringIncludes(terminalPlain, "[Seasonal Hold: Jan 2027]");
  assertStringIncludes(terminalPlain, "[Gig Spacing: Nov 20 Show]");
  assertStringIncludes(terminalPlain, "[Direct Chat Active]");
  assertStringIncludes(terminalPlain, "[Cooldown Active: Sent Sep 28]");

  // 2. Terminal candidate table (colored check)
  const terminalColored = renderCandidateTable(candidates, { color: true, referenceDate: refDate });
  assertStringIncludes(terminalColored, "[Seasonal Hold: Jan 2027]");
  assertStringIncludes(terminalColored, "\x1b[36m"); // Cyan
  assertStringIncludes(terminalColored, "[Gig Spacing: Nov 20 Show]");
  assertStringIncludes(terminalColored, "\x1b[31m"); // Red
  assertStringIncludes(terminalColored, "[Direct Chat Active]");
  assertStringIncludes(terminalColored, "\x1b[35m"); // Magenta
  assertStringIncludes(terminalColored, "[Cooldown Active: Sent Sep 28]");
  assertStringIncludes(terminalColored, "\x1b[34m"); // Blue

  // Empty table check
  const emptyTable = renderCandidateTable([]);
  assertEquals(emptyTable, "  (No eligible venues found matching criteria)");

  // 3. HTML artifact
  const result: BookGigResult = {
    mode: "preview",
    weekend: {
      start: "2026-10-16",
      end: "2026-10-18",
      rawText: "Oct 16-18 2026",
      label: "October 16–18, 2026",
      year: 2026,
      month: 10,
      days: [16, 17, 18],
    },
    candidates,
    density: { count: 4, isSparse: false },
    pitches: [],
  };

  const html = renderDarkHtml(result);

  // Status badges and CSS classes in HTML
  assertStringIncludes(html, "badge-seasonal-hold");
  assertStringIncludes(html, "[Seasonal Hold: Jan 2027]");
  assertStringIncludes(html, "badge-gig-spacing");
  assertStringIncludes(html, "[Gig Spacing: Nov 20 Show]");
  assertStringIncludes(html, "badge-direct-chat");
  assertStringIncludes(html, "[Direct Chat Active]");
  assertStringIncludes(html, "badge-cooldown");
  assertStringIncludes(html, "[Cooldown Active: Sent Sep 28]");
});

Deno.test("fetchCandidates: surfaces held, spacing-conflict, direct-chat, and cooldown venues alongside genuine /outreach/candidates response", async () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  // Genuine shape of /outreach/candidates response from web-jam-back buildCandidateReason
  const genuineCandidatesResponse = {
    candidates: [
      {
        _id: "venue-eligible-returning",
        name: "Twin Creeks Brewing",
        city: "Salem",
        usState: "VA",
        email: "booking@twincreeks.com",
        outreachEligible: true,
        reason: {
          lastGigDate: "2026-06-15T22:00:00.000Z",
          gigIntervalMonths: 2,
          nearestGigMonthsAway: 4.1,
          spacingNote: "clear — nearest gig ~4.1 mo away",
          resumeBookingExpired: false,
        },
      },
      {
        _id: "venue-eligible-new",
        name: "Big Lick Brewing Company",
        city: "Salem",
        usState: "VA",
        email: "info@biglick.com",
        outreachEligible: true,
        reason: {
          lastGigDate: null,
          gigIntervalMonths: 2,
          nearestGigMonthsAway: null,
          spacingNote: "no gigs yet",
          resumeBookingExpired: false,
        },
      },
    ],
    weekendGigs: [],
  };

  // Venues returned by GET /venue, including venues in seasonal hold, direct-chat, and gig-spacing conflict
  const allVenuesResponse = [
    {
      _id: "venue-eligible-returning",
      name: "Twin Creeks Brewing",
      city: "Salem",
      usState: "VA",
      email: "booking@twincreeks.com",
      outreachEligible: true,
    },
    {
      _id: "venue-eligible-new",
      name: "Big Lick Brewing Company",
      city: "Salem",
      usState: "VA",
      email: "info@biglick.com",
      outreachEligible: true,
    },
    {
      _id: "venue-seasonal-hold",
      name: "Olde Salem Brewery",
      city: "Salem",
      usState: "VA",
      email: "booking@oldesalem.com",
      outreachEligible: true,
      resumeBooking: "2027-01-01T00:00:00.000Z",
      bookedThrough: "2026-12-31T23:59:59.999Z",
    },
    {
      _id: "venue-direct-chat",
      name: "Direct Chat Lounge",
      city: "Salem",
      usState: "VA",
      email: "direct@lounge.com",
      outreachEligible: false,
      notes: "Spoke directly with booking manager",
    },
    {
      _id: "venue-unvetted",
      name: "Unvetted Dive Bar",
      city: "Salem",
      usState: "VA",
      email: "dive@bar.com",
      outreachEligible: false,
      notes: "Pending review of booking guidelines",
    },
    {
      _id: "venue-gig-spacing",
      name: "Parkway Brewing",
      city: "Salem",
      usState: "VA",
      email: "info@parkway.com",
      outreachEligible: true,
      gigInterval: 2,
      lastGig: {
        datetime: "2026-11-20T20:00:00.000Z",
        city: "Salem",
        usState: "VA",
      },
    },
    {
      _id: "venue-cooldown",
      name: "Cooldown Taphouse",
      city: "Salem",
      usState: "VA",
      email: "tap@cooldown.com",
      outreachEligible: true,
    },
    {
      _id: "venue-cooldown-replied",
      name: "Replied Brewery",
      city: "Salem",
      usState: "VA",
      email: "replied@brewery.com",
      outreachEligible: true,
    },
  ];

  // Active outreach campaigns returned by GET /outreach?status=sent and GET /outreach?status=replied
  const activeSentCampaignsResponse = [
    {
      _id: "camp-1",
      venueId: "venue-cooldown",
      sentAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
      targetDates: "2026-10-16 to 2026-10-18",
      targetWeekend: {
        start: "2026-10-16",
        end: "2026-10-18",
      },
      status: "sent",
    },
  ];

  const activeRepliedCampaignsResponse = [
    {
      _id: "camp-replied-1",
      venueId: "venue-cooldown-replied",
      sentAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
      repliedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(), // 1 day ago
      targetDates: "2026-10-16 to 2026-10-18",
      targetWeekend: {
        start: "2026-10-16",
        end: "2026-10-18",
      },
      status: "replied",
    },
  ];

  const mockFetch: typeof fetch = (url: string | URL | Request) => {
    const urlStr = String(url);
    if (urlStr.includes("/outreach/candidates")) {
      return Promise.resolve(
        new Response(JSON.stringify(genuineCandidatesResponse), { status: 200 }),
      );
    }
    if (urlStr.includes("/venue")) {
      return Promise.resolve(new Response(JSON.stringify(allVenuesResponse), { status: 200 }));
    }
    if (urlStr.includes("/outreach?status=sent")) {
      return Promise.resolve(
        new Response(JSON.stringify(activeSentCampaignsResponse), { status: 200 }),
      );
    }
    if (urlStr.includes("/outreach?status=replied")) {
      return Promise.resolve(
        new Response(JSON.stringify(activeRepliedCampaignsResponse), { status: 200 }),
      );
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };

  const candidates = await fetchCandidates(
    { weekend, backendUrl: "https://test.local", token: "test-token" },
    mockFetch,
  );

  // Verify all candidates are returned (unvetted venue with no direct chat notes is excluded from pool)
  assertEquals(candidates.length, 7);
  assertEquals(candidates.find((c) => c._id === "venue-unvetted"), undefined);

  // 1. Returning eligible venue
  const returning = candidates.find((c) => c._id === "venue-eligible-returning");
  assert(returning !== undefined);
  assertEquals(returning.isExcluded, false);
  const returningBadge = identifyCandidateBadge(returning);
  assertEquals(returningBadge.badge, "Returning · Last: Jun 15");
  assertEquals(returningBadge.cssClass, "badge-returning");
  assertEquals(returningBadge.isExcluded, false);

  // 2. New eligible venue
  const newVenue = candidates.find((c) => c._id === "venue-eligible-new");
  assert(newVenue !== undefined);
  assertEquals(newVenue.isExcluded, false);
  const newBadge = identifyCandidateBadge(newVenue);
  assertEquals(newBadge.badge, "no gigs yet");
  assertEquals(newBadge.cssClass, "badge-eligible");
  assertEquals(newBadge.isExcluded, false);

  // 3. Seasonal Hold venue
  const seasonalHold = candidates.find((c) => c._id === "venue-seasonal-hold");
  assert(seasonalHold !== undefined);
  assertEquals(seasonalHold.isExcluded, true);
  const seasonalBadge = identifyCandidateBadge(seasonalHold);
  assertStringIncludes(seasonalBadge.badge, "[Seasonal Hold: Jan 2027]");
  assertEquals(seasonalBadge.cssClass, "badge-seasonal-hold");
  assertEquals(seasonalBadge.isExcluded, true);

  // 4. Direct Chat Active venue
  const directChat = candidates.find((c) => c._id === "venue-direct-chat");
  assert(directChat !== undefined);
  assertEquals(directChat.isExcluded, true);
  const directChatBadge = identifyCandidateBadge(directChat);
  assertEquals(directChatBadge.badge, "[Direct Chat Active]");
  assertEquals(directChatBadge.cssClass, "badge-direct-chat");
  assertEquals(directChatBadge.isExcluded, true);

  // 5. Gig Spacing Conflict venue
  const gigSpacing = candidates.find((c) => c._id === "venue-gig-spacing");
  assert(gigSpacing !== undefined);
  assertEquals(gigSpacing.isExcluded, true);
  const gigSpacingBadge = identifyCandidateBadge(gigSpacing);
  assertEquals(gigSpacingBadge.badge, "[Gig Spacing: Nov 20 Show]");
  assertEquals(gigSpacingBadge.cssClass, "badge-gig-spacing");
  assertEquals(gigSpacingBadge.isExcluded, true);

  // 6. Cooldown Active venue (status=sent)
  const cooldown = candidates.find((c) => c._id === "venue-cooldown");
  assert(cooldown !== undefined);
  assertEquals(cooldown.isExcluded, true);
  const cooldownBadge = identifyCandidateBadge(cooldown);
  assertStringIncludes(cooldownBadge.badge, "[Cooldown Active: Sent");
  assertEquals(cooldownBadge.cssClass, "badge-cooldown");
  assertEquals(cooldownBadge.isExcluded, true);

  // 7. Cooldown Active venue (status=replied)
  const cooldownReplied = candidates.find((c) => c._id === "venue-cooldown-replied");
  assert(cooldownReplied !== undefined);
  assertEquals(cooldownReplied.isExcluded, true);
  const cooldownRepliedBadge = identifyCandidateBadge(cooldownReplied);
  assertStringIncludes(cooldownRepliedBadge.badge, "[Cooldown Active: Replied");
  assertEquals(cooldownRepliedBadge.cssClass, "badge-cooldown");
  assertEquals(cooldownRepliedBadge.isExcluded, true);

  // Verify renderCandidateTable displays all 4 badge states
  const renderedTable = renderCandidateTable(candidates, { color: false });
  assertStringIncludes(renderedTable, "Returning · Last: Jun 15");
  assertStringIncludes(renderedTable, "no gigs yet");
  assertStringIncludes(renderedTable, "[Seasonal Hold: Jan 2027]");
  assertStringIncludes(renderedTable, "[Direct Chat Active]");
  assertStringIncludes(renderedTable, "[Gig Spacing: Nov 20 Show]");
  assertStringIncludes(renderedTable, "[Cooldown Active: Sent");
  assertStringIncludes(renderedTable, "[Cooldown Active: Replied");

  // Verify assessDensity counts ONLY the 2 eligible candidates
  const density = assessDensity(candidates);
  assertEquals(density.count, 2);
  assertEquals(density.isSparse, true); // threshold is 3
});

Deno.test("fetchCandidates: gig spacing uses calendar-month arithmetic matching backend isTooCloseToWindow (#879)", async () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  // Weekend start: 2026-10-16. With 2 months spacing:
  // Lower bound: setMonth(9 - 2) = August 16, 2026.
  // Upper bound: setMonth(9 + 2) = December 16, 2026.
  // Conflicting rule: gTime > lower && gTime < upper.
  const venuesResponse = [
    {
      _id: "venue-spacing-exact-boundary",
      name: "Boundary Venue",
      city: "Salem",
      usState: "VA",
      email: "boundary@venue.com",
      outreachEligible: true,
      gigInterval: 2,
      lastGig: {
        datetime: "2026-08-16T00:00:00.000Z",
      },
    },
    {
      _id: "venue-spacing-conflict",
      name: "Conflict Venue",
      city: "Salem",
      usState: "VA",
      email: "conflict@venue.com",
      outreachEligible: true,
      gigInterval: 2,
      lastGig: {
        datetime: "2026-08-20T00:00:00.000Z",
      },
    },
  ];

  const mockFetch: typeof fetch = (url: string | URL | Request) => {
    const urlStr = String(url);
    if (urlStr.includes("/outreach/candidates")) {
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }
    if (urlStr.includes("/venue")) {
      return Promise.resolve(new Response(JSON.stringify(venuesResponse), { status: 200 }));
    }
    if (urlStr.includes("/outreach")) {
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };

  const candidates = await fetchCandidates(
    { weekend, backendUrl: "https://test.local", token: "test-token" },
    mockFetch,
  );

  // Aug 20 is strictly within 2 months -> conflicting
  const conflict = candidates.find((c) => c._id === "venue-spacing-conflict");
  assert(conflict !== undefined);
  assertEquals(conflict.isExcluded, true);
  assertEquals(conflict.exclusionReason, "gig-spacing");

  // Aug 16 is on the boundary (not strictly greater than lower bound) -> not conflicting
  const boundary = candidates.find((c) => c._id === "venue-spacing-exact-boundary");
  assertEquals(boundary, undefined);
});

Deno.test("isPitchableCandidate: accurately identifies pitchable venues vs excluded / missing contact (#983)", () => {
  // 1. Valid pitchable venue
  const validVenue: CandidateVenue = {
    _id: "v-valid",
    name: "Valid Brewery",
    email: "booking@validbrewery.com",
    isExcluded: false,
  };
  assertEquals(isPitchableCandidate(validVenue), true);

  // 2. Pitchable venue with undefined isExcluded
  const validUndefinedExcluded = {
    _id: "v-undef",
    name: "Undefined Excluded",
    email: "info@undef.com",
  };
  assertEquals(isPitchableCandidate(validUndefinedExcluded), true);

  // 3. Excluded venue (e.g. seasonal hold, spacing, direct chat)
  const excludedVenue: CandidateVenue = {
    _id: "v-excluded",
    name: "Held Venue",
    email: "held@venue.com",
    isExcluded: true,
  };
  assertEquals(isPitchableCandidate(excludedVenue), false);

  // 4. Missing email (empty string)
  const emptyEmailVenue: CandidateVenue = {
    _id: "v-no-email",
    name: "No Email Venue",
    email: "",
    isExcluded: false,
  };
  assertEquals(isPitchableCandidate(emptyEmailVenue), false);

  // 5. Undefined email
  const undefinedEmailVenue = {
    _id: "v-undef-email",
    name: "Undef Email Venue",
    isExcluded: false,
  };
  assertEquals(isPitchableCandidate(undefinedEmailVenue), false);

  // 6. Venue with email and not excluded, but lacking _id (critical requirement from #983)
  const missingIdVenue = {
    name: "Missing ID Venue",
    email: "noid@venue.com",
    isExcluded: false,
  };
  assertEquals(isPitchableCandidate(missingIdVenue), false);

  // 7. Venue with empty _id
  const emptyIdVenue = {
    _id: "",
    name: "Empty ID Venue",
    email: "emptyid@venue.com",
    isExcluded: false,
  };
  assertEquals(isPitchableCandidate(emptyIdVenue), false);
});

Deno.test("renderCandidateTable & partition: separates active eligible candidates from held/excluded venues (#983)", () => {
  const refDate = new Date("2026-10-01T00:00:00.000Z");
  const candidates: CandidateVenue[] = [
    {
      _id: "v1",
      name: "Eligible Brewery",
      city: "Salem",
      usState: "VA",
      email: "booking@eligible.com",
      isExcluded: false,
    },
    {
      _id: "v2",
      name: "Seasonal Hold Farm",
      city: "Blacksburg",
      usState: "VA",
      email: "farm@outside.com",
      resumeBooking: "2027-03-01",
      isExcluded: true,
      exclusionReason: "seasonal-hold",
    },
    {
      _id: "v3",
      name: "Gig Spacing Tavern",
      city: "Roanoke",
      usState: "VA",
      email: "tavern@spacing.com",
      conflictingGigDate: "2026-11-15",
      isExcluded: true,
      exclusionReason: "gig-spacing",
    },
    {
      _id: "v4",
      name: "Direct Chat Market",
      city: "Salem",
      usState: "VA",
      email: "market@chat.com",
      outreachEligible: false,
      isExcluded: true,
      exclusionReason: "direct-chat",
    },
    // Venue carrying email but no _id
    {
      _id: "",
      name: "Unidentified Cafe",
      city: "Salem",
      usState: "VA",
      email: "coffee@unidentified.com",
      isExcluded: false,
    },
  ];

  // Partition candidates using the shared helper
  const pitchable = candidates.filter(isPitchableCandidate);
  const excluded = candidates.filter((c) => !isPitchableCandidate(c));

  assertEquals(pitchable.length, 1);
  assertEquals(pitchable[0].name, "Eligible Brewery");

  assertEquals(excluded.length, 4);
  assert(excluded.some((c) => c.name === "Seasonal Hold Farm"));
  assert(excluded.some((c) => c.name === "Gig Spacing Tavern"));
  assert(excluded.some((c) => c.name === "Direct Chat Market"));
  assert(excluded.some((c) => c.name === "Unidentified Cafe"));

  // Primary table renders only pitchable candidates
  const primaryTable = renderCandidateTable(pitchable, { color: false, referenceDate: refDate });
  assertStringIncludes(primaryTable, "Eligible Brewery");
  assert(
    !primaryTable.includes("Seasonal Hold Farm"),
    "Seasonal hold must not be in primary table",
  );
  assert(!primaryTable.includes("Gig Spacing Tavern"), "Gig spacing must not be in primary table");
  assert(!primaryTable.includes("Direct Chat Market"), "Direct chat must not be in primary table");
  assert(
    !primaryTable.includes("Unidentified Cafe"),
    "Venue without _id must not be in primary table",
  );

  // Secondary table renders excluded candidates
  const secondaryTable = renderCandidateTable(excluded, { color: false, referenceDate: refDate });
  assert(
    !secondaryTable.includes("Eligible Brewery"),
    "Eligible venue must not be in secondary table",
  );
  assertStringIncludes(secondaryTable, "Seasonal Hold Farm");
  assertStringIncludes(secondaryTable, "Gig Spacing Tavern");
  assertStringIncludes(secondaryTable, "Direct Chat Market");
  assertStringIncludes(secondaryTable, "Unidentified Cafe");
});

Deno.test("runBookGigCli: logs evaluated vs pitchable discovery counts and prints partitioned tables (#983)", async () => {
  const loggedLines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    loggedLines.push(args.map(String).join(" "));
  };

  const mockVenues: CandidateVenue[] = [
    {
      _id: "v1",
      name: "Eligible Brewery",
      city: "Salem",
      usState: "VA",
      email: "booking@eligible.com",
      isExcluded: false,
    },
    {
      _id: "v2",
      name: "Seasonal Hold Farm",
      city: "Salem",
      usState: "VA",
      email: "farm@outside.com",
      resumeBooking: "2027-03-01",
      isExcluded: true,
      exclusionReason: "seasonal-hold",
    },
    {
      _id: "v3",
      name: "Spacing Conflict Venue",
      city: "Salem",
      usState: "VA",
      email: "conflict@venue.com",
      conflictingGigDate: "2026-11-10",
      isExcluded: true,
      exclusionReason: "gig-spacing",
    },
    // Venue without booking email
    {
      _id: "v4",
      name: "No Email Cafe",
      city: "Salem",
      usState: "VA",
      email: "",
      isExcluded: false,
    },
  ];

  const mockFetch: typeof fetch = (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/outreach/candidates")) {
      return Promise.resolve(
        new Response(
          JSON.stringify(mockVenues),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (u.includes("/outreach/preview")) {
      const weekend = parseTargetWeekend("Oct 16-18 2026");
      const rendered = renderPitch(mockVenues[0], weekend);
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              venueId: "v1",
              venueName: "Eligible Brewery",
              subject: rendered.subject,
              body: rendered.htmlBody || rendered.body,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (u.includes("/outreach/templates")) {
      return Promise.resolve(
        new Response(
          JSON.stringify(DEFAULT_TEMPLATES),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (u.includes("/outreach/report")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, reportUrl: "https://web-jam.com/outreach/report/test" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const mockOpener = () => Promise.resolve(true);

  try {
    const result = await runBookGigCli(
      ["Oct 16-18 2026", "Salem, VA", "--no-open"],
      mockFetch,
      mockOpener,
    );

    assertEquals(result.mode, "preview");
    assertEquals(result.candidates.length, 4);

    const fullLog = loggedLines.join("\n");

    // 1. Discovery log reports reconciled breakdown
    assertStringIncludes(
      fullLog,
      "Backend returned 4 total venues evaluated (1 pitchable, 1 seasonal-hold, 1 no-booking-email, 1 gig-spacing).",
    );

    // 2. Primary table heading specifies Eligible Candidate Venues with pitchable count
    assertStringIncludes(fullLog, "Eligible Candidate Venues for October 16–18, 2026 (1):");

    // 3. Secondary table heading specifies Excluded / On-Hold Venues with excluded count
    assertStringIncludes(fullLog, "Excluded / On-Hold Venues (3):");

    // 4. Verify candidate placement: Eligible Brewery in eligible table, others in excluded
    const eligibleSection = fullLog.substring(
      fullLog.indexOf("Eligible Candidate Venues"),
      fullLog.indexOf("Excluded / On-Hold Venues"),
    );
    assertStringIncludes(eligibleSection, "Eligible Brewery");
    assert(
      !eligibleSection.includes("Seasonal Hold Farm"),
      "Seasonal Hold Farm must not be in eligible table",
    );
    assert(
      !eligibleSection.includes("Spacing Conflict Venue"),
      "Spacing Conflict must not be in eligible table",
    );
    assert(
      !eligibleSection.includes("No Email Cafe"),
      "No Email Cafe must not be in eligible table",
    );

    const excludedSection = fullLog.substring(fullLog.indexOf("Excluded / On-Hold Venues"));
    assertStringIncludes(excludedSection, "Seasonal Hold Farm");
    assertStringIncludes(excludedSection, "Spacing Conflict Venue");
    assertStringIncludes(excludedSection, "No Email Cafe");
    assertStringIncludes(excludedSection, "[No Booking Email]");
    assert(
      !excludedSection.includes("Eligible Brewery"),
      "Eligible Brewery must not be in excluded table",
    );
  } finally {
    console.log = originalLog;
  }
});

Deno.test("reconciliation & 7 exclusion reasons: accounts for every backend venue with a named reason (#984)", async () => {
  const refDate = new Date("2026-10-15T00:00:00.000Z");
  const weekend = parseTargetWeekend("Oct 16-18 2026");
  const location = parseLocation("Roanoke, Salem, VA and surrounding areas")!;

  // 1. Candidate fixture set covering pitchable + all seven named exclusion reasons
  const fixtureVenues: CandidateVenue[] = [
    // 1. Pitchable venue (in target area, has booking email, not excluded)
    {
      _id: "v-pitchable",
      name: "Roanoke Brewing",
      city: "Roanoke",
      usState: "VA",
      email: "booking@roanokebrewing.com",
      isExcluded: false,
    },
    // 2. Out of state (different state from target location: NC vs VA)
    {
      _id: "v-out-of-state",
      name: "Charlotte Tavern",
      city: "Charlotte",
      usState: "NC",
      email: "booking@charlottetavern.com",
      isExcluded: false,
    },
    // 3. Outside target area (in-state, but outside target and surrounding cities: Richmond vs Roanoke)
    {
      _id: "v-outside-area",
      name: "Richmond Hall",
      city: "Richmond",
      usState: "VA",
      email: "booking@richmondhall.com",
      isExcluded: false,
    },
    // 4. No booking email (in target area, no prior hold/spacing, but email is missing/empty)
    {
      _id: "v-no-email",
      name: "Salem Speakeasy",
      city: "Salem",
      usState: "VA",
      email: "",
      isExcluded: false,
    },
    // 5. Seasonal hold (active hold in future)
    {
      _id: "v-seasonal-hold",
      name: "Vinton Vineyard",
      city: "Vinton",
      usState: "VA",
      email: "booking@vintonvineyard.com",
      resumeBooking: "2027-04-01",
      isExcluded: true,
      exclusionReason: "seasonal-hold",
    },
    // 6. Gig spacing (conflicting gig date within ±2 month window)
    {
      _id: "v-gig-spacing",
      name: "Cave Spring Pub",
      city: "Cave Spring",
      usState: "VA",
      email: "booking@cavespringpub.com",
      conflictingGigDate: "2026-11-15",
      isExcluded: true,
      exclusionReason: "gig-spacing",
    },
    // 7. Direct chat (outreachEligible: false with direct chat notes)
    {
      _id: "v-direct-chat",
      name: "Roanoke Cafe",
      city: "Roanoke",
      usState: "VA",
      email: "booking@roanokecafe.com",
      outreachEligible: false,
      notes: "Spoke directly with owner on phone",
      isExcluded: true,
      exclusionReason: "direct-chat",
    },
    // 8. Cooldown (contacted within 7-day cooldown window)
    {
      _id: "v-cooldown",
      name: "Salem Taphouse",
      city: "Salem",
      usState: "VA",
      email: "booking@salemtaphouse.com",
      cooldownSentDate: "2026-10-14",
      isExcluded: true,
      exclusionReason: "cooldown",
    },
  ];

  // 2. Mocked fetchFn returning fixture venues from /outreach/candidates
  const mockFetch: typeof fetch = (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/outreach/candidates")) {
      return Promise.resolve(
        new Response(
          JSON.stringify(fixtureVenues),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (u.includes("/venue?status=active")) {
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/outreach?status=")) {
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/outreach/preview")) {
      const rendered = renderPitch(fixtureVenues[0], weekend);
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              venueId: "v-pitchable",
              venueName: "Roanoke Brewing",
              subject: rendered.subject,
              body: rendered.htmlBody || rendered.body,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (u.includes("/outreach/templates")) {
      return Promise.resolve(
        new Response(
          JSON.stringify(DEFAULT_TEMPLATES),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (u.includes("/outreach/report")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, reportUrl: "https://web-jam.com/outreach/report/test" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  // 3. fetchCandidates retrieves all fixture candidates without mutation
  const rawCandidates = await fetchCandidates({ weekend }, mockFetch);
  assertEquals(rawCandidates.length, 8);

  // 4. filterAndRankCandidates retains ALL 8 venues with appropriate named reasons
  const candidates = filterAndRankCandidates(rawCandidates, location, { referenceDate: refDate });
  assertEquals(candidates.length, 8);

  // Assert each venue exists exactly once with its specific exclusion reason
  const pitchableVenue = candidates.find((c) => c._id === "v-pitchable")!;
  assertEquals(isPitchableCandidate(pitchableVenue), true);
  assertEquals(pitchableVenue.isExcluded, false);

  const outOfState = candidates.find((c) => c._id === "v-out-of-state")!;
  assertEquals(isPitchableCandidate(outOfState), false);
  assertEquals(outOfState.isExcluded, true);
  assertEquals(outOfState.exclusionReason, "out-of-state");
  assertEquals(outOfState.statusBadge, "[Out of State]");

  const outsideArea = candidates.find((c) => c._id === "v-outside-area")!;
  assertEquals(isPitchableCandidate(outsideArea), false);
  assertEquals(outsideArea.isExcluded, true);
  assertEquals(outsideArea.exclusionReason, "outside-target-area");
  assertEquals(outsideArea.statusBadge, "[Outside Target Area]");

  const noEmail = candidates.find((c) => c._id === "v-no-email")!;
  assertEquals(isPitchableCandidate(noEmail), false);
  assertEquals(noEmail.isExcluded, true);
  assertEquals(noEmail.exclusionReason, "no-booking-email");
  assertEquals(noEmail.statusBadge, "[No Booking Email]");

  const seasonalHold = candidates.find((c) => c._id === "v-seasonal-hold")!;
  assertEquals(isPitchableCandidate(seasonalHold), false);
  assertEquals(seasonalHold.isExcluded, true);
  assertEquals(seasonalHold.exclusionReason, "seasonal-hold");
  assertStringIncludes(seasonalHold.statusBadge!, "Seasonal Hold");

  const gigSpacing = candidates.find((c) => c._id === "v-gig-spacing")!;
  assertEquals(isPitchableCandidate(gigSpacing), false);
  assertEquals(gigSpacing.isExcluded, true);
  assertEquals(gigSpacing.exclusionReason, "gig-spacing");
  assertStringIncludes(gigSpacing.statusBadge!, "Gig Spacing");

  const directChat = candidates.find((c) => c._id === "v-direct-chat")!;
  assertEquals(isPitchableCandidate(directChat), false);
  assertEquals(directChat.isExcluded, true);
  assertEquals(directChat.exclusionReason, "direct-chat");
  assertEquals(directChat.statusBadge, "[Direct Chat Active]");

  const cooldown = candidates.find((c) => c._id === "v-cooldown")!;
  assertEquals(isPitchableCandidate(cooldown), false);
  assertEquals(cooldown.isExcluded, true);
  assertEquals(cooldown.exclusionReason, "cooldown");
  assertStringIncludes(cooldown.statusBadge!, "Cooldown Active");

  // 5. Reconciled breakdown invariant: pitchable + sum(excluded by reason) === total returned
  const breakdown = getCandidateBreakdown(candidates);
  assertEquals(breakdown.total, 8);
  assertEquals(breakdown.pitchable, 1);
  assertEquals(breakdown.byReason["out-of-state"], 1);
  assertEquals(breakdown.byReason["outside-target-area"], 1);
  assertEquals(breakdown.byReason["seasonal-hold"], 1);
  assertEquals(breakdown.byReason["no-booking-email"], 1);
  assertEquals(breakdown.byReason["gig-spacing"], 1);
  assertEquals(breakdown.byReason["direct-chat"], 1);
  assertEquals(breakdown.byReason["cooldown"], 1);

  const sumExcluded = Object.values(breakdown.byReason).reduce((a, b) => a + b, 0);
  assertEquals(breakdown.pitchable + sumExcluded, breakdown.total);

  // 6. Formatted discovery log reconciles exactly to total evaluated
  const logStr = formatCandidateBreakdown(candidates);
  assertEquals(
    logStr,
    "Backend returned 8 total venues evaluated (1 pitchable, 1 out-of-state, 1 outside-target-area, 1 seasonal-hold, 1 no-booking-email, 1 gig-spacing, 1 direct-chat, 1 cooldown).",
  );

  // 7. Table rendering: pitchable table contains only pitchable, excluded table contains all reasons and NO "New"
  const pitchableTable = renderCandidateTable(candidates.filter(isPitchableCandidate), {
    color: false,
    referenceDate: refDate,
  });
  assertStringIncludes(pitchableTable, "Roanoke Brewing");
  assert(!pitchableTable.includes("Charlotte Tavern"));
  assert(!pitchableTable.includes("Richmond Hall"));
  assert(!pitchableTable.includes("Salem Speakeasy"));

  const excludedTable = renderCandidateTable(candidates.filter((c) => !isPitchableCandidate(c)), {
    color: false,
    referenceDate: refDate,
  });
  assertStringIncludes(excludedTable, "Charlotte Tavern");
  assertStringIncludes(excludedTable, "Richmond Hall");
  assertStringIncludes(excludedTable, "Salem Speakeasy");
  assertStringIncludes(excludedTable, "Vinton Vineyard");
  assertStringIncludes(excludedTable, "Cave Spring Pub");
  assertStringIncludes(excludedTable, "Roanoke Cafe");
  assertStringIncludes(excludedTable, "Salem Taphouse");

  assertStringIncludes(excludedTable, "[Out of State]");
  assertStringIncludes(excludedTable, "[Outside Target Area]");
  assertStringIncludes(excludedTable, "[No Booking Email]");
  assertStringIncludes(excludedTable, "[Seasonal Hold: Apr 2027]");
  assertStringIncludes(excludedTable, "[Gig Spacing: Nov 15 Show]");
  assertStringIncludes(excludedTable, "[Direct Chat Active]");
  assertStringIncludes(excludedTable, "[Cooldown Active: Sent Oct 14]");
  assert(!excludedTable.includes("New"), "Excluded table must never display 'New'");

  // 8. CLI integration with mocked fetchFn prints the reconciled discovery breakdown log
  const loggedLines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    loggedLines.push(args.map(String).join(" "));
  };
  try {
    await runBookGigCli(
      ["Oct 16-18 2026", "Roanoke, Salem, VA and surrounding areas", "--no-open"],
      mockFetch,
      () => Promise.resolve(true),
    );
    const cliOutput = loggedLines.join("\n");
    assertStringIncludes(
      cliOutput,
      "Backend returned 8 total venues evaluated (1 pitchable, 1 out-of-state, 1 outside-target-area, 1 seasonal-hold, 1 no-booking-email, 1 gig-spacing, 1 direct-chat, 1 cooldown).",
    );
  } finally {
    console.log = originalLog;
  }
});

Deno.test("touch conversion: proposes genuine phone conversation, rejects legacy metadata, and requires explicit approval to write (#1006)", async () => {
  const fixtureVenues = [
    {
      _id: "v-phone",
      name: "Phone Note Venue",
      city: "Roanoke",
      usState: "VA",
      notes: "Spoke on the phone about a 2027 booking",
    },
    {
      _id: "v-hamlet",
      name: "Hamlet Vineyards",
      city: "Bassett",
      usState: "VA",
      notes: "Date called: 2026-05-09",
    },
  ];

  let postCalls = 0;
  const postedRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const mockFetch: typeof fetch = (input, init) => {
    if (init?.method === "POST") {
      postCalls++;
      postedRequests.push({ url: String(input), body: JSON.parse(String(init.body)) });
      return Promise.resolve(new Response(JSON.stringify({ _id: "touch-id" }), { status: 201 }));
    }
    return Promise.resolve(new Response(JSON.stringify(fixtureVenues), { status: 200 }));
  };

  // 1. Dry run: proposes without writing
  const dryRun = await executeTouchConversion(
    { apply: false, venues: fixtureVenues },
    mockFetch,
  );
  assertEquals(dryRun.proposals.length, 1);
  assertEquals(dryRun.proposals[0].venueName, "Phone Note Venue");
  assertEquals(dryRun.proposals[0].touchType, "call");
  assertEquals(dryRun.proposals[0].sentence, "Spoke on the phone about a 2027 booking");
  assertEquals(dryRun.applied.length, 0);
  assertEquals(postCalls, 0, "No POST /venue/:id/touch must be made on dry run");

  // 2. Explicit approval write with no date supplied: an undated proposal is never written.
  const approvedRunNoDate = await executeTouchConversion(
    { apply: true, venues: fixtureVenues, actor: "Josh" },
    mockFetch,
  );
  assertEquals(approvedRunNoDate.proposals.length, 1);
  assertEquals(approvedRunNoDate.applied.length, 0);
  assertEquals(postCalls, 0, "An undated row must never be POSTed");
  assertEquals(approvedRunNoDate.skippedNoDate.length, 1);
  assertEquals(approvedRunNoDate.skippedNoDate[0].venueName, "Phone Note Venue");
  assertStringIncludes(approvedRunNoDate.summary, "Skipped 1 undated row");

  // 3. Explicit approval write with a date supplied via --date: writes the approved touch.
  const approvedRunWithDate = await executeTouchConversion(
    { apply: true, venues: fixtureVenues, actor: "Josh", dates: ["v-phone=2026-05-09"] },
    mockFetch,
  );
  assertEquals(approvedRunWithDate.proposals.length, 1);
  assertEquals(approvedRunWithDate.applied.length, 1);
  assertEquals(approvedRunWithDate.applied[0].success, true);
  assertEquals(postCalls, 1);
  assertEquals(postedRequests[0].url, "https://webjamsalem.herokuapp.com/venue/v-phone/touch");
  assertEquals(postedRequests[0].body.type, "call");
  assertEquals(postedRequests[0].body.actor, "Josh");
  assertEquals(postedRequests[0].body.note, "Spoke on the phone about a 2027 booking");
  assertEquals(postedRequests[0].body.date, "2026-05-09T00:00:00.000Z");
});

Deno.test("matchesWeekend: three-outcome guard behavior for weekend matching (#998)", () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  // Outcome 1: Matches via targetWeekend range overlap
  const matchingOverlap: OutreachCampaignRecord = {
    _id: "r1",
    venueId: "v1",
    status: "replied",
    targetWeekend: { start: "2026-10-16", end: "2026-10-18" },
  };
  assertEquals(matchesWeekend(matchingOverlap, weekend), true);

  // Outcome 1 (alt): Matches via targetDates containing start or label
  const matchingDates: OutreachCampaignRecord = {
    _id: "r2",
    venueId: "v2",
    status: "replied",
    targetDates: "2026-10-16 to 2026-10-18",
  };
  assertEquals(matchesWeekend(matchingDates, weekend), true);

  const matchingLabel: OutreachCampaignRecord = {
    _id: "r3",
    venueId: "v3",
    status: "replied",
    targetDates: "Bookings for October 16–18, 2026",
  };
  assertEquals(matchesWeekend(matchingLabel, weekend), true);

  // Outcome 2: Excluded when targetWeekend does not overlap and targetDates does not match
  const mismatchedWeekend: OutreachCampaignRecord = {
    _id: "r4",
    venueId: "v4",
    status: "replied",
    targetWeekend: { start: "2026-11-06", end: "2026-11-08" },
    targetDates: "2026-11-06 to 2026-11-08",
  };
  assertEquals(matchesWeekend(mismatchedWeekend, weekend), false);

  // Outcome 3: Excluded (fails closed) when targetWeekend has missing, null, or unparseable metadata
  const missingMetadata: OutreachCampaignRecord = {
    _id: "r5",
    venueId: "v5",
    status: "replied",
  };
  assertEquals(matchesWeekend(missingMetadata, weekend), false);

  const unparseableWeekend: OutreachCampaignRecord = {
    _id: "r6",
    venueId: "v6",
    status: "replied",
    targetWeekend: { start: "not-a-date", end: "invalid" },
  };
  assertEquals(matchesWeekend(unparseableWeekend, weekend), false);
});

Deno.test("deduplicateCampaignsByVenue: deduplicates multiple outreach records by venueId preserving latest sentAt (#998)", () => {
  const records: OutreachCampaignRecord[] = [
    {
      _id: "c1",
      venueId: "v1",
      venueName: "Venue One",
      status: "sent",
      sentAt: "2026-08-10T10:00:00Z",
    },
    {
      _id: "c2",
      venueId: "v1",
      venueName: "Venue One - Resend",
      status: "replied",
      sentAt: "2026-08-12T15:00:00Z",
      replySnippet: "Resend reply",
    },
    {
      _id: "c3",
      venueId: "v2",
      venueName: "Venue Two",
      status: "sent",
      sentAt: "2026-08-11T12:00:00Z",
    },
  ];

  const deduped = deduplicateCampaignsByVenue(records);
  assertEquals(deduped.length, 2);
  // Venue One should retain the latest record c2 (2026-08-12)
  const v1Record = deduped.find((r) => r.venueId === "v1");
  assertEquals(v1Record?._id, "c2");
  assertEquals(v1Record?.replySnippet, "Resend reply");
  // Venue Two should be preserved
  const v2Record = deduped.find((r) => r.venueId === "v2");
  assertEquals(v2Record?._id, "c3");

  // Also verify order-independence: latest record first, older second
  const reverseOrder: OutreachCampaignRecord[] = [
    {
      _id: "c2",
      venueId: "v1",
      venueName: "Venue One - Resend",
      status: "replied",
      sentAt: "2026-08-12T15:00:00Z",
    },
    {
      _id: "c1",
      venueId: "v1",
      venueName: "Venue One",
      status: "sent",
      sentAt: "2026-08-10T10:00:00Z",
    },
  ];
  const dedupedReverse = deduplicateCampaignsByVenue(reverseOrder);
  assertEquals(dedupedReverse.length, 1);
  assertEquals(dedupedReverse[0]._id, "c2");
});

Deno.test("runBookGigCli: --replies filters pending replies by weekend and deduplicates campaigns (#998)", async () => {
  const mockVenues: CandidateVenue[] = [
    {
      _id: "v1",
      name: "Matching Venue",
      city: "Salem",
      usState: "VA",
    },
    {
      _id: "v2",
      name: "Mismatched Venue",
      city: "Roanoke",
      usState: "VA",
    },
    {
      _id: "v3",
      name: "Missing Weekend Venue",
      city: "Lynchburg",
      usState: "VA",
    },
  ];

  const mockFetch: typeof fetch = (input) => {
    const u = String(input);
    if (u.includes("/outreach/check-replies")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ checked: 3, matched: 1, classified: 1, bounced: 0 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (u.includes("/outreach/replies/pending")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            // Reply 1: Matching target weekend -> included
            {
              _id: "p1",
              venueId: "v1",
              status: "replied",
              targetWeekend: { start: "2026-10-16", end: "2026-10-18" },
              targetDates: "2026-10-16 to 2026-10-18",
              replySnippet: "Oct 17 is open!",
            },
            // Reply 2: Mismatched target weekend (prior month) -> excluded
            {
              _id: "p2",
              venueId: "v2",
              status: "replied",
              targetWeekend: { start: "2026-09-11", end: "2026-09-13" },
              targetDates: "2026-09-11 to 2026-09-13",
              replySnippet: "September was fun",
            },
            // Reply 3: Missing target weekend metadata -> excluded (fails closed)
            {
              _id: "p3",
              venueId: "v3",
              status: "replied",
              replySnippet: "Undated reply",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (u.includes("/outreach/report")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            url: "https://web-jam.com/outreach/report/2026-10-16-to-2026-10-18",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (u.includes("/outreach")) {
      // Return multiple campaigns for v1 (older and newer) to test deduplication
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              _id: "c1",
              venueId: "v1",
              status: "sent",
              sentAt: "2026-08-01T10:00:00Z",
              targetWeekend: { start: "2026-10-16", end: "2026-10-18" },
              targetDates: "2026-10-16 to 2026-10-18",
            },
            {
              _id: "c2",
              venueId: "v1",
              status: "replied",
              sentAt: "2026-08-05T12:00:00Z",
              targetWeekend: { start: "2026-10-16", end: "2026-10-18" },
              targetDates: "2026-10-16 to 2026-10-18",
              replySnippet: "Oct 17 is open!",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (u.includes("/venue")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const mockOpener = () => Promise.resolve(true);

  const result = await runBookGigCli(
    ["--replies", "Oct 16-18 2026", "--no-open"],
    mockFetch,
    mockOpener,
  );

  assertEquals(result.mode, "replies");
  // 1. Pending replies filtering: only p1 included, p2 (mismatched) and p3 (missing metadata) excluded
  const pending = result.repliesTracking?.pendingReplies || [];
  assertEquals(pending.length, 1);
  assertEquals(pending[0]._id, "p1");
  assertEquals(pending[0].venueName, "Matching Venue");

  // 2. Campaigns deduplication: v1 had c1 and c2; only c2 (latest sentAt) is preserved
  const campaigns = result.repliesTracking?.campaigns || [];
  assertEquals(campaigns.length, 1);
  assertEquals(campaigns[0]._id, "c2");
  assertEquals(campaigns[0].sentAt, "2026-08-05T12:00:00Z");
});

Deno.test("renderDarkHtml: places sortable candidates table as first section beneath header (#998)", () => {
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
    {
      _id: "v1",
      name: "Olde Salem Brewing",
      city: "Salem",
      usState: "VA",
      contactName: "Brewmaster Bob",
      email: "bob@oldesalem.com",
    },
  ];

  const campaigns: OutreachCampaignRecord[] = [
    {
      _id: "c1",
      venueId: "v1",
      venueName: "Olde Salem Brewing",
      status: "replied",
      sentAt: "2026-08-10T10:00:00Z",
      replySnippet: "We would love to host you!",
    },
  ];

  const result: BookGigResult = {
    mode: "replies",
    weekend,
    candidates,
    density: { count: 1, isSparse: false },
    pitches: [],
    repliesTracking: {
      checkReplies: { checked: 1, matched: 1, classified: 1, bounced: 0 },
      pendingReplies: [campaigns[0]],
      campaigns,
      targetWeekend: weekend,
    },
  };

  const html = renderDarkHtml(result);

  // Assert candidates section exists with id="candidates-table"
  assertStringIncludes(html, 'id="candidates-table"');
  assertStringIncludes(html, "📊 Eligible Candidates");
  assertStringIncludes(html, "⚠️ Pending Reply Reviews");
  assertStringIncludes(html, "Live Outreach Campaigns");

  // Assert section ordering within <main>:
  // candidatesSectionHtml must be rendered before pendingSectionHtml and campaignsSectionHtml
  const candidatesIndex = html.indexOf('id="candidates-table"');
  const pendingIndex = html.indexOf("⚠️ Pending Reply Reviews");
  const campaignsIndex = html.indexOf("Live Outreach Campaigns");

  assert(candidatesIndex !== -1, "Candidates section should be present");
  assert(pendingIndex !== -1, "Pending reply reviews section should be present");
  assert(campaignsIndex !== -1, "Campaigns section should be present");

  assert(
    candidatesIndex < pendingIndex,
    `Candidates table (${candidatesIndex}) must appear before Pending Reviews (${pendingIndex})`,
  );
  assert(
    candidatesIndex < campaignsIndex,
    `Candidates table (${candidatesIndex}) must appear before Campaigns (${campaignsIndex})`,
  );
});

Deno.test("parseLocation: treats 'all', 'all locations', and 'everywhere' (case-insensitive) as all-locations (#1104)", () => {
  const loc1 = parseLocation("all");
  assertEquals(loc1?.allLocations, true);
  assertEquals(loc1?.cities, undefined);
  assertEquals(loc1?.city, undefined);

  const loc2 = parseLocation("all locations");
  assertEquals(loc2?.allLocations, true);
  assertEquals(loc2?.cities, undefined);

  const loc3 = parseLocation("everywhere");
  assertEquals(loc3?.allLocations, true);
  assertEquals(loc3?.cities, undefined);

  // Case-insensitivity
  assertEquals(parseLocation("ALL")?.allLocations, true);
  assertEquals(parseLocation("All Locations")?.allLocations, true);
  assertEquals(parseLocation("Everywhere")?.allLocations, true);
  assertEquals(parseLocation("ALL LOCATIONS")?.allLocations, true);
});

Deno.test("parseBookGigArgs: recognizes --all, --all-locations, and all location string (#1104)", () => {
  const res1 = parseBookGigArgs(["Oct 16-18", "--all"]);
  assertEquals(res1.location?.allLocations, true);
  assertEquals(res1.weekend?.start, "2026-10-16");

  const res2 = parseBookGigArgs(["Oct 16-18", "--all-locations"]);
  assertEquals(res2.location?.allLocations, true);
  assertEquals(res2.weekend?.start, "2026-10-16");

  const res3 = parseBookGigArgs(["Oct 16-18 2026", "all"]);
  assertEquals(res3.location?.allLocations, true);
  assertEquals(res3.weekend?.start, "2026-10-16");

  const res4 = parseBookGigArgs(["all"]);
  assertEquals(res4.location?.allLocations, true);

  const res5 = parseBookGigArgs(["--all"]);
  assertEquals(res5.location?.allLocations, true);
});

Deno.test("METRO_SURROUNDING: charlotte contains Tega Cay (#1104)", () => {
  assert(METRO_SURROUNDING["charlotte"].includes("Tega Cay"));
});

Deno.test("filterAndRankCandidates: bypasses city/metro filtering when location.allLocations is true (#1104)", () => {
  const venues: CandidateVenue[] = [
    {
      _id: "v1",
      name: "Roanoke Venue",
      city: "Roanoke",
      usState: "VA",
      email: "rke@test.com",
    },
    {
      _id: "v2",
      name: "Charlotte Venue",
      city: "Charlotte",
      usState: "NC",
      email: "clt@test.com",
    },
    {
      _id: "v3",
      name: "Rock Hill Venue",
      city: "Rock Hill",
      usState: "SC",
      email: "rh@test.com",
    },
    {
      _id: "v4",
      name: "Tega Cay Venue",
      city: "Tega Cay",
      usState: "SC",
      email: "tc@test.com",
    },
  ];

  const loc = parseLocation("all")!;
  const filtered = filterAndRankCandidates(venues, loc);
  const pitchable = filtered.filter(isPitchableCandidate);

  assertEquals(pitchable.length, 4);
  assertEquals(filtered.every((v) => !v.isExcluded), true);
  assertEquals(filtered.some((v) => v.exclusionReason === "outside-target-area"), false);
});

Deno.test("filterAndRankCandidates: preserves pre-existing cause-based exclusion badges when out-of-area (#1104)", () => {
  const venues: CandidateVenue[] = [
    {
      _id: "garrison",
      name: "The Garrison",
      city: "Tega Cay",
      usState: "SC",
      email: "booking@thegarrison.com",
      isExcluded: true,
      statusBadge: "[Cooldown Active: Sent Sep 13]",
      exclusionReason: "cooldown",
      reason: {
        statusBadge: "[Cooldown Active: Sent Sep 13]",
        exclusionReason: "cooldown",
      },
    },
    {
      _id: "hold-venue",
      name: "Hold Venue",
      city: "Charlotte",
      usState: "NC",
      email: "booking@hold.com",
      isExcluded: true,
      statusBadge: "[Seasonal Hold: Jan 2027]",
      exclusionReason: "seasonal-hold",
      reason: {
        statusBadge: "[Seasonal Hold: Jan 2027]",
        exclusionReason: "seasonal-hold",
      },
    },
    {
      _id: "direct-chat-venue",
      name: "Chat Venue",
      city: "Gastonia",
      usState: "NC",
      email: "booking@chat.com",
      isExcluded: true,
      statusBadge: "[Direct Chat Active]",
      exclusionReason: "direct-chat",
      reason: {
        statusBadge: "[Direct Chat Active]",
        exclusionReason: "direct-chat",
      },
    },
    {
      _id: "spacing-venue",
      name: "Spacing Venue",
      city: "Concord",
      usState: "NC",
      email: "booking@spacing.com",
      isExcluded: true,
      statusBadge: "[Gig Spacing: Nov 15 Show]",
      exclusionReason: "gig-spacing",
      reason: {
        statusBadge: "[Gig Spacing: Nov 15 Show]",
        exclusionReason: "gig-spacing",
      },
    },
    {
      _id: "in-area-venue",
      name: "Waterman's Grill",
      city: "Lynchburg",
      usState: "VA",
      email: "booking@watermans.com",
      isExcluded: false,
    },
    {
      _id: "out-of-area-eligible",
      name: "Eligible Faraway Venue",
      city: "Raleigh",
      usState: "NC",
      email: "booking@raleigh.com",
      isExcluded: false,
    },
  ];

  // Explicit multi-city filter targeting Lynchburg, VA and Rock Hill, SC (cross-state, no uniform state filter)
  const loc = parseLocation("Lynchburg, Rock Hill")!;
  const filtered = filterAndRankCandidates(venues, loc);

  const garrison = filtered.find((v) => v._id === "garrison")!;
  assertEquals(garrison.isExcluded, true);
  assertEquals(garrison.exclusionReason, "cooldown");
  assertEquals(garrison.statusBadge, "[Cooldown Active: Sent Sep 13]");
  assertEquals(garrison.reason?.exclusionReason, "cooldown");
  assertEquals(garrison.reason?.statusBadge, "[Cooldown Active: Sent Sep 13]");

  const hold = filtered.find((v) => v._id === "hold-venue")!;
  assertEquals(hold.isExcluded, true);
  assertEquals(hold.exclusionReason, "seasonal-hold");
  assertEquals(hold.statusBadge, "[Seasonal Hold: Jan 2027]");
  assertEquals(hold.reason?.exclusionReason, "seasonal-hold");
  assertEquals(hold.reason?.statusBadge, "[Seasonal Hold: Jan 2027]");

  const chat = filtered.find((v) => v._id === "direct-chat-venue")!;
  assertEquals(chat.isExcluded, true);
  assertEquals(chat.exclusionReason, "direct-chat");
  assertEquals(chat.statusBadge, "[Direct Chat Active]");
  assertEquals(chat.reason?.exclusionReason, "direct-chat");
  assertEquals(chat.reason?.statusBadge, "[Direct Chat Active]");

  const spacing = filtered.find((v) => v._id === "spacing-venue")!;
  assertEquals(spacing.isExcluded, true);
  assertEquals(spacing.exclusionReason, "gig-spacing");
  assertEquals(spacing.statusBadge, "[Gig Spacing: Nov 15 Show]");
  assertEquals(spacing.reason?.exclusionReason, "gig-spacing");
  assertEquals(spacing.reason?.statusBadge, "[Gig Spacing: Nov 15 Show]");

  const inArea = filtered.find((v) => v._id === "in-area-venue")!;
  assertEquals(inArea.isExcluded, false);
  assertEquals(isPitchableCandidate(inArea), true);

  const outOfArea = filtered.find((v) => v._id === "out-of-area-eligible")!;
  assertEquals(outOfArea.isExcluded, true);
  assertEquals(outOfArea.exclusionReason, "outside-target-area");
  assertEquals(outOfArea.statusBadge, "[Outside Target Area]");
});

Deno.test("formatMonthDayYear: formats date string or Date object with 4-digit year (#1103)", () => {
  assertEquals(formatMonthDayYear("2026-12-12"), "Dec 12, 2026");
  assertEquals(formatMonthDayYear("2026-05-09"), "May 9, 2026");
  assertEquals(formatMonthDayYear("Dec 12, 2026"), "Dec 12, 2026");
});

Deno.test("formatExcludedAuditSummary: returns None when empty (#1103)", () => {
  assertEquals(formatExcludedAuditSummary([]), "Excluded Candidate Audit Summary: None");
});

Deno.test("formatExcludedAuditSummary: groups excluded candidates across all canonical categories (#1103)", () => {
  const excludedVenues: CandidateVenue[] = [
    {
      _id: "lwb",
      name: "Long Way Brewing",
      city: "Radford",
      usState: "VA",
      email: "booking@longway.com",
      isExcluded: true,
      exclusionReason: "gig-spacing",
      conflictingGigDate: "2026-12-12",
      statusBadge: "[Gig Spacing: Dec 12, 2026 Show]",
    },
    {
      _id: "5pts",
      name: "5 Points Music Sanctuary",
      city: "Roanoke",
      usState: "VA",
      email: "info@5pointsmusic.com",
      isExcluded: true,
      exclusionReason: "gig-spacing",
      conflictingGigDate: "2026-11-15",
      statusBadge: "[Gig Spacing: Nov 15, 2026 Show]",
    },
    {
      _id: "garrison",
      name: "The Garrison",
      city: "Tega Cay",
      usState: "SC",
      email: "booking@thegarrison.com",
      isExcluded: true,
      exclusionReason: "cooldown",
      statusBadge: "[Cooldown Active: Sent Sep 13]",
    },
    {
      _id: "osb",
      name: "Olde Salem Brewing",
      city: "Salem",
      usState: "VA",
      email: "booking@oldesalem.com",
      isExcluded: true,
      exclusionReason: "seasonal-hold",
      statusBadge: "[Seasonal Hold: Jan 2027]",
    },
    {
      _id: "chat",
      name: "Twin Creeks Brewing",
      city: "Vinton",
      usState: "VA",
      email: "info@twincreeks.com",
      isExcluded: true,
      exclusionReason: "direct-chat",
      statusBadge: "[Direct Chat Active]",
    },
    {
      _id: "no-email",
      name: "Mystery Tavern",
      city: "Roanoke",
      usState: "VA",
      email: "",
      isExcluded: true,
      exclusionReason: "no-booking-email",
      statusBadge: "[No Booking Email]",
    },
    {
      _id: "parkway",
      name: "Parkway Brewing",
      city: "Salem",
      usState: "VA",
      email: "booking@parkway.com",
      isExcluded: true,
      exclusionReason: "outside-target-area",
      statusBadge: "[Outside Target Area]",
    },
    {
      _id: "beales",
      name: "Beale's Brewery",
      city: "Bedford",
      usState: "VA",
      email: "info@beales.com",
      isExcluded: true,
      exclusionReason: "outside-target-area",
      statusBadge: "[Outside Target Area]",
    },
    {
      _id: "raleigh",
      name: "Raleigh Pour House",
      city: "Raleigh",
      usState: "NC",
      email: "info@raleighpour.com",
      isExcluded: true,
      exclusionReason: "out-of-state",
      statusBadge: "[Out of State]",
    },
  ];

  const summary = formatExcludedAuditSummary(excludedVenues);

  // Asserts total count in header
  assertStringIncludes(summary, "Excluded Candidate Audit Summary (9 total):");

  // Asserts Gig Spacing Conflicts section with dates and correct venue names (prevents misattribution)
  assertStringIncludes(summary, "• Gig Spacing Conflicts (2):");
  assertStringIncludes(summary, "- 5 Points Music Sanctuary (Nov 15, 2026 Show)");
  assertStringIncludes(summary, "- Long Way Brewing (Dec 12, 2026 Show)");

  // Asserts Active Cooldowns
  assertStringIncludes(summary, "• Active Cooldowns (1):");
  assertStringIncludes(summary, "- The Garrison (Sent Sep 13)");

  // Asserts Seasonal Holds
  assertStringIncludes(summary, "• Seasonal Holds (1):");
  assertStringIncludes(summary, "- Olde Salem Brewing (Jan 2027)");

  // Asserts Direct Chat Active
  assertStringIncludes(summary, "• Direct Chat Active (1):");
  assertStringIncludes(summary, "- Twin Creeks Brewing (Direct Chat Active)");

  // Asserts No Booking Email
  assertStringIncludes(summary, "• No Booking Email (1):");
  assertStringIncludes(summary, "- Mystery Tavern (No Booking Email)");

  // Asserts Outside Target Area with alphabetical ordering (Beale's before Parkway)
  assertStringIncludes(summary, "• Outside Target Area (2):");
  assertStringIncludes(summary, "- Beale's Brewery (Bedford, VA)");
  assertStringIncludes(summary, "- Parkway Brewing (Salem, VA)");
  const bealesIdx = summary.indexOf("Beale's Brewery");
  const parkwayIdx = summary.indexOf("Parkway Brewing");
  assert(bealesIdx !== -1 && parkwayIdx !== -1 && bealesIdx < parkwayIdx);

  // Asserts Out of State
  assertStringIncludes(summary, "• Out of State (1):");
  assertStringIncludes(summary, "- Raleigh Pour House (Raleigh, NC)");
});

Deno.test("formatExcludedAuditSummary: files a venue by its recorded exclusion reason, never by an old send date or a missing email (#1103)", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  const summary = formatExcludedAuditSummary([
    {
      _id: "hold",
      name: "Durty Bull Brewing Company",
      email: "booking@durtybull.com",
      isExcluded: true,
      exclusionReason: "seasonal-hold",
      statusBadge: "[Seasonal Hold: Jan 2027]",
      sentAt: "2026-07-24T12:00:00Z",
    },
    {
      _id: "far",
      name: "Far Away Tavern",
      city: "Asheville",
      usState: "NC",
      email: "",
      isExcluded: true,
      exclusionReason: "outside-target-area",
      statusBadge: "[Outside Target Area]",
      sentAt: "2026-03-01T12:00:00Z",
    },
    {
      _id: "badge-only",
      name: "Badge Only Brewing",
      email: "booking@badgeonly.com",
      isExcluded: true,
      statusBadge: "[Seasonal Hold: Feb 2027]",
      lastSentDate: "2026-09-20T12:00:00Z",
    },
    {
      _id: "old-send",
      name: "Old Send Hall",
      email: "booking@oldsend.com",
      isExcluded: true,
      resumeBooking: "2027-01-15T00:00:00Z",
      sentAt: "2026-07-24T12:00:00Z",
    },
    {
      _id: "recent-send",
      name: "Recent Send Hall",
      email: "booking@recentsend.com",
      isExcluded: true,
      sentAt: "2026-09-20T12:00:00Z",
    },
  ], now);

  assertEquals(
    summary,
    [
      "Excluded Candidate Audit Summary (5 total):",
      "  • Active Cooldowns (1):",
      "    - Recent Send Hall (Sent Sep 20)",
      "  • Seasonal Holds (3):",
      "    - Badge Only Brewing (Feb 2027)",
      "    - Durty Bull Brewing Company (Jan 2027)",
      "    - Old Send Hall (Jan 2027)",
      "  • Outside Target Area (1):",
      "    - Far Away Tavern (Asheville, NC)",
    ].join("\n"),
  );
});
