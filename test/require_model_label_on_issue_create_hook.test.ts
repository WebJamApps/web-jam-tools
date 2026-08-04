// require_model_label_on_issue_create_hook.test.ts — web-jam-tools#265
//
// Exercises hooks/require-model-label-on-issue-create.sh end-to-end by
// actually shelling out to it (Deno.Command) with mocked PreToolUse JSON on
// stdin, the same shape Claude Code's hook runner feeds it — same pattern as
// test/block_agy_non_flash_model_hook.test.ts (re-implementing the shell/
// python logic in TypeScript would test a copy, not the real guard).

import { assertEquals } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/require-model-label-on-issue-create.sh",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
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
  const { code, stderr } = await child.output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

function bashCall(command: string): Record<string, unknown> {
  return { tool_name: "Bash", tool_input: { command } };
}

function mcpIssueWrite(
  toolName: string,
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  return { tool_name: toolName, tool_input: toolInput };
}

function assertBlocked(stderr: string) {
  if (!stderr.includes("BLOCKED (model-label guard)")) {
    throw new Error(`expected BLOCKED message in stderr, got: ${stderr}`);
  }
}

// --- Bash surface: gh issue create ---

Deno.test("gh issue create with a single --label model label is allowed", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --label Sonnet`),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue create with multiple --label flags (one model label among them) is allowed", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --label Sonnet --label bug`),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue create with -l short flag carrying the model label is allowed", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B -l Sonnet -l bug`),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue create with a comma-separated --label value is allowed", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --label "Sonnet,bug"`),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue create with --label=value single-token form is allowed", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --label=Sonnet`),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue create with ZERO model labels is denied", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --label bug`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("gh issue create with a non-model label only (enhancement) is denied", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --label enhancement`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("gh issue create with no --label flag at all is denied", async () => {
  const res = await runHook(bashCall(`gh issue create --title T --body B`));
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("gh issue create with TWO model labels is denied", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --label Sonnet --label Opus`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("deny message lists the valid model labels", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --label bug`),
  );
  assertEquals(res.code, 2);
  for (const label of ["Haiku", "Sonnet", "Opus", "Fable", "Flash Med", "Flash High"]) {
    if (!res.stderr.includes(label)) {
      throw new Error(`expected deny message to list ${label}, got: ${res.stderr}`);
    }
  }
});

Deno.test("a --label flag with no value at all is denied (malformed, fail closed)", async () => {
  const res = await runHook(bashCall(`gh issue create --title T --body B --label`));
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("unparseable shell quoting on what looks like a gh issue create is denied (fail closed)", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title "unterminated --label Sonnet`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("unparseable shell quoting on an unrelated command passes through", async () => {
  const res = await runHook(bashCall(`echo "unterminated`));
  assertEquals(res.code, 0, res.stderr);
});

// --- Bash surface: non-issue-create commands pass through untouched ---

Deno.test("gh issue list (not create) passes through", async () => {
  const res = await runHook(bashCall(`gh issue list`));
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue edit --add-label (not create) passes through", async () => {
  const res = await runHook(bashCall(`gh issue edit 5 --add-label bug`));
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh pr create (not an issue) passes through even with no model label", async () => {
  const res = await runHook(bashCall(`gh pr create --title T --body B`));
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("a command with no gh reference at all passes through", async () => {
  const res = await runHook(bashCall(`ls -la src/`));
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue create chained after another command (&&) is still gated", async () => {
  const res = await runHook(
    bashCall(`echo hi && gh issue create --title T --body B --label bug`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- MCP surface: mcp__*__issue_write ---

Deno.test("MCP issue_write create with one model label in the array is allowed", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      title: "T",
      labels: ["Sonnet", "bug"],
    }),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("MCP issue_write create with a different server prefix is still gated (server-agnostic matcher)", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__github__issue_write", {
      method: "create",
      labels: ["bug"],
    }),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("MCP issue_write create with ZERO model labels is denied", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "create",
      labels: ["bug"],
    }),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("MCP issue_write create with no labels field at all is denied", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "create",
      title: "T",
    }),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("MCP issue_write create with TWO model labels is denied", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "create",
      labels: ["Sonnet", "Opus"],
    }),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("MCP issue_write with a non-array labels field is denied (unparseable, fail closed)", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "create",
      labels: "Sonnet",
    }),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("MCP issue_write update (not create) passes through even with no model label", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "update",
      issue_number: 5,
      labels: ["bug"],
    }),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("MCP issue_write with an unrecognized/missing method is denied (fail closed)", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      labels: ["Sonnet"],
    }),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("a non-issue_write MCP tool call passes through untouched", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__pull_request_read", {
      method: "get",
    }),
  );
  assertEquals(res.code, 0, res.stderr);
});

