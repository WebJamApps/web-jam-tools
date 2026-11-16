// test/git_hooks_reference_transaction.test.ts — web-jam-tools#1820
// Shell-driven Deno tests for git-hooks/reference-transaction against every row
// of the at-git table in draft-pr-design.md ("Appendix A — Case list").

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";

const ROOT_DIR = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const HOOKS_DIR = path.join(ROOT_DIR, "git-hooks");

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGit(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<CmdResult> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: {
      ...Deno.env.toObject(),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      ...env,
    },
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

interface Fixture {
  root: string;
  upstream: string;
  clone: string;
  otherRepo: string;
  env: Record<string, string>;
}

async function setupCanonicalCloneFixture(
  prefix: string,
  opts: { withHooksPath?: boolean; useCanonicalEnv?: boolean } = {},
): Promise<Fixture> {
  const { withHooksPath = true, useCanonicalEnv = false } = opts;
  const root = await Deno.makeTempDir({ prefix });
  const fakeHome = path.join(root, "home");
  const upstream = path.join(root, "upstream.git");
  const clone = path.join(fakeHome, "WebJamApps", "web-jam-tools");
  const otherRepo = path.join(fakeHome, "WebJamApps", "JaMmusic");
  const writer = path.join(root, "writer");
  await Deno.mkdir(path.join(fakeHome, "WebJamApps"), { recursive: true });

  const env: Record<string, string> = {
    HOME: fakeHome,
    ...(useCanonicalEnv ? { CANONICAL_CLONE_DIR: clone } : {}),
  };

  assertEquals((await runGit(["init", "--bare", "-b", "dev", "-q", upstream], root, env)).code, 0);
  assertEquals((await runGit(["clone", "-q", upstream, writer], root, env)).code, 0);
  await runGit(["config", "user.name", "Test User"], writer, env);
  await runGit(["config", "user.email", "test@example.com"], writer, env);
  await Deno.writeTextFile(path.join(writer, "file.txt"), "base\n");
  assertEquals((await runGit(["add", "file.txt"], writer, env)).code, 0);
  assertEquals((await runGit(["commit", "-q", "-m", "initial"], writer, env)).code, 0);
  assertEquals((await runGit(["push", "-q", "-u", "origin", "dev"], writer, env)).code, 0);

  assertEquals((await runGit(["clone", "-q", upstream, clone], root, env)).code, 0);
  await runGit(["config", "user.name", "Test User"], clone, env);
  await runGit(["config", "user.email", "test@example.com"], clone, env);
  if (withHooksPath) {
    await runGit(["config", "core.hooksPath", HOOKS_DIR], clone, env);
  }

  return { root, upstream, clone, otherRepo, env };
}

// Git < 2.40 prints `fatal: in 'prepared'|'preparing' phase, update aborted by the reference-transaction hook`,
// while newer git (>= 2.41+) prints `fatal: ref updates aborted by hook`.
const GIT_ABORTED_RE =
  /fatal: (?:ref updates aborted by hook|in 'prepar(?:ed|ing)' phase, update aborted by the reference-transaction hook)/;

function assertHookAborted(stderr: string): void {
  assert(
    GIT_ABORTED_RE.test(stderr),
    `expected git reference-transaction abort message in stderr, got:\n${stderr}`,
  );
}

async function currentHeadRef(repoDir: string, env: Record<string, string>): Promise<string> {
  const res = await runGit(["symbolic-ref", "-q", "HEAD"], repoDir, env);
  return res.stdout.trim();
}

Deno.test("Row 1: git switch -c other in canonical clone is refused and leaves branch other made", async () => {
  const fx = await setupCanonicalCloneFixture("rt-row1-");
  try {
    const res = await runGit(["switch", "-c", "other"], fx.clone, fx.env);
    assert(res.code !== 0, "expected git switch -c other to fail");
    assertHookAborted(res.stderr);
    assertStringIncludes(res.stderr, "BLOCKED (reference-transaction)");
    assertStringIncludes(res.stderr, "-c core.hooksPath=/dev/null");
    assertStringIncludes(res.stderr, "Report the clone's state to Josh");
    assertStringIncludes(res.stderr, "NEVER reset");
    assertEquals(await currentHeadRef(fx.clone, fx.env), "refs/heads/dev");
    const branchCheck = await runGit(
      ["show-ref", "--verify", "--quiet", "refs/heads/other"],
      fx.clone,
      fx.env,
    );
    assertEquals(branchCheck.code, 0, "branch other should remain created");
  } finally {
    await Deno.remove(fx.root, { recursive: true }).catch(() => {});
  }
});

Deno.test("Row 2: git switch other (existing branch) in canonical clone is refused", async () => {
  const fx = await setupCanonicalCloneFixture("rt-row2-");
  try {
    assertEquals((await runGit(["branch", "other"], fx.clone, fx.env)).code, 0);
    const res = await runGit(["switch", "other"], fx.clone, fx.env);
    assert(res.code !== 0, "expected git switch other to fail");
    assertHookAborted(res.stderr);
    assertStringIncludes(res.stderr, "BLOCKED (reference-transaction)");
    assertEquals(await currentHeadRef(fx.clone, fx.env), "refs/heads/dev");
  } finally {
    await Deno.remove(fx.root, { recursive: true }).catch(() => {});
  }
});

Deno.test("Row 3: git checkout HEAD~0 (detached) in canonical clone is refused", async () => {
  const fx = await setupCanonicalCloneFixture("rt-row3-");
  try {
    const res = await runGit(["checkout", "HEAD~0"], fx.clone, fx.env);
    assert(res.code !== 0, "expected detached checkout to fail");
    assertHookAborted(res.stderr);
    assertStringIncludes(res.stderr, "BLOCKED (reference-transaction)");
    assertEquals(await currentHeadRef(fx.clone, fx.env), "refs/heads/dev");
  } finally {
    await Deno.remove(fx.root, { recursive: true }).catch(() => {});
  }
});

Deno.test("Row 4: git commit --allow-empty -m x in canonical clone is refused", async () => {
  const fx = await setupCanonicalCloneFixture("rt-row4-");
  try {
    const before = (await runGit(["rev-parse", "HEAD"], fx.clone, fx.env)).stdout.trim();
    const res = await runGit(["commit", "--allow-empty", "-m", "x"], fx.clone, fx.env);
    assert(res.code !== 0, "expected git commit on canonical dev to fail");
    assertHookAborted(res.stderr);
    assertStringIncludes(res.stderr, "BLOCKED (reference-transaction)");
    const after = (await runGit(["rev-parse", "HEAD"], fx.clone, fx.env)).stdout.trim();
    assertEquals(after, before);
  } finally {
    await Deno.remove(fx.root, { recursive: true }).catch(() => {});
  }
});

Deno.test("Row 5: git cherry-pick that applies cleanly in canonical clone is refused", async () => {
  const fx = await setupCanonicalCloneFixture("rt-row5-", { useCanonicalEnv: true });
  try {
    const helper = path.join(fx.root, "helper");
    assertEquals((await runGit(["clone", "-q", fx.upstream, helper], fx.root, fx.env)).code, 0);
    await runGit(["config", "user.name", "Test User"], helper, fx.env);
    await runGit(["config", "user.email", "test@example.com"], helper, fx.env);
    await Deno.writeTextFile(path.join(helper, "clean.txt"), "new file\n");
    assertEquals((await runGit(["add", "clean.txt"], helper, fx.env)).code, 0);
    assertEquals((await runGit(["commit", "-q", "-m", "clean"], helper, fx.env)).code, 0);
    const sha = (await runGit(["rev-parse", "HEAD"], helper, fx.env)).stdout.trim();

    assertEquals((await runGit(["fetch", "-q", helper, "dev"], fx.clone, fx.env)).code, 0);
    const before = (await runGit(["rev-parse", "refs/heads/dev"], fx.clone, fx.env)).stdout.trim();
    const res = await runGit(["cherry-pick", sha], fx.clone, fx.env);
    assert(res.code !== 0, "expected clean cherry-pick onto canonical dev to fail");
    assertHookAborted(res.stderr);
    assertStringIncludes(res.stderr, "BLOCKED (reference-transaction)");
    const after = (await runGit(["rev-parse", "refs/heads/dev"], fx.clone, fx.env)).stdout.trim();
    assertEquals(after, before);
  } finally {
    await Deno.remove(fx.root, { recursive: true }).catch(() => {});
  }
});

Deno.test("Row 6: git cherry-pick that conflicts leaves files conflicted without triggering ref abort", async () => {
  const fx = await setupCanonicalCloneFixture("rt-row6-");
  try {
    const helper = path.join(fx.root, "helper");
    assertEquals((await runGit(["clone", "-q", fx.upstream, helper], fx.root, fx.env)).code, 0);
    await runGit(["config", "user.name", "Test User"], helper, fx.env);
    await runGit(["config", "user.email", "test@example.com"], helper, fx.env);
    await Deno.writeTextFile(path.join(helper, "file.txt"), "upstream change\n");
    assertEquals((await runGit(["commit", "-am", "upstream"], helper, fx.env)).code, 0);
    assertEquals((await runGit(["push", "-q", "origin", "dev"], helper, fx.env)).code, 0);

    // Move clone dev up to upstream via fast-forward pull first, then create conflicting commit.
    assertEquals(
      (await runGit(["pull", "--ff-only", "-q", "origin", "dev"], fx.clone, fx.env)).code,
      0,
    );

    await Deno.writeTextFile(path.join(helper, "file.txt"), "branch B\n");
    assertEquals((await runGit(["commit", "-am", "branch B"], helper, fx.env)).code, 0);
    const conflictSha = (await runGit(["rev-parse", "HEAD"], helper, fx.env)).stdout.trim();
    // Create an incompatible base state in clone by bypassing hook for fixture setup only:
    assertEquals(
      (await runGit(
        ["-c", "core.hooksPath=/dev/null", "reset", "--hard", "HEAD~1"],
        fx.clone,
        fx.env,
      )).code,
      0,
    );
    await runGit(["fetch", "-q", helper, "dev"], fx.clone, fx.env);

    // Wait: we want file.txt to differ cleanly at merge base vs cherry-pick commit so cherry-pick conflicts.
    assertEquals(
      (await runGit(["-c", "core.hooksPath=/dev/null", "checkout", "-q", "dev"], fx.clone, fx.env))
        .code,
      0,
    );
    await Deno.writeTextFile(path.join(fx.clone, "file.txt"), "local side\n");
    assertEquals(
      (await runGit(
        ["-c", "core.hooksPath=/dev/null", "commit", "-am", "local side"],
        fx.clone,
        fx.env,
      )).code,
      0,
    );

    const res = await runGit(["cherry-pick", conflictSha], fx.clone, fx.env);
    assert(res.code !== 0, "expected conflicting cherry-pick to exit non-zero");
    assert(
      !GIT_ABORTED_RE.test(res.stderr) && !res.stderr.includes("BLOCKED (reference-transaction)"),
      `conflicting cherry-pick should stop in files before hook refusal: ${res.stderr}`,
    );
    const unmerged = await runGit(["diff", "--name-only", "--diff-filter=U"], fx.clone, fx.env);
    assertStringIncludes(unmerged.stdout, "file.txt");
  } finally {
    await Deno.remove(fx.root, { recursive: true }).catch(() => {});
  }
});

Deno.test("Row 7: git pull --ff-only origin dev passes after upstream gains a commit", async () => {
  const fx = await setupCanonicalCloneFixture("rt-row7-");
  try {
    const pusher = path.join(fx.root, "pusher");
    assertEquals((await runGit(["clone", "-q", fx.upstream, pusher], fx.root, fx.env)).code, 0);
    await runGit(["config", "user.name", "Test User"], pusher, fx.env);
    await runGit(["config", "user.email", "test@example.com"], pusher, fx.env);
    await Deno.writeTextFile(path.join(pusher, "file.txt"), "next\n");
    assertEquals((await runGit(["commit", "-am", "advance dev"], pusher, fx.env)).code, 0);
    const expectedSha = (await runGit(["rev-parse", "HEAD"], pusher, fx.env)).stdout.trim();
    assertEquals((await runGit(["push", "-q", "origin", "dev"], pusher, fx.env)).code, 0);

    const res = await runGit(["pull", "--ff-only", "-q", "origin", "dev"], fx.clone, fx.env);
    assertEquals(res.code, 0, `pull --ff-only failed: ${res.stderr}`);
    const actualSha = (await runGit(["rev-parse", "refs/heads/dev"], fx.clone, fx.env)).stdout
      .trim();
    assertEquals(actualSha, expectedSha);
  } finally {
    await Deno.remove(fx.root, { recursive: true }).catch(() => {});
  }
});

Deno.test("Row 8: git worktree add -b feat <folder> origin/dev in canonical clone passes", async () => {
  const fx = await setupCanonicalCloneFixture("rt-row8-");
  const wt = path.join(fx.root, "wt-feat");
  try {
    const addRes = await runGit(
      ["worktree", "add", "-b", "feat", wt, "origin/dev"],
      fx.clone,
      fx.env,
    );
    assertEquals(addRes.code, 0, `worktree add failed: ${addRes.stderr}`);
    assertEquals(await currentHeadRef(fx.clone, fx.env), "refs/heads/dev");
    assertEquals(await currentHeadRef(wt, fx.env), "refs/heads/feat");
  } finally {
    await Deno.remove(fx.root, { recursive: true }).catch(() => {});
  }
});

Deno.test("Row 9: git worktree remove <folder> then git branch -D feat in canonical clone passes", async () => {
  const fx = await setupCanonicalCloneFixture("rt-row9-");
  const wt = path.join(fx.root, "wt-feat");
  try {
    assertEquals(
      (await runGit(["worktree", "add", "-b", "feat", wt, "origin/dev"], fx.clone, fx.env)).code,
      0,
    );
    const rmRes = await runGit(["worktree", "remove", wt], fx.clone, fx.env);
    assertEquals(rmRes.code, 0, `worktree remove failed: ${rmRes.stderr}`);
    const brRes = await runGit(["branch", "-D", "feat"], fx.clone, fx.env);
    assertEquals(brRes.code, 0, `branch -D feat failed: ${brRes.stderr}`);
  } finally {
    await Deno.remove(fx.root, { recursive: true }).catch(() => {});
  }
});

Deno.test("Row 10: git commit --allow-empty -m x in the new linked worktree passes", async () => {
  const fx = await setupCanonicalCloneFixture("rt-row10-");
  const wt = path.join(fx.root, "wt-feat");
  try {
    assertEquals(
      (await runGit(["worktree", "add", "-b", "feat", wt, "origin/dev"], fx.clone, fx.env)).code,
      0,
    );
    const wtCommit = await runGit(["commit", "--allow-empty", "-m", "x"], wt, fx.env);
    assertEquals(wtCommit.code, 0, `commit in linked worktree failed: ${wtCommit.stderr}`);
  } finally {
    await Deno.remove(fx.root, { recursive: true }).catch(() => {});
  }
});

Deno.test("Row 11: git switch -c feat in another repository main clone (JaMmusic) passes", async () => {
  const fx = await setupCanonicalCloneFixture("rt-row11-");
  try {
    assertEquals(
      (await runGit(["clone", "-q", fx.upstream, fx.otherRepo], fx.root, fx.env)).code,
      0,
    );
    await runGit(["config", "user.name", "Test User"], fx.otherRepo, fx.env);
    await runGit(["config", "user.email", "test@example.com"], fx.otherRepo, fx.env);
    await runGit(["config", "core.hooksPath", HOOKS_DIR], fx.otherRepo, fx.env);

    const res = await runGit(["switch", "-c", "feat"], fx.otherRepo, fx.env);
    assertEquals(res.code, 0, `switch in JaMmusic clone failed: ${res.stderr}`);
    assertEquals(await currentHeadRef(fx.otherRepo, fx.env), "refs/heads/feat");
  } finally {
    await Deno.remove(fx.root, { recursive: true }).catch(() => {});
  }
});

Deno.test("Row 12: git -c core.hooksPath=/dev/null switch -c feat bypasses hook as documented", async () => {
  const fx = await setupCanonicalCloneFixture("rt-row12-");
  try {
    const res = await runGit(
      ["-c", "core.hooksPath=/dev/null", "switch", "-c", "feat"],
      fx.clone,
      fx.env,
    );
    assertEquals(res.code, 0, `override switch failed: ${res.stderr}`);
    assertEquals(await currentHeadRef(fx.clone, fx.env), "refs/heads/feat");
  } finally {
    await Deno.remove(fx.root, { recursive: true }).catch(() => {});
  }
});

Deno.test("Row 13: hands on to repository .git/hooks/reference-transaction with state and stdin", async () => {
  const fx = await setupCanonicalCloneFixture("rt-row13-");
  try {
    const pusher = path.join(fx.root, "pusher");
    assertEquals((await runGit(["clone", "-q", fx.upstream, pusher], fx.root, fx.env)).code, 0);
    await runGit(["config", "user.name", "Test User"], pusher, fx.env);
    await runGit(["config", "user.email", "test@example.com"], pusher, fx.env);
    await Deno.writeTextFile(path.join(pusher, "file.txt"), "more\n");
    assertEquals((await runGit(["commit", "-am", "advance"], pusher, fx.env)).code, 0);
    assertEquals((await runGit(["push", "-q", "origin", "dev"], pusher, fx.env)).code, 0);

    const logPath = path.join(fx.root, "repo-rt-hook.log");
    const repoHookPath = path.join(fx.clone, ".git", "hooks", "reference-transaction");
    await Deno.mkdir(path.dirname(repoHookPath), { recursive: true });
    await Deno.writeTextFile(
      repoHookPath,
      `#!/usr/bin/env bash
printf 'STATE:%s\\n' "$1" >> "${logPath}"
cat >> "${logPath}"
exit 1
`,
    );
    await Deno.chmod(repoHookPath, 0o755);

    const res = await runGit(["pull", "--ff-only", "-q", "origin", "dev"], fx.clone, fx.env);
    assert(res.code !== 0, "expected repo .git/hooks/reference-transaction exit 1 to refuse pull");
    assertHookAborted(res.stderr);
    const recorded = await Deno.readTextFile(logPath);
    assertStringIncludes(recorded, "STATE:prepared");
    assertStringIncludes(recorded, "refs/");
  } finally {
    await Deno.remove(fx.root, { recursive: true }).catch(() => {});
  }
});

Deno.test("git-hooks/reference-transaction is committed with 100755 executable permissions", async () => {
  const info = await Deno.stat(path.join(HOOKS_DIR, "reference-transaction"));
  assert(info.isFile);
  assert(info.mode !== null && (info.mode & 0o111) !== 0, "must have executable bit set");
});

Deno.test("canonical guard: blocks -C from outside and subdirs, allows .claude/worktrees, and ignores spoofed messages", async () => {
  const fx = await setupCanonicalCloneFixture("rt-edges-");
  const claudeWt = path.join(fx.clone, ".claude", "worktrees", "lane-1");
  try {
    // Subdirectory inside canonical clone is still blocked.
    const sub = path.join(fx.clone, "sub");
    await Deno.mkdir(sub);
    const subRes = await runGit(["switch", "-c", "sub-br"], sub, fx.env);
    assert(subRes.code !== 0, "subdirectory switch should be refused");
    assertHookAborted(subRes.stderr);
    assertStringIncludes(subRes.stderr, "BLOCKED (reference-transaction)");

    // git -C <canonical> from outside is still blocked.
    const dashC = await runGit(
      ["-C", fx.clone, "commit", "--allow-empty", "-m", "x"],
      fx.root,
      fx.env,
    );
    assert(dashC.code !== 0, "git -C commit in canonical clone should be refused");
    assertHookAborted(dashC.stderr);
    assertStringIncludes(dashC.stderr, "BLOCKED (reference-transaction)");

    // Commit message mentioning "worktree add" does not bypass is_git_worktree_add.
    const spoof = await runGit(["commit", "--allow-empty", "-m", "worktree add"], fx.clone, fx.env);
    assert(spoof.code !== 0, "spoofed commit message should be refused");
    assertHookAborted(spoof.stderr);
    assertStringIncludes(spoof.stderr, "BLOCKED (reference-transaction)");

    // Linked worktree nested under .claude/worktrees/ passes cleanly.
    assertEquals(
      (await runGit(["worktree", "add", "-b", "lane-1", claudeWt, "origin/dev"], fx.clone, fx.env))
        .code,
      0,
    );
    assertEquals((await runGit(["commit", "--allow-empty", "-m", "ok"], claudeWt, fx.env)).code, 0);
  } finally {
    await Deno.remove(fx.root, { recursive: true }).catch(() => {});
  }
});
