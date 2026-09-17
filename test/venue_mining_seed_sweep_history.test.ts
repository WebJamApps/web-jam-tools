// test/venue_mining_seed_sweep_history.test.ts
import { assertEquals, assertRejects } from "@std/assert";
import { SEED_SWEEP_RECORDS, seedSweepHistory } from "../src/venue-mining/seed_sweep_history.ts";

Deno.test("seedSweepHistory runs in dry-run mode by default without making network requests", async () => {
  let fetchCalled = false;
  const mockFetch = () => {
    fetchCalled = true;
    return Promise.resolve(new Response("OK", { status: 200 }));
  };

  const res = await seedSweepHistory({
    confirm: false,
    fetchFn: mockFetch as unknown as typeof fetch,
  });

  assertEquals(fetchCalled, false);
  assertEquals(res.dryRun, true);
  assertEquals(res.total, 5);
  assertEquals(res.created, 0);
  assertEquals(res.alreadyPresent, 0);
  assertEquals(res.failed, 0);
  assertEquals(res.records.length, 5);
  assertEquals(res.records.every((r) => r.status === "dry_run"), true);
});

Deno.test("seedSweepHistory with confirm: true posts all 5 records and counts 201 created", async () => {
  const postedBodies: unknown[] = [];
  const mockFetch = (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) {
      postedBodies.push(JSON.parse(String(init.body)));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ _id: "new-id" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const res = await seedSweepHistory({
    confirm: true,
    backendUrl: "http://mock-backend.local",
    token: "test-token",
    fetchFn: mockFetch as unknown as typeof fetch,
  });

  assertEquals(res.dryRun, false);
  assertEquals(res.total, 5);
  assertEquals(res.created, 5);
  assertEquals(res.alreadyPresent, 0);
  assertEquals(res.failed, 0);
  assertEquals(postedBodies.length, 5);
  assertEquals(
    postedBodies.map((b) => (b as { metroSlug: string }).metroSlug),
    SEED_SWEEP_RECORDS.map((r) => r.metroSlug),
  );
});

Deno.test("seedSweepHistory treats 409 conflict as already present and succeeds", async () => {
  const mockFetch = (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { metroSlug: string };
    // Simulate charlottesville is new, but first 4 are already present
    if (body.metroSlug === "charlottesville") {
      return Promise.resolve(
        new Response(JSON.stringify({ _id: "cville-id" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ message: "Sweep for this metro and date already exists" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const res = await seedSweepHistory({
    confirm: true,
    backendUrl: "http://mock-backend.local",
    token: "test-token",
    fetchFn: mockFetch as unknown as typeof fetch,
  });

  assertEquals(res.dryRun, false);
  assertEquals(res.total, 5);
  assertEquals(res.created, 1);
  assertEquals(res.alreadyPresent, 4);
  assertEquals(res.failed, 0);
  const cville = res.records.find((r) => r.metroSlug === "charlottesville");
  assertEquals(cville?.status, "created");
  const roanoke = res.records.find((r) => r.metroSlug === "roanoke-salem");
  assertEquals(roanoke?.status, "already_present");
});

Deno.test("seedSweepHistory throws and reports failure on non-409/non-201 error", async () => {
  const mockFetch = () =>
    Promise.resolve(
      new Response("Internal Server Error", {
        status: 500,
      }),
    );

  await assertRejects(
    () =>
      seedSweepHistory({
        confirm: true,
        backendUrl: "http://mock-backend.local",
        token: "test-token",
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    Error,
    "Failed to seed 5 of 5 sweep records",
  );
});
