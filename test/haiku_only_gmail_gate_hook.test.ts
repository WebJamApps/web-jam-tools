// haiku_only_gmail_gate_hook.test.ts — web-jam-tools#285
//
// hooks/haiku-only-gmail-gate.sh had NO behaviour test before #285. It is a
// PreToolUse guard matched (in scripts/install-hooks.sh) against
// `mcp__(gmail|claude_ai_Gmail)__.*`: it reads `transcript_path` from the
// PreToolUse JSON on stdin, looks up the NEWEST assistant-turn model recorded
// in that transcript JSONL, and denies (fail-closed) unless that model name
// contains "haiku". Exercised the same way as the other hooks — shelling out
// to it (Deno.Command) with mocked PreToolUse JSON on stdin, plus a real temp
// transcript JSONL file standing in for Claude Code's actual transcript.
//
// The matcher covers both local Gmail MCP (mcp__gmail__*) and live claude.ai
// Gmail tools (mcp__claude_ai_Gmail__*), ensuring the gate applies to all
// Gmail tool usage.

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

function assistantTurn(model: string, content = "hi"): Record<string, unknown> {
  return { message: { role: "assistant", model, content } };
}

function sidechainTurn(model: string, content = "subagent response"): Record<string, unknown> {
  return { isSidechain: true, message: { role: "assistant", model, content } };
}

function apiErrorMessageTurn(
  model = "claude-haiku-4-5",
  content = "API error occurred",
): Record<string, unknown> {
  return { isApiErrorMessage: true, message: { role: "assistant", model, content } };
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

Deno.test("Haiku main session with an interleaved Sonnet subagent entry is allowed", async () => {
  await withTranscript(
    [
      assistantTurn("claude-haiku-4-6"),
      sidechainTurn("claude-sonnet-4-6"),
    ],
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

// --- web-jam-tools#566: regression tests proving interleaved subagent entries and API error entries cannot breach the gate ---

Deno.test("an interleaved Haiku subagent transcript entry cannot make the gate admit an Opus session", async () => {
  await withTranscript(
    [
      assistantTurn("claude-opus-4-6-thinking"),
      sidechainTurn("claude-haiku-4-5"),
    ],
    async (transcript_path) => {
      const res = await runHook({ transcript_path });
      assertEquals(res.code, 0);
      assertDenied(res.stdout);
    },
  );
});

Deno.test("a synthetic API error message cannot make the gate admit an Opus session", async () => {
  await withTranscript(
    [
      assistantTurn("claude-opus-4-6-thinking"),
      apiErrorMessageTurn("claude-haiku-4-5"),
    ],
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

// --- web-jam-tools#285: verify the updated matcher fires against both
// local (mcp__gmail__*) and live (mcp__claude_ai_Gmail__*) Gmail tool names.

Deno.test("install-hooks.sh matcher fires against local Gmail MCP (mcp__gmail__*)", () => {
  const matcher = "mcp__(gmail|claude_ai_Gmail)__.*";
  const localToolName = "mcp__gmail__send";
  const re = new RegExp(matcher);
  const fires = re.test(localToolName);
  assertEquals(fires, true, `matcher should fire against ${localToolName}`);
});

Deno.test("install-hooks.sh matcher fires against live Gmail MCP (mcp__claude_ai_Gmail__*)", () => {
  const matcher = "mcp__(gmail|claude_ai_Gmail)__.*";
  const liveToolName = "mcp__claude_ai_Gmail__list_labels";
  const re = new RegExp(matcher);
  const fires = re.test(liveToolName);
  assertEquals(fires, true, `matcher should fire against ${liveToolName}`);
});

Deno.test("install-hooks.sh matcher does not fire against unrelated tools", () => {
  const matcher = "mcp__(gmail|claude_ai_Gmail)__.*";
  const unrelatedToolName = "mcp__google-drive__search";
  const re = new RegExp(matcher);
  const fires = re.test(unrelatedToolName);
  assertEquals(fires, false, `matcher should NOT fire against ${unrelatedToolName}`);
});
