// ci_failure_report.test.ts — shared CircleCI failure reporter (web-jam-tools#1337, #1910)
//
// Every credential here is made up and built at run time, so no credential-shaped literal sits in
// this file. The reports must carry no part of any of them, nor any signed log link.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  assertSafeReportText,
  ciFailureReport,
  type FetchJson,
  formatReport,
  PUBLIC_URL_UNAVAILABLE,
  sanitizeLog,
  sanitizePublicBuildUrl,
  WITHHELD,
  WITHHELD_FETCH_FAILED,
  WITHHELD_FORMAT_UNVERIFIED,
  WITHHELD_NO_OUTPUT,
  WITHHELD_SAFETY_FAILED,
  WITHHELD_SIGNED_URL,
} from "../src/ci-failure-report/report.ts";
import { createDefaultFetcher, isCircleCiApiUrl, main } from "../scripts/ci-failure-report.ts";

const BEGIN = "-----BEGIN " + "RSA PRIV" + "ATE KEY-----";
const END = "-----END " + "RSA PRIV" + "ATE KEY-----";

function randomBase64(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw));
}

function randomBase64Url(bytes: number): string {
  return randomBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function randomHex(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
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

function fakeJwt(): { jwt: string; part1: string; part2: string; part3: string } {
  const part1 = randomBase64Url(18);
  const part2 = randomBase64Url(18);
  const part3 = randomBase64Url(20);
  return { jwt: `eyJ${part1}.${part2}.${part3}`, part1, part2, part3 };
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

function assertNoJwt(
  text: string,
  jwtObj: { jwt: string; part1: string; part2: string; part3: string },
): void {
  assert(!text.includes(jwtObj.jwt), "full JWT reached the output");
  assert(!text.includes(jwtObj.part1), "JWT part 1 reached the output");
  assert(!text.includes(jwtObj.part2), "JWT part 2 reached the output");
  assert(!text.includes(jwtObj.part3), "JWT part 3 reached the output");
}

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

// --- Case list 1 (Cases 1–21; Case 22 lives in test/detect_credential_literal.test.ts) ---

Deno.test("Case 1: signed CircleCI presigned URL in step log text is withheld while failed step, exit code, and safe error stay visible", async () => {
  const tok = fakeJwt();
  const url =
    `https://circleci.com/api/private/output/presigned/d4dd534a-0000-0000-0000-000000000000/0/108?token=${tok.jwt}`;
  const output = `step started\nfetching ${url}\nerror: Test failed\n`;
  const text = formatReport(await ciFailureReport(REPO, BRANCH, HEAD, fakeCircle(output)));
  assertStringIncludes(text, "Failed step: Unit tests (exit 1)");
  assertStringIncludes(text, "step started");
  assertStringIncludes(text, WITHHELD_SIGNED_URL);
  assertStringIncludes(text, "error: Test failed");
  assert(!text.includes("private/output"), "private/output path reached the report");
  assertNoJwt(text, tok);
});

Deno.test("Case 2–6: CircleCI private output URL variants (raw, http, subdomain, no query, fragment) are all withheld", async () => {
  const tok = fakeJwt();
  const variants: Array<[string, string]> = [
    [
      "Case 2 raw",
      `https://circleci.com/api/private/output/raw/d4dd534a/0/108?token=${tok.jwt}`,
    ],
    [
      "Case 3 plain http",
      `http://circleci.com/api/private/output/presigned/abc?token=${tok.jwt}`,
    ],
    [
      "Case 4 subdomain",
      `https://app.circleci.com/api/private/output/presigned/abc?token=${tok.jwt}`,
    ],
    [
      "Case 5 no query string",
      "https://circleci.com/api/private/output/presigned/abc",
    ],
    [
      "Case 6 fragment suffix",
      `https://circleci.com/api/private/output/presigned/x#https://evil.example.com/?token=${tok.jwt}`,
    ],
  ];
  for (const [label, line] of variants) {
    const text = formatReport(
      await ciFailureReport(REPO, BRANCH, HEAD, fakeCircle(`before\n${line}\nafter\n`)),
    );
    assertStringIncludes(text, WITHHELD_SIGNED_URL, label);
    assertStringIncludes(text, "before", label);
    assertStringIncludes(text, "after", label);
    assert(!text.includes("private/output"), `${label}: path leaked`);
    assertNoJwt(text, tok);
  }
});

Deno.test("Case 7: signed CircleCI URL wrapped across two lines withholds both lines", async () => {
  const tok = fakeJwt();
  const output = [
    "before",
    "https://circleci.com/api/private/output/presigned/abc",
    `?token=${tok.jwt}`,
    "after",
  ].join("\n");
  const text = formatReport(await ciFailureReport(REPO, BRANCH, HEAD, fakeCircle(output)));
  assertStringIncludes(text, "before");
  assertStringIncludes(text, WITHHELD_SIGNED_URL);
  assertStringIncludes(text, "after");
  assert(!text.includes("private/output"));
  assertNoJwt(text, tok);
});

Deno.test("Case 8 & 9: webjam-fixture-ok never exempts a signed CircleCI URL or credential in step output", async () => {
  const tok = fakeJwt();
  const ghTok = fakeGithubToken();
  const pragma = "webjam-fixture-ok";
  const output = [
    `https://circleci.com/api/private/output/presigned/abc?token=${tok.jwt} // ${pragma}`,
    `const t = "${ghTok}"; // ${pragma}`,
    "error: Assertion failed",
  ].join("\n");
  const text = formatReport(await ciFailureReport(REPO, BRANCH, HEAD, fakeCircle(output)));
  assertStringIncludes(text, WITHHELD_SIGNED_URL);
  assertStringIncludes(text, WITHHELD);
  assertStringIncludes(text, "error: Assertion failed");
  assert(!text.includes("private/output"));
  assertNoJwt(text, tok);
  assert(!text.includes(ghTok));
});

Deno.test("Case 10–13: cloud presigned URL parameters are withheld unconditionally", async () => {
  const sig = randomHex(32);
  const tok = fakeJwt();
  const fakeAwsKeyId = "AKIA" + randomHex(8).toUpperCase();
  const urls: Array<[string, string]> = [
    [
      "Case 10 X-Amz-Signature",
      `https://circle-production-action-output.s3.amazonaws.com/obj?X-Amz-Signature=${sig}&X-Amz-Credential=${fakeAwsKeyId}`,
    ],
    [
      "Case 11 AWSAccessKeyId + Signature",
      `https://storage.example.net/logs/1?AWSAccessKeyId=${fakeAwsKeyId}&Signature=${sig}`,
    ],
    [
      "Case 12 GoogleAccessId + Signature",
      `https://storage.googleapis.com/bucket/log?GoogleAccessId=svc@proj.iam.gserviceaccount.com&Signature=${sig}`,
    ],
    [
      "Case 13 X-Amz-Security-Token",
      `https://s3.amazonaws.com/bucket/log?X-Amz-Security-Token=${tok.jwt}`,
    ],
  ];
  for (const [label, line] of urls) {
    const text = formatReport(
      await ciFailureReport(REPO, BRANCH, HEAD, fakeCircle(`ok\n${line}\nboom`)),
    );
    assertStringIncludes(text, WITHHELD_SIGNED_URL, label);
    assert(!text.includes(sig), `${label}: signature leaked`);
    assert(!text.includes("X-Amz-Signature"), `${label}: param leaked`);
    assert(!text.includes("AWSAccessKeyId"), `${label}: param leaked`);
    assert(!text.includes("GoogleAccessId"), `${label}: param leaked`);
    assert(!text.includes("X-Amz-Security-Token"), `${label}: param leaked`);
    assertNoJwt(text, tok);
  }
});

Deno.test("Case 14: multi-line PEM, escaped-newline PEM, unclosed PEM, bare base64 run, and GitHub token are withheld", () => {
  const key = fakeKey();
  const run = randomBase64(48);
  const token = fakeGithubToken();

  const outMulti = sanitizeLog(`step started\n${key.text}\nerror: expected 1, got 2\n`);
  assertNoKey(outMulti, key);
  assertStringIncludes(outMulti, WITHHELD);
  assertStringIncludes(outMulti, "error: expected 1, got 2");

  const oneLine = `{"private_key": "${key.text.replaceAll("\n", "\\n")}", "type": "x"}`;
  const outOneLine = sanitizeLog(`loading credentials\n${oneLine}\ndone\n`);
  assertNoKey(outOneLine, key);
  assertStringIncludes(outOneLine, "done");

  const cut = [BEGIN, ...key.body.slice(0, 3)].join("\n");
  const outCut = sanitizeLog(`before\n${cut}`);
  assertNoKey(outCut, key);
  assertStringIncludes(outCut, "before");

  const outRunAndToken = sanitizeLog(`${run}\nusing token ${token}\nok`);
  assert(!outRunAndToken.includes(run));
  assert(!outRunAndToken.includes(token));
  assertEquals(outRunAndToken.split("\n"), [WITHHELD, WITHHELD, "ok"]);
});

Deno.test("Case 15: safe failure lines and public CircleCI build URL pass through intact", async () => {
  const log = [
    "error: Test failed",
    "FAILED | 12 passed | 1 failed (3s)",
    "https://circleci.com/gh/WebJamApps/web-jam-tools/2826",
  ].join("\n");
  assertEquals(sanitizeLog(log), log);

  const text = formatReport(await ciFailureReport(REPO, BRANCH, HEAD, fakeCircle(log)));
  assertStringIncludes(
    text,
    "Build 2824 (failed): https://circleci.com/gh/WebJamApps/web-jam-tools/2824",
  );
  assertStringIncludes(text, "Failed step: Unit tests (exit 1)");
  assertStringIncludes(text, "error: Test failed");
  assertStringIncludes(text, "FAILED | 12 passed | 1 failed (3s)");
  assertStringIncludes(text, "https://circleci.com/gh/WebJamApps/web-jam-tools/2826");
});

Deno.test("Case 16: fetch failure refuses to quote log text and hides the signed URL", async () => {
  const text = formatReport(
    await ciFailureReport(
      REPO,
      BRANCH,
      HEAD,
      fakeCircle("x", { [SIGNED]: new Error(`fetch ${SIGNED} failed`) }),
    ),
  );
  assertStringIncludes(text, "Failed step: Unit tests (exit 1)");
  assertStringIncludes(text, WITHHELD_FETCH_FAILED);
  assert(!text.includes("Last "));
  assert(!text.includes("SIGNEDLINKSECRET123"));
  assert(!text.includes("private/output"));
});

Deno.test("Case 17: malformed JSON payload (non-array or non-string message) refuses to quote log text", async () => {
  for (const badBody of [{ ok: false }, [{ message: 123 }], [null]]) {
    const text = formatReport(
      await ciFailureReport(REPO, BRANCH, HEAD, fakeCircle("x", { [SIGNED]: badBody })),
    );
    assertStringIncludes(text, "Failed step: Unit tests (exit 1)");
    assertStringIncludes(text, WITHHELD_FORMAT_UNVERIFIED);
    assert(!text.includes("Last "));
  }
});

Deno.test("Case 18: sanitizer throw or post-check failure fails closed with safety check notice", async () => {
  const tok = fakeJwt();
  const unsafeLog =
    `line 1\nhttps://circleci.com/api/private/output/presigned/abc?token=${tok.jwt}\n`;

  // 1. Sanitizer throws at step level
  const textThrow = formatReport(
    await ciFailureReport(REPO, BRANCH, HEAD, fakeCircle(unsafeLog), {
      sanitize: () => {
        throw new Error("boom");
      },
    }),
  );
  assertStringIncludes(textThrow, "Failed step: Unit tests (exit 1)");
  assertStringIncludes(textThrow, WITHHELD_SAFETY_FAILED);
  assert(!textThrow.includes("line 1"));
  assert(!textThrow.includes("private/output"));
  assertNoJwt(textThrow, tok);

  // 2. Sanitizer leaks unredacted signed URL -> step-level assertSafeReportText catches it
  const textStepBypass = formatReport(
    await ciFailureReport(REPO, BRANCH, HEAD, fakeCircle(unsafeLog), {
      sanitize: (s) => s,
    }),
  );
  assertStringIncludes(textStepBypass, WITHHELD_SAFETY_FAILED);
  assert(!textStepBypass.includes("line 1"));
  assertNoJwt(textStepBypass, tok);

  // 3. Final report post-check catches an unredacted report passed directly to formatReport
  const textFinalBypass = formatReport(
    {
      kind: "read",
      build: 2824,
      buildUrl: "https://circleci.com/gh/WebJamApps/web-jam-tools/2824",
      status: "failed",
      failed: [{ step: "Unit tests", exitCode: 1, excerpt: [unsafeLog] }],
    },
    { sanitize: (s) => s },
  );
  assertStringIncludes(
    textFinalBypass,
    "Build 2824 (failed): https://circleci.com/gh/WebJamApps/web-jam-tools/2824",
  );
  assertStringIncludes(textFinalBypass, "Failed step: Unit tests (exit 1)");
  assertStringIncludes(textFinalBypass, WITHHELD_SAFETY_FAILED);
  assert(!textFinalBypass.includes("line 1"));
  assertNoJwt(textFinalBypass, tok);
});

Deno.test("Case 19: build lookup error containing a signed URL emits fixed label only", async () => {
  const tok = fakeJwt();
  const signedErrUrl = `https://circleci.com/api/private/output/presigned/abc?token=${tok.jwt}`;
  const text = formatReport(
    await ciFailureReport(
      REPO,
      BRANCH,
      HEAD,
      fakeCircle("x", {
        [`${BASE}/tree/${encodeURIComponent(BRANCH)}?limit=1&shallow=true`]: new Error(
          `request to ${signedErrUrl} failed`,
        ),
      }),
    ),
  );
  assertEquals(
    text,
    "CI unknown: the build lookup failed: network or parse error. Do not treat this as a passing build.",
  );
  assert(!text.includes("private/output"));
  assertNoJwt(text, tok);
});

Deno.test("Case 20: invalid or presigned detail.build_url is omitted with public build URL unavailable notice", async () => {
  const tok = fakeJwt();
  const badUrls = [
    `https://circleci.com/api/private/output/presigned/abc?token=${tok.jwt}`,
    "https://circleci.com/gh/WebJamApps/web-jam-tools/2824?token=secret12345",
  ];
  for (const badUrl of badUrls) {
    const text = formatReport(
      await ciFailureReport(
        REPO,
        BRANCH,
        HEAD,
        fakeCircle("error: failed", {
          [`${BASE}/2824`]: {
            build_num: 2824,
            build_url: badUrl,
            status: "failed",
            steps: [{
              name: "Unit tests",
              actions: [{ failed: true, exit_code: 1, output_url: SIGNED }],
            }],
          },
        }),
      ),
    );
    assertStringIncludes(text, `Build 2824 (failed): ${PUBLIC_URL_UNAVAILABLE}`);
    assert(!text.includes("private/output"));
    assert(!text.includes("token="));
    assertNoJwt(text, tok);
  }
});

Deno.test("Case 21: live CLI fetcher sends Circle-Token only on API endpoints and sets redirect: error on output_url", async () => {
  const calls: Array<{ url: string; headers?: HeadersInit; redirect?: RequestRedirect }> = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    calls.push({ url, headers: init?.headers, redirect: init?.redirect });
    if (url.includes("/tree/")) {
      return Promise.resolve(
        new Response(JSON.stringify([{ build_num: 2824, vcs_revision: HEAD }]), { status: 200 }),
      );
    }
    if (url.endsWith("/2824")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            build_num: 2824,
            build_url: "https://circleci.com/gh/WebJamApps/web-jam-tools/2824",
            status: "failed",
            steps: [{
              name: "Unit tests",
              actions: [{ failed: true, exit_code: 1, output_url: SIGNED }],
            }],
          }),
          { status: 200 },
        ),
      );
    }
    if (url === SIGNED) {
      return Promise.resolve(
        new Response(JSON.stringify([{ message: "error: Test failed\n" }]), { status: 200 }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  assertEquals(isCircleCiApiUrl(`${BASE}/2824`), true);
  assertEquals(isCircleCiApiUrl(SIGNED), false);

  const fetcher = createDefaultFetcher("fake-circle-token-val", fakeFetch);
  const report = await ciFailureReport(REPO, BRANCH, HEAD, fetcher);
  assertEquals(report.kind, "read");
  assertEquals(calls.length, 3);

  for (const apiCall of calls.slice(0, 2)) {
    const hdrs = apiCall.headers as Record<string, string> | undefined;
    assertEquals(hdrs?.["Circle-Token"], "fake-circle-token-val");
  }
  const outputCall = calls[2];
  assertEquals(outputCall.url, SIGNED);
  assertEquals(outputCall.headers, undefined);
  assertEquals(outputCall.redirect, "error");
});

// --- Additional existing & CLI checks ---

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

Deno.test("a missing output_url records no output without failing", async () => {
  const fetchJson = fakeCircle("x", {
    [`${BASE}/2824`]: {
      build_num: 2824,
      build_url: "https://circleci.com/gh/WebJamApps/web-jam-tools/2824",
      status: "failed",
      steps: [{ name: "Unit tests", actions: [{ failed: true, exit_code: 1, output_url: null }] }],
    },
  });
  const text = formatReport(await ciFailureReport(REPO, BRANCH, HEAD, fetchJson));
  assertStringIncludes(text, "Failed step: Unit tests (exit 1)");
  assertStringIncludes(text, WITHHELD_NO_OUTPUT);
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

Deno.test("assertSafeReportText throws on any unredacted signed URL or credential", () => {
  const tok = fakeJwt();
  const ghTok = fakeGithubToken();
  const key = fakeKey();
  const run = randomBase64(48);
  const badInputs = [
    `https://circleci.com/api/private/output/presigned/x?token=${tok.jwt}`,
    `https://s3.amazonaws.com/bucket?X-Amz-Signature=${randomHex(16)}`,
    key.text,
    `const t = "${ghTok}"; // webjam-fixture-ok`,
    run,
  ];
  for (const input of badInputs) {
    let threw = false;
    try {
      assertSafeReportText(input);
    } catch {
      threw = true;
    }
    assert(threw, `expected assertSafeReportText to reject: ${input.slice(0, 32)}`);
  }
});

Deno.test("sanitizePublicBuildUrl accepts app.circleci.com pipeline URLs and rejects userinfo or foreign hosts", () => {
  const pipelineUrl =
    "https://app.circleci.com/pipelines/gh/WebJamApps/web-jam-tools/100/workflows/abc";
  assertEquals(sanitizePublicBuildUrl(pipelineUrl), pipelineUrl);
  assertEquals(sanitizePublicBuildUrl(""), null);
  assertEquals(
    sanitizePublicBuildUrl("https://user:pass@circleci.com/gh/WebJamApps/web-jam-tools/1"),
    null,
  );
  assertEquals(sanitizePublicBuildUrl("https://circleci.com/gh/OtherOrg/repo/1"), null);
});

Deno.test("whitespace-only step output reports no output, and unknown report fails closed if verifySafe rejects", async () => {
  const text = formatReport(
    await ciFailureReport(REPO, BRANCH, HEAD, fakeCircle("   \n  \n")),
  );
  assertStringIncludes(text, WITHHELD_NO_OUTPUT);

  const fallback = formatReport(
    { kind: "unknown", reason: "the build lookup failed: HTTP 500" },
    {
      verifySafe: () => {
        throw new Error("blocked");
      },
    },
  );
  assertEquals(
    fallback,
    "CI unknown: build lookup could not be verified. Do not treat this as a passing build.",
  );
});
