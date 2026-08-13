// install_hooks_script.test.ts — web-jam-tools#273
//
// Exercises scripts/install-hooks.sh itself (the --hooks-dir override and the
// git-worktree refusal guard) — unlike install_hooks_merge.test.ts, which
// deliberately stays away from this script's symlink step because, before
// #273, there was no way to run it without repointing the live
// ~/.claude/hooks symlinks.
//
// Every invocation in this file is sandboxed so the real ~/.claude is never
// touched:
//   - the override test passes both --hooks-dir and --settings-path pointing
//     at temp dirs — exactly the shape web-jam-tools#273 asks for;
//   - the default-destination and worktree-refusal tests below exist to
//     exercise the NO-OVERRIDE code path (that's the whole point of both —
//     see acceptance criteria on #273), so they cannot also pass
//     --hooks-dir. Instead they redirect the subprocess's HOME env var to a
//     scratch directory, so "$HOME/.claude/hooks" never resolves to a real
//     path even though --hooks-dir is intentionally omitted. This is a
//     deliberate, disclosed deviation from "always pass both flags" — see
//     the PR description.
//   - the worktree-refusal test additionally builds a throwaway git repo +
//     linked worktree under a temp dir (never the real web-jam-tools
//     checkout) so the guard's git-worktree detection is exercised
//     deterministically, regardless of whether this suite happens to be run
//     from a worktree itself.

import { assert, assertEquals } from "@std/assert";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const INSTALL_SCRIPT = `${REPO_ROOT}scripts/install-hooks.sh`;
const MERGE_SCRIPT = `${REPO_ROOT}scripts/merge-hooks-into-settings.ts`;
const MERGE_AGENTS_MD_SCRIPT = `${REPO_ROOT}scripts/merge-agents-md-pointer.ts`;
const HOOKS_SRC_DIR = `${REPO_ROOT}hooks`;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  cmd: string,
  args: string[],
  env?: Record<string, string>,
  stdinText?: string,
): Promise<RunResult> {
  const command = new Deno.Command(cmd, {
    args,
    stdin: stdinText !== undefined ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
    env: env ? { ...Deno.env.toObject(), ...env } : undefined,
  });

  if (stdinText !== undefined) {
    const child = command.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdinText));
    await writer.close();
    const { code, stdout, stderr } = await child.output();
    return {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  }
  const { code, stdout, stderr } = await command.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

function shHookNames(): string[] {
  return [...Deno.readDirSync(HOOKS_SRC_DIR)]
    .filter((e) => e.isFile && e.name.endsWith(".sh"))
    .map((e) => e.name)
    .sort();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

// --- --hooks-dir + --settings-path: writes nothing outside those paths ---

Deno.test("install-hooks.sh --hooks-dir + --settings-path writes only inside those paths", async () => {
  const hooksDir = await Deno.makeTempDir();
  const settingsDir = await Deno.makeTempDir();
  const settingsPath = `${settingsDir}/settings.json`;
  try {
    const res = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
    ]);
    assertEquals(res.code, 0, res.stdout + res.stderr);

    const linked = [...Deno.readDirSync(hooksDir)].map((e) => e.name).sort();
    assertEquals(linked, shHookNames());
    for (const name of linked) {
      const info = await Deno.lstat(`${hooksDir}/${name}`);
      assert(info.isSymlink, `${name} should be a symlink`);
    }

    const settings = JSON.parse(await Deno.readTextFile(settingsPath));
    assert(settings.hooks.SessionStart.length > 0);
    assert(settings.hooks.PreToolUse.length > 0);
    // web-jam-tools#308: DENY_RULES land in permissions.deny too.
    assert(Array.isArray(settings.permissions?.deny) && settings.permissions.deny.length > 0);
    assert(
      settings.permissions.deny.includes("Bash(git push --delete *)"),
      "expected the git push --delete deny pattern to be present",
    );

    // web-jam-tools#345: agy hooks.json is also created and populated
    const agyHooksPath = `${settingsDir}/hooks.json`;
    const agyHooks = JSON.parse(await Deno.readTextFile(agyHooksPath));
    assert(agyHooks.hooks.PreToolUse.length > 0, "expected PreToolUse in agy hooks.json");
    assert(agyHooks.hooks.PostToolUse.length > 0, "expected PostToolUse in agy hooks.json");
  } finally {
    await Deno.remove(hooksDir, { recursive: true });
    await Deno.remove(settingsDir, { recursive: true });
  }
});

