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

Deno.test("irreversible operation: gh pr merge is blocked with runnable command (R-24 & R-25)", async () => {
  const res = await runHook({ command: "gh pr merge 123" });
  assertEquals(res.code, 2);
  assertEquals(res.stderr.includes("BLOCKED (irreversible operation guard)"), true);
  assertEquals(res.stderr.includes("separate terminal outside Claude Code"), true);
  assertEquals(res.stderr.includes("gh pr merge 123"), true);
});

Deno.test("irreversible operation: GitHub MCP delete_file is blocked with runnable command", async () => {
  const res = await runHook({ tool_name: "mcp__claude_ai_GitHub_MCP__delete_file" });
  assertEquals(res.code, 2);
  assertEquals(res.stderr.includes("BLOCKED (irreversible operation guard)"), true);
  assertEquals(res.stderr.includes("separate terminal outside Claude Code"), true);
});

Deno.test("irreversible operation: heroku addons:destroy is blocked", async () => {
  const res = await runHook({ command: "heroku addons:destroy my-addon" });
  assertEquals(res.code, 2);
  assertEquals(res.stderr.includes("BLOCKED (irreversible operation guard)"), true);
});

Deno.test("irreversible operation: remote branch deletion via git push is blocked", async () => {
  const res = await runHook({ command: "git push origin --delete feature-branch" });
  assertEquals(res.code, 2);
  assertEquals(res.stderr.includes("BLOCKED (irreversible operation guard)"), true);
});

Deno.test("ordinary allowed commands pass through silently", async () => {
  const res = await runHook({ command: "git status" });
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "");
  assertEquals(res.stderr, "");
});
