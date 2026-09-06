// semver_push_reminder_hook.test.ts — web-jam-tools#285, extended web-jam-tools#648
//
// hooks/semver-push-reminder.sh had NO behaviour test before #285. It is a
// non-blocking reminder hook: it never exits non-zero, it either emits a
// PreToolUse additionalContext JSON (when the command is a real `git push`)
// or emits nothing. Exercised the same way as the other hooks — shelling out
// to it (Deno.Command) with mocked PreToolUse JSON on stdin.
//
// web-jam-tools#648 made the hook branch-aware: a branch whose version field
// already differs from its merge-base with origin/dev gets a confirmation
// instead of the reminder (re-bumping is a defect, not a to-do), and every
// indeterminate case (no cwd, not a repo, no origin/dev ref, detached HEAD,
// no version file) falls open to the reminder. It also narrowed push
// detection so a `git push` substring inside a heredoc body or a quoted
// argument no longer fires. These cases need a REAL throwaway git repo (with
// a real bare "remote" standing in for origin) per case — never the real
// web-jam-tools checkout — since the hook reads the actual merge-base and
// version file. Same pattern as test/feature_branch_guard_hook.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/semver-push-reminder.sh",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stdout: string;
}

async function runHook(command: string, cwd?: string): Promise<RunResult> {
  const payload: Record<string, unknown> = { tool_input: { command } };
  if (cwd !== undefined) payload.cwd = cwd;
  const input = JSON.stringify(payload);
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code, stdout } = await child.output();
  return { code, stdout: new TextDecoder().decode(stdout) };
}

async function run(cmd: string, args: string[]): Promise<void> {
  const command = new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" });
  const { code, stderr } = await command.output();
  assertEquals(code, 0, `${cmd} ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`);
}

/**
 * Builds a throwaway repo + bare "remote" pair: a `dev` branch with a
 * committed `deno.json` at the given version, fetched into the working
 * repo's `origin/dev`, then checked out onto a feature branch. Callers then
 * optionally bump the version on the feature branch before invoking the
 * hook. Cleans up both dirs when `fn` returns or throws.
 */
async function withFeatureBranch(
  opts: { initialVersion: string; bumpTo?: string },
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const remoteDir = await Deno.makeTempDir();
  const dir = await Deno.makeTempDir();
  try {
    await run("git", ["init", "-q", "--bare", remoteDir]);
    await run("git", ["-C", dir, "init", "-q", "-b", "dev"]);
    await run("git", ["-C", dir, "config", "user.email", "test@example.invalid"]);
    await run("git", ["-C", dir, "config", "user.name", "Test"]);
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ version: opts.initialVersion }),
    );
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", ["-C", dir, "commit", "-q", "-m", "init"]);
    await run("git", ["-C", dir, "remote", "add", "origin", remoteDir]);
    await run("git", ["-C", dir, "push", "-q", "origin", "dev"]);
    await run("git", ["-C", dir, "fetch", "-q", "origin"]);
    await run("git", ["-C", dir, "checkout", "-q", "-b", "feat"]);
    if (opts.bumpTo) {
      await Deno.writeTextFile(
        `${dir}/deno.json`,
        JSON.stringify({ version: opts.bumpTo }),
      );
      await run("git", ["-C", dir, "commit", "-q", "-am", "bump"]);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(remoteDir, { recursive: true });
  }
}

// --- fires: real git push commands (existing #285 cases, unchanged) ---

Deno.test("git push fires the semver reminder", async () => {
  const res = await runHook("git push origin claude/285-hook-behaviour-tests");
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "SEMVER REMINDER");
  assertStringIncludes(res.stdout, "git-feature-branch-and-semver");
});

Deno.test("git push -u origin HEAD fires the semver reminder", async () => {
  const res = await runHook("git push -u origin HEAD");
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "SEMVER REMINDER");
});

// --- passes through: anything that isn't a git push (existing #285 cases) ---

Deno.test("gh pr create passes through silently", async () => {
  const res = await runHook("gh pr create --title T --body B");
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "");
});