Deno.test(
  "symlinked hook scripts execute correctly via symlink paths (readlink -f resolution)",
  async () => {
    const hooksDir = await Deno.makeTempDir();
    const settingsDir = await Deno.makeTempDir();
    const settingsPath = `${settingsDir}/settings.json`;
    try {
      const res = await run("bash", [
        INSTALL_SCRIPT,
        "--hooks-dir",
        hooksDir,
        "--settings-path",
        settingsPath,
      ]);
      assertEquals(res.code, 0, res.stdout + res.stderr);

      // Test execution of require-model-label-on-issue-create.sh via the symlinked path
      const labelHookSymlink = `${hooksDir}/require-model-label-on-issue-create.sh`;
      const passRes = await run(
        "bash",
        [labelHookSymlink],
        {},
        JSON.stringify({
          tool_input: {
            command:
              'gh issue create --repo WebJamApps/web-jam-tools --title "test" --body "standalone body text" --type Task --label Sonnet',
          },
        }),
      );
      assertEquals(passRes.code, 0, passRes.stderr + passRes.stdout);

      const blockRes = await run(
        "bash",
        [labelHookSymlink],
        {},
        JSON.stringify({
          tool_input: {
            command:
              'gh issue create --repo WebJamApps/web-jam-tools --title "test" --body "test" --label bug',
          },
        }),
      );
      assertEquals(blockRes.code, 2, blockRes.stdout + blockRes.stderr);

      // Test execution of block-dangerous-git-deploy.sh via the symlinked path
      const deployHookSymlink = `${hooksDir}/block-dangerous-git-deploy.sh`;
      const deployBlockRes = await run(
        "bash",
        [deployHookSymlink],
        {},
        JSON.stringify({
          tool_input: {
            command: "git push origin :b",
          },
        }),
      );
      assertEquals(deployBlockRes.code, 2, deployBlockRes.stdout + deployBlockRes.stderr);
    } finally {
      await Deno.remove(hooksDir, { recursive: true });
      await Deno.remove(settingsDir, { recursive: true });
    }
  },
);

// --- CLAUDE_SETTINGS_PATH env override (web-jam-tools#308) ---

Deno.test(
  "CLAUDE_SETTINGS_PATH env var is honored for the deny-rule merge, same as --settings-path",
  async () => {
    const hooksDir = await Deno.makeTempDir();
    const settingsDir = await Deno.makeTempDir();
    const settingsPath = `${settingsDir}/settings.json`;
    try {
      const res = await run(
        "bash",
        [INSTALL_SCRIPT, "--hooks-dir", hooksDir],
        { CLAUDE_SETTINGS_PATH: settingsPath },
      );
      assertEquals(res.code, 0, res.stdout + res.stderr);

      const settings = JSON.parse(await Deno.readTextFile(settingsPath));
      assert(
        settings.permissions?.deny?.includes("Bash(git push --force *)"),
        "expected the git push --force deny pattern to be present via CLAUDE_SETTINGS_PATH",
      );

      // Re-run: idempotent, no duplicate entries.
      const second = await run(
        "bash",
        [INSTALL_SCRIPT, "--hooks-dir", hooksDir],
        { CLAUDE_SETTINGS_PATH: settingsPath },
      );
      assertEquals(second.code, 0, second.stdout + second.stderr);
      const settings2 = JSON.parse(await Deno.readTextFile(settingsPath));
      assertEquals(settings2.permissions.deny.length, settings.permissions.deny.length);
    } finally {
      await Deno.remove(hooksDir, { recursive: true });
      await Deno.remove(settingsDir, { recursive: true });
    }
  },
);

Deno.test("AGY_HOOKS_PATH or --agy-hooks-path env var/flag is honored", async () => {
  const hooksDir = await Deno.makeTempDir();
  const settingsDir = await Deno.makeTempDir();
  const settingsPath = `${settingsDir}/settings.json`;
  const agyHooksPath = `${settingsDir}/custom_agy_hooks.json`;
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
    assert(agyHooks.hooks.PreToolUse.length > 0);
    assert(agyHooks.hooks.PostToolUse.length > 0);
  } finally {
    await Deno.remove(hooksDir, { recursive: true });
    await Deno.remove(settingsDir, { recursive: true });
  }
});

// --- Default destination formula is unchanged ---

