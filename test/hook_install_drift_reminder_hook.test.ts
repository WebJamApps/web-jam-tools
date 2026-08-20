// hook_install_drift_reminder_hook.test.ts — web-jam-tools#664
//
// Exercises hooks/hook-install-drift-reminder.sh and its helper
// hooks/lib/check_hook_install_drift.ts:
// 1. Quiet case: checkout is level with remote tracking ref and settings.json has all hooks.
// 2. Remote diff case: detects added, deleted, and modified hook files on origin/dev.
// 3. Dead hook path case: detects settings.json commands pointing to non-existent files.
// 4. Unregistered hook case: detects hooks on origin/dev missing from settings.json.
// 5. Read-only verification: never mutates git repo or settings.json.
// 6. Bash execution: confirms hook script runs end-to-end and exits 0.

import { assert, assertEquals } from "@std/assert";
import * as path from "jsr:@std/path@^1.0.0";
import {
  checkAgyDeadHookPaths,
  checkAgyUnregisteredHooks,
  checkDeadHookPaths,
  checkRemoteDiff,
  checkUnregisteredHooks,
  detectDrift,
  formatDriftMessage,
} from "../hooks/lib/check_hook_install_drift.ts";

const REPO_ROOT = path.resolve(
  path.dirname(path.fromFileUrl(import.meta.url)),
  "..",
);
const HOOK_SCRIPT = path.join(
  REPO_ROOT,
  "hooks/hook-install-drift-reminder.sh",
);

interface Sandbox {
  dir: string;
  repoDir: string;
  homeDir: string;
  hooksDir: string;
  settingsPath: string;
  agyHooksPath: string;
  cleanup: () => Promise<void>;
}

// Base64 of the literal matcher "Bash" — same encoding
// scripts/install-hooks.sh's agy_shim_arg() applies to every agy-side
// PreToolUse/PostToolUse matcher before wrapping it in agy-hook-shim.sh.
const BASH_MATCHER_B64 = btoa("Bash");

