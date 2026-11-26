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
  checkStatusLineDeadPath,
  checkStatusLineUnregistered,
  checkUnregisteredHooks,
  detectDrift,
  extractExpectedAgyHooksFromInstaller,
  extractExpectedHooksFromInstaller,
  extractScriptPathFromCommand,
  extractSurfaceOnlyHooksFromInstaller,
  formatDriftMessage,
  readInstallerHookArray,
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
    // The update command must be the installed command, with the cwd-independent full path as the first-run fallback.
    assert(msg.includes("'update-scripts'"), msg);
    assert(
      msg.includes("'~/WebJamApps/web-jam-tools/scripts/update-scripts.sh'"),
      msg,
    );
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

// --- Test 3b: inline bash SessionStart hooks must never be flagged dead ---
// web-jam-tools#664: extractScriptPathFromCommand() previously returned the
// raw first whitespace token of ANY hook command, even for inline
// multi-statement bash hooks like the real
// `M="$HOME/.claude/.last-update-reminder"; T=$(date +%Y-%m-%d); ...`
// SessionStart entry in settings.json. That first token is a variable
// assignment, not a script path, so it never resolved and was reported as a
// false-positive dead path on every session — despite the checkout being
// level and every real registration resolving.

Deno.test("extractScriptPathFromCommand ignores inline bash commands with no .sh token", () => {
  const inline =
    'M="$HOME/.claude/.last-update-reminder"; T=$(date +%Y-%m-%d); if [ "$(cat "$M" 2>/dev/null)" != "$T" ]; then echo "$T" > "$M"; fi';
  assertEquals(extractScriptPathFromCommand(inline), "");
});

Deno.test("extractScriptPathFromCommand still extracts a real .sh script path", () => {
  assertEquals(
    extractScriptPathFromCommand("$HOME/.claude/hooks/hook1.sh"),
    "$HOME/.claude/hooks/hook1.sh",
  );
});