// --- Whole-payload unparseable input ---

Deno.test("invalid JSON on stdin passes through (nothing this hook can act on)", async () => {
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
  const { code, stderr } = await child.output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
});

// --- Executable Issue rule pointer phrase checks (web-jam-tools#342) ---

const ISSUE_342_FIXTURE_BODY = `Implement Issue #342 in /home/joshua/WebJamApps/web-jam-tools.

### Instructions:
1. Documentation Updates:
   - skills/draft-issue/SKILL.md: Update "Before you file" section.
2. Hook Enforcement Extension:
   - Inspect issue bodies for unresolvable pointer phrases: "see the comment", "see comment", "read the comment first", "read comment first", "as discussed above", "as discussed in", "per the discussion", "in the epic", "see the epic".
   - Strip code blocks/spans and quotes prior to scanning.`;

Deno.test("gh issue create with forbidden pointer phrase in body is denied", async () => {
  const res = await runHook(
    bashCall(
      `gh issue create --title T --body "Please see the comment for details" --label Sonnet`,
    ),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
  assertEquals(res.stderr.includes("see the comment"), true);
});

Deno.test("gh issue create with Issue #342 body fixture (quoted pointer phrases) is allowed", async () => {
  const res = await runHook(
    bashCall(
      `gh issue create --title T --body "${
        ISSUE_342_FIXTURE_BODY.replace(/"/g, '\\"')
      }" --label Sonnet`,
    ),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue create with pointer phrase inside code block/span or quotes is allowed", async () => {
  const res = await runHook(
    bashCall(
      `gh issue create --title T --body "Rule states \`read comment first\` is banned and \\"see the epic\\" is banned." --label Sonnet`,
    ),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue edit with forbidden pointer phrase in body is denied", async () => {
  const res = await runHook(
    bashCall(`gh issue edit 5 --body "Requirements are per the discussion"`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
  assertEquals(res.stderr.includes("per the discussion"), true);
});

Deno.test("gh issue edit on Epic issue type with forbidden pointer phrase in body is allowed (Epic exemption)", async () => {
  const res = await runHook(
    bashCall(
      `gh issue edit 5 --body "As discussed in the epic, see comment below" --type Epic`,
    ),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue edit without body argument passes through untouched", async () => {
  const res = await runHook(
    bashCall(`gh issue edit 5 --add-label bug`),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("MCP issue_write create with forbidden pointer phrase in body is denied", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "create",
      title: "T",
      body: "Please read the comment first.",
      labels: ["Sonnet"],
    }),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
  assertEquals(res.stderr.includes("read the comment first"), true);
});

Deno.test("MCP issue_write update with forbidden pointer phrase in body is denied", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "update",
      issue_number: 5,
      body: "Details are in the epic.",
    }),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
  assertEquals(res.stderr.includes("in the epic"), true);
});

Deno.test("MCP issue_write update on Epic issue type with forbidden pointer phrase in body is allowed (Epic exemption)", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "update",
      issue_number: 5,
      type: "Epic",
      body: "Details are in the epic, see the comment.",
    }),
  );
  assertEquals(res.code, 0, res.stderr);
});
