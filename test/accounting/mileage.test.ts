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
  routingUrls: () => string[];
  backendCalls: () => number;
  geocodeUrls: () => string[];
}

/** Twenty miles, the whole route from home to the venue and back. */
const ROUND_TRIP_METERS = 32186.88;

function stubFetch(
  gigs: MileageGig[],
  venues: MileageVenue[],
  routing: "up" | "down" | "stall" = "up",
  roundTripMeters: number | ((url: string) => number) = ROUND_TRIP_METERS,
  geocode: "match" | "no-match" | "stall" = "match",
  onRoute: () => Promise<void> = () => Promise.resolve(),
): Stub {
  const routingUrls: string[] = [];
  let backendCalls = 0;
  const geocodeUrls: string[] = [];
  // A body that never finishes: the answer's headers arrive, its JSON never does.
  const stalled = () => new Response(new ReadableStream({ start() {} }));
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(GEOCODER_BASE_URL)) {
      geocodeUrls.push(url);
      if (geocode === "stall") return stalled();
      const addressMatches = geocode === "match" ? [{ coordinates: { x: 5, y: 6 } }] : [];
      return Response.json({ result: { addressMatches } });
    }
    if (url.startsWith(ROUTING_BASE_URL)) {
      routingUrls.push(url);
      await onRoute();
      if (routing === "down") return new Response("unavailable", { status: 503 });
      if (routing === "stall") return new Promise<Response>(() => {});
      const distance = typeof roundTripMeters === "function"
        ? roundTripMeters(url)
        : roundTripMeters;
      return Response.json({ code: "Ok", routes: [{ distance }] });
    }
    backendCalls++;
    if (url === `${BACKEND}/gig`) return Response.json(gigs);
    if (url === `${BACKEND}/venue`) return Response.json(venues);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return {
    fetchFn,
    routingCalls: () => routingUrls.length,
    routingUrls: () => routingUrls,
    backendCalls: () => backendCalls,
    geocodeUrls: () => geocodeUrls,
  };
}

async function booksWithHome(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "mileage-test-" });
  await Deno.writeTextFile(path.join(dir, HOME_POINT_FILE), JSON.stringify(FAKE_HOME));
  return dir;
}

