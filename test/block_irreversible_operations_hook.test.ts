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
