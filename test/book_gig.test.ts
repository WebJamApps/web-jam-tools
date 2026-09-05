// test/book_gig.test.ts — Unit tests for /book-gig skill and CLI

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  matchesVenueFilter,
  parseBookGigArgs,
  parseLocation,
  parseTargetWeekend,
} from "../src/book-gig/parser.ts";
import {
  assessDensity,
  fetchCandidates,
  filterAndRankCandidates,
  formatMonthDay,
  formatMonthYear,
  identifyCandidateBadge,
  renderCandidateTable,
} from "../src/book-gig/candidates.ts";
import {
  BANNED_VOICE_WORDS,
  DEFAULT_TEMPLATES,
  htmlToPlainText,
  renderPitch,
  validateVoiceRules,
} from "../src/book-gig/pitch.ts";
import {
  extractRunDataFromMarkdown,
  formatDraftPayload,
  mergeWeekendRuns,
  writeDropboxRunLog,
} from "../src/book-gig/gmail.ts";
import {
  checkGmailReplies,
  dispatchBatchOutreach,
  fetchOutreachCampaigns,
  fetchPendingReplies,
  fetchTemplates,
  fetchVenueMap,
} from "../src/book-gig/outreach_api.ts";
import {
  extractRunDataFromHtml,
  formatPay,
  renderDarkHtml,
  renderStatusBadge,
  SORTING_SCRIPT,
} from "../src/book-gig/html.ts";
import { openHtmlInBrowser } from "../src/book-gig/browser.ts";
import { formatLocationDisplay, runBookGigCli } from "../src/book-gig/cli.ts";
import {
  buildUnambiguousNameIndex,
  decodeHtmlEntities,
  executeLinkGig,
  normalizeVenueName,
  resolveGigVenueId,
} from "../src/book-gig/venue_link.ts";
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

  assertEquals(filtered.length, 2);
  assertEquals(filtered[0].name, "Waterman's Grill"); // Direct city match
  assertEquals(filtered[1].name, "Apocalypse Ale Works"); // Surrounding Forest match
  assertEquals(filtered.some((v) => v.name === "Parkway Brewing"), false); // Unrelated metro excluded
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

  assertEquals(filtered.length, 3);
  assertEquals(filtered.some((v) => v.city === "Charlotte"), true);
  assertEquals(filtered.some((v) => v.city === "Gastonia"), true);
  assertEquals(filtered.some((v) => v.city === "Belmont"), true);
  assertEquals(filtered.some((v) => v.city === "Salem"), false);
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

  // Exact matches first (Blacksburg, Salem VA), then surrounding (Forest VA, Floyd VA)
  assertEquals(filtered.length, 4);
  assertEquals(filtered[0].name, "Olde Salem Brewing"); // Exact Salem VA match
  assertEquals(filtered[1].name, "Rising Silo Brewery"); // Exact Blacksburg VA match
  assertEquals(filtered[2].name, "Apocalypse Ale Works"); // Surrounding Forest VA match
  assertEquals(filtered[3].name, "Dogtown Roadhouse"); // Surrounding Floyd VA match

  // Non-target metros, far-out towns (Marion, Harrisonburg), and out-of-state venues (Charlotte NC, Salem NC, Charleston SC) must be excluded
  assertEquals(filtered.some((v) => v.city === "Charlotte"), false);
  assertEquals(filtered.some((v) => v.city === "Harrisonburg"), false);
  assertEquals(filtered.some((v) => v.city === "Marion"), false);
  assertEquals(filtered.some((v) => v.usState === "NC"), false);
  assertEquals(filtered.some((v) => v.usState === "SC"), false);
  assertEquals(filtered.some((v) => v._id === "v5"), false); // Marion VA excluded
  assertEquals(filtered.some((v) => v._id === "v7"), false); // Salem NC excluded
  assertEquals(filtered.some((v) => v._id === "v8"), false); // Charleston SC excluded
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

