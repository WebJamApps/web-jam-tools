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
import {
  checkGmailReplies,
  dispatchBatchOutreach,
  fetchOutreachCampaigns,
  fetchPendingReplies,
  fetchVenueMap,
} from "../src/book-gig/outreach_api.ts";
import { renderDarkHtml, renderStatusBadge } from "../src/book-gig/html.ts";
import { runBookGigCli } from "../src/book-gig/cli.ts";
import type {
  CandidateVenue,
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

Deno.test("parseBookGigArgs: splits CLI arguments and extracts --send / --replies flags", () => {
  const res1 = parseBookGigArgs(["Oct", "16-18", "2026", "Lynchburg,", "VA"]);
  assertEquals(res1.mode, "preview");
  assertEquals(res1.weekend?.start, "2026-10-16");
  assertEquals(res1.location?.city, "Lynchburg");

  const res2 = parseBookGigArgs(["2026-10-16", "24502"]);
  assertEquals(res2.mode, "preview");
  assertEquals(res2.weekend?.start, "2026-10-16");
  assertEquals(res2.location?.zip, "24502");

  const res3 = parseBookGigArgs(["--send", "Oct 16-18 2026", "Lynchburg, VA"]);
  assertEquals(res3.mode, "send");
  assertEquals(res3.weekend?.start, "2026-10-16");
  assertEquals(res3.location?.city, "Lynchburg");

  const res4 = parseBookGigArgs(["--replies", "Oct 16-18 2026"]);
  assertEquals(res4.mode, "replies");
  assertEquals(res4.weekend?.start, "2026-10-16");

  const res5 = parseBookGigArgs(["--check-replies"]);
  assertEquals(res5.mode, "replies");
  assertEquals(res5.weekend, undefined);

  const res6 = parseBookGigArgs([]);
  assertEquals(res6.mode, "preview");
  assertEquals(res6.weekend, undefined);
  assertEquals(res6.location, undefined);
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

  // Discovery mode (default)
  const resultDiscovery = await runBookGigCli(["Oct 16-18 2026", "Salem, VA"], mockFetch);
  assertEquals(resultDiscovery.mode, "preview");
  assertEquals(resultDiscovery.weekend?.start, "2026-10-16");
  assertEquals(resultDiscovery.candidates.length, 1);
  assertEquals(resultDiscovery.pitches.length, 1);

  // Batch send mode (--send)
  const resultSend = await runBookGigCli(["--send", "Oct 16-18 2026", "Salem, VA"], mockFetch);
  assertEquals(resultSend.mode, "send");
  assertEquals(resultSend.batchDispatch?.sent, 1);
  assertEquals(resultSend.batchDispatch?.requested, 1);

  // Replies tracking mode (--replies)
  const resultReplies = await runBookGigCli(["--replies", "Oct 16-18 2026"], mockFetch);
  assertEquals(resultReplies.mode, "replies");
  assertEquals(resultReplies.repliesTracking?.checkReplies.matched, 1);
  assertEquals(resultReplies.repliesTracking?.campaigns.length, 1);
  assertEquals(resultReplies.repliesTracking?.pendingReplies.length, 1);
});