async function createSandbox(): Promise<Sandbox> {
  const dir = await Deno.makeTempDir({ prefix: "drift_test_" });
  const repoDir = path.join(dir, "repo");
  const homeDir = path.join(dir, "home");
  const hooksDir = path.join(homeDir, ".claude/hooks");
  const settingsPath = path.join(homeDir, ".claude/settings.json");
  const agyHooksPath = path.join(homeDir, ".gemini/config/hooks.json");

  await Deno.mkdir(repoDir, { recursive: true });
  await Deno.mkdir(hooksDir, { recursive: true });
  await Deno.mkdir(path.dirname(agyHooksPath), { recursive: true });

  const runGit = async (args: string[], cwd = repoDir) => {
    const cmd = new Deno.Command("git", {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
    });
    const out = await cmd.output();
    if (!out.success) {
      throw new Error(
        `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
      );
    }
  };

  await runGit(["init", "-b", "dev"]);
  await runGit(["config", "user.name", "Test User"]);
  await runGit(["config", "user.email", "test@example.com"]);

  await Deno.mkdir(path.join(repoDir, "hooks"), { recursive: true });
  await Deno.mkdir(path.join(repoDir, "scripts"), { recursive: true });

  // Initial hook scripts
  await Deno.writeTextFile(
    path.join(repoDir, "hooks/hook1.sh"),
    "#!/bin/bash\nexit 0\n",
  );
  await Deno.writeTextFile(
    path.join(repoDir, "hooks/hook2.sh"),
    "#!/bin/bash\nexit 0\n",
  );
  // agy-hook-shim.sh: the wrapper every agy-side registration in hooks.json
  // routes through (web-jam-tools#432) — its content doesn't matter here,
  // only that the file exists at the path agy hooks.json commands reference.
  await Deno.writeTextFile(
    path.join(repoDir, "hooks/agy-hook-shim.sh"),
    "#!/bin/bash\nexit 0\n",
  );
  await Deno.writeTextFile(
    path.join(repoDir, "scripts/install-hooks.sh"),
    `SESSION_START_HOOKS=(hook1.sh)\nSTOP_HOOKS=()\nPRE_TOOL_USE_HOOKS=(\n  "Bash::hook2.sh"\n)\nAGY_ONLY_PRE_TOOL_USE_HOOKS=(\n)\nPOST_TOOL_USE_HOOKS=(\n)\n`,
  );

  await runGit(["add", "."]);
  await runGit(["commit", "-m", "Initial commit"]);
  await runGit(["update-ref", "refs/remotes/origin/dev", "HEAD"]);

  // Create installed hooks in home dir
  await Deno.symlink(
    path.join(repoDir, "hooks/hook1.sh"),
    path.join(hooksDir, "hook1.sh"),
  );
  await Deno.symlink(
    path.join(repoDir, "hooks/hook2.sh"),
    path.join(hooksDir, "hook2.sh"),
  );
  await Deno.symlink(
    path.join(repoDir, "hooks/agy-hook-shim.sh"),
    path.join(hooksDir, "agy-hook-shim.sh"),
  );

  const initialSettings = {
    permissions: {
      allow: ["Bash(echo hello)"],
    },
    hooks: {
      SessionStart: [
        {
          hooks: [{
            type: "command",
            command: "$HOME/.claude/hooks/hook1.sh",
          }],
        },
      ],
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{
            type: "command",
            command: "$HOME/.claude/hooks/hook2.sh",
          }],
        },
      ],
    },
  };

  await Deno.writeTextFile(
    settingsPath,
    JSON.stringify(initialSettings, null, 2),
  );

  // agy's hooks.json: same shape, every command shim-wrapped
  // ($HOME/.claude/hooks/agy-hook-shim.sh <event> <base64 matcher> <target>)
  // per scripts/install-hooks.sh's agy_shim_arg(). Starts level with
  // PRE_TOOL_USE_HOOKS above (hook2.sh) so the baseline sandbox is clean on
  // BOTH surfaces.
  const initialAgyHooks = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{
            type: "command",
            command:
              `$HOME/.claude/hooks/agy-hook-shim.sh PreToolUse ${BASH_MATCHER_B64} $HOME/.claude/hooks/hook2.sh`,
          }],
        },
      ],
    },
  };

  await Deno.writeTextFile(
    agyHooksPath,
    JSON.stringify(initialAgyHooks, null, 2),
  );

  return {
    dir,
    repoDir,
    homeDir,
    hooksDir,
    settingsPath,
    agyHooksPath,
    cleanup: async () => {
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function runHookScript(env: Record<string, string>): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const cmd = new Deno.Command("bash", {
    args: [HOOK_SCRIPT],
    env,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

// --- Test 1: Quiet case ---

Deno.test("detectDrift returns empty result when checkout is level and all hooks valid", async () => {
  const sb = await createSandbox();
  try {
    const result = await detectDrift({
      repoDir: sb.repoDir,
      homeDir: sb.homeDir,
      settingsPath: sb.settingsPath,
      agyHooksPath: sb.agyHooksPath,
      remoteRef: "origin/dev",
    });

    assertEquals(result.remoteDiff.added, []);
    assertEquals(result.remoteDiff.deleted, []);
    assertEquals(result.remoteDiff.modified, []);
    assertEquals(result.deadHooks, []);
    assertEquals(result.unregisteredHooks, []);
    assertEquals(result.agy.configFound, true);
    assertEquals(result.agy.deadHooks, []);
    assertEquals(result.agy.unregisteredHooks, []);

    const msg = formatDriftMessage(result);
    assertEquals(msg, "");
  } finally {
    await sb.cleanup();
  }
});

// --- Test 2: Remote diff (Added, Deleted, Modified) ---

Deno.test("detectDrift catches added, deleted, and modified hook files on origin/dev", async () => {
  const sb = await createSandbox();
  try {
    const runGit = async (args: string[]) => {
      const cmd = new Deno.Command("git", {
        args,
        cwd: sb.repoDir,
        stdout: "piped",
        stderr: "piped",
      });
      const out = await cmd.output();
      if (!out.success) {
        throw new Error(
          `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
        );
      }
    };

    // Make changes on origin/dev:
    // 1. Add hook3.sh
    // 2. Delete hook1.sh
    // 3. Modify hook2.sh
    await Deno.writeTextFile(
      path.join(sb.repoDir, "hooks/hook3.sh"),
      "#!/bin/bash\necho hook3\n",
    );
    await Deno.remove(path.join(sb.repoDir, "hooks/hook1.sh"));
    await Deno.writeTextFile(
      path.join(sb.repoDir, "hooks/hook2.sh"),
      "#!/bin/bash\n# modified\nexit 0\n",
    );

    await runGit(["add", "."]);
    await runGit(["commit", "-m", "Remote update"]);
    await runGit(["update-ref", "refs/remotes/origin/dev", "HEAD"]);

    // Reset local HEAD back to the original commit
    await runGit(["reset", "--hard", "HEAD~1"]);

    const diff = await checkRemoteDiff(sb.repoDir, "origin/dev");
    assertEquals(diff.added, ["hooks/hook3.sh"]);
    assertEquals(diff.deleted, ["hooks/hook1.sh"]);
    assertEquals(diff.modified, ["hooks/hook2.sh"]);

    const result = await detectDrift({
      repoDir: sb.repoDir,
      homeDir: sb.homeDir,
      settingsPath: sb.settingsPath,
      agyHooksPath: sb.agyHooksPath,
      remoteRef: "origin/dev",
    });

    const msg = formatDriftMessage(result);
    assert(msg.includes("Added on origin/dev: hooks/hook3.sh"), msg);
    assert(msg.includes("Deleted on origin/dev: hooks/hook1.sh"), msg);
    assert(msg.includes("Modified on origin/dev: hooks/hook2.sh"), msg);
  } finally {
    await sb.cleanup();
  }
});

