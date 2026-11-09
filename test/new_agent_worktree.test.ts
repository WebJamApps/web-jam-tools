import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";

const SCRIPT = path.fromFileUrl(new URL("../scripts/new-agent-worktree.sh", import.meta.url));
const decoder = new TextDecoder();

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: "agent worktree " });
  const workspace = path.join(root, "workspace");
  const repo = path.join(workspace, "Fixture");
  const origin = path.join(root, "origin.git");
  const worktree = path.join(repo, ".claude/worktrees/feat");
  await Deno.mkdir(repo, { recursive: true });
  const env = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = async (...args: string[]) => {
    const output = await new Deno.Command("git", {
      args: ["-c", "core.hooksPath=/dev/null", ...args],
      cwd: repo,
      env,
    }).output();
    assertEquals(output.code, 0, decoder.decode(output.stderr));
    return decoder.decode(output.stdout).trim();
  };
  try {
    await git("init", "--bare", origin);
    await git("init", "-b", "dev");
    await git("config", "user.name", "Worktree Fixture");
    await git("config", "user.email", "worktree@example.invalid");
    await git("config", "core.hooksPath", "/dev/null");
    await Deno.writeTextFile(path.join(repo, ".gitignore"), ".env\n.env.test\n.claude/\n");
    await git("add", ".gitignore");
    await git("commit", "-m", "dev base");
    const dev = await git("rev-parse", "HEAD");
    await git("checkout", "-b", "main");
    await git("commit", "--allow-empty", "-m", "different main base");
    const main = await git("rev-parse", "HEAD");
    await git("checkout", "dev");
    await git("remote", "add", "origin", origin);
    await git("push", "origin", "dev", "main");

    const feature = async (remote: boolean, keepLocal = true) => {
      await git("checkout", "-b", "feat");
      await Deno.writeTextFile(path.join(repo, "work.txt"), "pr-work\n");
      await git("add", "work.txt");
      await git("commit", "-m", "pr-work");
      const commit = await git("rev-parse", "HEAD");
      if (remote) await git("push", "origin", "feat");
      await git("checkout", "dev");
      if (!keepLocal) await git("branch", "-D", "feat");
      return commit;
    };
    const run = async (base?: string) => {
      const output = await new Deno.Command("bash", {
        args: [SCRIPT, "Fixture", "feat", ...(base ? [base] : [])],
        cwd: repo,
        env: { ...env, WEBJAMAPPS_ROOT: workspace },
        stdin: "null",
      }).output();
      return {
        code: output.code,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
      };
    };
    const checkWorktree = async (commit: string, result: Awaited<ReturnType<typeof run>>) => {
      assertEquals(result.code, 0, result.stderr);
      assertEquals(result.stdout.trim().split("\n").at(-1), worktree);
      assertEquals(await git("-C", worktree, "rev-parse", "HEAD"), commit);
      assertEquals(await git("rev-parse", "refs/heads/feat"), commit);
      assertEquals(await git("symbolic-ref", "--short", "HEAD"), "dev");
      assertEquals(await git("status", "--porcelain"), "");
    };
    const checkRefusal = async (local: string, remote: string) => {
      const before = await git("show-ref");
      const result = await run();
      assert(result.code !== 0, result.stderr);
      assertStringIncludes(result.stderr, local);
      assertStringIncludes(result.stderr, remote);
      assertEquals(await git("show-ref"), before);
      assertEquals(
        await git("worktree", "list", "--porcelain"),
        `worktree ${repo}\nHEAD ${dev}\nbranch refs/heads/dev`,
      );
      assertEquals(await exists(worktree), false);
    };
    return {
      root,
      repo,
      origin,
      worktree,
      git,
      dev,
      main,
      feature,
      run,
      checkWorktree,
      checkRefusal,
    };
  } catch (error) {
    await Deno.remove(root, { recursive: true });
    throw error;
  }
}

