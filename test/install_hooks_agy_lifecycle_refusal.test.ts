// install_hooks_agy_lifecycle_refusal.test.ts — web-jam-tools#432 finding 9
//
// Finding 9 (measured 2026-08-07): registering a Stop OR a SessionStart
// entry in agy's hooks.json silently disables the ENTIRE hooks config on
// that surface — not just that event, every PreToolUse guard included. That
// landmine wasn't armed at the time (install-hooks.sh only ever passed
// --pre-tool-use/--post-tool-use for the agy target), but nothing stopped a
// future change from adding one. This pins the active refusal:
//   1. scripts/merge-hooks-into-settings.ts refuses to write anything at all
//      when --forbid-lifecycle-hooks is combined with a --stop/SessionStart
//      argument (unit level, sandboxed temp file).
//   2. scripts/install-hooks.sh's own agy-targeting invocations always pass
//      --forbid-lifecycle-hooks (source-level pin, same pattern as
//      test/install_hooks_force_push_policy.test.ts).
//   3. A full, sandboxed install-hooks.sh run never writes a Stop or
//      SessionStart key into the agy hooks file at all (behavioural proof).

import { assert, assertEquals } from "@std/assert";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const INSTALL_SCRIPT = `${REPO_ROOT}scripts/install-hooks.sh`;
const MERGE_SCRIPT = `${REPO_ROOT}scripts/merge-hooks-into-settings.ts`;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(cmd: string, args: string[], env?: Record<string, string>): Promise<RunResult> {
  const command = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
    env: env ? { ...Deno.env.toObject(), ...env } : undefined,
  });
  const { code, stdout, stderr } = await command.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

// --- 1. merge-hooks-into-settings.ts refuses when combined with lifecycle args ---