Deno.test("default invocation (no --hooks-dir) still targets $HOME/.claude/hooks", async () => {
  const home = await Deno.makeTempDir();
  const settingsDir = await Deno.makeTempDir();
  try {
    const res = await run(
      "bash",
      [
        INSTALL_SCRIPT,
        "--settings-path",
        `${settingsDir}/settings.json`,
        // --force bypasses the worktree guard (tested separately below) so
        // this test is deterministic whether or not this suite happens to
        // run from a worktree itself. HOME is redirected below so "the
        // default destination" this test exercises is never ~/.claude.
        "--force",
      ],
      { HOME: home },
    );
    assertEquals(res.code, 0, res.stdout + res.stderr);
    const hooksDir = `${home}/.claude/hooks`;
    assert(await pathExists(hooksDir), "expected hooks dir under $HOME/.claude/hooks");
    const linked = [...Deno.readDirSync(hooksDir)].map((e) => e.name).sort();
    assertEquals(linked, shHookNames());
  } finally {
    await Deno.remove(home, { recursive: true });
    await Deno.remove(settingsDir, { recursive: true });
  }
});

// --- Worktree refusal ---

async function withTempWorktree(fn: (worktreePath: string) => Promise<void>): Promise<void> {
  const base = await Deno.makeTempDir();
  const mainRepo = `${base}/main`;
  const worktree = `${base}/wt`;
  await Deno.mkdir(mainRepo, { recursive: true });
  await run("git", ["-C", mainRepo, "init", "-q", "-b", "main"]);
  await run("git", ["-C", mainRepo, "config", "user.email", "test@example.invalid"]);
  await run("git", ["-C", mainRepo, "config", "user.name", "Test"]);

  // Copy the real script + its merge helper + the real hooks/*.sh so the
  // SESSION_START_HOOKS/PRE_TOOL_USE_HOOKS existence checks (and, for the
  // tests that go all the way through, the actual merge step) succeed
  await Deno.copyFile(`${REPO_ROOT}deno.json`, `${mainRepo}/deno.json`);
  await Deno.mkdir(`${mainRepo}/scripts`, { recursive: true });
  await Deno.copyFile(INSTALL_SCRIPT, `${mainRepo}/scripts/install-hooks.sh`);
  await Deno.chmod(`${mainRepo}/scripts/install-hooks.sh`, 0o755);
  await Deno.copyFile(MERGE_SCRIPT, `${mainRepo}/scripts/merge-hooks-into-settings.ts`);
  await Deno.copyFile(MERGE_AGENTS_MD_SCRIPT, `${mainRepo}/scripts/merge-agents-md-pointer.ts`);
  await Deno.mkdir(`${mainRepo}/hooks/lib`, { recursive: true });
  for (const entry of Deno.readDirSync(`${HOOKS_SRC_DIR}/lib`)) {
    if (entry.isFile) {
      await Deno.copyFile(
        `${HOOKS_SRC_DIR}/lib/${entry.name}`,
        `${mainRepo}/hooks/lib/${entry.name}`,
      );
    }
  }
  for (const name of shHookNames()) {
    await Deno.copyFile(`${HOOKS_SRC_DIR}/${name}`, `${mainRepo}/hooks/${name}`);
    await Deno.chmod(`${mainRepo}/hooks/${name}`, 0o755);
  }

  await run("git", ["-C", mainRepo, "add", "-A"]);
  const commit = await run("git", ["-C", mainRepo, "commit", "-q", "-m", "init"]);
  assertEquals(commit.code, 0, commit.stderr);

  const add = await run("git", [
    "-C",
    mainRepo,
    "worktree",
    "add",
    "-q",
    "--detach",
    worktree,
    "HEAD",
  ]);
  assertEquals(add.code, 0, add.stderr);

  try {
    await fn(worktree);
  } finally {
    await run("git", ["-C", mainRepo, "worktree", "remove", "--force", worktree]);
    await Deno.remove(base, { recursive: true });
  }
}

Deno.test("refuses to link into the default destination from a git worktree without --force", async () => {
  await withTempWorktree(async (worktree) => {
    const home = await Deno.makeTempDir();
    const settingsDir = await Deno.makeTempDir();
    try {
      const res = await run(
        "bash",
        [
          `${worktree}/scripts/install-hooks.sh`,
          "--settings-path",
          `${settingsDir}/settings.json`,
        ],
        { HOME: home },
      );
      assert(res.code !== 0, "expected the worktree guard to refuse");
      assert(res.stderr.includes("git worktree"), res.stderr);
      assert(res.stderr.includes("web-jam-tools#273"), res.stderr);
      assert(
        !(await pathExists(`${home}/.claude/hooks`)),
        "guard must refuse before creating anything under the default destination",
      );
    } finally {
      await Deno.remove(home, { recursive: true });
      await Deno.remove(settingsDir, { recursive: true });
    }
  });
});

