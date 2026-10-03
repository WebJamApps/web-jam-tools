/**
 * test/push_task.test.ts
 *
 * Tests for `deno task push` / `scripts/push.ts`.
 * Validates the push guard logic and exercises all literal cases:
 *   - `deno task push` → pushes `probe-branch`.
 *   - `deno task push --force-with-lease` → pushes `probe-branch` with `--force-with-lease`.
 *   - current branch `dev`, `deno task push` → refused.
 *   - current branch `main`, `deno task push` → refused.
 *   - `deno task push --delete` → refused.
 *   - `deno task push -d` → refused.
 *   - `deno task push origin :probe` → refused.
 *   - `deno task push --force` → refused.
 *   - `deno task push -f` → refused.
 *   - current branch `dev`, `deno task push --force-with-lease` → refused.
 *   - current branch `main`, `deno task push --force-with-lease` → refused.
 *   - detached HEAD (no current branch) → refused.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { evaluatePush, getCurrentBranch, type GitRunner, runPush } from "../scripts/push.ts";

const SCRIPT_PATH = new URL("../scripts/push.ts", import.meta.url).pathname;

interface FixtureEnv {
  tempDir: string;
  bareDir: string;
  repoDir: string;
  git: (args: string[]) => Promise<string>;
  cleanup: () => Promise<void>;
}

async function createFixtureRepo(): Promise<FixtureEnv> {
  const tempDir = await Deno.makeTempDir({ prefix: "push-task-test-" });
  const bareDir = `${tempDir}/remote.git`;
  const repoDir = `${tempDir}/local`;

  const runGit = async (args: string[], cwd: string): Promise<string> => {
    const cmd = new Deno.Command("git", {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    if (code !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed in ${cwd}: ${new TextDecoder().decode(stderr)}`,
      );
    }
    return new TextDecoder().decode(stdout).trim();
  };

  await Deno.mkdir(bareDir);
  await runGit(["init", "--bare"], bareDir);

  await Deno.mkdir(repoDir);
  await runGit(["init", "-q"], repoDir);
  await runGit(["config", "user.email", "test@example.com"], repoDir);
  await runGit(["config", "user.name", "Test Runner"], repoDir);
  await runGit(["remote", "add", "origin", bareDir], repoDir);

  // Provide a deno.json in repoDir so `deno task push` works inside the fixture
  const fixtureDenoConfig = JSON.stringify(
    {
      tasks: {
        push: `deno run --allow-run=git "${SCRIPT_PATH}"`,
      },
    },
    null,
    2,
  );

  // Set up dev branch and initial commit
  await runGit(["checkout", "-q", "-b", "dev"], repoDir);
  await Deno.writeTextFile(`${repoDir}/file.txt`, "dev content\n");
  await Deno.writeTextFile(`${repoDir}/deno.json`, fixtureDenoConfig);
  await runGit(["add", "file.txt", "deno.json"], repoDir);
  await runGit(["commit", "-q", "-m", "init dev with deno.json"], repoDir);
  await runGit(["push", "-q", "-u", "origin", "dev"], repoDir);

  // Set up main branch
  await runGit(["checkout", "-q", "-b", "main"], repoDir);
  await Deno.writeTextFile(`${repoDir}/file.txt`, "main content\n");
  await runGit(["commit", "-q", "-am", "init main"], repoDir);
  await runGit(["push", "-q", "-u", "origin", "main"], repoDir);

  // Set up probe-branch
  await runGit(["checkout", "-q", "-b", "probe-branch"], repoDir);
  await Deno.writeTextFile(`${repoDir}/file.txt`, "probe content\n");
  await runGit(["commit", "-q", "-am", "probe commit"], repoDir);

  return {
    tempDir,
    bareDir,
    repoDir,
    git: (args: string[]) => runGit(args, repoDir),
    cleanup: async () => {
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // ignore
      }
    },
  };
}

async function runDenoTaskPush(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["task", "push", ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

// ---------------------------------------------------------------------------
// Unit tests: evaluatePush
// ---------------------------------------------------------------------------

Deno.test("evaluatePush: plain push on probe-branch is allowed", () => {
  const decision = evaluatePush([], "probe-branch");
  assertEquals(decision.outcome, "allowed");
  assertEquals(decision.branch, "probe-branch");
  assertEquals(decision.forceWithLease, false);
});

Deno.test("evaluatePush: force-with-lease on probe-branch is allowed", () => {
  const decision = evaluatePush(["--force-with-lease"], "probe-branch");
  assertEquals(decision.outcome, "allowed");
  assertEquals(decision.branch, "probe-branch");
  assertEquals(decision.forceWithLease, true);
});

Deno.test("evaluatePush: plain push on dev is refused", () => {
  const decision = evaluatePush([], "dev");
  assertEquals(decision.outcome, "refused");
  assertEquals(decision.rule, "protected-branch");
  assertStringIncludes(decision.reason, "cannot push protected branch 'dev'");
});

Deno.test("evaluatePush: plain push on main is refused", () => {
  const decision = evaluatePush([], "main");
  assertEquals(decision.outcome, "refused");
  assertEquals(decision.rule, "protected-branch");
  assertStringIncludes(decision.reason, "cannot push protected branch 'main'");
});

Deno.test("evaluatePush: --delete on probe-branch is refused", () => {
  const decision = evaluatePush(["--delete"], "probe-branch");
  assertEquals(decision.outcome, "refused");
  assertEquals(decision.rule, "branch-deletion");
  assertStringIncludes(decision.reason, "'--delete' is not permitted");
});

Deno.test("evaluatePush: -d on probe-branch is refused", () => {
  const decision = evaluatePush(["-d"], "probe-branch");
  assertEquals(decision.outcome, "refused");
  assertEquals(decision.rule, "branch-deletion");
  assertStringIncludes(decision.reason, "'-d' is not permitted");
});

Deno.test("evaluatePush: origin :probe colon refspec is refused", () => {
  const decision = evaluatePush(["origin", ":probe"], "probe-branch");
  assertEquals(decision.outcome, "refused");
  assertEquals(decision.rule, "colon-refspec");
  assertStringIncludes(decision.reason, "a colon refspec is not permitted");
});

Deno.test("evaluatePush: --force on probe-branch is refused", () => {
  const decision = evaluatePush(["--force"], "probe-branch");
  assertEquals(decision.outcome, "refused");
  assertEquals(decision.rule, "plain-force");
  assertStringIncludes(decision.reason, "'--force' is not permitted");
});

Deno.test("evaluatePush: -f on probe-branch is refused", () => {
  const decision = evaluatePush(["-f"], "probe-branch");
  assertEquals(decision.outcome, "refused");
  assertEquals(decision.rule, "plain-force");
  assertStringIncludes(decision.reason, "'-f' is not permitted");
});

Deno.test("evaluatePush: --force-with-lease on dev is refused", () => {
  const decision = evaluatePush(["--force-with-lease"], "dev");
  assertEquals(decision.outcome, "refused");
  assertEquals(decision.rule, "protected-branch-force-with-lease");
  assertStringIncludes(
    decision.reason,
    "cannot push protected branch 'dev' with '--force-with-lease'",
  );
});

Deno.test("evaluatePush: --force-with-lease on main is refused", () => {
  const decision = evaluatePush(["--force-with-lease"], "main");
  assertEquals(decision.outcome, "refused");
  assertEquals(decision.rule, "protected-branch-force-with-lease");
  assertStringIncludes(
    decision.reason,
    "cannot push protected branch 'main' with '--force-with-lease'",
  );
});

Deno.test("evaluatePush: detached HEAD (branch = null) fails closed", () => {
  const decision = evaluatePush([], null);
  assertEquals(decision.outcome, "refused-fail-closed");
  assertEquals(decision.rule, "cannot-determine-branch");
  assertStringIncludes(decision.reason, "current branch cannot be determined");
});

Deno.test("evaluatePush: unaccepted extra arguments are refused", () => {
  const decision = evaluatePush(["unexpected-arg"], "probe-branch");
  assertEquals(decision.outcome, "refused");
  assertEquals(decision.rule, "unaccepted-arguments");
});

// ---------------------------------------------------------------------------
// End-to-end integration tests exercising the 12 literal cases
// ---------------------------------------------------------------------------

Deno.test("literal case 1: deno task push → pushes probe-branch", async () => {
  const env = await createFixtureRepo();
  try {
    const res = await runDenoTaskPush([], env.repoDir);
    assertEquals(res.code, 0, `Expected push to succeed, stderr: ${res.stderr}`);

    // Verify bare remote received probe-branch
    const localHead = await env.git(["rev-parse", "probe-branch"]);
    const remoteCmd = new Deno.Command("git", {
      args: ["rev-parse", "probe-branch"],
      cwd: env.bareDir,
      stdout: "piped",
      stderr: "piped",
    });
    const remoteOut = await remoteCmd.output();
    assertEquals(remoteOut.code, 0);
    assertEquals(new TextDecoder().decode(remoteOut.stdout).trim(), localHead);
  } finally {
    await env.cleanup();
  }
});

Deno.test("literal case 2: deno task push --force-with-lease → pushes probe-branch with --force-with-lease", async () => {
  const env = await createFixtureRepo();
  try {
    // Initial push
    await runDenoTaskPush([], env.repoDir);

    // Make an amend/update commit on probe-branch
    await Deno.writeTextFile(`${env.repoDir}/file.txt`, "updated probe content\n");
    await env.git(["commit", "-q", "-am", "amended probe commit"]);

    const res = await runDenoTaskPush(["--force-with-lease"], env.repoDir);
    assertEquals(res.code, 0, `Expected force-with-lease push to succeed, stderr: ${res.stderr}`);

    const localHead = await env.git(["rev-parse", "probe-branch"]);
    const remoteCmd = new Deno.Command("git", {
      args: ["rev-parse", "probe-branch"],
      cwd: env.bareDir,
      stdout: "piped",
      stderr: "piped",
    });
    const remoteOut = await remoteCmd.output();
    assertEquals(remoteOut.code, 0);
    assertEquals(new TextDecoder().decode(remoteOut.stdout).trim(), localHead);
  } finally {
    await env.cleanup();
  }
});

Deno.test("literal case 3: current branch dev, deno task push → refused", async () => {
  const env = await createFixtureRepo();
  try {
    await env.git(["checkout", "-q", "dev"]);
    const res = await runDenoTaskPush([], env.repoDir);
    assertEquals(res.code, 1);
    assertStringIncludes(res.stderr, "Refused (protected-branch)");
    assertStringIncludes(res.stderr, "cannot push protected branch 'dev'");
  } finally {
    await env.cleanup();
  }
});

Deno.test("literal case 4: current branch main, deno task push → refused", async () => {
  const env = await createFixtureRepo();
  try {
    await env.git(["checkout", "-q", "main"]);
    const res = await runDenoTaskPush([], env.repoDir);
    assertEquals(res.code, 1);
    assertStringIncludes(res.stderr, "Refused (protected-branch)");
    assertStringIncludes(res.stderr, "cannot push protected branch 'main'");
  } finally {
    await env.cleanup();
  }
});

Deno.test("literal case 5: deno task push --delete → refused", async () => {
  const env = await createFixtureRepo();
  try {
    const res = await runDenoTaskPush(["--delete"], env.repoDir);
    assertEquals(res.code, 1);
    assertStringIncludes(res.stderr, "Refused (branch-deletion)");
    assertStringIncludes(res.stderr, "'--delete' is not permitted");
  } finally {
    await env.cleanup();
  }
});

Deno.test("literal case 6: deno task push -d → refused", async () => {
  const env = await createFixtureRepo();
  try {
    const res = await runDenoTaskPush(["-d"], env.repoDir);
    assertEquals(res.code, 1);
    assertStringIncludes(res.stderr, "Refused (branch-deletion)");
    assertStringIncludes(res.stderr, "'-d' is not permitted");
  } finally {
    await env.cleanup();
  }
});

Deno.test("literal case 7: deno task push origin :probe → refused", async () => {
  const env = await createFixtureRepo();
  try {
    const res = await runDenoTaskPush(["origin", ":probe"], env.repoDir);
    assertEquals(res.code, 1);
    assertStringIncludes(res.stderr, "Refused (colon-refspec)");
    assertStringIncludes(res.stderr, "a colon refspec is not permitted");
  } finally {
    await env.cleanup();
  }
});

Deno.test("literal case 8: deno task push --force → refused", async () => {
  const env = await createFixtureRepo();
  try {
    const res = await runDenoTaskPush(["--force"], env.repoDir);
    assertEquals(res.code, 1);
    assertStringIncludes(res.stderr, "Refused (plain-force)");
    assertStringIncludes(res.stderr, "'--force' is not permitted");
  } finally {
    await env.cleanup();
  }
});

Deno.test("literal case 9: deno task push -f → refused", async () => {
  const env = await createFixtureRepo();
  try {
    const res = await runDenoTaskPush(["-f"], env.repoDir);
    assertEquals(res.code, 1);
    assertStringIncludes(res.stderr, "Refused (plain-force)");
    assertStringIncludes(res.stderr, "'-f' is not permitted");
  } finally {
    await env.cleanup();
  }
});

Deno.test("literal case 10: current branch dev, deno task push --force-with-lease → refused", async () => {
  const env = await createFixtureRepo();
  try {
    await env.git(["checkout", "-q", "dev"]);
    const res = await runDenoTaskPush(["--force-with-lease"], env.repoDir);
    assertEquals(res.code, 1);
    assertStringIncludes(res.stderr, "Refused (protected-branch-force-with-lease)");
    assertStringIncludes(
      res.stderr,
      "cannot push protected branch 'dev' with '--force-with-lease'",
    );
  } finally {
    await env.cleanup();
  }
});

Deno.test("literal case 11: current branch main, deno task push --force-with-lease → refused", async () => {
  const env = await createFixtureRepo();
  try {
    await env.git(["checkout", "-q", "main"]);
    const res = await runDenoTaskPush(["--force-with-lease"], env.repoDir);
    assertEquals(res.code, 1);
    assertStringIncludes(res.stderr, "Refused (protected-branch-force-with-lease)");
    assertStringIncludes(
      res.stderr,
      "cannot push protected branch 'main' with '--force-with-lease'",
    );
  } finally {
    await env.cleanup();
  }
});

Deno.test("literal case 12: detached HEAD (no current branch) → refused (fails closed)", async () => {
  const env = await createFixtureRepo();
  try {
    await env.git(["checkout", "-q", "--detach"]);
    const res = await runDenoTaskPush([], env.repoDir);
    assertEquals(res.code, 1);
    assertStringIncludes(res.stderr, "Refused (cannot-determine-branch)");
    assertStringIncludes(res.stderr, "current branch cannot be determined");
  } finally {
    await env.cleanup();
  }
});

Deno.test("getCurrentBranch: returns null outside git repository", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "not-a-git-repo-" });
  try {
    const branch = await getCurrentBranch(tempDir);
    assertEquals(branch, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runPush: returns 1 on refusal", async () => {
  const code = await runPush([], undefined, { branch: "dev", stderr: "piped" });
  assertEquals(code, 1);
});

// ---------------------------------------------------------------------------
// Review-fix tests: unsafe branch names, argument echo, fail-closed paths
// ---------------------------------------------------------------------------

async function remoteRefs(bareDir: string): Promise<string> {
  const out = await new Deno.Command("git", {
    args: ["for-each-ref", "--format=%(refname)"],
    cwd: bareDir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout).trim();
}

for (const name of ["+dev", "+main", "+probe", "-dev"]) {
  Deno.test(`unsafe branch name '${name}' is refused and nothing reaches the remote`, async () => {
    const decision = evaluatePush([], name);
    assertEquals(decision.outcome, "refused");
    assertEquals(decision.rule, "unsafe-branch-name");

    // git itself refuses to create a branch named '-dev', so feed it through runPush.
    let spawned = false;
    const code = await runPush([], undefined, {
      branch: name,
      stderr: "piped",
      spawnPush: () => {
        spawned = true;
        return Promise.resolve(0);
      },
    });
    assertEquals(code, 1);
    assertEquals(spawned, false);
    if (name.startsWith("-")) return;

    const env = await createFixtureRepo();
    try {
      const before = await remoteRefs(env.bareDir);
      await env.git(["checkout", "-q", "-b", name]);
      const res = await runDenoTaskPush([], env.repoDir);
      assertEquals(res.code, 1);
      assertStringIncludes(res.stderr, "Refused (unsafe-branch-name)");
      assertEquals(await remoteRefs(env.bareDir), before);
    } finally {
      await env.cleanup();
    }
  });
}

Deno.test("runPush: pushes an explicit refs/heads refspec", async () => {
  let seen: string[] = [];
  const code = await runPush(["--force-with-lease"], undefined, {
    branch: "probe-branch",
    spawnPush: (args) => {
      seen = args;
      return Promise.resolve(0);
    },
  });
  assertEquals(code, 0);
  assertEquals(seen, [
    "push",
    "-u",
    "origin",
    "--force-with-lease",
    "refs/heads/probe-branch:refs/heads/probe-branch",
  ]);
});

Deno.test("refusal messages do not echo the arguments", () => {
  const secret = "https://user:token@host/repo.git";
  for (const args of [[secret], ["origin", secret], ["--force-with-lease", secret]]) {
    const decision = evaluatePush(args, "probe-branch");
    assertEquals(decision.outcome, "refused");
    assertEquals(decision.reason.includes("token"), false);
    assertEquals(decision.reason.includes("user:"), false);
  }
});

Deno.test("getCurrentBranch: fails closed when the git runner throws", async () => {
  const run: GitRunner = () => Promise.reject(new Error("spawn failed"));
  assertEquals(await getCurrentBranch(undefined, run), null);
});

Deno.test("getCurrentBranch: fails closed when symbolic-ref exits non-zero", async () => {
  const run: GitRunner = (args) =>
    Promise.resolve(
      args[0] === "rev-parse" ? { code: 0, stdout: "true\n" } : { code: 1, stdout: "" },
    );
  assertEquals(await getCurrentBranch(undefined, run), null);
});

Deno.test("runPush: returns 1 when spawning the push fails", async () => {
  const code = await runPush([], undefined, {
    branch: "probe-branch",
    spawnPush: () => Promise.reject(new Error("spawn failed")),
  });
  assertEquals(code, 1);
});
