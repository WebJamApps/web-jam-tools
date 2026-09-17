// test/venue_mining_sweep.test.ts
import { assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  checkCooldown,
  dedupeVenues,
  fetchSceneThinkEvents,
  type HarvestedVenue,
  harvestEvents,
  isLargeHallOrTheater,
  isLocalArea,
  isNonMusicEntity,
  LARGE_HALL_OR_THEATER_KEYWORDS,
  loadSourcesRegistry,
  NON_MUSIC_ENTITY_KEYWORDS,
  parseStateFromLabel,
  resolveMetro,
  runSweep,
} from "../src/venue-mining/sweep.ts";

const FIXTURE_SOURCES = new URL(
  "./fixtures/venue_mining_sources_fixture.yaml",
  import.meta.url,
).pathname;

Deno.test("isNonMusicEntity correctly classifies non-venues and respects word boundaries", () => {
  // Acceptance criteria:
  assertEquals(isNonMusicEntity("Parkway Brewing Co"), false);
  assertEquals(isNonMusicEntity("Springfield Tavern"), false);
  assertEquals(isNonMusicEntity("Riverside Park"), true);

  // Common entity keywords
  assertEquals(isNonMusicEntity("Jefferson Madison Central Library"), true);
  assertEquals(isNonMusicEntity("First Baptist Church"), true);
  assertEquals(isNonMusicEntity("Sewing & Craft Studio"), true);
  assertEquals(isNonMusicEntity("Botanical Garden Center"), true);

  // Real venues
  assertEquals(isNonMusicEntity("Eastwood Farm and Winery"), false);
  assertEquals(isNonMusicEntity("Dürty Nelly's"), false);
  assertEquals(isNonMusicEntity("Three Notch'd Craft Kitchen & Brewery"), false);
  assertEquals(isNonMusicEntity("The Bebedero"), false);

  // C-VILLE specific keywords removed from shared lists
  const cvilleKeywords = [
    "scrappy elephant",
    "monticello",
    "downtown mall",
    "hall 107",
    "hall 229a",
    "campbell hall",
    "nau hall",
    "bryan hall",
    "jaba",
    "wtju",
  ];
  for (const kw of cvilleKeywords) {
    assertEquals(
      NON_MUSIC_ENTITY_KEYWORDS.includes(kw),
      false,
      `Keyword '${kw}' should not be in NON_MUSIC_ENTITY_KEYWORDS`,
    );
  }
});

Deno.test("isLargeHallOrTheater identifies TSM leads with word boundaries", () => {
  assertEquals(isLargeHallOrTheater("Roanoke Civic Center Coliseum"), true);
  assertEquals(isLargeHallOrTheater("Salem Civic Center"), true);
  assertEquals(isLargeHallOrTheater("Charlottesville Amphitheater"), true);

  // Word boundary prevents false match on substrings (e.g. 'arena' in 'Macarena')
  assertEquals(isLargeHallOrTheater("Macarena Grill"), false);
  assertEquals(isLargeHallOrTheater("Albemarle Ciderworks"), false);
  assertEquals(isLargeHallOrTheater("Firefly"), false);
  assertEquals(isLargeHallOrTheater("Pro Re Nata Farm Brewery"), false);

  // C-VILLE specific keywords removed from shared lists
  const cvilleLargeKeywords = [
    "paramount theater",
    "jefferson theater",
    "ting pavilion",
    "john paul jones",
    "old cabell hall",
  ];
  for (const kw of cvilleLargeKeywords) {
    assertEquals(
      LARGE_HALL_OR_THEATER_KEYWORDS.includes(kw),
      false,
      `Keyword '${kw}' should not be in LARGE_HALL_OR_THEATER_KEYWORDS`,
    );
  }
});

Deno.test("parseStateFromLabel extracts state code from metro label", () => {
  assertEquals(parseStateFromLabel("Charlottesville VA"), "VA");
  assertEquals(parseStateFromLabel("Winston-Salem NC"), "NC");
  assertEquals(parseStateFromLabel("Lewisburg WV"), "WV");
  assertEquals(parseStateFromLabel("Bristol VA-TN / Tri-Cities"), "VA-TN");
  assertEquals(parseStateFromLabel("Unknown Location"), null);
});

