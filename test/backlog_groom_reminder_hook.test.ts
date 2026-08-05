// backlog_groom_reminder_hook.test.ts

import { assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/backlog-groom-reminder.sh",
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
  fn: (reportPath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(`${dir}/backlog-groom-report.md`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("missing report file emits missing reminder and exits 0", async () => {
  await withSandbox(async (reportPath) => {
    const res = await runHook({
      BACKLOG_GROOM_PATH: reportPath,
    });
    assertEquals(res.code, 0);
    assertStringIncludes(
      res.stdout,
      "Backlog groom report has never been generated on this machine — run /backlog-groom.",
    );
    const parsed = JSON.parse(res.stdout);
    assertEquals(
      parsed.systemMessage,
      "Backlog groom report has never been generated on this machine — run /backlog-groom.",
    );
  });
});

Deno.test("fresh report file (< 7 days old) exits 0 silently", async () => {
  await withSandbox(async (reportPath) => {
    await Deno.writeTextFile(reportPath, "# Backlog Groom Report\n");
    const oneDayAgoSec = Math.floor(Date.now() / 1000) - 1 * 86400;
    await Deno.utime(reportPath, oneDayAgoSec, oneDayAgoSec);

    const res = await runHook({
      BACKLOG_GROOM_PATH: reportPath,
    });
    assertEquals(res.code, 0);
    assertEquals(res.stdout, "");
  });
});

Deno.test("stale report file (>= 7 days old) emits stale age reminder", async () => {
  await withSandbox(async (reportPath) => {
    await Deno.writeTextFile(reportPath, "# Backlog Groom Report\n");
    const tenDaysAgoSec = Math.floor(Date.now() / 1000) - 10 * 86400;
    await Deno.utime(reportPath, tenDaysAgoSec, tenDaysAgoSec);

    const res = await runHook({
      BACKLOG_GROOM_PATH: reportPath,
    });
    assertEquals(res.code, 0);
    assertStringIncludes(
      res.stdout,
      "Backlog groom report is 10 days old — run /backlog-groom to refresh it.",
    );
    const parsed = JSON.parse(res.stdout);
    assertEquals(
      parsed.systemMessage,
      "Backlog groom report is 10 days old — run /backlog-groom to refresh it.",
    );
  });
});
