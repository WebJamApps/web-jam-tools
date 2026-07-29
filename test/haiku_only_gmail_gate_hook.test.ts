// haiku_only_gmail_gate_hook.test.ts — web-jam-tools#285
//
// hooks/haiku-only-gmail-gate.sh had NO behaviour test before #285. It is a
// PreToolUse guard matched (in scripts/install-hooks.sh) against
// `mcp__gmail__.*`: it reads `transcript_path` from the PreToolUse JSON on
// stdin, looks up the NEWEST assistant-turn model recorded in that transcript
// JSONL, and denies (fail-closed) unless that model name contains "haiku".
// Exercised the same way as the other hooks — shelling out to it
// (Deno.Command) with mocked PreToolUse JSON on stdin, plus a real temp
// transcript JSONL file standing in for Claude Code's actual transcript.
//
// web-jam-tools#285 special instruction: this test file ALSO records whether
// the hook's install-time matcher (`mcp__gmail__.*` in
// scripts/install-hooks.sh's PRE_TOOL_USE_HOOKS) actually fires against the
// CURRENT live Gmail MCP tool names. See the dedicated test at the bottom —
// per the issue, changing the matcher is Josh's call, not this PR's, so it is
// only asserted/reported here, never "fixed".

import { assertEquals } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/haiku-only-gmail-gate.sh",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stdout: string;
}

async function runHook(payload: Record<string, unknown>): Promise<RunResult> {
  const input = JSON.stringify(payload);
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
  const { code, stdout } = await child.output();
  return { code, stdout: new TextDecoder().decode(stdout) };
}

async function withTranscript(
  lines: Record<string, unknown>[],
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const path = await Deno.makeTempFile({ suffix: ".jsonl" });
  try {
    await Deno.writeTextFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await fn(path);
  } finally {
    await Deno.remove(path);
  }
}

function assistantTurn(model: string): Record<string, unknown> {
  return { message: { role: "assistant", model } };
}

function assertDenied(stdout: string) {
  const parsed = JSON.parse(stdout);
  assertEquals(
    parsed.hookSpecificOutput?.permissionDecision,
    "deny",
    `expected a deny decision, got: ${stdout}`,
  );
}

// --- passes through: newest assistant turn's model is Haiku ---

Deno.test("newest assistant turn on a haiku model is allowed (silent, no deny JSON)", async () => {
  await withTranscript(
    [assistantTurn("claude-sonnet-4-6"), assistantTurn("claude-haiku-4-6")],
    async (transcript_path) => {
      const res = await runHook({ transcript_path });
      assertEquals(res.code, 0);
      assertEquals(res.stdout, "");
    },
  );
});

// --- fires: newest assistant turn's model is NOT Haiku ---

Deno.test("newest assistant turn on Sonnet is denied", async () => {
  await withTranscript(
    [assistantTurn("claude-haiku-4-6"), assistantTurn("claude-sonnet-4-6")],
    async (transcript_path) => {
      const res = await runHook({ transcript_path });
      assertEquals(res.code, 0);
      assertDenied(res.stdout);
    },
  );
});

Deno.test("newest assistant turn on Opus is denied", async () => {
  await withTranscript(
    [assistantTurn("claude-opus-4-6-thinking")],
    async (transcript_path) => {
      const res = await runHook({ transcript_path });
      assertEquals(res.code, 0);
      assertDenied(res.stdout);
    },
  );
});

// --- fail-closed: unknown/unreadable model denies too ---

Deno.test("missing transcript_path is denied (fail closed on unknown model)", async () => {
  const res = await runHook({});
  assertEquals(res.code, 0);
  assertDenied(res.stdout);
});

Deno.test("transcript_path pointing at a nonexistent file is denied (fail closed)", async () => {
  const res = await runHook({ transcript_path: "/tmp/does-not-exist-285.jsonl" });
  assertEquals(res.code, 0);
  assertDenied(res.stdout);
});

Deno.test("a transcript with no assistant turns at all is denied (fail closed)", async () => {
  await withTranscript(
    [{ message: { role: "user", content: "hi" } }],
    async (transcript_path) => {
      const res = await runHook({ transcript_path });
      assertEquals(res.code, 0);
      assertDenied(res.stdout);
    },
  );
});

// --- web-jam-tools#285: does the install-time matcher fire against the LIVE
// Gmail MCP tool name? Report only — do not "fix" the matcher (Josh's call).

Deno.test("install-hooks.sh matcher check: mcp__gmail__.* vs the live tool name mcp__claude_ai_Gmail__* (reported, not fixed)", () => {
  const matcher = "mcp__gmail__.*";
  const liveToolName = "mcp__claude_ai_Gmail__list_labels";
  const re = new RegExp(matcher);
  const fires = re.test(liveToolName);
  // As of web-jam-tools#285: this is FALSE. The live Gmail MCP tool names in
  // this environment are `mcp__claude_ai_Gmail__*` (see the deferred-tools
  // listing in any session with the claude.ai Gmail connector), not
  // `mcp__gmail__*`. scripts/install-hooks.sh's PRE_TOOL_USE_HOOKS wires this
  // hook to matcher "mcp__gmail__.*", which does NOT match
  // "mcp__claude_ai_Gmail__*" (different prefix, different case) — so this
  // guard currently does NOT gate the live Gmail tools at all. Confirmed and
  // reported per #285; changing the matcher is Josh's call (it changes which
  // model may touch Gmail), not this PR's.
  assertEquals(fires, false);
});