Deno.test("--force allows linking into the default destination from a git worktree", async () => {
  await withTempWorktree(async (worktree) => {
    const home = await Deno.makeTempDir();
    const settingsDir = await Deno.makeTempDir();
    try {
      const res = await run(
        "bash",
        [
          `${worktree}/scripts/install-hooks.sh`,
          "--settings-path",
          `${settingsDir}/settings.json`,
          "--force",
        ],
        { HOME: home },
      );
      assertEquals(res.code, 0, res.stdout + res.stderr);
      assert(await pathExists(`${home}/.claude/hooks`));
    } finally {
      await Deno.remove(home, { recursive: true });
      await Deno.remove(settingsDir, { recursive: true });
    }
  });
});

Deno.test("--hooks-dir is exempt from the worktree guard (no --force needed)", async () => {
  await withTempWorktree(async (worktree) => {
    const hooksDir = await Deno.makeTempDir();
    const settingsDir = await Deno.makeTempDir();
    try {
      const res = await run("bash", [
        `${worktree}/scripts/install-hooks.sh`,
        "--hooks-dir",
        hooksDir,
        "--settings-path",
        `${settingsDir}/settings.json`,
      ]);
      assertEquals(res.code, 0, res.stdout + res.stderr);
    } finally {
      await Deno.remove(hooksDir, { recursive: true });
      await Deno.remove(settingsDir, { recursive: true });
    }
  });
});

// --- --check mode and secret-scan gate (web-jam-tools#339) ---

Deno.test("install-hooks.sh --check passes on a clean sandboxed installation", async () => {
  const hooksDir = await Deno.makeTempDir();
  const settingsDir = await Deno.makeTempDir();
  const settingsPath = `${settingsDir}/settings.json`;
  try {
    const installRes = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
    ]);
    assertEquals(installRes.code, 0, installRes.stdout + installRes.stderr);

    const checkRes = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--check",
    ]);
    assertEquals(checkRes.code, 0, checkRes.stdout + checkRes.stderr);
    assert(checkRes.stdout.includes("check passed (no drift)"));
  } finally {
    await Deno.remove(hooksDir, { recursive: true });
    await Deno.remove(settingsDir, { recursive: true });
  }
});

Deno.test("install-hooks.sh --check reports drift when a rule is removed from settings", async () => {
  const hooksDir = await Deno.makeTempDir();
  const settingsDir = await Deno.makeTempDir();
  const settingsPath = `${settingsDir}/settings.json`;
  try {
    const installRes = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
    ]);
    assertEquals(installRes.code, 0, installRes.stdout + installRes.stderr);

    // Remove DENY_RULES from settings.json
    const settings = JSON.parse(await Deno.readTextFile(settingsPath));
    settings.permissions.deny = [];
    await Deno.writeTextFile(settingsPath, JSON.stringify(settings, null, 2));

    const checkRes = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--check",
    ]);
    assert(checkRes.code !== 0, "expected --check to fail when rule is missing");
    assert(checkRes.stderr.includes("missing permissions.deny rule"));
    assert(checkRes.stderr.includes("error: drift detected"));
  } finally {
    await Deno.remove(hooksDir, { recursive: true });
    await Deno.remove(settingsDir, { recursive: true });
  }
});

Deno.test("install-hooks.sh --check reports drift when a hook symlink is missing", async () => {
  const hooksDir = await Deno.makeTempDir();
  const settingsDir = await Deno.makeTempDir();
  const settingsPath = `${settingsDir}/settings.json`;
  try {
    const installRes = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
    ]);
    assertEquals(installRes.code, 0, installRes.stdout + installRes.stderr);

    // Remove one hook symlink
    await Deno.remove(`${hooksDir}/semver-push-reminder.sh`);

    const checkRes = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--check",
    ]);
    assert(checkRes.code !== 0, "expected --check to fail when hook symlink is removed");
    assert(checkRes.stderr.includes("drift: hook script semver-push-reminder.sh is not linked"));
  } finally {
    await Deno.remove(hooksDir, { recursive: true });
    await Deno.remove(settingsDir, { recursive: true });
  }
});

