// test/book_gig_cooldown.test.ts — Unit tests for book-gig seasonal cooldown holds (web-jam-tools#878)

import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { parseBookGigArgs } from "../src/book-gig/parser.ts";
import {
  executeVenueHold,
  type HoldVenueRecord,
  parseHoldDate,
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
});

// -----------------------------------------------------------------------------
// 2. parseHoldDate Tests
// -----------------------------------------------------------------------------

Deno.test("parseHoldDate: computes resumeBooking at UTC midnight and bookedThrough at previous day end", () => {
  const res = parseHoldDate("2027-01-01");
  assertEquals(res.resumeBooking, "2027-01-01T00:00:00.000Z");
  assertEquals(res.bookedThrough, "2026-12-31T23:59:59.999Z");
  assertEquals(res.eligibleDate, "2027-01-01");
});

Deno.test("parseHoldDate: handles leap year boundary correctly", () => {
  // March 1, 2028 (leap year) -> previous day is Feb 29, 2028
  const res1 = parseHoldDate("2028-03-01");
  assertEquals(res1.resumeBooking, "2028-03-01T00:00:00.000Z");
  assertEquals(res1.bookedThrough, "2028-02-29T23:59:59.999Z");
  assertEquals(res1.eligibleDate, "2028-03-01");

  // Feb 29, 2028 (leap day) -> previous day is Feb 28, 2028
  const res2 = parseHoldDate("2028-02-29");
  assertEquals(res2.resumeBooking, "2028-02-29T00:00:00.000Z");
  assertEquals(res2.bookedThrough, "2028-02-28T23:59:59.999Z");
  assertEquals(res2.eligibleDate, "2028-02-29");
});

Deno.test("parseHoldDate: throws on missing or invalid date inputs", () => {
  assertThrows(
    () => parseHoldDate(""),
    Error,
    "Missing required resume date for --hold",
  );
  assertThrows(
    () => parseHoldDate("someday-in-summer"),
    Error,
    "Invalid date format",
  );
  assertThrows(
    () => parseHoldDate("2027-02-29"), // 2027 is not a leap year
    Error,
    "Invalid calendar date",
  );
  assertThrows(
    () => parseHoldDate("2027-13-01"),
    Error,
    "Month must be 1-12",
  );
  assertThrows(
    () => parseHoldDate("2027-04-31"), // April has 30 days
    Error,
    "Invalid calendar date",
  );
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

Deno.test("resolveHoldVenue: resolves fuzzy substring match", () => {
  // "Tequila's" -> matches "Tequila's Mexican Grill"
  const res = resolveHoldVenue("Tequila's", mockVenues);
  assertEquals(res.success, true);
  if (res.success) {
    assertEquals(res.venue._id, "v-tequila-grill");
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

Deno.test("executeVenueHold: dispatches PATCH /venue/:id with resumeBooking and bookedThrough", async () => {
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
    "Tequila's",
    "2027-01-01",
    { backendUrl: "https://mock.api", token: "test-token" },
    mockFetch,
  );

  assertEquals(result.venueId, "v-tequila-grill");
  assertEquals(result.venueName, "Tequila's Mexican Grill");
  assertEquals(result.resumeBooking, "2027-01-01T00:00:00.000Z");
  assertEquals(result.bookedThrough, "2026-12-31T23:59:59.999Z");
  assertEquals(result.eligibleDate, "2027-01-01");

  const patchCall = calls.find((c) => c.method === "PATCH");
  assertEquals(Boolean(patchCall), true);
  assertEquals(patchCall?.url, "https://mock.api/venue/v-tequila-grill");
  assertEquals(patchCall?.body, {
    resumeBooking: "2027-01-01T00:00:00.000Z",
    bookedThrough: "2026-12-31T23:59:59.999Z",
  });
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

Deno.test("runBookGigCli: executes --hold mode successfully", async () => {
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
            bookedThrough: "2026-12-31T23:59:59.999Z",
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
  assertEquals(res.holdResult?.bookedThrough, "2026-12-31T23:59:59.999Z");
  assertEquals(res.holdResult?.eligibleDate, "2027-01-01");
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
