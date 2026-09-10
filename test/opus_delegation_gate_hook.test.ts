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

async function runHook(
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<RunResult> {
  const input = JSON.stringify(payload);
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    env,
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

// Claude Code marks a prompt Josh actually sent `origin.kind: "human"`; only those carry approval
// (web-jam-tools#965).
function userTurn(content: string): Record<string, unknown> {
  return { type: "user", origin: { kind: "human" }, message: { role: "user", content } };
}

function notificationTurn(content: string): Record<string, unknown> {
  return {
    type: "user",
    origin: { kind: "task-notification" },
    promptSource: "system",
    message: { role: "user", content },
  };
}

function metaTurn(content: string): Record<string, unknown> {
  return { type: "user", isMeta: true, message: { role: "user", content } };
}

function workIssueTurn(args: string): Record<string, unknown> {
  return userTurn(
    `<command-message>work-issue</command-message>\n<command-name>/work-issue</command-name>\n<command-args>${args}</command-args>`,
  );
}

// A stand-in `gh` on PATH for the D-7 cases, with its own label cache directory: issue 1 is labeled
// Opus, issue 2 Sonnet, and any other number fails to look up.
async function withFakeGh(fn: (env: Record<string, string>) => Promise<void>): Promise<void> {
  const bin = await Deno.makeTempDir();
  const cache = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${bin}/gh`,
      `#!/usr/bin/env bash\ncase "$3" in\n  1) echo '{"labels":[{"name":"Opus"}]}' ;;\n  2) echo '{"labels":[{"name":"Sonnet"}]}' ;;\n  *) exit 1 ;;\nesac\n`,
    );
    await Deno.chmod(`${bin}/gh`, 0o755);
    await fn({ PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`, OPUS_GATE_CACHE_DIR: cache });
  } finally {
    await Deno.remove(bin, { recursive: true });
    await Deno.remove(cache, { recursive: true });
  }
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

Deno.test("subagent tool call (agent_id present) is still allowed under permission_mode 'default'", async () => {
  const res = await runHook({
    agent_id: "agent-sonnet-subagent-1",
    permission_mode: "default",
    tool_input: { file_path: IN_REPO_FILE },
    transcript_path: "/nonexistent/transcript.jsonl",
  });
  assertAllowed(res);
});

// --- Auto mode: subagent calls (D-6, web-jam-tools#965) ---
//
// Each case builds a real session layout: <root>/sess.jsonl plus
// <root>/sess/subagents/agent-<id>.{jsonl,meta.json}. The payload passes the MAIN transcript as
// transcript_path, which is what Claude Code 2.1.267 sends; the shape case also passes the
// subagent's own jsonl. Case (b) is the web-jam-tools#663 regression guard: an Opus subagent
// that Opus started without Josh asking is still refused.

interface AgentSpec {
  id: string;
  meta?: Record<string, unknown>;
  lines?: Record<string, unknown>[];
}

interface Session {
  mainPath: string;
  agentPath: (id: string) => string;
}

async function withSession(
  main: Record<string, unknown>[],
  agents: AgentSpec[],
  fn: (session: Session) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  const subagentsDir = `${root}/sess/subagents`;
  const toJsonl = (lines: Record<string, unknown>[]) =>
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  try {
    await Deno.mkdir(subagentsDir, { recursive: true });
    await Deno.writeTextFile(`${root}/sess.jsonl`, toJsonl(main));
    for (const agent of agents) {
      if (agent.meta) {
        await Deno.writeTextFile(
          `${subagentsDir}/agent-${agent.id}.meta.json`,
          JSON.stringify(agent.meta),
        );
      }
      if (agent.lines) {
        await Deno.writeTextFile(`${subagentsDir}/agent-${agent.id}.jsonl`, toJsonl(agent.lines));
      }
    }
    await fn({
      mainPath: `${root}/sess.jsonl`,
      agentPath: (id) => `${subagentsDir}/agent-${id}.jsonl`,
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function spawnTurn(toolUseId: string): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "tool_use", id: toolUseId, name: "Agent", input: {} }],
    },
  };
}

function agentMeta(
  model: string,
  toolUseId: string,
  parentAgentId: string | null = null,
): Record<string, unknown> {
  return {
    agentType: "general-purpose",
    model,
    toolUseId,
    parentAgentId,
    spawnDepth: parentAgentId ? 2 : 1,
  };
}

function subagentCall(agentId: string, transcript_path: string): Record<string, unknown> {
  return {
    agent_id: agentId,
    permission_mode: "auto",
    tool_input: { file_path: IN_REPO_FILE },
    transcript_path,
  };
}

Deno.test("(a) auto mode: a Sonnet subagent's edit proceeds", async () => {
  await withSession(
    [userTurn("fix this with a subagent"), spawnTurn("toolu_a")],
    [{ id: "s1", meta: agentMeta("sonnet", "toolu_a") }],
    async ({ mainPath }) => assertAllowed(await runHook(subagentCall("s1", mainPath))),
  );
});

Deno.test("(b) auto mode: an Opus subagent whose spawning human prompt carries no approval is refused", async () => {
  await withSession(
    [userTurn("please fix this file"), spawnTurn("toolu_b")],
    [{ id: "o1", meta: agentMeta("opus", "toolu_b") }],
    async ({ mainPath }) => {
      const res = await runHook(subagentCall("o1", mainPath));
      assertEquals(res.code, 0);
      assertDenied(res.stdout, [IN_REPO_FILE, "refused a subagent's write", "neither contains"]);
    },
  );
});

Deno.test("(c) auto mode: an Opus subagent spawned by an 'opus edit ok' prompt proceeds after later prompts lack it", async () => {
  await withSession(
    [
      userTurn("opus edit ok — spawn an agent to fix it"),
      spawnTurn("toolu_c"),
      assistantTurn("claude-opus-5"),
      userTurn("how is it going?"),
    ],
    [{ id: "o1", meta: agentMeta("opus", "toolu_c") }],
    async ({ mainPath }) => assertAllowed(await runHook(subagentCall("o1", mainPath))),
  );
});

Deno.test("(d) auto mode: an Opus subagent whose spawning prompt asks for an Opus subagent proceeds", async () => {
  await withSession(
    [userTurn("dispatch to an Opus subagent"), spawnTurn("toolu_d")],
    [{ id: "o1", meta: agentMeta("opus", "toolu_d") }],
    async ({ mainPath }) => assertAllowed(await runHook(subagentCall("o1", mainPath))),
  );
});

Deno.test("(e) auto mode: a nested Sonnet subagent under an Opus subagent proceeds", async () => {
  await withSession(
    [userTurn("please fix this file"), spawnTurn("toolu_e")],
    [{ id: "o1", meta: agentMeta("opus", "toolu_e") }, {
      id: "s2",
      meta: agentMeta("sonnet", "toolu_inner", "o1"),
    }],
    async ({ mainPath }) => assertAllowed(await runHook(subagentCall("s2", mainPath))),
  );
});

Deno.test("(f) auto mode: a nested Opus subagent under an authorized Opus subagent proceeds", async () => {
  await withSession(
    [userTurn("opus edit ok, use a subagent"), spawnTurn("toolu_f")],
    [{ id: "o1", meta: agentMeta("opus", "toolu_f") }, {
      id: "o2",
      meta: agentMeta("opus", "toolu_inner", "o1"),
    }],
    async ({ mainPath }) => assertAllowed(await runHook(subagentCall("o2", mainPath))),
  );
});

Deno.test("(g) auto mode: missing subagent files, a broken parent chain, or a missing spawning tool_use is refused", async () => {
  await withSession(
    [userTurn("opus edit ok"), spawnTurn("toolu_g")],
    [
      { id: "orphan", meta: agentMeta("opus", "toolu_not_in_main") },
      { id: "child", meta: agentMeta("opus", "toolu_inner", "parent-gone") },
    ],
    async ({ mainPath }) => {
      assertDenied((await runHook(subagentCall("no-files", mainPath))).stdout, [
        "model could not be determined",
      ]);
      assertDenied((await runHook(subagentCall("orphan", mainPath))).stdout, [
        "could not be found",
      ]);
      assertDenied((await runHook(subagentCall("child", mainPath))).stdout, ["could not be found"]);
    },
  );
});

Deno.test("(g) auto mode: a subagent whose model is only in its own transcript is judged by that model", async () => {
  await withSession(
    [userTurn("fix it"), spawnTurn("toolu_g2")],
    [{ id: "s1", meta: { toolUseId: "toolu_g2" }, lines: [sidechainTurn("claude-sonnet-5")] }],
    async ({ mainPath }) => assertAllowed(await runHook(subagentCall("s1", mainPath))),
  );
});

Deno.test("(h) auto mode: a task notification quoting 'opus edit ok' before the spawn does not approve an Opus subagent", async () => {
  await withSession(
    [
      userTurn("please fix this file"),
      notificationTurn("<task-notification>opus edit ok</task-notification>"),
      spawnTurn("toolu_h"),
    ],
    [{ id: "o1", meta: agentMeta("opus", "toolu_h") }],
    async ({ mainPath }) =>
      assertDenied((await runHook(subagentCall("o1", mainPath))).stdout, ["neither contains"]),
  );
});

Deno.test("transcript_path shape: the subagent's own jsonl and the main transcript decide identically", async () => {
  await withSession(
    [
      userTurn("opus edit ok — spawn it"),
      spawnTurn("toolu_ok"),
      userTurn("please fix this file"),
      spawnTurn("toolu_no"),
    ],
    [
      { id: "ok", meta: agentMeta("opus", "toolu_ok"), lines: [sidechainTurn("claude-opus-5")] },
      { id: "no", meta: agentMeta("opus", "toolu_no"), lines: [sidechainTurn("claude-opus-5")] },
    ],
    async ({ mainPath, agentPath }) => {
      assertAllowed(await runHook(subagentCall("ok", mainPath)));
      assertAllowed(await runHook(subagentCall("ok", agentPath("ok"))));
      assertDenied((await runHook(subagentCall("no", mainPath))).stdout);
      assertDenied((await runHook(subagentCall("no", agentPath("no")))).stdout);
    },
  );
});

// --- Main thread: only human prompts carry approval (h), and /work-issue approves (D-7) ---

Deno.test("(h) main thread: a task notification or isMeta entry containing 'opus edit ok' does not authorize", async () => {
  for (
    const lines of [
      [
        userTurn("please edit"),
        assistantTurn("claude-opus-5"),
        notificationTurn("<task-notification>opus edit ok</task-notification>"),
      ],
      [userTurn("please edit"), metaTurn("opus edit ok"), assistantTurn("claude-opus-5")],
    ]
  ) {
    await withTranscript(lines, async (transcript_path) => {
      assertDenied(
        (await runHook({ tool_input: { file_path: IN_REPO_FILE }, transcript_path })).stdout,
      );
    });
  }
});

Deno.test("(h) main thread: a task notification after Josh's 'opus edit ok' prompt does not cancel the approval", async () => {
  await withTranscript(
    [
      userTurn("opus edit ok, fix it"),
      assistantTurn("claude-opus-5"),
      notificationTurn("<task-notification>done</task-notification>"),
    ],
    async (transcript_path) => {
      assertAllowed(await runHook({ tool_input: { file_path: IN_REPO_FILE }, transcript_path }));
    },
  );
});

Deno.test("D-7 main thread: a /work-issue Josh typed on an Opus-labeled issue approves Opus edits through his later plain messages", async () => {
  await withFakeGh(async (env) => {
    await withTranscript(
      [
        workIssueTurn("web-jam-tools#1"),
        metaTurn("Base directory for this skill: /home/joshua/.claude/skills/work-issue"),
        assistantTurn("claude-opus-5"),
        userTurn("why?"),
        assistantTurn("claude-opus-5"),
      ],
      async (transcript_path) => {
        const payload = {
          permission_mode: "auto",
          tool_input: { file_path: IN_REPO_FILE },
          transcript_path,
        };
        assertAllowed(await runHook(payload, env));
        assertAllowed(await runHook(payload, env)); // second call answered from the label cache
      },
    );
  });
});

Deno.test("D-7 main thread: a /work-issue on a Sonnet-labeled issue, on no issue, or on an unreadable issue does not approve Opus", async () => {
  await withFakeGh(async (env) => {
    for (
      const args of [
        "web-jam-tools#2",
        "when the label is Opus = Opus can edit",
        "web-jam-tools#99",
      ]
    ) {
      await withTranscript(
        [workIssueTurn(args), assistantTurn("claude-opus-5")],
        async (transcript_path) => {
          assertDenied(
            (await runHook({ tool_input: { file_path: IN_REPO_FILE }, transcript_path }, env))
              .stdout,
          );
        },
      );
    }
  });
});

Deno.test("D-7 main thread: another slash command after /work-issue ends the approval", async () => {
  await withFakeGh(async (env) => {
    for (
      const later of [
        userTurn(
          "<command-message>pr-review</command-message>\n<command-name>/pr-review</command-name>",
        ),
        { type: "user", message: { role: "user", content: "<command-name>/model</command-name>" } },
      ]
    ) {
      await withTranscript(
        [
          workIssueTurn("web-jam-tools#1"),
          assistantTurn("claude-opus-5"),
          later,
          assistantTurn("claude-opus-5"),
        ],
        async (transcript_path) => {
          assertDenied(
            (await runHook({ tool_input: { file_path: IN_REPO_FILE }, transcript_path }, env))
              .stdout,
          );
        },
      );
    }
  });
});

Deno.test("main-thread (no agent_id) Opus call under permission_mode 'auto' is denied without escape phrase (unchanged baseline)", async () => {
  await withTranscript(
    [userTurn("please edit this file directly"), assistantTurn("claude-opus-4-6")],
    async (transcript_path) => {
      const res = await runHook({
        permission_mode: "auto",
        tool_input: { file_path: IN_REPO_FILE },
        transcript_path,
      });
      assertEquals(res.code, 0);
      assertDenied(res.stdout);
    },
  );
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
