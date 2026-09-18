// write_backend_approval_token.test.ts
//
// Tests scripts/write_backend_approval_token.ts, closing the trap left by web-jam-tools#1075
// "hooks/backend-guard: guard production backend mutations and enforce venue-mining skill
// boundaries": that PR merged a guard (hooks/lib/check_backend_mutation.ts /
// hooks/block-backend-mutation.sh) whose only approval path is a session token file that nothing
// in the repo wrote. These tests prove the writer produces a file the guard's OWN
// checkSessionToken accepts, and that it rejects the file the same way it would reject any other
// invalid token — expired, wrong endpoint, mismatched presented token.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildBackendApprovalToken,
  DEFAULT_ENDPOINTS,
  DEFAULT_TTL_MINUTES,
  generateToken,
  redactToken,
  writeBackendApprovalToken,
  writeBackendApprovalTokenSync,
} from "../scripts/write_backend_approval_token.ts";
import { checkSessionToken } from "../hooks/lib/check_backend_mutation.ts";

const SCRIPT_PATH = new URL(
  "../scripts/write_backend_approval_token.ts",
  import.meta.url,
).pathname;

async function runCli(
  args: string[],
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-write",
      SCRIPT_PATH,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
    ...(env ? { env, clearEnv: true } : {}),
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

// --- buildBackendApprovalToken unit tests ---

Deno.test("buildBackendApprovalToken: applies defaults (generated token, default endpoints, default TTL)", () => {
  const before = Date.now();
  const token = buildBackendApprovalToken();
  assertEquals(token.endpoints, [...DEFAULT_ENDPOINTS]);
  assertEquals(token.session_id, undefined);
  assert(token.token && token.token.length > 0);
  const expMs = Date.parse(token.expires_at);
  assert(!Number.isNaN(expMs));
  // Within a few seconds of now + DEFAULT_TTL_MINUTES.
  const expectedMs = before + DEFAULT_TTL_MINUTES * 60_000;
  assert(Math.abs(expMs - expectedMs) < 5_000, `expiry too far from expected: ${expMs}`);
});

Deno.test("buildBackendApprovalToken: honors explicit session id, token, endpoints, ttlMinutes", () => {
  const token = buildBackendApprovalToken({
    sessionId: "sess-1",
    token: "explicit-token-value",
    endpoints: ["/venue", "/venue/*"],
    ttlMinutes: 5,
  });
  assertEquals(token.session_id, "sess-1");
  assertEquals(token.token, "explicit-token-value");
  assertEquals(token.endpoints, ["/venue", "/venue/*"]);
  const expMs = Date.parse(token.expires_at);
  assert(expMs <= Date.now() + 5 * 60_000 + 2_000);
  assert(expMs > Date.now());
});

Deno.test("buildBackendApprovalToken: honors explicit expiresAt over ttlMinutes", () => {
  const customIso = "2030-01-01T00:00:00.000Z";
  const token = buildBackendApprovalToken({ expiresAt: customIso, ttlMinutes: 999 });
  assertEquals(token.expires_at, customIso);
});

Deno.test("buildBackendApprovalToken: throws on unparseable expiresAt", () => {
  assertThrows(
    () => buildBackendApprovalToken({ expiresAt: "not-a-date" }),
    Error,
    "Invalid expiresAt",
  );
});

Deno.test("buildBackendApprovalToken: throws on a non-positive ttlMinutes", () => {
  assertThrows(
    () => buildBackendApprovalToken({ ttlMinutes: 0 }),
    Error,
    "ttlMinutes must be a positive number",
  );
  assertThrows(
    () => buildBackendApprovalToken({ ttlMinutes: -5 }),
    Error,
    "ttlMinutes must be a positive number",
  );
});

Deno.test("buildBackendApprovalToken: throws on an empty endpoints array", () => {
  assertThrows(
    () => buildBackendApprovalToken({ endpoints: [] }),
    Error,
    "endpoints must contain at least one",
  );
  assertThrows(
    () => buildBackendApprovalToken({ endpoints: ["  ", ""] }),
    Error,
    "endpoints must contain at least one",
  );
});

Deno.test("buildBackendApprovalToken: omits session_id entirely when not given (rather than writing an empty string)", () => {
  const token = buildBackendApprovalToken({ sessionId: "   " });
  assertEquals(Object.prototype.hasOwnProperty.call(token, "session_id"), false);
});

// --- generateToken / redactToken unit tests ---

Deno.test("generateToken: produces distinct, non-empty hex-looking values", () => {
  const a = generateToken();
  const b = generateToken();
  assert(a.length >= 32);
  assert(/^[0-9a-f]+$/.test(a));
  assert(a !== b);
});

Deno.test("redactToken: never returns the full value for a normal-length token", () => {
  const secret = "super-secret-bearer-value-1234567890";
  const redacted = redactToken(secret);
  assert(!redacted.includes(secret));
  assertEquals(redacted, "super-...(redacted)");
});

Deno.test("redactToken: masks a short token entirely rather than partially revealing it", () => {
  assertEquals(redactToken("abc"), "***");
  assertEquals(redactToken(""), "");
});

// --- writeBackendApprovalToken / writeBackendApprovalTokenSync: file shape and permissions ---

Deno.test("writeBackendApprovalToken: creates missing parent directories and writes the token file with 0600 permissions", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/nested/subdir/backend-approval-token.json`;
  try {
    // Every call in this suite passes an explicit tokenPath — never exercise the real default
    // path (~/.claude/state/backend-approval-token.json), which would write to the actual
    // laptop state directory as a side effect of running the test suite.
    const { token, path: nestedPath } = await writeBackendApprovalToken({
      sessionId: "session-xyz",
      endpoints: ["/venue", "/venue/*"],
      tokenPath,
    });
    assert(token.token);
    assertEquals(nestedPath, tokenPath);
    const info = await Deno.stat(tokenPath);
    assert(info.isFile);
    // Owner-only permissions: mode & 0o777 === 0o600.
    assert(info.mode !== null);
    assertEquals((info.mode as number) & 0o777, 0o600);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeBackendApprovalTokenSync: writes synchronously with 0600 permissions and creates parent dirs", () => {
  const dir = Deno.makeTempDirSync();
  const tokenPath = `${dir}/a/b/c/backend-approval-token.json`;
  try {
    const { token, path } = writeBackendApprovalTokenSync({ tokenPath });
    assertEquals(path, tokenPath);
    assert(token.token);
    const info = Deno.statSync(tokenPath);
    assertEquals((info.mode as number) & 0o777, 0o600);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

// --- Round-trip: the guard's OWN checkSessionToken accepts what this writer produces ---

Deno.test("Round-trip: checkSessionToken ALLOWS a venue mutation with no presented token, using only the written file", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/backend-approval-token.json`;
  try {
    await writeBackendApprovalToken({ sessionId: "sess-1", tokenPath, ttlMinutes: 30 });
    const result = checkSessionToken(tokenPath, "sess-1", "/venue");
    assertEquals(result.valid, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Round-trip: checkSessionToken ALLOWS when the presented token matches the written token's value", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/backend-approval-token.json`;
  try {
    const { token } = await writeBackendApprovalToken({
      sessionId: "sess-1",
      token: "known-value-for-test",
      tokenPath,
    });
    const result = checkSessionToken(tokenPath, "sess-1", "/venue", Date.now(), token.token);
    assertEquals(result.valid, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Round-trip: checkSessionToken REJECTS an expired token (past ttlMinutes)", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/backend-approval-token.json`;
  try {
    // Write a token whose expires_at is already in the past.
    await writeBackendApprovalToken({
      sessionId: "sess-1",
      tokenPath,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const result = checkSessionToken(tokenPath, "sess-1", "/venue");
    assertEquals(result.valid, false);
    assert(result.reason?.includes("expired"), result.reason);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Round-trip: checkSessionToken REJECTS an endpoint outside the written --endpoints scope", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/backend-approval-token.json`;
  try {
    await writeBackendApprovalToken({
      sessionId: "sess-1",
      endpoints: ["/venue-mining/verify"],
      tokenPath,
    });
    const result = checkSessionToken(tokenPath, "sess-1", "/venue");
    assertEquals(result.valid, false);
    assert(result.reason?.includes("does not cover endpoint"), result.reason);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Round-trip: checkSessionToken ALLOWS an endpoint covered by a trailing-wildcard pattern", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/backend-approval-token.json`;
  try {
    await writeBackendApprovalToken({
      sessionId: "sess-1",
      endpoints: ["/venue/*"],
      tokenPath,
    });
    const result = checkSessionToken(tokenPath, "sess-1", "/venue/42");
    assertEquals(result.valid, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Round-trip: checkSessionToken REJECTS a mismatched presented token", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/backend-approval-token.json`;
  try {
    await writeBackendApprovalToken({
      sessionId: "sess-1",
      token: "the-real-value",
      tokenPath,
    });
    const result = checkSessionToken(tokenPath, "sess-1", "/venue", Date.now(), "not-the-value");
    assertEquals(result.valid, false);
    assert(result.reason?.includes("does not match"), result.reason);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Round-trip: checkSessionToken REJECTS a session mismatch", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/backend-approval-token.json`;
  try {
    await writeBackendApprovalToken({ sessionId: "sess-A", tokenPath });
    const result = checkSessionToken(tokenPath, "sess-B", "/venue");
    assertEquals(result.valid, false);
    assert(result.reason?.includes("different session"), result.reason);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Round-trip: an unscoped token (no sessionId given) validates for any session", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/backend-approval-token.json`;
  try {
    await writeBackendApprovalToken({ tokenPath });
    const result = checkSessionToken(tokenPath, "any-session-id", "/venue");
    assertEquals(result.valid, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- CLI execution tests ---

Deno.test("CLI: writes a token file using defaults and prints a redacted confirmation", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/cli-default.json`;
  try {
    const res = await runCli(["--path", tokenPath], { ...Deno.env.toObject() });
    assertEquals(res.code, 0, res.stderr);
    assert(res.stdout.includes("Approval token successfully written to"));
    assert(res.stdout.includes(tokenPath));
    assert(!res.stdout.includes("expired"));

    const written = JSON.parse(await Deno.readTextFile(tokenPath));
    assert(typeof written.token === "string" && written.token.length > 0);
    // The full raw token must never appear in stdout.
    assert(!res.stdout.includes(written.token));
    assertEquals(written.endpoints, [...DEFAULT_ENDPOINTS]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: --json prints the token shape but redacts the token field", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/cli-json.json`;
  try {
    const res = await runCli(
      ["--path", tokenPath, "--session-id", "cli-sess", "--json"],
      { ...Deno.env.toObject() },
    );
    assertEquals(res.code, 0, res.stderr);
    const jsonLine = res.stdout.split("\n").find((l) => l.trim().startsWith("{"));
    assert(jsonLine !== undefined, res.stdout);
    // Re-read full JSON blob (may span multiple lines) up to the confirmation line.
    const jsonBlob = res.stdout.slice(res.stdout.indexOf("{"), res.stdout.lastIndexOf("}") + 1);
    const parsed = JSON.parse(jsonBlob);
    assertEquals(parsed.session_id, "cli-sess");
    assert(parsed.token.endsWith("(redacted)"));

    const written = JSON.parse(await Deno.readTextFile(tokenPath));
    assert(!res.stdout.includes(written.token));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: --endpoints accepts a comma-separated list", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/cli-endpoints-csv.json`;
  try {
    const res = await runCli(
      ["--path", tokenPath, "--endpoints", "/venue,/venue/*"],
      { ...Deno.env.toObject() },
    );
    assertEquals(res.code, 0, res.stderr);
    const written = JSON.parse(await Deno.readTextFile(tokenPath));
    assertEquals(written.endpoints, ["/venue", "/venue/*"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: --endpoints accepts a JSON array", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/cli-endpoints-json.json`;
  try {
    const res = await runCli(
      ["--path", tokenPath, "--endpoints", JSON.stringify(["/venue-mining/verify"])],
      { ...Deno.env.toObject() },
    );
    assertEquals(res.code, 0, res.stderr);
    const written = JSON.parse(await Deno.readTextFile(tokenPath));
    assertEquals(written.endpoints, ["/venue-mining/verify"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: --ttl-minutes controls expiry", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/cli-ttl.json`;
  try {
    const before = Date.now();
    const res = await runCli(
      ["--path", tokenPath, "--ttl-minutes", "1"],
      { ...Deno.env.toObject() },
    );
    assertEquals(res.code, 0, res.stderr);
    const written = JSON.parse(await Deno.readTextFile(tokenPath));
    const expMs = Date.parse(written.expires_at);
    assert(expMs <= before + 60_000 + 2_000);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: --expires-at overrides --ttl-minutes", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/cli-expires-at.json`;
  try {
    const res = await runCli(
      ["--path", tokenPath, "--ttl-minutes", "999", "--expires-at", "2031-06-01T00:00:00.000Z"],
      { ...Deno.env.toObject() },
    );
    assertEquals(res.code, 0, res.stderr);
    const written = JSON.parse(await Deno.readTextFile(tokenPath));
    assertEquals(written.expires_at, "2031-06-01T00:00:00.000Z");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: --token sets an explicit bearer value, never echoed in full to stdout", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/cli-explicit-token.json`;
  try {
    const res = await runCli(
      ["--path", tokenPath, "--token", "my-explicit-secret-value"],
      { ...Deno.env.toObject() },
    );
    assertEquals(res.code, 0, res.stderr);
    assert(!res.stdout.includes("my-explicit-secret-value"));
    const written = JSON.parse(await Deno.readTextFile(tokenPath));
    assertEquals(written.token, "my-explicit-secret-value");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: falls back to CLAUDE_CODE_SESSION_ID/CLAUDE_SESSION_ID/SESSION_ID env vars when --session-id is omitted", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/cli-env-session.json`;
  try {
    const res = await runCli(
      ["--path", tokenPath],
      { ...Deno.env.toObject(), CLAUDE_CODE_SESSION_ID: "env-session-id" },
    );
    assertEquals(res.code, 0, res.stderr);
    const written = JSON.parse(await Deno.readTextFile(tokenPath));
    assertEquals(written.session_id, "env-session-id");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: --help exits 0 and prints usage without writing a token file", async () => {
  const res = await runCli(["--help"], { ...Deno.env.toObject() });
  assertEquals(res.code, 0, res.stderr);
  assert(res.stdout.includes("Usage:"));
  assert(res.stdout.includes("backend-approval-token"));
});

Deno.test("CLI: exits 1 and reports the error when ttl-minutes is invalid", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/cli-bad-ttl.json`;
  try {
    const res = await runCli(
      ["--path", tokenPath, "--ttl-minutes=-1"],
      { ...Deno.env.toObject() },
    );
    assertEquals(res.code, 1);
    assert(res.stderr.includes("ttlMinutes must be a positive number"));
    const exists = await Deno.stat(tokenPath).then(() => true).catch(() => false);
    assertEquals(exists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: exits 1 and reports the error when expires-at is unparseable", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/cli-bad-expiry.json`;
  try {
    const res = await runCli(
      ["--path", tokenPath, "--expires-at", "definitely-not-a-date"],
      { ...Deno.env.toObject() },
    );
    assertEquals(res.code, 1);
    assert(res.stderr.includes("Invalid expiresAt"));
    const exists = await Deno.stat(tokenPath).then(() => true).catch(() => false);
    assertEquals(exists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Guard remediation text names the runnable command (closes the trap) ---

Deno.test("Guard remediation text names `deno task backend-approval-token`, not just the file path", async () => {
  const { checkBackendMutation } = await import("../hooks/lib/check_backend_mutation.ts");
  const dir = await Deno.makeTempDir();
  try {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: 'curl -X POST https://webjamsalem.herokuapp.com/venue -d \'{"name":"Test"}\'',
      },
    });
    const res = checkBackendMutation(payload, `${dir}/does-not-exist.json`);
    assert(res.startsWith("DENY:"), res);
    assert(res.includes("deno task backend-approval-token"), res);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
