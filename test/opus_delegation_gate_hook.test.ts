// opus_delegation_gate_hook.test.ts — web-jam-tools#641
//
// Exercises hooks/opus-delegation-gate.sh end-to-end by shelling out to it
// (Deno.Command) with mocked PreToolUse JSON on stdin, plus real temp
// transcript JSONL files standing in for Claude Code's actual transcript.

import { assert, assertEquals } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/opus-delegation-gate.sh",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
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
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
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

function userTurn(content: string): Record<string, unknown> {
  return { type: "user", message: { role: "user", content } };
}

function assistantTurn(model: string, content = "understood"): Record<string, unknown> {
  return { type: "assistant", message: { role: "assistant", model, content } };
}

function sidechainTurn(model: string, content = "subagent response"): Record<string, unknown> {
  return { type: "assistant", isSidechain: true, message: { role: "assistant", model, content } };
}

function assertDenied(stdout: string, expectedInReason: string[] = []): void {
  assert(stdout.trim().length > 0, "expected non-empty output on deny");
  const parsed = JSON.parse(stdout);
  assertEquals(
    parsed.hookSpecificOutput?.permissionDecision,
    "deny",
    `expected a deny decision, got: ${stdout}`,
  );
  const reason = parsed.hookSpecificOutput?.permissionDecisionReason as string;
  assert(
    typeof reason === "string" && reason.length > 0,
    "expected permissionDecisionReason string",
  );
  for (const needle of expectedInReason) {
    assert(
      reason.includes(needle),
      `expected reason to contain "${needle}", got:\n${reason}`,
    );
  }
}

function assertAllowed(res: RunResult): void {
  assertEquals(res.code, 0, `expected exit code 0, got ${res.code}: ${res.stderr}`);
  assertEquals(res.stdout, "", `expected empty stdout on allow, got: ${res.stdout}`);
}

// Target file inside the current repository
const IN_REPO_FILE = SCRIPT_PATH;

// --- Step 1: Subagent tool call allowed ---

Deno.test("subagent tool call (agent_id present) is allowed immediately without transcript check", async () => {
  const res = await runHook({
    agent_id: "agent-sonnet-subagent-1",
    tool_input: { file_path: IN_REPO_FILE },
    // invalid transcript_path would fail if checked
    transcript_path: "/nonexistent/transcript.jsonl",
  });
  assertAllowed(res);
});

// --- Step 2: No target path in tool input allowed ---

Deno.test("tool call without file_path or notebook_path or path is allowed", async () => {
  const res = await runHook({
    tool_input: {},
    transcript_path: "/nonexistent/transcript.jsonl",
  });
  assertAllowed(res);
});

// --- Step 3: Target path outside git working tree allowed ---

