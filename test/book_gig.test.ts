// test/book_gig.test.ts — Unit tests for /book-gig skill and CLI

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
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
} from "../src/book-gig/candidates.ts";
import {
  BANNED_VOICE_WORDS,
  DEFAULT_TEMPLATES,
  htmlToPlainText,
  renderPitch,
  validateVoiceRules,
} from "../src/book-gig/pitch.ts";
import { formatDraftPayload, writeDropboxRunLog } from "../src/book-gig/gmail.ts";
import {
  checkGmailReplies,
  dispatchBatchOutreach,
  fetchOutreachCampaigns,
  fetchPendingReplies,
  fetchTemplates,
  fetchVenueMap,
} from "../src/book-gig/outreach_api.ts";
import { renderDarkHtml, renderStatusBadge, SORTING_SCRIPT } from "../src/book-gig/html.ts";
import { openHtmlInBrowser } from "../src/book-gig/browser.ts";
import { formatLocationDisplay, runBookGigCli } from "../src/book-gig/cli.ts";
import type {
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