Deno.test("isLocalArea correctly filters geographic bounds and handles missing states", () => {
  // Acceptance criteria:
  // isLocalArea("Lynchburg", "VA", { slug: "roanoke-salem", label: "Roanoke / Salem VA" }) === false for metro with no coverageArea
  assertEquals(
    isLocalArea("Lynchburg", "VA", { slug: "roanoke-salem", label: "Roanoke / Salem VA" }),
    false,
  );

  // Venue with missing state is not accepted automatically when state is expected
  assertEquals(
    isLocalArea("Roanoke", undefined, { slug: "roanoke-salem", label: "Roanoke / Salem VA" }),
    false,
  );

  // Venue with matching city & state
  assertEquals(
    isLocalArea("Roanoke", "VA", { slug: "roanoke-salem", label: "Roanoke / Salem VA" }),
    true,
  );
  assertEquals(
    isLocalArea("Salem", "VA", { slug: "roanoke-salem", label: "Roanoke / Salem VA" }),
    true,
  );

  // Metro with coverageArea
  const cvilleMetro = {
    slug: "charlottesville",
    label: "Charlottesville VA",
    coverageArea: ["charlottesville", "crozet", "keswick", "north garden", "earlysville"],
  };
  assertEquals(isLocalArea("Charlottesville", "VA", cvilleMetro), true);
  assertEquals(isLocalArea("Crozet", "VA", cvilleMetro), true);
  assertEquals(isLocalArea("Richmond", "VA", cvilleMetro), false);
  assertEquals(isLocalArea("Charlottesville", "NC", cvilleMetro), false);
});

Deno.test("resolveMetro handles exact slugs and labels without false substring matches", async () => {
  const registry = await loadSourcesRegistry(FIXTURE_SOURCES);

  // resolveMetro("salem", registry) returns null
  assertEquals(resolveMetro("salem", registry), null);

  // resolveMetro("roanoke-salem", registry) returns Roanoke entry
  const roanoke = resolveMetro("roanoke-salem", registry);
  assertExists(roanoke);
  assertEquals(roanoke.slug, "roanoke-salem");

  // Exact label match
  const roanokeByLabel = resolveMetro("Roanoke / Salem VA", registry);
  assertExists(roanokeByLabel);
  assertEquals(roanokeByLabel.slug, "roanoke-salem");

  // Unknown returns null
  assertEquals(resolveMetro("nowhere-ville", registry), null);
});

Deno.test("checkCooldown and runSweep cover all three outcomes of cooldown gate", async () => {
  const fixedNow = new Date("2026-09-16T12:00:00Z");

  const mockPayload = {
    pages: 1,
    events: [
      {
        _source: {
          name: "Concert",
          starttime: "2026-09-20T18:00:00Z",
          venue: { name: "Local Pub", city: "Roanoke", state: "VA" },
        },
      },
    ],
  };
  const mockFetch = () =>
    Promise.resolve(new Response(JSON.stringify(mockPayload), { status: 200 }));

  // Outcome 1: locked (lastSwept < 180 days ago) -> refuse unless forced
  const lockedCd = checkCooldown("2026-09-10", fixedNow);
  assertEquals(lockedCd.isLocked, true);
  assertEquals(lockedCd.daysRemaining > 0, true);

  await assertRejects(
    () =>
      runSweep({
        metro: "locked-metro",
        sourcesPath: FIXTURE_SOURCES,
        now: fixedNow,
        fetchFn: mockFetch as unknown as typeof fetch,
        noDedup: true,
      }),
    Error,
    "6-month cooldown active",
  );

  // Force bypasses locked cooldown
  const forcedRes = await runSweep({
    metro: "locked-metro",
    force: true,
    sourcesPath: FIXTURE_SOURCES,
    now: fixedNow,
    fetchFn: mockFetch as unknown as typeof fetch,
    noDedup: true,
  });
  assertEquals(forcedRes.candidates.length, 1);

  // Outcome 2: stale or null -> proceed
  const staleCd = checkCooldown("2025-01-01", fixedNow);
  assertEquals(staleCd.isLocked, false);
  const nullCd = checkCooldown(null, fixedNow);
  assertEquals(nullCd.isLocked, false);

  const staleRes = await runSweep({
    metro: "stale-metro",
    sourcesPath: FIXTURE_SOURCES,
    now: fixedNow,
    fetchFn: mockFetch as unknown as typeof fetch,
    noDedup: true,
  });
  assertEquals(staleRes.candidates.length, 1);

  const nullRes = await runSweep({
    metro: "null-metro",
    sourcesPath: FIXTURE_SOURCES,
    now: fixedNow,
    fetchFn: mockFetch as unknown as typeof fetch,
    noDedup: true,
  });
  assertEquals(nullRes.candidates.length, 1);

  // Outcome 3: unparseable lastSwept -> refuse unless forced
  const unparseableCd = checkCooldown("not-a-valid-date", fixedNow);
  assertEquals(unparseableCd.unparseable, true);

  await assertRejects(
    () =>
      runSweep({
        metro: "unparseable-metro",
        sourcesPath: FIXTURE_SOURCES,
        now: fixedNow,
        fetchFn: mockFetch as unknown as typeof fetch,
        noDedup: true,
      }),
    Error,
    "is unparseable as a date",
  );

  const unparseableForced = await runSweep({
    metro: "unparseable-metro",
    force: true,
    sourcesPath: FIXTURE_SOURCES,
    now: fixedNow,
    fetchFn: mockFetch as unknown as typeof fetch,
    noDedup: true,
  });
  assertEquals(unparseableForced.candidates.length, 1);

  // Missing sources file fails closed and cannot be overridden by --force
  await assertRejects(
    () =>
      runSweep({
        metro: "null-metro",
        sourcesPath: "/tmp/nonexistent-sources.yaml",
        force: true,
      }),
    Error,
    "Failed to read sources file",
  );
});

