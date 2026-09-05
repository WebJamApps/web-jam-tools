// test/book_gig_cooldown.test.ts — Unit tests for book-gig seasonal cooldown holds (web-jam-tools#878)

import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { parseBookGigArgs } from "../src/book-gig/parser.ts";
import {
  executeVenueHold,
  type HoldVenueRecord,
  parseBookedThroughDate,
  parseHoldDate,
  parseResumeBookingDate,
  resolveHoldVenue,
} from "../src/book-gig/cooldown.ts";
import { runBookGigCli } from "../src/book-gig/cli.ts";

// -----------------------------------------------------------------------------
// 1. Argument Parsing Tests
// -----------------------------------------------------------------------------

Deno.test("parseBookGigArgs: parses --hold and --until flags", () => {
  const parsed = parseBookGigArgs(["--hold", "Tequila's", "--until", "2027-01-01"]);
  assertEquals(parsed.mode, "hold");
  assertEquals(parsed.holdVenue, "Tequila's");
  assertEquals(parsed.holdUntil, "2027-01-01");
  assertEquals(parsed.bookedThrough, undefined);
});

Deno.test("parseBookGigArgs: parses --venue and --booked-through flags", () => {
  const parsed = parseBookGigArgs([
    "--venue",
    "Olde Salem Brewing",
    "--booked-through",
    "2026-12-31",
  ]);
  assertEquals(parsed.mode, "hold");
  assertEquals(parsed.holdVenue, "Olde Salem Brewing");
  assertEquals(parsed.holdUntil, undefined);
  assertEquals(parsed.bookedThrough, "2026-12-31");
});

Deno.test("parseBookGigArgs: parses both --until and --booked-through flags", () => {
  const parsed = parseBookGigArgs([
    "--hold",
    "Olde Salem Brewing",
    "--until",
    "2027-01-01",
    "--booked-through",
    "2026-12-31",
  ]);
  assertEquals(parsed.mode, "hold");
  assertEquals(parsed.holdVenue, "Olde Salem Brewing");
  assertEquals(parsed.holdUntil, "2027-01-01");
  assertEquals(parsed.bookedThrough, "2026-12-31");
});

Deno.test("parseBookGigArgs: parses positional venue with --booked-through flag", () => {
  const parsed = parseBookGigArgs(["--booked-through", "2026-12-31", "Olde Salem Brewing"]);
  assertEquals(parsed.mode, "hold");
  assertEquals(parsed.holdVenue, "Olde Salem Brewing");
  assertEquals(parsed.holdUntil, undefined);
  assertEquals(parsed.bookedThrough, "2026-12-31");
});

Deno.test("parseBookGigArgs: parses --hold and --resume with equals syntax", () => {
  const parsed = parseBookGigArgs(["--hold=64b123456789", "--resume=2027-01-01"]);
  assertEquals(parsed.mode, "hold");
  assertEquals(parsed.holdVenue, "64b123456789");
  assertEquals(parsed.holdUntil, "2027-01-01");
});

Deno.test("parseBookGigArgs: parses --resume before --hold", () => {
  const parsed = parseBookGigArgs(["--resume", "2027-01-01", "--hold", "The Spot on Kirk"]);
  assertEquals(parsed.mode, "hold");
  assertEquals(parsed.holdVenue, "The Spot on Kirk");
  assertEquals(parsed.holdUntil, "2027-01-01");
});

Deno.test("parseBookGigArgs: parses positional venue with --until flag", () => {
  const parsed = parseBookGigArgs(["--until", "2027-01-01", "Tequila's"]);
  assertEquals(parsed.mode, "hold");
  assertEquals(parsed.holdVenue, "Tequila's");
  assertEquals(parsed.holdUntil, "2027-01-01");
});

Deno.test("parseBookGigArgs: parses --hold without until as hold mode", () => {
  const parsed = parseBookGigArgs(["--hold", "Tequila's"]);
  assertEquals(parsed.mode, "hold");
  assertEquals(parsed.holdVenue, "Tequila's");
  assertEquals(parsed.holdUntil, undefined);
  assertEquals(parsed.bookedThrough, undefined);
});

