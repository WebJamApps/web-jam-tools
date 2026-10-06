// check_issue_citation_on_write_hook.test.ts — web-jam-tools#1056
//
// Exercises hooks/check-issue-citation-on-write.sh end-to-end (Claude Code shape) AND,
// per the design's "both surfaces — a standing requirement", through
// hooks/agy-hook-shim.sh unmodified — proving the agy deny comes back as
// {"decision":"deny","reason":"..."} with exit 0, and allow comes back as
// {"decision":"allow"} with exit 0.

import { assertEquals, assertStringIncludes } from "@std/assert";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const HOOK_SCRIPT = `${REPO_ROOT}hooks/check-issue-citation-on-write.sh`;
const AGY_SHIM = `${REPO_ROOT}hooks/agy-hook-shim.sh`;
const MATCHER =
  "Bash|(?:mcp__.*__)?(issue_write|pull_request_review_write|add_comment_to_pending_review|add_reply_to_pull_request_comment|update_issue_comment|add_issue_comment)";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runClaude(payload: Record<string, unknown>): Promise<RunResult> {
  const input = JSON.stringify(payload);
  const cmd = new Deno.Command("bash", {
    args: [HOOK_SCRIPT],
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

async function runAgy(payload: Record<string, unknown>): Promise<RunResult> {
  const matcherB64 = btoa(MATCHER);
  const input = JSON.stringify(payload);
  const cmd = new Deno.Command("bash", {
    args: [AGY_SHIM, "PreToolUse", matcherB64, HOOK_SCRIPT],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: {
      ...Deno.env.toObject(),
      AGY_HOOK_RECORD_PATH: "off",
    },
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

// --- Claude Code surface ---

Deno.test("Claude Code: bare issue citation in gh issue comment is DENIED with exit 2", async () => {
  const res = await runClaude({
    tool_name: "Bash",
    tool_input: {
      command: 'gh issue comment 123 --body "see wjt#45"',
    },
  });
  assertEquals(res.code, 2);
  assertStringIncludes(res.stderr, "BLOCKED (issue-citation guard)");
  assertStringIncludes(res.stderr, "- wjt#45");
});

Deno.test("Claude Code: full issue citation in gh issue comment is ALLOWED with exit 0", async () => {
  const res = await runClaude({
    tool_name: "Bash",
    tool_input: {
      command: "gh issue comment 123 --body 'see web-jam-tools#45 \"Real title here\"'",
    },
  });
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("Claude Code: bare citation in MCP issue_write is DENIED with exit 2", async () => {
  const res = await runClaude({
    tool_name: "mcp__github__issue_write",
    tool_input: {
      body: "referring to #45",
    },
  });
  assertEquals(res.code, 2);
  assertStringIncludes(res.stderr, "BLOCKED (issue-citation guard)");
  assertStringIncludes(res.stderr, "- #45");
});

Deno.test("Claude Code: full citation in MCP issue_write is ALLOWED with exit 0", async () => {
  const res = await runClaude({
    tool_name: "mcp__github__issue_write",
    tool_input: {
      body: 'referring to web-jam-tools#45 "Real title"',
    },
  });
  assertEquals(res.code, 0, res.stderr);
});

// --- agy surface, via the unmodified translation shim ---

Deno.test('agy: bare citation in run_command DENIED as {"decision":"deny","reason":"..."} with exit 0', async () => {
  const res = await runAgy({
    toolCall: {
      name: "run_command",
      args: {
        CommandLine: 'gh issue comment 123 --body "see wjt#45"',
      },
    },
  });
  assertEquals(res.code, 0, res.stderr);
  const verdict = JSON.parse(res.stdout.trim());
  assertEquals(verdict.decision, "deny");
  assertStringIncludes(verdict.reason, "BLOCKED (issue-citation guard)");
  assertStringIncludes(verdict.reason, "- wjt#45");
});

Deno.test("agy: full citation in run_command is ALLOWED with exit 0", async () => {
  const res = await runAgy({
    toolCall: {
      name: "run_command",
      args: {
        CommandLine: "gh issue comment 123 --body 'see web-jam-tools#45 \"Real title here\"'",
      },
    },
  });
  assertEquals(res.code, 0, res.stderr);
  const verdict = JSON.parse(res.stdout.trim());
  assertEquals(verdict.decision, "allow");
});

Deno.test('agy: bare citation in MCP issue_write DENIED as {"decision":"deny","reason":"..."} with exit 0', async () => {
  const res = await runAgy({
    toolCall: {
      name: "issue_write",
      args: {
        body: "bare #45 citation",
      },
    },
  });
  assertEquals(res.code, 0, res.stderr);
  const verdict = JSON.parse(res.stdout.trim());
  assertEquals(verdict.decision, "deny");
  assertStringIncludes(verdict.reason, "BLOCKED (issue-citation guard)");
  assertStringIncludes(verdict.reason, "- #45");
});

Deno.test("agy: full citation in MCP issue_write is ALLOWED with exit 0", async () => {
  const res = await runAgy({
    toolCall: {
      name: "issue_write",
      args: {
        body: 'web-jam-tools#45 "Real title" citation',
      },
    },
  });
  assertEquals(res.code, 0, res.stderr);
  const verdict = JSON.parse(res.stdout.trim());
  assertEquals(verdict.decision, "allow");
});