// --- Test 3: Dead hook paths in settings.json ---

Deno.test("detectDrift reports hook commands in settings.json pointing to dead paths", async () => {
  const sb = await createSandbox();
  try {
    // Delete hook1.sh from hooks dir to make the symlink in ~/.claude/hooks/hook1.sh dangling
    await Deno.remove(path.join(sb.repoDir, "hooks/hook1.sh"));

    const dead = checkDeadHookPaths(sb.settingsPath, sb.homeDir);
    assertEquals(dead.length, 1);
    assertEquals(dead[0].event, "SessionStart");
    assertEquals(dead[0].command, "$HOME/.claude/hooks/hook1.sh");

    const result = await detectDrift({
      repoDir: sb.repoDir,
      homeDir: sb.homeDir,
      settingsPath: sb.settingsPath,
      agyHooksPath: sb.agyHooksPath,
      remoteRef: "origin/dev",
    });

    const msg = formatDriftMessage(result);
    assert(msg.includes("Dead hook paths in settings.json"), msg);
    assert(msg.includes("SessionStart: $HOME/.claude/hooks/hook1.sh"), msg);
    // Ensure permission strings/secrets from settings.json are NEVER leaked
    assert(!msg.includes("echo hello"), msg);
  } finally {
    await sb.cleanup();
  }
});

// --- Test 4: Unregistered hooks on origin/dev ---