Deno.test("merge-hooks-into-settings.ts refuses to write when --forbid-lifecycle-hooks is combined with --stop", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/agy_hooks.json`;
  try {
    const res = await run(Deno.execPath(), [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      MERGE_SCRIPT,
      path,
      "--forbid-lifecycle-hooks",
      "--",
      "--stop",
      "$HOME/.claude/hooks/some-stop-hook.sh",
    ]);
    assertEquals(res.code, 1);
    assert(res.stderr.includes("refusing to write"), res.stderr);
    assert(res.stderr.includes("finding 9"), res.stderr);
    let exists = true;
    try {
      await Deno.stat(path);
    } catch {
      exists = false;
    }
    assert(!exists, "the target file must not be created when the refusal fires");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("merge-hooks-into-settings.ts refuses to write when --forbid-lifecycle-hooks is combined with a SessionStart (head) arg", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/agy_hooks.json`;
  try {
    const res = await run(Deno.execPath(), [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      MERGE_SCRIPT,
      path,
      "--forbid-lifecycle-hooks",
      "--",
      "$HOME/.claude/hooks/some-session-start-hook.sh",
    ]);
    assertEquals(res.code, 1);
    assert(res.stderr.includes("refusing to write"), res.stderr);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("merge-hooks-into-settings.ts with --forbid-lifecycle-hooks still merges normally when no lifecycle args are present", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/agy_hooks.json`;
  try {
    const res = await run(Deno.execPath(), [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      MERGE_SCRIPT,
      path,
      "--forbid-lifecycle-hooks",
      "--",
      "--pre-tool-use",
      "Bash::$HOME/.claude/hooks/agy-hook-shim.sh PreToolUse QmFzaA== $HOME/.claude/hooks/block-secret-dumps.sh",
    ]);
    assertEquals(res.code, 0, res.stderr);
    const data = JSON.parse(await Deno.readTextFile(path));
    assert(data.hooks.PreToolUse.length > 0);
    // mergeFlatHooks always creates the key (even when its cmds list is
    // empty) — an empty array, not a missing key, is what "no Stop/
    // SessionStart hook was ever registered" looks like here.
    assertEquals(data.hooks.Stop ?? [], []);
    assertEquals(data.hooks.SessionStart ?? [], []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- 2. install-hooks.sh source-level pin ---

Deno.test("install-hooks.sh passes --forbid-lifecycle-hooks on both agy hooks.json invocations", async () => {
  const src = await Deno.readTextFile(INSTALL_SCRIPT);
  const agyInvocations = src
    .split("\n")
    .filter((line) =>
      line.includes('"$AGY_HOOKS_PATH"') && line.includes("merge-hooks-into-settings.ts")
    );
  assert(
    agyInvocations.length >= 2,
    `expected at least 2 agy invocations, found ${agyInvocations.length}`,
  );
  for (const line of agyInvocations) {
    assert(
      line.includes("--forbid-lifecycle-hooks"),
      `expected --forbid-lifecycle-hooks on agy invocation, got: ${line}`,
    );
  }
});

Deno.test("install-hooks.sh never passes --stop or SessionStart args to the agy hooks.json invocations", async () => {
  const src = await Deno.readTextFile(INSTALL_SCRIPT);
  const agyInvocations = src
    .split("\n")
    .filter((line) =>
      line.includes('"$AGY_HOOKS_PATH"') && line.includes("merge-hooks-into-settings.ts")
    );
  for (const line of agyInvocations) {
    assert(!line.includes("--stop"), `agy invocation must never pass --stop: ${line}`);
    assert(
      !line.includes("merge_session_start_args"),
      `agy invocation must never pass SessionStart args: ${line}`,
    );
  }
});

// --- 3. Behavioural proof: a full sandboxed install-hooks.sh run never
// writes Stop/SessionStart into the agy hooks file, and does wrap
// PreToolUse/PostToolUse commands with the shim ---

Deno.test("a full sandboxed install-hooks.sh run writes no Stop/SessionStart into agy hooks.json, and wraps entries with the shim", async () => {
  const hooksDir = await Deno.makeTempDir();
  const settingsDir = await Deno.makeTempDir();
  const settingsPath = `${settingsDir}/settings.json`;
  const agyHooksPath = `${settingsDir}/agy_hooks.json`;
  try {
    const res = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
    ]);
    assertEquals(res.code, 0, res.stdout + res.stderr);

    const agyHooks = JSON.parse(await Deno.readTextFile(agyHooksPath));
    assertEquals(agyHooks.hooks.Stop ?? [], []);
    assertEquals(agyHooks.hooks.SessionStart ?? [], []);
    assert(agyHooks.hooks.PreToolUse.length > 0);
    assert(agyHooks.hooks.PostToolUse.length > 0);

    const allCommands = [...agyHooks.hooks.PreToolUse, ...agyHooks.hooks.PostToolUse]
      .flatMap((entry: { hooks: Array<{ command: string }> }) => entry.hooks.map((h) => h.command));
    assert(
      allCommands.every((c: string) => c.includes("agy-hook-shim.sh")),
      "every agy hooks.json PreToolUse/PostToolUse command must be wrapped by agy-hook-shim.sh",
    );

    // The two agy-only hooks must be present in the wrapped set.
    assert(allCommands.some((c: string) => c.includes("block-agy-gmail-send-delete.sh")));
    assert(allCommands.some((c: string) => c.includes("agy-model-guard.sh")));

    // Claude Code's settings.json is unaffected by any of this: no shim
    // wrapping, no agy-only hooks (they are agy-surface only).
    const settings = JSON.parse(await Deno.readTextFile(settingsPath));
    const claudeCommands = settings.hooks.PreToolUse.flatMap(
      (entry: { hooks: Array<{ command: string }> }) => entry.hooks.map((h) => h.command),
    );
    assert(claudeCommands.every((c: string) => !c.includes("agy-hook-shim.sh")));
    assert(claudeCommands.every((c: string) => !c.includes("block-agy-gmail-send-delete.sh")));
    assert(claudeCommands.every((c: string) => !c.includes("agy-model-guard.sh")));
  } finally {
    await Deno.remove(hooksDir, { recursive: true });
    await Deno.remove(settingsDir, { recursive: true });
  }
});

Deno.test("install-hooks.sh --check passes on a clean sandboxed agy installation", async () => {
  const hooksDir = await Deno.makeTempDir();
  const settingsDir = await Deno.makeTempDir();
  const settingsPath = `${settingsDir}/settings.json`;
  const agyHooksPath = `${settingsDir}/agy_hooks.json`;
  try {
    const first = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
    ]);
    assertEquals(first.code, 0, first.stdout + first.stderr);

    const check = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
      "--check",
    ]);
    assertEquals(check.code, 0, check.stdout + check.stderr);
  } finally {
    await Deno.remove(hooksDir, { recursive: true });
    await Deno.remove(settingsDir, { recursive: true });
  }
});
