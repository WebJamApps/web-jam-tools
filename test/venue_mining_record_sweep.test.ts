// test/venue_mining_record_sweep.test.ts
import { assertEquals } from "@std/assert";
import {
  buildRetryCommand,
  recordSweep,
  type RecordSweepOptions,
} from "../src/venue-mining/record_sweep.ts";

const sampleOptions: RecordSweepOptions = {
  metro: "charlottesville",
  sweptAt: "2026-09-16",
  pubName: "C-VILLE Weekly",
  pubUrl: "http://events.c-ville.com",
  pubApi: "http://events.c-ville.com/cville/search.json?category=13",
  pubType: "scenethink",
  venuesCreated: 12,
  coverageArea: ["charlottesville", "crozet"],
  excludeKeywords: ["hall 107", "monticello"],
  notes: "Run 5 sweep completed.",
  backendUrl: "http://mock-backend.local",
  token: "test-token",
};

const PREVIOUS_CVILLE_SWEEP = {
  metroSlug: "charlottesville",
  sweptAt: "2026-03-01",
  publication: {
    name: "C-VILLE Weekly",
    url: "http://events.c-ville.com",
    api: "http://events.c-ville.com/cville/search.json?category=13",
    type: "scenethink",
  },
  venuesCreatedCount: 4,
  coverageArea: ["charlottesville", "crozet", "keswick"],
  excludeKeywords: ["monticello", "wtju"],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Mock backend: GET returns `history` (or `historyResponse`), POST is answered by `onPost`. */
function mockBackend(options: {
  onPost: (body: Record<string, unknown>) => Response | Promise<Response>;
  history?: unknown[];
  historyResponse?: () => Response | Promise<Response>;
}): { fetchFn: typeof fetch; posted: Record<string, unknown>[] } {
  const posted: Record<string, unknown>[] = [];
  const fetchFn = ((_url: string | URL | Request, init?: RequestInit) => {
    if ((init?.method || "GET") === "GET") {
      if (options.historyResponse) return Promise.resolve(options.historyResponse());
      return Promise.resolve(jsonResponse(options.history || []));
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    posted.push(body);
    return Promise.resolve(options.onPost(body));
  }) as unknown as typeof fetch;
  return { fetchFn, posted };
}

Deno.test("recordSweep succeeds and returns status 'recorded' on 201", async () => {
  const backend = mockBackend({ onPost: (body) => jsonResponse({ _id: "new-id", ...body }, 201) });

  const result = await recordSweep({ ...sampleOptions, fetchFn: backend.fetchFn });

  assertEquals(result.status, "recorded");
  assertEquals(result.statusCode, 201);
  assertEquals(result.inherited, []);
  assertEquals(backend.posted.length, 1);
  const pb = backend.posted[0];
  assertEquals(pb.metroSlug, "charlottesville");
  assertEquals(pb.sweptAt, "2026-09-16");
  assertEquals(pb.venuesCreatedCount, 12);
  assertEquals((pb.publication as { name: string }).name, "C-VILLE Weekly");
  assertEquals((pb.publication as { type?: string }).type, "scenethink");
  assertEquals(pb.coverageArea, ["charlottesville", "crozet"]);
  assertEquals(pb.excludeKeywords, ["hall 107", "monticello"]);
});

Deno.test("recordSweep carries forward settings not passed from the metro's newest record", async () => {
  const backend = mockBackend({
    history: [PREVIOUS_CVILLE_SWEEP],
    onPost: (body) => jsonResponse(body, 201),
  });

  const result = await recordSweep({
    metro: "charlottesville",
    sweptAt: "2027-03-20",
    pubName: "C-VILLE Weekly",
    pubUrl: "http://events.c-ville.com",
    venuesCreated: 2,
    backendUrl: "http://mock-backend.local",
    token: "test-token",
    fetchFn: backend.fetchFn,
  });

  assertEquals(result.status, "recorded");
  assertEquals(result.inherited, [
    "publication.api",
    "publication.type",
    "coverageArea",
    "excludeKeywords",
  ]);
  const pb = backend.posted[0];
  assertEquals(pb.publication, PREVIOUS_CVILLE_SWEEP.publication);
  assertEquals(pb.coverageArea, PREVIOUS_CVILLE_SWEEP.coverageArea);
  assertEquals(pb.excludeKeywords, PREVIOUS_CVILLE_SWEEP.excludeKeywords);
});

Deno.test("recordSweep keeps passed settings and never inherits api/type across a publication change", async () => {
  const backend = mockBackend({
    history: [PREVIOUS_CVILLE_SWEEP],
    onPost: (body) => jsonResponse(body, 201),
  });

  const result = await recordSweep({
    metro: "charlottesville",
    sweptAt: "2027-03-20",
    pubName: "Cville Events Daily",
    pubUrl: "https://cvilleevents.example",
    venuesCreated: 0,
    coverageArea: ["charlottesville"],
    backendUrl: "http://mock-backend.local",
    token: "test-token",
    fetchFn: backend.fetchFn,
  });

  assertEquals(result.status, "recorded");
  assertEquals(result.inherited, ["excludeKeywords"]);
  const pb = backend.posted[0];
  assertEquals(pb.publication, {
    name: "Cville Events Daily",
    url: "https://cvilleevents.example",
  });
  assertEquals(pb.coverageArea, ["charlottesville"]);
  assertEquals(pb.excludeKeywords, PREVIOUS_CVILLE_SWEEP.excludeKeywords);
});

Deno.test("recordSweep refuses to record when the sweep history can't be read", async () => {
  const backend = mockBackend({
    historyResponse: () => new Response("Service Unavailable", { status: 503 }),
    onPost: (body) => jsonResponse(body, 201),
  });

  const result = await recordSweep({ ...sampleOptions, fetchFn: backend.fetchFn });

  assertEquals(result.status, "failed");
  assertEquals(result.error?.includes("Could not read sweep history"), true);
  assertEquals(result.error?.includes("HTTP status 503"), true);
  assertEquals(result.retryCommand.includes("deno task venue-mining:record-sweep"), true);
  assertEquals(backend.posted.length, 0);
});

Deno.test("recordSweep returns status 'already_recorded' on 409", async () => {
  const backend = mockBackend({
    onPost: () => jsonResponse({ message: "Sweep for this metro and date already exists" }, 409),
  });

  const result = await recordSweep({ ...sampleOptions, fetchFn: backend.fetchFn });

  assertEquals(result.status, "already_recorded");
  assertEquals(result.statusCode, 409);
  assertEquals(result.error, "Sweep for this metro and date already exists");
});

Deno.test("recordSweep returns status 'failed' with retry command on 500 error", async () => {
  const backend = mockBackend({
    onPost: () => new Response("Internal Database Error", { status: 500 }),
  });

  const result = await recordSweep({ ...sampleOptions, fetchFn: backend.fetchFn });

  assertEquals(result.status, "failed");
  assertEquals(result.statusCode, 500);
  assertEquals(result.error?.includes("HTTP 500"), true);
  assertEquals(result.retryCommand.includes("deno task venue-mining:record-sweep"), true);
  assertEquals(result.retryCommand.includes("--metro charlottesville"), true);
  assertEquals(result.retryCommand.includes("--swept-at 2026-09-16"), true);
  assertEquals(result.retryCommand.includes('--pub-name "C-VILLE Weekly"'), true);
  assertEquals(result.retryCommand.includes("--venues-created 12"), true);
});

Deno.test("recordSweep returns status 'failed' on network error with retry command", async () => {
  const backend = mockBackend({
    onPost: () => Promise.reject(new Error("Connection refused")),
  });

  const result = await recordSweep({ ...sampleOptions, fetchFn: backend.fetchFn });

  assertEquals(result.status, "failed");
  assertEquals(result.error, "Network error: Connection refused");
  assertEquals(result.retryCommand.includes("deno task venue-mining:record-sweep"), true);
});

Deno.test("recordSweep validates required fields before making requests", async () => {
  let fetchCalled = false;
  const mockFetch = () => {
    fetchCalled = true;
    return Promise.resolve(new Response("OK"));
  };

  // Missing metro
  const resNoMetro = await recordSweep({
    ...sampleOptions,
    metro: "",
    fetchFn: mockFetch as unknown as typeof fetch,
  });
  assertEquals(resNoMetro.status, "failed");
  assertEquals(resNoMetro.error?.includes("--metro"), true);
  assertEquals(fetchCalled, false);

  // Invalid date
  const resBadDate = await recordSweep({
    ...sampleOptions,
    sweptAt: "not-a-date",
    fetchFn: mockFetch as unknown as typeof fetch,
  });
  assertEquals(resBadDate.status, "failed");
  assertEquals(resBadDate.error?.includes("--swept-at"), true);
  assertEquals(fetchCalled, false);

  // Timestamps and unpadded dates are rejected: the backend dedupes on the exact value
  for (const sweptAt of ["2026-09-16T14:02:00Z", "2026-9-16"]) {
    const res = await recordSweep({
      ...sampleOptions,
      sweptAt,
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    assertEquals(res.status, "failed");
    assertEquals(res.error?.includes("--swept-at"), true);
  }
  assertEquals(fetchCalled, false);

  // Invalid venues created
  const resBadVenues = await recordSweep({
    ...sampleOptions,
    venuesCreated: -1,
    fetchFn: mockFetch as unknown as typeof fetch,
  });
  assertEquals(resBadVenues.status, "failed");
  assertEquals(resBadVenues.error?.includes("--venues-created"), true);
  assertEquals(fetchCalled, false);
});

Deno.test("buildRetryCommand formats all options cleanly for re-running in terminal", () => {
  const cmd = buildRetryCommand(sampleOptions);
  assertEquals(cmd.includes("deno task venue-mining:record-sweep"), true);
  assertEquals(cmd.includes("--metro charlottesville"), true);
  assertEquals(cmd.includes("--swept-at 2026-09-16"), true);
  assertEquals(cmd.includes('--pub-name "C-VILLE Weekly"'), true);
  assertEquals(cmd.includes('--pub-url "http://events.c-ville.com"'), true);
  assertEquals(
    cmd.includes('--pub-api "http://events.c-ville.com/cville/search.json?category=13"'),
    true,
  );
  assertEquals(cmd.includes("--pub-type scenethink"), true);
  assertEquals(cmd.includes("--venues-created 12"), true);
  assertEquals(cmd.includes('--coverage-area "charlottesville,crozet"'), true);
  assertEquals(cmd.includes('--exclude-keywords "hall 107,monticello"'), true);
  assertEquals(cmd.includes('--notes "Run 5 sweep completed."'), true);
});
