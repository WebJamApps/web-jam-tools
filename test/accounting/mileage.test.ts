// test/accounting/mileage.test.ts
// The mileage log from the gig list (web-jam-tools#1767). Every gig, venue and routing answer here
// is stubbed, and the home map point is a made-up one written to a temporary books folder.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import {
  formatMileageLog,
  GEOCODER_BASE_URL,
  GIG_PURPOSE,
  gigLocalDate,
  HOME_POINT_FILE,
  type MileageGig,
  type MileageVenue,
  parseMileageLog,
  ROUTING_BASE_URL,
  runMileage,
} from "../../src/accounting/mileage.ts";

const BACKEND = "https://backend.test";
const FAKE_HOME = { latitude: 1.5, longitude: 2.5 };

function venue(id: string, name: string, pin = true): MileageVenue {
  return {
    _id: id,
    name,
    city: "Testville",
    usState: "Virginia",
    ...(pin ? { location: { type: "Point", coordinates: [3, 4] } } : {}),
  };
}

function gig(datetime: string, venueId?: string, venueText = ""): MileageGig {
  return { datetime, venue: venueText, city: "Testville", usState: "Virginia", venueId };
}

interface Stub {
  fetchFn: typeof fetch;
  routingCalls: () => number;
  backendCalls: () => number;
  geocodeUrls: () => string[];
}

function stubFetch(
  gigs: MileageGig[],
  venues: MileageVenue[],
  routing: "up" | "down" = "up",
  oneWayMeters = 16093.44,
  geocode: "match" | "no-match" = "match",
): Stub {
  let routingCalls = 0;
  let backendCalls = 0;
  const geocodeUrls: string[] = [];
  const fetchFn = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(GEOCODER_BASE_URL)) {
      geocodeUrls.push(url);
      const addressMatches = geocode === "match" ? [{ coordinates: { x: 5, y: 6 } }] : [];
      return Promise.resolve(Response.json({ result: { addressMatches } }));
    }
    if (url.startsWith(ROUTING_BASE_URL)) {
      routingCalls++;
      if (routing === "down") return Promise.resolve(new Response("unavailable", { status: 503 }));
      return Promise.resolve(Response.json({ code: "Ok", routes: [{ distance: oneWayMeters }] }));
    }
    backendCalls++;
    if (url === `${BACKEND}/gig`) return Promise.resolve(Response.json(gigs));
    if (url === `${BACKEND}/venue`) return Promise.resolve(Response.json(venues));
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
  return {
    fetchFn,
    routingCalls: () => routingCalls,
    backendCalls: () => backendCalls,
    geocodeUrls: () => geocodeUrls,
  };
}

async function booksWithHome(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "mileage-test-" });
  await Deno.writeTextFile(path.join(dir, HOME_POINT_FILE), JSON.stringify(FAKE_HOME));
  return dir;
}

function run(booksDir: string, stub: Stub, today = "2026-12-31") {
  return runMileage({
    year: 2026,
    booksDir,
    today,
    backendUrl: BACKEND,
    token: "test-token",
    fetchFn: stub.fetchFn,
  });
}

async function readLog(booksDir: string) {
  return parseMileageLog(await Deno.readTextFile(path.join(booksDir, "mileage-2026.csv")));
}

Deno.test("mileage: a venue seen twice is looked up once and each line holds the round trip", async () => {
  const books = await booksWithHome();
  const stub = stubFetch(
    [gig("2026-03-14T23:00:00Z", "v1"), gig("2026-05-02T23:00:00Z", "v1")],
    [venue("v1", "The Test Tavern")],
  );
  const result = await run(books, stub);

  assertEquals(stub.routingCalls(), 1);
  assertEquals(result.lookups, 1);
  const lines = await readLog(books);
  assertEquals(lines.map((l) => [l.date, l.destination, l.purpose, l.miles]), [
    ["2026-03-14", "The Test Tavern, Testville, Virginia", GIG_PURPOSE, "20.0"],
    ["2026-05-02", "The Test Tavern, Testville, Virginia", GIG_PURPOSE, "20.0"],
  ]);
});

