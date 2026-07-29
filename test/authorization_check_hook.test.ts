// authorization_check_hook.test.ts — web-jam-tools#285
//
// hooks/authorization-check.sh had NO behaviour test before #285. It is a
// non-blocking reminder hook: it never exits non-zero, it either emits a
// PreToolUse additionalContext JSON (when the command changes external
// state) or emits nothing (when it doesn't). Exercised the same way as the
// other hooks — shelling out to it (Deno.Command) with mocked PreToolUse
// JSON on stdin, the same shape Claude Code's hook runner feeds it.

import { assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/authorization-check.sh",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stdout: string;
}

async function runHook(command: string): Promise<RunResult> {
  const input = JSON.stringify({ tool_input: { command } });
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
  const { code, stdout } = await child.output();
  return { code, stdout: new TextDecoder().decode(stdout) };
}

function assertFires(stdout: string) {
  assertStringIncludes(stdout, "AUTHORIZATION CHECK");
  assertStringIncludes(stdout, "no-unauthorized-token-spend");
}

// --- fires: state-changing / outward-facing commands ---

Deno.test("gh issue create fires the authorization reminder", async () => {
  const res = await runHook(`gh issue create --title T --body B --label Sonnet`);
  assertEquals(res.code, 0);
  assertFires(res.stdout);
});

Deno.test("git push fires the authorization reminder", async () => {
  const res = await runHook("git push origin claude/285-hook-behaviour-tests");
  assertEquals(res.code, 0);
  assertFires(res.stdout);
});

Deno.test("gh api -X POST fires the authorization reminder", async () => {
  const res = await runHook("gh api -X POST repos/o/r/issues -f title=x");
  assertEquals(res.code, 0);
  assertFires(res.stdout);
});

Deno.test("heroku config:set fires the authorization reminder", async () => {
  const res = await runHook("heroku config:set FOO=bar --app web-jam-back");
  assertEquals(res.code, 0);
  assertFires(res.stdout);
});

Deno.test("gh pr ready fires the authorization reminder", async () => {
  const res = await runHook("gh pr ready 291");
  assertEquals(res.code, 0);
  assertFires(res.stdout);
});

Deno.test("gh pr merge fires the authorization reminder", async () => {
  const res = await runHook("gh pr merge 291 --squash");
  assertEquals(res.code, 0);
  assertFires(res.stdout);
});

// --- passes through: read-only / unrelated commands emit nothing ---

Deno.test("gh issue list passes through silently", async () => {
  const res = await runHook("gh issue list");
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "");
});

Deno.test("gh pr view passes through silently", async () => {
  const res = await runHook("gh pr view 291");
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "");
});

Deno.test("an ordinary command passes through silently", async () => {
  const res = await runHook("ls -la src/");
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "");
});

Deno.test("gh api GET passes through silently (read-only method)", async () => {
  const res = await runHook("gh api repos/o/r/issues");
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "");
});