function run(booksDir: string, stub: Stub, now = "2027-01-01T04:59:00Z", lookupTimeoutMs?: number) {
  return runMileage({
    year: 2026,
    booksDir,
    now: new Date(now),
    backendUrl: BACKEND,
    token: "test-token",
    fetchFn: stub.fetchFn,
    lookupTimeoutMs,
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
  assertEquals(lines.map((l) => [l.date, l.destination, l.purpose, l.miles, l.venue]), [
    ["2026-03-14", "The Test Tavern, Testville, Virginia", GIG_PURPOSE, "20.0", "v1"],
    ["2026-05-02", "The Test Tavern, Testville, Virginia", GIG_PURPOSE, "20.0", "v1"],
  ]);
});

Deno.test("mileage: the round trip is one route from home to the venue and back home", async () => {
  const books = await booksWithHome();
  const stub = stubFetch([gig("2026-03-14T23:00:00Z", "v1")], [venue("v1", "The Test Tavern")]);
  await run(books, stub);
  const waypoints = new URL(stub.routingUrls()[0]).pathname.split("/").pop();
  assertEquals(waypoints, "2.5,1.5;3,4;2.5,1.5");
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
  await run(books, stub, "2026-11-23T17:00:00Z");
  assertEquals((await readLog(books)).map((l) => l.date), ["2026-07-24"]);
});

Deno.test("mileage: a gig later today is left out until it has started, and the year is Eastern", async () => {
  const books = await booksWithHome();
  const gigs = [
    // 6:30 pm Eastern on November 24.
    gig("2026-11-24T23:30:00Z", "v1"),
    // 10 pm Eastern on December 31, 2026: already 2027 in UTC.
    gig("2027-01-01T03:00:00Z", "v1"),
  ];
  const venues = [venue("v1", "The Test Tavern")];

  // 9 am Eastern on the day of the gig.
  await run(books, stubFetch(gigs, venues), "2026-11-24T14:00:00Z");
  assertEquals((await readLog(books)).length, 0);

  // 7 pm Eastern, after it started.
  await run(books, stubFetch(gigs, venues), "2026-11-25T00:00:00Z");
  assertEquals((await readLog(books)).map((l) => l.date), ["2026-11-24"]);

  // After the year's last gig, which belongs to 2026 where it was played.
  await run(books, stubFetch(gigs, venues), "2027-01-01T06:00:00Z");
  assertEquals((await readLog(books)).map((l) => l.date), ["2026-11-24", "2026-12-31"]);
});

Deno.test("mileage: every existing line is kept, and a drive Josh added never stands in for a gig", async () => {
  const books = await booksWithHome();
  const destination = "The Test Tavern, Testville, Virginia";
  const pickup = { date: "2026-03-14", destination, purpose: "Equipment pickup", miles: "11.0" };
  await Deno.writeTextFile(
    path.join(books, "mileage-2026.csv"),
    formatMileageLog([
      { date: "2026-02-02", destination: "Music store, Roanoke", purpose: "Strings", miles: "8.0" },
      { date: "2026-02-02", destination: "Music store, Roanoke", purpose: "Strings", miles: "8.0" },
      pickup,
    ]),
  );
  const stub = stubFetch([gig("2026-03-14T23:00:00Z", "v1")], [venue("v1", "The Test Tavern")]);
  await run(books, stub);
  const lines = await readLog(books);
  assertEquals(lines.map((l) => [l.date, l.purpose, l.miles]), [
    ["2026-02-02", "Strings", "8.0"],
    ["2026-02-02", "Strings", "8.0"],
    ["2026-03-14", "Equipment pickup", "11.0"],
    ["2026-03-14", GIG_PURPOSE, "20.0"],
  ]);

  // A second run adds nothing: the gig's line is found by its gig.
  await run(
    books,
    stubFetch([gig("2026-03-14T23:00:00Z", "v1")], [venue("v1", "The Test Tavern")]),
  );
  assertEquals((await readLog(books)).length, 4);
});

Deno.test("mileage: venues sharing a name and city get their own figures", async () => {
  const books = await booksWithHome();
  const north = {
    ...venue("v1", "The Test Tavern"),
    location: { type: "Point", coordinates: [3, 4] },
  };
  const south = {
    ...venue("v2", "The Test Tavern"),
    location: { type: "Point", coordinates: [7, 8] },
  };
  const stub = stubFetch(
    [
      { ...gig("2026-03-14T23:00:00Z", "v1"), _id: "g1" },
      { ...gig("2026-04-14T23:00:00Z", "v2"), _id: "g2" },
      { ...gig("2026-05-14T23:00:00Z", "v1"), _id: "g3" },
    ],
    [north, south],
    "up",
    (url) => (url.includes(";7,8;") ? 2 * ROUND_TRIP_METERS : ROUND_TRIP_METERS),
  );
  await run(books, stub);
  assertEquals(stub.routingCalls(), 2);
  assertEquals((await readLog(books)).map((l) => [l.gig, l.venue, l.miles]), [
    ["g1", "v1", "20.0"],
    ["g2", "v2", "40.0"],
    ["g3", "v1", "20.0"],
  ]);
});

Deno.test("mileage: different figures for one venue are listed for Josh, never carried forward", async () => {
  const books = await booksWithHome();
  const destination = "The Test Tavern, Testville, Virginia";
  // Both were generated at 20.0; Josh corrected the earlier one.
  await Deno.writeTextFile(
    path.join(books, "mileage-2026.csv"),
    formatMileageLog([
      {
        date: "2026-03-14",
        destination,
        purpose: GIG_PURPOSE,
        miles: "42.5",
        gig: "g1",
        venue: "v1",
      },
      {
        date: "2026-04-14",
        destination,
        purpose: GIG_PURPOSE,
        miles: "20.0",
        gig: "g2",
        venue: "v1",
      },
    ]),
  );
  const stub = stubFetch(
    [
      { ...gig("2026-03-14T23:00:00Z", "v1"), _id: "g1" },
      { ...gig("2026-04-14T23:00:00Z", "v1"), _id: "g2" },
      { ...gig("2026-06-20T23:00:00Z", "v1"), _id: "g3" },
    ],
    [venue("v1", "The Test Tavern")],
  );
  const result = await run(books, stub);
  assertEquals(stub.routingCalls(), 0);
  assertEquals((await readLog(books)).map((l) => l.miles), ["42.5", "20.0", ""]);
  assertEquals(result.noMiles.length, 1);
  assertStringIncludes(result.noMiles[0].reason, "different figures for this venue (20.0, 42.5)");
});

Deno.test("mileage: a gig that more than one old line could be leaves those lines as they are", async () => {
  const books = await booksWithHome();
  const destination = "The Test Tavern, Testville, Virginia";
  const before = formatMileageLog([
    { date: "2026-03-14", destination, purpose: GIG_PURPOSE, miles: "20.0" },
    { date: "2026-03-14", destination, purpose: GIG_PURPOSE, miles: "21.0" },
  ]);
  await Deno.writeTextFile(path.join(books, "mileage-2026.csv"), before);
  const stub = stubFetch([gig("2026-03-14T23:00:00Z", "v1")], [venue("v1", "The Test Tavern")]);
  const result = await run(books, stub);
  assertEquals(stub.routingCalls(), 0);
  assertEquals(result.ambiguous.map((a) => a.date), ["2026-03-14"]);
  assertEquals((await readLog(books)).map((l) => [l.miles, l.gig]), [["20.0", ""], ["21.0", ""]]);
});

Deno.test("mileage: a stalled routing or geocoding answer leaves the line for Josh and still writes the log", async () => {
  for (
    const [routing, geocode, reason] of [
      ["stall", "match", "the routing service gave no answer"],
      ["up", "stall", "the venue's street address could not be placed on the map"],
    ] as const
  ) {
    const books = await booksWithHome();
    const pinless = { ...venue("v1", "Pinless", false), address: "1 Main St" };
    const stub = stubFetch(
      [gig("2026-03-14T23:00:00Z", "v1")],
      [pinless],
      routing,
      ROUND_TRIP_METERS,
      geocode,
    );
    const result = await run(books, stub, undefined, 20);
    assertEquals(result.noMiles.map((n) => n.reason), [reason]);
    assertEquals((await readLog(books)).map((l) => l.miles), [""]);
  }
});

Deno.test("mileage: an edit saved during the lookups is kept, and nothing is written", async () => {
  const books = await booksWithHome();
  const logPath = path.join(books, "mileage-2026.csv");
  const edited = formatMileageLog([
    { date: "2026-01-05", destination: "Somewhere", purpose: "Josh's edit", miles: "10.0" },
  ]);
  const stub = stubFetch(
    [gig("2026-03-14T23:00:00Z", "v1")],
    [venue("v1", "The Test Tavern")],
    "up",
    ROUND_TRIP_METERS,
    "match",
    () => Deno.writeTextFile(logPath, edited),
  );
  await assertRejects(
    () => run(books, stub),
    Error,
    "changed while the routes were being looked up",
  );
  assertEquals(await Deno.readTextFile(logPath), edited);
  assertEquals([...Deno.readDirSync(books)].filter((e) => e.name.endsWith(".tmp")), []);
});

Deno.test("mileage: two runs from the same log never overwrite each other's additions", async () => {
  const books = await booksWithHome();
  const logPath = path.join(books, "mileage-2026.csv");
  const snapshot = formatMileageLog([
    { date: "2026-01-05", destination: "Music store", purpose: "Strings", miles: "8.0" },
  ]);
  await Deno.writeTextFile(logPath, snapshot);
  const venues = [venue("v1", "The Test Tavern")];
  // Both runs read the same log, then neither routes until both have reached the lookup.
  let arrived = 0;
  let release = () => {};
  const bothReading = new Promise<void>((resolve) => release = resolve);
  const meet = () => {
    if (++arrived === 2) release();
    return bothReading;
  };
  const first = { ...gig("2026-03-14T23:00:00Z", "v1"), _id: "g-first" };
  const second = { ...gig("2026-05-02T23:00:00Z", "v1"), _id: "g-second" };
  const runs = await Promise.allSettled([
    run(books, stubFetch([first], venues, "up", ROUND_TRIP_METERS, "match", meet)),
    run(books, stubFetch([second], venues, "up", ROUND_TRIP_METERS, "match", meet)),
  ]);

  const published = runs.filter((r) => r.status === "fulfilled");
  const refused = runs.filter((r) => r.status === "rejected");
  assertEquals(published.length, 1);
  assertEquals(refused.length, 1);
  assertStringIncludes(String(refused[0].reason), "changed while the routes were being looked up");
  const winner = runs[0].status === "fulfilled" ? "g-first" : "g-second";
  const loser = winner === "g-first" ? "g-second" : "g-first";
  const lines = await readLog(books);
  assertEquals(lines.filter((l) => l.gig === winner).length, 1);
  assertEquals(lines.filter((l) => l.gig === loser).length, 0);
  assert(lines.some((l) => l.purpose === "Strings"));
  // Neither run leaves its temporary file or the lock behind.
  assertEquals(
    [...Deno.readDirSync(books)].map((e) => e.name).sort(),
    [HOME_POINT_FILE, "mileage-2026.csv"].sort(),
  );
});

Deno.test("mileage: a failed lookup retried after the gig is relinked keeps the figure with the venue it was looked up for", async () => {
  const books = await booksWithHome();
  const tavern = venue("v1", "The Test Tavern");
  const hall: MileageVenue = {
    ...venue("v2", "The Other Hall"),
    location: { type: "Point", coordinates: [7, 8] },
  };
  const thirtyMiles = 48280.32;
  const byVenue = (url: string) => url.includes(";7,8;") ? thirtyMiles : ROUND_TRIP_METERS;
  const atTavern = { ...gig("2026-03-14T23:00:00Z", "v1"), _id: "g1" };

  // The lookup fails while the gig links to the tavern.
  await run(books, stubFetch([atTavern], [tavern, hall], "down"));
  assertEquals((await readLog(books)).map((l) => [l.gig, l.venue, l.miles]), [["g1", "v1", ""]]);

  // The gig is relinked to the hall: the retried line takes the hall, its destination and its miles.
  const atHall = { ...atTavern, venueId: "v2" };
  await run(books, stubFetch([atHall], [tavern, hall], "up", byVenue));
  assertEquals((await readLog(books)).map((l) => [l.gig, l.destination, l.venue, l.miles]), [
    ["g1", "The Other Hall, Testville, Virginia", "v2", "30.0"],
  ]);

  // A later run reuses the hall's figure for the hall and looks the tavern up on its own.
  const laterTavern = { ...gig("2026-05-02T23:00:00Z", "v1"), _id: "g2" };
  const laterHall = { ...gig("2026-06-20T23:00:00Z", "v2"), _id: "g3" };
  const rerun = stubFetch([atHall, laterTavern, laterHall], [tavern, hall], "up", byVenue);
  const result = await run(books, rerun);
  assertEquals(result.lookups, 1);
  assertEquals(rerun.routingUrls().every((u) => u.includes(";3,4;")), true);
  assertEquals((await readLog(books)).map((l) => [l.gig, l.venue, l.miles]), [
    ["g1", "v2", "30.0"],
    ["g2", "v1", "20.0"],
    ["g3", "v2", "30.0"],
  ]);
});

Deno.test("mileage: a blank line changed by hand stays as it is when its gig is relinked", async () => {
  const books = await booksWithHome();
  const tavern = venue("v1", "The Test Tavern");
  const hall = venue("v2", "The Other Hall");
  for (
    const edit of [
      { destination: "Tavern back room", purpose: GIG_PURPOSE },
      { destination: "The Test Tavern, Testville, Virginia", purpose: "Load-in only" },
    ]
  ) {
    const line = { date: "2026-03-14", miles: "", gig: "g1", venue: "v1", ...edit };
    await Deno.writeTextFile(path.join(books, "mileage-2026.csv"), formatMileageLog([line]));
    const stub = stubFetch([{ ...gig("2026-03-14T23:00:00Z", "v2"), _id: "g1" }], [tavern, hall]);
    const result = await run(books, stub);
    assertEquals(stub.routingCalls(), 0);
    assertEquals(result.noMiles.map((n) => n.destination), [edit.destination]);
    assertStringIncludes(result.noMiles[0].reason, "changed by hand");
    assertEquals(await readLog(books), [line]);
  }
});

Deno.test("mileage: each run writes through its own temporary file", async () => {
  const books = await booksWithHome();
  const otherWriter = path.join(books, "mileage-2026.csv.tmp");
  await Deno.writeTextFile(otherWriter, "another run's file");
  await run(
    books,
    stubFetch([gig("2026-03-14T23:00:00Z", "v1")], [venue("v1", "The Test Tavern")]),
  );
  assertEquals(await Deno.readTextFile(otherWriter), "another run's file");
  assertEquals(
    [...Deno.readDirSync(books)].map((e) => e.name).sort(),
    [HOME_POINT_FILE, "mileage-2026.csv", "mileage-2026.csv.tmp"].sort(),
  );
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
        now: new Date("2027-01-01T04:59:00Z"),
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
    gig: "g1",
    venue: "v1",
  };
  assertEquals(parseMileageLog(formatMileageLog([line])), [line]);
});

Deno.test("mileage: a log written before the gig and venue columns still reads", () => {
  assertEquals(
    parseMileageLog("date,destination,purpose,miles\n2026-01-01,Somewhere,Strings,8.0\n"),
    [
      {
        date: "2026-01-01",
        destination: "Somewhere",
        purpose: "Strings",
        miles: "8.0",
        gig: "",
        venue: "",
      },
    ],
  );
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