Deno.test("formatDraftPayload and writeDropboxRunLog: formats and writes run log", async () => {
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

  const tmpDir = await Deno.makeTempDir();
  try {
    const result = {
      mode: "preview" as const,
      weekend,
      candidates: [venue],
      density: { count: 1, isSparse: true, suggestedMetro: "roanoke" },
      pitches: [pitch],
    };
    const logPath = await writeDropboxRunLog(result, tmpDir);
    assert(logPath !== null);
    const mdContent = await Deno.readTextFile(logPath);
    assertStringIncludes(mdContent, "Parkway Brewing");
    assertStringIncludes(mdContent, "October 16–18, 2026");

    // Verify corresponding HTML artifact was created
    const htmlPath = logPath.replace(/\.md$/, ".html");
    const htmlContent = await Deno.readTextFile(htmlPath);
    assertStringIncludes(htmlContent, "<!DOCTYPE html>");
    assertStringIncludes(htmlContent, "Parkway Brewing");
    assertStringIncludes(htmlContent, "--bg-primary: #121212");
    assertStringIncludes(htmlContent, 'name="viewport"');
    assertStringIncludes(htmlContent, "Copy Email");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("writeDropboxRunLog & renderDarkHtml: includes Contact Person and Phone in markdown and HTML artifacts (#874)", async () => {
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

  const tmpDir = await Deno.makeTempDir();
  try {
    const result = {
      mode: "preview" as const,
      weekend,
      candidates: [venue],
      density: { count: 1, isSparse: false },
      pitches: [pitch],
    };

    const logPath = await writeDropboxRunLog(result, tmpDir);
    assert(logPath !== null);

    const mdContent = await Deno.readTextFile(logPath);
    assertStringIncludes(
      mdContent,
      "| # | Venue Name | Location | Contact Person | Phone | Booking Email | Spacing Note |",
    );
    assertStringIncludes(
      mdContent,
      "| 1 | Parkway Brewing | Salem, VA | Lezlie Snyder | 540-555-1234 | lezlie@parkwaybrewing.com |",
    );

    const html = renderDarkHtml(result);
    assertStringIncludes(html, "<th>Contact Person</th>");
    assertStringIncludes(html, "<th>Phone</th>");
    assertStringIncludes(html, "<td>Lezlie Snyder</td>");
    assertStringIncludes(html, '<a href="tel:540-555-1234" class="email-link">540-555-1234</a>');
    assertStringIncludes(html, "Contact: <strong>Lezlie Snyder</strong>");
    assertStringIncludes(
      html,
      'Tel: <a href="tel:540-555-1234" class="meta-email">540-555-1234</a>',
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("writeDropboxRunLog: accumulates multiple batches for the same weekend into a single consolidated report (#876)", async () => {
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

  const tmpDir = await Deno.makeTempDir({ prefix: "book_gig_accum_" });
  try {
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

    const logPath1 = await writeDropboxRunLog(batch1, tmpDir);
    assert(logPath1 !== null);

    const md1 = await Deno.readTextFile(logPath1);
    assertStringIncludes(md1, "Parkway Brewing");
    assertStringIncludes(md1, "Olde Salem Brewery");
    assertStringIncludes(md1, "**Batch Dispatch:** 2 sent / 2 requested (0 skipped)");

    // Batch 2: 2 different candidates for same weekend, 1 sent, 1 skipped
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

    const logPath2 = await writeDropboxRunLog(batch2, tmpDir);
    assertEquals(logPath2, logPath1);

    // Verify consolidated Markdown log
    const consolidatedMd = await Deno.readTextFile(logPath2!);
    assertStringIncludes(consolidatedMd, "Parkway Brewing");
    assertStringIncludes(consolidatedMd, "Olde Salem Brewery");
    assertStringIncludes(consolidatedMd, "The Glass House");
    assertStringIncludes(consolidatedMd, "Riverviews Artspace");
    assertStringIncludes(consolidatedMd, "**Candidates Found:** 4");
    assertStringIncludes(consolidatedMd, "**Pitches Drafted:** 4");
    assertStringIncludes(consolidatedMd, "**Batch Dispatch:** 3 sent / 4 requested (1 skipped)");

    // Verify consolidated Dark Mode HTML artifact
    const htmlPath = logPath2!.replace(/\.md$/, ".html");
    const consolidatedHtml = await Deno.readTextFile(htmlPath);
    assertStringIncludes(consolidatedHtml, '<tr data-venue-id="v1">');
    assertStringIncludes(consolidatedHtml, '<tr data-venue-id="v2">');
    assertStringIncludes(consolidatedHtml, '<tr data-venue-id="v3">');
    assertStringIncludes(consolidatedHtml, '<tr data-venue-id="v4">');
    assertStringIncludes(
      consolidatedHtml,
      '<section class="pitch-card" id="pitch-1" data-venue-id="v1">',
    );
    assertStringIncludes(
      consolidatedHtml,
      '<section class="pitch-card" id="pitch-2" data-venue-id="v2">',
    );
    assertStringIncludes(
      consolidatedHtml,
      '<section class="pitch-card" id="pitch-3" data-venue-id="v3">',
    );
    assertStringIncludes(
      consolidatedHtml,
      '<section class="pitch-card" id="pitch-4" data-venue-id="v4">',
    );
    assertStringIncludes(consolidatedHtml, "3 dispatched");
    assertStringIncludes(consolidatedHtml, "1 venues");
    assertStringIncludes(consolidatedHtml, "3 of 4 venue pitch emails sent");
    assertStringIncludes(consolidatedHtml, "Invalid booking email");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("writeDropboxRunLog: deduplicates candidate rows and pitch cards by venueId across batches (#876)", async () => {
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

  const tmpDir = await Deno.makeTempDir({ prefix: "book_gig_dedup_" });
  try {
    const batch1: BookGigResult = {
      mode: "send",
      weekend,
      candidates: [venueA_old, venueB],
      density: { count: 2, isSparse: true },
      pitches: [pitchA_old, pitchB],
      batchDispatch: { requested: 2, sent: 2, skipped: [], records: [] },
    };
    await writeDropboxRunLog(batch1, tmpDir);

    const batch2: BookGigResult = {
      mode: "send",
      weekend,
      candidates: [venueA_new, venueC],
      density: { count: 2, isSparse: true },
      pitches: [pitchA_new, pitchC],
      batchDispatch: { requested: 2, sent: 2, skipped: [], records: [] },
    };
    const logPath = await writeDropboxRunLog(batch2, tmpDir);
    assert(logPath !== null);

    const md = await Deno.readTextFile(logPath);
    // Should have 3 candidates total (Venue A, Venue B, Venue C) - not 4
    assertStringIncludes(md, "**Candidates Found:** 3");
    assertStringIncludes(md, "**Pitches Drafted:** 3");
    assertStringIncludes(md, "**Batch Dispatch:** 4 sent / 4 requested (0 skipped)");

    // Venue A details should be updated to new contact and email
    assertStringIncludes(md, "new@venuea.com");
    assertStringIncludes(md, "Alice Updated");
    assertStringIncludes(md, "999-999-9999");

    const htmlPath = logPath.replace(/\.md$/, ".html");
    const html = await Deno.readTextFile(htmlPath);
    // Verify only one data-venue-id="vA" in candidate rows
    const matchesA = html.match(/<tr data-venue-id="vA">/g);
    assertEquals(matchesA?.length, 1);

    // Verify only one pitch card for vA
    const pitchCardsA = html.match(/data-venue-id="vA"/g);
    // 1 in candidate table row + 1 in pitch card = 2 total occurrences
    assertEquals(pitchCardsA?.length, 2);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("writeDropboxRunLog: deduplicates skipped venues by venueId across batches (#876)", async () => {
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

  const tmpDir = await Deno.makeTempDir({ prefix: "book_gig_skip_dedup_" });
  try {
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
    await writeDropboxRunLog(batch1, tmpDir);

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
    const logPath = await writeDropboxRunLog(batch2, tmpDir);
    assert(logPath !== null);

    const htmlPath = logPath.replace(/\.md$/, ".html");
    const html = await Deno.readTextFile(htmlPath);

    // Skipped table should have exactly 2 distinct rows: v1 and v2
    assertStringIncludes(html, "Skipped Venues (2)");
    assertStringIncludes(html, "Updated skip reason");
    assertStringIncludes(html, "Bounced");

    const md = await Deno.readTextFile(logPath);
    // Cumulative: requested = 1 + 2 = 3, sent = 0 + 1 = 1, skipped = 2 deduplicated
    assertStringIncludes(md, "**Batch Dispatch:** 1 sent / 3 requested (2 skipped)");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("writeDropboxRunLog: consolidates with legacy run logs lacking embedded JSON (#876)", async () => {
  const weekend: TargetWeekend = {
    start: "2026-10-16",
    end: "2026-10-18",
    rawText: "Oct 16-18 2026",
    label: "October 16–18, 2026",
    year: 2026,
    month: 10,
    days: [16, 17, 18],
  };

  const tmpDir = await Deno.makeTempDir({ prefix: "book_gig_legacy_" });
  try {
    const legacyMd = `# \`book-gig\` Run Record: October 16–18, 2026

**Run Timestamp:** 2026-08-20T10:00:00.000Z  
**Mode:** send  
**Target Weekend:** 2026-10-16 to 2026-10-18 (October 16–18, 2026)  
**Target Location Filter:** Roanoke, VA  
**Candidates Found:** 1 (Sparse: Yes)  
**Pitches Drafted:** 1  
**Batch Dispatch:** 1 sent / 1 requested (0 skipped)  

---

## 1. Candidate Venues Evaluated

| # | Venue Name | Location | Contact Person | Phone | Booking Email | Spacing Note |
|---|---|---|---|---|---|---|
| 1 | Legacy Taproom | Roanoke, VA | Bob | 540-000-0000 | bob@legacy.com | Eligible |

---

## 2. Generated Gmail Pitches

### Pitch 1: Legacy Taproom
- **To:** \`bob@legacy.com\`
- **Subject:** Booking Inquiry - Legacy Taproom

\`\`\`text
Hi Bob, we would love to perform at Legacy Taproom on Oct 16-18.
\`\`\`

---

*Note: Generated by WebJamApps \`book-gig\` outreach pipeline.*
`;
    await Deno.writeTextFile(`${tmpDir}/book-gig-run-2026-10-16-to-2026-10-18.md`, legacyMd);

    const newVenue: CandidateVenue = {
      _id: "vNew",
      name: "New Taproom",
      city: "Salem",
      usState: "VA",
      email: "booking@newtaproom.com",
    };
    const newPitch = renderPitch(newVenue, weekend);

    const batch2: BookGigResult = {
      mode: "send",
      weekend,
      candidates: [newVenue],
      density: { count: 1, isSparse: true },
      pitches: [newPitch],
      batchDispatch: { requested: 1, sent: 1, skipped: [], records: [] },
    };

    const logPath = await writeDropboxRunLog(batch2, tmpDir);
    assert(logPath !== null);

    const md = await Deno.readTextFile(logPath);
    assertStringIncludes(md, "Legacy Taproom");
    assertStringIncludes(md, "New Taproom");
    assertStringIncludes(md, "**Candidates Found:** 2");
    assertStringIncludes(md, "**Batch Dispatch:** 2 sent / 2 requested (0 skipped)");

    const htmlPath = logPath.replace(/\.md$/, ".html");
    const html = await Deno.readTextFile(htmlPath);
    assertStringIncludes(html, "Legacy Taproom");
    assertStringIncludes(html, "New Taproom");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractRunDataFromMarkdown & extractRunDataFromHtml: extracts and parses run data", () => {
  const sampleMd = `
# Run Record
<!-- BOOK_GIG_RUN_DATA:
{
  "candidates": [{"_id": "v1", "name": "Venue 1"}],
  "pitches": [{"venueId": "v1", "venueName": "Venue 1", "to": "a@b.com", "subject": "Sub", "body": "Body"}],
  "batchDispatch": {"requested": 1, "sent": 1, "skipped": [], "records": []}
}
-->
`;
  const parsedMd = extractRunDataFromMarkdown(sampleMd);
  assert(parsedMd);
  assertEquals(parsedMd.candidates.length, 1);
  assertEquals(parsedMd.candidates[0].name, "Venue 1");
  assertEquals(parsedMd.batchDispatch?.sent, 1);

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
  assertStringIncludes(html, "Returning · Last: 2026-06-15");
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
  assertEquals(capturedBody.targetDates, "2026-10-16 to 2026-10-18");
  assertEquals(capturedBody.targetWeekend, { start: "2026-10-16", end: "2026-10-18" });
  assertEquals(res.sent, 2);
  assertEquals(res.requested, 2);
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
    capturedUrl1 = String(_url);
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
    capturedUrl2 = String(_url);
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
              replySnippet: "Oct 17 works great!",
              suggestion: { action: "Confirm date", intent: "Booking Offer", confidence: 0.9 },
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
    ["--send", "Oct 16-18 2026", "Salem, VA"],
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
    ["--send", "Oct 16-18 2026"],
    mockFetch,
    mockOpener,
  );
  assertEquals(resAll.batchDispatch?.sent, 3);
  assertEquals(lastDispatchedIds, ["v1", "v2", "v3"]);

  // Test 2: Send with --venues (approved subset by ID)
  const resSubsetId = await runBookGigCli(
    ["--send", "Oct 16-18 2026", "--venues", "v1,v3"],
    mockFetch,
    mockOpener,
  );
  assertEquals(resSubsetId.batchDispatch?.sent, 2);
  assertEquals(lastDispatchedIds, ["v1", "v3"]);

  // Test 3: Send with --venues (approved subset by Name)
  const resSubsetName = await runBookGigCli(
    ["--send", "Oct 16-18 2026", "--venues", "Parkway Brewing"],
    mockFetch,
    mockOpener,
  );
  assertEquals(resSubsetName.batchDispatch?.sent, 1);
  assertEquals(lastDispatchedIds, ["v2"]);

  // Test 4: Send with --skip (exclude specific ID)
  const resSkip = await runBookGigCli(
    ["--send", "Oct 16-18 2026", "--skip", "v2"],
    mockFetch,
    mockOpener,
  );
  assertEquals(resSkip.batchDispatch?.sent, 2);
  assertEquals(lastDispatchedIds, ["v1", "v3"]);

  // Test 5: Send with non-matching --venues
  const resNone = await runBookGigCli(
    ["--send", "Oct 16-18 2026", "--venues", "non-existent-id"],
    mockFetch,
    mockOpener,
  );
  assertEquals(resNone.batchDispatch?.sent, 0);
  assertEquals(resNone.batchDispatch?.requested, 0);
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

  assertStringIncludes(pitch.body, "Hi Matt Kimble,");
  assertStringIncludes(pitch.body, "Following up on our earlier conversation");
  assertStringIncludes(pitch.body, "January 15–17, 2027");
  assertEquals(pitch.body.includes("[Custom Body]"), false);

  const validation = validateVoiceRules(pitch.body);
  assertEquals(validation.valid, true);
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
    contactNotes: "Direct phone conversation with booking manager on Monday",
  };

  const badge = identifyCandidateBadge(venue, refDate);
  assertEquals(badge.badge, "[Direct Chat Active]");
  assertEquals(badge.cssClass, "badge-direct-chat");
  assertEquals(badge.isExcluded, true);

  const venuePrior: CandidateVenue = {
    _id: "v2",
    name: "Riverviews Artspace",
    outreachEligible: false,
    priorContactNotes: "Chatting directly about holiday showcase",
  };
  const badgePrior = identifyCandidateBadge(venuePrior, refDate);
  assertEquals(badgePrior.badge, "[Direct Chat Active]");
  assertEquals(badgePrior.cssClass, "badge-direct-chat");
  assertEquals(badgePrior.isExcluded, true);
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
  assertEquals(badgeReturning.badge, "Returning · Last: 2026-06-15");
  assertEquals(badgeReturning.cssClass, "badge-returning");
  assertEquals(badgeReturning.isExcluded, false);

  const newVenue: CandidateVenue = {
    _id: "v2",
    name: "Brand New Brewery",
    reason: {},
  };
  const badgeNew = identifyCandidateBadge(newVenue, refDate);
  assertEquals(badgeNew.badge, "New");
  assertEquals(badgeNew.cssClass, "badge-eligible");
  assertEquals(badgeNew.isExcluded, false);
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
      contactNotes: "Spoke with owner directly",
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
      reason: { lastGigDate: "2026-06-15" },
    },
    {
      _id: "v6",
      name: "Fresh New Venue",
      city: "Salem",
      usState: "VA",
      reason: {},
    },
  ];

  const loc = parseLocation("Salem, VA")!;
  const filtered = filterAndRankCandidates(candidates, loc, { referenceDate: refDate });

  assertEquals(filtered.length, 6);

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
  assertEquals(returning.statusBadge, "Returning · Last: 2026-06-15");
  assertEquals(returning.isExcluded, false);

  const fresh = filtered.find((v) => v._id === "v6")!;
  assertEquals(fresh.statusBadge, "New");
  assertEquals(fresh.isExcluded, false);
});

Deno.test("renderCandidateTable & renderDarkHtml: surfaces granular badges in terminal and HTML artifacts (#879)", async () => {
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
      contactNotes: "Spoke with owner directly",
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

  // 4. Markdown run log
  const tmpDir = await Deno.makeTempDir({ prefix: "book_gig_badges_" });
  try {
    const logPath = await writeDropboxRunLog(result, tmpDir);
    assert(logPath !== null);
    const mdContent = await Deno.readTextFile(logPath);
    assertStringIncludes(mdContent, "[Seasonal Hold: Jan 2027]");
    assertStringIncludes(mdContent, "[Gig Spacing: Nov 20 Show]");
    assertStringIncludes(mdContent, "[Direct Chat Active]");
    assertStringIncludes(mdContent, "[Cooldown Active: Sent Sep 28]");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
