import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type BackfillOptions,
  classifyVenue,
  parseAffirmativeFlag,
  runBackfill,
  runBackfillCli,
  type VenueRecord,
} from "../../src/venue-tag/backfill.ts";
import {
  createContextRequest,
  parseContextualClassifications,
} from "../../src/venue-tag/contextual.ts";

const knownVenue: VenueRecord = { _id: "known", name: "Valley Brewery" };
const unknownVenue: VenueRecord = {
  _id: "unknown",
  name: "The Green Door",
  genre: "folk",
  notes: "Seated ticketed performances; guests focus on the musicians.",
};

function backend(data: unknown) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const logs: string[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Promise.resolve(new Response(JSON.stringify(method === "GET" ? data : {})));
  };
  const options: BackfillOptions = {
    // Generated authentication fixture; the injected fetch never contacts a provider.
    token: crypto.randomUUID(),
    backendUrl: "https://example.invalid",
    fetchFn,
    logger: { log: (line) => logs.push(line), error: (line) => logs.push(line) },
  };
  return { options, calls, logs, patches: () => calls.filter((call) => call.method === "PATCH") };
}

async function decisionFor(venue = unknownVenue) {
  const request = await createContextRequest(venue);
  return {
    venueId: venue._id,
    contextHash: request.contextHash,
    type: "Originals" as const,
    reason: "Ticketed seated performances indicate a dedicated listening venue.",
  };
}

Deno.test("confirmation flags reject repeats, empty values, negatives and normalization", () => {
  for (const flag of ["apply", "overwrite"]) {
    for (
      const args of [
        [`--${flag}`, `--${flag}=no`],
        [`--${flag}=no`, `--${flag}`],
        [`--${flag}=true`, `--${flag}=false`],
        [`--${flag}`, `--${flag}`],
        [`--${flag}=`],
        [`--${flag}`, ""],
        [`--${flag}`, "-1"],
        [`--${flag}=TRUE`],
        [`--${flag}= true `],
      ]
    ) {
      const result = parseAffirmativeFlag(flag, args);
      assertEquals(result.affirmative, false, JSON.stringify(args));
      assert(result.error);
    }
    for (const value of ["true", "yes", "1"]) {
      assertEquals(parseAffirmativeFlag(flag, [`--${flag}=${value}`]).affirmative, true);
    }
  }
});

Deno.test("CLI rejects conflicting and malformed flags before any HTTP request", async () => {
  for (
    const args of [
      ["--apply", "--apply=no"],
      ["--apply", "--overwrite", "--overwrite=no"],
      ["--apply", "--dry-run"],
      ["--apply", "--context-json"],
      ["--apply", "--unknown"],
      ["--apply", "--token"],
      ["--contextual-types", "invalid-json"],
      ["--backend-url=one", "--backend-url=two"],
    ]
  ) {
    const mock = backend([knownVenue]);
    const code = await runBackfillCli(args, mock.options);
    assertEquals(code, 1, JSON.stringify(args));
    assertEquals(mock.calls.length, 0);
  }
});

Deno.test("classifier defers competing categories across all context fields", () => {
  for (
    const venue of [
      { _id: "a", name: "Roanoke Taproom & Grill" },
      { _id: "b", name: "Craft Kitchen & Brewing" },
      { _id: "c", name: "Valley Brewery", notes: "Dedicated listening room" },
      { _id: "d", name: "Coffee House", genre: "songwriter" },
      { _id: "e", name: "Coffee House", type: "Pub" },
    ]
  ) {
    const match = classifyVenue(venue);
    assertEquals(match.type, null);
    assertStringIncludes(match.reason, "competing categories");
  }
});

Deno.test("classifier includes the approved winery, vineyard, beer and acoustic stage rules", () => {
  for (const name of ["Valley Winery", "Valley Vineyards", "Valley Beer"]) {
    assertEquals(classifyVenue({ _id: name, name }).type, "PubFestivalBrewery");
  }
  assertEquals(classifyVenue({ _id: "stage", name: "Valley Acoustic Stage" }).type, "Originals");
  assertEquals(classifyVenue({ _id: "accent", name: "Café Oasis" }).type, "MidRangeCafeBar");
  assertEquals(classifyVenue({ _id: "word", name: "Beersmith" }).type, null);
});