Deno.test("install-hooks.sh secret-scan gate fails closed with synthetic JWT fixture", async () => {
  const hooksDir = await Deno.makeTempDir();
  const settingsDir = await Deno.makeTempDir();
  const settingsPath = `${settingsDir}/settings.json`;
  const jwtSecret = "eyJ" + "X".repeat(20) + "." + "Y".repeat(20) + "." + "Z".repeat(20);
  try {
    await Deno.writeTextFile(
      settingsPath,
      JSON.stringify({
        permissions: {
          allow: [`Bash(export TOKEN="${jwtSecret}")`],
        },
      }),
    );

    const installRes = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
    ]);
    assert(installRes.code !== 0, "secret-scan gate must fail closed");
    assert(installRes.stderr.includes("CREDENTIAL-SHAPED LITERAL(S) FOUND"));
    assert(installRes.stderr.includes("JWT token"));
    assert(
      !installRes.stderr.includes(jwtSecret),
      "secret literal value must not be leaked in output",
    );
  } finally {
    await Deno.remove(hooksDir, { recursive: true });
    await Deno.remove(settingsDir, { recursive: true });
  }
});

async function symlinkExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

// --- Orphaned symlink detection and --check drift (web-jam-tools#430) ---

Deno.test(
  "install-hooks.sh prunes orphaned/dangling symlinks whose target no longer exists",
  async () => {
    const hooksDir = await Deno.makeTempDir();
    const settingsDir = await Deno.makeTempDir();
    const settingsPath = `${settingsDir}/settings.json`;
    try {
      const firstInstall = await run("bash", [
        INSTALL_SCRIPT,
        "--hooks-dir",
        hooksDir,
        "--settings-path",
        settingsPath,
      ]);
      assertEquals(firstInstall.code, 0, firstInstall.stdout + firstInstall.stderr);

      // Create an orphaned dangling symlink in hooksDir
      const danglingPath = `${hooksDir}/retired-hook.sh`;
      await Deno.symlink(`${HOOKS_SRC_DIR}/retired-hook.sh`, danglingPath);
      assert(await symlinkExists(danglingPath), "dangling symlink created");

      const secondInstall = await run("bash", [
        INSTALL_SCRIPT,
        "--hooks-dir",
        hooksDir,
        "--settings-path",
        settingsPath,
      ]);
      assertEquals(secondInstall.code, 0, secondInstall.stdout + secondInstall.stderr);
      assert(
        secondInstall.stdout.includes("retired-hook.sh: pruned orphaned symlink"),
        secondInstall.stdout,
      );
      assert(!(await symlinkExists(danglingPath)), "dangling symlink must be removed");
    } finally {
      await Deno.remove(hooksDir, { recursive: true });
      await Deno.remove(settingsDir, { recursive: true });
    }
  },
);

Deno.test(
  "install-hooks.sh --check reports drift on dangling symlinks and stale entries",
  async () => {
    const hooksDir = await Deno.makeTempDir();
    const settingsDir = await Deno.makeTempDir();
    const settingsPath = `${settingsDir}/settings.json`;
    try {
      const installRes = await run("bash", [
        INSTALL_SCRIPT,
        "--hooks-dir",
        hooksDir,
        "--settings-path",
        settingsPath,
      ]);
      assertEquals(installRes.code, 0, installRes.stdout + installRes.stderr);

      // 1. Add dangling symlink
      const danglingPath = `${hooksDir}/dangling-check.sh`;
      await Deno.symlink(`${HOOKS_SRC_DIR}/dangling-check.sh`, danglingPath);

      // 2. Add stale/retired hook entry in settings.json
      const settings = JSON.parse(await Deno.readTextFile(settingsPath));
      settings.hooks.SessionStart.push({
        hooks: [{ type: "command", command: "$HOME/.claude/hooks/retired-start.sh" }],
      });
      await Deno.writeTextFile(settingsPath, JSON.stringify(settings, null, 2));

      const checkRes = await run("bash", [
        INSTALL_SCRIPT,
        "--hooks-dir",
        hooksDir,
        "--settings-path",
        settingsPath,
        "--check",
      ]);
      assert(checkRes.code !== 0, "expected --check to fail when drift is present");
      assert(checkRes.stderr.includes("drift: orphaned symlink dangling-check.sh"));
      assert(checkRes.stderr.includes("has retired SessionStart hook"));
    } finally {
      await Deno.remove(hooksDir, { recursive: true });
      await Deno.remove(settingsDir, { recursive: true });
    }
  },
);

