// test/venue-tag/backfill.test.ts
// Unit tests for propose-then-apply venue-tag backfill CLI and classifier (web-jam-tools#1126).

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  classifyVenue,
  formatClassificationTable,
  parseAffirmativeFlag,
  runBackfill,
  runBackfillCli,
  type VenueRecord,
} from "../../src/venue-tag/backfill.ts";
import { lintRunbookFile } from "../../src/design-issue/lint_runbook.ts";

Deno.test("classifyVenue: recognizes legacy type field values", () => {
  assertEquals(classifyVenue({ _id: "1", type: "Originals" }), {
    type: "Originals",
    reason: 'legacy type "Originals"',
  });
  assertEquals(classifyVenue({ _id: "2", type: "Listening Room" }), {
    type: "Originals",
    reason: 'legacy type "Listening Room"',
  });
  assertEquals(classifyVenue({ _id: "3", type: "Brewery" }), {
    type: "PubFestivalBrewery",
    reason: 'legacy type "Brewery"',
  });
  assertEquals(classifyVenue({ _id: "4", type: "Pub" }), {
    type: "PubFestivalBrewery",
    reason: 'legacy type "Pub"',
  });
  assertEquals(classifyVenue({ _id: "5", type: "Festival" }), {
    type: "PubFestivalBrewery",
    reason: 'legacy type "Festival"',
  });
  assertEquals(classifyVenue({ _id: "6", type: "FarmersMarket" }), {
    type: "PubFestivalBrewery",
    reason: 'legacy type "FarmersMarket"',
  });
  assertEquals(classifyVenue({ _id: "7", type: "CoffeeShop" }), {
    type: "MidRangeCafeBar",
    reason: 'legacy type "CoffeeShop"',
  });
  assertEquals(classifyVenue({ _id: "8", type: "Cafe" }), {
    type: "MidRangeCafeBar",
    reason: 'legacy type "Cafe"',
  });
  assertEquals(classifyVenue({ _id: "9", type: "Winery" }), {
    type: "PubFestivalBrewery",
    reason: 'legacy type "Winery"',
  });
});

Deno.test("classifyVenue: classifies Originals via name, genre, or notes keywords", () => {
  // Name keyword
  const v1 = classifyVenue({ _id: "1", name: "The Bluebird Listening Room" });
  assertEquals(v1.type, "Originals");
  assertEquals(v1.reason, 'name keyword "listening room"');

  const v2 = classifyVenue({ _id: "2", name: "Paramount Theater" });
  assertEquals(v2.type, "Originals");
  assertEquals(v2.reason, 'name keyword "theater"');

  // Genre keyword
  const v3 = classifyVenue({
    _id: "3",
    name: "The Underground",
    genre: ["singer-songwriter", "folk"],
  });
  assertEquals(v3.type, "Originals");
  assertEquals(v3.reason, 'genre keyword "singer-songwriter"');

  // Notes keyword
  const v4 = classifyVenue({
    _id: "4",
    name: "The Basement",
    notes: "A dedicated indie club with great sound.",
  });
  assertEquals(v4.type, "Originals");
  assertEquals(v4.reason, 'notes keyword "indie club"');
});

Deno.test("classifyVenue: classifies PubFestivalBrewery via name, genre, or notes keywords", () => {
  const v1 = classifyVenue({ _id: "1", name: "Starr Hill Pilot Brewery" });
  assertEquals(v1.type, "PubFestivalBrewery");
  assertEquals(v1.reason, 'name keyword "brewery"');

  const v2 = classifyVenue({ _id: "2", name: "Three Notch'd Brewing" });
  assertEquals(v2.type, "PubFestivalBrewery");
  assertEquals(v2.reason, 'name keyword "brewing"');

  const v3 = classifyVenue({ _id: "3", name: "Flannagan's Pub" });
  assertEquals(v3.type, "PubFestivalBrewery");
  assertEquals(v3.reason, 'name keyword "pub"');

  const v4 = classifyVenue({ _id: "4", name: "Albemarle Ciderworks" });
  assertEquals(v4.type, "PubFestivalBrewery");
  assertEquals(v4.reason, 'name keyword "ciderworks"');

  const v5 = classifyVenue({ _id: "5", name: "Roanoke Taproom" });
  assertEquals(v5.type, "PubFestivalBrewery");
  assertEquals(v5.reason, 'name keyword "taproom"');
});