// web-jam-tools#649 finding 1: this command lacks the raw "push" substring,
// so it exits via the cheap pre-filter BEFORE the Deno normalize_command.ts
// spawn — no Deno process is started for it at all. Left as one shared test
// (not duplicated) with the existing pass-through cases above, since the
// expected behavior (empty stdout, exit 0) is identical whether a command
// is filtered at the fast path or later at segment matching.
Deno.test("an ordinary command passes through silently (fast path: no git/push substring, no Deno spawn)", async () => {
  const res = await runHook("ls -la src/");
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "");
});

Deno.test("git pull passes through silently (not a push)", async () => {
  const res = await runHook("git pull origin dev");
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "");
});

// --- #648: branch-aware version comparison ---

Deno.test("unbumped feature branch still fires the SEMVER REMINDER", async () => {
  await withFeatureBranch({ initialVersion: "1.0.0" }, async (dir) => {
    const res = await runHook("git push origin HEAD", dir);
    assertEquals(res.code, 0);
    assertStringIncludes(res.stdout, "SEMVER REMINDER");
  });
});

Deno.test("already-bumped feature branch emits a confirmation, not the reminder", async () => {
  await withFeatureBranch(
    { initialVersion: "1.0.0", bumpTo: "1.0.1" },
    async (dir) => {
      const res = await runHook("git push origin HEAD", dir);
      assertEquals(res.code, 0);
      assert(
        !res.stdout.includes("SEMVER REMINDER"),
        `expected no SEMVER REMINDER, got: ${res.stdout}`,
      );
      assertStringIncludes(res.stdout, "already bumped");
      assertStringIncludes(res.stdout, "do NOT bump again");
      assertStringIncludes(res.stdout, "defect, not a to-do");
    },
  );
});

// --- #648: fail-open cases (indeterminate -> reminder, exit 0 always) ---

Deno.test("no cwd in payload falls open to the reminder", async () => {
  const res = await runHook("git push origin HEAD");
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "SEMVER REMINDER");
});

Deno.test("cwd that is not a git repo falls open to the reminder", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const res = await runHook("git push origin HEAD", dir);
    assertEquals(res.code, 0);
    assertStringIncludes(res.stdout, "SEMVER REMINDER");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("detached HEAD falls open to the reminder", async () => {
  await withFeatureBranch({ initialVersion: "1.0.0" }, async (dir) => {
    await run("git", ["-C", dir, "checkout", "-q", "--detach"]);
    const res = await runHook("git push origin HEAD", dir);
    assertEquals(res.code, 0);
    assertStringIncludes(res.stdout, "SEMVER REMINDER");
  });
});

Deno.test("missing origin/dev ref falls open to the reminder", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await run("git", ["-C", dir, "init", "-q", "-b", "feat"]);
    await run("git", ["-C", dir, "config", "user.email", "test@example.invalid"]);
    await run("git", ["-C", dir, "config", "user.name", "Test"]);
    await Deno.writeTextFile(`${dir}/deno.json`, JSON.stringify({ version: "1.0.0" }));
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", ["-C", dir, "commit", "-q", "-m", "init"]);
    const res = await runHook("git push origin HEAD", dir);
    assertEquals(res.code, 0);
    assertStringIncludes(res.stdout, "SEMVER REMINDER");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("no deno.json/package.json anywhere falls open to the reminder", async () => {
  const remoteDir = await Deno.makeTempDir();
  const dir = await Deno.makeTempDir();
  try {
    await run("git", ["init", "-q", "--bare", remoteDir]);
    await run("git", ["-C", dir, "init", "-q", "-b", "dev"]);
    await run("git", ["-C", dir, "config", "user.email", "test@example.invalid"]);
    await run("git", ["-C", dir, "config", "user.name", "Test"]);
    await run("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"]);
    await run("git", ["-C", dir, "remote", "add", "origin", remoteDir]);
    await run("git", ["-C", dir, "push", "-q", "origin", "dev"]);
    await run("git", ["-C", dir, "fetch", "-q", "origin"]);
    await run("git", ["-C", dir, "checkout", "-q", "-b", "feat"]);
    const res = await runHook("git push origin HEAD", dir);
    assertEquals(res.code, 0);
    assertStringIncludes(res.stdout, "SEMVER REMINDER");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(remoteDir, { recursive: true });
  }
});

Deno.test("malformed JSON on stdin never blocks and never exits non-zero", async () => {
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode("not json at all"));
  await writer.close();
  const { code, stdout } = await child.output();
  assertEquals(code, 0);
  assertEquals(new TextDecoder().decode(stdout), "");
});