Deno.test(
  "install-hooks.sh merges rules pointer into AGENTS.md, preserves pre-existing content, and is idempotent",
  async () => {
    const hooksDir = await Deno.makeTempDir();
    const settingsDir = await Deno.makeTempDir();
    const settingsPath = `${settingsDir}/settings.json`;
    const agentsMdPath = `${settingsDir}/AGENTS.md`;

    try {
      const initialContent =
        `# Pre-existing Header\n\nPre-existing intro text.\n\n## Pre-existing Section\nItem A\nItem B\n`;
      await Deno.writeTextFile(agentsMdPath, initialContent);

      const firstRun = await run("bash", [
        INSTALL_SCRIPT,
        "--hooks-dir",
        hooksDir,
        "--settings-path",
        settingsPath,
        "--agents-md-path",
        agentsMdPath,
      ]);
      assertEquals(firstRun.code, 0, firstRun.stdout + firstRun.stderr);

      const contentAfterFirst = await Deno.readTextFile(agentsMdPath);
      assert(contentAfterFirst.includes("## Cross-AI hard rules"), "expected rules pointer header");
      assert(contentAfterFirst.includes("docs/cross-ai-rules.md"), "expected pointer target file");
      assert(contentAfterFirst.includes("# Pre-existing Header"), "pre-existing header preserved");
      assert(contentAfterFirst.includes("Item A"), "pre-existing body text preserved");

      // Idempotency: run a second time
      const secondRun = await run("bash", [
        INSTALL_SCRIPT,
        "--hooks-dir",
        hooksDir,
        "--settings-path",
        settingsPath,
        "--agents-md-path",
        agentsMdPath,
      ]);
      assertEquals(secondRun.code, 0, secondRun.stdout + secondRun.stderr);

      const contentAfterSecond = await Deno.readTextFile(agentsMdPath);
      const pointerOccurrences = contentAfterSecond.split("## Cross-AI hard rules").length - 1;
      assertEquals(pointerOccurrences, 1, "rules pointer must not be duplicated on second run");

      // Check mode passes
      const checkRun = await run("bash", [
        INSTALL_SCRIPT,
        "--hooks-dir",
        hooksDir,
        "--settings-path",
        settingsPath,
        "--agents-md-path",
        agentsMdPath,
        "--check",
      ]);
      assertEquals(checkRun.code, 0, checkRun.stdout + checkRun.stderr);
      assert(checkRun.stdout.includes("check passed"));
    } finally {
      await Deno.remove(hooksDir, { recursive: true });
      await Deno.remove(settingsDir, { recursive: true });
    }
  },
);

Deno.test(
  "install-hooks.sh --check reports drift when AGENTS.md rules pointer is missing or out-of-date",
  async () => {
    const hooksDir = await Deno.makeTempDir();
    const settingsDir = await Deno.makeTempDir();
    const settingsPath = `${settingsDir}/settings.json`;
    const agentsMdPath = `${settingsDir}/AGENTS.md`;

    try {
      const installRes = await run("bash", [
        INSTALL_SCRIPT,
        "--hooks-dir",
        hooksDir,
        "--settings-path",
        settingsPath,
        "--agents-md-path",
        agentsMdPath,
      ]);
      assertEquals(installRes.code, 0, installRes.stdout + installRes.stderr);

      // Strip out the pointer from AGENTS.md to simulate drift
      await Deno.writeTextFile(agentsMdPath, "# Just Some Content\n\nNo rules pointer here.\n");

      const checkRes = await run("bash", [
        INSTALL_SCRIPT,
        "--hooks-dir",
        hooksDir,
        "--settings-path",
        settingsPath,
        "--agents-md-path",
        agentsMdPath,
        "--check",
      ]);
      assert(
        checkRes.code !== 0,
        "expected --check to fail when AGENTS.md rules pointer is missing",
      );
      assert(checkRes.stderr.includes("out-of-date rules pointer"));
      assert(checkRes.stderr.includes("error: drift detected"));
    } finally {
      await Deno.remove(hooksDir, { recursive: true });
      await Deno.remove(settingsDir, { recursive: true });
    }
  },
);
