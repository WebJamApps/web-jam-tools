// test/venue_mining_sweep.test.ts
import { assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  checkCooldown,
  dedupeVenues,
  fetchCvilleMusicEvents,
  fetchSceneThinkEvents,
  type HarvestedVenue,
  isLargeHallOrTheater,
  isLocalArea,
  isLocalCvilleArea,
  isNonMusicEntity,
  loadSourcesRegistry,
  parseStateFromLabel,
  resolveMetro,
  runSweep,
} from "../src/venue-mining/sweep.ts";

Deno.test("isNonMusicEntity correctly classifies non-venues", () => {
  assertEquals(isNonMusicEntity("The Scrappy Elephant"), true);
  assertEquals(isNonMusicEntity("Jefferson Madison Central Library"), true);
  assertEquals(isNonMusicEntity("Monticello Loop Park"), true);
  assertEquals(isNonMusicEntity("RSWA Ivy Solid Waste Recycling Center"), true);
  assertEquals(isNonMusicEntity("First Baptist Church"), true);
  assertEquals(isNonMusicEntity("Sewing & Craft Studio"), true);

  assertEquals(isNonMusicEntity("Eastwood Farm and Winery"), false);
  assertEquals(isNonMusicEntity("Dürty Nelly's"), false);
  assertEquals(isNonMusicEntity("Three Notch'd Craft Kitchen & Brewery"), false);
  assertEquals(isNonMusicEntity("The Bebedero"), false);
});

Deno.test("isLargeHallOrTheater identifies TSM leads (arenas/theaters)", () => {
  assertEquals(isLargeHallOrTheater("The Paramount Theater"), true);
  assertEquals(isLargeHallOrTheater("The Jefferson Theater"), true);
  assertEquals(isLargeHallOrTheater("Ting Pavilion"), true);
  assertEquals(isLargeHallOrTheater("John Paul Jones Arena"), true);
  assertEquals(isLargeHallOrTheater("Roanoke Civic Center Coliseum"), true);
  assertEquals(isLargeHallOrTheater("Salem Civic Center"), true);

  assertEquals(isLargeHallOrTheater("Albemarle Ciderworks"), false);
  assertEquals(isLargeHallOrTheater("Firefly"), false);
  assertEquals(isLargeHallOrTheater("Pro Re Nata Farm Brewery"), false);
});

Deno.test("parseStateFromLabel extracts state code from metro label", () => {
  assertEquals(parseStateFromLabel("Charlottesville VA"), "VA");
  assertEquals(parseStateFromLabel("Winston-Salem NC"), "NC");
  assertEquals(parseStateFromLabel("Lewisburg WV"), "WV");
  assertEquals(parseStateFromLabel("Bristol VA-TN / Tri-Cities"), "VA-TN");
  assertEquals(parseStateFromLabel("Unknown Location"), null);
});

Deno.test("isLocalArea correctly filters geographic bounds across metros", () => {
  const cvilleMetro = {
    slug: "charlottesville",
    label: "Charlottesville VA",
    coverageArea: ["charlottesville", "crozet", "keswick", "north garden", "earlysville"],
  };

  assertEquals(isLocalArea("Charlottesville", "VA", cvilleMetro), true);
  assertEquals(isLocalArea("Crozet", "VA", cvilleMetro), true);
  assertEquals(isLocalArea("Keswick", "VA", cvilleMetro), true);
  assertEquals(isLocalArea("North Garden", "VA", cvilleMetro), true);
  // Non-matching state
  assertEquals(isLocalArea("Charlottesville", "NC", cvilleMetro), false);
  assertEquals(
    isLocalArea("Lowell", "MA", { slug: "gastonia", label: "Gastonia / Gaston County NC" }),
    false,
  );

  // Backward-compatible cville check
  assertEquals(isLocalCvilleArea("Charlottesville", "VA"), true);
  assertEquals(isLocalCvilleArea("Richmond", "VA"), false);
});

Deno.test("checkCooldown evaluates 6-month cooldown status", () => {
  const now = new Date("2026-09-16T00:00:00Z");

  // Null date = not locked
  assertEquals(checkCooldown(null, now).isLocked, false);

  // Old date (8 months ago) = not locked
  assertEquals(checkCooldown("2026-01-01", now).isLocked, false);

  // Recent date (2 days ago) = locked
  const recent = checkCooldown("2026-09-14", now);
  assertEquals(recent.isLocked, true);
  assertEquals(recent.daysRemaining > 0, true);
  assertExists(recent.unlockDate);
});