Deno.test("harvestEvents and runSweep reject publication type other than scenethink", async () => {
  // Direct harvestEvents call
  await assertRejects(
    () => harvestEvents("http://mock.com/calendar", "rss"),
    Error,
    "Unsupported publication type 'rss'",
  );

  // Metro with unsupported publication type
  await assertRejects(
    () =>
      runSweep({
        metro: "unsupported-metro",
        sourcesPath: FIXTURE_SOURCES,
        force: true,
        noDedup: true,
      }),
    Error,
    "unsupported publication type 'html'",
  );

  // Metro with missing publication type
  await assertRejects(
    () =>
      runSweep({
        metro: "missing-type-metro",
        sourcesPath: FIXTURE_SOURCES,
        force: true,
        noDedup: true,
      }),
    Error,
    "with missing type",
  );

  // roanoke-salem has no publication type configured in sources.yaml
  await assertRejects(
    () =>
      runSweep({
        metro: "roanoke-salem",
        sourcesPath: FIXTURE_SOURCES,
        force: true,
        noDedup: true,
      }),
    Error,
    "with missing type",
  );
});

Deno.test("runSweep raises not-found error for unknown metro", async () => {
  await assertRejects(
    () =>
      runSweep({
        metro: "unknown-city",
        sourcesPath: FIXTURE_SOURCES,
      }),
    Error,
    "metro 'unknown-city' not found in sources.yaml",
  );
});

Deno.test("fetchSceneThinkEvents rejects on non-OK response and JSON parse error", async () => {
  // Non-OK HTTP status
  const mockFetch500 = () =>
    Promise.resolve(new Response("Internal Server Error", { status: 500 }));
  await assertRejects(
    () => fetchSceneThinkEvents("http://mock.com/search.json", mockFetch500 as typeof fetch),
    Error,
    "HTTP error 500",
  );

  // Malformed JSON body
  const mockFetchBadJson = () =>
    Promise.resolve(new Response("<html><body>Not JSON</body></html>", { status: 200 }));
  await assertRejects(
    () => fetchSceneThinkEvents("http://mock.com/search.json", mockFetchBadJson as typeof fetch),
    Error,
    "Failed to parse JSON response",
  );

  // Network/connection error
  const mockFetchNetworkErr = () => Promise.reject(new Error("Connection reset"));
  await assertRejects(
    () => fetchSceneThinkEvents("http://mock.com/search.json", mockFetchNetworkErr as typeof fetch),
    Error,
    "Failed to fetch page",
  );
});