Deno.test("detectDrift reports hooks on origin/dev not registered in settings.json", async () => {
  const sb = await createSandbox();
  try {
    const runGit = async (args: string[]) => {
      const cmd = new Deno.Command("git", {
        args,
        cwd: sb.repoDir,
        stdout: "piped",
        stderr: "piped",
      });
      const out = await cmd.output();
      if (!out.success) {
        throw new Error(
          `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
        );
      }
    };

    // Add hook3.sh to origin/dev installer and hooks
    await Deno.writeTextFile(
      path.join(sb.repoDir, "hooks/hook3.sh"),
      "#!/bin/bash\nexit 0\n",
    );
    await Deno.writeTextFile(
      path.join(sb.repoDir, "scripts/install-hooks.sh"),
      `SESSION_START_HOOKS=(hook1.sh hook3.sh)\nSTOP_HOOKS=()\nPRE_TOOL_USE_HOOKS=("Bash::hook2.sh")\nPOST_TOOL_USE_HOOKS=()\n`,
    );

    await runGit(["add", "."]);
    await runGit(["commit", "-m", "Add hook3"]);
    await runGit(["update-ref", "refs/remotes/origin/dev", "HEAD"]);

    const unreg = await checkUnregisteredHooks(
      sb.repoDir,
      "origin/dev",
      sb.settingsPath,
    );
    assertEquals(unreg, ["hook3.sh"]);

    const result = await detectDrift({
      repoDir: sb.repoDir,
      homeDir: sb.homeDir,
      settingsPath: sb.settingsPath,
      agyHooksPath: sb.agyHooksPath,
      remoteRef: "origin/dev",
    });

    const msg = formatDriftMessage(result);
    assert(
      msg.includes("Hooks on origin/dev not registered in settings.json:"),
      msg,
    );
    assert(msg.includes("• hook3.sh"), msg);
    // hook3.sh was only added to SESSION_START_HOOKS (a Claude-only,
    // SessionStart-fired event agy's hooks.json never registers per
    // --forbid-lifecycle-hooks / web-jam-tools#432 finding 9) — the agy
    // surface must stay clean and must NOT demand a SessionStart-only hook.
    assertEquals(result.agy.unregisteredHooks, []);
    assert(
      !msg.includes("Hooks on origin/dev not registered in agy hooks.json:"),
      msg,
    );
  } finally {
    await sb.cleanup();
  }
});

// --- Test 5: Read-only immutability ---

Deno.test("detectDrift never writes to repository, settings.json, or agy hooks.json", async () => {
  const sb = await createSandbox();
  try {
    const settingsBefore = await Deno.readTextFile(sb.settingsPath);
    const settingsStatBefore = await Deno.stat(sb.settingsPath);
    const agyBefore = await Deno.readTextFile(sb.agyHooksPath);
    const agyStatBefore = await Deno.stat(sb.agyHooksPath);

    // Run detectDrift multiple times
    await detectDrift({
      repoDir: sb.repoDir,
      homeDir: sb.homeDir,
      settingsPath: sb.settingsPath,
      agyHooksPath: sb.agyHooksPath,
      remoteRef: "origin/dev",
    });
    await detectDrift({
      repoDir: sb.repoDir,
      homeDir: sb.homeDir,
      settingsPath: sb.settingsPath,
      agyHooksPath: sb.agyHooksPath,
      remoteRef: "origin/dev",
    });

    const settingsAfter = await Deno.readTextFile(sb.settingsPath);
    const settingsStatAfter = await Deno.stat(sb.settingsPath);
    assertEquals(settingsBefore, settingsAfter);
    assertEquals(settingsStatBefore.mtime, settingsStatAfter.mtime);

    const agyAfter = await Deno.readTextFile(sb.agyHooksPath);
    const agyStatAfter = await Deno.stat(sb.agyHooksPath);
    assertEquals(agyBefore, agyAfter);
    assertEquals(agyStatBefore.mtime, agyStatAfter.mtime);

    const cmd = new Deno.Command("git", {
      args: ["status", "--porcelain"],
      cwd: sb.repoDir,
      stdout: "piped",
      stderr: "piped",
    });
    const out = await cmd.output();
    const gitStatus = new TextDecoder().decode(out.stdout).trim();
    assertEquals(gitStatus, "");
  } finally {
    await sb.cleanup();
  }
});

// --- Test 6: End-to-end Bash Hook Script Execution ---

Deno.test("hooks/hook-install-drift-reminder.sh executes end-to-end and emits JSON", async () => {
  const sb = await createSandbox();
  try {
    // 1. Quiet run -> empty output, exit 0
    const quietRes = await runHookScript({
      CLAUDE_HOOKS_REPO_DIR: sb.repoDir,
      CLAUDE_SETTINGS_PATH: sb.settingsPath,
      AGY_HOOKS_PATH: sb.agyHooksPath,
      HOOKS_REMOTE_REF: "origin/dev",
      CLAUDE_HOME: sb.homeDir,
    });
    assertEquals(quietRes.code, 0, quietRes.stderr);
    assertEquals(quietRes.stdout.trim(), "");

    // 2. Introduce dead path -> produces JSON systemMessage, exit 0
    await Deno.remove(path.join(sb.repoDir, "hooks/hook1.sh"));
    const driftRes = await runHookScript({
      CLAUDE_HOOKS_REPO_DIR: sb.repoDir,
      CLAUDE_SETTINGS_PATH: sb.settingsPath,
      AGY_HOOKS_PATH: sb.agyHooksPath,
      HOOKS_REMOTE_REF: "origin/dev",
      CLAUDE_HOME: sb.homeDir,
    });
    assertEquals(driftRes.code, 0, driftRes.stderr);
    assert(driftRes.stdout.includes("systemMessage"), driftRes.stdout);

    const parsed = JSON.parse(driftRes.stdout);
    assert(typeof parsed.systemMessage === "string");
    assert(parsed.systemMessage.includes("Dead hook paths in settings.json"));
  } finally {
    await sb.cleanup();
  }
});

// --- Test 7: agy dead hook paths (web-jam-tools#674) ---
//
// Positive/negative pair: introduce a dangling agy registration (delete the
// TARGET hook's symlink the agy entry ultimately points at), confirm the
// check reports it, then restore the symlink and confirm it goes quiet
// again — proving the check actually inspects state rather than always
// passing or always failing.

Deno.test("checkAgyDeadHookPaths detects a dangling agy target and clears once restored", async () => {
  const sb = await createSandbox();
  try {
    // Baseline: clean.
    assertEquals(checkAgyDeadHookPaths(sb.agyHooksPath, sb.homeDir), []);

    // Construct the drift: remove the installed symlink hook2.sh, which is
    // the TARGET the agy hooks.json PreToolUse entry wraps via the shim.
    const hook2Symlink = path.join(sb.hooksDir, "hook2.sh");
    await Deno.remove(hook2Symlink);

    const dead = checkAgyDeadHookPaths(sb.agyHooksPath, sb.homeDir);
    assertEquals(dead.length, 1);
    assertEquals(dead[0].event, "PreToolUse [agy target]");
    assert(dead[0].command.includes("hook2.sh"), dead[0].command);

    const driftResult = await detectDrift({
      repoDir: sb.repoDir,
      homeDir: sb.homeDir,
      settingsPath: sb.settingsPath,
      agyHooksPath: sb.agyHooksPath,
      remoteRef: "origin/dev",
    });
    const driftMsg = formatDriftMessage(driftResult);
    assert(
      driftMsg.includes("Dead hook paths in agy hooks.json"),
      driftMsg,
    );
    assert(driftMsg.includes("PreToolUse [agy target]"), driftMsg);
    assert(
      driftMsg.includes("web-jam-tools#432"),
      "expected the #432 enforcement caveat when agy drift is reported: " + driftMsg,
    );

    // Remove the drift: restore the symlink.
    await Deno.symlink(
      path.join(sb.repoDir, "hooks/hook2.sh"),
      hook2Symlink,
    );

    assertEquals(checkAgyDeadHookPaths(sb.agyHooksPath, sb.homeDir), []);

    const cleanResult = await detectDrift({
      repoDir: sb.repoDir,
      homeDir: sb.homeDir,
      settingsPath: sb.settingsPath,
      agyHooksPath: sb.agyHooksPath,
      remoteRef: "origin/dev",
    });
    assertEquals(formatDriftMessage(cleanResult), "");
  } finally {
    await sb.cleanup();
  }
});

// --- Test 8: agy unregistered hooks (web-jam-tools#674) ---
//
// Positive/negative pair: add a hook to origin/dev's PRE_TOOL_USE_HOOKS
// that agy hooks.json never learns about, confirm it's reported, then
// register it (shim-wrapped, matching scripts/install-hooks.sh's
// agy_shim_arg() shape) and confirm the report goes quiet.

Deno.test("checkAgyUnregisteredHooks detects a hook missing from agy hooks.json and clears once registered", async () => {
  const sb = await createSandbox();
  try {
    const runGit = async (args: string[]) => {
      const cmd = new Deno.Command("git", {
        args,
        cwd: sb.repoDir,
        stdout: "piped",
        stderr: "piped",
      });
      const out = await cmd.output();
      if (!out.success) {
        throw new Error(
          `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
        );
      }
    };

    // Add hook3.sh to origin/dev's PRE_TOOL_USE_HOOKS (the array agy's
    // hooks.json IS expected to mirror, unlike SESSION_START_HOOKS).
    await Deno.writeTextFile(
      path.join(sb.repoDir, "hooks/hook3.sh"),
      "#!/bin/bash\nexit 0\n",
    );
    await Deno.writeTextFile(
      path.join(sb.repoDir, "scripts/install-hooks.sh"),
      `SESSION_START_HOOKS=(hook1.sh)\nSTOP_HOOKS=()\nPRE_TOOL_USE_HOOKS=(\n  "Bash::hook2.sh"\n  "Bash::hook3.sh"\n)\nAGY_ONLY_PRE_TOOL_USE_HOOKS=(\n)\nPOST_TOOL_USE_HOOKS=(\n)\n`,
    );
    await Deno.symlink(
      path.join(sb.repoDir, "hooks/hook3.sh"),
      path.join(sb.hooksDir, "hook3.sh"),
    );

    await runGit(["add", "."]);
    await runGit(["commit", "-m", "Add hook3 to PRE_TOOL_USE_HOOKS"]);
    await runGit(["update-ref", "refs/remotes/origin/dev", "HEAD"]);

    const unreg = await checkAgyUnregisteredHooks(
      sb.repoDir,
      "origin/dev",
      sb.agyHooksPath,
    );
    assertEquals(unreg, ["hook3.sh"]);

    const driftResult = await detectDrift({
      repoDir: sb.repoDir,
      homeDir: sb.homeDir,
      settingsPath: sb.settingsPath,
      agyHooksPath: sb.agyHooksPath,
      remoteRef: "origin/dev",
    });
    const driftMsg = formatDriftMessage(driftResult);
    assert(
      driftMsg.includes("Hooks on origin/dev not registered in agy hooks.json:"),
      driftMsg,
    );
    assert(driftMsg.includes("• hook3.sh"), driftMsg);
    assert(driftMsg.includes("web-jam-tools#432"), driftMsg);

    // Remove the drift: register hook3.sh in agy hooks.json, shim-wrapped.
    const agyHooks = JSON.parse(await Deno.readTextFile(sb.agyHooksPath));
    agyHooks.hooks.PreToolUse.push({
      matcher: "Bash",
      hooks: [{
        type: "command",
        command:
          `$HOME/.claude/hooks/agy-hook-shim.sh PreToolUse ${BASH_MATCHER_B64} $HOME/.claude/hooks/hook3.sh`,
      }],
    });
    await Deno.writeTextFile(sb.agyHooksPath, JSON.stringify(agyHooks, null, 2));

    assertEquals(
      await checkAgyUnregisteredHooks(sb.repoDir, "origin/dev", sb.agyHooksPath),
      [],
    );

    const cleanResult = await detectDrift({
      repoDir: sb.repoDir,
      homeDir: sb.homeDir,
      settingsPath: sb.settingsPath,
      agyHooksPath: sb.agyHooksPath,
      remoteRef: "origin/dev",
    });
    // Claude side still drifts (settings.json was never touched) — only
    // confirm the agy-specific line is gone.
    assert(
      !formatDriftMessage(cleanResult).includes(
        "Hooks on origin/dev not registered in agy hooks.json:",
      ),
    );
  } finally {
    await sb.cleanup();
  }
});

