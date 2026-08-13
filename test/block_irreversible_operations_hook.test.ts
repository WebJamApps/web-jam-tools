// block_irreversible_operations_hook.test.ts — R-24 & R-25, web-jam-tools#524
//
// Exercises hooks/block-irreversible-operations.sh end-to-end by actually
// shelling out to it (Deno.Command) with mocked PreToolUse JSON on stdin —
// same pattern as test/block_agy_non_flash_model_hook.test.ts. Pure-logic
// coverage of the underlying Deno lib lives in
// test/check_irreversible_operations_lib.test.ts.

import { assertEquals } from "@std/assert";

const HOOK_PATH = new URL("../hooks/block-irreversible-operations.sh", import.meta.url).pathname;

async function runHook(
  payload: { tool_name?: string; command?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const input = JSON.stringify({
    tool_name: payload.tool_name,
    tool_input: payload.command ? { command: payload.command } : undefined,
  });
  const process = new Deno.Command("bash", {
    args: [HOOK_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = process.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();

  const output = await child.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
}

Deno.test("irreversible operations: all 17 operations blocked with exit 2 and runnable commands (R-24 & R-25)", async () => {
  const testCases = [
    { cmd: "gh repo delete owner/repo", desc: "gh repo delete" },
    { cmd: "gh label delete bug", desc: "gh label delete" },
    { cmd: "gh project delete 1", desc: "gh project delete" },
    { cmd: "gh project item-delete --id 1", desc: "gh project item-delete" },
    { cmd: "gh project field-delete --id 1", desc: "gh project field-delete" },
    { cmd: "heroku addons:destroy my-addon", desc: "heroku addons:destroy" },
    { tool: "mcp__claude_ai_GitHub_MCP__delete_file", desc: "GitHub MCP delete_file" },
    { cmd: "gh auth token", desc: "gh auth token" },
    { cmd: "gh issue delete 42", desc: "gh issue delete" },
    { cmd: "gh run delete 123", desc: "gh run delete" },
    { cmd: "gh repo sync owner/repo --force", desc: "gh repo sync --force" },
    { cmd: "gh issue transfer 42 dest/repo", desc: "gh issue transfer" },
    { cmd: "gh repo rename new-name", desc: "gh repo rename" },
    { cmd: "gh workflow run deploy.yml", desc: "gh workflow run" },
    { cmd: "gh pr merge 123", desc: "gh pr merge" },
    {
      tool: "mcp__claude_ai_GitHub_MCP__merge_pull_request",
      desc: "GitHub MCP merge_pull_request",
    },
    { cmd: "git push origin --delete feature-branch", desc: "remote branch deletion" },
  ];

  for (const tc of testCases) {
    const res = await runHook({ command: tc.cmd, tool_name: tc.tool });
    assertEquals(res.code, 2, `Expected exit 2 for ${tc.desc}`);
    assertEquals(
      res.stderr.includes("BLOCKED (irreversible operation guard)"),
      true,
      `Expected block output for ${tc.desc}`,
    );
    assertEquals(
      res.stderr.includes("separate terminal outside Claude Code"),
      true,
      `Expected runnable command instruction for ${tc.desc}`,
    );
  }
});

Deno.test("ordinary allowed commands pass through silently", async () => {
  const res = await runHook({ command: "git status" });
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "");
  assertEquals(res.stderr, "");
});

// --- the exact false-positive repro from web-jam-tools#524 ---
//
// The reported command was a `cat >> <file> <<'EOF' ... EOF` heredoc whose
// BODY contained the literal deny-list text `git push --delete*` as test
// data (asserting the pattern stays in the deny list), with no `git` command
// anywhere in the actual command being executed.

Deno.test("web-jam-tools#524 exact repro: a cat heredoc whose body contains 'git push --delete*' as test data is NOT blocked", async () => {
  const cmd = [
    `cat >> test/install_hooks_script.test.ts <<'EOF'`,
    `Deno.test("deny list still contains git push --delete*, git push -d and git push origin :branch", () => {`,
    `  assertStringIncludes(denyListSource, "git push --delete*");`,
    `  assertStringIncludes(denyListSource, "git push -d");`,
    `  assertStringIncludes(denyListSource, "git push origin :branch");`,
    `});`,
    `EOF`,
  ].join("\n");
  const res = await runHook({ command: cmd });
  assertEquals(
    res.code,
    0,
    `expected the heredoc write to pass through, got stderr: ${res.stderr}`,
  );
  assertEquals(res.stderr, "");
});

Deno.test("a real 'git push --delete' is still blocked even though the #524 repro above is not", async () => {
  const res = await runHook({ command: "git push --delete origin somebranch" });
  assertEquals(res.code, 2);
  assertEquals(res.stderr.includes("BLOCKED (irreversible operation guard)"), true);
});

// --- quoted string literal (no heredoc) ---

Deno.test("a quoted string literal mentioning 'git push --delete' is NOT blocked", async () => {
  const res = await runHook({ command: `echo "the deny list blocks git push --delete"` });
  assertEquals(res.code, 0, res.stderr);
});

// --- real deletion still blocked, including chained forms ---

Deno.test("real 'git push -d' is blocked", async () => {
  const res = await runHook({ command: "git push -d origin somebranch" });
  assertEquals(res.code, 2);
});

Deno.test("real 'git push origin :branch' (empty-source refspec) is blocked", async () => {
  const res = await runHook({ command: "git push origin :somebranch" });
  assertEquals(res.code, 2);
});

Deno.test("real deletion chained behind && is blocked", async () => {
  const res = await runHook({ command: "git fetch && git push origin --delete somebranch" });
  assertEquals(res.code, 2);
});

Deno.test("real deletion chained behind || is blocked", async () => {
  const res = await runHook({ command: "false || git push origin -d somebranch" });
  assertEquals(res.code, 2);
});

Deno.test("real deletion chained behind ; is blocked", async () => {
  const res = await runHook({ command: "echo hi; git push origin :somebranch" });
  assertEquals(res.code, 2);
});

Deno.test("real deletion chained behind a pipe is blocked", async () => {
  const res = await runHook({ command: "echo hi | cat; git push origin --delete somebranch" });
  assertEquals(res.code, 2);
});

// --- narrowed colon-refspec branch ---

Deno.test("'git push origin HEAD:main' (an ordinary push, not a deletion) is NOT blocked", async () => {
  const res = await runHook({ command: "git push origin HEAD:main" });
  assertEquals(res.code, 0, res.stderr);
});

// --- fail closed ---

Deno.test("an unterminated quote fails CLOSED (blocked)", async () => {
  const res = await runHook({ command: `git push origin 'unterminated` });
  assertEquals(res.code, 2);
  assertEquals(res.stderr.includes("BLOCKED (irreversible operation guard)"), true);
});
