// test/agy_skill_run_hook.test.ts — web-jam-tools#1319
//
// Comprehensive unit and end-to-end integration tests for:
// - hooks/lib/check_agy_skill_run.ts
// - hooks/agy-skill-run-hook.sh
//
// Tests cover the closed case lists from issue 1319:
// 1. What Josh typed, and what the hook decides
// 2. Conversation records (including helper agents up to 3 steps up)
// 3. Commands, and what the hook answers (rewriting and deny rules)
// 4. Fail-open behavior when the record cannot be decided
// 5. Direct execution of bash hooks/agy-skill-run-hook.sh

import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import {
  containsInstalledScriptPath,
  evaluateMessage,
  evaluateUserMessages,
  handlePreToolUse,
  type HookResult,
  INSTALLED_SCRIPT_PATH,
  isSkillRunOpen,
  rewriteCommand,
} from "../hooks/lib/check_agy_skill_run.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const HOOK_SCRIPT_PATH = `${REPO_ROOT}hooks/agy-skill-run-hook.sh`;

// Installed skills matching row 2 closed cases:
const MOCK_PLUGIN_SKILLS = new Set(["work-issue", "pr-review", "sheet-music"]);
const MOCK_USER_SKILLS = new Set<string>();

// ---------------------------------------------------------------------------
// 1. rewriteCommand unit tests
// ---------------------------------------------------------------------------

Deno.test("rewriteCommand: rewrites simple command with single quotes", () => {
  const rewritten = rewriteCommand("git -C /tmp/agy-worktrees/x status --short");
  assertEquals(
    rewritten,
    `${INSTALLED_SCRIPT_PATH} 'git -C /tmp/agy-worktrees/x status --short'`,
  );
});

Deno.test("rewriteCommand: rewrites single quotes as '\\''", () => {
  const cmd = `echo "it's a 'quoted' test" > /tmp/out.txt && cat /tmp/out.txt | wc -c`;
  const rewritten = rewriteCommand(cmd);
  assertEquals(
    rewritten,
    `${INSTALLED_SCRIPT_PATH} 'echo "it'\\''s a '\\''quoted'\\'' test" > /tmp/out.txt && cat /tmp/out.txt | wc -c'`,
  );
});

Deno.test("rewriteCommand: python3 inline quote escaping", () => {
  const cmd = `python3 -c 'print("inline", 6*7)'`;
  const rewritten = rewriteCommand(cmd);
  assertEquals(
    rewritten,
    `${INSTALLED_SCRIPT_PATH} 'python3 -c '\\''print("inline", 6*7)'\\'''`,
  );
});

Deno.test("rewriteCommand: two-line command keeps line break inside quotes", () => {
  const cmd = `echo line1\necho line2`;
  const rewritten = rewriteCommand(cmd);
  assertEquals(
    rewritten,
    `${INSTALLED_SCRIPT_PATH} 'echo line1\necho line2'`,
  );
});

Deno.test("containsInstalledScriptPath: detects all variants of installed script path", () => {
  assertEquals(
    containsInstalledScriptPath("/home/joshua/.claude/hooks/agy-skill-run.sh 'rm -rf x'"),
    true,
  );
  assertEquals(
    containsInstalledScriptPath("~/.claude/hooks/agy-skill-run.sh 'ls'"),
    true,
  );
  assertEquals(
    containsInstalledScriptPath("$HOME/.claude/hooks/agy-skill-run.sh ls"),
    true,
  );
  assertEquals(
    containsInstalledScriptPath("bash /home/joshua/.claude/hooks/agy-skill-run.sh ls"),
    true,
  );
  assertEquals(
    containsInstalledScriptPath("echo ok; /home/joshua/.claude/hooks/agy-skill-run.sh ls"),
    true,
  );
  assertEquals(
    containsInstalledScriptPath("git add scripts/agy-skill-run.sh"),
    false,
  );
  assertEquals(
    containsInstalledScriptPath("git -C /tmp/agy-worktrees/x status --short"),
    false,
  );
});

// ---------------------------------------------------------------------------
// 2. What Josh typed, and what the hook decides (Closed Case List)
// ---------------------------------------------------------------------------