// -----------------------------------------------------------------------------
// 2. Date Parsing Tests
// -----------------------------------------------------------------------------

Deno.test("parseResumeBookingDate: formats UTC midnight string", () => {
  const res = parseResumeBookingDate("2027-01-01");
  assertEquals(res, "2027-01-01T00:00:00.000Z");
});

Deno.test("parseBookedThroughDate: formats UTC end-of-day string", () => {
  const res = parseBookedThroughDate("2026-12-31");
  assertEquals(res, "2026-12-31T23:59:59.999Z");
});

Deno.test("parseResumeBookingDate & parseBookedThroughDate: handles leap year boundary correctly", () => {
  // Leap day in leap year 2028
  const res1 = parseResumeBookingDate("2028-02-29");
  assertEquals(res1, "2028-02-29T00:00:00.000Z");

  const res2 = parseBookedThroughDate("2028-02-29");
  assertEquals(res2, "2028-02-29T23:59:59.999Z");
});

Deno.test("parseResumeBookingDate & parseBookedThroughDate: throws on invalid calendar dates", () => {
  assertThrows(() => parseResumeBookingDate(""), Error, "Missing required resume date");
  assertThrows(
    () => parseBookedThroughDate(""),
    Error,
    "Missing required date for --booked-through",
  );
  assertThrows(() => parseResumeBookingDate("someday-in-summer"), Error, "Invalid date format");
  assertThrows(() => parseBookedThroughDate("someday-in-summer"), Error, "Invalid date format");
  assertThrows(() => parseResumeBookingDate("2027-02-29"), Error, "Invalid calendar date"); // 2027 is not leap year
  assertThrows(() => parseBookedThroughDate("2027-02-29"), Error, "Invalid calendar date");
  assertThrows(() => parseResumeBookingDate("2027-13-01"), Error, "Month must be 1-12");
  assertThrows(() => parseBookedThroughDate("2027-13-01"), Error, "Month must be 1-12");
  assertThrows(() => parseResumeBookingDate("2027-04-31"), Error, "Invalid calendar date"); // April has 30 days
  assertThrows(() => parseBookedThroughDate("2027-04-31"), Error, "Invalid calendar date");
});

Deno.test("parseHoldDate: legacy helper still computes both fields", () => {
  const res = parseHoldDate("2027-01-01");
  assertEquals(res.resumeBooking, "2027-01-01T00:00:00.000Z");
  assertEquals(res.bookedThrough, "2026-12-31T23:59:59.999Z");
  assertEquals(res.eligibleDate, "2027-01-01");
});

// -----------------------------------------------------------------------------
// 3. resolveHoldVenue Tests
// -----------------------------------------------------------------------------

const mockVenues: HoldVenueRecord[] = [
  { _id: "v-spot", name: "The Spot on Kirk", city: "Roanoke", usState: "VA" },
  { _id: "v-tequila-grill", name: "Tequila's Mexican Grill", city: "Roanoke", usState: "VA" },
  { _id: "v-olde-salem", name: "Olde Salem Brewing Company", city: "Salem", usState: "VA" },
  { _id: "v-chateau", name: "Château Morrisette Winery", city: "Floyd", usState: "VA" },
];

Deno.test("resolveHoldVenue: resolves exact ID match", () => {
  const res = resolveHoldVenue("v-spot", mockVenues);
  assertEquals(res.success, true);
  if (res.success) {
    assertEquals(res.venue._id, "v-spot");
    assertEquals(res.venue.name, "The Spot on Kirk");
  }
});

Deno.test("resolveHoldVenue: resolves exact name match case-insensitively", () => {
  const res = resolveHoldVenue("the spot on kirk", mockVenues);
  assertEquals(res.success, true);
  if (res.success) {
    assertEquals(res.venue._id, "v-spot");
  }
});

Deno.test("resolveHoldVenue: resolves normalized name match (accents / punctuation)", () => {
  // Château vs Chateau
  const res = resolveHoldVenue("Chateau Morrisette Winery", mockVenues);
  assertEquals(res.success, true);
  if (res.success) {
    assertEquals(res.venue._id, "v-chateau");
  }
});

