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
const MERGE_SCRIPT = `${REPO_ROOT}scripts/merge-hooks-into-settings.py`;
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
): Promise<RunResult> {
  const command = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
    env,
  });
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
  // exactly as they would against the real repo.
  await Deno.mkdir(`${mainRepo}/scripts`, { recursive: true });
  await Deno.copyFile(INSTALL_SCRIPT, `${mainRepo}/scripts/install-hooks.sh`);
  await Deno.chmod(`${mainRepo}/scripts/install-hooks.sh`, 0o755);
  await Deno.copyFile(MERGE_SCRIPT, `${mainRepo}/scripts/merge-hooks-into-settings.py`);
  await Deno.mkdir(`${mainRepo}/hooks`, { recursive: true });
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
