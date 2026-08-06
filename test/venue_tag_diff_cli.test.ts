// venue_tag_diff_cli.test.ts — web-jam-tools venue-tag-diff
//
// Tests for the I/O half (src/venue-tag-diff/cli.ts): env-var auth config,
// the `GET /venue` response-shape normalization, proposal-file loading,
// report formatting, and main()'s wiring — all driven through stubbed
// `fetch`/env vars/temp files, never real network and never a real token.
//
// Also proves the token VALUE never appears in printed output. All fixture
// data below is synthetic; no real venue records anywhere in this file.

import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import {
  backendConfig,
  DEFAULT_BACKEND,
  fetchLiveVenues,
  formatReport,
  loadProposal,
  main,
} from "../src/venue-tag-diff/cli.ts";
import type { VenueTagDiffResult } from "../src/venue-tag-diff/diff.ts";

/** Temporarily swap console.log/console.error and capture what they were called with. */
async function withConsole(
  fn: () => Promise<void>,
): Promise<{ logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { logs, errors };
}

type Route = { status?: number; body: string };

/** Stub `globalThis.fetch` by exact URL and/or set env vars, restoring both afterward. */
async function withMocks(
  opts: { routes?: Record<string, Route>; env?: Record<string, string | undefined> },
  fn: () => void | Promise<void>,
): Promise<void> {
  const savedFetch = globalThis.fetch;
  const envKeys = Object.keys(opts.env ?? {});
  const savedEnv = new Map(envKeys.map((k) => [k, Deno.env.get(k)]));
  try {
    if (opts.routes) {
      globalThis.fetch = ((input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        const entry = opts.routes![url];
        if (!entry) return Promise.resolve(new Response("not found", { status: 404 }));
        return Promise.resolve(new Response(entry.body, { status: entry.status ?? 200 }));
      }) as typeof fetch;
    }
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await fn();
  } finally {
    globalThis.fetch = savedFetch;
    for (const [k, v] of savedEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

// --- backendConfig ---

Deno.test("backendConfig: default base URL, token from WEB_JAM_LLM_TOKEN", async () => {
  await withMocks({
    env: { WEB_JAM_LLM_TOKEN: "tok-123", WEB_JAM_BACK_URL: undefined },
  }, () => {
    assertEquals(backendConfig(), { baseUrl: DEFAULT_BACKEND, token: "tok-123" });
  });
});

Deno.test("backendConfig: WEB_JAM_BACK_URL override, trailing slash trimmed", async () => {
  await withMocks({
    env: { WEB_JAM_LLM_TOKEN: "tok-123", WEB_JAM_BACK_URL: "https://example.test/api///" },
  }, () => {
    assertEquals(backendConfig().baseUrl, "https://example.test/api");
  });
});

Deno.test("backendConfig: throws when WEB_JAM_LLM_TOKEN is unset, naming no file path", async () => {
  await withMocks({ env: { WEB_JAM_LLM_TOKEN: undefined } }, () => {
    assertThrows(() => backendConfig(), Error, "Missing WEB_JAM_LLM_TOKEN");
  });
});

// --- fetchLiveVenues: response-shape normalization ---

const VENUE_URL = `${DEFAULT_BACKEND}/venue`;
const CONFIG = { baseUrl: DEFAULT_BACKEND, token: "tok" };

Deno.test("fetchLiveVenues accepts a bare array response", async () => {
  await withMocks({
    routes: { [VENUE_URL]: { body: JSON.stringify([{ _id: "v1" }]) } },
  }, async () => {
    assertEquals(await fetchLiveVenues(CONFIG), [{ _id: "v1" }]);
  });
});

Deno.test("fetchLiveVenues unwraps a { venues: [...] } response", async () => {
  await withMocks({
    routes: { [VENUE_URL]: { body: JSON.stringify({ venues: [{ _id: "v2" }] }) } },
  }, async () => {
    assertEquals(await fetchLiveVenues(CONFIG), [{ _id: "v2" }]);
  });
});

Deno.test("fetchLiveVenues unwraps a { data: [...] } response", async () => {
  await withMocks({
    routes: { [VENUE_URL]: { body: JSON.stringify({ data: [{ _id: "v3" }] }) } },
  }, async () => {
    assertEquals(await fetchLiveVenues(CONFIG), [{ _id: "v3" }]);
  });
});

Deno.test("fetchLiveVenues returns [] for an object with neither venues nor data", async () => {
  await withMocks({
    routes: { [VENUE_URL]: { body: JSON.stringify({ status: "ok" }) } },
  }, async () => {
    assertEquals(await fetchLiveVenues(CONFIG), []);
  });
});

Deno.test("fetchLiveVenues returns [] for a non-array, non-object body", async () => {
  await withMocks({
    routes: { [VENUE_URL]: { body: "null" } },
  }, async () => {
    assertEquals(await fetchLiveVenues(CONFIG), []);
  });
});

Deno.test("fetchLiveVenues throws with status and body on a non-OK response", async () => {
  await withMocks({
    routes: { [VENUE_URL]: { status: 401, body: "unauthorized" } },
  }, async () => {
    await assertRejects(() => fetchLiveVenues(CONFIG), Error, "GET /venue failed: 401");
  });
});

// --- loadProposal ---

Deno.test("loadProposal parses a valid JSON array file", async () => {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(path, JSON.stringify([{ _id: "v1", name: "A" }]));
    assertEquals(await loadProposal(path), [{ _id: "v1", name: "A" }]);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("loadProposal throws when the file is not a JSON array", async () => {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(path, JSON.stringify({ not: "an array" }));
    await assertRejects(() => loadProposal(path), Error, "expected a JSON array");
  } finally {
    await Deno.remove(path);
  }
});

// --- formatReport ---

Deno.test("formatReport: all-matched report has no diverging/missing sections", () => {
  const result: VenueTagDiffResult = { matchedCount: 3, diverged: [], missing: [] };
  const report = formatReport(result, { liveCount: 10, proposalCount: 3 });
  assertStringIncludes(report, "live venues: 10");
  assertStringIncludes(report, "proposal records: 3");
  assertStringIncludes(report, "MATCH live DB : 3");
  assertStringIncludes(report, "DIVERGE from live   : 0");
  assertStringIncludes(report, "is GONE      : 0");
  assertEquals(report.includes("-- diverging"), false);
  assertEquals(report.includes("-- no longer in DB --"), false);
});

Deno.test("formatReport: lists diverging rows and missing names", () => {
  const result: VenueTagDiffResult = {
    matchedCount: 0,
    diverged: [
      {
        id: "v1",
        name: "The Blue Note",
        diffs: [{ field: "inScope", proposed: false, live: true }],
      },
    ],
    missing: [{ id: "v9", name: "Vanished Venue" }],
  };
  const report = formatReport(result, { liveCount: 5, proposalCount: 2 });
  assertStringIncludes(report, "-- diverging (name: field proposed -> live) --");
  assertStringIncludes(report, "The Blue Note: inScope false->true");
  assertStringIncludes(report, "-- no longer in DB --");
  assertStringIncludes(report, "Vanished Venue");
});

Deno.test("formatReport: truncates diverging/missing lists past 15 with a '... and N more' line", () => {
  const diverged = Array.from({ length: 17 }, (_, i) => ({
    id: `v${i}`,
    name: `Venue ${i}`,
    diffs: [{ field: "inScope" as const, proposed: false, live: true }],
  }));
  const missing = Array.from({ length: 17 }, (_, i) => ({ id: `m${i}`, name: `Missing ${i}` }));
  const report = formatReport({ matchedCount: 0, diverged, missing }, {
    liveCount: 1,
    proposalCount: 34,
  });
  assertStringIncludes(report, "... and 2 more");
  assertEquals(report.includes("Venue 16"), false); // 17th diverging row beyond the cap of 15
  assertEquals(report.includes("Missing 16"), false); // 17th missing name beyond the cap of 15
});

// --- main(): end-to-end wiring ---

Deno.test("main: prints usage and returns 1 when no proposal path is given", async () => {
  const { logs, errors } = await withConsole(async () => {
    const code = await main([]);
    assertEquals(code, 1);
  });
  assertEquals(logs, []);
  assertStringIncludes(errors.join("\n"), "Usage: deno task venue-tag:diff");
});

Deno.test("main: reports missing token and returns 1 when WEB_JAM_LLM_TOKEN is unset", async () => {
  await withMocks({ env: { WEB_JAM_LLM_TOKEN: undefined } }, async () => {
    const { logs, errors } = await withConsole(async () => {
      const code = await main(["/nonexistent/proposal.json"]);
      assertEquals(code, 1);
    });
    assertEquals(logs, []);
    assertStringIncludes(errors.join("\n"), "Missing WEB_JAM_LLM_TOKEN");
  });
});

Deno.test("main: reports an API error and returns 1 without ever printing the token value", async () => {
  await withMocks({
    env: { WEB_JAM_LLM_TOKEN: "super-secret-token-42" },
    routes: { [VENUE_URL]: { status: 500, body: "boom" } },
  }, async () => {
    const { logs, errors } = await withConsole(async () => {
      const code = await main(["/nonexistent/proposal.json"]);
      assertEquals(code, 1);
    });
    const allOutput = [...logs, ...errors].join("\n");
    assertStringIncludes(allOutput, "API error:");
    assertEquals(allOutput.includes("super-secret-token-42"), false);
  });
});

Deno.test("main: reports a proposal-file error and returns 1", async () => {
  await withMocks({
    env: { WEB_JAM_LLM_TOKEN: "tok" },
    routes: { [VENUE_URL]: { body: JSON.stringify([]) } },
  }, async () => {
    const { errors } = await withConsole(async () => {
      const code = await main(["/nonexistent/proposal.json"]);
      assertEquals(code, 1);
    });
    assertStringIncludes(errors.join("\n"), "No such file or directory");
  });
});

Deno.test("main: full success run prints the report and never the token value", async () => {
  const proposalPath = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(
      proposalPath,
      JSON.stringify([
        { _id: "v1", name: "The Blue Note", inScope: false },
        { _id: "ghost", name: "Vanished Venue", inScope: true },
      ]),
    );

    await withMocks({
      env: { WEB_JAM_LLM_TOKEN: "super-secret-token-99" },
      routes: {
        [VENUE_URL]: {
          body: JSON.stringify([{ _id: "v1", name: "The Blue Note", inScope: true }]),
        },
      },
    }, async () => {
      const { logs, errors } = await withConsole(async () => {
        const code = await main([proposalPath]);
        assertEquals(code, 0);
      });
      assertEquals(errors, []);
      const output = logs.join("\n");
      assertStringIncludes(output, "live venues: 1");
      assertStringIncludes(output, "proposal records: 2");
      assertStringIncludes(output, "DIVERGE from live   : 1");
      assertStringIncludes(output, "is GONE      : 1");
      assertStringIncludes(output, "The Blue Note: inScope false->true");
      assertStringIncludes(output, "Vanished Venue");
      assertEquals(output.includes("super-secret-token-99"), false);
    });
  } finally {
    await Deno.remove(proposalPath);
  }
});
