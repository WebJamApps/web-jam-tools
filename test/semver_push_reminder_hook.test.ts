// semver_push_reminder_hook.test.ts — web-jam-tools#285
//
// hooks/semver-push-reminder.sh had NO behaviour test before #285. It is a
// non-blocking reminder hook: it never exits non-zero, it either emits a
// PreToolUse additionalContext JSON (when the command is a `git push`) or
// emits nothing. Exercised the same way as the other hooks — shelling out to
// it (Deno.Command) with mocked PreToolUse JSON on stdin.

import { assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/semver-push-reminder.sh",
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

// --- fires: git push commands ---

Deno.test("git push fires the semver reminder", async () => {
  const res = await runHook("git push origin claude/285-hook-behaviour-tests");
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "SEMVER REMINDER");
  assertStringIncludes(res.stdout, "git-feature-branch-and-semver");
});

Deno.test("git push -u origin HEAD fires the semver reminder", async () => {
  const res = await runHook("git push -u origin HEAD");
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "SEMVER REMINDER");
});

// --- passes through: anything that isn't a git push ---

Deno.test("gh pr create passes through silently", async () => {
  const res = await runHook("gh pr create --title T --body B");
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "");
});

Deno.test("an ordinary command passes through silently", async () => {
  const res = await runHook("ls -la src/");
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "");
});

Deno.test("git pull passes through silently (not a push)", async () => {
  const res = await runHook("git pull origin dev");
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "");
});