const TYPED_CASES: Array<{
  message: string;
  expectedSlash: boolean;
  expectedInstalled: boolean;
  desc: string;
}> = [
  {
    message: "/work-issue web-jam-tools#1304",
    expectedSlash: true,
    expectedInstalled: true,
    desc: "a slash command; a skill run is open",
  },
  {
    message: "/webjam-tasks:work-issue https://github.com/WebJamApps/web-jam-tools/issues/1304",
    expectedSlash: true,
    expectedInstalled: true,
    desc: "a slash command; a skill run is open",
  },
  {
    message: "/pr-review",
    expectedSlash: true,
    expectedInstalled: true,
    desc: "a slash command; a skill run is open",
  },
  {
    message: "/webjam-tasks:pr-review\nhttps://github.com/WebJamApps/web-jam-tools/pull/1313",
    expectedSlash: true,
    expectedInstalled: true,
    desc: "a slash command; a skill run is open",
  },
  {
    message: "/sheet-music",
    expectedSlash: true,
    expectedInstalled: true,
    desc: "a slash command; a skill run is open",
  },
  {
    message: "/webjam-tasks:work-issueplease fix it",
    expectedSlash: true,
    expectedInstalled: false,
    desc: "slash command not installed; no skill run open, open one ends",
  },
  {
    message: "/other-plugin:work-issue web-jam-tools#1304",
    expectedSlash: true,
    expectedInstalled: false,
    desc: "slash command not installed; no skill run open, open one ends",
  },
  {
    message: "/config",
    expectedSlash: true,
    expectedInstalled: false,
    desc: "slash command not installed; no skill run open, open one ends",
  },
  {
    message: "/probe-skill",
    expectedSlash: true,
    expectedInstalled: false,
    desc: "only in project folder .agents/skills/probe-skill; not installed",
  },
  {
    message: "/home/joshua/Pictures/shot.png what is this",
    expectedSlash: false,
    expectedInstalled: false,
    desc: "not a slash command; an open skill run stays open",
  },
  {
    message: "please run /work-issue web-jam-tools#1304",
    expectedSlash: false,
    expectedInstalled: false,
    desc: "not a slash command; an open skill run stays open",
  },
  {
    message: "yes",
    expectedSlash: false,
    expectedInstalled: false,
    desc: "not a slash command; an open skill run stays open",
  },
  {
    message: "are you stuck?",
    expectedSlash: false,
    expectedInstalled: false,
    desc: "not a slash command; an open skill run stays open",
  },
  {
    message: "please fix this PR and leave a comment",
    expectedSlash: false,
    expectedInstalled: false,
    desc: "not a slash command; an open skill run stays open",
  },
];

for (const tc of TYPED_CASES) {
  Deno.test(`What Josh typed: "${tc.message.replace(/\n/g, "\\n")}" -> ${tc.desc}`, () => {
    const res = evaluateMessage(tc.message, MOCK_PLUGIN_SKILLS, MOCK_USER_SKILLS);
    assertEquals(res.isSlashCommand, tc.expectedSlash, `isSlashCommand for: ${tc.message}`);
    assertEquals(
      res.isInstalledSkill,
      tc.expectedInstalled,
      `isInstalledSkill for: ${tc.message}`,
    );
  });
}

// ---------------------------------------------------------------------------
// 3. Conversation records (Closed Case List)
// ---------------------------------------------------------------------------

Deno.test("Conversation record: holds /work-issue web-jam-tools#1304, then yes -> open", () => {
  const messages = ["/work-issue web-jam-tools#1304", "yes"];
  const isOpen = evaluateUserMessages(messages, MOCK_PLUGIN_SKILLS, MOCK_USER_SKILLS);
  assertEquals(isOpen, true);
});

Deno.test("Conversation record: holds /work-issue web-jam-tools#1304, then /config -> not open", () => {
  const messages = ["/work-issue web-jam-tools#1304", "/config"];
  const isOpen = evaluateUserMessages(messages, MOCK_PLUGIN_SKILLS, MOCK_USER_SKILLS);
  assertEquals(isOpen, false);
});

Deno.test("Conversation record: holds /config, then /pr-review -> open", () => {
  const messages = ["/config", "/pr-review"];
  const isOpen = evaluateUserMessages(messages, MOCK_PLUGIN_SKILLS, MOCK_USER_SKILLS);
  assertEquals(isOpen, true);
});

