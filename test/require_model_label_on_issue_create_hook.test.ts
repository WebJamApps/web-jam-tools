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

Deno.test("gh issue create without native Type is denied", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --label Sonnet`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
  assertEquals(
    res.stderr.includes(
      "missing native issue type (--type/-t). Valid native types: Task, Bug, Feature, Epic.",
    ),
    true,
  );
});

Deno.test("gh issue create with invalid native Type is denied", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --label Sonnet --type InvalidType`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
  assertEquals(
    res.stderr.includes(
      "missing native issue type (--type/-t). Valid native types: Task, Bug, Feature, Epic.",
    ),
    true,
  );
});

Deno.test("gh issue create with a single --label model label and --type Task is allowed", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --label "Flash High" --type Task`),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue create with valid native types (Bug, Feature, Epic) is allowed", async () => {
  const resBug = await runHook(
    bashCall(`gh issue create --title T --body B --label "Flash High" -t Bug`),
  );
  assertEquals(resBug.code, 0, resBug.stderr);

  const resFeat = await runHook(
    bashCall(`gh issue create --title T --body B --label "Flash High" --type=Feature`),
  );
  assertEquals(resFeat.code, 0, resFeat.stderr);

  const resEpic = await runHook(
    bashCall(`gh issue create --title T --body B --label "Flash High" -t=Epic`),
  );
  assertEquals(resEpic.code, 0, resEpic.stderr);
});

Deno.test("gh issue create with multiple --label flags (one model label among them) is allowed", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --label "Flash High" --label bug --type Task`),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue create with -l short flag carrying the model label is allowed", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B -l "Flash High" -l bug -t Task`),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue create with a comma-separated --label value is allowed", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --label "Flash High,bug" --type Task`),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue create with --label=value single-token form is allowed", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --label="Flash High" --type Task`),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue create with only Josh label is allowed (Josh carve-out)", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --label Josh --type Task`),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue create with Josh and non-model labels (Josh, Blocked) is allowed (Josh carve-out)", async () => {
  const res = await runHook(
    bashCall(
      `gh issue create --title T --body B --label Josh --label Blocked --type Task`,
    ),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue create with ZERO model labels and no Josh label is still denied", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --label bug --type Task`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("gh issue create with a non-model label only (enhancement) is denied", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --label enhancement --type Task`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("gh issue create with no --label flag at all is denied", async () => {
  const res = await runHook(bashCall(`gh issue create --title T --body B --type Task`));
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("gh issue create with TWO model labels is denied", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --label Sonnet --label Opus --type Task`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("deny message lists the valid model labels", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --label bug --type Task`),
  );
  assertEquals(res.code, 2);
  for (const label of ["Haiku", "Sonnet", "Opus", "Fable", "Flash Med", "Flash High"]) {
    if (!res.stderr.includes(label)) {
      throw new Error(`expected deny message to list ${label}, got: ${res.stderr}`);
    }
  }
});