Deno.test("mileage: a corrected figure in the log is kept and reused, with no lookup", async () => {
  const books = await booksWithHome();
  const destination = "The Test Tavern, Testville, Virginia";
  await Deno.writeTextFile(
    path.join(books, "mileage-2026.csv"),
    formatMileageLog([
      { date: "2026-03-14", destination, purpose: GIG_PURPOSE, miles: "42.5" },
      { date: "2026-04-01", destination: "Music store, Roanoke", purpose: "Strings", miles: "8.0" },
    ]),
  );
  const stub = stubFetch(
    [gig("2026-03-14T23:00:00Z", "v1"), gig("2026-06-20T23:00:00Z", "v1")],
    [venue("v1", "The Test Tavern")],
  );
  const result = await run(books, stub);

  assertEquals(stub.routingCalls(), 0);
  assertEquals(result.lookups, 0);
  const lines = await readLog(books);
  assertEquals(lines.map((l) => [l.date, l.destination, l.miles]), [
    ["2026-03-14", destination, "42.5"],
    ["2026-04-01", "Music store, Roanoke", "8.0"],
    ["2026-06-20", destination, "42.5"],
  ]);
});

Deno.test("mileage: a gig with no venue record is listed for Josh with no miles", async () => {
  const books = await booksWithHome();
  const stub = stubFetch(
    [gig("2026-09-12T14:30:00Z", undefined, "<p>Porch &amp; <a href='x'>Festival</a></p>")],
    [venue("v1", "The Test Tavern")],
  );
  const result = await run(books, stub);

  assertEquals(stub.routingCalls(), 0);
  assertEquals(result.noVenueRecord.length, 1);
  assertEquals(result.noVenueRecord[0].date, "2026-09-12");
  assertEquals(result.noVenueRecord[0].destination, "Porch & Festival, Testville, Virginia");
  const lines = await readLog(books);
  assertEquals(lines.length, 1);
  assertEquals(lines[0].miles, "");
});

Deno.test("mileage: a gig matches its venue by exact normalized name when it has no venueId", async () => {
  const books = await booksWithHome();
  const stub = stubFetch(
    [gig("2026-03-14T23:00:00Z", undefined, "<p><a href='x'>The Test Tavern!</a></p>")],
    [venue("v1", "The Test Tavern")],
  );
  const result = await run(books, stub);
  assertEquals(result.noVenueRecord.length, 0);
  assertEquals((await readLog(books))[0].miles, "20.0");
});

Deno.test("mileage: the routing service down leaves the line for Josh, and a later run fills it", async () => {
  const books = await booksWithHome();
  const gigs = [gig("2026-03-14T23:00:00Z", "v1"), gig("2026-05-02T23:00:00Z", "v1")];
  const venues = [venue("v1", "The Test Tavern")];

  const down = stubFetch(gigs, venues, "down");
  const first = await run(books, down);
  assertEquals(down.routingCalls(), 1);
  assertEquals(first.noMiles.map((n) => n.reason), [
    "the routing service gave no answer",
    "the routing service gave no answer",
  ]);
  assertEquals((await readLog(books)).map((l) => l.miles), ["", ""]);

  const up = stubFetch(gigs, venues, "up");
  const second = await run(books, up);
  assertEquals(up.routingCalls(), 1);
  assertEquals(second.noMiles.length, 0);
  assertEquals((await readLog(books)).map((l) => l.miles), ["20.0", "20.0"]);
});

Deno.test("mileage: a venue with no map pin or address is listed for Josh and not looked up", async () => {
  const books = await booksWithHome();
  const stub = stubFetch([gig("2026-03-14T23:00:00Z", "v1")], [venue("v1", "Pinless", false)]);
  const result = await run(books, stub);
  assertEquals(stub.routingCalls() + stub.geocodeUrls().length, 0);
  assertEquals(result.noMiles[0].reason, "the venue record has no map pin or street address");
});

Deno.test("mileage: a pinless venue is placed once from its street address, then routed", async () => {
  const books = await booksWithHome();
  const pinless = { ...venue("v1", "Pinless", false), address: "1 Main St", zipCode: "24153" };
  const stub = stubFetch(
    [gig("2026-03-14T23:00:00Z", "v1"), gig("2026-04-14T23:00:00Z", "v1")],
    [pinless],
  );
  const result = await run(books, stub);

  assertEquals(stub.geocodeUrls().length, 1);
  const query = new URL(stub.geocodeUrls()[0]).searchParams;
  assertEquals(
    [query.get("street"), query.get("city"), query.get("state"), query.get("zip")],
    ["1 Main St", "Testville", "Virginia", "24153"],
  );
  assertEquals(stub.routingCalls(), 1);
  assertEquals(result.noMiles.length, 0);
  assertEquals((await readLog(books)).map((l) => l.miles), ["20.0", "20.0"]);
});

