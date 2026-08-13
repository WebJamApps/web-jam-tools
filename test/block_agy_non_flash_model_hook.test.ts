// block_agy_non_flash_model_hook.test.ts — web-jam-tools#267
//
// Exercises hooks/block-agy-non-flash-model.sh end-to-end by actually
// shelling out to it (Deno.Command) with mocked PreToolUse JSON on stdin,
// the same shape Claude Code's hook runner feeds it — same pattern as
// test/block_secret_dumps_hook.test.ts (re-implementing the shell/python
// logic in TypeScript would test a copy, not the real guard).

import { assertEquals } from "@std/assert";

const SCRIPT_PATH = new URL("../hooks/block-agy-non-flash-model.sh", import.meta.url).pathname;

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
  if (!stderr.includes("BLOCKED (agy-model guard)")) {
    throw new Error(`expected BLOCKED message in stderr, got: ${stderr}`);
  }
}

// --- allowed: bare agy, no --model ---

Deno.test("bare agy (no --model) is allowed", async () => {
  const res = await runHook("agy");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("agy -i 'prompt' with no --model is allowed", async () => {
  const res = await runHook(`agy -i "do the thing"`);
  assertEquals(res.code, 0, res.stderr);
});

// --- allowed: the two Flash 3.6 slugs ---

Deno.test("agy --model gemini-3.6-flash-medium is allowed", async () => {
  const res = await runHook("agy --model gemini-3.6-flash-medium");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("agy --model gemini-3.6-flash-high is allowed", async () => {
  const res = await runHook("agy --model gemini-3.6-flash-high");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("agy --model=gemini-3.6-flash-high (single-token form) is allowed", async () => {
  const res = await runHook("agy --model=gemini-3.6-flash-high -i hi");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("agy --model gemini-3.6-flash-medium --dangerously-skip-permissions -p 'x' is allowed", async () => {
  const res = await runHook(
    `agy --model gemini-3.6-flash-medium --dangerously-skip-permissions -p "reply with: ok"`,
  );
  assertEquals(res.code, 0, res.stderr);
});

// --- blocked: every other --model value ---

Deno.test("agy --model gemini-3.6-flash-low is blocked", async () => {
  const res = await runHook("agy --model gemini-3.6-flash-low");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model claude-sonnet-4-6 is blocked", async () => {
  const res = await runHook("agy --model claude-sonnet-4-6");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model claude-opus-4-6-thinking is blocked", async () => {
  const res = await runHook("agy --model claude-opus-4-6-thinking");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model gpt-oss-120b-medium is blocked", async () => {
  const res = await runHook("agy --model gpt-oss-120b-medium");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model gemini-3.1-pro-high is blocked", async () => {
  const res = await runHook("agy --model gemini-3.1-pro-high");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model gemini-3.1-pro-low is blocked", async () => {
  const res = await runHook("agy --model gemini-3.1-pro-low");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model gemini-3.5-flash-high is blocked (old Flash generation)", async () => {
  const res = await runHook("agy --model gemini-3.5-flash-high");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model gemini-3.5-flash-medium is blocked (old Flash generation)", async () => {
  const res = await runHook("agy --model gemini-3.5-flash-medium");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model gemini-3.5-flash-low is blocked (old Flash generation)", async () => {
  const res = await runHook("agy --model gemini-3.5-flash-low");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("block message names both permitted slugs", async () => {
  const res = await runHook("agy --model claude-sonnet-4-6");
  assertEquals(res.code, 2);
  for (const slug of ["gemini-3.6-flash-medium", "gemini-3.6-flash-high"]) {
    if (!res.stderr.includes(slug)) {
      throw new Error(`expected block message to name ${slug}, got: ${res.stderr}`);
    }
  }
});

// --- blocked: AGY_MODELS= env prefix bypassing --model ---

Deno.test("AGY_MODELS=claude-opus-4-6-thinking agy is blocked", async () => {
  const res = await runHook("AGY_MODELS=claude-opus-4-6-thinking agy");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("AGY_MODELS='gemini-3.5-flash-high' agy -i x is blocked (old Flash generation)", async () => {
  const res = await runHook(`AGY_MODELS='gemini-3.5-flash-high' agy -i x`);
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("AGY_MODELS with one good and one bad slug (pipe-separated) is blocked", async () => {
  const res = await runHook("AGY_MODELS='gemini-3.6-flash-medium|claude-sonnet-4-6' agy");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- allowed: AGY_MODELS= env prefix naming only permitted slugs ---

Deno.test("AGY_MODELS=gemini-3.6-flash-medium agy is allowed", async () => {
  const res = await runHook("AGY_MODELS=gemini-3.6-flash-medium agy");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("AGY_MODELS='gemini-3.6-flash-medium|gemini-3.6-flash-high' agy is allowed (pipe-separated, both permitted)", async () => {
  const res = await runHook("AGY_MODELS='gemini-3.6-flash-medium|gemini-3.6-flash-high' agy");
  assertEquals(res.code, 0, res.stderr);
});

// --- out of scope: wrapper scripts that merely mention/invoke agy internally ---

Deno.test(
  "handle-agy-tasks.sh invocation is untouched (not a literal agy command)",
  async () => {
    const res = await runHook("handle-agy-tasks.sh --headless Repo#123");
    assertEquals(res.code, 0, res.stderr);
  },
);

Deno.test(
  "AGY_MODELS prefix on a non-agy command (the wrapper script) is untouched — only a literal agy invocation is in scope",
  async () => {
    const res = await runHook(
      "AGY_MODELS='claude-opus-4-6-thinking' ~/WebJamApps/web-jam-tools/scripts/handle-agy-tasks.sh --headless Repo#123",
    );
    assertEquals(res.code, 0, res.stderr);
  },
);

Deno.test("a command with no agy reference at all passes through untouched", async () => {
  const res = await runHook("ls -la src/");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("agy invoked via a path ending in /agy is still recognized", async () => {
  const res = await runHook("$HOME/.local/bin/agy --model claude-sonnet-4-6");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});