Deno.test("a --label flag with no value at all is denied (malformed, fail closed)", async () => {
  const res = await runHook(bashCall(`gh issue create --title T --body B --type Task --label`));
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("unparseable shell quoting on what looks like a gh issue create is denied (fail closed)", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title "unterminated --label Sonnet --type Task`),
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
    bashCall(`echo hi && gh issue create --title T --body B --label bug --type Task`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- web-jam-tools#788 review Must Fix #1: newline / bare-& segmentation ---

Deno.test("gh issue create chained after another command with a NEWLINE (not &&) is still gated", async () => {
  const res = await runHook(
    bashCall(`echo hi\ngh issue create --title T --body B --label bug --type Task`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("gh issue create chained after another command with a bare & (not &&) is still gated", async () => {
  const res = await runHook(
    bashCall(`echo hi & gh issue create --title T --body B --label bug --type Task`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- web-jam-tools#788 re-review regression in commit 3afdf03 ---

Deno.test("subshell-wrapped gh issue create ( ... ) is still gated (parens are segment boundaries)", async () => {
  const res = await runHook(
    bashCall(`( gh issue create --title T --body B --label bug --type Task )`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("brace-grouped gh issue create { ...; } is still gated (braces are segment boundaries)", async () => {
  const res = await runHook(
    bashCall(`{ gh issue create --title T --body B --label bug --type Task; }`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- MCP surface: mcp__*__issue_write ---

Deno.test("MCP issue_write create without native Type is denied", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      title: "T",
      labels: ["Sonnet", "bug"],
    }),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
  assertEquals(
    res.stderr.includes(
      "missing native issue type (--type/-t). Valid native types: Task, Bug, Feature, Epic.",
    ),
    true,
  );
});

Deno.test("MCP issue_write create with invalid native Type is denied", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      title: "T",
      type: "InvalidType",
      labels: ["Sonnet", "bug"],
    }),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
  assertEquals(
    res.stderr.includes(
      "missing native issue type (--type/-t). Valid native types: Task, Bug, Feature, Epic.",
    ),
    true,
  );
});

Deno.test("MCP issue_write create with one model label in the array and valid type is allowed", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      title: "T",
      type: "Task",
      labels: ["Flash High", "bug"],
    }),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("MCP issue_write create with only Josh label is allowed (Josh carve-out)", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      title: "T",
      type: "Task",
      labels: ["Josh"],
    }),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("MCP issue_write create with Josh and non-model labels is allowed (Josh carve-out)", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      title: "T",
      type: "Task",
      labels: ["Josh", "Blocked"],
    }),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("MCP issue_write create with a different server prefix is still gated (server-agnostic matcher)", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__github__issue_write", {
      method: "create",
      type: "Task",
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
      type: "Task",
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
      type: "Task",
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
      type: "Task",
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
      type: "Task",
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
   - skills/file-issue/SKILL.md: Update "Before you file" section.
2. Hook Enforcement Extension:
   - Inspect issue bodies for unresolvable pointer phrases: "see the comment", "see comment", "read the comment first", "read comment first", "as discussed above", "as discussed in", "per the discussion", "in the epic", "see the epic".
   - Strip code blocks/spans and quotes prior to scanning.`;

Deno.test("gh issue create with forbidden pointer phrase in body is denied", async () => {
  const res = await runHook(
    bashCall(
      `gh issue create --title T --body "Please see the comment for details" --label "Flash High" --type Task`,
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
      }" --label "Flash High" --type Task`,
    ),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue create with pointer phrase inside code block/span or quotes is allowed", async () => {
  const res = await runHook(
    bashCall(
      `gh issue create --title T --body "Rule states \`read comment first\` is banned and \\"see the epic\\" is banned." --label "Flash High" --type Task`,
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
      type: "Task",
      body: "Please read the comment first.",
      labels: ["Flash High"],
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

// --- Bash surface: create-issue.ts invocation forms (web-jam-tools#553) ---

// Form 1: deno task create-issue
Deno.test("deno task create-issue without native Type is denied", async () => {
  const res = await runHook(
    bashCall(`deno task create-issue --title T --body-file /tmp/b.md --label "Flash High"`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
  assertEquals(
    res.stderr.includes(
      "missing native issue type (--type/-t). Valid native types: Task, Bug, Feature, Epic.",
    ),
    true,
  );
});

Deno.test("deno task create-issue with invalid native Type is denied", async () => {
  const res = await runHook(
    bashCall(
      `deno task create-issue --title T --body-file /tmp/b.md --label "Flash High" --type UnknownType`,
    ),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
  assertEquals(
    res.stderr.includes(
      "missing native issue type (--type/-t). Valid native types: Task, Bug, Feature, Epic.",
    ),
    true,
  );
});

Deno.test("deno task create-issue with zero model labels is denied", async () => {
  const res = await runHook(
    bashCall(`deno task create-issue --title T --body-file /tmp/b.md --type Task --label bug`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("deno task create-issue with multiple model labels is denied", async () => {
  const res = await runHook(
    bashCall(
      `deno task create-issue --title T --body-file /tmp/b.md --type Task --label "Flash High" --label Opus`,
    ),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("deno task create-issue with valid type and model label is allowed", async () => {
  const res1 = await runHook(
    bashCall(
      `deno task create-issue --title T --body-file /tmp/b.md --type Task --label "Flash High"`,
    ),
  );
  assertEquals(res1.code, 0, res1.stderr);

  const res2 = await runHook(
    bashCall(`deno task create-issue --title T --body-file /tmp/b.md -t Epic --label "Flash Med"`),
  );
  assertEquals(res2.code, 0, res2.stderr);

  const res3 = await runHook(
    bashCall(`deno task issue:create --title T --body-file /tmp/b.md --type=Bug --label=Haiku`),
  );
  assertEquals(res3.code, 0, res3.stderr);
});

// Form 2: deno run ... scripts/create-issue.ts
Deno.test("deno run scripts/create-issue.ts without native Type is denied", async () => {
  const res = await runHook(
    bashCall(
      `deno run --allow-all scripts/create-issue.ts --title T --body-file /tmp/b.md --label Sonnet`,
    ),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
  assertEquals(
    res.stderr.includes(
      "missing native issue type (--type/-t). Valid native types: Task, Bug, Feature, Epic.",
    ),
    true,
  );
});

Deno.test("deno run scripts/create-issue.ts with invalid native Type is denied", async () => {
  const res = await runHook(
    bashCall(
      `deno run --allow-env --allow-run scripts/create-issue.ts --title T --body-file /tmp/b.md --label Sonnet --type Bad`,
    ),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("deno run scripts/create-issue.ts with zero/multiple model labels is denied", async () => {
  const resZero = await runHook(
    bashCall(
      `deno run --allow-all scripts/create-issue.ts --title T --body-file /tmp/b.md --type Task`,
    ),
  );
  assertEquals(resZero.code, 2);
  assertBlocked(resZero.stderr);

  const resMulti = await runHook(
    bashCall(
      `deno run --allow-all scripts/create-issue.ts --title T --body-file /tmp/b.md --type Task --label Sonnet,Haiku`,
    ),
  );
  assertEquals(resMulti.code, 2);
  assertBlocked(resMulti.stderr);
});

Deno.test("deno run scripts/create-issue.ts with valid type and model label is allowed", async () => {
  const res = await runHook(
    bashCall(
      `deno run --allow-env --allow-run --allow-read --allow-write scripts/create-issue.ts --title T --body-file /tmp/b.md --type Feature --label Haiku`,
    ),
  );
  assertEquals(res.code, 0, res.stderr);
});

// Form 3: direct scripts/create-issue.ts and ./scripts/create-issue.ts
Deno.test("direct scripts/create-issue.ts without native Type is denied", async () => {
  const res = await runHook(
    bashCall(`scripts/create-issue.ts --title T --body-file /tmp/b.md --label Opus`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
  assertEquals(
    res.stderr.includes(
      "missing native issue type (--type/-t). Valid native types: Task, Bug, Feature, Epic.",
    ),
    true,
  );
});

Deno.test("direct ./scripts/create-issue.ts with invalid Type is denied", async () => {
  const res = await runHook(
    bashCall(`./scripts/create-issue.ts --title T --body-file /tmp/b.md --label Opus -t Invalid`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("direct scripts/create-issue.ts with zero/multiple model labels is denied", async () => {
  const resZero = await runHook(
    bashCall(`scripts/create-issue.ts --title T --body-file /tmp/b.md --type Task --label custom`),
  );
  assertEquals(resZero.code, 2);
  assertBlocked(resZero.stderr);

  const resMulti = await runHook(
    bashCall(
      `scripts/create-issue.ts --title T --body-file /tmp/b.md --type Task --label Opus --label "Flash Med"`,
    ),
  );
  assertEquals(resMulti.code, 2);
  assertBlocked(resMulti.stderr);
});

Deno.test("direct scripts/create-issue.ts with valid type and model label is allowed", async () => {
  const res1 = await runHook(
    bashCall(
      `scripts/create-issue.ts --title T --body-file /tmp/b.md --type Task --label "Flash High"`,
    ),
  );
  assertEquals(res1.code, 0, res1.stderr);

  const res2 = await runHook(
    bashCall(`./scripts/create-issue.ts --title T --body-file /tmp/b.md -t Epic --label Josh`),
  );
  assertEquals(res2.code, 0, res2.stderr);
});

// --- Escalation Justification Rule (web-jam-tools#709) ---

Deno.test("gh issue create with Sonnet and no escalation reason is denied with helpful escalation prompt", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --type Task --label Sonnet`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
  assertEquals(
    res.stderr.includes(
      "Creating an issue labeled 'Sonnet' requires an explicit escalation justification.",
    ),
    true,
  );
  assertEquals(
    res.stderr.includes(
      "Flash High is the default model tier for implementation work and bills a separate Google budget, whereas Sonnet bills the constrained Anthropic budget.",
    ),
    true,
  );
  assertEquals(
    res.stderr.includes(
      'gh issue create --title T --body B --type Task --label Sonnet --escalation-reason "<why Sonnet is genuinely the right tier>"',
    ),
    true,
  );
});

Deno.test("gh issue create with Opus and no escalation reason is denied with helpful escalation prompt", async () => {
  const res = await runHook(
    bashCall(`gh issue create --title T --body B --type Task --label Opus`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
  assertEquals(
    res.stderr.includes(
      "Creating an issue labeled 'Opus' requires an explicit escalation justification.",
    ),
    true,
  );
  assertEquals(
    res.stderr.includes(
      "Flash High is the default model tier for implementation work and bills a separate Google budget, whereas Opus bills the constrained Anthropic budget.",
    ),
    true,
  );
  assertEquals(
    res.stderr.includes(
      'gh issue create --title T --body B --type Task --label Opus --escalation-reason "<why Opus is genuinely the right tier>"',
    ),
    true,
  );
});

Deno.test("gh issue create with Sonnet and non-empty --escalation-reason is allowed", async () => {
  const res = await runHook(
    bashCall(
      `gh issue create --title T --body B --type Task --label Sonnet --escalation-reason "complex multi-file refactoring"`,
    ),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue create with Opus and non-empty --escalation-reason is allowed", async () => {
  const res = await runHook(
    bashCall(
      `gh issue create --title T --body B --type Task --label Opus --escalation-reason "architectural spec and tech-lead judgment"`,
    ),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue create with Sonnet and --escalation-reason=value single-token form is allowed", async () => {
  const res = await runHook(
    bashCall(
      `gh issue create --title T --body B --type Task --label Sonnet --escalation-reason="complex backend rewrite"`,
    ),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue create with Sonnet and empty --escalation-reason is denied", async () => {
  const resEmpty = await runHook(
    bashCall(
      `gh issue create --title T --body B --type Task --label Sonnet --escalation-reason ""`,
    ),
  );
  assertEquals(resEmpty.code, 2);
  assertBlocked(resEmpty.stderr);

  const resWhitespace = await runHook(
    bashCall(
      `gh issue create --title T --body B --type Task --label Sonnet --escalation-reason "   "`,
    ),
  );
  assertEquals(resWhitespace.code, 2);
  assertBlocked(resWhitespace.stderr);
});

Deno.test("gh issue create with Flash High / Flash Med / Haiku requires no escalation reason", async () => {
  const resFH = await runHook(
    bashCall(`gh issue create --title T --body B --type Task --label "Flash High"`),
  );
  assertEquals(resFH.code, 0, resFH.stderr);

  const resFM = await runHook(
    bashCall(`gh issue create --title T --body B --type Task --label "Flash Med"`),
  );
  assertEquals(resFM.code, 0, resFM.stderr);

  const resHaiku = await runHook(
    bashCall(`gh issue create --title T --body B --type Task --label Haiku`),
  );
  assertEquals(resHaiku.code, 0, resHaiku.stderr);
});

Deno.test("MCP issue_write create with Sonnet and no escalation reason is denied", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      title: "T",
      type: "Task",
      labels: ["Sonnet"],
    }),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
  assertEquals(
    res.stderr.includes(
      "Creating an issue labeled 'Sonnet' requires an explicit escalation justification.",
    ),
    true,
  );
  assertEquals(
    res.stderr.includes("supply an 'escalation_reason' property"),
    true,
  );
});

Deno.test("MCP issue_write create with Opus and no escalation reason is denied", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      title: "T",
      type: "Task",
      labels: ["Opus"],
    }),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
  assertEquals(
    res.stderr.includes(
      "Creating an issue labeled 'Opus' requires an explicit escalation justification.",
    ),
    true,
  );
});

Deno.test("MCP issue_write create with Sonnet and escalation_reason is allowed", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      title: "T",
      type: "Task",
      labels: ["Sonnet"],
      escalation_reason: "major multi-file refactor across repos",
    }),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("MCP issue_write create with Opus and escalation_reason is allowed", async () => {
  const res = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      title: "T",
      type: "Task",
      labels: ["Opus"],
      escalation_reason: "architectural design and requirements alignment",
    }),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("MCP issue_write create with Flash High / Haiku requires no escalation reason", async () => {
  const resFH = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      title: "T",
      type: "Task",
      labels: ["Flash High"],
    }),
  );
  assertEquals(resFH.code, 0, resFH.stderr);

  const resHaiku = await runHook(
    mcpIssueWrite("mcp__claude_ai_GitHub_MCP__issue_write", {
      method: "create",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      title: "T",
      type: "Task",
      labels: ["Haiku"],
    }),
  );
  assertEquals(resHaiku.code, 0, resHaiku.stderr);
});

Deno.test("deno task create-issue with Sonnet and no escalation reason is denied", async () => {
  const res = await runHook(
    bashCall(`deno task create-issue --title T --body-file /tmp/b.md --type Task --label Sonnet`),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("deno task create-issue with Sonnet and --escalation-reason is allowed", async () => {
  const res = await runHook(
    bashCall(
      `deno task create-issue --title T --body-file /tmp/b.md --type Task --label Sonnet --escalation-reason "complex refactor"`,
    ),
  );
  assertEquals(res.code, 0, res.stderr);
});

// --- web-jam-tools#788 third review: the unterminated-quote fallback must
// recognise every create form the parseable scan recognises ---

Deno.test("unterminated-quote 'deno task issue:create' is blocked (task name carries no gh token)", async () => {
  const res = await runHook(
    bashCall(`deno task issue:create --title 'unterminated`),
  );
  // The fallback's first alternative requires a `gh` token, which
  // `issue:create` does not have — without its own alternative this command
  // passed silently even though the balanced-quote form is gated.
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("deno task create-issue with Opus and --escalation-reason is allowed", async () => {
  const res = await runHook(
    bashCall(
      `deno task create-issue --title T --body-file /tmp/b.md -t Epic --label Opus --escalation-reason "architectural spec"`,
    ),
  );
  assertEquals(res.code, 0, res.stderr);
});

// --- web-jam-tools#813: the ambiguous-parse branch retries with heredoc
// bodies stripped before falling back to the blunt whole-string test, so a
// heredoc body redirected into a file (data, not code) no longer trips the
// guard just because its prose mentions issue tooling. Every heredoc body
// below deliberately carries exactly one unescaped apostrophe so the raw
// command is genuinely ambiguous (unterminated quote) before the fix even
// gets a chance to run — a heredoc with no such apostrophe stays on the
// already-parseable fast path this issue is a Non-goal to touch.

Deno.test("web-jam-tools#813: heredoc body redirected to a file mentioning 'gh issue create' passes (data, not code)", async () => {
  const res = await runHook(
    bashCall(
      `cat > /tmp/design-notes.md <<'EOF'\n` +
        `This document explains why gh issue create shouldn't run unless approved.\n` +
        `EOF`,
    ),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("web-jam-tools#813: heredoc body redirected via 'tee' mentioning 'create-issue' passes (data, not code)", async () => {
  const res = await runHook(
    bashCall(
      `tee /tmp/design-notes.md <<"EOF"\n` +
        `This reviews the create-issue script's own doc — nothing here isn't already explained.\n` +
        `EOF`,
    ),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("web-jam-tools#813: heredoc body appended via '>>' mentioning 'gh issue edit' passes (data, not code)", async () => {
  const res = await runHook(
    bashCall(
      `cat >> /tmp/design-notes.md <<-EOF\n` +
        `A note on why gh issue edit shouldn't be run here either.\n` +
        `\tEOF`,
    ),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("web-jam-tools#813: unquoted <<EOF heredoc body mentioning 'gh issue create' passes (data, not code)", async () => {
  const res = await runHook(
    bashCall(
      `cat > /tmp/design-notes.md <<EOF\n` +
        `Explains why gh issue create isn't run from this file.\n` +
        `EOF`,
    ),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("web-jam-tools#813: multiple data heredocs in one command are each classified independently", async () => {
  const res = await runHook(
    bashCall(
      `cat > /tmp/a.md <<'EOF1'\n` +
        `First note mentions gh issue create for context.\n` +
        `EOF1\n` +
        `cat > /tmp/b.md <<'EOF2'\n` +
        `Second note explains why it wasn't run.\n` +
        `EOF2`,
    ),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("web-jam-tools#813: an unterminated heredoc (no closing delimiter) fails closed without crashing", async () => {
  const res = await runHook(
    bashCall(
      `cat > /tmp/c.md <<'EOF'\n` +
        `Notes about gh issue create that don't get closed.`,
    ),
  );
  // No matching closing delimiter — stripHeredocs() conservatively keeps
  // the body in scope rather than discarding it, so the ambiguous parse
  // remains ambiguous and the blunt fallback still sees the mention. The
  // defined, tested fallback is "fail closed, don't crash" — not "pass".
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("web-jam-tools#813: a delimiter word appearing mid-body does not end the heredoc early", async () => {
  const res = await runHook(
    bashCall(
      `cat > /tmp/d.md <<'EOF'\n` +
        `The word EOF appears in this sentence but doesn't end anything here.\n` +
        `A real gh issue create mention happens down here too, still data.\n` +
        `EOF`,
    ),
  );
  // If "EOF" mid-sentence were mistaken for the closing line, everything
  // after it (including the apostrophe and the gh mention) would spill out
  // as ordinary command text instead of being dropped as heredoc data.
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("web-jam-tools#813: a heredoc piped to an interpreter is executed code and stays gated", async () => {
  const res = await runHook(
    bashCall(
      `bash <<'EOF'\n` +
        `gh issue create --title "Nobody's title" --body B --type Task\n` +
        `EOF`,
    ),
  );
  // Unlike a file-redirected heredoc, this body genuinely executes — it
  // must stay in scope for the scan, not be treated as data.
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("web-jam-tools#813: a data heredoc mention and a real gh issue create in the same command are decided independently (valid outer call passes)", async () => {
  const res = await runHook(
    bashCall(
      `cat > /tmp/notes.md <<'EOF1'\n` +
        `This documents why gh issue create shouldn't be used carelessly.\n` +
        `EOF1\n` +
        `gh issue create --title T --body B --type Task --label Haiku`,
    ),
  );
  // The data body's mention is excluded; the real, valid, outside-heredoc
  // call is still scanned and passes on its own merits.
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("web-jam-tools#813: a data heredoc mention and a real, invalid gh issue create in the same command are decided independently (invalid outer call still denied)", async () => {
  const res = await runHook(
    bashCall(
      `cat > /tmp/notes.md <<'EOF1'\n` +
        `This documents why gh issue create shouldn't be used carelessly.\n` +
        `EOF1\n` +
        `gh issue create --title T --body B --label Haiku`,
    ),
  );
  // Same data body as above, but this time the real outer call is missing
  // --type — it must still be denied for its OWN reason, proving the fix
  // doesn't just blanket-pass once a data heredoc is seen.
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
  assertEquals(
    res.stderr.includes("missing native issue type"),
    true,
  );
});

// --- web-jam-tools#813 Must Fix #1: INTERPRETER must recognize a
// path-qualified or `source`/`.` spelling of an interpreter, not just the
// bare word — otherwise the ambiguous-parse retry's stripHeredocs() call
// misclassifies these forms as a data (file-redirected) heredoc, strips the
// body, and a real `gh issue create` inside it never gets scanned. Every
// body below carries exactly one unescaped apostrophe (matching the
// convention above) so the raw command is genuinely ambiguous before the
// fix gets a chance to run.

Deno.test("web-jam-tools#813: a heredoc piped to a path-qualified interpreter (/bin/bash) is executed code and stays gated", async () => {
  const res = await runHook(
    bashCall(
      `cat <<'EOF' | /bin/bash\n` +
        `This heredoc contains a gh issue create call, and it shouldn't slip past.\n` +
        `EOF`,
    ),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("web-jam-tools#813: a heredoc fed directly to a path-qualified interpreter (/bin/sh) is executed code and stays gated", async () => {
  const res = await runHook(
    bashCall(
      `/bin/sh <<'EOF'\n` +
        `This heredoc contains a gh issue create call, and it shouldn't slip past.\n` +
        `EOF`,
    ),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("web-jam-tools#813: a heredoc fed to 'source /dev/stdin' is executed code and stays gated", async () => {
  const res = await runHook(
    bashCall(
      `source /dev/stdin <<'EOF'\n` +
        `This heredoc contains a gh issue create call, and it shouldn't slip past.\n` +
        `EOF`,
    ),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("web-jam-tools#813: a heredoc fed to '. /dev/stdin' (dot form of source) is executed code and stays gated", async () => {
  const res = await runHook(
    bashCall(
      `. /dev/stdin <<'EOF'\n` +
        `This heredoc contains a gh issue create call, and it shouldn't slip past.\n` +
        `EOF`,
    ),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});
