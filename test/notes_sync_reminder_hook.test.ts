// notes_sync_reminder_hook.test.ts — web-jam-tools#285
//
// hooks/notes-sync-reminder.sh had NO behaviour test before #285. It is a
// SessionStart hook: it watches a cross-instance notes file (path overridable
// via CLAUDE_SYNC_NOTES_PATH) and a content-hash marker (dir overridable via
// CLAUDE_STATE_DIR), emitting a `systemMessage` SessionStart JSON only when
// the watched file's fingerprint has changed since the last recorded marker.
// Both env vars are used here to fully sandbox every run in temp dirs — the
// real ~/.claude/state and ~/Dropbox files are never touched.

import { assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/notes-sync-reminder.sh",
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
  // SessionStart feeds JSON on stdin; this hook never reads it, but close
  // stdin so the process doesn't hang waiting for input.
  await child.stdin.close();
  const { code, stdout } = await child.output();
  return { code, stdout: new TextDecoder().decode(stdout) };
}

async function withSandbox(
  fn: (notesPath: string, stateDir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(`${dir}/notes.md`, `${dir}/state`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// --- silent no-op: watched path doesn't exist ---

Deno.test("watched notes file missing is a silent no-op", async () => {
  await withSandbox(async (notesPath, stateDir) => {
    const res = await runHook({
      CLAUDE_SYNC_NOTES_PATH: notesPath,
      CLAUDE_STATE_DIR: stateDir,
    });
    assertEquals(res.code, 0);
    assertEquals(res.stdout, "");
  });
});

// --- fires: first time this hook has ever run against this file (no marker yet) ---

Deno.test("first run against an existing notes file fires the reminder and writes a marker", async () => {
  await withSandbox(async (notesPath, stateDir) => {
    await Deno.writeTextFile(notesPath, "some cross-instance learning\n");
    const res = await runHook({
      CLAUDE_SYNC_NOTES_PATH: notesPath,
      CLAUDE_STATE_DIR: stateDir,
    });
    assertEquals(res.code, 0);
    assertStringIncludes(res.stdout, "systemMessage");
    assertStringIncludes(res.stdout, notesPath);
    const marker = await Deno.readTextFile(`${stateDir}/notes-sync-marker.txt`);
    assertEquals(marker.length > 0, true);
  });
});

// --- passes through: unchanged content since the last recorded marker ---

Deno.test("second run with unchanged content is silent", async () => {
  await withSandbox(async (notesPath, stateDir) => {
    await Deno.writeTextFile(notesPath, "some cross-instance learning\n");
    const env = { CLAUDE_SYNC_NOTES_PATH: notesPath, CLAUDE_STATE_DIR: stateDir };
    const first = await runHook(env);
    assertEquals(first.code, 0);
    assertStringIncludes(first.stdout, "systemMessage");

    const second = await runHook(env);
    assertEquals(second.code, 0);
    assertEquals(second.stdout, "");
  });
});

// --- fires again: content changed since the last recorded marker ---

Deno.test("content change since the last marker fires the reminder again", async () => {
  await withSandbox(async (notesPath, stateDir) => {
    await Deno.writeTextFile(notesPath, "original content\n");
    const env = { CLAUDE_SYNC_NOTES_PATH: notesPath, CLAUDE_STATE_DIR: stateDir };
    const first = await runHook(env);
    assertStringIncludes(first.stdout, "systemMessage");

    await Deno.writeTextFile(notesPath, "updated content — something new\n");
    const second = await runHook(env);
    assertEquals(second.code, 0);
    assertStringIncludes(second.stdout, "systemMessage");
  });
});
