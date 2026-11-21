// ci_failure_report.test.ts — the fix-pr skill's CI read (web-jam-tools#1337)
//
// Every credential here is made up and built at run time, so no credential-shaped literal sits in
// this file. The reports must carry no part of any of them, nor the signed log link.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  ciFailureReport,
  type FetchJson,
  formatReport,
  sanitizeLog,
  WITHHELD,
} from "../src/ci-failure-report/report.ts";
import { main } from "../scripts/ci-failure-report.ts";

const BEGIN = "-----BEGIN " + "RSA PRIV" + "ATE KEY-----";
const END = "-----END " + "RSA PRIV" + "ATE KEY-----";

function randomBase64(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw));
}

/** A made-up multi-line private key: its markers and six 64-character body lines. */
function fakeKey(): { text: string; body: string[] } {
  const body = Array.from({ length: 6 }, () => randomBase64(48));
  return { text: [BEGIN, ...body, END].join("\n"), body };
}

function fakeGithubToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const pick = crypto.getRandomValues(new Uint8Array(36));
  return "gh" + "p_" + Array.from(pick, (b) => chars[b % chars.length]).join("");
}

/** No marker and no body line of the key appears anywhere in `text`. */
function assertNoKey(text: string, key: { body: string[] }): void {
  assert(!text.includes("BEGIN "), "a key marker reached the output");
  assert(!text.includes("PRIV" + "ATE KEY"), "a key marker reached the output");
  for (const line of key.body) {
    assert(!text.includes(line), "a key body line reached the output");
    assert(!text.includes(line.slice(0, 16)), "part of a key body line reached the output");
  }
}

Deno.test("sanitizeLog withholds every line of a multi-line private key", () => {
  const key = fakeKey();
  const out = sanitizeLog(`step started\n${key.text}\nerror: expected 1, got 2\n`);
  assertNoKey(out, key);
  assertStringIncludes(out, WITHHELD);
  assertStringIncludes(out, "step started");
  assertStringIncludes(out, "error: expected 1, got 2");
});

Deno.test("sanitizeLog withholds a key written on one line with escaped newlines", () => {
  const key = fakeKey();
  const oneLine = `{"private_key": "${key.text.replaceAll("\n", "\\n")}", "type": "x"}`;
  const out = sanitizeLog(`loading credentials\n${oneLine}\ndone\n`);
  assertNoKey(out, key);
  assertStringIncludes(out, "done");
});

Deno.test("sanitizeLog withholds the rest of the log after a key that never ends", () => {
  const key = fakeKey();
  const cut = [BEGIN, ...key.body.slice(0, 3)].join("\n");
  const out = sanitizeLog(`before\n${cut}`);
  assertNoKey(out, key);
  assertStringIncludes(out, "before");
});

Deno.test("sanitizeLog withholds a bare base64 run and a token the credential check knows", () => {
  const run = randomBase64(48);
  const token = fakeGithubToken();
  const out = sanitizeLog(`${run}\nusing token ${token}\nok`);
  assert(!out.includes(run));
  assert(!out.includes(token));
  assertEquals(out.split("\n"), [WITHHELD, WITHHELD, "ok"]);
});

Deno.test("sanitizeLog keeps ordinary failure output", () => {
  const log = [
    "error: Test failed",
    "FAILED | 12 passed | 1 failed (3s)",
    "Expected deno.json version 1.68.0 to exceed 1.67.0",
  ].join("\n");
  assertEquals(sanitizeLog(log), log);
});

// --- The report, through a fake CircleCI ---

const REPO = "web-jam-tools";
const BRANCH = "agy/1337-skills-fix-pr-add-the-skill-and-install";
const HEAD = "70fc9e01a97c9deed872a236d44cbeb12bfcd81f";
const BASE = `https://circleci.com/api/v1.1/project/github/WebJamApps/${REPO}`;
const SIGNED = "https://circleci.com/api/private/output/presigned/abc?token=SIGNEDLINKSECRET123";

function fakeCircle(output: string, overrides: Record<string, unknown> = {}): FetchJson {
  const responses: Record<string, unknown> = {
    [`${BASE}/tree/${encodeURIComponent(BRANCH)}?limit=1&shallow=true`]: [
      { build_num: 2824, vcs_revision: HEAD },
    ],
    [`${BASE}/2824`]: {
      build_num: 2824,
      build_url: "https://circleci.com/gh/WebJamApps/web-jam-tools/2824",
      status: "failed",
      steps: [
        { name: "Checkout", actions: [{ failed: null, exit_code: 0, output_url: null }] },
        { name: "Unit tests", actions: [{ failed: true, exit_code: 1, output_url: SIGNED }] },
      ],
    },
    [SIGNED]: [{ message: output, time: "t", truncated: false, type: "out" }],
    ...overrides,
  };
  return (url) => {
    if (!(url in responses)) return Promise.reject(new Error(`unexpected ${url}`));
    const value = responses[url];
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  };
}