Deno.test("fetchSceneThinkEvents excludes events on or before lastSwept incrementally", async () => {
  const mockPayload = {
    pages: 1,
    events: [
      {
        _source: {
          name: "Old Gig 1",
          starttime: "2026-07-01T19:00:00Z",
          venue: { name: "Music Tavern", city: "Roanoke", state: "VA" },
        },
      },
      {
        _source: {
          name: "On LastSwept Gig",
          starttime: "2026-07-02T19:00:00Z",
          venue: { name: "Music Tavern", city: "Roanoke", state: "VA" },
        },
      },
      {
        _source: {
          name: "New Post-Swept Gig",
          starttime: "2026-07-03T19:00:00Z",
          venue: { name: "Music Tavern", city: "Roanoke", state: "VA" },
        },
      },
    ],
  };

  const mockFetch = () =>
    Promise.resolve(new Response(JSON.stringify(mockPayload), { status: 200 }));

  // When lastSwept is "2026-07-02", events on or before 2026-07-02 are excluded
  const venues = await fetchSceneThinkEvents(
    "http://mock.com/search.json",
    mockFetch as typeof fetch,
    1,
    "2026-07-02",
  );

  assertEquals(venues.length, 1);
  assertEquals(venues[0].name, "Music Tavern");
  assertEquals(venues[0].eventCount, 1);
  assertEquals(venues[0].events.length, 1);
  assertEquals(venues[0].events[0].title, "New Post-Swept Gig");
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

Deno.test("runSweep covers all three DB dedup outcomes", async () => {
  const mockEventsPayload = {
    pages: 1,
    events: [
      {
        _source: {
          name: "Live Duo",
          starttime: "2026-09-20T18:00:00Z",
          venue: { name: "New Bar", city: "Roanoke", state: "VA" },
        },
      },
      {
        _source: {
          name: "Existing Show",
          starttime: "2026-09-21T18:00:00Z",
          venue: { name: "Existing Bar", city: "Roanoke", state: "VA" },
        },
      },
    ],
  };

  // Dedup Outcome 1: loads -> dedup against DB
  const mockFetchSuccess = (url: string | URL | Request) => {
    const urlStr = url.toString();
    if (urlStr.includes("/venue")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([{ _id: "v1", name: "Existing Bar", city: "Roanoke", usState: "VA" }]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response(JSON.stringify(mockEventsPayload), { status: 200 }));
  };

  const res1 = await runSweep({
    metro: "null-metro",
    sourcesPath: FIXTURE_SOURCES,
    fetchFn: mockFetchSuccess as unknown as typeof fetch,
  });
  assertEquals(res1.deduplicated, true);
  assertEquals(res1.candidates.length, 1);
  assertEquals(res1.candidates[0].name, "New Bar");

  // Dedup Outcome 2: --no-dedup -> proceeds without calling DB and labeled
  let dbCalled = false;
  const mockFetchNoDedup = (url: string | URL | Request) => {
    const urlStr = url.toString();
    if (urlStr.includes("/venue")) {
      dbCalled = true;
      return Promise.resolve(new Response("[]", { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify(mockEventsPayload), { status: 200 }));
  };

  const res2 = await runSweep({
    metro: "null-metro",
    sourcesPath: FIXTURE_SOURCES,
    fetchFn: mockFetchNoDedup as unknown as typeof fetch,
    noDedup: true,
  });
  assertEquals(dbCalled, false);
  assertEquals(res2.deduplicated, false);
  assertEquals(res2.candidates.length, 2);

  // Dedup Outcome 3: fetch fails, times out, returns non-OK or non-array -> refuses
  const mockFetchDb500 = (url: string | URL | Request) => {
    const urlStr = url.toString();
    if (urlStr.includes("/venue")) {
      return Promise.resolve(new Response("Server Error", { status: 500 }));
    }
    return Promise.resolve(new Response(JSON.stringify(mockEventsPayload), { status: 200 }));
  };

  await assertRejects(
    () =>
      runSweep({
        metro: "null-metro",
        sourcesPath: FIXTURE_SOURCES,
        fetchFn: mockFetchDb500 as unknown as typeof fetch,
      }),
    Error,
    "Database query failed with HTTP status 500",
  );

  const mockFetchNonArray = (url: string | URL | Request) => {
    const urlStr = url.toString();
    if (urlStr.includes("/venue")) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify(mockEventsPayload), { status: 200 }));
  };

  await assertRejects(
    () =>
      runSweep({
        metro: "null-metro",
        sourcesPath: FIXTURE_SOURCES,
        fetchFn: mockFetchNonArray as unknown as typeof fetch,
      }),
    Error,
    "invalid data: expected JSON array",
  );
});
