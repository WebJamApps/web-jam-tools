// memory_cleanup_reminder_hook.test.ts

import { assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/memory-cleanup-reminder.sh",
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
  fn: (stampPath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(`${dir}/last-run.txt`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("stamp missing reminds with phrase 'never run'", async () => {
  await withSandbox(async (stampPath) => {
    const res = await runHook({
      MEMORY_CLEANUP_STAMP_PATH: stampPath,
    });
    assertEquals(res.code, 0);
    assertStringIncludes(res.stdout, "Weekly memory cleanup due (never run)");
    const parsed = JSON.parse(res.stdout);
    assertStringIncludes(parsed.systemMessage, "never run");
  });
});

Deno.test("stamp empty reminds with phrase 'never run'", async () => {
  await withSandbox(async (stampPath) => {
    await Deno.writeTextFile(stampPath, "");
    const res = await runHook({
      MEMORY_CLEANUP_STAMP_PATH: stampPath,
    });
    assertEquals(res.code, 0);
    assertStringIncludes(res.stdout, "Weekly memory cleanup due (never run)");
    const parsed = JSON.parse(res.stdout);
    assertStringIncludes(parsed.systemMessage, "never run");
  });
});

Deno.test("stamp corrupt reminds with phrase 'stamp unreadable: <contents>'", async () => {
  await withSandbox(async (stampPath) => {
    await Deno.writeTextFile(stampPath, "corrupted-date-12345");
    const res = await runHook({
      MEMORY_CLEANUP_STAMP_PATH: stampPath,
    });
    assertEquals(res.code, 0);
    assertStringIncludes(
      res.stdout,
      "Weekly memory cleanup due (stamp unreadable: corrupted-date-12345)",
    );
    const parsed = JSON.parse(res.stdout);
    assertStringIncludes(parsed.systemMessage, "stamp unreadable: corrupted-date-12345");
  });
});

Deno.test("stamp stale (>= 7 days old) reminds with phrase 'last run: <ISO date>, <N> days ago'", async () => {
  await withSandbox(async (stampPath) => {
    // 10 days ago
    const d = new Date(Date.now() - 10 * 86400 * 1000);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
      String(d.getDate()).padStart(2, "0")
    }`;
    await Deno.writeTextFile(stampPath, dateStr);

    const res = await runHook({
      MEMORY_CLEANUP_STAMP_PATH: stampPath,
    });
    assertEquals(res.code, 0);
    assertStringIncludes(res.stdout, `last run: ${dateStr}, 10 days ago`);
    const parsed = JSON.parse(res.stdout);
    assertStringIncludes(parsed.systemMessage, `last run: ${dateStr}, 10 days ago`);
  });
});

Deno.test("stamp fresh (< 7 days old) outputs nothing", async () => {
  await withSandbox(async (stampPath) => {
    // 1 day ago
    const d = new Date(Date.now() - 1 * 86400 * 1000);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
      String(d.getDate()).padStart(2, "0")
    }`;
    await Deno.writeTextFile(stampPath, dateStr);

    const res = await runHook({
      MEMORY_CLEANUP_STAMP_PATH: stampPath,
    });
    assertEquals(res.code, 0);
    assertEquals(res.stdout, "");
  });
});
