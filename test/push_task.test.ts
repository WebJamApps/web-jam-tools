/**
 * test/push_task.test.ts
 *
 * Tests for `deno task push` / `scripts/push.ts`.
 * Validates the push guard logic and exercises all literal cases:
 *   - `deno task push` → pushes `probe-branch`.
 *   - `deno task push --force-with-lease` → requires terminal confirmation.
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
import {
  confirmForcePush,
  evaluatePush,
  getCurrentBranch,
  type GitRunner,
  runPush as pushWithContext,
} from "../scripts/push.ts";
import {
  checkFixRun,
  githubRepository,
  latestTypedSkillCall,
  parseFixPrReference,
  type PullRequestState,
} from "../hooks/lib/fix_run.ts";
import { resolveFixRun } from "../scripts/push.ts";

// Existing policy tests have no user invocation and never inspect this workstation's sessions.
const runPush: typeof pushWithContext = (args, cwd, options) =>
  pushWithContext(args, cwd, { readSkillCall: () => Promise.resolve(null), ...options });

const SCRIPT_PATH = new URL("../scripts/push.ts", import.meta.url).pathname;
const SHARED_CONFIG_PATH = new URL("../deno.json", import.meta.url).pathname;

const fixBody = (author: string) => `Fixed formatting.\n\n🤖 Fixed by ${author}\n`;

interface FixtureEnv {
  tempDir: string;
  bareDir: string;
  repoDir: string;
  git: (args: string[]) => Promise<string>;
  cleanup: () => Promise<void>;
}

for (const surface of ["claude", "agy", "codex"] as const) {
  Deno.test(`${surface}: comment checks run before pushing, and successful pushes post recorded signatures`, async () => {
    const fixture = await createFixFixture(surface);
    const comment = `${fixture.repoDir}/c ' retry.md`;
    const signature = surface === "codex"
      ? "Codex — GPT-6 Luna"
      : surface === "claude"
      ? "Claude Code — Claude Opus"
      : "agy — Gemini Flash";
    try {
      await fixture.writeSession([fixCall.text]);
      const args = ["--fix-comment", comment];
      const help = await runDenoTaskPush(["--help"], fixture.repoDir, true, fixture.shellEnv);
      assertEquals(help.code, 0, help.stderr);
      assertStringIncludes(help.stdout, "--fix-comment");
      const initial = await Deno.readTextFile(fixture.sessionPath);
      const initialRecord = surface === "agy" ? await Deno.readTextFile(fixture.recordPath) : "";
      for (
        const body of [
          "",
          "🤖 Fixed by Claude Code — Claude Opus",
          "Fixed formatting.",
          `${fixBody(signature)}extra text`,
          `## PR Review Summary\n${fixBody(signature)}`,
          `${fixBody(signature)}${fixBody(signature)}`,
        ]
      ) {
        await Deno.writeTextFile(comment, body);
        const before = await fixture.git(["ls-remote", "origin"]);
        const result = await runDenoTaskPush(args, fixture.repoDir, true, fixture.shellEnv);
        assertEquals(result.code, 1, result.stderr);
        assertStringIncludes(result.stderr, "Refused (fix-comment)");
        assertEquals(await fixture.git(["ls-remote", "origin"]), before);
        assertEquals(await remoteRefs(fixture.bareDir), "refs/heads/dev\nrefs/heads/main");
      }
      await Deno.writeTextFile(comment, fixBody("Codex — GPT"));
      const recordedFile = surface === "agy" ? fixture.recordPath : fixture.sessionPath;
      const recordedText = surface === "agy" ? initialRecord : initial;
      const slug = surface === "codex"
        ? "gpt-6-luna"
        : surface === "claude"
        ? "claude-opus-5-5"
        : "gemini-3.8-flash-high";
      for (const model of ["missing-model", "gpt-6-sol"]) {
        const damaged = model === "missing-model"
          ? recordedText.replace(`"${slug}"`, "null")
          : recordedText.replace(slug, model);
        await Deno.writeTextFile(recordedFile, damaged);
        const before = await fixture.git(["ls-remote", "origin"]);
        const result = await runDenoTaskPush(args, fixture.repoDir, true, fixture.shellEnv);
        assertEquals(result.code, 1, result.stderr);
        assertEquals(await fixture.git(["ls-remote", "origin"]), before);
        assertStringIncludes(
          result.stderr,
          model === "missing-model" ? recordedFile : "roster entry",
        );
      }
      await Deno.writeTextFile(recordedFile, recordedText);
      await Deno.remove(comment);
      const missing = await runDenoTaskPush(args, fixture.repoDir, true, fixture.shellEnv);
      assertEquals(missing.code, 1);
      assertStringIncludes(missing.stderr, comment);

      await Deno.writeTextFile(comment, fixBody("Codex — GPT"));
      const result = await runDenoTaskPush(args, fixture.repoDir, true, fixture.shellEnv);
      assertEquals(result.code, 0, result.stderr);
      assertEquals(
        await Deno.readTextFile(fixture.shellEnv.PUSH_TEST_COMMENT_OUTPUT),
        fixBody(signature),
      );
      assertEquals(await Deno.readTextFile(comment), fixBody(signature));
      assertEquals(
        (await fixture.git(["ls-remote", "origin", "refs/heads/probe-branch"])).split(/\s+/)[0],
        await fixture.git(["rev-parse", "HEAD"]),
      );

      // The remote has changed even if the subsequent post fails. Retry only that signed file.
      await Deno.writeTextFile(`${fixture.repoDir}/file.txt`, "next fix\n");
      await fixture.git(["commit", "-qam", "next fix"]);
      const failed = await runDenoTaskPush(args, fixture.repoDir, true, {
        ...fixture.shellEnv,
        PUSH_TEST_POST_EXIT: "1",
      });
      assertEquals(failed.code, 1);
      assertStringIncludes(failed.stderr, "Push landed, but the fix comment was not posted");
      const remote = await fixture.git(["ls-remote", "origin"]);
      assertStringIncludes(remote, await fixture.git(["rev-parse", "HEAD"]));
      const retry = failed.stderr.trim().split("\n").at(-1)!;
      assertStringIncludes(retry, "post-pr-comment --repo");
      const retried = await new Deno.Command("bash", {
        args: ["-c", retry],
        cwd: fixture.repoDir,
        env: fixture.shellEnv,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(retried.code, 0, new TextDecoder().decode(retried.stderr));
      assertEquals(await fixture.git(["ls-remote", "origin"]), remote);
      assertEquals(
        await Deno.readTextFile(fixture.shellEnv.PUSH_TEST_COMMENT_OUTPUT),
        fixBody(signature),
      );
      assertEquals(await Deno.readTextFile(fixture.shellEnv.PUSH_TEST_TRACE), "post\npost\npost\n");
    } finally {
      await fixture.cleanup();
    }
  });
}

for (const surface of ["claude", "codex"] as const) {
  Deno.test(`${surface}: only this session's helpers started since the typed call may sign`, async () => {
    const fixture = await createFixFixture(surface);
    const comment = `${fixture.repoDir}/c.md`;
    const childId = "12345678-1234-5678-abcd-123456789abd";
    const parentAuthor = surface === "claude" ? "Claude Code — Claude Opus" : "Codex — GPT-6.1 Sol";
    const helperAuthor = surface === "claude"
      ? "Claude Code — Claude Haiku 5.5"
      : "Codex — GPT-6 Luna";
    const outsider = surface === "claude"
      ? "Claude Code — Claude Sonnet 5.5"
      : "Codex — GPT-6 Astra";
    try {
      await fixture.writeSession([fixCall.text]);
      if (surface === "codex") {
        await Deno.writeTextFile(
          fixture.sessionPath,
          (await Deno.readTextFile(fixture.sessionPath)).replace("gpt-6-luna", "gpt-6.1-sol"),
        );
      }
      const helperPath = surface === "claude"
        ? `${fixture.sessionPath.slice(0, -6)}/subagents/agent-${childId}.jsonl`
        : `${fixture.shellEnv.CODEX_HOME}/sessions/rollout-${childId}.jsonl`;
      await Deno.mkdir(helperPath.slice(0, helperPath.lastIndexOf("/")), { recursive: true });
      const child = (
        timestamp: string,
        model = surface === "claude" ? "claude-haiku-5-5" : "gpt-6-luna",
        parent = fixtureThread,
      ) =>
        (surface === "claude"
          ? [
            {
              type: "user",
              timestamp,
              isSidechain: true,
              message: { role: "user", content: "Do the fix" },
            },
            { type: "assistant", isSidechain: true, message: { role: "assistant", model } },
          ]
          : [
            {
              type: "session_meta",
              timestamp,
              payload: {
                id: childId,
                thread_source: "subagent",
                parent_thread_id: parent,
                source: { subagent: { thread_spawn: { parent_thread_id: parent } } },
              },
            },
            { type: "turn_context", payload: { model } },
          ]).map((entry) => JSON.stringify(entry)).join("\n") + "\n";
      for (const author of [helperAuthor, parentAuthor, outsider]) {
        await Deno.writeTextFile(helperPath, child("2026-10-13T01:01:00Z"));
        await Deno.writeTextFile(comment, fixBody(author));
        const before = await fixture.git(["ls-remote", "origin"]);
        const result = await runDenoTaskPush(
          ["--fix-comment", comment],
          fixture.repoDir,
          true,
          fixture.shellEnv,
        );
        assertEquals(result.code, author === outsider ? 1 : 0, result.stderr);
        if (author === outsider) {
          assertStringIncludes(result.stderr, "neither the session model nor a helper");
          assertEquals(await fixture.git(["ls-remote", "origin"]), before);
        } else {
          assertEquals(
            await Deno.readTextFile(fixture.shellEnv.PUSH_TEST_COMMENT_OUTPUT),
            fixBody(author),
          );
        }
      }
      await Deno.writeTextFile(helperPath, child("2026-10-13T00:01:00Z"));
      await Deno.writeTextFile(comment, fixBody(helperAuthor));
      assertEquals(
        (await runDenoTaskPush(["--fix-comment", comment], fixture.repoDir, true, fixture.shellEnv))
          .code,
        0,
      );
      assertEquals(await Deno.readTextFile(comment), fixBody(parentAuthor));
      for (
        const [timestamp, model] of [["bad date", "gpt-6-luna"], [
          "2026-10-13T01:01:00Z",
          "unknown-model",
        ]]
      ) {
        await Deno.writeTextFile(helperPath, child(timestamp, model));
        await Deno.writeTextFile(comment, fixBody(helperAuthor));
        const before = await fixture.git(["ls-remote", "origin"]);
        const result = await runDenoTaskPush(
          ["--fix-comment", comment],
          fixture.repoDir,
          true,
          fixture.shellEnv,
        );
        assertEquals(result.code, 1);
        assertEquals(await fixture.git(["ls-remote", "origin"]), before);
      }
      if (surface === "codex") {
        await Deno.writeTextFile(helperPath, child("2026-10-13T01:01:00Z", "gpt-6-luna", childId));
        await Deno.writeTextFile(comment, fixBody(outsider));
        assertEquals(
          (await runDenoTaskPush(
            ["--fix-comment", comment],
            fixture.repoDir,
            true,
            fixture.shellEnv,
          )).code,
          0,
        );
        assertEquals(await Deno.readTextFile(comment), fixBody(parentAuthor));
      }
    } finally {
      await fixture.cleanup();
    }
  });
}

Deno.test("a failed or throwing push never posts a validated fix comment", async () => {
  for (const throws of [false, true]) {
    let posted = false;
    const code = await runPush(["--fix-comment", "c.md"], undefined, {
      branch: "probe-branch",
      readSkillCall: () => Promise.resolve(fixCall),
      runGit: () => Promise.resolve({ code: 0, stdout: `https://github.com/${targetRepo}.git` }),
      lookupPullRequest: () => Promise.resolve(targetPr),
      prepareComment: () => Promise.resolve(),
      spawnPush: () => throws ? Promise.reject(new Error("push failed")) : Promise.resolve(1),
      postComment: () => {
        posted = true;
        return Promise.resolve(0);
      },
    });
    assertEquals(code, 1);
    assertEquals(posted, false);
  }
});

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
  sharedConfig = false,
  fixtureEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "task",
      ...(sharedConfig ? ["--config", SHARED_CONFIG_PATH] : []),
      "push",
      ...(sharedConfig ? ["--repo-dir", cwd] : []),
      ...args,
    ],
    cwd,
    env: {
      CODEX_THREAD_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
      WJT_SURFACE: "codex",
      WJT_UNATTENDED: "",
      ...fixtureEnv,
    },
    stdin: "null",
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

Deno.test("shared push task pushes the caller's Node repository without a Deno config", async () => {
  const env = await createFixtureRepo();
  try {
    await Deno.remove(`${env.repoDir}/deno.json`);
    await Deno.writeTextFile(`${env.repoDir}/package.json`, '{"scripts":{}}\n');
    const res = await runDenoTaskPush([], env.repoDir, true);
    assertEquals(res.code, 0, `Expected shared task to push the caller, stderr: ${res.stderr}`);

    const localHead = await env.git(["rev-parse", "HEAD"]);
    const remoteHead = await env.git(["ls-remote", "origin", "refs/heads/probe-branch"]);
    assertEquals(remoteHead.split(/\s+/)[0], localHead);
  } finally {
    await env.cleanup();
  }
});

Deno.test("shared push task refuses the caller's protected branch without changing its remote", async () => {
  const env = await createFixtureRepo();
  try {
    await env.git(["checkout", "-q", "dev"]);
    await Deno.remove(`${env.repoDir}/deno.json`);
    const before = await env.git(["ls-remote", "origin"]);
    const res = await runDenoTaskPush([], env.repoDir, true);
    assertEquals(res.code, 1);
    assertStringIncludes(res.stderr, "cannot push protected branch 'dev'");
    assertEquals(await env.git(["ls-remote", "origin"]), before);
  } finally {
    await env.cleanup();
  }
});

Deno.test("explicit repository selection fails closed for missing, empty, or nonexistent directories", async () => {
  const env = await createFixtureRepo();
  try {
    const before = await env.git(["ls-remote", "origin"]);
    for (
      const args of [
        ["--repo-dir"],
        ["--repo-dir", ""],
        ["--repo-dir", `${env.tempDir}/missing`],
      ]
    ) {
      const res = await runDenoTaskPush(args, env.repoDir);
      assertEquals(res.code, 1, `Expected invalid repository selection to refuse: ${res.stderr}`);
      assertStringIncludes(res.stderr, "Refused (");
      assertEquals(await env.git(["ls-remote", "origin"]), before);
    }
  } finally {
    await env.cleanup();
  }
});

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

for (const form of ["canonical", "repo-dir", "shared-config", "short-config", "direct-script"]) {
  Deno.test(`force-with-lease ${form} refuses noninteractive confirmation and preserves remote refs`, async () => {
    const env = await createFixtureRepo();
    try {
      assertEquals((await runDenoTaskPush([], env.repoDir)).code, 0);
      const before = await env.git(["ls-remote", "origin"]);
      await Deno.writeTextFile(`${env.repoDir}/file.txt`, "rewritten probe content\n");
      await env.git(["commit", "-q", "--amend", "-am", "rewritten probe commit"]);

      let args = ["task", "push", "--force-with-lease"];
      if (form === "repo-dir") {
        args = ["task", "push", "--repo-dir", env.repoDir, "--force-with-lease"];
      } else if (form === "shared-config" || form === "short-config") {
        await Deno.remove(`${env.repoDir}/deno.json`);
        args = [
          "task",
          form === "shared-config" ? "--config" : "-c",
          SHARED_CONFIG_PATH,
          "push",
          "--repo-dir",
          env.repoDir,
          "--force-with-lease",
        ];
      } else if (form === "direct-script") {
        args = ["run", "--allow-run=git", SCRIPT_PATH, "--force-with-lease"];
      }
      // A piped affirmative answer must not substitute for terminal confirmation.
      const child = new Deno.Command(Deno.execPath(), {
        args,
        cwd: env.repoDir,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode("y\n"));
      await writer.close();
      const res = await child.output();
      assertEquals(res.code, 1);
      assertStringIncludes(
        new TextDecoder().decode(res.stderr),
        "Refused (force-with-lease-confirmation)",
      );
      assertEquals(await env.git(["ls-remote", "origin"]), before);
    } finally {
      await env.cleanup();
    }
  });
}

Deno.test("runPush: confirmed force-with-lease can update a rewritten feature branch", async () => {
  const env = await createFixtureRepo();
  try {
    assertEquals((await runDenoTaskPush([], env.repoDir)).code, 0);
    await Deno.writeTextFile(`${env.repoDir}/file.txt`, "confirmed rewrite\n");
    await env.git(["commit", "-q", "--amend", "-am", "confirmed rewrite"]);
    let confirmedBranch: string | undefined;
    const code = await runPush(["--force-with-lease"], env.repoDir, {
      stdout: "piped",
      stderr: "piped",
      confirmForce: (branch) => {
        confirmedBranch = branch;
        return true;
      },
    });
    assertEquals(confirmedBranch, "probe-branch");
    assertEquals(code, 0);
    const remoteHead = await env.git(["ls-remote", "origin", "refs/heads/probe-branch"]);
    assertEquals(remoteHead.split(/\s+/)[0], await env.git(["rev-parse", "HEAD"]));
  } finally {
    await env.cleanup();
  }
});

Deno.test("confirmForcePush: only asks in a terminal and requires an affirmative response", () => {
  let asked = false;
  assertEquals(
    confirmForcePush("probe-branch", () => false, () => {
      asked = true;
      return true;
    }),
    false,
  );
  assertEquals(asked, false);
  assertEquals(confirmForcePush("probe-branch", () => true, () => false), false);
  assertEquals(
    confirmForcePush("probe-branch", () => true, (message) => {
      assertStringIncludes(message, "'probe-branch' to origin with --force-with-lease");
      return true;
    }),
    true,
  );
});

Deno.test("runPush: plain pushes and protected-branch refusals never ask for force confirmation", async () => {
  let confirmations = 0;
  for (const branch of ["probe-branch", "dev", "main"]) {
    for (const args of [[], ["--force-with-lease"]]) {
      if (branch === "probe-branch" && args.length > 0) continue;
      const code = await runPush(args, undefined, {
        branch,
        confirmForce: () => {
          confirmations++;
          return true;
        },
        spawnPush: () => Promise.resolve(0),
      });
      assertEquals(code, branch === "probe-branch" ? 0 : 1);
    }
  }
  assertEquals(confirmations, 0);
});

for (const outcome of ["declined", "error"]) {
  Deno.test(`runPush: ${outcome} confirmation never spawns a force push`, async () => {
    let spawned = false;
    const code = await runPush(["--force-with-lease"], undefined, {
      branch: "probe-branch",
      confirmForce: () => {
        if (outcome === "error") throw new Error("confirmation unavailable");
        return false;
      },
      spawnPush: () => {
        spawned = true;
        return Promise.resolve(0);
      },
    });
    assertEquals(code, 1);
    assertEquals(spawned, false);
  });
}

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
    confirmForce: () => true,
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

const targetRepo = "WebJamApps/web-jam-tools";
const targetPr: PullRequestState = {
  number: 1318,
  state: "OPEN",
  headRefName: "probe-branch",
  headRepository: { nameWithOwner: targetRepo },
  isCrossRepository: false,
};
const fixCall = {
  name: "fix-pr",
  arguments: "web-jam-tools#1318",
  text: "/fix-pr web-jam-tools#1318",
};
const activeFix = { kind: "active" as const, pullRequest: { repo: targetRepo, number: 1318 } };

Deno.test("fix run resolves supported PR names and GitHub push remotes", () => {
  for (
    const args of [
      "1318",
      "web-jam-tools#1318",
      `${targetRepo}#1318`,
      "https://github.com/WebJamApps/web-jam-tools/pull/1318 also run checks",
    ]
  ) {
    assertEquals(parseFixPrReference(args, targetRepo), { repo: targetRepo, number: 1318 });
  }
  for (
    const args of ["", "0", "-1", "9007199254740993", "please fix 1318", "1318suffix", "foo#0"]
  ) {
    assertEquals(parseFixPrReference(args, targetRepo), null);
  }
  for (
    const remote of [
      "https://github.com/WebJamApps/web-jam-tools.git",
      "git@github.com:WebJamApps/web-jam-tools.git",
      "ssh://git@github.com/WebJamApps/web-jam-tools",
    ]
  ) {
    assertEquals(githubRepository(remote), targetRepo);
  }
  for (
    const remote of [
      "https://other.host/WebJamApps/web-jam-tools.git",
      "https://user:password@github.com/WebJamApps/web-jam-tools.git",
      "/tmp/origin.git",
      `https://github.com/${targetRepo}.git\nhttps://github.com/${targetRepo}.git`,
    ]
  ) {
    assertEquals(githubRepository(remote), null);
  }
});

Deno.test("typed call ignores agent text and keeps plain replies, but a new skill ends it", () => {
  const human = (text: string) => ({
    type: "user",
    origin: { kind: "human" },
    message: { role: "user", content: text },
  });
  const ctx = {
    entries: [human(fixCall.text), human("also bump the version")],
    ownConversationId: "session",
    isSubagentInvocation: false,
  };
  const agentEntries = [
    { type: "assistant", message: { role: "assistant", content: "/pr-review" } },
    { type: "user", isMeta: true, message: { role: "user", content: "/pr-review" } },
    { ...human("/pr-review"), origin: { kind: "task-notification" } },
    { ...human("/pr-review"), isSidechain: true },
    { type: "user", message: { role: "user", content: "/pr-review" } },
  ];
  for (const entry of agentEntries) {
    assertEquals(latestTypedSkillCall({ ...ctx, entries: [...ctx.entries, entry] }), fixCall);
  }
  assertEquals(
    latestTypedSkillCall({ ...ctx, entries: [...ctx.entries, human("/pr-review")] })?.name,
    "pr-review",
  );
  assertEquals(latestTypedSkillCall({ ...ctx, isSubagentInvocation: true }), null);
  assertEquals(latestTypedSkillCall({ ...ctx, ownConversationId: null }), null);
  assertEquals(
    latestTypedSkillCall({
      ...ctx,
      entries: [human(
        "<command-message>fix-pr</command-message><command-name>/fix-pr</command-name>" +
          "<command-args>web-jam-tools#1318</command-args>",
      )],
    })?.arguments,
    fixCall.arguments,
  );
});

Deno.test("active fix requires a comment and preserves every forbidden push form", () => {
  for (const args of [[], ["--force-with-lease"]]) {
    const result = evaluatePush(args, "probe-branch", activeFix);
    assertEquals(result.rule, "missing-fix-comment");
    assertStringIncludes(result.reason, "--fix-comment");
  }
  for (
    const args of [["--fix-comment", "c.md"], ["--force-with-lease", "--fix-comment", "c.md"], [
      "--fix-comment",
      "c.md",
      "--force-with-lease",
    ]]
  ) {
    assertEquals(evaluatePush(args, "probe-branch", activeFix).outcome, "allowed");
    assertEquals(evaluatePush(args, "probe-branch").rule, "fix-comment-outside-run");
  }
  for (
    const args of [
      ["--fix-comment"],
      ["--fix-comment", ""],
      ["--fix-comment", "--force-with-lease"],
      ["--fix-comment", "c.md", "--fix-comment", "d.md"],
      ["--force-with-lease", "--force-with-lease"],
    ]
  ) {
    assertEquals(evaluatePush(args, "probe-branch", activeFix).outcome, "refused");
  }
  for (const flag of ["--force", "-f", "--delete", "-d", ":probe", "--mirror", "--prune"]) {
    assertEquals(
      evaluatePush([flag, "--fix-comment", "c.md"], "probe-branch", activeFix).outcome,
      "refused",
    );
  }
  for (const branch of ["main", "dev", "+dev", null]) {
    assertEquals(
      evaluatePush(["--force-with-lease", "--fix-comment", "c.md"], branch, activeFix).outcome ===
        "allowed",
      false,
    );
  }
});

Deno.test("fix run binds state, number, branch and repository including fork refusal", () => {
  for (
    const changes of [
      { state: "CLOSED" },
      { state: "MERGED" },
      { number: 1322 },
      { headRefName: "another-branch" },
      { isCrossRepository: true },
      { headRepository: null },
      { headRepository: { nameWithOwner: "other/web-jam-tools" } },
    ]
  ) {
    assertEquals(
      checkFixRun(fixCall, targetRepo, "probe-branch", { ...targetPr, ...changes }).kind,
      "refused",
    );
  }
  assertEquals(
    checkFixRun(fixCall, "WebJamApps/JaMmusic", "probe-branch", targetPr).kind,
    "refused",
  );
  assertEquals(checkFixRun(fixCall, targetRepo, "probe-branch", null).kind, "none");
});

Deno.test("resolution failure never grants a fix run or falls back to another typed session", async () => {
  const deps = {
    readSkillCall: () => Promise.resolve(fixCall),
    runGit: () => Promise.resolve({ code: 0, stdout: `https://github.com/${targetRepo}.git` }),
    lookupPullRequest: () => Promise.resolve(targetPr),
  };
  assertEquals(await resolveFixRun("probe-branch", undefined, deps), activeFix);
  for (
    const failed of [
      { readSkillCall: () => Promise.reject(new Error("record unavailable")) },
      { runGit: () => Promise.reject(new Error("git unavailable")) },
      { runGit: () => Promise.resolve({ code: 1, stdout: "" }) },
      { lookupPullRequest: () => Promise.reject(new Error("GitHub unavailable")) },
      { lookupPullRequest: () => Promise.resolve(null) },
    ]
  ) {
    assertEquals(await resolveFixRun("probe-branch", undefined, { ...deps, ...failed }), {
      kind: "none",
    });
  }
  let spawned = false;
  const code = await runPush(["--force-with-lease", "--fix-comment", "c.md"], undefined, {
    branch: "probe-branch",
    ...deps,
    prepareComment: () => Promise.resolve(),
    postComment: () => Promise.resolve(0),
    confirmForce: () => {
      throw new Error("active fix must never ask");
    },
    spawnPush: (args) => {
      assertEquals(args.at(-1), "refs/heads/probe-branch:refs/heads/probe-branch");
      spawned = true;
      return Promise.resolve(0);
    },
  });
  assertEquals(code, 0);
  assertEquals(spawned, true);
});

const fixtureThread = "12345678-1234-5678-abcd-123456789abc";
type Surface = "claude" | "agy" | "codex";

async function createFixFixture(surface: Surface) {
  const fixture = await createFixtureRepo();
  const userHome = `${fixture.tempDir}/home`;
  const toolsDir = `${fixture.tempDir}/bin`;
  const codexHome = `${userHome}/.codex`;
  const sessionPath = surface === "codex"
    ? `${codexHome}/sessions/rollout-${fixtureThread}.jsonl`
    : surface === "claude"
    ? `${userHome}/.claude/projects/probe/${fixtureThread}.jsonl`
    : `${userHome}/.gemini/brain/${fixtureThread}/.system_generated/logs/transcript_full.jsonl`;
  await Deno.mkdir(sessionPath.slice(0, sessionPath.lastIndexOf("/")), { recursive: true });
  await Deno.mkdir(toolsDir);
  const realGit = (Deno.env.get("PATH") ?? "").split(":").map((dir) => `${dir}/git`).find(
    (path) => {
      try {
        return Deno.statSync(path).isFile;
      } catch {
        return false;
      }
    },
  );
  if (!realGit) throw new Error("git not found for local fixture");
  const quotedGit = `'${realGit.replaceAll("'", "'\\''")}'`;
  // Only repository discovery is stubbed; the push itself goes to the fixture's real bare origin.
  await Deno.writeTextFile(
    `${toolsDir}/git`,
    '#!/bin/sh\nif [ "$1" = remote ] && [ "$2" = get-url ]; then\n' +
      '  printf "%s\\n" "$PUSH_TEST_REMOTE"\n  exit 0\nfi\n' + `exec ${quotedGit} "$@"\n`,
  );
  await Deno.writeTextFile(
    `${toolsDir}/gh`,
    '#!/bin/sh\nif [ "$1" = pr ] && [ "$2" = comment ]; then\n' +
      '  printf "post\\n" >> "$PUSH_TEST_TRACE"\n' +
      '  while [ "$#" -gt 0 ]; do\n' +
      '    if [ "$1" = --body-file ]; then cat "$2" > "$PUSH_TEST_COMMENT_OUTPUT"; break; fi\n' +
      '    if [ "$1" = --body ]; then printf "%s" "$2" > "$PUSH_TEST_COMMENT_OUTPUT"; break; fi\n' +
      "    shift\n  done\n" +
      '  if [ "$PUSH_TEST_POST_EXIT" != 0 ]; then echo "comment unavailable" >&2; fi\n' +
      '  exit "$PUSH_TEST_POST_EXIT"\nfi\n' +
      'printf "%s\\n" "$PUSH_TEST_PR"\nexit "${PUSH_TEST_GH_EXIT:-0}"\n',
  );
  await Deno.chmod(`${toolsDir}/git`, 0o755);
  await Deno.chmod(`${toolsDir}/gh`, 0o755);
  const recordPath = `${fixture.tempDir}/agy-record.jsonl`;
  const shellEnv = {
    HOME: userHome,
    CODEX_HOME: codexHome,
    CODEX_THREAD_ID: surface === "codex" ? fixtureThread : "",
    CLAUDE_CODE_SESSION_ID: surface === "claude" ? fixtureThread : "",
    AGY_HOOK_RECORD_PATH: recordPath,
    AGY_CONVERSATION_ID: surface === "agy" ? fixtureThread : "",
    AGY_MODEL_NAME: surface === "agy" ? "gemini-3.8-flash-high" : "",
    AGY_TRANSCRIPT_PATH: surface === "agy" ? sessionPath : "",
    WJT_SURFACE: surface,
    PATH: `${toolsDir}:${Deno.env.get("PATH") ?? ""}`,
    PUSH_TEST_REMOTE: `https://github.com/${targetRepo}.git`,
    PUSH_TEST_PR: JSON.stringify(targetPr),
    PUSH_TEST_GH_EXIT: "0",
    PUSH_TEST_POST_EXIT: "0",
    PUSH_TEST_TRACE: `${fixture.tempDir}/post-trace`,
    PUSH_TEST_COMMENT_OUTPUT: `${fixture.tempDir}/posted-comment.md`,
    FORCED_PR_AUTHOR: "",
  };
  const writeSession = async (texts: string[], helper = false, damaged = false) => {
    const records = surface === "codex"
      ? [
        {
          type: "session_meta",
          timestamp: "2026-10-13T00:00:00Z",
          payload: {
            id: fixtureThread,
            source: helper ? "exec" : "cli",
            originator: helper ? "codex_exec" : "codex-tui",
            thread_source: "user",
            parent_thread_id: null,
          },
        },
        { type: "turn_context", payload: { model: "gpt-6-luna" } },
        ...texts.map((text) => ({
          type: "response_item",
          timestamp: "2026-10-13T01:00:00Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        })),
      ]
      : surface === "claude"
      ? [
        ...texts.map((text) => ({
          type: "user",
          timestamp: "2026-10-13T01:00:00Z",
          origin: { kind: "human" },
          isSidechain: helper,
          message: { role: "user", content: text },
        })),
        { type: "assistant", message: { role: "assistant", model: "claude-opus-5-5" } },
      ]
      : texts.map((text, step_index) => ({
        type: "USER_INPUT",
        timestamp: "2026-10-13T01:00:00Z",
        source: "USER_EXPLICIT",
        step_index,
        content: `<USER_REQUEST>${text}</USER_REQUEST>`,
      }));
    await Deno.writeTextFile(
      sessionPath,
      records.map((record) => JSON.stringify(record)).join("\n") + "\n" + (damaged ? "{torn" : ""),
    );
    if (surface === "agy") {
      await Deno.writeTextFile(
        recordPath,
        JSON.stringify({
          conversationId: fixtureThread,
          transcriptPath: sessionPath,
          modelName: "gemini-3.8-flash-high",
        }) + "\n",
      );
      const parent = `${userHome}/.gemini/brain/parent/.system_generated/subagents`;
      await Deno.mkdir(parent, { recursive: true });
      const childFile = `${parent}/${fixtureThread}.json`;
      if (helper) await Deno.writeTextFile(childFile, "{}");
      else {try {
          await Deno.remove(childFile);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }}
    }
  };
  await Deno.writeTextFile(
    `${fixture.repoDir}/c.md`,
    "Fixed formatting.\n\n🤖 Fixed by Codex — GPT\n",
  );
  return { ...fixture, shellEnv, writeSession, sessionPath, recordPath };
}

for (const surface of ["claude", "agy", "codex"] as const) {
  Deno.test(`${surface}: real Deno task pushes a rebased branch only for the closed fix-run case list`, async () => {
    const fixture = await createFixFixture(surface);
    try {
      await fixture.git(["push", "-q", "-u", "origin", "probe-branch"]);
      await Deno.writeTextFile(`${fixture.repoDir}/file.txt`, "rebased probe\n");
      await fixture.git(["commit", "-qam", "changed probe"]);
      // The remote stays at its original probe commit, while local HEAD replaces it.
      await fixture.git(["reset", "--soft", "HEAD~1"]);
      await fixture.git(["commit", "--amend", "-qm", "rebased probe"]);
      const forceArgs = ["--force-with-lease", "--fix-comment", "c.md"];
      const cases = [
        { texts: [fixCall.text], args: forceArgs, ok: true },
        {
          texts: ["/fix-pr https://github.com/WebJamApps/web-jam-tools/pull/1318"],
          args: forceArgs,
          ok: true,
        },
        { texts: ["/fix-pr 1318"], args: forceArgs, ok: true },
        { texts: [fixCall.text, "also bump the version"], args: forceArgs, ok: true },
        { texts: [fixCall.text], args: ["--fix-comment", "c.md"], ok: true },
        { texts: [fixCall.text], args: ["--force-with-lease"], rule: "missing-fix-comment" },
        { texts: [fixCall.text], args: [], rule: "missing-fix-comment" },
        { texts: [fixCall.text, "/pr-review"], args: forceArgs, rule: "fix-comment-outside-run" },
        {
          texts: [fixCall.text, "/fix-pr web-jam-tools#1322"],
          args: forceArgs,
          rule: "fix-run-mismatch",
        },
        { texts: ["/fix-pr JaMmusic#1318"], args: forceArgs, rule: "fix-run-mismatch" },
        {
          texts: ["/work-issue web-jam-tools#1317"],
          args: ["--force-with-lease"],
          rule: "force-with-lease-confirmation",
        },
        {
          texts: ["/work-issue web-jam-tools#1317"],
          args: ["--fix-comment", "c.md"],
          rule: "fix-comment-outside-run",
        },
        { texts: [fixCall.text], args: forceArgs, helper: true, rule: "fix-comment-outside-run" },
        {
          texts: [fixCall.text],
          args: ["--force-with-lease"],
          helper: true,
          rule: "force-with-lease-confirmation",
        },
        { texts: [fixCall.text], args: forceArgs, damaged: true, rule: "fix-comment-outside-run" },
        {
          texts: [fixCall.text],
          args: forceArgs,
          pr: { ...targetPr, state: "CLOSED" },
          rule: "fix-run-mismatch",
        },
        {
          texts: [fixCall.text],
          args: forceArgs,
          pr: { ...targetPr, state: "MERGED" },
          rule: "fix-run-mismatch",
        },
        {
          texts: [fixCall.text],
          args: forceArgs,
          pr: { ...targetPr, headRefName: "other" },
          rule: "fix-run-mismatch",
        },
        {
          texts: [fixCall.text],
          args: forceArgs,
          pr: { ...targetPr, isCrossRepository: true },
          rule: "fix-run-mismatch",
        },
        {
          texts: [fixCall.text],
          args: ["--force-with-lease"],
          ghExit: "1",
          rule: "force-with-lease-confirmation",
        },
        {
          texts: [fixCall.text],
          args: forceArgs,
          unattended: "1",
          rule: "fix-comment-outside-run",
        },
        ...["--force", "--delete", ":probe"].map((flag) => ({
          texts: [fixCall.text],
          args: [flag, "--fix-comment", "c.md"],
          rule: flag === "--force"
            ? "plain-force"
            : flag === "--delete"
            ? "branch-deletion"
            : "colon-refspec",
        })),
      ];
      let caseIndex = 0;
      for (const item of cases) {
        caseIndex++;
        await fixture.writeSession(
          item.texts,
          "helper" in item && item.helper,
          "damaged" in item && item.damaged,
        );
        if ("ok" in item && item.ok) {
          await Deno.writeTextFile(`${fixture.repoDir}/file.txt`, `case ${caseIndex}\n`);
          await fixture.git(["commit", "-qam", `case ${caseIndex}`]);
        }
        const before = await fixture.git(["ls-remote", "origin"]);
        const result = await runDenoTaskPush(item.args, fixture.repoDir, true, {
          ...fixture.shellEnv,
          PUSH_TEST_PR: JSON.stringify("pr" in item ? item.pr : targetPr),
          PUSH_TEST_GH_EXIT: "ghExit" in item ? item.ghExit ?? "0" : "0",
          WJT_UNATTENDED: "unattended" in item ? item.unattended ?? "" : "",
        });
        const allowed = "ok" in item && item.ok;
        assertEquals(result.code, allowed ? 0 : 1, `case ${caseIndex}: ${result.stderr}`);
        if (allowed) {
          assertEquals(result.stderr.includes("Force-push feature branch"), false);
          const remote = await fixture.git(["ls-remote", "origin", "refs/heads/probe-branch"]);
          assertEquals(remote.split(/\s+/)[0], await fixture.git(["rev-parse", "HEAD"]));
        } else {
          assertStringIncludes(result.stderr, `Refused (${"rule" in item ? item.rule : ""})`);
          assertEquals(await fixture.git(["ls-remote", "origin"]), before);
        }
      }
      if (surface === "codex") {
        await fixture.writeSession(["$fix-pr web-jam-tools#1318", "yes"]);
        assertEquals(
          (await runDenoTaskPush(forceArgs, fixture.repoDir, true, fixture.shellEnv)).code,
          0,
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });
}
