// opus_no_delegation_warning_hook.test.ts — web-jam-tools#290
//
// Exercises hooks/opus-no-delegation-warning.sh end-to-end by actually
// shelling out to it (Deno.Command) with a mocked Stop-hook payload on
// stdin (a transcript_path pointing at a fixture JSONL file we write per
// test), the same shape Claude Code's hook runner feeds it — same pattern
// as test/block_agy_non_flash_model_hook.test.ts (re-implementing the
// shell/jq logic in TypeScript would test a copy, not the real hook).
//
// This hook is DETECTIVE, not preventive (see the hook's own header
// comment) — it never blocks; it only emits an optional systemMessage on
// stdout. So these tests assert on stdout content, not exit code shape
// (the hook always exits 0 — fail-open is part of the point).

import { assert, assertEquals } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/opus-no-delegation-warning.sh",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runHook(transcriptPath: string): Promise<RunResult> {
  const input = JSON.stringify({ transcript_path: transcriptPath });
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

// deno-lint-ignore no-explicit-any
type TranscriptEntry = Record<string, any>;

function userTurn(text: string): TranscriptEntry {
  return { type: "user", message: { role: "user", content: text } };
}

function toolResult(toolUseId: string, content: string): TranscriptEntry {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  };
}

function assistantToolUse(model: string, name: string, id: string): TranscriptEntry {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      model,
      content: [{ type: "tool_use", id, name, input: {} }],
    },
  };
}

// Same as assistantToolUse but with a target path in .input, the way
// Edit/Write (file_path) and NotebookEdit (notebook_path) tool_use blocks
// actually look in a real transcript — needed to exercise the path
// exclusion logic.
function assistantToolUseAtPath(
  model: string,
  name: string,
  id: string,
  path: string,
): TranscriptEntry {
  const inputKey = name === "NotebookEdit" ? "notebook_path" : "file_path";
  return {
    type: "assistant",
    message: {
      role: "assistant",
      model,
      content: [{ type: "tool_use", id, name, input: { [inputKey]: path } }],
    },
  };
}

function editTurnAtPaths(model: string, paths: string[], startId = 0): TranscriptEntry[] {
  return paths.map((p, i) => assistantToolUseAtPath(model, "Edit", `edit-${startId + i}`, p));
}

async function withFixtureTranscript(
  entries: TranscriptEntry[],
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/transcript.jsonl`;
  try {
    const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await Deno.writeTextFile(path, body);
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function editTurn(model: string, count: number, startId = 0): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (let i = 0; i < count; i++) {
    out.push(assistantToolUse(model, "Edit", `edit-${startId + i}`));
  }
  return out;
}

const OPUS_MODEL = "claude-opus-4-8";
const SONNET_MODEL = "claude-sonnet-4-6";
const HAIKU_MODEL = "claude-haiku-4-5";
const THRESHOLD = 5;

// --- (a) non-Opus model: silent, exit 0, no output ---

Deno.test("sonnet model with edits at/above threshold and zero Task calls stays silent", async () => {
  const entries = [userTurn("do the thing"), ...editTurn(SONNET_MODEL, THRESHOLD)];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stdout.trim(), "");
  });
});

Deno.test("haiku model with edits at/above threshold and zero Task calls stays silent", async () => {
  const entries = [userTurn("do the thing"), ...editTurn(HAIKU_MODEL, THRESHOLD)];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stdout.trim(), "");
  });
});

// --- (b) Opus + edits at/above threshold + zero Task calls: warns with real count ---

Deno.test("opus with edits AT threshold and zero Task calls warns, naming the real count", async () => {
  const entries = [userTurn("do the thing"), ...editTurn(OPUS_MODEL, THRESHOLD)];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert(
      parsed.systemMessage.includes(`${THRESHOLD} file edits`),
      `expected message to name ${THRESHOLD}, got: ${parsed.systemMessage}`,
    );
    assert(parsed.systemMessage.includes("web-jam-tools#286"));
  });
});

Deno.test("opus with edits ABOVE threshold and zero Task calls warns, naming the real (higher) count", async () => {
  const editCount = THRESHOLD + 2;
  const entries = [userTurn("do the thing"), ...editTurn(OPUS_MODEL, editCount)];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert(
      parsed.systemMessage.includes(`${editCount} file edits`),
      `expected message to name ${editCount}, got: ${parsed.systemMessage}`,
    );
  });
});

Deno.test("Write and NotebookEdit tool calls count toward the edit total same as Edit", async () => {
  const entries = [
    userTurn("do the thing"),
    assistantToolUse(OPUS_MODEL, "Write", "w1"),
    assistantToolUse(OPUS_MODEL, "NotebookEdit", "n1"),
    ...editTurn(OPUS_MODEL, THRESHOLD - 2, 100),
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert(
      parsed.systemMessage.includes(`${THRESHOLD} file edits`),
      `expected message to name ${THRESHOLD}, got: ${parsed.systemMessage}`,
    );
  });
});

// --- (c) Opus + edits at/above threshold + >=1 Task call: silent ---

Deno.test("opus with edits at/above threshold but at least one Task call stays silent", async () => {
  const entries = [
    userTurn("do the thing"),
    ...editTurn(OPUS_MODEL, THRESHOLD),
    assistantToolUse(OPUS_MODEL, "Task", "task-1"),
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stdout.trim(), "");
  });
});

// --- (d) unreadable/absent transcript: silent exit 0 (fail-open) ---

Deno.test("nonexistent transcript path stays silent, exit 0 (fail-open)", async () => {
  const res = await runHook("/nonexistent/path/does-not-exist.jsonl");
  assertEquals(res.code, 0, res.stderr);
  assertEquals(res.stdout.trim(), "");
});

Deno.test("empty transcript_path stays silent, exit 0 (fail-open)", async () => {
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify({})));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
  assertEquals(new TextDecoder().decode(stdout).trim(), "");
});

Deno.test("invalid JSON on stdin stays silent, exit 0 (fail-open)", async () => {
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode("not valid json{{{"));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
  assertEquals(new TextDecoder().decode(stdout).trim(), "");
});

Deno.test("an unreadable (garbage, non-JSONL) transcript file stays silent, exit 0 (fail-open)", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/transcript.jsonl`;
  try {
    await Deno.writeTextFile(path, "this is not jsonl at all\n{{{broken");
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stdout.trim(), "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- boundary: edits BELOW threshold on Opus with zero Tasks stays silent ---

Deno.test("opus with edits ONE BELOW threshold and zero Task calls stays silent (boundary)", async () => {
  const entries = [userTurn("do the thing"), ...editTurn(OPUS_MODEL, THRESHOLD - 1)];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stdout.trim(), "");
  });
});