Deno.test("target path outside any git repository is allowed", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const outOfRepoFile = `${tempDir}/notes.txt`;
    const res = await runHook({
      tool_input: { file_path: outOfRepoFile },
      // invalid transcript_path would fail if checked
      transcript_path: "/nonexistent/transcript.jsonl",
    });
    assertAllowed(res);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// --- Step 5: Session model is not Opus allowed ---

Deno.test("in-repo write by Sonnet main session is allowed", async () => {
  await withTranscript(
    [userTurn("please edit code"), assistantTurn("claude-sonnet-4-6")],
    async (transcript_path) => {
      const res = await runHook({
        tool_input: { file_path: IN_REPO_FILE },
        transcript_path,
      });
      assertAllowed(res);
    },
  );
});

Deno.test("in-repo write by Haiku main session is allowed", async () => {
  await withTranscript(
    [userTurn("please edit code"), assistantTurn("claude-haiku-3-5")],
    async (transcript_path) => {
      const res = await runHook({
        tool_input: { file_path: IN_REPO_FILE },
        transcript_path,
      });
      assertAllowed(res);
    },
  );
});

// --- Step 6: Escape phrase 'opus edit ok' present in latest user message ---

Deno.test("Opus session is allowed when latest user message contains 'opus edit ok'", async () => {
  await withTranscript(
    [
      userTurn("opus edit ok, go ahead and fix this file"),
      assistantTurn("claude-opus-4-6"),
    ],
    async (transcript_path) => {
      const res = await runHook({
        tool_input: { file_path: IN_REPO_FILE },
        transcript_path,
      });
      assertAllowed(res);
    },
  );
});

Deno.test("Opus session with NotebookEdit is allowed when latest user message contains 'opus edit ok'", async () => {
  await withTranscript(
    [
      userTurn("opus edit ok — edit notebook"),
      assistantTurn("claude-opus-4-6"),
    ],
    async (transcript_path) => {
      const res = await runHook({
        tool_input: { notebook_path: IN_REPO_FILE },
        transcript_path,
      });
      assertAllowed(res);
    },
  );
});

// --- Step 7: Refusals (denials) ---

Deno.test("Opus main session in-repo write without escape phrase is denied with complete refusal message", async () => {
  await withTranscript(
    [
      userTurn("please edit this file directly"),
      assistantTurn("claude-opus-4-6"),
    ],
    async (transcript_path) => {
      const res = await runHook({
        tool_input: { file_path: IN_REPO_FILE },
        transcript_path,
      });
      assertEquals(res.code, 0);
      assertDenied(res.stdout, [
        IN_REPO_FILE,
        "Repository code must not be edited directly on Opus",
        'model: "sonnet"',
        "Flash via agy",
        "opus edit ok",
      ]);
    },
  );
});

Deno.test("Opus session where escape phrase was in an older turn but not the latest turn is denied", async () => {
  await withTranscript(
    [
      userTurn("opus edit ok — first turn"),
      assistantTurn("claude-opus-4-6", "done turn 1"),
      userTurn("now do another edit on this file"),
      assistantTurn("claude-opus-4-6"),
    ],
    async (transcript_path) => {
      const res = await runHook({
        tool_input: { file_path: IN_REPO_FILE },
        transcript_path,
      });
      assertEquals(res.code, 0);
      assertDenied(res.stdout);
    },
  );
});

Deno.test("Opus session with interleaved Haiku subagent is still recognized as Opus and denied without escape phrase", async () => {
  await withTranscript(
    [
      userTurn("run subagent and then do edit"),
      assistantTurn("claude-opus-4-6"),
      sidechainTurn("claude-haiku-3-5"),
    ],
    async (transcript_path) => {
      const res = await runHook({
        tool_input: { file_path: IN_REPO_FILE },
        transcript_path,
      });
      assertEquals(res.code, 0);
      assertDenied(res.stdout);
    },
  );
});

// --- Fail-closed on missing/unreadable transcript ---

Deno.test("missing transcript_path is denied (fail-closed)", async () => {
  const res = await runHook({
    tool_input: { file_path: IN_REPO_FILE },
  });
  assertEquals(res.code, 0);
  assertDenied(res.stdout);
});

Deno.test("nonexistent transcript file is denied (fail-closed)", async () => {
  const res = await runHook({
    tool_input: { file_path: IN_REPO_FILE },
    transcript_path: "/tmp/nonexistent-transcript-gate-test.jsonl",
  });
  assertEquals(res.code, 0);
  assertDenied(res.stdout);
});

Deno.test("empty transcript file is denied (fail-closed)", async () => {
  await withTranscript([], async (transcript_path) => {
    const res = await runHook({
      tool_input: { file_path: IN_REPO_FILE },
      transcript_path,
    });
    assertEquals(res.code, 0);
    assertDenied(res.stdout);
  });
});

// --- Matcher regex verification ---

Deno.test("install-hooks.sh matcher Write|Edit|NotebookEdit matches Edit, Write, and NotebookEdit", () => {
  const matcher = "Write|Edit|NotebookEdit";
  const re = new RegExp(`^(?:${matcher})$`);
  assertEquals(re.test("Edit"), true);
  assertEquals(re.test("Write"), true);
  assertEquals(re.test("NotebookEdit"), true);
  assertEquals(re.test("Bash"), false);
  assertEquals(re.test("Read"), false);
});
