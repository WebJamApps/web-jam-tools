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

Deno.test("recordSweep succeeds and returns status 'recorded' on 201", async () => {
  let postedBody: unknown = null;
  const mockFetch = (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) {
      postedBody = JSON.parse(String(init.body));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ _id: "new-record-id", ...sampleOptions }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const result = await recordSweep({
    ...sampleOptions,
    fetchFn: mockFetch as unknown as typeof fetch,
  });

  assertEquals(result.status, "recorded");
  assertEquals(result.statusCode, 201);
  assertEquals(postedBody !== null, true);
  const pb = postedBody as Record<string, unknown>;
  assertEquals(pb.metroSlug, "charlottesville");
  assertEquals(pb.sweptAt, "2026-09-16");
  assertEquals(pb.venuesCreatedCount, 12);
  assertEquals((pb.publication as { name: string }).name, "C-VILLE Weekly");
  assertEquals((pb.publication as { type?: string }).type, "scenethink");
  assertEquals(pb.coverageArea, ["charlottesville", "crozet"]);
  assertEquals(pb.excludeKeywords, ["hall 107", "monticello"]);
});

Deno.test("recordSweep returns status 'already_recorded' on 409", async () => {
  const mockFetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ message: "Sweep for this metro and date already exists" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );

  const result = await recordSweep({
    ...sampleOptions,
    fetchFn: mockFetch as unknown as typeof fetch,
  });

  assertEquals(result.status, "already_recorded");
  assertEquals(result.statusCode, 409);
  assertEquals(result.error, "Sweep for this metro and date already exists");
});

Deno.test("recordSweep returns status 'failed' with retry command on 500 error", async () => {
  const mockFetch = () =>
    Promise.resolve(
      new Response("Internal Database Error", {
        status: 500,
      }),
    );

  const result = await recordSweep({
    ...sampleOptions,
    fetchFn: mockFetch as unknown as typeof fetch,
  });

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
  const mockFetch = () => Promise.reject(new Error("Connection refused"));

  const result = await recordSweep({
    ...sampleOptions,
    fetchFn: mockFetch as unknown as typeof fetch,
  });

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