Deno.test("the report names the failed step and exit code, and carries no part of a multi-line key or the signed link", async () => {
  const key = fakeKey();
  const token = fakeGithubToken();
  const output = `running tests\n${key.text}\nauth ${token}\nerror: Test failed\n`;
  const text = formatReport(await ciFailureReport(REPO, BRANCH, HEAD, fakeCircle(output)));
  assertStringIncludes(text, "Build 2824 (failed)");
  assertStringIncludes(text, "Failed step: Unit tests (exit 1)");
  assertStringIncludes(text, "error: Test failed");
  assertNoKey(text, key);
  assert(!text.includes(token), "a token reached the report");
  assert(!text.includes("SIGNEDLINKSECRET123"), "the signed link reached the report");
  assert(!text.includes("api/private/output"), "the signed link reached the report");
});

Deno.test("the CLI prints the same sanitized report", async () => {
  const key = fakeKey();
  const printed: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => printed.push(parts.join(" "));
  try {
    const code = await main(
      ["--repo", REPO, "--branch", BRANCH, "--head", HEAD],
      fakeCircle(`${key.text}\nboom\n`),
    );
    assertEquals(code, 0);
  } finally {
    console.log = log;
  }
  const text = printed.join("\n");
  assertStringIncludes(text, "Failed step: Unit tests (exit 1)");
  assertNoKey(text, key);
});

Deno.test("a build for another commit, no build, or a failed lookup is CI unknown, never passing", async () => {
  const cases: Array<[string, FetchJson]> = [
    [
      "another commit",
      fakeCircle("x", {
        [`${BASE}/tree/${encodeURIComponent(BRANCH)}?limit=1&shallow=true`]: [
          { build_num: 2823, vcs_revision: "c99c1fd2ecd57876a7c4460f6b3eeb7f87506eba" },
        ],
      }),
    ],
    [
      "no build",
      fakeCircle("x", {
        [`${BASE}/tree/${encodeURIComponent(BRANCH)}?limit=1&shallow=true`]: [],
      }),
    ],
    [
      "lookup failed",
      fakeCircle("x", {
        [`${BASE}/tree/${encodeURIComponent(BRANCH)}?limit=1&shallow=true`]: new Error("HTTP 500"),
      }),
    ],
    ["build unreadable", fakeCircle("x", { [`${BASE}/2824`]: new Error("HTTP 404") })],
  ];
  for (const [name, fetchJson] of cases) {
    const report = await ciFailureReport(REPO, BRANCH, HEAD, fetchJson);
    assertEquals(report.kind, "unknown", name);
    assertStringIncludes(formatReport(report), "Do not treat this as a passing build", name);
  }
});

Deno.test("an output that cannot be read is said so, without repeating the signed link", async () => {
  const text = formatReport(
    await ciFailureReport(
      REPO,
      BRANCH,
      HEAD,
      fakeCircle("x", { [SIGNED]: new Error(`fetch ${SIGNED} failed`) }),
    ),
  );
  assertStringIncludes(text, "Failed step: Unit tests (exit 1)");
  assertStringIncludes(text, "(this step's output could not be read)");
  assert(!text.includes("SIGNEDLINKSECRET123"));
});

Deno.test("a build with no failed step says so", async () => {
  const fetchJson = fakeCircle("x", {
    [`${BASE}/2824`]: {
      build_num: 2824,
      build_url: "https://circleci.com/gh/WebJamApps/web-jam-tools/2824",
      status: "success",
      steps: [{ name: "Unit tests", actions: [{ failed: null, exit_code: 0 }] }],
    },
  });
  const text = formatReport(await ciFailureReport(REPO, BRANCH, HEAD, fetchJson));
  assertStringIncludes(text, "Build 2824 (success)");
  assertStringIncludes(text, "No step failed.");
});

Deno.test("a build still running with no failed step is not reported as passing", async () => {
  const fetchJson = fakeCircle("x", {
    [`${BASE}/2824`]: {
      build_num: 2824,
      build_url: "https://circleci.com/gh/WebJamApps/web-jam-tools/2824",
      status: "running",
      steps: [{ name: "Unit tests", actions: [{ failed: null, exit_code: null }] }],
    },
  });
  const text = formatReport(await ciFailureReport(REPO, BRANCH, HEAD, fetchJson));
  assertStringIncludes(text, "the build is running: do not treat it as passing");
  assert(!text.includes("No step failed."));
});