Deno.test("loadSourcesRegistry and resolveMetro lookup metros correctly", async () => {
  const registry = await loadSourcesRegistry();
  assertExists(registry.metros);
  assertEquals(registry.metros.length > 0, true);

  const cville = resolveMetro("charlottesville", registry);
  assertExists(cville);
  assertEquals(cville.slug, "charlottesville");

  const roanoke = resolveMetro("Roanoke / Salem VA", registry);
  assertExists(roanoke);
  assertEquals(roanoke.slug, "roanoke-salem");

  const unknown = resolveMetro("non-existent-city", registry);
  assertEquals(unknown, null);
});

Deno.test("dedupeVenues excludes existing DB venues by name", () => {
  const harvested: HarvestedVenue[] = [
    { name: "The Southern Cafe & Music Hall", eventCount: 10, events: [] },
    { name: "Eastwood Farm and Winery", eventCount: 5, events: [] },
    { name: "Dürty Nelly's", eventCount: 8, events: [] },
  ];

  const dbNames = ["The Southern Cafe & Music Hall", "Pale Fire Brewing Co."];
  const result = dedupeVenues(harvested, dbNames);

  assertEquals(result.length, 2);
  assertEquals(result.map((v) => v.name), ["Eastwood Farm and Winery", "Dürty Nelly's"]);
});

Deno.test("fetchSceneThinkEvents aggregates events from mocked JSON API", async () => {
  const mockPayload = {
    pages: 1,
    events: [
      {
        _source: {
          name: "Bluegrass Friday",
          starttime: "2026-09-20T18:00:00.000-04:00",
          venue: {
            name: "Mock Brewery",
            address: "123 Main St",
            city: "Charlottesville",
            state: "VA",
            zip: "22902",
            phone: "434-555-0100",
            url: "https://mockbrewery.com",
          },
        },
      },
      {
        _source: {
          name: "Acoustic Saturday",
          starttime: "2026-09-21T19:00:00.000-04:00",
          venue: {
            name: "Mock Brewery",
            address: "123 Main St",
            city: "Charlottesville",
            state: "VA",
            zip: "22902",
            phone: "434-555-0100",
            url: "https://mockbrewery.com",
          },
        },
      },
    ],
  };

  const mockFetch = (_url: string | URL | Request) => {
    return Promise.resolve(new Response(JSON.stringify(mockPayload), { status: 200 }));
  };

  const venues = await fetchSceneThinkEvents(
    "http://mock.com/search.json",
    mockFetch as unknown as typeof fetch,
    1,
  );
  assertEquals(venues.length, 1);
  assertEquals(venues[0].name, "Mock Brewery");
  assertEquals(venues[0].eventCount, 2);
  assertEquals(venues[0].events.length, 2);
  assertEquals(venues[0].events[0].title, "Bluegrass Friday");

  // Also check backwards-compatible alias
  const cvilleVenues = await fetchCvilleMusicEvents(mockFetch as unknown as typeof fetch, 1);
  assertEquals(cvilleVenues.length, 1);
});

Deno.test("runSweep exercises full pipeline and enforces cooldown unless forced", async () => {
  const mockPayload = {
    pages: 1,
    events: [
      {
        _source: {
          name: "Live Duo",
          starttime: "2026-09-20T18:00:00.000-04:00",
          venue: {
            name: "Local Taproom",
            address: "100 Main St",
            city: "Charlottesville",
            state: "VA",
            zip: "22902",
            phone: "434-555-0100",
            url: "https://localtaproom.com",
          },
        },
      },
      {
        _source: {
          name: "Big Arena Concert",
          starttime: "2026-09-21T18:00:00.000-04:00",
          venue: {
            name: "Huge Coliseum",
            address: "200 Arena Dr",
            city: "Charlottesville",
            state: "VA",
            zip: "22902",
          },
        },
      },
    ],
  };

  const mockFetch = (url: string | URL | Request) => {
    const urlStr = url.toString();
    if (urlStr.includes("/venue")) {
      return Promise.resolve(
        new Response(JSON.stringify([{ name: "Existing Bar" }]), { status: 200 }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify(mockPayload), { status: 200 }));
  };

  // When cooldown is active (e.g. lastSwept = 2026-09-16), running without force fails
  await assertRejects(
    () =>
      runSweep({
        metro: "charlottesville",
        fetchFn: mockFetch as unknown as typeof fetch,
        pageLimit: 1,
      }),
    Error,
    "6-month cooldown active",
  );

  // Running with force: true succeeds
  const res = await runSweep({
    metro: "charlottesville",
    force: true,
    fetchFn: mockFetch as unknown as typeof fetch,
    pageLimit: 1,
  });

  assertEquals(res.rawCount, 2);
  assertEquals(res.candidates.length, 1);
  assertEquals(res.candidates[0].name, "Local Taproom");
  assertEquals(res.tsmLeads.length, 1);
  assertEquals(res.tsmLeads[0].name, "Huge Coliseum");
});
