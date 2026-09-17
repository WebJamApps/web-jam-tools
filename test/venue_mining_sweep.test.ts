// test/venue_mining_sweep.test.ts
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  checkCooldown,
  dedupeVenues,
  fetchSceneThinkEvents,
  fetchSweepHistory,
  type HarvestedVenue,
  harvestEvents,
  isLargeHallOrTheater,
  isLocalArea,
  isNonMusicEntity,
  LARGE_HALL_OR_THEATER_KEYWORDS,
  listMetros,
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

const FIXTURE_SWEEP_RECORDS: Record<string, unknown[]> = {
  "locked-metro": [
    {
      metroSlug: "locked-metro",
      sweptAt: "2026-09-10",
      publication: {
        name: "SceneThink Calendar",
        url: "http://mock.com/locked/search.json",
        api: "http://mock.com/locked/search.json",
        type: "scenethink",
      },
      venuesCreatedCount: 5,
      coverageArea: ["roanoke", "salem"],
      excludeKeywords: ["hall 107"],
    },
  ],
  "stale-metro": [
    {
      metroSlug: "stale-metro",
      sweptAt: "2025-01-01",
      publication: {
        name: "SceneThink Calendar",
        url: "http://mock.com/stale/search.json",
        api: "http://mock.com/stale/search.json",
        type: "scenethink",
      },
      venuesCreatedCount: 5,
      coverageArea: ["roanoke", "salem"],
    },
  ],
  "null-metro": [
    {
      metroSlug: "null-metro",
      sweptAt: null,
      publication: {
        name: "SceneThink Calendar",
        url: "http://mock.com/null/search.json",
        api: "http://mock.com/null/search.json",
        type: "scenethink",
      },
      venuesCreatedCount: 0,
      coverageArea: ["roanoke", "salem"],
    },
  ],
  "unparseable-metro": [
    {
      metroSlug: "unparseable-metro",
      sweptAt: "not-a-valid-date",
      publication: {
        name: "SceneThink Calendar",
        url: "http://mock.com/unparseable/search.json",
        api: "http://mock.com/unparseable/search.json",
        type: "scenethink",
      },
      venuesCreatedCount: 0,
      coverageArea: ["roanoke", "salem"],
    },
  ],
  "unsupported-metro": [
    {
      metroSlug: "unsupported-metro",
      sweptAt: null,
      publication: {
        name: "HTML Calendar",
        url: "http://mock.com/unsupported",
        api: "http://mock.com/unsupported",
        type: "html",
      },
      venuesCreatedCount: 0,
    },
  ],
  "missing-type-metro": [
    {
      metroSlug: "missing-type-metro",
      sweptAt: null,
      publication: {
        name: "Missing Type Calendar",
        url: "http://mock.com/missing-type",
      },
      venuesCreatedCount: 0,
    },
  ],
  "roanoke-salem": [
    {
      metroSlug: "roanoke-salem",
      sweptAt: "2026-07-02",
      publication: {
        name: "The Roanoke Rambler",
        url: "https://www.roanokerambler.com",
      },
      venuesCreatedCount: 14,
    },
  ],
};