Deno.test("resolveHoldVenue: resolves fuzzy forward substring match (min >= 3 chars)", () => {
  // "Tequila" (7 chars) -> matches "Tequila's Mexican Grill"
  const res1 = resolveHoldVenue("Tequila", mockVenues);
  assertEquals(res1.success, true);
  if (res1.success) {
    assertEquals(res1.venue._id, "v-tequila-grill");
  }

  // "Spot" (4 chars) -> matches "The Spot on Kirk"
  const res2 = resolveHoldVenue("Spot", mockVenues);
  assertEquals(res2.success, true);
  if (res2.success) {
    assertEquals(res2.venue._id, "v-spot");
  }
});

Deno.test("resolveHoldVenue: rejects reverse string containment (query contains venue name)", () => {
  // If query is longer and contains venue name, forward match fails: "The Spot on Kirk with extra words" does NOT match
  const res = resolveHoldVenue("The Spot on Kirk with extra words", mockVenues);
  assertEquals(res.success, false);
  if (!res.success) {
    assertStringIncludes(res.error, "not found in venue database");
  }
});

Deno.test("resolveHoldVenue: rejects queries below 3 characters for fuzzy matching", () => {
  // "Sp" is 2 chars, should not fuzzy match "The Spot on Kirk"
  const res = resolveHoldVenue("Sp", mockVenues);
  assertEquals(res.success, false);
  if (!res.success) {
    assertStringIncludes(res.error, "not found in venue database");
  }
});

Deno.test("resolveHoldVenue: reports ambiguous match with candidate list", () => {
  const ambiguousVenues: HoldVenueRecord[] = [
    { _id: "v1", name: "Tequila's Mexican Grill", city: "Roanoke", usState: "VA" },
    { _id: "v2", name: "Tequila's Cantina & Bar", city: "Lynchburg", usState: "VA" },
  ];
  const res = resolveHoldVenue("Tequila's", ambiguousVenues);
  assertEquals(res.success, false);
  if (!res.success) {
    assertStringIncludes(res.error, "Ambiguous venue query");
    assertEquals(res.candidates?.length, 2);
  }
});

Deno.test("resolveHoldVenue: reports error on unknown venue", () => {
  const res = resolveHoldVenue("Nonexistent Music Hall", mockVenues);
  assertEquals(res.success, false);
  if (!res.success) {
    assertStringIncludes(res.error, 'Venue "Nonexistent Music Hall" not found');
  }
});

// -----------------------------------------------------------------------------
// 4. executeVenueHold Tests
// -----------------------------------------------------------------------------

Deno.test("executeVenueHold: dispatches PATCH with only resumeBooking when untilDate is provided", async () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];

  const mockFetch: typeof fetch = (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    const bodyStr = init?.body ? String(init.body) : undefined;
    const body = bodyStr ? JSON.parse(bodyStr) : undefined;
    calls.push({ url: u, method, body });

    if (u.includes("/venue") && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (u.includes("/venue/v-tequila-grill") && method === "PATCH") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            _id: "v-tequila-grill",
            name: "Tequila's Mexican Grill",
            resumeBooking: "2027-01-01T00:00:00.000Z",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    }

    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const result = await executeVenueHold(
    "Tequila's",
    "2027-01-01",
    { backendUrl: "https://mock.api", token: "test-token" },
    mockFetch,
  );

  assertEquals(result.venueId, "v-tequila-grill");
  assertEquals(result.venueName, "Tequila's Mexican Grill");
  assertEquals(result.resumeBooking, "2027-01-01T00:00:00.000Z");
  assertEquals(result.bookedThrough, undefined);
  assertEquals(result.eligibleDate, "2027-01-01");

  const patchCall = calls.find((c) => c.method === "PATCH");
  assertEquals(Boolean(patchCall), true);
  assertEquals(patchCall?.url, "https://mock.api/venue/v-tequila-grill");
  assertEquals(patchCall?.body, {
    resumeBooking: "2027-01-01T00:00:00.000Z",
  });
});

