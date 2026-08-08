// backup_refusal_reminder_hook.test.ts — web-jam-tools#456
//
// Exercises hooks/backup-refusal-reminder.sh: emits a SessionStart systemMessage
// when SETTINGS_BACKUP_REFUSAL_FILE exists and contains refusal info, and emits
// nothing when absent or empty.

import { assert, assertEquals } from "@std/assert";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const HOOK_PATH = `${REPO_ROOT}hooks/backup-refusal-reminder.sh`;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runHook(refusalFilePath?: string): Promise<RunResult> {
  const env: Record<string, string> = { ...Deno.env.toObject() };
  if (refusalFilePath !== undefined) {
    env.SETTINGS_BACKUP_REFUSAL_FILE = refusalFilePath;
  }
  const cmd = new Deno.Command("bash", {
    args: [HOOK_PATH],
    env,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

Deno.test("backup-refusal-reminder.sh emits SessionStart systemMessage when refusal file exists", async () => {
  const dir = await Deno.makeTempDir();
  const refusalFile = `${dir}/settings-backup-refusal.txt`;
  await Deno.writeTextFile(
    refusalFile,
    "2026-08-08T10:55:02Z REFUSED settings.json backup: credential-shaped literal found in permissions",
  );

  const res = await runHook(refusalFile);
  assertEquals(res.code, 0, res.stderr);
  assert(res.stdout.includes("WARNING: Claude Code settings.json backup was REFUSED"), res.stdout);
  assert(res.stdout.includes("systemMessage"), res.stdout);

  const parsed = JSON.parse(res.stdout);
  assert(typeof parsed.systemMessage === "string");
  assert(parsed.systemMessage.includes("REFUSED settings.json backup"));
});

Deno.test("backup-refusal-reminder.sh emits nothing when refusal file is absent or empty", async () => {
  const dir = await Deno.makeTempDir();
  const refusalFile = `${dir}/does-not-exist.txt`;

  const res1 = await runHook(refusalFile);
  assertEquals(res1.code, 0, res1.stderr);
  assertEquals(res1.stdout, "");

  const emptyFile = `${dir}/empty.txt`;
  await Deno.writeTextFile(emptyFile, "");
  const res2 = await runHook(emptyFile);
  assertEquals(res2.code, 0, res2.stderr);
  assertEquals(res2.stdout, "");
});
