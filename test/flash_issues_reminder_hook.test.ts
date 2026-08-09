// flash_issues_reminder_hook.test.ts

import { assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/flash-issues-reminder.sh",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stdout: string;
}

async function runHook(env: Record<string, string>): Promise<RunResult> {
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env,
  });
  const child = cmd.spawn();
  await child.stdin.close();
  const { code, stdout } = await child.output();
  return { code, stdout: new TextDecoder().decode(stdout) };
}

async function withSandbox(
  fn: (worklistPath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(`${dir}/flash-issues.md`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("missing worklist file emits missing reminder and exits 0", async () => {
  await withSandbox(async (worklistPath) => {
    const res = await runHook({
      FLASH_ISSUES_PATH: worklistPath,
    });
    assertEquals(res.code, 0);
    assertStringIncludes(
      res.stdout,
      "Flash worklist has never been generated on this machine — run /flash-issues.",
    );
    const parsed = JSON.parse(res.stdout);
    assertEquals(
      parsed.systemMessage,
      "Flash worklist has never been generated on this machine — run /flash-issues.",
    );
  });
});

Deno.test("fresh worklist file (< 7 days old) exits 0 silently", async () => {
  await withSandbox(async (worklistPath) => {
    await Deno.writeTextFile(worklistPath, "# Flash Issues\n");
    const oneDayAgoSec = Math.floor(Date.now() / 1000) - 1 * 86400;
    await Deno.utime(worklistPath, oneDayAgoSec, oneDayAgoSec);

    const res = await runHook({
      FLASH_ISSUES_PATH: worklistPath,
    });
    assertEquals(res.code, 0);
    assertEquals(res.stdout, "");
  });
});

Deno.test("stale worklist file (>= 7 days old) emits stale age reminder", async () => {
  await withSandbox(async (worklistPath) => {
    await Deno.writeTextFile(worklistPath, "# Flash Issues\n");
    const tenDaysAgoSec = Math.floor(Date.now() / 1000) - 10 * 86400;
    await Deno.utime(worklistPath, tenDaysAgoSec, tenDaysAgoSec);

    const res = await runHook({
      FLASH_ISSUES_PATH: worklistPath,
    });
    assertEquals(res.code, 0);
    assertStringIncludes(
      res.stdout,
      "Flash worklist is 10 days old — run /flash-issues to regenerate it.",
    );
    const parsed = JSON.parse(res.stdout);
    assertEquals(
      parsed.systemMessage,
      "Flash worklist is 10 days old — run /flash-issues to regenerate it.",
    );
  });
});
