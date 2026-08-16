// test/book_gig.test.ts — Unit tests for /book-gig skill and CLI

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { parseBookGigArgs, parseLocation, parseTargetWeekend } from "../src/book-gig/parser.ts";
import {
  assessDensity,
  fetchCandidates,
  filterAndRankCandidates,
} from "../src/book-gig/candidates.ts";
import { BANNED_VOICE_WORDS, renderPitch, validateVoiceRules } from "../src/book-gig/pitch.ts";
import { formatDraftPayload, writeDropboxRunLog } from "../src/book-gig/gmail.ts";
import { runBookGigCli } from "../src/book-gig/cli.ts";
import type { CandidateVenue, TargetWeekend } from "../src/book-gig/types.ts";

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

Deno.test("parseBookGigArgs: splits CLI arguments correctly", () => {
  const res1 = parseBookGigArgs(["Oct", "16-18", "2026", "Lynchburg,", "VA"]);
  assertEquals(res1.weekend?.start, "2026-10-16");
  assertEquals(res1.location?.city, "Lynchburg");

  const res2 = parseBookGigArgs(["2026-10-16", "24502"]);
  assertEquals(res2.weekend?.start, "2026-10-16");
  assertEquals(res2.location?.zip, "24502");

  const res3 = parseBookGigArgs([]);
  assertEquals(res3.weekend, undefined);
  assertEquals(res3.location, undefined);
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

  assertEquals(filtered.length, 3);
  assertEquals(filtered[0].name, "Waterman's Grill"); // Direct city match
  assertEquals(filtered[1].name, "Apocalypse Ale Works"); // Same state / neighboring
  assertEquals(filtered[2].name, "Parkway Brewing"); // Same state / neighboring
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
  assertStringIncludes(pitch.subject, "October 16–18, 2026");
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
  assertStringIncludes(pitch.body, "My wife Maria and I play as Josh and Maria");
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
      weekend,
      candidates: [venue],
      density: { count: 1, isSparse: true, suggestedMetro: "roanoke" },
      pitches: [pitch],
    };
    const logPath = await writeDropboxRunLog(result, tmpDir);
    assert(logPath !== null);
    const content = await Deno.readTextFile(logPath);
    assertStringIncludes(content, "Parkway Brewing");
    assertStringIncludes(content, "October 16–18, 2026");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
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

  // Bare array response
  const mockFetch1: typeof fetch = (_url: string | URL | Request) => {
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

Deno.test("runBookGigCli: executes CLI successfully", async () => {
  const result = await runBookGigCli(["Oct 16-18 2026", "Lynchburg, VA"]);
  assertEquals(result.weekend.start, "2026-10-16");
  assertEquals(result.location?.city, "Lynchburg");
});
