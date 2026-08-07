// block_secret_literals_hook.test.ts — web-jam-tools#304
//
// Exercises hooks/block-secret-literals.sh end-to-end by shelling out to it
// (Deno.Command) with mocked PreToolUse JSON on stdin, the same shape Claude
// Code's hook runner feeds it.
//
// This hook closes the gap left by the two existing secret guards: approving
// a Bash command containing a literal secret (e.g. `export
// GEMINI_API_KEY="<key>"`) persists the ENTIRE command string, secret
// included, into permissions.allow in ~/.claude/settings.json — permanently
// and in plaintext. scan-output-for-secrets.sh (PostToolUse) never sees it
// because `export` prints nothing; block-secret-dumps.sh (PreToolUse) only
// blocks READING a known secret FILE, not a literal passed as an argument.
//
// Every credential string below is SYNTHETIC, assembled at runtime via string
// concatenation — never a complete credential-shaped literal at rest in this
// file — so this file itself is never mistaken for a leak by the existing
// PostToolUse output scanner or any secret-scanning CI step.

import { assertEquals } from "@std/assert";

const SCRIPT_PATH = new URL("../hooks/block-secret-literals.sh", import.meta.url).pathname;

interface RunResult {
  code: number;
  stderr: string;
}

async function runHook(command: string): Promise<RunResult> {
  const input = JSON.stringify({ tool_input: { command } });
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code, stderr } = await child.output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

function assertBlocked(stderr: string) {
  if (!stderr.includes("BLOCKED (secret-literal guard)")) {
    throw new Error(`expected BLOCKED message in stderr, got: ${stderr}`);
  }
  if (!stderr.includes("~/.bashrc")) {
    throw new Error(`expected the bashrc alternative to be named, got: ${stderr}`);
  }
}

// Fake values assembled at runtime so no complete credential-shaped literal
// sits in the repo.
const FAKE = {
  google: "AIza" + "B".repeat(35),
  github: "ghp_" + "C".repeat(36),
  githubPat: "github_pat_" + "H".repeat(22),
  openai: "sk-" + "D".repeat(32),
  slack: "xoxb-" + "1".repeat(12),
  anthropic: "sk-ant-" + "G".repeat(24),
};

// --- the actual 2026-07-29 incident: export of a literal API key ---

Deno.test('export GEMINI_API_KEY="<literal>" is blocked (the actual 2026-07-29 incident)', async () => {
  const res = await runHook(`export GEMINI_API_KEY="${FAKE.google}"`);
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("export of an unquoted Google API key literal is blocked", async () => {
  const res = await runHook(`export GEMINI_API_KEY=${FAKE.google}`);
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- vendor-specific credential shapes, anywhere in the command ---

Deno.test("a GitHub token literal anywhere in the command is blocked", async () => {
  const res = await runHook(`curl -H "Authorization: token ${FAKE.github}" https://api.github.com`);
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("a GitHub fine-grained PAT literal is blocked", async () => {
  const res = await runHook(`export GH_TOKEN=${FAKE.githubPat}`);
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("an Anthropic API key literal is blocked", async () => {
  const res = await runHook(`export ANTHROPIC_API_KEY="${FAKE.anthropic}"`);
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("an OpenAI-style key literal is blocked", async () => {
  const res = await runHook(`export OPENAI_API_KEY="${FAKE.openai}"`);
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("a Slack token literal is blocked", async () => {
  const res = await runHook(`export SLACK_TOKEN="${FAKE.slack}"`);
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- generic shape: export of a credential-named var with ANY literal RHS ---

Deno.test("export of a *_SECRET var with a plain-word literal is blocked (generic shape)", async () => {
  const res = await runHook(`export DB_PASSWORD=hunter2`);
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("export of a *_TOKEN var with a quoted plain literal is blocked (generic shape)", async () => {
  const res = await runHook(`export SOME_TOKEN="not-a-real-shape-but-still-a-literal"`);
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- must NOT regress: ordinary exports of variable references / empty values ---

Deno.test("export FOO=$BAR is allowed (variable reference, not a literal)", async () => {
  const res = await runHook("export FOO=$BAR");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test('export FOO="$BAR" is allowed (quoted variable reference)', async () => {
  const res = await runHook('export FOO="$BAR"');
  assertEquals(res.code, 0, res.stderr);
});

Deno.test('export FOO="" is allowed (empty value)', async () => {
  const res = await runHook('export FOO=""');
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("export of a non-credential-named variable with a literal is allowed", async () => {
  const res = await runHook("export NODE_ENV=production");
  assertEquals(res.code, 0, res.stderr);
});

// --- must NOT regress: a credential-NAMED var set from another variable ---

Deno.test(
  "export GEMINI_API_KEY=$SOME_VAR is allowed (credential-named var, but a variable reference)",
  async () => {
    const res = await runHook("export GEMINI_API_KEY=$SOME_VAR");
    assertEquals(res.code, 0, res.stderr);
  },
);

Deno.test(
  'export GEMINI_API_KEY="$SOME_VAR" is allowed (quoted variable reference)',
  async () => {
    const res = await runHook('export GEMINI_API_KEY="$SOME_VAR"');
    assertEquals(res.code, 0, res.stderr);
  },
);

Deno.test('export GEMINI_API_KEY="" is allowed (empty value, credential-named var)', async () => {
  const res = await runHook('export GEMINI_API_KEY=""');
  assertEquals(res.code, 0, res.stderr);
});

// --- unrelated commands pass through untouched ---

Deno.test("a command with no credential-shaped literal is allowed", async () => {
  const res = await runHook("ls -la src/");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("a git sha is not mistaken for a credential", async () => {
  const res = await runHook("git show 2992da92f1b0c4e8a7d6b5c4e3f2a1b0c9d8e7f6");
  assertEquals(res.code, 0, res.stderr);
});

// --- URL-embedded token and placeholder tests (web-jam-tools#434) ---

Deno.test("a curl command carrying a URL query token literal is blocked with safe alternative message", async () => {
  const res = await runHook(
    `curl "https://circleci.com/api/v1.1/project/github/foo/bar/123?token=${FAKE.google}"`,
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
  if (!res.stderr.includes('don\'t "always allow" URLs carrying embedded credentials')) {
    throw new Error(`expected URL safe alternative message in stderr, got: ${res.stderr}`);
  }
});

Deno.test("a curl command carrying a placeholder query token (e.g. token=<token> or token=...) is allowed", async () => {
  const res1 = await runHook('curl "https://example.com/api?token=<token>"');
  assertEquals(res1.code, 0, res1.stderr);

  const res2 = await runHook('curl "https://example.com/api?token=..."');
  assertEquals(res2.code, 0, res2.stderr);

  const res3 = await runHook('curl "https://example.com/api?token=YOUR_TOKEN_HERE"');
  assertEquals(res3.code, 0, res3.stderr);
});