function createMockFetch(overrides?: {
  sweepHistory?: (url: string) => Response | Promise<Response>;
  events?: (url: string) => Response | Promise<Response>;
  venueMap?: (url: string) => Response | Promise<Response>;
}): typeof fetch {
  return ((input: string | URL | Request) => {
    const urlStr = input.toString();

    if (urlStr.includes("/venue-mining/sweep")) {
      if (overrides?.sweepHistory) {
        return Promise.resolve(overrides.sweepHistory(urlStr));
      }
      const urlObj = new URL(urlStr);
      const slug = urlObj.searchParams.get("metroSlug");
      if (slug) {
        const records = FIXTURE_SWEEP_RECORDS[slug] || [];
        return Promise.resolve(
          new Response(JSON.stringify(records), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      const all = Object.values(FIXTURE_SWEEP_RECORDS).flat();
      return Promise.resolve(
        new Response(JSON.stringify(all), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (urlStr.includes("/venue")) {
      if (overrides?.venueMap) {
        return Promise.resolve(overrides.venueMap(urlStr));
      }
      return Promise.resolve(
        new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (overrides?.events) {
      return Promise.resolve(overrides.events(urlStr));
    }

    return Promise.resolve(
      new Response(
        JSON.stringify({
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
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as unknown as typeof fetch;
}

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

Deno.test("isLargeHallOrTheater identifies large halls and theaters with word boundaries", () => {
  assertEquals(isLargeHallOrTheater("Roanoke Civic Center Coliseum"), true);
  assertEquals(isLargeHallOrTheater("Salem Civic Center"), true);
  assertEquals(isLargeHallOrTheater("Charlottesville Amphitheater"), true);
  assertEquals(isLargeHallOrTheater("The Paramount Theater"), true);
  assertEquals(isLargeHallOrTheater("The Jefferson Theater"), true);
  assertEquals(isLargeHallOrTheater("Ting Pavilion"), true);

  // Word boundary prevents false match on substrings (e.g. 'arena' in 'Macarena')
  assertEquals(isLargeHallOrTheater("Macarena Grill"), false);
  assertEquals(isLargeHallOrTheater("Albemarle Ciderworks"), false);
  assertEquals(isLargeHallOrTheater("Firefly"), false);
  assertEquals(isLargeHallOrTheater("Pro Re Nata Farm Brewery"), false);

  // Generic keywords are in LARGE_HALL_OR_THEATER_KEYWORDS
  assertEquals(LARGE_HALL_OR_THEATER_KEYWORDS.includes("theater"), true);
  assertEquals(LARGE_HALL_OR_THEATER_KEYWORDS.includes("theatre"), true);
  assertEquals(LARGE_HALL_OR_THEATER_KEYWORDS.includes("pavilion"), true);

  // C-VILLE specific venue names removed from shared lists
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

Deno.test("loadSourcesRegistry reads and parses YAML correctly", async () => {
  const registry = await loadSourcesRegistry(FIXTURE_SOURCES);
  assertExists(registry);
  assertExists(registry.metros);
  assertEquals(registry.metros.length, 7);
  assertEquals(registry.metros[0].slug, "locked-metro");
  assertEquals(registry.metros[0].label, "Locked Metro VA");
  assertEquals(registry.metros[0].driveTier, "<1.5h");
});

Deno.test("resolveMetro handles exact slugs and labels without false substring matches", async () => {
  const registry = await loadSourcesRegistry(FIXTURE_SOURCES);

  // resolveMetro("salem", registry) returns null
  assertEquals(resolveMetro("salem", registry), null);

  // Exact slug match
  const locked = resolveMetro("locked-metro", registry);
  assertExists(locked);
  assertEquals(locked.slug, "locked-metro");

  // Slug match with casing differences
  const lockedUpper = resolveMetro("LOCKED-METRO", registry);
  assertExists(lockedUpper);
  assertEquals(lockedUpper.slug, "locked-metro");

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

Deno.test("parseStateFromLabel extracts state code from metro label", () => {
  assertEquals(parseStateFromLabel("Roanoke / Salem VA"), "VA");
  assertEquals(parseStateFromLabel("Charlottesville VA"), "VA");
  assertEquals(parseStateFromLabel("Winston-Salem NC"), "NC");
  assertEquals(parseStateFromLabel("Lewisburg WV"), "WV");
  assertEquals(parseStateFromLabel("Bristol VA-TN / Tri-Cities"), "VA-TN");
  assertEquals(parseStateFromLabel("Charlottesville"), null);
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

  const roanokeWithCoverage = {
    slug: "roanoke-salem",
    label: "Roanoke / Salem VA",
    coverageArea: ["vinton", "salem"],
  };
  assertEquals(isLocalArea("Vinton", "VA", roanokeWithCoverage), true);
  assertEquals(isLocalArea("Richmond", "VA", roanokeWithCoverage), false);
  assertEquals(isLocalArea("Salem", "NC", roanokeWithCoverage), false);
});

Deno.test("fetchSweepHistory fetches records for a metro or all metros", async () => {
  const mockFetch = createMockFetch();
  const single = await fetchSweepHistory({
    metroSlug: "roanoke-salem",
    fetchFn: mockFetch,
    backendUrl: "http://mock-backend.local",
  });
  assertEquals(single.length, 1);
  assertEquals(single[0].metroSlug, "roanoke-salem");

  const all = await fetchSweepHistory({
    fetchFn: mockFetch,
    backendUrl: "http://mock-backend.local",
  });
  assert(all.length >= 7);
});

Deno.test("checkCooldown and runSweep cover all three outcomes of cooldown gate", async () => {
  const fixedNow = new Date("2026-09-16T12:00:00Z");
  const mockFetch = createMockFetch();

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
        fetchFn: mockFetch,
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
    fetchFn: mockFetch,
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
    fetchFn: mockFetch,
    noDedup: true,
  });
  assertEquals(staleRes.candidates.length, 1);

  const nullRes = await runSweep({
    metro: "null-metro",
    sourcesPath: FIXTURE_SOURCES,
    now: fixedNow,
    fetchFn: mockFetch,
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
        fetchFn: mockFetch,
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
    fetchFn: mockFetch,
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

Deno.test("runSweep fails closed on sweep history API failure and --force does not bypass it", async () => {
  // 500 error from sweep history API
  const mockFetch500 = createMockFetch({
    sweepHistory: () => new Response("Internal Server Error", { status: 500 }),
  });

  await assertRejects(
    () =>
      runSweep({
        metro: "locked-metro",
        sourcesPath: FIXTURE_SOURCES,
        fetchFn: mockFetch500,
        noDedup: true,
        force: false,
      }),
    Error,
    "HTTP status 500",
  );

  // --force does NOT bypass API failure
  await assertRejects(
    () =>
      runSweep({
        metro: "locked-metro",
        sourcesPath: FIXTURE_SOURCES,
        fetchFn: mockFetch500,
        noDedup: true,
        force: true,
      }),
    Error,
    "HTTP status 500",
  );

  // Network error from sweep history API
  const mockFetchNetwork = createMockFetch({
    sweepHistory: () => Promise.reject(new Error("Connection refused")),
  });

  await assertRejects(
    () =>
      runSweep({
        metro: "locked-metro",
        sourcesPath: FIXTURE_SOURCES,
        fetchFn: mockFetchNetwork,
        noDedup: true,
        force: true,
      }),
    Error,
    "Connection refused",
  );

  // Non-array data from sweep history API
  const mockFetchNonArray = createMockFetch({
    sweepHistory: () =>
      new Response(JSON.stringify({ error: "Invalid" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });

  await assertRejects(
    () =>
      runSweep({
        metro: "locked-metro",
        sourcesPath: FIXTURE_SOURCES,
        fetchFn: mockFetchNonArray,
        noDedup: true,
        force: true,
      }),
    Error,
    "expected JSON array",
  );
});

Deno.test("runSweep on a metro with no sweep history proceeds with --url and refuses without it", async () => {
  const fixedNow = new Date("2026-09-16T12:00:00Z");
  const mockFetch = createMockFetch({
    sweepHistory: () =>
      new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
  });

  // No record and no --url -> refuses, telling the operator to pass --url
  await assertRejects(
    () =>
      runSweep({
        metro: "roanoke-salem",
        sourcesPath: FIXTURE_SOURCES,
        now: fixedNow,
        fetchFn: mockFetch,
        noDedup: true,
      }),
    Error,
    "has no publication configured in sweep history",
  );

  // No record with --url -> proceeds unlocked, with no publication or lastSwept carried in
  const res = await runSweep({
    metro: "roanoke-salem",
    url: "http://mock.com/roanoke/search.json",
    sourcesPath: FIXTURE_SOURCES,
    now: fixedNow,
    fetchFn: mockFetch,
    noDedup: true,
  });
  assertEquals(res.cooldownStatus?.isLocked, false);
  assertEquals(res.metro?.lastSwept, null);
  assertEquals(res.publication, undefined);
  assertEquals(res.sourceUrl, "http://mock.com/roanoke/search.json");
  assertEquals(res.candidates.length, 1);
});

Deno.test("runSweep returns the publication it resolved from the newest record", async () => {
  const res = await runSweep({
    metro: "stale-metro",
    sourcesPath: FIXTURE_SOURCES,
    now: new Date("2026-09-16T12:00:00Z"),
    fetchFn: createMockFetch(),
    noDedup: true,
  });
  assertEquals(res.publication?.name, "SceneThink Calendar");
  assertEquals(res.publication?.api, "http://mock.com/stale/search.json");
  assertEquals(res.metro?.coverageArea, ["roanoke", "salem"]);
});

Deno.test("fetchSweepHistory fails closed when the backend does not answer in time", async () => {
  const hangingFetch =
    ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;

  await assertRejects(
    () =>
      fetchSweepHistory({
        metroSlug: "roanoke-salem",
        backendUrl: "http://mock-backend.local",
        token: "test-token",
        fetchFn: hangingFetch,
        timeoutMs: 10,
      }),
    Error,
    "Sweep history query failed",
  );
});

Deno.test("runSweep respects runtime --coverage-area and --exclude-keywords overrides", async () => {
  const eventsPayload = {
    pages: 1,
    events: [
      {
        _source: {
          name: "CustomTown Gig",
          starttime: "2026-09-20T18:00:00Z",
          venue: { name: "Acoustic Stage", city: "CustomTown", state: "VA" },
        },
      },
    ],
  };

  const mockFetch = createMockFetch({
    events: () =>
      new Response(JSON.stringify(eventsPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });

  // Default: CustomTown is not in locked-metro's coverage area ["roanoke", "salem"], so 0 candidates
  const defaultRes = await runSweep({
    metro: "locked-metro",
    sourcesPath: FIXTURE_SOURCES,
    force: true,
    noDedup: true,
    fetchFn: mockFetch,
  });
  assertEquals(defaultRes.candidates.length, 0);

  // Override coverageArea to include "customtown":
  const overrideRes = await runSweep({
    metro: "locked-metro",
    sourcesPath: FIXTURE_SOURCES,
    force: true,
    noDedup: true,
    coverageArea: ["customtown"],
    fetchFn: mockFetch,
  });
  assertEquals(overrideRes.candidates.length, 1);
  assertEquals(overrideRes.candidates[0].city, "CustomTown");

  // Override excludeKeywords to exclude "acoustic":
  const overrideExclRes = await runSweep({
    metro: "locked-metro",
    sourcesPath: FIXTURE_SOURCES,
    force: true,
    noDedup: true,
    coverageArea: ["customtown"],
    excludeKeywords: ["acoustic"],
    fetchFn: mockFetch,
  });
  assertEquals(overrideExclRes.candidates.length, 0);
});

Deno.test("listMetros fetches GET /venue-mining/sweep once and fails closed on error", async () => {
  let apiCallCount = 0;
  const mockFetch = createMockFetch({
    sweepHistory: () => {
      apiCallCount++;
      return new Response(
        JSON.stringify([
          {
            metroSlug: "roanoke-salem",
            sweptAt: "2026-07-02",
            publication: {
              name: "The Roanoke Rambler",
              url: "https://www.roanokerambler.com",
            },
            venuesCreatedCount: 14,
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const list = await listMetros({
    sourcesPath: FIXTURE_SOURCES,
    fetchFn: mockFetch,
  });

  assertEquals(apiCallCount, 1);
  assert(list.length > 0);
  const roanoke = list.find((m) => m.slug === "roanoke-salem");
  assertExists(roanoke);
  assertEquals(roanoke.publication?.name, "The Roanoke Rambler");
  assertEquals(roanoke.lastSwept, "2026-07-02");

  // API failure fails closed:
  const mockFetchFail = createMockFetch({
    sweepHistory: () => new Response("Database offline", { status: 503 }),
  });

  await assertRejects(
    () =>
      listMetros({
        sourcesPath: FIXTURE_SOURCES,
        fetchFn: mockFetchFail,
      }),
    Error,
    "HTTP status 503",
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
        fetchFn: createMockFetch(),
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
        fetchFn: createMockFetch(),
      }),
    Error,
    "with missing type",
  );

  // roanoke-salem has no publication type configured in sweep record
  await assertRejects(
    () =>
      runSweep({
        metro: "roanoke-salem",
        sourcesPath: FIXTURE_SOURCES,
        force: true,
        noDedup: true,
        fetchFn: createMockFetch(),
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
  const mockFetchSuccess = createMockFetch({
    events: () => new Response(JSON.stringify(mockEventsPayload), { status: 200 }),
    venueMap: () =>
      new Response(
        JSON.stringify([{ _id: "v1", name: "Existing Bar", city: "Roanoke", usState: "VA" }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  const res1 = await runSweep({
    metro: "null-metro",
    sourcesPath: FIXTURE_SOURCES,
    fetchFn: mockFetchSuccess,
  });
  assertEquals(res1.deduplicated, true);
  assertEquals(res1.candidates.length, 1);
  assertEquals(res1.candidates[0].name, "New Bar");

  // Dedup Outcome 2: --no-dedup -> proceeds without calling DB and labeled
  let dbCalled = false;
  const mockFetchNoDedup = createMockFetch({
    events: () => new Response(JSON.stringify(mockEventsPayload), { status: 200 }),
    venueMap: () => {
      dbCalled = true;
      return new Response("[]", { status: 200 });
    },
  });

  const res2 = await runSweep({
    metro: "null-metro",
    sourcesPath: FIXTURE_SOURCES,
    fetchFn: mockFetchNoDedup,
    noDedup: true,
  });
  assertEquals(dbCalled, false);
  assertEquals(res2.deduplicated, false);
  assertEquals(res2.candidates.length, 2);

  // Dedup Outcome 3: fetch fails, times out, returns non-OK or non-array -> refuses
  const mockFetchDb500 = createMockFetch({
    events: () => new Response(JSON.stringify(mockEventsPayload), { status: 200 }),
    venueMap: () => new Response("Server Error", { status: 500 }),
  });

  await assertRejects(
    () =>
      runSweep({
        metro: "null-metro",
        sourcesPath: FIXTURE_SOURCES,
        fetchFn: mockFetchDb500,
      }),
    Error,
    "Database query failed with HTTP status 500",
  );

  const mockFetchNonArray = createMockFetch({
    events: () => new Response(JSON.stringify(mockEventsPayload), { status: 200 }),
    venueMap: () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });

  await assertRejects(
    () =>
      runSweep({
        metro: "null-metro",
        sourcesPath: FIXTURE_SOURCES,
        fetchFn: mockFetchNonArray,
      }),
    Error,
    "invalid data: expected JSON array",
  );
});

Deno.test("runSweep rejects large halls and theaters from candidates", async () => {
  const mockEventsPayload = {
    pages: 1,
    events: [
      {
        _source: {
          name: "Theater Show",
          starttime: "2026-09-20T18:00:00Z",
          venue: { name: "The Paramount Theater", city: "Roanoke", state: "VA" },
        },
      },
      {
        _source: {
          name: "Club Gig",
          starttime: "2026-09-20T18:00:00Z",
          venue: { name: "Acoustic Cafe", city: "Roanoke", state: "VA" },
        },
      },
    ],
  };

  const mockFetch = createMockFetch({
    events: () => new Response(JSON.stringify(mockEventsPayload), { status: 200 }),
  });

  const res = await runSweep({
    metro: "null-metro",
    sourcesPath: FIXTURE_SOURCES,
    fetchFn: mockFetch,
    noDedup: true,
  });

  assertEquals(res.candidates.length, 1);
  assertEquals(res.candidates[0].name, "Acoustic Cafe");
  assertEquals(
    Object.keys(res).sort(),
    [
      "candidates",
      "cooldownStatus",
      "deduplicated",
      "metro",
      "publication",
      "rawCount",
      "sourceType",
      "sourceUrl",
    ],
  );
});