// --- "current turn" scoping: edits from a PRIOR turn must not count ---

Deno.test(
  "edits from a prior turn (before the last user message) do not count toward the current turn's total",
  async () => {
    const entries = [
      userTurn("first request"),
      ...editTurn(OPUS_MODEL, THRESHOLD + 3, 0), // prior turn: well above threshold
      userTurn("second request — this is the current turn"),
      ...editTurn(OPUS_MODEL, THRESHOLD - 1, 1000), // current turn: below threshold
    ];
    await withFixtureTranscript(entries, async (path) => {
      const res = await runHook(path);
      assertEquals(res.code, 0, res.stderr);
      assertEquals(res.stdout.trim(), "");
    });
  },
);

Deno.test(
  "a tool_result (role=user, content is an array) is not mistaken for a turn-boundary user message",
  async () => {
    const entries = [
      userTurn("do the thing"),
      assistantToolUse(OPUS_MODEL, "Edit", "e1"),
      toolResult("e1", "ok"),
      ...editTurn(OPUS_MODEL, THRESHOLD - 1, 1),
    ];
    await withFixtureTranscript(entries, async (path) => {
      const res = await runHook(path);
      assertEquals(res.code, 0, res.stderr);
      // Total edits in the turn = 1 (e1) + (THRESHOLD - 1) = THRESHOLD.
      const parsed = JSON.parse(res.stdout);
      assert(
        parsed.systemMessage.includes(`${THRESHOLD} file edits`),
        `tool_result entry was wrongly treated as a turn boundary, got: ${res.stdout}`,
      );
    });
  },
);

// --- path exclusions (web-jam-tools#286-follow-up): memory/scratchpad
// bookkeeping is non-delegable and must not count toward the threshold ---

const MEMORY_DIR_PATH = "/home/joshua/.claude/projects/-home-joshua/memory/session-checkpoint.md";
const MEMORY_MD_PATH = "/home/joshua/.claude/projects/-home-joshua/memory/MEMORY.md";
const SCRATCHPAD_PATH =
  "/tmp/claude-1000/-home-joshua/3315bc1a-1ac3-429e-8002-b495465bf684/scratchpad/notes.txt";
const SOURCE_PATH_PREFIX = "/home/joshua/WebJamApps/web-jam-tools/src/file";

function sourcePaths(count: number, startId = 0): string[] {
  return Array.from({ length: count }, (_, i) => `${SOURCE_PATH_PREFIX}${startId + i}.ts`);
}

Deno.test(
  "5 edits all under .claude/projects/<x>/memory/, zero spawns: does NOT warn (the reported false positive)",
  async () => {
    const entries = [
      userTurn("do the thing"),
      ...editTurnAtPaths(OPUS_MODEL, [
        MEMORY_DIR_PATH,
        MEMORY_DIR_PATH.replace("session-checkpoint", "another-checkpoint"),
        MEMORY_DIR_PATH.replace("session-checkpoint", "new-rule"),
        MEMORY_MD_PATH,
        MEMORY_MD_PATH,
      ]),
    ];
    await withFixtureTranscript(entries, async (path) => {
      const res = await runHook(path);
      assertEquals(res.code, 0, res.stderr);
      assertEquals(res.stdout.trim(), "", `expected silence, got: ${res.stdout}`);
    });
  },
);