Deno.test("preview retains unresolved records and exports only classification context", async () => {
  const mock = backend([
    knownVenue,
    { ...unknownVenue, email: "contact@example.invalid", token: "never-export-this-field" },
  ]);
  const result = await runBackfill(mock.options);
  assertEquals(result.proposed[1].proposedType, null);
  assertEquals(result.contextRequests.length, 1);
  assertEquals(result.contextRequests[0].venueId, unknownVenue._id);
  assertEquals(mock.patches().length, 0);
  assert(mock.logs.some((line) => line.includes("(needs context)")));
  assertEquals(Object.hasOwn(result.contextRequests[0].context, "email"), false);
  assertEquals(Object.hasOwn(result.contextRequests[0].context, "token"), false);
});

Deno.test("apply refuses the whole batch while any contextual classification is unresolved", async () => {
  const mock = backend([knownVenue, unknownVenue]);
  let prompted = false;
  await assertRejects(
    () =>
      runBackfill({
        ...mock.options,
        apply: true,
        confirmProposal: () => {
          prompted = true;
          return true;
        },
      }),
    Error,
    "resolve every contextual classification",
  );
  assertEquals(prompted, false);
  assertEquals(mock.patches().length, 0);
});

Deno.test("apply waits for approval of the freshly displayed proposal", async () => {
  const mock = backend([knownVenue]);
  await runBackfill({
    ...mock.options,
    apply: true,
    confirmProposal: (proposed) => {
      assertEquals(mock.patches().length, 0);
      assertEquals(proposed[0].venueId, knownVenue._id);
      assert(mock.logs.some((line) => line.includes("Valley Brewery")));
      return Promise.resolve(true);
    },
  });
  assertEquals(mock.patches().length, 1);
  assertEquals(mock.patches()[0].body, { venueType: "PubFestivalBrewery" });
});

Deno.test("absent, denied, throwing and non-boolean confirmation perform zero writes", async () => {
  const confirmations: Array<BackfillOptions["confirmProposal"]> = [
    undefined,
    () => false,
    () => "yes" as unknown as boolean,
    () => {
      throw new Error("confirmation unavailable");
    },
  ];
  for (const confirmProposal of confirmations) {
    const mock = backend([knownVenue]);
    await assertRejects(() => runBackfill({ ...mock.options, apply: true, confirmProposal }));
    assertEquals(mock.patches().length, 0);
  }
});

Deno.test("a preview never approves a changed apply batch", async () => {
  const records = [knownVenue];
  const mock = backend(records);
  await runBackfill(mock.options);
  records.push({ _id: "later", name: "Later Cafe" });
  await assertRejects(
    () =>
      runBackfill({
        ...mock.options,
        apply: true,
        confirmProposal: (proposal) => {
          assertEquals(proposal.length, 2);
          assertEquals(proposal[1].venueId, "later");
          return false;
        },
      }),
  );
  assertEquals(mock.patches().length, 0);
});

Deno.test("session contextual decisions resolve an ambiguous venue before batch approval", async () => {
  const mock = backend([knownVenue, unknownVenue]);
  const result = await runBackfill({
    ...mock.options,
    apply: true,
    contextualTypes: [await decisionFor()],
    confirmProposal: (proposal) => {
      assertEquals(proposal[1].proposedType, "Originals");
      assertStringIncludes(proposal[1].reason, "contextual LLM classification");
      assertEquals(mock.patches().length, 0);
      return true;
    },
  });
  assertEquals(result.contextRequests.length, 0);
  assertEquals(result.appliedCount, 2);
});