Deno.test("classifyVenue: follows the approved cafe, winery, and vineyard mapping", () => {
  const v1 = classifyVenue({ _id: "1", name: "Mudhouse Coffee Roasters" });
  assertEquals(v1.type, "MidRangeCafeBar");
  assertEquals(v1.reason, 'name keyword "coffee"');

  const v2 = classifyVenue({ _id: "2", name: "Mill Mountain Cafe" });
  assertEquals(v2.type, "MidRangeCafeBar");
  assertEquals(v2.reason, 'name keyword "cafe"');

  const v3 = classifyVenue({ _id: "3", name: "Eastwood Farm and Winery" });
  assertEquals(v3.type, "PubFestivalBrewery");
  assertEquals(v3.reason, 'name keyword "winery"');

  const v4 = classifyVenue({ _id: "4", name: "Southwest Mountains Vineyards" });
  assertEquals(v4.type, "PubFestivalBrewery");
  assertEquals(v4.reason, 'name keyword "vineyard"');

  const v5 = classifyVenue({ _id: "5", name: "The Corner Bistro" });
  assertEquals(v5.type, "MidRangeCafeBar");
  assertEquals(v5.reason, 'name keyword "bistro"');
});

Deno.test("classifyVenue: word-boundary matching avoids false positive substrings (Rule 21)", () => {
  // "Macarena Grill" should match "grill" -> MidRangeCafeBar, not "arena"
  const v1 = classifyVenue({ _id: "1", name: "Macarena Grill" });
  assertEquals(v1.type, "MidRangeCafeBar");
  assertEquals(v1.reason, 'name keyword "grill"');

  // "Scarecrow" should not match "crow"
  const v2 = classifyVenue({ _id: "2", name: "Scarecrow Eatery" });
  assertEquals(v2.type, "MidRangeCafeBar");
  assertEquals(v2.reason, 'name keyword "eatery"');
});

Deno.test("classifyVenue: requires contextual fallback when no keyword matches (D-78)", () => {
  const v = classifyVenue({ _id: "1", name: "The Green Door", notes: "A nice place." });
  assertEquals(v.type, null);
  assertEquals(v.reason, "no keyword match; contextual LLM classification required");
});

Deno.test("parseAffirmativeFlag: enforces fail-closed affirmative confirmation (Rule 19)", () => {
  // Bare flags
  assertEquals(parseAffirmativeFlag("apply", ["--apply"]), {
    present: true,
    affirmative: true,
  });
  assertEquals(parseAffirmativeFlag("overwrite", ["--overwrite"]), {
    present: true,
    affirmative: true,
  });

  // Explicit affirmative values
  assertEquals(parseAffirmativeFlag("apply", ["--apply=true"]), {
    present: true,
    affirmative: true,
  });
  assertEquals(parseAffirmativeFlag("apply", ["--apply", "yes"]), {
    present: true,
    affirmative: true,
  });
  assertEquals(parseAffirmativeFlag("apply", ["--apply=1"]), {
    present: true,
    affirmative: true,
  });

  // Non-affirmative / negative values must fail closed
  const neg1 = parseAffirmativeFlag("apply", ["--apply=false"]);
  assertEquals(neg1.present, true);
  assertEquals(neg1.affirmative, false);
  assert(neg1.error?.includes("Must be affirmative"));

  const neg2 = parseAffirmativeFlag("apply", ["--apply=no"]);
  assertEquals(neg2.present, true);
  assertEquals(neg2.affirmative, false);
  assert(neg2.error?.includes("Must be affirmative"));

  const neg3 = parseAffirmativeFlag("apply", ["--apply=0"]);
  assertEquals(neg3.present, true);
  assertEquals(neg3.affirmative, false);
  assert(neg3.error?.includes("Must be affirmative"));

  const malformed = parseAffirmativeFlag("apply", ["--apply=bogus"]);
  assertEquals(malformed.present, true);
  assertEquals(malformed.affirmative, false);
  assert(malformed.error?.includes("Must be affirmative"));

  // Not present
  assertEquals(parseAffirmativeFlag("apply", ["--other"]), {
    present: false,
    affirmative: false,
  });
});

Deno.test("formatClassificationTable: formats empty and populated lists", () => {
  const empty = formatClassificationTable([]);
  assertEquals(empty, "No unvetted venues requiring classification.");

  const table = formatClassificationTable([
    {
      venueId: "v1",
      name: "Starr Hill Brewery",
      currentType: null,
      proposedType: "PubFestivalBrewery",
      reason: 'name keyword "brewery"',
      isOverwritten: false,
    },
    {
      venueId: "v2",
      name: "Jefferson Theater",
      currentType: null,
      proposedType: "Originals",
      reason: 'name keyword "theater"',
      isOverwritten: false,
    },
  ]);

  assert(table.includes("Starr Hill Brewery"));
  assert(table.includes("PubFestivalBrewery"));
  assert(table.includes("Jefferson Theater"));
  assert(table.includes("Originals"));
});

