// Behaviour and edge-case tests for hooks/block-tool-after-question.sh and
// hooks/lib/check_tool_after_question.ts (web-jam-tools#1892).
// Covers all 14 rows of the literal case table in
// ~/Dropbox/web-jam-llms/AI_Misbehaves/hooks-design-2026-09-15.md (v3.8.0).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  collectTurnAssistantTexts,
  evaluateToolAfterQuestion,
} from "../hooks/lib/check_tool_after_question.ts";

const HOOK_SCRIPT = new URL("../hooks/block-tool-after-question.sh", import.meta.url).pathname;
const SHIM_SCRIPT = new URL("../hooks/agy-hook-shim.sh", import.meta.url).pathname;

async function runHook(
  payload: unknown,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = new Deno.Command("bash", {
    args: [HOOK_SCRIPT],
    env: {
      AGY_HOOK_RECORD_PATH: "off",
      ...env,
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  await writer.write(new TextEncoder().encode(raw));
  await writer.close();
  const out = await child.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function runAgyShim(
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<{ code: number; reply: { decision: string; reason?: string }; rawStdout: string }> {
  const child = new Deno.Command("bash", {
    args: [SHIM_SCRIPT, "PreToolUse", btoa(".*"), HOOK_SCRIPT],
    env: {
      AGY_HOOK_RECORD_PATH: "off",
      ...env,
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
  await writer.close();
  const out = await child.output();
  const rawStdout = new TextDecoder().decode(out.stdout);
  return {
    code: out.code,
    reply: JSON.parse(rawStdout),
    rawStdout,
  };
}

async function withTempTranscript(
  entries: unknown[],
  fn: (transcriptPath: string, tempDir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    const transcriptPath = `${tempDir}/transcript.jsonl`;
    const body = entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") +
      "\n";
    await Deno.writeTextFile(transcriptPath, body);
    await fn(transcriptPath, tempDir);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("Row 1 (agy): PLANNER_RESPONSE ends with fabricated user reply after ? -> refuses run_command/read_file/edit_file", async () => {
  const entries = [
    { type: "USER_INPUT", content: "Which option?" },
    {
      type: "PLANNER_RESPONSE",
      content: "Pick one:\nDo you approve Option 1?\noption 1 please\n",
    },
  ];
  await withTempTranscript(entries, async (transcriptPath) => {
    for (const toolName of ["run_command", "read_file", "edit_file"]) {
      const shimRes = await runAgyShim({
        conversationId: "conv-1",
        transcriptPath,
        toolCall: { name: toolName, args: {} },
      });
      assertEquals(shimRes.code, 0);
      assertEquals(shimRes.reply.decision, "deny");
      assert(shimRes.reply.reason, "expected refusal reason");
      assertStringIncludes(shimRes.reply.reason, "Do you approve Option 1?");
      assertStringIncludes(shimRes.reply.reason, "working as designed");
      assertStringIncludes(
        shimRes.reply.reason,
        "deno task workflow-switch --guard block-tool-after-question --ttl-minutes 15",
      );
    }
  });
});

Deno.test("Row 2 (agy): bare question at end of PLANNER_RESPONSE -> refuses read_file and write_file", async () => {
  const entries = [
    { type: "USER_INPUT", content: "Prepare target.txt" },
    { type: "PLANNER_RESPONSE", content: "Do you approve writing target.txt?" },
  ];
  await withTempTranscript(entries, async (transcriptPath, tempDir) => {
    for (const toolName of ["read_file", "write_file"]) {
      const res = await runAgyShim({
        conversationId: "conv-2",
        transcriptPath,
        toolCall: {
          name: toolName,
          args: { Path: `${tempDir}/target.txt`, Content: "x" },
        },
      });
      assertEquals(res.reply.decision, "deny");
      assertStringIncludes(res.reply.reason ?? "", "Do you approve writing target.txt?");
    }
  });
});

Deno.test("Row 3 (agy): SYSTEM_MESSAGE, GENERIC, and CHECKPOINT after ? do not clear boundary", async () => {
  for (const fillerType of ["SYSTEM_MESSAGE", "GENERIC", "CHECKPOINT"]) {
    const entries = [
      { type: "USER_INPUT", content: "Start" },
      { type: "PLANNER_RESPONSE", content: "Should I schedule the cron?" },
      { type: fillerType, content: "Background event fired" },
    ];
    await withTempTranscript(entries, async (transcriptPath) => {
      for (const toolName of ["schedule", "read_file"]) {
        const res = await runAgyShim({
          conversationId: "conv-3",
          transcriptPath,
          toolCall: { name: toolName, args: {} },
        });
        assertEquals(res.reply.decision, "deny", `${fillerType} + ${toolName} should refuse`);
        assertStringIncludes(res.reply.reason ?? "", "Should I schedule the cron?");
      }
    });
  }
});

Deno.test("Row 4 (agy): new USER_INPUT after ? clears the block -> edit_file allowed", async () => {
  const entries = [
    { type: "USER_INPUT", content: "Ask me first" },
    { type: "PLANNER_RESPONSE", content: "Do you approve Option 1?" },
    { type: "USER_INPUT", content: "option 1 please" },
    { type: "PLANNER_RESPONSE", content: "Applying Option 1 now." },
  ];
  await withTempTranscript(entries, async (transcriptPath) => {
    const res = await runAgyShim({
      conversationId: "conv-4",
      transcriptPath,
      toolCall: { name: "edit_file", args: {} },
    });
    assertEquals(res.code, 0);
    assertEquals(res.reply, { decision: "allow" });
  });
});

Deno.test("Row 5 (agy): PLANNER_RESPONSE with statements only (no ?) -> read_file allowed", async () => {
  const entries = [
    { type: "USER_INPUT", content: "Read config" },
    { type: "PLANNER_RESPONSE", content: "Reading configuration now." },
  ];
  await withTempTranscript(entries, async (transcriptPath) => {
    const res = await runAgyShim({
      conversationId: "conv-5",
      transcriptPath,
      toolCall: { name: "read_file", args: {} },
    });
    assertEquals(res.reply, { decision: "allow" });
  });
});

Deno.test("Row 6 (agy): PLANNER_RESPONSE asks question -> ask_question allowed (exempt tool)", async () => {
  const entries = [
    { type: "USER_INPUT", content: "Help me pick" },
    { type: "PLANNER_RESPONSE", content: "Which approach should we take?" },
  ];
  await withTempTranscript(entries, async (transcriptPath) => {
    const res = await runAgyShim({
      conversationId: "conv-6",
      transcriptPath,
      toolCall: { name: "ask_question", args: { questions: [] } },
    });
    assertEquals(res.reply, { decision: "allow" });
  });
});

Deno.test("Row 7 (Codex): response_item assistant output_text with ? -> Bash and apply_patch refused", async () => {
  const entries = [
    {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Check" }] },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Should I inspect hello.txt?" }],
      },
    },
  ];
  await withTempTranscript(entries, async (transcriptPath) => {
    for (const toolName of ["Bash", "apply_patch"]) {
      const res = await runHook(
        { transcript_path: transcriptPath, tool_name: toolName, tool_input: {} },
        { WJT_SURFACE: "codex" },
      );
      assertEquals(res.code, 2, `${toolName} should be refused on Codex`);
      assertStringIncludes(res.stderr, "Should I inspect hello.txt?");
    }
  });
});

Deno.test("Row 8 (Codex): new response_item user message clears earlier ? -> Bash allowed", async () => {
  const entries = [
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Start" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Should I inspect hello.txt?" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Yes, inspect it." }],
      },
    },
  ];
  await withTempTranscript(entries, async (transcriptPath) => {
    const res = await runHook(
      {
        transcript_path: transcriptPath,
        tool_name: "Bash",
        tool_input: { command: "cat hello.txt" },
      },
      { WJT_SURFACE: "codex" },
    );
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stdout, "");
  });
});

Deno.test("Row 9 (Claude Code): step 1 assistant text had ?, step 2 Read/Edit/Write/Bash -> refused", async () => {
  const entries = [
    { type: "user", message: { role: "user", content: "Investigate" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Should I proceed?" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
        ],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
      },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Running step 2." }],
      },
    },
  ];
  await withTempTranscript(entries, async (transcriptPath) => {
    for (const toolName of ["Read", "Edit", "Write", "Bash"]) {
      const res = await runHook({
        transcript_path: transcriptPath,
        tool_name: toolName,
        tool_input: {},
      });
      assertEquals(res.code, 2, `${toolName} should refuse at step 2`);
      assertStringIncludes(res.stderr, "Should I proceed?");
    }
  });
});

Deno.test("Row 10 (Claude Code): step 1 assistant text had ? -> AskUserQuestion allowed", async () => {
  const entries = [
    { type: "user", message: { role: "user", content: "Ask me" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Should I proceed?" }],
      },
    },
  ];
  await withTempTranscript(entries, async (transcriptPath) => {
    const res = await runHook({
      transcript_path: transcriptPath,
      tool_name: "AskUserQuestion",
      tool_input: {},
    });
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stdout, "");
  });
});

Deno.test("Row 11 (Claude Code): main session has ?, subagent with agent_id runs -> Bash/Read allowed", async () => {
  const entries = [
    { type: "user", message: { role: "user", content: "Main turn" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Should main stop?" }],
      },
    },
  ];
  await withTempTranscript(entries, async (transcriptPath) => {
    for (const toolName of ["Bash", "Read"]) {
      const res = await runHook({
        transcript_path: transcriptPath,
        agent_id: "sub-1",
        tool_name: toolName,
        tool_input: {},
      });
      assertEquals(res.code, 0, res.stderr);
      assertEquals(res.stdout, "");
    }
  });
});

Deno.test("Row 12 (Any surface): ? only inside fenced code, backticks, double quotes, URL, or blockquote -> allowed", async () => {
  const safeProse = [
    "Here is code:",
    "```ts",
    "const x = a ? b : c;",
    "```",
    "Inline `flag ? 1 : 0` check.",
    'The issue is titled "Why did X fail?".',
    "Visit https://example.com?a=1&b=2 for details.",
    "> Did Josh ask this earlier?",
  ].join("\n");

  const entries = [
    { type: "USER_INPUT", content: "Check sanitization" },
    { type: "PLANNER_RESPONSE", content: safeProse },
  ];
  await withTempTranscript(entries, async (transcriptPath) => {
    const agyRes = await runAgyShim({
      conversationId: "conv-12",
      transcriptPath,
      toolCall: { name: "read_file", args: {} },
    });
    assertEquals(agyRes.reply, { decision: "allow" });

    const claudeRes = await runHook({
      transcript_path: transcriptPath,
      tool_name: "Bash",
      tool_input: { command: "echo ok" },
    });
    assertEquals(claudeRes.code, 0);
    assertEquals(claudeRes.stdout, "");
  });
});

Deno.test("Row 13 (Any surface): unexpired workflow switch releases block and logs to workflow-switch.log", async () => {
  const entries = [
    { type: "USER_INPUT", content: "Ask" },
    { type: "PLANNER_RESPONSE", content: "Should I proceed?" },
  ];
  await withTempTranscript(entries, async (transcriptPath, tempDir) => {
    const switchPath = `${tempDir}/workflow-switch.json`;
    const logPath = `${tempDir}/workflow-switch.log`;
    await Deno.writeTextFile(
      switchPath,
      JSON.stringify({
        guard: "block-tool-after-question",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    const res = await runHook(
      { transcript_path: transcriptPath, tool_name: "read_file", tool_input: {} },
      { WORKFLOW_SWITCH_PATH: switchPath, WORKFLOW_SWITCH_LOG_PATH: logPath },
    );
    assertEquals(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assertStringIncludes(out.hookSpecificOutput.additionalContext, "Released by workflow switch");
    const log = await Deno.readTextFile(logPath);
    assertStringIncludes(log, "released guard: block-tool-after-question");
  });
});

Deno.test("Row 14 (Any surface): missing transcript_path, nonexistent file, or unparseable payload -> allows with workflow note", async () => {
  // Missing transcript_path
  const missingPathRes = await runHook({ tool_name: "read_file", tool_input: {} });
  assertEquals(missingPathRes.code, 0);
  const missingOut = JSON.parse(missingPathRes.stdout);
  assertEquals(missingOut.hookSpecificOutput.hookEventName, "PreToolUse");
  assertStringIncludes(
    missingOut.hookSpecificOutput.additionalContext,
    "transcript_path is missing",
  );

  // Nonexistent transcript file
  const noFileRes = await runHook({
    transcript_path: "/tmp/nonexistent-block-tool-after-question-transcript.jsonl",
    tool_name: "read_file",
    tool_input: {},
  });
  assertEquals(noFileRes.code, 0);
  const noFileOut = JSON.parse(noFileRes.stdout);
  assertStringIncludes(
    noFileOut.hookSpecificOutput.additionalContext,
    "transcript file could not be read",
  );

  // Unparseable payload
  const badJsonRes = await runHook("{not json");
  assertEquals(badJsonRes.code, 0);
  const badJsonOut = JSON.parse(badJsonRes.stdout);
  assertStringIncludes(
    badJsonOut.hookSpecificOutput.additionalContext,
    "hook payload could not be parsed",
  );

  // agy shim propagates allow reason when transcriptPath is missing
  const agyMissingRes = await runAgyShim({
    conversationId: "conv-14",
    toolCall: { name: "read_file", args: {} },
  });
  assertEquals(agyMissingRes.reply.decision, "allow");
  assertStringIncludes(agyMissingRes.reply.reason ?? "", "transcript_path is missing");
});

Deno.test("Claude Code ignores isSidechain, isApiErrorMessage, and non-text content blocks", () => {
  const texts = collectTurnAssistantTexts([
    { type: "user", message: { role: "user", content: "Start" } },
    {
      type: "assistant",
      isSidechain: true,
      message: { role: "assistant", content: "Sidechain question?" },
    },
    {
      type: "assistant",
      isApiErrorMessage: true,
      message: { role: "assistant", content: "Retry error?" },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Internal question?" },
          { type: "tool_use", name: "Read", input: {} },
          { type: "text", text: "Statement only." },
        ],
      },
    },
  ]);
  assertEquals(texts, ["Statement only."]);
});

Deno.test("Expired or differently-named workflow switch still refuses", async () => {
  const entries = [
    { type: "USER_INPUT", content: "Go" },
    { type: "PLANNER_RESPONSE", content: "Confirm?" },
  ];
  await withTempTranscript(entries, async (transcriptPath, tempDir) => {
    const switchPath = `${tempDir}/workflow-switch.json`;
    const logPath = `${tempDir}/workflow-switch.log`;

    // Expired
    await Deno.writeTextFile(
      switchPath,
      JSON.stringify({
        guard: "block-tool-after-question",
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    const expiredRes = await runHook(
      { transcript_path: transcriptPath, tool_name: "read_file", tool_input: {} },
      { WORKFLOW_SWITCH_PATH: switchPath, WORKFLOW_SWITCH_LOG_PATH: logPath },
    );
    assertEquals(expiredRes.code, 2);

    // Different guard
    await Deno.writeTextFile(
      switchPath,
      JSON.stringify({
        guard: "opus-delegation-gate",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const otherRes = await runHook(
      { transcript_path: transcriptPath, tool_name: "read_file", tool_input: {} },
      { WORKFLOW_SWITCH_PATH: switchPath, WORKFLOW_SWITCH_LOG_PATH: logPath },
    );
    assertEquals(otherRes.code, 2);
  });
});

Deno.test("All-lines-corrupt non-empty transcript allows with workflow note", () => {
  const decision = evaluateToolAfterQuestion(
    JSON.stringify({ transcript_path: "/fake/transcript.jsonl", tool_name: "Read" }),
    { readFile: () => "not json at all\nalso broken\n" },
  );
  assertEquals(decision.outcome, "allow-with-note");
  if (decision.outcome === "allow-with-note") {
    assertStringIncludes(decision.note, "no valid JSONL entries");
  }
});

Deno.test("run_hook.sh workflow fallback emits additionalContext when Deno is unavailable", async () => {
  const fakeBin = await Deno.makeTempDir();
  try {
    const fakeDeno = `${fakeBin}/deno`;
    await Deno.writeTextFile(fakeDeno, "#!/bin/sh\nexit 1\n");
    await Deno.chmod(fakeDeno, 0o755);

    const res = await runHook(
      { transcript_path: "/tmp/any.jsonl", tool_name: "Read" },
      {
        PATH: `${fakeBin}:${Deno.env.get("PATH") ?? ""}`,
        BASH_ENV: "",
      },
    );
    assertEquals(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assertEquals(out.hookSpecificOutput.hookEventName, "PreToolUse");
    assertStringIncludes(out.hookSpecificOutput.additionalContext, "block-tool-after-question");
  } finally {
    await Deno.remove(fakeBin, { recursive: true });
  }
});
