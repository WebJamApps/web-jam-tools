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
  cleanup: () => Promise<void>;
}

async function createSandbox(): Promise<Sandbox> {
  const dir = await Deno.makeTempDir({ prefix: "drift_test_" });
  const repoDir = path.join(dir, "repo");
  const homeDir = path.join(dir, "home");
  const hooksDir = path.join(homeDir, ".claude/hooks");
  const settingsPath = path.join(homeDir, ".claude/settings.json");

  await Deno.mkdir(repoDir, { recursive: true });
  await Deno.mkdir(hooksDir, { recursive: true });

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
  await Deno.writeTextFile(
    path.join(repoDir, "scripts/install-hooks.sh"),
    `SESSION_START_HOOKS=(hook1.sh)\nSTOP_HOOKS=()\nPRE_TOOL_USE_HOOKS=("Bash::hook2.sh")\nPOST_TOOL_USE_HOOKS=()\n`,
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

  return {
    dir,
    repoDir,
    homeDir,
    hooksDir,
    settingsPath,
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
      remoteRef: "origin/dev",
    });

    assertEquals(result.remoteDiff.added, []);
    assertEquals(result.remoteDiff.deleted, []);
    assertEquals(result.remoteDiff.modified, []);
    assertEquals(result.deadHooks, []);
    assertEquals(result.unregisteredHooks, []);

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
      remoteRef: "origin/dev",
    });

    const msg = formatDriftMessage(result);
    assert(
      msg.includes("Hooks on origin/dev not registered in settings.json:"),
      msg,
    );
    assert(msg.includes("• hook3.sh"), msg);
  } finally {
    await sb.cleanup();
  }
});

// --- Test 5: Read-only immutability ---

Deno.test("detectDrift never writes to repository or settings.json", async () => {
  const sb = await createSandbox();
  try {
    const settingsBefore = await Deno.readTextFile(sb.settingsPath);
    const settingsStatBefore = await Deno.stat(sb.settingsPath);

    // Run detectDrift multiple times
    await detectDrift({
      repoDir: sb.repoDir,
      homeDir: sb.homeDir,
      settingsPath: sb.settingsPath,
      remoteRef: "origin/dev",
    });
    await detectDrift({
      repoDir: sb.repoDir,
      homeDir: sb.homeDir,
      settingsPath: sb.settingsPath,
      remoteRef: "origin/dev",
    });

    const settingsAfter = await Deno.readTextFile(sb.settingsPath);
    const settingsStatAfter = await Deno.stat(sb.settingsPath);
    assertEquals(settingsBefore, settingsAfter);
    assertEquals(settingsStatBefore.mtime, settingsStatAfter.mtime);

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