Deno.test("executeVenueHold: dispatches PATCH with only bookedThrough when bookedThroughDate is provided", async () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];

  const mockFetch: typeof fetch = (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    const bodyStr = init?.body ? String(init.body) : undefined;
    const body = bodyStr ? JSON.parse(bodyStr) : undefined;
    calls.push({ url: u, method, body });

    if (u.includes("/venue") && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (u.includes("/venue/v-olde-salem") && method === "PATCH") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            _id: "v-olde-salem",
            name: "Olde Salem Brewing Company",
            bookedThrough: "2026-12-31T23:59:59.999Z",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    }

    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const result = await executeVenueHold(
    "Olde Salem",
    { bookedThroughDate: "2026-12-31" },
    { backendUrl: "https://mock.api", token: "test-token" },
    mockFetch,
  );

  assertEquals(result.venueId, "v-olde-salem");
  assertEquals(result.venueName, "Olde Salem Brewing Company");
  assertEquals(result.resumeBooking, undefined);
  assertEquals(result.bookedThrough, "2026-12-31T23:59:59.999Z");

  const patchCall = calls.find((c) => c.method === "PATCH");
  assertEquals(Boolean(patchCall), true);
  assertEquals(patchCall?.url, "https://mock.api/venue/v-olde-salem");
  assertEquals(patchCall?.body, {
    bookedThrough: "2026-12-31T23:59:59.999Z",
  });
});

Deno.test("executeVenueHold: dispatches PATCH with both fields when both dates are provided", async () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];

  const mockFetch: typeof fetch = (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    const bodyStr = init?.body ? String(init.body) : undefined;
    const body = bodyStr ? JSON.parse(bodyStr) : undefined;
    calls.push({ url: u, method, body });

    if (u.includes("/venue") && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (u.includes("/venue/v-olde-salem") && method === "PATCH") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            _id: "v-olde-salem",
            name: "Olde Salem Brewing Company",
            resumeBooking: "2027-01-01T00:00:00.000Z",
            bookedThrough: "2026-12-31T23:59:59.999Z",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    }

    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const result = await executeVenueHold(
    "Olde Salem",
    { untilDate: "2027-01-01", bookedThroughDate: "2026-12-31" },
    { backendUrl: "https://mock.api", token: "test-token" },
    mockFetch,
  );

  assertEquals(result.venueId, "v-olde-salem");
  assertEquals(result.resumeBooking, "2027-01-01T00:00:00.000Z");
  assertEquals(result.bookedThrough, "2026-12-31T23:59:59.999Z");
  assertEquals(result.eligibleDate, "2027-01-01");

  const patchCall = calls.find((c) => c.method === "PATCH");
  assertEquals(patchCall?.body, {
    resumeBooking: "2027-01-01T00:00:00.000Z",
    bookedThrough: "2026-12-31T23:59:59.999Z",
  });
});

Deno.test("executeVenueHold: throws error when no dates are provided", async () => {
  await assertRejects(
    async () => {
      await executeVenueHold("v-spot", {});
    },
    Error,
    "Missing required date for venue hold",
  );
});