Deno.test("mileage: an address the geocoder cannot place is listed for Josh, once per venue", async () => {
  const books = await booksWithHome();
  const pinless = { ...venue("v1", "Pinless", false), address: "Nowhere Rd" };
  const stub = stubFetch(
    [gig("2026-03-14T23:00:00Z", "v1"), gig("2026-04-14T23:00:00Z", "v1")],
    [pinless],
    "up",
    16093.44,
    "no-match",
  );
  const result = await run(books, stub);
  assertEquals(stub.geocodeUrls().length, 1);
  assertEquals(stub.routingCalls(), 0);
  assertEquals(result.noMiles.map((n) => n.reason), [
    "the venue's street address could not be placed on the map",
    "the venue's street address could not be placed on the map",
  ]);
});

Deno.test("mileage: only gigs of the year already played are logged, dated where they were played", async () => {
  const books = await booksWithHome();
  const stub = stubFetch(
    [
      gig("2025-12-31T23:00:00Z", "v1"),
      gig("2026-07-25T02:00:00Z", "v1"),
      gig("2026-11-30T23:00:00Z", "v1"),
    ],
    [venue("v1", "The Test Tavern")],
  );
  await run(books, stub, "2026-11-23");
  assertEquals((await readLog(books)).map((l) => l.date), ["2026-07-24"]);
});

Deno.test("mileage: a missing home map point refuses before any network call or write", async () => {
  const books = await Deno.makeTempDir({ prefix: "mileage-test-" });
  const stub = stubFetch([gig("2026-03-14T23:00:00Z", "v1")], [venue("v1", "The Test Tavern")]);
  const err = await assertRejects(() => run(books, stub), Error);
  assertStringIncludes(err.message, HOME_POINT_FILE);
  assertEquals(stub.backendCalls() + stub.routingCalls(), 0);
  await assertRejects(() => Deno.stat(path.join(books, "mileage-2026.csv")), Deno.errors.NotFound);
});

Deno.test("mileage: a home map point out of range is refused", async () => {
  const books = await Deno.makeTempDir({ prefix: "mileage-test-" });
  await Deno.writeTextFile(
    path.join(books, HOME_POINT_FILE),
    JSON.stringify({ latitude: 200, longitude: 2 }),
  );
  const stub = stubFetch([], []);
  await assertRejects(() => run(books, stub), Error, "latitude");
});

Deno.test("mileage: an unreadable venue list refuses and leaves the log untouched", async () => {
  const books = await booksWithHome();
  const logPath = path.join(books, "mileage-2026.csv");
  const before = formatMileageLog([
    { date: "2026-01-05", destination: "Somewhere", purpose: GIG_PURPOSE, miles: "10.0" },
  ]);
  await Deno.writeTextFile(logPath, before);
  const fetchFn = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${BACKEND}/gig`) return Promise.resolve(Response.json([]));
    return Promise.resolve(new Response("expired", { status: 401 }));
  }) as typeof fetch;
  await assertRejects(
    () =>
      runMileage({
        year: 2026,
        booksDir: books,
        today: "2026-12-31",
        backendUrl: BACKEND,
        token: "t",
        fetchFn,
      }),
    Error,
    "venue list",
  );
  assertEquals(await Deno.readTextFile(logPath), before);
});

Deno.test("mileage: a destination holding a comma or quote survives a write and read", () => {
  const line = {
    date: "2026-02-01",
    destination: 'Joe\'s "Place", Salem, Virginia',
    purpose: GIG_PURPOSE,
    miles: "3.2",
  };
  assertEquals(parseMileageLog(formatMileageLog([line])), [line]);
});

Deno.test("mileage: a log with a different first line is refused", () => {
  const err = (() => {
    try {
      parseMileageLog("when,where\n2026-01-01,x\n");
    } catch (e) {
      return e as Error;
    }
  })();
  assert(err);
  assertStringIncludes(err.message, "date,destination,purpose,miles");
});

Deno.test("mileage: gigLocalDate gives the Eastern calendar date and null for no date", () => {
  assertEquals(gigLocalDate("2026-07-25T02:00:00Z"), "2026-07-24");
  assertEquals(gigLocalDate("2026-01-10T17:00:00Z"), "2026-01-10");
  assertEquals(gigLocalDate(undefined), null);
  assertEquals(gigLocalDate("not a date"), null);
});
