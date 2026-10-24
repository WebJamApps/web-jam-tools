// test/github_token_expiry_test.ts — web-jam-tools#1534
//
// Tests for GitHub token expiration checking and warnings.
// Design reference:
//   ~/Dropbox/web-jam-llms/Access_Controls/github-token-exposure-design.md
//   ("The replacement token").

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  checkTokenExpiry,
  evaluateExpiry,
  EXPIRY_HEADER_NAME,
  parseExpiryHeader,
  RUNBOOK_PATH,
} from "../src/github-token/check_expiry.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT_PATH = `${REPO_ROOT}src/github-token/check_expiry.ts`;

function formatDateHeader(date: Date): string {
  // Format as "YYYY-MM-DD HH:MM:SS UTC" matching GitHub API header
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss} UTC`;
}

Deno.test("parseExpiryHeader parses header case-insensitively and returns trimmed value", () => {
  const headers = [
    "HTTP/2.0 200 OK",
    "server: github.com",
    "github-authentication-token-expiration: 2026-11-20 12:00:00 UTC",
    "x-oauth-scopes: repo",
  ].join("\r\n");

  assertEquals(parseExpiryHeader(headers), "2026-11-20 12:00:00 UTC");

  const mixedCase = [
    "HTTP/2.0 200 OK",
    "GitHub-Authentication-Token-Expiration: 2026-12-01 00:00:00 UTC",
  ].join("\n");

  assertEquals(parseExpiryHeader(mixedCase), "2026-12-01 00:00:00 UTC");

  const noExpiry = [
    "HTTP/2.0 200 OK",
    "server: github.com",
    "x-oauth-scopes: admin:org, repo, workflow",
  ].join("\n");

  assertEquals(parseExpiryHeader(noExpiry), null);
});

Deno.test("evaluateExpiry: 30 days ahead produces no warning", () => {
  const now = new Date("2026-10-24T12:00:00Z");
  const expiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const header = formatDateHeader(expiry);

  const res = evaluateExpiry(header, now);
  assertEquals(res.hasExpiry, true);
  assertEquals(res.isWarning, false);
  assertEquals(res.message, undefined);
  assertEquals(res.isExpired, false);
});

Deno.test("evaluateExpiry: 14 days ahead produces warning naming date and runbook path", () => {
  const now = new Date("2026-10-24T12:00:00Z");
  const expiry = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const header = formatDateHeader(expiry);

  const res = evaluateExpiry(header, now);
  assertEquals(res.hasExpiry, true);
  assertEquals(res.isWarning, true);
  assert(res.message !== undefined);
  assert(res.message.includes(header), `message must name date: ${res.message}`);
  assert(res.message.includes(RUNBOOK_PATH), `message must name runbook: ${res.message}`);
});

Deno.test("evaluateExpiry: 1 day ahead produces warning naming date and runbook path", () => {
  const now = new Date("2026-10-24T12:00:00Z");
  const expiry = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);
  const header = formatDateHeader(expiry);

  const res = evaluateExpiry(header, now);
  assertEquals(res.hasExpiry, true);
  assertEquals(res.isWarning, true);
  assert(res.message !== undefined);
  assert(res.message.includes(header), `message must name date: ${res.message}`);
  assert(res.message.includes(RUNBOOK_PATH), `message must name runbook: ${res.message}`);
});

Deno.test("evaluateExpiry: no expiry header produces no warning", () => {
  const now = new Date("2026-10-24T12:00:00Z");
  const res = evaluateExpiry(null, now);
  assertEquals(res.hasExpiry, false);
  assertEquals(res.isWarning, false);
  assertEquals(res.message, undefined);
});

Deno.test("checkTokenExpiry function: unit test with stubs", async () => {
  const now = new Date("2026-10-24T12:00:00Z");
  const warnings: string[] = [];
  const warn = (msg: string) => warnings.push(msg);

  // 1. 30 days ahead -> ok, no warning
  warnings.length = 0;
  const expiry30 = formatDateHeader(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000));
  const res30 = await checkTokenExpiry({
    headersText: `${EXPIRY_HEADER_NAME}: ${expiry30}\n`,
    now,
    warn,
  });
  assertEquals(res30.status, "ok");
  assertEquals(warnings.length, 0);

  // 2. 14 days ahead -> warning, names date and runbook
  warnings.length = 0;
  const expiry14 = formatDateHeader(new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000));
  const res14 = await checkTokenExpiry({
    headersText: `${EXPIRY_HEADER_NAME}: ${expiry14}\n`,
    now,
    warn,
  });
  assertEquals(res14.status, "warning");
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes(expiry14));
  assert(warnings[0].includes(RUNBOOK_PATH));

  // 3. 1 day ahead -> warning, names date and runbook
  warnings.length = 0;
  const expiry1 = formatDateHeader(new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000));
  const res1 = await checkTokenExpiry({
    headersText: `${EXPIRY_HEADER_NAME}: ${expiry1}\n`,
    now,
    warn,
  });
  assertEquals(res1.status, "warning");
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes(expiry1));
  assert(warnings[0].includes(RUNBOOK_PATH));

  // 4. No expiry header -> ok, no warning
  warnings.length = 0;
  const resNoExpiry = await checkTokenExpiry({
    headersText: "HTTP/2.0 200 OK\r\nx-oauth-scopes: repo\r\n",
    now,
    warn,
  });
  assertEquals(resNoExpiry.status, "ok");
  assertEquals(warnings.length, 0);

  // 5. Failing call -> error status, logs warning without throwing, names runbook
  warnings.length = 0;
  const resFail = await checkTokenExpiry({
    runCmd: () => Promise.resolve({ code: 1, stdout: "", stderr: "gh: Not Found" }),
    now,
    warn,
  });
  assertEquals(resFail.status, "error");
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("could not check GitHub token expiry"));
  assert(warnings[0].includes(RUNBOOK_PATH));
});

Deno.test("check-token-expiry task subprocess: feeds 30 days, 14 days, 1 day, no header, and failing call", async () => {
  const syntheticToken = "synthetic_ghp_SECRET_CANARY_TOKEN_98765";
  const now = new Date("2026-10-24T12:00:00Z");
  const nowIso = now.toISOString();

  async function runSubprocess(envOverrides: Record<string, string>) {
    const cmd = new Deno.Command("deno", {
      args: ["run", "--allow-env", "--allow-run", SCRIPT_PATH],
      env: {
        ...Deno.env.toObject(),
        GH_TOKEN: syntheticToken,
        GITHUB_TOKEN: syntheticToken,
        GITHUB_TOKEN_EXPIRY_NOW: nowIso,
        ...envOverrides,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    const outStr = new TextDecoder().decode(stdout);
    const errStr = new TextDecoder().decode(stderr);

    // Verify token is NEVER printed
    assertFalse(outStr.includes(syntheticToken), "token must never appear in stdout");
    assertFalse(errStr.includes(syntheticToken), "token must never appear in stderr");

    return { code, outStr, errStr };
  }

  // 1. 30 days ahead: no warning, exit 0
  const date30 = formatDateHeader(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000));
  const sub30 = await runSubprocess({
    GITHUB_TOKEN_EXPIRY_TEST_HEADERS: `${EXPIRY_HEADER_NAME}: ${date30}\n`,
  });
  assertEquals(sub30.code, 0);
  assertEquals(sub30.errStr, "");

  // 2. 14 days ahead: prints date and runbook path, exit 0
  const date14 = formatDateHeader(new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000));
  const sub14 = await runSubprocess({
    GITHUB_TOKEN_EXPIRY_TEST_HEADERS: `${EXPIRY_HEADER_NAME}: ${date14}\n`,
  });
  assertEquals(sub14.code, 0);
  assert(sub14.errStr.includes(date14), `expected date ${date14} in stderr: ${sub14.errStr}`);
  assert(sub14.errStr.includes(RUNBOOK_PATH), `expected runbook in stderr: ${sub14.errStr}`);

  // 3. 1 day ahead: prints date and runbook path, exit 0
  const date1 = formatDateHeader(new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000));
  const sub1 = await runSubprocess({
    GITHUB_TOKEN_EXPIRY_TEST_HEADERS: `${EXPIRY_HEADER_NAME}: ${date1}\n`,
  });
  assertEquals(sub1.code, 0);
  assert(sub1.errStr.includes(date1), `expected date ${date1} in stderr: ${sub1.errStr}`);
  assert(sub1.errStr.includes(RUNBOOK_PATH), `expected runbook in stderr: ${sub1.errStr}`);

  // 4. No expiry header: no warning, exit 0
  const subNoHeader = await runSubprocess({
    GITHUB_TOKEN_EXPIRY_TEST_HEADERS: "HTTP/2.0 200 OK\r\nx-oauth-scopes: repo\r\n",
  });
  assertEquals(subNoHeader.code, 0);
  assertEquals(subNoHeader.errStr, "");

  // 5. Failing call: warning without stopping, exit 0, names runbook
  const subFail = await runSubprocess({
    GITHUB_TOKEN_EXPIRY_MOCK_FAILURE: "1",
  });
  assertEquals(subFail.code, 0);
  assert(subFail.errStr.includes("warning: could not check GitHub token expiry"));
  assert(subFail.errStr.includes(RUNBOOK_PATH));
});