Deno.test("checkDeadHookPaths never flags a legitimate inline bash SessionStart hook", async () => {
  const sb = await createSandbox();
  try {
    const settings = JSON.parse(await Deno.readTextFile(sb.settingsPath));
    settings.hooks.SessionStart.push({
      hooks: [{
        type: "command",
        command:
          'M="$HOME/.claude/.last-update-reminder"; T=$(date +%Y-%m-%d); if [ "$(cat "$M" 2>/dev/null)" != "$T" ]; then echo "$T" > "$M"; fi',
      }],
    });
    await Deno.writeTextFile(
      sb.settingsPath,
      JSON.stringify(settings, null, 2),
    );

    const dead = checkDeadHookPaths(sb.settingsPath, sb.homeDir);
    assertEquals(dead, []);
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

Deno.test("checkUnregisteredHooks skips codex-* hooks but still reports other unregistered hooks", async () => {
  const sb = await createSandbox();
  try {
    const runGit = async (args: string[]) => {
      const out = await new Deno.Command("git", {
        args,
        cwd: sb.repoDir,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!out.success) {
        throw new Error(
          `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
        );
      }
    };

    for (const name of ["codex-reaper-startup-check.sh", "hook3.sh"]) {
      await Deno.writeTextFile(
        path.join(sb.repoDir, "hooks", name),
        "#!/bin/bash\nexit 0\n",
      );
    }
    await runGit(["add", "."]);
    await runGit(["commit", "-m", "Add codex and non-codex hooks"]);
    await runGit(["update-ref", "refs/remotes/origin/dev", "HEAD"]);

    // git ls-tree branch
    assertEquals(
      await checkUnregisteredHooks(sb.repoDir, "origin/dev", sb.settingsPath),
      ["hook3.sh"],
    );
    // local-directory fallback branch (ref that git cannot resolve)
    assertEquals(
      await checkUnregisteredHooks(sb.repoDir, "no-such-ref", sb.settingsPath),
      ["hook3.sh"],
    );

    // A codex-* hook explicitly listed in the installer (e.g. SESSION_START_HOOKS)
    // and missing from settings.json MUST still be reported (the exemption only
    // applies to hooks/ directory listing, never to installer registration).
    await Deno.writeTextFile(
      path.join(sb.repoDir, "scripts/install-hooks.sh"),
      `SESSION_START_HOOKS=(hook1.sh codex-reaper-startup-check.sh)\nSTOP_HOOKS=()\nPRE_TOOL_USE_HOOKS=(\n  "Bash::hook2.sh"\n)\nAGY_ONLY_PRE_TOOL_USE_HOOKS=(\n)\nPOST_TOOL_USE_HOOKS=(\n)\n`,
    );
    await runGit(["add", "scripts/install-hooks.sh"]);
    await runGit(["commit", "-m", "Add codex hook to installer"]);
    await runGit(["update-ref", "refs/remotes/origin/dev", "HEAD"]);

    // git ls-tree branch
    assertEquals(
      await checkUnregisteredHooks(sb.repoDir, "origin/dev", sb.settingsPath),
      ["codex-reaper-startup-check.sh", "hook3.sh"],
    );
    // local-directory fallback branch (ref that git cannot resolve)
    assertEquals(
      await checkUnregisteredHooks(sb.repoDir, "no-such-ref", sb.settingsPath),
      ["codex-reaper-startup-check.sh", "hook3.sh"],
    );
  } finally {
    await sb.cleanup();
  }
});

// --- Test 4b: statusLine drift (web-jam-tools#691) ---
//
// scripts/statusline.sh's installed location is NOT a hooks.<Event>[]
// bucket entry (it lives under the top-level "statusLine" key), so it needs
// its own dead-path/unregistered coverage rather than reusing
// checkDeadHookPaths/checkUnregisteredHooks. The baseline sandbox
// (createSandbox()) never creates scripts/statusline.sh or a statusLine key,
// so the Test 1 "quiet" case is unaffected by any of this — both new checks
// report nothing when the script doesn't exist on origin/dev at all.

Deno.test("checkStatusLineDeadPath reports a dead statusLine path", async () => {
  const sb = await createSandbox();
  try {
    const settings = JSON.parse(await Deno.readTextFile(sb.settingsPath));
    settings.statusLine = {
      type: "command",
      command: "$HOME/.claude/hooks/statusline.sh",
    };
    await Deno.writeTextFile(sb.settingsPath, JSON.stringify(settings, null, 2));

    // No statusline.sh symlink was ever created in sb.hooksDir, so the
    // registered path is dead from the start.
    const dead = checkStatusLineDeadPath(sb.settingsPath, sb.homeDir);
    assertEquals(dead.length, 1);
    assertEquals(dead[0].event, "statusLine");
    assertEquals(dead[0].command, "$HOME/.claude/hooks/statusline.sh");

    const result = await detectDrift({
      repoDir: sb.repoDir,
      homeDir: sb.homeDir,
      settingsPath: sb.settingsPath,
      agyHooksPath: sb.agyHooksPath,
      remoteRef: "origin/dev",
    });
    assertEquals(result.statusLineDead.length, 1);

    const msg = formatDriftMessage(result);
    assert(msg.includes("Dead statusLine path in settings.json"), msg);
    assert(msg.includes("$HOME/.claude/hooks/statusline.sh"), msg);
  } finally {
    await sb.cleanup();
  }
});

Deno.test("checkStatusLineDeadPath reports nothing once the installed file exists", async () => {
  const sb = await createSandbox();
  try {
    await Deno.writeTextFile(
      path.join(sb.repoDir, "scripts/statusline.sh"),
      "#!/bin/bash\necho ok\n",
    );
    await Deno.symlink(
      path.join(sb.repoDir, "scripts/statusline.sh"),
      path.join(sb.hooksDir, "statusline.sh"),
    );

    const settings = JSON.parse(await Deno.readTextFile(sb.settingsPath));
    settings.statusLine = {
      type: "command",
      command: "$HOME/.claude/hooks/statusline.sh",
    };
    await Deno.writeTextFile(sb.settingsPath, JSON.stringify(settings, null, 2));

    assertEquals(checkStatusLineDeadPath(sb.settingsPath, sb.homeDir), []);
  } finally {
    await sb.cleanup();
  }
});

Deno.test("checkStatusLineUnregistered detects scripts/statusline.sh missing from settings.json, clears once registered", async () => {
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

    // Nothing added to settings.json's statusLine key yet — but
    // scripts/statusline.sh now exists on origin/dev.
    await Deno.writeTextFile(
      path.join(sb.repoDir, "scripts/statusline.sh"),
      "#!/bin/bash\necho ok\n",
    );
    await runGit(["add", "."]);
    await runGit(["commit", "-m", "Add statusline.sh"]);
    await runGit(["update-ref", "refs/remotes/origin/dev", "HEAD"]);

    const unreg = await checkStatusLineUnregistered(
      sb.repoDir,
      "origin/dev",
      sb.settingsPath,
    );
    assertEquals(unreg, true);

    const result = await detectDrift({
      repoDir: sb.repoDir,
      homeDir: sb.homeDir,
      settingsPath: sb.settingsPath,
      agyHooksPath: sb.agyHooksPath,
      remoteRef: "origin/dev",
    });
    assertEquals(result.statusLineUnregistered, true);

    const msg = formatDriftMessage(result);
    assert(
      msg.includes(
        "scripts/statusline.sh exists on origin/dev but settings.json has no statusLine registered.",
      ),
      msg,
    );

    // Now register it — drift must clear.
    const settings = JSON.parse(await Deno.readTextFile(sb.settingsPath));
    settings.statusLine = {
      type: "command",
      command: "$HOME/.claude/hooks/statusline.sh",
    };
    await Deno.writeTextFile(sb.settingsPath, JSON.stringify(settings, null, 2));
    await Deno.symlink(
      path.join(sb.repoDir, "scripts/statusline.sh"),
      path.join(sb.hooksDir, "statusline.sh"),
    );

    const clearedUnreg = await checkStatusLineUnregistered(
      sb.repoDir,
      "origin/dev",
      sb.settingsPath,
    );
    assertEquals(clearedUnreg, false);
  } finally {
    await sb.cleanup();
  }
});

Deno.test("checkStatusLineUnregistered reports unregistered when statusLine points at a different script", async () => {
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

    // scripts/statusline.sh exists on origin/dev...
    await Deno.writeTextFile(
      path.join(sb.repoDir, "scripts/statusline.sh"),
      "#!/bin/bash\necho ok\n",
    );
    await runGit(["add", "."]);
    await runGit(["commit", "-m", "Add statusline.sh"]);
    await runGit(["update-ref", "refs/remotes/origin/dev", "HEAD"]);

    // ...but settings.json's statusLine is a non-empty command pointing at a
    // COMPLETELY DIFFERENT script (a hand-pasted command, or a stale path to
    // some other file) rather than our statusline.sh. Presence of a
    // non-empty command must not be mistaken for OUR script being
    // registered — only a matching basename counts.
    const settings = JSON.parse(await Deno.readTextFile(sb.settingsPath));
    settings.statusLine = {
      type: "command",
      command: "$HOME/.claude/hooks/some-other-script.sh",
    };
    await Deno.writeTextFile(sb.settingsPath, JSON.stringify(settings, null, 2));

    const unreg = await checkStatusLineUnregistered(
      sb.repoDir,
      "origin/dev",
      sb.settingsPath,
    );
    assertEquals(unreg, true);

    const result = await detectDrift({
      repoDir: sb.repoDir,
      homeDir: sb.homeDir,
      settingsPath: sb.settingsPath,
      agyHooksPath: sb.agyHooksPath,
      remoteRef: "origin/dev",
    });
    assertEquals(result.statusLineUnregistered, true);
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

Deno.test("extractExpectedAgyHooksFromInstaller honours the installer's agy skip lines", async () => {
  const synthetic =
    `PRE_TOOL_USE_HOOKS=(\n  "Bash::hook2.sh"\n  "mcp__gmail__.*::skipped.sh"\n)\nAGY_ONLY_PRE_TOOL_USE_HOOKS=(\n)\nPOST_TOOL_USE_HOOKS=(\n)\n` +
    `merge_agy_pre_tool_use_args=()\nfor entry in "\${PRE_TOOL_USE_HOOKS[@]}"; do\n  [ "$name" = "skipped.sh" ] && continue\ndone\n`;
  assertEquals([...extractExpectedAgyHooksFromInstaller(synthetic)], ["hook2.sh"]);

  // The real installer: haiku-only-gmail-gate.sh is deliberately not registered in agy.
  const real = await Deno.readTextFile(path.join(REPO_ROOT, "scripts/install-hooks.sh"));
  const expected = extractExpectedAgyHooksFromInstaller(real);
  assert(!expected.has("haiku-only-gmail-gate.sh"));
  assert(expected.has("block-agy-gmail-send-delete.sh"));
});

// --- Claude Code drift check and surface-only hooks (web-jam-tools#1968) ---
//
// The ten literal cases of "Claude Code drift check and surface-only hooks" in
// hooks-design-2026-09-15.md (revision 3.10.0). scripts/install-hooks.sh is
// the single source of truth for which scripts belong in Claude Code's
// settings.json; no script filename is hardcoded in the checker.

interface InstallerArrays {
  sessionStart?: string[];
  sessionEnd?: string[];
  subagentStart?: string[];
  subagentStop?: string[];
  pre?: string[];
  codexOnlyPre?: string[];
  agyOnlyPre?: string[];
}

/** An installer laid out like the real one: Claude Code arrays first, surface-only arrays after. */
function installerFixture(a: InstallerArrays): string {
  // An empty array is written "(" then ")" on the next line, as bash and the
  // real installer write it.
  const multi = (name: string, items: string[] = []) =>
    `${name}=(\n${items.map((i) => `  "${i}"\n`).join("")})\n`;
  return `SESSION_START_HOOKS=(${["hook1.sh", ...(a.sessionStart ?? [])].join(" ")})\n` +
    `SESSION_END_HOOKS=(${(a.sessionEnd ?? []).join(" ")})\n` +
    `STOP_HOOKS=()\n` +
    `SUBAGENT_START_HOOKS=(${(a.subagentStart ?? []).join(" ")})\n` +
    `SUBAGENT_STOP_HOOKS=(${(a.subagentStop ?? []).join(" ")})\n` +
    multi("PRE_TOOL_USE_HOOKS", ["Bash::hook2.sh", ...(a.pre ?? [])]) +
    multi("CODEX_ONLY_PRE_TOOL_USE_HOOKS", a.codexOnlyPre) +
    multi("POST_TOOL_USE_HOOKS") +
    multi("AGY_ONLY_PRE_TOOL_USE_HOOKS", a.agyOnlyPre);
}

/** Writes hook scripts and the installer into the sandbox repo and moves origin/dev to them. */
async function commitToDev(sb: Sandbox, scripts: string[], installer: string): Promise<void> {
  for (const name of scripts) {
    await Deno.writeTextFile(path.join(sb.repoDir, "hooks", name), "#!/bin/bash\nexit 0\n");
  }
  await Deno.writeTextFile(path.join(sb.repoDir, "scripts/install-hooks.sh"), installer);
  for (
    const args of [
      ["add", "."],
      ["commit", "-m", "fixture"],
      ["update-ref", "refs/remotes/origin/dev", "HEAD"],
    ]
  ) {
    const out = await new Deno.Command("git", {
      args,
      cwd: sb.repoDir,
      stdout: "piped",
      stderr: "piped",
    })
      .output();
    if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  }
}

/** checkUnregisteredHooks through the git ls-tree scan and through the local-directory fallback. */
async function unregisteredBothWays(sb: Sandbox): Promise<[string[], string[]]> {
  return [
    await checkUnregisteredHooks(sb.repoDir, "origin/dev", sb.settingsPath),
    await checkUnregisteredHooks(sb.repoDir, "no-such-ref", sb.settingsPath),
  ];
}

Deno.test("drift case: block-codex-gmail-write.sh in CODEX_ONLY_PRE_TOOL_USE_HOOKS only is not reported", async () => {
  const sb = await createSandbox();
  try {
    await commitToDev(
      sb,
      ["block-codex-gmail-write.sh"],
      installerFixture({ codexOnlyPre: ["mcp__codex_apps__gmail_.*::block-codex-gmail-write.sh"] }),
    );
    assertEquals(await unregisteredBothWays(sb), [[], []]);
  } finally {
    await sb.cleanup();
  }
});

Deno.test("drift case: block-agy-gmail-send-delete.sh in AGY_ONLY_PRE_TOOL_USE_HOOKS only is not reported", async () => {
  const sb = await createSandbox();
  try {
    await commitToDev(
      sb,
      ["block-agy-gmail-send-delete.sh"],
      installerFixture({
        agyOnlyPre: ["mcp__gmail__.*|send_email::block-agy-gmail-send-delete.sh"],
      }),
    );
    assertEquals(await unregisteredBothWays(sb), [[], []]);
  } finally {
    await sb.cleanup();
  }
});

Deno.test("drift case: a new Codex-only hook with no codex- prefix is not reported (no hardcoded names)", async () => {
  const sb = await createSandbox();
  try {
    await commitToDev(
      sb,
      ["block-future-codex-guard.sh"],
      installerFixture({ codexOnlyPre: ["Bash::block-future-codex-guard.sh"] }),
    );
    assertEquals(await unregisteredBothWays(sb), [[], []]);
  } finally {
    await sb.cleanup();
  }
});

Deno.test("drift case: block-personal-numbers-read.sh in both PRE_TOOL_USE_HOOKS and AGY_ONLY stays expected", async () => {
  const sb = await createSandbox();
  try {
    await commitToDev(
      sb,
      ["block-personal-numbers-read.sh"],
      installerFixture({
        pre: ["Bash|Read::block-personal-numbers-read.sh"],
        agyOnlyPre: ["view_file|read_file::block-personal-numbers-read.sh"],
      }),
    );
    // Missing from settings.json -> reported on both scan paths.
    assertEquals(await unregisteredBothWays(sb), [
      ["block-personal-numbers-read.sh"],
      ["block-personal-numbers-read.sh"],
    ]);

    // Registered -> quiet.
    const settings = JSON.parse(await Deno.readTextFile(sb.settingsPath));
    settings.hooks.PreToolUse.push({
      matcher: "Bash|Read",
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/block-personal-numbers-read.sh" }],
    });
    await Deno.writeTextFile(sb.settingsPath, JSON.stringify(settings, null, 2));
    assertEquals(await unregisteredBothWays(sb), [[], []]);
  } finally {
    await sb.cleanup();
  }
});

Deno.test("drift case: SESSION_END_HOOKS and SUBAGENT_*_HOOKS scripts are expected", () => {
  const expected = extractExpectedHooksFromInstaller(installerFixture({
    sessionEnd: ["prune-permission-allows-on-session-end.sh"],
    subagentStart: ["track-subagent-start.sh"],
    subagentStop: ["track-subagent-stop.sh"],
  }));
  assert(expected.has("prune-permission-allows-on-session-end.sh"));
  assert(expected.has("track-subagent-start.sh"));
  assert(expected.has("track-subagent-stop.sh"));
});

Deno.test("drift case: agy-/codex- helper scripts in no Claude Code array are prefix-skipped", async () => {
  const sb = await createSandbox();
  try {
    await commitToDev(
      sb,
      ["agy-skill-run-hook.sh", "codex-reaper-startup-check.sh"],
      installerFixture({}),
    );
    // agy-hook-shim.sh is already in the sandbox's hooks/ directory.
    assertEquals(await unregisteredBothWays(sb), [[], []]);
  } finally {
    await sb.cleanup();
  }
});

Deno.test("drift case: codex-reaper-startup-check.sh listed in SESSION_START_HOOKS overrides the prefix skip", async () => {
  const sb = await createSandbox();
  try {
    await commitToDev(
      sb,
      ["codex-reaper-startup-check.sh"],
      installerFixture({ sessionStart: ["codex-reaper-startup-check.sh"] }),
    );
    assertEquals(await unregisteredBothWays(sb), [
      ["codex-reaper-startup-check.sh"],
      ["codex-reaper-startup-check.sh"],
    ]);
  } finally {
    await sb.cleanup();
  }
});

Deno.test("drift case: hook3.sh in hooks/ but in no installer array is reported", async () => {
  const sb = await createSandbox();
  try {
    await commitToDev(sb, ["hook3.sh"], installerFixture({}));
    assertEquals(await unregisteredBothWays(sb), [["hook3.sh"], ["hook3.sh"]]);
  } finally {
    await sb.cleanup();
  }
});

Deno.test("drift case: live scripts/install-hooks.sh separates Claude Code hooks from surface-only hooks", async () => {
  const installer = await Deno.readTextFile(path.join(REPO_ROOT, "scripts/install-hooks.sh"));
  const expected = extractExpectedHooksFromInstaller(installer);
  for (
    const name of [
      "prune-permission-allows-on-session-end.sh",
      "track-subagent-start.sh",
      "track-subagent-stop.sh",
      "block-personal-numbers-read.sh",
    ]
  ) {
    assert(expected.has(name), `expected ${name} in Claude Code's set`);
  }
  for (
    const name of [
      "block-codex-gmail-write.sh",
      "block-agy-gmail-send-delete.sh",
      "agy-model-guard.sh",
    ]
  ) {
    assert(!expected.has(name), `${name} must not be in Claude Code's set`);
  }
  const surfaceOnly = extractSurfaceOnlyHooksFromInstaller(installer);
  for (
    const name of [
      "block-codex-gmail-write.sh",
      "block-agy-gmail-send-delete.sh",
      "agy-model-guard.sh",
    ]
  ) {
    assert(surfaceOnly.has(name), `${name} must be in the surface-only set`);
  }
});

Deno.test("readInstallerHookArray anchors array names so STOP_HOOKS never reads SUBAGENT_STOP_HOOKS", () => {
  const installer =
    `SUBAGENT_STOP_HOOKS=(track-subagent-stop.sh)\nSTOP_HOOKS=(stop-a.sh stop-b.sh)\n` +
    `CODEX_ONLY_PRE_TOOL_USE_HOOKS=(\n  "Bash::codex-only.sh"\n)\nPRE_TOOL_USE_HOOKS=(\n  "Bash::claude.sh" # trailing note\n)\n`;
  assertEquals(readInstallerHookArray(installer, "STOP_HOOKS"), ["stop-a.sh", "stop-b.sh"]);
  assertEquals(readInstallerHookArray(installer, "PRE_TOOL_USE_HOOKS"), ["claude.sh"]);
  assertEquals(readInstallerHookArray(installer, "SESSION_END_HOOKS"), []);
});

Deno.test("readInstallerHookArray stops an empty multi-line array at its own closing paren", () => {
  const installer =
    `POST_TOOL_USE_HOOKS=(\n)\nAGY_ONLY_PRE_TOOL_USE_HOOKS=(\n  ".*::agy-model-guard.sh"\n)\n` +
    `CODEX_ONLY_PRE_TOOL_USE_HOOKS=(\n)\nPRE_TOOL_USE_HOOKS=(\n  "Bash::claude.sh"\n)\n`;
  assertEquals(readInstallerHookArray(installer, "POST_TOOL_USE_HOOKS"), []);
  assertEquals(readInstallerHookArray(installer, "AGY_ONLY_PRE_TOOL_USE_HOOKS"), [
    "agy-model-guard.sh",
  ]);
  assertEquals(readInstallerHookArray(installer, "CODEX_ONLY_PRE_TOOL_USE_HOOKS"), []);
  assert(!extractExpectedHooksFromInstaller(installer).has("agy-model-guard.sh"));
  assertEquals([...extractSurfaceOnlyHooksFromInstaller(installer)], ["agy-model-guard.sh"]);
});

Deno.test("readInstallerHookArray reads arrays whose declaration line carries a trailing comment", () => {
  const installer = `STOP_HOOKS=(stop-a.sh) # Stop event (Claude Code)\n` +
    `PRE_TOOL_USE_HOOKS=( # matcher::script\n  "Bash::claude.sh"\n) # end\n`;
  assertEquals(readInstallerHookArray(installer, "STOP_HOOKS"), ["stop-a.sh"]);
  assertEquals(readInstallerHookArray(installer, "PRE_TOOL_USE_HOOKS"), ["claude.sh"]);
});

Deno.test("hooks/hook-install-drift-reminder.sh stays quiet end-to-end for a Codex-only hook", async () => {
  const sb = await createSandbox();
  try {
    await commitToDev(
      sb,
      ["block-codex-gmail-write.sh"],
      installerFixture({ codexOnlyPre: ["mcp__codex_apps__gmail_.*::block-codex-gmail-write.sh"] }),
    );
    const env = {
      CLAUDE_HOOKS_REPO_DIR: sb.repoDir,
      CLAUDE_SETTINGS_PATH: sb.settingsPath,
      AGY_HOOKS_PATH: sb.agyHooksPath,
      HOOKS_REMOTE_REF: "origin/dev",
      CLAUDE_HOME: sb.homeDir,
    };
    const quiet = await runHookScript(env);
    assertEquals(quiet.code, 0, quiet.stderr);
    assertEquals(quiet.stdout.trim(), "");

    // A genuinely unregistered Claude Code hook is still reported end-to-end.
    await commitToDev(
      sb,
      ["hook3.sh"],
      installerFixture({ codexOnlyPre: ["mcp__codex_apps__gmail_.*::block-codex-gmail-write.sh"] }),
    );
    const drift = await runHookScript(env);
    assertEquals(drift.code, 0, drift.stderr);
    const msg = JSON.parse(drift.stdout).systemMessage as string;
    assert(msg.includes("• hook3.sh"), msg);
    assert(!msg.includes("block-codex-gmail-write.sh"), msg);
  } finally {
    await sb.cleanup();
  }
});