// --- Test 9: agy hooks.json missing entirely is reported, never silently "clean" ---

Deno.test("a missing agy hooks.json is reported explicitly rather than reported as no drift", async () => {
  const sb = await createSandbox();
  try {
    // Construct the drift: agy was never installed on this machine.
    await Deno.remove(sb.agyHooksPath);

    const result = await detectDrift({
      repoDir: sb.repoDir,
      homeDir: sb.homeDir,
      settingsPath: sb.settingsPath,
      agyHooksPath: sb.agyHooksPath,
      remoteRef: "origin/dev",
    });
    assertEquals(result.agy.configFound, false);

    const msg = formatDriftMessage(result);
    assert(msg !== "", "a surface that was never inspected must not be reported silent/clean");
    assert(msg.includes("agy hooks.json not found at"), msg);
    assert(msg.includes(sb.agyHooksPath), msg);
    assert(msg.includes("web-jam-tools#432"), msg);

    // Remove the drift: restore the file exactly as the baseline sandbox
    // created it.
    const initialAgyHooks = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{
              type: "command",
              command:
                `$HOME/.claude/hooks/agy-hook-shim.sh PreToolUse ${BASH_MATCHER_B64} $HOME/.claude/hooks/hook2.sh`,
            }],
          },
        ],
      },
    };
    await Deno.writeTextFile(sb.agyHooksPath, JSON.stringify(initialAgyHooks, null, 2));

    const cleanResult = await detectDrift({
      repoDir: sb.repoDir,
      homeDir: sb.homeDir,
      settingsPath: sb.settingsPath,
      agyHooksPath: sb.agyHooksPath,
      remoteRef: "origin/dev",
    });
    assertEquals(cleanResult.agy.configFound, true);
    assertEquals(formatDriftMessage(cleanResult), "");
  } finally {
    await sb.cleanup();
  }
});

// --- Test 10: end-to-end Bash execution surfaces agy drift too ---

Deno.test("hooks/hook-install-drift-reminder.sh reports agy drift end-to-end", async () => {
  const sb = await createSandbox();
  try {
    // Quiet baseline (both surfaces clean) already covered by Test 6.
    // Introduce agy-only drift: agy hooks.json missing.
    await Deno.remove(sb.agyHooksPath);

    const res = await runHookScript({
      CLAUDE_HOOKS_REPO_DIR: sb.repoDir,
      CLAUDE_SETTINGS_PATH: sb.settingsPath,
      AGY_HOOKS_PATH: sb.agyHooksPath,
      HOOKS_REMOTE_REF: "origin/dev",
      CLAUDE_HOME: sb.homeDir,
    });
    assertEquals(res.code, 0, res.stderr);
    assert(res.stdout.includes("systemMessage"), res.stdout);
    const parsed = JSON.parse(res.stdout);
    assert(parsed.systemMessage.includes("agy hooks.json not found at"));
    assert(parsed.systemMessage.includes("web-jam-tools#432"));
  } finally {
    await sb.cleanup();
  }
});