Deno.test("Conversation record: holds only please fix this PR and leave a comment -> not open", () => {
  const messages = ["please fix this PR and leave a comment"];
  const isOpen = evaluateUserMessages(messages, MOCK_PLUGIN_SKILLS, MOCK_USER_SKILLS);
  assertEquals(isOpen, false);
});

// Helper agent cases
Deno.test("Helper agent: holds nothing Josh typed, message folder names starting conv, starting conv record lists it and holds /work-issue -> open", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "agy-helper-test-" });
  try {
    const parentId = "parent-conv-123";
    const helperId = "helper-conv-456";

    // Setup parent directory
    const parentDir = join(tmpDir, parentId, ".system_generated", "logs");
    await Deno.mkdir(parentDir, { recursive: true });
    const parentTranscript = join(parentDir, "transcript.jsonl");
    const parentContent = [
      JSON.stringify({ type: "USER_INPUT", content: "/work-issue web-jam-tools#1304" }),
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        content: `Created the following subagents:\n{"conversationId": "${helperId}"}`,
      }),
    ].join("\n");
    await Deno.writeTextFile(parentTranscript, parentContent);

    // Setup helper directory
    const helperLogs = join(tmpDir, helperId, ".system_generated", "logs");
    const helperMessages = join(tmpDir, helperId, ".system_generated", "messages");
    await Deno.mkdir(helperLogs, { recursive: true });
    await Deno.mkdir(helperMessages, { recursive: true });
    const helperTranscript = join(helperLogs, "transcript.jsonl");
    // Helper holds nothing Josh typed:
    await Deno.writeTextFile(
      helperTranscript,
      JSON.stringify({ type: "PLANNER_RESPONSE", content: "Working on it" }) + "\n",
    );

    // Helper message folder names starting conversation:
    const msgFile = join(helperMessages, "msg-1.json");
    await Deno.writeTextFile(
      msgFile,
      JSON.stringify({
        recipient: helperId,
        sender: parentId,
        sourceMetadata: {
          tool: {
            conversationId: parentId,
            toolCall: { name: "invoke_subagent" },
          },
        },
      }),
    );

    const res = isSkillRunOpen(helperTranscript, helperId, MOCK_PLUGIN_SKILLS, MOCK_USER_SKILLS);
    assertEquals(res.outcome, "open");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("Helper agent: holds nothing Josh typed, message folder names starting conv, starting conv record does NOT list it -> not open", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "agy-helper-test-" });
  try {
    const parentId = "parent-conv-123";
    const helperId = "helper-conv-456";

    // Setup parent directory without helperId listed
    const parentDir = join(tmpDir, parentId, ".system_generated", "logs");
    await Deno.mkdir(parentDir, { recursive: true });
    const parentTranscript = join(parentDir, "transcript.jsonl");
    const parentContent = JSON.stringify({
      type: "USER_INPUT",
      content: "/work-issue web-jam-tools#1304",
    }) + "\n";
    await Deno.writeTextFile(parentTranscript, parentContent);

    // Setup helper directory
    const helperLogs = join(tmpDir, helperId, ".system_generated", "logs");
    const helperMessages = join(tmpDir, helperId, ".system_generated", "messages");
    await Deno.mkdir(helperLogs, { recursive: true });
    await Deno.mkdir(helperMessages, { recursive: true });
    const helperTranscript = join(helperLogs, "transcript.jsonl");
    await Deno.writeTextFile(
      helperTranscript,
      JSON.stringify({ type: "PLANNER_RESPONSE", content: "Working" }) + "\n",
    );

    const msgFile = join(helperMessages, "msg-1.json");
    await Deno.writeTextFile(
      msgFile,
      JSON.stringify({
        recipient: helperId,
        sender: parentId,
      }),
    );

    const res = isSkillRunOpen(helperTranscript, helperId, MOCK_PLUGIN_SKILLS, MOCK_USER_SKILLS);
    assertEquals(res.outcome, "not_open");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("Helper agent: holds nothing Josh typed and has no message folder -> not open", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "agy-helper-test-" });
  try {
    const helperId = "helper-conv-no-messages";
    const helperLogs = join(tmpDir, helperId, ".system_generated", "logs");
    await Deno.mkdir(helperLogs, { recursive: true });
    const helperTranscript = join(helperLogs, "transcript.jsonl");
    await Deno.writeTextFile(
      helperTranscript,
      JSON.stringify({ type: "PLANNER_RESPONSE", content: "Running" }) + "\n",
    );

    const res = isSkillRunOpen(helperTranscript, helperId, MOCK_PLUGIN_SKILLS, MOCK_USER_SKILLS);
    assertEquals(res.outcome, "not_open");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("Helper agent: four steps up to the conversation Josh typed in -> not open", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "agy-helper-test-" });
  try {
    // Conv 0 (Josh typed in), Conv 1 (helper), Conv 2 (helper), Conv 3 (helper), Conv 4 (helper)
    // From Conv 4 to Conv 0 is 4 steps up!
    const convs = ["conv0", "conv1", "conv2", "conv3", "conv4"];

    for (let i = 0; i < convs.length; i++) {
      const id = convs[i];
      const logs = join(tmpDir, id, ".system_generated", "logs");
      await Deno.mkdir(logs, { recursive: true });
      const tPath = join(logs, "transcript.jsonl");

      let content = "";
      if (i === 0) {
        content =
          JSON.stringify({ type: "USER_INPUT", content: "/work-issue web-jam-tools#1304" }) +
          "\n";
      } else {
        content = JSON.stringify({ type: "PLANNER_RESPONSE", content: "Helper step" }) + "\n";
      }
      if (i < convs.length - 1) {
        // Parent lists child
        content += JSON.stringify({
          type: "PLANNER_RESPONSE",
          content: `Subagent: ${convs[i + 1]}`,
        }) + "\n";
      }
      await Deno.writeTextFile(tPath, content);

      if (i > 0) {
        const msgs = join(tmpDir, id, ".system_generated", "messages");
        await Deno.mkdir(msgs, { recursive: true });
        const mPath = join(msgs, "msg.json");
        await Deno.writeTextFile(
          mPath,
          JSON.stringify({
            recipient: id,
            sender: convs[i - 1],
          }),
        );
      }
    }

    // Check conv 3 (3 steps up to conv0) -> should be OPEN
    const conv3Transcript = join(tmpDir, "conv3", ".system_generated", "logs", "transcript.jsonl");
    const res3 = isSkillRunOpen(conv3Transcript, "conv3", MOCK_PLUGIN_SKILLS, MOCK_USER_SKILLS);
    assertEquals(res3.outcome, "open", "3 steps up should resolve to open");

    // Check conv 4 (4 steps up to conv0) -> must be NOT OPEN
    const conv4Transcript = join(tmpDir, "conv4", ".system_generated", "logs", "transcript.jsonl");
    const res4 = isSkillRunOpen(conv4Transcript, "conv4", MOCK_PLUGIN_SKILLS, MOCK_USER_SKILLS);
    assertEquals(res4.outcome, "not_open", "4 steps up must not be open");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("Conversation record: fails open (cannot tell) on missing record path, unreadable file, or invalid JSON", () => {
  // Missing transcriptPath
  const resMissing = isSkillRunOpen(undefined, "id", MOCK_PLUGIN_SKILLS, MOCK_USER_SKILLS);
  assertEquals(resMissing.outcome, "cannot_tell");

  // Unreadable file
  const resUnreadable = isSkillRunOpen(
    "/non/existent/path/transcript.jsonl",
    "id",
    MOCK_PLUGIN_SKILLS,
    MOCK_USER_SKILLS,
  );
  assertEquals(resUnreadable.outcome, "cannot_tell");
});

Deno.test("Conversation record: fails open when a line is not valid JSON", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "agy-invalid-json-" });
  try {
    const tPath = join(tmpDir, "transcript.jsonl");
    await Deno.writeTextFile(tPath, '{"type":"USER_INPUT"}\nNOT_VALID_JSON\n');
    const res = isSkillRunOpen(tPath, "id", MOCK_PLUGIN_SKILLS, MOCK_USER_SKILLS);
    assertEquals(res.outcome, "cannot_tell");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Commands, and what the hook answers (Closed Case List)
// ---------------------------------------------------------------------------

Deno.test("handlePreToolUse: commands and hook answers closed cases", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "agy-cmd-test-" });
  try {
    const openTranscript = join(tmpDir, "open_transcript.jsonl");
    await Deno.writeTextFile(
      openTranscript,
      JSON.stringify({ type: "USER_INPUT", content: "/work-issue web-jam-tools#1304" }) + "\n",
    );

    const closedTranscript = join(tmpDir, "closed_transcript.jsonl");
    await Deno.writeTextFile(
      closedTranscript,
      JSON.stringify({ type: "USER_INPUT", content: "/config" }) + "\n",
    );

    const cases: Array<{
      command?: string;
      toolName?: string;
      transcript: string;
      expectedDecision: "allow" | "deny";
      expectedOverwrite?: string;
      desc: string;
    }> = [
      {
        command: "git -C /tmp/agy-worktrees/x status --short",
        transcript: openTranscript,
        expectedDecision: "allow",
        expectedOverwrite:
          "/home/joshua/.claude/hooks/agy-skill-run.sh 'git -C /tmp/agy-worktrees/x status --short'",
        desc: "git status (open) -> allow, rewritten",
      },
      {
        command: `echo "it's a 'quoted' test" > /tmp/out.txt && cat /tmp/out.txt | wc -c`,
        transcript: openTranscript,
        expectedDecision: "allow",
        expectedOverwrite:
          `/home/joshua/.claude/hooks/agy-skill-run.sh 'echo "it'\\''s a '\\''quoted'\\'' test" > /tmp/out.txt && cat /tmp/out.txt | wc -c'`,
        desc: "nested quotes (open) -> allow, rewritten with '\\'''",
      },
      {
        command: `python3 -c 'print("inline", 6*7)'`,
        transcript: openTranscript,
        expectedDecision: "allow",
        expectedOverwrite:
          `/home/joshua/.claude/hooks/agy-skill-run.sh 'python3 -c '\\''print("inline", 6*7)'\\'''`,
        desc: "python3 inline (open) -> allow, rewritten same way",
      },
      {
        command: `echo line1\necho line2`,
        transcript: openTranscript,
        expectedDecision: "allow",
        expectedOverwrite: `/home/joshua/.claude/hooks/agy-skill-run.sh 'echo line1\necho line2'`,
        desc: "two-line command (open) -> allow, line break inside quotes",
      },
      {
        command: "git -C /tmp/agy-worktrees/x status --short",
        transcript: closedTranscript,
        expectedDecision: "allow",
        expectedOverwrite: undefined,
        desc: "git status (not open) -> allow, no rewrite",
      },
      {
        command: "/home/joshua/.claude/hooks/agy-skill-run.sh 'rm -rf x'",
        transcript: openTranscript,
        expectedDecision: "deny",
        desc: "direct installed path (open) -> deny",
      },
      {
        command: "/home/joshua/.claude/hooks/agy-skill-run.sh 'rm -rf x'",
        transcript: closedTranscript,
        expectedDecision: "deny",
        desc: "direct installed path (not open) -> deny",
      },
      {
        command: "~/.claude/hooks/agy-skill-run.sh 'ls'",
        transcript: closedTranscript,
        expectedDecision: "deny",
        desc: "~ installed path (not open) -> deny",
      },
      {
        command: "$HOME/.claude/hooks/agy-skill-run.sh ls",
        transcript: closedTranscript,
        expectedDecision: "deny",
        desc: "$HOME installed path (not open) -> deny",
      },
      {
        command: "bash /home/joshua/.claude/hooks/agy-skill-run.sh ls",
        transcript: closedTranscript,
        expectedDecision: "deny",
        desc: "bash installed path (not open) -> deny",
      },
      {
        command: "echo ok; /home/joshua/.claude/hooks/agy-skill-run.sh ls",
        transcript: closedTranscript,
        expectedDecision: "deny",
        desc: "compound command with installed path (not open) -> deny",
      },
      {
        command: "git add scripts/agy-skill-run.sh",
        transcript: closedTranscript,
        expectedDecision: "allow",
        expectedOverwrite: undefined,
        desc: "git add scripts/... (not open) -> allow, no rewrite",
      },
      {
        command: "git add scripts/agy-skill-run.sh",
        transcript: openTranscript,
        expectedDecision: "allow",
        expectedOverwrite:
          "/home/joshua/.claude/hooks/agy-skill-run.sh 'git add scripts/agy-skill-run.sh'",
        desc: "git add scripts/... (open) -> allow, rewritten",
      },
      {
        toolName: "write_to_file",
        transcript: openTranscript,
        expectedDecision: "allow",
        expectedOverwrite: undefined,
        desc: "non run_command tool (open) -> allow, no rewrite",
      },
      {
        toolName: "read_url_content",
        transcript: openTranscript,
        expectedDecision: "allow",
        expectedOverwrite: undefined,
        desc: "read_url_content tool (open) -> allow, no rewrite",
      },
      {
        toolName: "invoke_subagent",
        transcript: openTranscript,
        expectedDecision: "allow",
        expectedOverwrite: undefined,
        desc: "invoke_subagent tool (open) -> allow, no rewrite",
      },
    ];

    for (const tc of cases) {
      const payload = {
        toolCall: {
          name: tc.toolName ?? "run_command",
          args: {
            CommandLine: tc.command,
          },
        },
        transcriptPath: tc.transcript,
      };

      const result: HookResult = handlePreToolUse(
        payload,
        MOCK_PLUGIN_SKILLS,
        MOCK_USER_SKILLS,
      );
      assertEquals(
        result.decision,
        tc.expectedDecision,
        `Decision mismatch for case: ${tc.desc}`,
      );
      if (tc.expectedOverwrite !== undefined) {
        assertEquals(
          result.overwrite?.CommandLine,
          tc.expectedOverwrite,
          `Overwrite mismatch for case: ${tc.desc}`,
        );
      } else {
        assertEquals(
          result.overwrite,
          undefined,
          `Expected no overwrite for case: ${tc.desc}`,
        );
      }
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 5. End-to-end integration test of hooks/agy-skill-run-hook.sh
// ---------------------------------------------------------------------------

async function runHookScript(payload: unknown): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  parsed: HookResult;
}> {
  const cmd = new Deno.Command("bash", {
    args: [HOOK_SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  const outStr = new TextDecoder().decode(stdout).trim();
  const errStr = new TextDecoder().decode(stderr).trim();
  return {
    code,
    stdout: outStr,
    stderr: errStr,
    parsed: JSON.parse(outStr),
  };
}

Deno.test("E2E hooks/agy-skill-run-hook.sh: rewrites open command and exits 0", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "agy-e2e-" });
  try {
    const tPath = join(tmpDir, "transcript.jsonl");
    await Deno.writeTextFile(
      tPath,
      JSON.stringify({ type: "USER_INPUT", content: "/work-issue web-jam-tools#1304" }) + "\n",
    );

    const payload = {
      toolCall: {
        name: "run_command",
        args: {
          CommandLine: "git -C /tmp/agy-worktrees/x status --short",
        },
      },
      transcriptPath: tPath,
    };

    const res = await runHookScript(payload);
    assertEquals(res.code, 0);
    assertEquals(res.parsed.decision, "allow");
    assertEquals(
      res.parsed.overwrite?.CommandLine,
      "/home/joshua/.claude/hooks/agy-skill-run.sh 'git -C /tmp/agy-worktrees/x status --short'",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("E2E hooks/agy-skill-run-hook.sh: denies direct installed script path", async () => {
  const payload = {
    toolCall: {
      name: "run_command",
      args: {
        CommandLine: "/home/joshua/.claude/hooks/agy-skill-run.sh 'rm -rf x'",
      },
    },
  };

  const res = await runHookScript(payload);
  assertEquals(res.code, 0);
  assertEquals(res.parsed.decision, "deny");
  assert(res.parsed.reason !== undefined);
});

Deno.test("E2E hooks/agy-skill-run-hook.sh: fails open with allow on invalid input", async () => {
  const cmd = new Deno.Command("bash", {
    args: [HOOK_SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode("NOT_JSON"));
  await writer.close();
  const { code, stdout } = await child.output();
  const outStr = new TextDecoder().decode(stdout).trim();

  assertEquals(code, 0);
  const parsed = JSON.parse(outStr);
  assertEquals(parsed.decision, "allow");
});