Deno.test("executeVenueHold: throws error on ambiguous venue", async () => {
  const ambiguousVenues: HoldVenueRecord[] = [
    { _id: "v1", name: "Tequila's Bar", city: "Roanoke", usState: "VA" },
    { _id: "v2", name: "Tequila's Grill", city: "Salem", usState: "VA" },
  ];

  const mockFetch: typeof fetch = (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    if (u.includes("/venue") && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify(ambiguousVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  await assertRejects(
    async () => {
      await executeVenueHold(
        "Tequila's",
        "2027-01-01",
        { backendUrl: "https://mock.api", token: "test-token" },
        mockFetch,
      );
    },
    Error,
    "Ambiguous venue query",
  );
});

Deno.test("executeVenueHold: throws error on unknown venue", async () => {
  const mockFetch: typeof fetch = (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    if (u.includes("/venue") && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  await assertRejects(
    async () => {
      await executeVenueHold(
        "Unknown Venue",
        "2027-01-01",
        { backendUrl: "https://mock.api", token: "test-token" },
        mockFetch,
      );
    },
    Error,
    'Venue "Unknown Venue" not found',
  );
});

Deno.test("executeVenueHold: throws error when PATCH fails", async () => {
  const mockFetch: typeof fetch = (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    if (u.includes("/venue") && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/venue/v-spot") && method === "PATCH") {
      return Promise.resolve(
        new Response("Internal Server Error", {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  await assertRejects(
    async () => {
      await executeVenueHold(
        "v-spot",
        "2027-01-01",
        { backendUrl: "https://mock.api", token: "test-token" },
        mockFetch,
      );
    },
    Error,
    "Failed to update venue v-spot: HTTP 500",
  );
});

// -----------------------------------------------------------------------------
// 5. runBookGigCli Tests in Hold Mode
// -----------------------------------------------------------------------------

Deno.test("runBookGigCli: executes --hold mode with --until successfully", async () => {
  const mockFetch: typeof fetch = (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    if (u.includes("/venue") && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/venue/v-tequila-grill") && method === "PATCH") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            _id: "v-tequila-grill",
            name: "Tequila's Mexican Grill",
            resumeBooking: "2027-01-01T00:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const res = await runBookGigCli(
    ["--hold", "Tequila's", "--until", "2027-01-01"],
    mockFetch,
  );
  assertEquals(res.mode, "hold");
  assertEquals(res.holdResult?.venueId, "v-tequila-grill");
  assertEquals(res.holdResult?.venueName, "Tequila's Mexican Grill");
  assertEquals(res.holdResult?.resumeBooking, "2027-01-01T00:00:00.000Z");
  assertEquals(res.holdResult?.bookedThrough, undefined);
  assertEquals(res.holdResult?.eligibleDate, "2027-01-01");
});

Deno.test("runBookGigCli: executes --venue with --booked-through successfully", async () => {
  const mockFetch: typeof fetch = (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    if (u.includes("/venue") && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/venue/v-olde-salem") && method === "PATCH") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            _id: "v-olde-salem",
            name: "Olde Salem Brewing Company",
            bookedThrough: "2026-12-31T23:59:59.999Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const res = await runBookGigCli(
    ["--venue", "Olde Salem", "--booked-through", "2026-12-31"],
    mockFetch,
  );
  assertEquals(res.mode, "hold");
  assertEquals(res.holdResult?.venueId, "v-olde-salem");
  assertEquals(res.holdResult?.venueName, "Olde Salem Brewing Company");
  assertEquals(res.holdResult?.resumeBooking, undefined);
  assertEquals(res.holdResult?.bookedThrough, "2026-12-31T23:59:59.999Z");
});

Deno.test("runBookGigCli: executes with both --until and --booked-through", async () => {
  const mockFetch: typeof fetch = (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    if (u.includes("/venue") && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify(mockVenues), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/venue/v-olde-salem") && method === "PATCH") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            _id: "v-olde-salem",
            name: "Olde Salem Brewing Company",
            resumeBooking: "2027-01-01T00:00:00.000Z",
            bookedThrough: "2026-12-31T23:59:59.999Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const res = await runBookGigCli(
    [
      "--hold",
      "Olde Salem",
      "--until",
      "2027-01-01",
      "--booked-through",
      "2026-12-31",
    ],
    mockFetch,
  );
  assertEquals(res.mode, "hold");
  assertEquals(res.holdResult?.venueId, "v-olde-salem");
  assertEquals(res.holdResult?.resumeBooking, "2027-01-01T00:00:00.000Z");
  assertEquals(res.holdResult?.bookedThrough, "2026-12-31T23:59:59.999Z");
});

Deno.test("runBookGigCli: handles --hold with missing resume date", async () => {
  const mockFetch: typeof fetch = () => Promise.resolve(new Response("[]", { status: 200 }));
  await assertRejects(
    async () => {
      await runBookGigCli(["--hold", "Tequila's"], mockFetch);
    },
    Error,
    "Missing resume date for --hold",
  );
});

Deno.test("runBookGigCli: handles --until with missing venue identifier", async () => {
  const mockFetch: typeof fetch = () => Promise.resolve(new Response("[]", { status: 200 }));
  await assertRejects(
    async () => {
      await runBookGigCli(["--until", "2027-01-01"], mockFetch);
    },
    Error,
    "Missing venue identifier for --hold",
  );
});
