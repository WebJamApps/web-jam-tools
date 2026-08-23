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

// --- web-jam-tools#714: repo deno.json parse failures must NOT deadlock this guard ---
//
// Every PR bumps the `version` line in deno.json, so a rebase conflict on
// exactly that line is routine, not an edge case. Before the fix, this
// hook's own `deno run` resolved the nearest deno.json from the working
// directory; when that file held conflict markers (or any unparseable
// JSON), deno exited before running the lib at all, the guard's result was
// empty, and it failed CLOSED — blocking every Bash call, including the
// shell commands that are the only way to resolve the conflict. The fix
// passes `--no-config` so this hook's own deno invocation never depends on
// the repo's deno.json.
//
// This test replaces the old "when evaluator fails ... " test above, which
// asserted the OLD (deadlocking) behavior for exactly this failure mode —
// that assertion is now wrong on purpose: a repo-config parse error must no
// longer be fatal to this guard.
Deno.test("web-jam-tools#714: deno.json holding conflict markers does not deadlock the guard — an ordinary command still evaluates and passes through", async () => {
  const denoJsonPath = new URL("../deno.json", import.meta.url).pathname;
  const backupPath = denoJsonPath + ".t714-backup";

  try {
    await Deno.copyFile(denoJsonPath, backupPath);
    // Simulate a rebase conflict landing on the version line — the exact
    // shape described in the issue's "How to test locally" repro.
    await Deno.writeTextFile(denoJsonPath, "<<<<<<< HEAD\n", { append: true });

    const res = await runHook({ command: "git status" });

    // An ordinary, non-irreversible command must pass through cleanly —
    // NOT be refused with "guard could not evaluate the command".
    assertEquals(
      res.code,
      0,
      `expected the guard to still evaluate with a broken deno.json, got exit ${res.code}, stderr: ${res.stderr}`,
    );
    assertEquals(
      res.stderr.includes("guard could not evaluate"),
      false,
      `guard must not fail closed on a repo-config parse error, got: ${res.stderr}`,
    );
  } finally {
    await Deno.copyFile(backupPath, denoJsonPath);
    await Deno.remove(backupPath);
  }
});

Deno.test("web-jam-tools#714: an irreversible command is still blocked while deno.json holds conflict markers", async () => {
  const denoJsonPath = new URL("../deno.json", import.meta.url).pathname;
  const backupPath = denoJsonPath + ".t714-backup2";

  try {
    await Deno.copyFile(denoJsonPath, backupPath);
    await Deno.writeTextFile(denoJsonPath, "<<<<<<< HEAD\n", { append: true });

    const res = await runHook({ command: "gh repo delete owner/repo" });

    assertEquals(
      res.code,
      2,
      `expected the real deny-list match to still block, got: ${res.stderr}`,
    );
    assertEquals(res.stderr.includes("BLOCKED (irreversible operation guard)"), true);
  } finally {
    await Deno.copyFile(backupPath, denoJsonPath);
    await Deno.remove(backupPath);
  }
});

// --- genuine evaluation failures (NOT a repo-config parse error) must still fail closed ---

Deno.test("when deno itself is unavailable, the guard still fails CLOSED", async () => {
  // Prepend a directory with a failing dummy `deno` command to PATH so the
  // guard's `deno run` fails closed even while preserving the rest of PATH
  // (bash, jq, mktemp, cat) across different OS/CI environments.
  const shadowDir = await Deno.makeTempDir({ prefix: "shadow-deno-" });
  try {
    const fakeDeno = `${shadowDir}/deno`;
    await Deno.writeTextFile(
      fakeDeno,
      '#!/bin/sh\necho "deno: command not found" >&2\nexit 127\n',
    );
    await Deno.chmod(fakeDeno, 0o755);

    const input = JSON.stringify({ tool_input: { command: "git status" } });
    const process = new Deno.Command("bash", {
      args: [HOOK_PATH],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: { PATH: `${shadowDir}:${Deno.env.get("PATH") ?? ""}` },
    });
    const child = process.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
    const output = await child.output();
    const stderr = new TextDecoder().decode(output.stderr).trim();

    assertEquals(output.code, 2, `expected fail-closed when deno is missing, stderr: ${stderr}`);
    assertEquals(stderr.includes("guard could not evaluate"), true, stderr);
  } finally {
    await Deno.remove(shadowDir, { recursive: true });
  }
});
