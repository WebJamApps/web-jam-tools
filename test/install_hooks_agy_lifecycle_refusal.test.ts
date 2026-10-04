// install_hooks_agy_lifecycle_refusal.test.ts — web-jam-tools#432 finding 9
//
// Finding 9 (measured 2026-08-07): registering a Stop OR a SessionStart
// entry in agy's hooks.json silently disables the ENTIRE hooks config on
// that surface — not just that event, every PreToolUse guard included.
// Re-measured 2026-09-28 on agy 1.2.12 (web-jam-tools#1176): for Stop, the
// cause is the entry's shape. A nested { hooks: [{ type, command }] } Stop
// entry makes agy reject the whole file ("command hook must specify
// 'command'"); a flat { type, command } Stop entry loads, fires, and leaves
// the PreToolUse guards firing. This pins:
//   1. scripts/merge-hooks-into-settings.ts writes agy's Stop entry flat,
//      flattens (and --check reports) any nested one, and still refuses
//      SessionStart/SessionEnd when --forbid-lifecycle-hooks is passed.
//   2. scripts/install-hooks.sh's own agy-targeting invocations always pass
//      --forbid-lifecycle-hooks (source-level pin, same pattern as
//      test/install_hooks_force_push_policy.test.ts).
//   3. A full, sandboxed install-hooks.sh run writes only a flat Stop entry
//      and no SessionStart/SessionEnd into the agy hooks file.

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

// --- 1. merge-hooks-into-settings.ts permits --stop on agy, refuses SessionStart/SessionEnd ---

Deno.test("merge-hooks-into-settings.ts permits --stop with --forbid-lifecycle-hooks (web-jam-tools#1176)", async () => {
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
      "$HOME/.claude/hooks/agent-alert.sh agy finished",
    ]);
    assertEquals(res.code, 0, res.stderr);
    const data = JSON.parse(await Deno.readTextFile(path));
    assertEquals(data.hooks.Stop, [
      { type: "command", command: "$HOME/.claude/hooks/agent-alert.sh agy finished" },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("merge-hooks-into-settings.ts flattens a nested agy Stop entry, and --check reports it first (web-jam-tools#1176)", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/agy_hooks.json`;
  const cmd = "$HOME/.claude/hooks/agent-alert.sh agy finished";
  const mergeArgs = (...extra: string[]) => [
    "run",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    MERGE_SCRIPT,
    path,
    ...extra,
    "--forbid-lifecycle-hooks",
    "--",
    "--stop",
    cmd,
  ];
  try {
    // The nested shape agy rejects, which disarms every guard in the file.
    await Deno.writeTextFile(
      path,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: cmd }] }] } }),
    );

    const check = await run(Deno.execPath(), mergeArgs("--check"));
    assertEquals(check.code, 1, "a nested agy Stop entry must be reported as drift");
    assert(check.stderr.includes("nested Stop entr"), check.stderr);

    const res = await run(Deno.execPath(), mergeArgs());
    assertEquals(res.code, 0, res.stderr);
    const data = JSON.parse(await Deno.readTextFile(path));
    assertEquals(data.hooks.Stop, [{ type: "command", command: cmd }]);

    const recheck = await run(Deno.execPath(), mergeArgs("--check"));
    assertEquals(recheck.code, 0, recheck.stderr);
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

Deno.test("merge-hooks-into-settings.ts refuses to write when --forbid-lifecycle-hooks is combined with --session-end", async () => {
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
      "--session-end",
      "$HOME/.claude/hooks/prune-permission-allows-on-session-end.sh",
    ]);
    assertEquals(res.code, 1);
    assert(res.stderr.includes("refusing to write"), res.stderr);
    assert(res.stderr.includes("SessionEnd"), res.stderr);
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
    assertEquals(data.hooks.SessionEnd ?? [], []);
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

Deno.test("install-hooks.sh passes --stop to agy hooks.json and never passes --session-end or SessionStart args", async () => {
  const src = await Deno.readTextFile(INSTALL_SCRIPT);
  const agyInvocations = src
    .split("\n")
    .filter((line) =>
      line.includes('"$AGY_HOOKS_PATH"') && line.includes("merge-hooks-into-settings.ts")
    );
  for (const line of agyInvocations) {
    assert(line.includes("--stop"), `agy invocation must pass --stop: ${line}`);
    assert(
      !line.includes("--session-end"),
      `agy invocation must never pass --session-end: ${line}`,
    );
    assert(
      !line.includes("merge_session_start_args"),
      `agy invocation must never pass SessionStart args: ${line}`,
    );
    assert(
      !line.includes("merge_session_end_args"),
      `agy invocation must never pass SessionEnd args: ${line}`,
    );
  }
});

// --- 3. Behavioural proof: a full sandboxed install-hooks.sh run registers
// agy's Stop hook ($HOME/.claude/hooks/agent-alert.sh agy finished) into agy hooks.json,
// writes no SessionStart/SessionEnd, and wraps PreToolUse/PostToolUse commands
// with the shim ---

Deno.test("a full sandboxed install-hooks.sh run writes agy Stop hook into agy hooks.json, no SessionStart/SessionEnd, and wraps entries with the shim", async () => {
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
    assertEquals(agyHooks.hooks.Stop, [
      { type: "command", command: "$HOME/.claude/hooks/agent-alert.sh agy finished" },
    ]);
    assertEquals(agyHooks.hooks.SessionStart ?? [], []);
    assertEquals(agyHooks.hooks.SessionEnd ?? [], []);
    assert(agyHooks.hooks.PreToolUse.length > 0);
    assert(agyHooks.hooks.PostToolUse.length > 0);

    const allCommands = [...agyHooks.hooks.PreToolUse, ...agyHooks.hooks.PostToolUse]
      .flatMap((entry: { hooks: Array<{ command: string }> }) => entry.hooks.map((h) => h.command));
    const shimWrapped = allCommands.filter((c: string) => !c.includes("agy-prompt-watch.sh"));
    assert(
      shimWrapped.every((c: string) => c.includes("agy-hook-shim.sh")),
      "every translated PreToolUse/PostToolUse command must be wrapped by agy-hook-shim.sh",
    );
    assert(
      allCommands.some((c: string) => c === "$HOME/.claude/hooks/agy-prompt-watch.sh"),
      "agy-native agy-prompt-watch.sh must be present directly in agy hooks.json",
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
    assert(claudeCommands.every((c: string) => !c.includes("agy-prompt-watch.sh")));
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