Deno.test(
  "5 edits to ordinary repo source files, zero spawns: still DOES warn (no regression)",
  async () => {
    const entries = [
      userTurn("do the thing"),
      ...editTurnAtPaths(OPUS_MODEL, sourcePaths(THRESHOLD)),
    ];
    await withFixtureTranscript(entries, async (path) => {
      const res = await runHook(path);
      assertEquals(res.code, 0, res.stderr);
      const parsed = JSON.parse(res.stdout);
      assert(
        parsed.systemMessage.includes(`${THRESHOLD} file edits`),
        `expected message to name ${THRESHOLD}, got: ${res.stdout}`,
      );
    });
  },
);

Deno.test(
  "mix of memory edits + real source edits where the real ones ALONE clear the threshold: still warns",
  async () => {
    const entries = [
      userTurn("do the thing"),
      ...editTurnAtPaths(
        OPUS_MODEL,
        [MEMORY_DIR_PATH, MEMORY_MD_PATH, SCRATCHPAD_PATH, ...sourcePaths(THRESHOLD)],
      ),
    ];
    await withFixtureTranscript(entries, async (path) => {
      const res = await runHook(path);
      assertEquals(res.code, 0, res.stderr);
      const parsed = JSON.parse(res.stdout);
      assert(
        parsed.systemMessage.includes(`${THRESHOLD} file edits`),
        `expected message to name only the ${THRESHOLD} real source edits, got: ${res.stdout}`,
      );
    });
  },
);

Deno.test(
  "mix of memory edits + real source edits where the real ones ALONE do NOT clear the threshold: does not warn",
  async () => {
    const entries = [
      userTurn("do the thing"),
      ...editTurnAtPaths(
        OPUS_MODEL,
        [
          MEMORY_DIR_PATH,
          MEMORY_MD_PATH,
          SCRATCHPAD_PATH,
          MEMORY_DIR_PATH.replace("session-checkpoint", "another-checkpoint"),
          ...sourcePaths(THRESHOLD - 1),
        ],
      ),
    ];
    await withFixtureTranscript(entries, async (path) => {
      const res = await runHook(path);
      assertEquals(res.code, 0, res.stderr);
      assertEquals(res.stdout.trim(), "", `expected silence, got: ${res.stdout}`);
    });
  },
);

Deno.test(
  "MEMORY.md under .claude/ (not nested under a memory/ dir) is excluded",
  async () => {
    const entries = [
      userTurn("do the thing"),
      ...editTurnAtPaths(OPUS_MODEL, [
        "/home/joshua/.claude/MEMORY.md",
        ...sourcePaths(THRESHOLD - 1),
      ]),
    ];
    await withFixtureTranscript(entries, async (path) => {
      const res = await runHook(path);
      assertEquals(res.code, 0, res.stderr);
      assertEquals(res.stdout.trim(), "", `expected silence, got: ${res.stdout}`);
    });
  },
);

Deno.test(
  "scratchpad edits under /tmp/claude-*/.../scratchpad/ are excluded",
  async () => {
    const entries = [
      userTurn("do the thing"),
      ...editTurnAtPaths(OPUS_MODEL, [
        SCRATCHPAD_PATH,
        SCRATCHPAD_PATH.replace("notes.txt", "draft.md"),
        ...sourcePaths(THRESHOLD - 1),
      ]),
    ];
    await withFixtureTranscript(entries, async (path) => {
      const res = await runHook(path);
      assertEquals(res.code, 0, res.stderr);
      assertEquals(res.stdout.trim(), "", `expected silence, got: ${res.stdout}`);
    });
  },
);

Deno.test("model recovery reads the NEWEST assistant message's model, not an earlier one", async () => {
  // Session started as opus, then a mid-transcript entry shows sonnet as the
  // most recent model — the hook should recover "sonnet" (newest wins) and
  // stay silent even though earlier edits were made under opus.
  const entries = [
    userTurn("do the thing"),
    ...editTurn(OPUS_MODEL, THRESHOLD),
    assistantToolUse(SONNET_MODEL, "Edit", "e-last"),
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stdout.trim(), "");
  });
});

Deno.test("interleaved subagent entry (isSidechain: true) does not confuse model detection for Opus session", async () => {
  const entries = [
    userTurn("do the thing"),
    ...editTurn(OPUS_MODEL, THRESHOLD),
    {
      type: "assistant",
      isSidechain: true,
      message: {
        role: "assistant",
        model: HAIKU_MODEL,
        content: [{ type: "text", text: "subagent finished" }],
      },
    },
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert(
      parsed.systemMessage.includes(`${THRESHOLD} file edits`),
      `expected message to name ${THRESHOLD}, got: ${res.stdout}`,
    );
  });
});

Deno.test("synthetic API error entry (isApiErrorMessage: true) does not confuse model detection for Opus session", async () => {
  const entries = [
    userTurn("do the thing"),
    ...editTurn(OPUS_MODEL, THRESHOLD),
    {
      type: "assistant",
      isApiErrorMessage: true,
      message: {
        role: "assistant",
        model: HAIKU_MODEL,
        content: [{ type: "text", text: "API error retry" }],
      },
    },
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert(
      parsed.systemMessage.includes(`${THRESHOLD} file edits`),
      `expected message to name ${THRESHOLD}, got: ${res.stdout}`,
    );
  });
});