Deno.test("runBackfill: preview mode performs GET /venue, classifies, and makes 0 PATCH requests", async () => {
  const venues: VenueRecord[] = [
    { _id: "1", name: "Three Notch'd Brewing", venueType: null, status: "active" },
    { _id: "2", name: "The Mockingbird Cafe", venueType: "", status: "active" },
    { _id: "3", name: "Already Classified Pub", venueType: "PubFestivalBrewery", status: "active" },
    { _id: "4", name: "Archived Venue", venueType: null, status: "archived" },
  ];

  let getCount = 0;
  let patchCount = 0;

  const mockFetch: typeof fetch = (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    if (url.endsWith("/venue") && method === "GET") {
      getCount++;
      return Promise.resolve(new Response(JSON.stringify(venues), { status: 200 }));
    }
    if (url.includes("/venue/") && method === "PATCH") {
      patchCount++;
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };

  const logs: string[] = [];
  const result = await runBackfill({
    backendUrl: "https://mock.example.com",
    token: "mock-token",
    apply: false,
    fetchFn: mockFetch,
    logger: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
  });

  assertEquals(getCount, 1);
  assertEquals(patchCount, 0, "Preview mode must make 0 PATCH calls");
  assertEquals(result.totalFetched, 4);
  assertEquals(result.unvettedCount, 2, "Only active unvetted venues are processed");
  assertEquals(result.appliedCount, 0);
  assertEquals(result.skippedCount, 2);
  assertEquals(result.proposed.length, 2);
  assertEquals(result.proposed[0].proposedType, "PubFestivalBrewery");
  assertEquals(result.proposed[1].proposedType, "MidRangeCafeBar");
  assert(logs.some((l) => l.includes("Dry-run preview mode")));
});

Deno.test("runBackfill: --apply sends PATCH /venue/:id requests and updates records", async () => {
  const venues: VenueRecord[] = [
    { _id: "v1", name: "Devils Backbone Brewing", venueType: null, status: "active" },
    { _id: "v2", name: "Jefferson Theater", venueType: null, status: "active" },
  ];

  const patchCalls: Array<{ url: string; body: unknown; auth: string | null }> = [];

  const mockFetch: typeof fetch = (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    if (url.endsWith("/venue") && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify(venues), { status: 200 }));
    }
    if (url.includes("/venue/") && method === "PATCH") {
      const headers = init?.headers as Record<string, string>;
      patchCalls.push({
        url,
        body: JSON.parse(String(init?.body || "{}")),
        auth: headers?.Authorization || null,
      });
      return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };

  const logs: string[] = [];
  const result = await runBackfill({
    backendUrl: "https://mock.example.com",
    token: "valid-bearer-token",
    apply: true,
    confirmProposal: () => true,
    fetchFn: mockFetch,
    logger: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
  });

  assertEquals(result.appliedCount, 2);
  assertEquals(patchCalls.length, 2);
  assertEquals(patchCalls[0].url, "https://mock.example.com/venue/v1");
  assertEquals(patchCalls[0].body, { venueType: "PubFestivalBrewery" });
  assertEquals(patchCalls[0].auth, "Bearer valid-bearer-token");
  assertEquals(patchCalls[1].url, "https://mock.example.com/venue/v2");
  assertEquals(patchCalls[1].body, { venueType: "Originals" });
  assertEquals(patchCalls[1].auth, "Bearer valid-bearer-token");
});

Deno.test("runBackfill: --overwrite option evaluates already-classified venues", async () => {
  const venues: VenueRecord[] = [
    { _id: "v1", name: "Parkway Brewing", venueType: "PubFestivalBrewery", status: "active" }, // matching
    { _id: "v2", name: "Mill Mountain Coffee", venueType: "Originals", status: "active" }, // diverging: should be MidRangeCafeBar
  ];

  const mockFetch: typeof fetch = (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    if (url.endsWith("/venue") && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify(venues), { status: 200 }));
    }
    return Promise.resolve(new Response("OK", { status: 200 }));
  };

  // Without overwrite: 0 venues proposed because all have venueType
  const noOverwriteResult = await runBackfill({
    backendUrl: "https://mock.example.com",
    token: "mock-token",
    apply: false,
    overwrite: false,
    fetchFn: mockFetch,
    logger: { log: () => {}, error: () => {} },
  });
  assertEquals(noOverwriteResult.proposed.length, 0);

  // With overwrite: only v2 is proposed because its classification differs
  const overwriteResult = await runBackfill({
    backendUrl: "https://mock.example.com",
    token: "mock-token",
    apply: false,
    overwrite: true,
    fetchFn: mockFetch,
    logger: { log: () => {}, error: () => {} },
  });
  assertEquals(overwriteResult.proposed.length, 1);
  assertEquals(overwriteResult.proposed[0].venueId, "v2");
  assertEquals(overwriteResult.proposed[0].proposedType, "MidRangeCafeBar");
  assertEquals(overwriteResult.proposed[0].currentType, "Originals");
  assertEquals(overwriteResult.proposed[0].isOverwritten, true);
});