Deno.test("stale contextual decisions abort before approval or any PATCH", async () => {
  const contextualTypes = [await decisionFor()];
  for (const change of [{ notes: "changed" }, { genre: "changed" }, { name: "changed" }]) {
    const mock = backend([knownVenue, { ...unknownVenue, ...change }]);
    await assertRejects(
      () =>
        runBackfill({ ...mock.options, apply: true, contextualTypes, confirmProposal: () => true }),
      Error,
      "Context changed",
    );
    assertEquals(mock.patches().length, 0);
  }
});

Deno.test("contextual decisions cannot override deterministic or out-of-batch venues", async () => {
  for (const venue of [knownVenue, { ...unknownVenue, _id: "outside" }]) {
    const mock = backend([knownVenue, unknownVenue]);
    const contextualTypes = [await decisionFor(venue)];
    await assertRejects(() =>
      runBackfill({
        ...mock.options,
        apply: true,
        contextualTypes,
        confirmProposal: () => true,
      })
    );
    assertEquals(mock.patches().length, 0);
  }
});

Deno.test("contextual decision schema rejects missing evidence, invalid types and duplicates", async () => {
  const valid = await decisionFor();
  assertEquals(parseContextualClassifications(JSON.stringify([valid])), [valid]);
  for (
    const invalid of [
      null,
      {},
      [null],
      [{ ...valid, venueId: "" }],
      [{ ...valid, contextHash: "bad" }],
      [{ ...valid, type: "unsupported" }],
      [{ ...valid, reason: " " }],
      [{ ...valid, reason: "a".repeat(2001) }],
      [valid, valid],
    ]
  ) {
    const mock = backend([knownVenue]);
    await assertRejects(() =>
      runBackfill({
        ...mock.options,
        contextualTypes: invalid as unknown as BackfillOptions["contextualTypes"],
      })
    );
    assertEquals(mock.calls.length, 0);
  }
});

Deno.test("CLI context export is valid JSON and never writes", async () => {
  const mock = backend([knownVenue, unknownVenue]);
  assertEquals(await runBackfillCli(["--context-json"], mock.options), 0);
  assertEquals(mock.logs.length, 1);
  const exported = JSON.parse(mock.logs[0]);
  assertEquals(exported.length, 1);
  assertEquals(exported[0].venueId, unknownVenue._id);
  assertEquals(mock.patches().length, 0);
});

Deno.test("CLI accepts contextual JSON and still requires fresh confirmation", async () => {
  const mock = backend([unknownVenue]);
  const decision = await decisionFor();
  const code = await runBackfillCli([
    "--apply=yes",
    "--token",
    mock.options.token!,
    `--contextual-types=${JSON.stringify([decision])}`,
  ], { ...mock.options, confirmProposal: () => false });
  assertEquals(code, 1);
  assertEquals(mock.patches().length, 0);
  assert(mock.logs.some((line) => line.includes("not confirmed")));
});

Deno.test("invalid response shapes and records abort the batch before any writes", async () => {
  for (
    const data of [
      null,
      {},
      { data: "not-an-array" },
      [null],
      [knownVenue, { name: "Missing ID" }],
      [knownVenue, knownVenue],
      [{ ...knownVenue, name: 42 }],
      [{ ...knownVenue, genre: [42] }],
    ]
  ) {
    const mock = backend(data);
    await assertRejects(() =>
      runBackfill({ ...mock.options, apply: true, confirmProposal: () => true })
    );
    assertEquals(mock.patches().length, 0);
  }
});

Deno.test("empty and wrapped venue lists are supported without asking to write", async () => {
  for (const data of [[], { venues: [] }, { data: [] }]) {
    const mock = backend(data);
    const result = await runBackfill({ ...mock.options, apply: true });
    assertEquals(result.appliedCount, 0);
    assertEquals(result.contextRequests, []);
  }
});

Deno.test("library options reject non-boolean write flags before any HTTP request", async () => {
  for (const value of ["false", 1, null]) {
    for (const flag of ["apply", "overwrite"] as const) {
      const mock = backend([knownVenue]);
      await assertRejects(() =>
        runBackfill({
          ...mock.options,
          [flag]: value as unknown as boolean,
        })
      );
      assertEquals(mock.calls.length, 0);
    }
  }
});