// --- #648: substring false positive (heredoc / quoted argument) ---

Deno.test("git push mentioned inside a heredoc body does not fire", async () => {
  const res = await runHook(
    "cat > notes.md <<'EOF'\ndoc note: run git push origin HEAD when ready\nEOF\n",
  );
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "");
});

Deno.test("git push mentioned inside a quoted argument does not fire", async () => {
  const res = await runHook('echo "please run git push later"');
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "");
});

Deno.test("a real git push after a leading cd && still fires", async () => {
  const res = await runHook("cd /tmp && git push origin HEAD");
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "SEMVER REMINDER");
});

Deno.test("a real git push after a semicolon still fires", async () => {
  const res = await runHook("echo hi; git push origin HEAD");
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "SEMVER REMINDER");
});

// --- web-jam-tools#649 Must Fix 1: quoted string preceding a real push ---

Deno.test("a real git push straddled by two quoted strings still fires (Must Fix 1)", async () => {
  // Two apostrophes/quotes, one on each side of the push: a naive two-pass
  // quote stripper (single-quote pass first, double-quote pass second)
  // mispairs the apostrophes in "don't" and "it's" and deletes the real
  // `git push` between them.
  const res = await runHook(
    `git commit -m "don't nag" && git push origin HEAD && gh pr comment 649 --body "it's pushed"`,
  );
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "SEMVER REMINDER");
});

// --- web-jam-tools#649 Must Fix 2: wrapper text before `git` in the segment ---

Deno.test("sudo git push still fires (Must Fix 2)", async () => {
  const res = await runHook("sudo git push origin HEAD");
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "SEMVER REMINDER");
});

Deno.test("git push inside an if/then still fires (Must Fix 2)", async () => {
  const res = await runHook("if true; then git push origin HEAD; fi");
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "SEMVER REMINDER");
});

Deno.test("git push inside a subshell still fires (Must Fix 2)", async () => {
  const res = await runHook("(git push origin HEAD)");
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "SEMVER REMINDER");
});

// --- web-jam-tools#649 delta review Must Fix: argument-less push closing a
// subshell/group. The anchor demanded whitespace-or-end-of-string after
// `push`, so `)` landing directly against `push` (no arguments to keep them
// apart) failed to match even though `(git push origin HEAD)` — which has
// arguments — already fired. These five all fire on `dev` and were silent
// at the PR head before this fix. ---

Deno.test("an argument-less git push inside a bare subshell still fires (delta Must Fix)", async () => {
  const res = await runHook("(git push)");
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "SEMVER REMINDER");
});

Deno.test("an argument-less git push after cd inside a subshell still fires (delta Must Fix)", async () => {
  const res = await runHook("(cd /tmp/wt && git push)");
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "SEMVER REMINDER");
});

Deno.test("git push inside a brace group still fires (delta Must Fix 2)", async () => {
  const res = await runHook("{ git push; }");
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "SEMVER REMINDER");
});

Deno.test("a leading VAR=value assignment prefix still fires (delta Must Fix 2)", async () => {
  const res = await runHook("FOO=bar git push origin HEAD");
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "SEMVER REMINDER");
});

Deno.test("stacked wrappers (time sudo) still fire (delta Must Fix 3)", async () => {
  const res = await runHook("time sudo git push origin HEAD");
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "SEMVER REMINDER");
});

// --- must-stay-silent cases, re-confirmed alongside the Must Fix 1/2 fixes ---

Deno.test("git push mentioned inside a heredoc body still does not fire", async () => {
  const res = await runHook(
    "cat > notes.md <<'EOF'\ndoc note: run git push origin HEAD when ready\nEOF\n",
  );
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "");
});

Deno.test("git push mentioned inside a double-quoted argument still does not fire", async () => {
  const res = await runHook('echo "please run git push later"');
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "");
});

Deno.test("git push mentioned inside a single-quoted argument does not fire", async () => {
  const res = await runHook("echo 'please run git push later'");
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "");
});

Deno.test('a single-quoted string wrapping a double-quoted "git push" does not fire', async () => {
  const res = await runHook(`echo 'about "git push" in quotes'`);
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "");
});