Deno.test("runBackfill: fails closed on missing auth token when --apply is requested", async () => {
  await assertRejects(
    async () => {
      await runBackfill({
        backendUrl: "https://mock.example.com",
        token: "", // explicitly empty/missing
        apply: true,
        fetchFn: () => Promise.resolve(new Response(JSON.stringify([]), { status: 200 })),
      });
    },
    Error,
    "Missing authentication token",
  );
});

Deno.test("runBackfill: fails closed on GET /venue network failure (AC 3)", async () => {
  const mockFetch: typeof fetch = () => {
    return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
  };

  await assertRejects(
    async () => {
      await runBackfill({
        backendUrl: "https://mock.example.com",
        token: "tok",
        apply: false,
        fetchFn: mockFetch,
      });
    },
    Error,
    "GET /venue failed: HTTP 500",
  );
});

Deno.test("runBackfill: fails closed on PATCH /venue/:id network error (AC 3)", async () => {
  const venues: VenueRecord[] = [
    { _id: "v1", name: "Failing Pub", venueType: null, status: "active" },
  ];

  const mockFetch: typeof fetch = (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    if (url.endsWith("/venue") && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify(venues), { status: 200 }));
    }
    if (url.includes("/venue/v1") && method === "PATCH") {
      return Promise.resolve(new Response("Validation failed on server", { status: 400 }));
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };

  await assertRejects(
    async () => {
      await runBackfill({
        backendUrl: "https://mock.example.com",
        token: "tok",
        apply: true,
        confirmProposal: () => true,
        fetchFn: mockFetch,
      });
    },
    Error,
    'failed to update "Failing Pub" (v1): PATCH /venue/v1 failed: HTTP 400',
  );
});

Deno.test("runBackfillCli: handles --help without touching network", async () => {
  const logs: string[] = [];
  const code = await runBackfillCli(["--help"], {
    logger: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
  });
  assertEquals(code, 0);
  assert(logs.some((l) => l.includes("Usage: deno task venue-tag:backfill-types")));
  assert(logs.some((l) => l.includes("--apply")));
  assert(logs.some((l) => l.includes("--overwrite")));
});

Deno.test("runBackfillCli: fails closed with non-zero exit code on non-affirmative --apply", async () => {
  const errors: string[] = [];
  const code = await runBackfillCli(["--apply=no"], {
    logger: { log: () => {}, error: (m) => errors.push(m) },
  });
  assertEquals(code, 1);
  assert(errors.some((e) => e.includes("Must be affirmative")));
});

Deno.test("deno.json registers venue-tag:backfill-types with scoped permissions (Rule 12, Rule 21)", async () => {
  const repoRoot = new URL("../../", import.meta.url).pathname;
  const denoJsonText = await Deno.readTextFile(join(repoRoot, "deno.json"));
  const denoJson = JSON.parse(denoJsonText);

  assert(
    denoJson.tasks["venue-tag:backfill-types"],
    "deno.json must define task 'venue-tag:backfill-types'",
  );
  const taskCmd = denoJson.tasks["venue-tag:backfill-types"];
  assert(taskCmd.includes("scripts/venue-tag-backfill.ts"));
  assert(taskCmd.includes("--allow-net"));
  assert(taskCmd.includes("--allow-env"));
  assert(!taskCmd.includes("-A"), "Must not use blanket -A flag");

  // Verify scripts/venue-tag-backfill.ts exists
  const scriptStat = await Deno.stat(join(repoRoot, "scripts/venue-tag-backfill.ts"));
  assert(scriptStat.isFile);
});

Deno.test("Manual verification runbook conforms to format requirements (AC 4)", async () => {
  const runbookPath = join(
    Deno.env.get("HOME") || "/home/joshua",
    "Dropbox/web-jam-llms/gig-outreach/gig-outreach-backfill-manual-steps-2026-09-24.md",
  );

  try {
    const stat = await Deno.stat(runbookPath);
    if (!stat.isFile) return;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return; // Skip in environments where Dropbox is unmounted
    }
    throw err;
  }

  const result = await lintRunbookFile(runbookPath);
  assertEquals(
    result.valid,
    true,
    `Runbook has violations: ${JSON.stringify(result.violations)}`,
  );
});