async function exists(filename: string): Promise<boolean> {
  try {
    await Deno.stat(filename);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

// One test per row of "The worktree script agents start a lane with".
Deno.test("remote feat without a local branch retains pr-work and tracks origin", async () => {
  const f = await fixture();
  try {
    const commit = await f.feature(true, false);
    // Prove the script fetches feature refs, not just the base ref.
    await f.git("update-ref", "-d", "refs/remotes/origin/feat");
    const result = await f.run();
    await f.checkWorktree(commit, result);
    assertEquals(await f.git("rev-parse", "feat@{upstream}"), commit);
    assertEquals(await f.git("config", "branch.feat.merge"), "refs/heads/feat");
    assertStringIncludes(result.stderr, "Case: branch on origin");
    assertEquals(await Deno.readTextFile(path.join(f.worktree, "work.txt")), "pr-work\n");
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("matching local and remote feat retain pr-work", async () => {
  const f = await fixture();
  try {
    const commit = await f.feature(true);
    await f.git("branch", "--set-upstream-to=origin/dev", "feat");
    await f.checkWorktree(commit, await f.run());
    assertEquals(await f.git("rev-parse", "feat@{upstream}"), commit);
    assertEquals(await f.git("config", "branch.feat.merge"), "refs/heads/feat");
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("local feat ahead of origin refuses without moving branches", async () => {
  const f = await fixture();
  try {
    const remote = await f.feature(true);
    await f.git("checkout", "feat");
    await f.git("commit", "--allow-empty", "-m", "unpushed work");
    const local = await f.git("rev-parse", "HEAD");
    await f.git("checkout", "dev");
    await f.checkRefusal(local, remote);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("local feat at dev behind origin refuses without moving branches", async () => {
  const f = await fixture();
  try {
    const remote = await f.feature(true, false);
    await f.git("branch", "feat", f.dev);
    await f.checkRefusal(f.dev, remote);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("local-only feat keeps its unpushed commit", async () => {
  const f = await fixture();
  try {
    const commit = await f.feature(false);
    const result = await f.run();
    await f.checkWorktree(commit, result);
    assertStringIncludes(result.stderr, "Case: local-only branch");
    assertStringIncludes(result.stderr, "base 'dev' ignored");
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("new feat starts from origin/dev by default", async () => {
  const f = await fixture();
  try {
    const result = await f.run();
    await f.checkWorktree(f.dev, result);
    assertStringIncludes(result.stderr, "Case: new branch, starting from origin/dev");
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("new feat with explicit main starts from origin/main", async () => {
  const f = await fixture();
  try {
    const result = await f.run("main");
    await f.checkWorktree(f.main, result);
    assertStringIncludes(result.stderr, "Case: new branch, starting from origin/main");
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("remote feat ignores explicit main and keeps pr-work", async () => {
  const f = await fixture();
  try {
    const commit = await f.feature(true, false);
    const result = await f.run("main");
    await f.checkWorktree(commit, result);
    assertStringIncludes(result.stderr, "base 'main' ignored");
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("existing worktree folder refuses without changing its contents or branches", async () => {
  const f = await fixture();
  try {
    await Deno.mkdir(f.worktree, { recursive: true });
    const sentinel = path.join(f.worktree, "keep.txt");
    await Deno.writeTextFile(sentinel, "keep\n");
    const refs = await f.git("show-ref");
    const result = await f.run();
    assert(result.code !== 0);
    assertStringIncludes(result.stderr, "already exists");
    assertEquals(await Deno.readTextFile(sentinel), "keep\n");
    assertEquals(await f.git("show-ref"), refs);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("all three successful branch cases copy both environment files", async () => {
  for (const branchCase of ["remote", "local", "new"]) {
    const f = await fixture();
    try {
      const commit = branchCase === "new"
        ? f.dev
        : await f.feature(branchCase === "remote", branchCase === "local");
      for (const name of [".env", ".env.test"]) {
        await Deno.writeTextFile(path.join(f.repo, name), `fixture ${name}\n`);
      }
      await f.checkWorktree(commit, await f.run());
      for (const name of [".env", ".env.test"]) {
        assertEquals(
          await Deno.readTextFile(path.join(f.worktree, name)),
          await Deno.readTextFile(path.join(f.repo, name)),
        );
      }
    } finally {
      await Deno.remove(f.root, { recursive: true });
    }
  }
});
