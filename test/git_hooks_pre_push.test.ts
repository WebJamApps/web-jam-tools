// test/git_hooks_pre_push.test.ts — web-jam-tools#1404
// Tests for git-hooks/pre-push machine-wide push-time secret scanner.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";

const ROOT_DIR = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const HOOK_PATH = path.join(ROOT_DIR, "git-hooks", "pre-push");
const MASTER_CONFIG = path.join(ROOT_DIR, ".gitleaks.toml");
const ZERO_OID = "0000000000000000000000000000000000000000";

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCmd(
  cmd: string[],
  cwd?: string,
  stdinText?: string,
  env?: Record<string, string>,
): Promise<CmdResult> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: cwd ?? ROOT_DIR,
    stdin: stdinText !== undefined ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
    env: {
      ...Deno.env.toObject(),
      ...env,
    },
  });

  const child = command.spawn();
  if (stdinText !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdinText));
    await writer.close();
  }

  const output = await child.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

async function createStub(
  dir: string,
  exitCode: number,
  outputMessage = "",
  scriptName = "stub-gitleaks.sh",
  logName = "gitleaks-call.log",
): Promise<{ stubPath: string; logPath: string }> {
  const stubPath = path.join(dir, scriptName);
  const logPath = path.join(dir, logName);
  const scriptContent = `#!/usr/bin/env bash
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "${logPath}"
done
printf '---END CALL---\\n' >> "${logPath}"
${outputMessage ? `printf '%s\\n' "${outputMessage}" >&2` : ""}
exit ${exitCode}
`;
  await Deno.writeTextFile(stubPath, scriptContent);
  await Deno.chmod(stubPath, 0o755);
  return { stubPath, logPath };
}

async function createCleanCopyStub(dir: string): Promise<string> {
  const { stubPath } = await createStub(dir, 0, "", "stub-copy-clean.sh", "copy-clean.log");
  return stubPath;
}

// --- Preserved cases from install_git_secret_hook.test.ts ---

Deno.test("master .gitleaks.toml exists and has valid structure", async () => {
  const content = await Deno.readTextFile(MASTER_CONFIG);
  assertStringIncludes(content, "WebJamApps Gitleaks Configuration");
  assertStringIncludes(content, "google-api-key");
  assertStringIncludes(content, "github-pat");
  assert(
    !content.includes("webjam-fixture-ok"),
    ".gitleaks.toml must not contain webjam-fixture-ok",
  );
});

Deno.test("scripts/gitleaks.sh executes cleanly against repository", async () => {
  const res = await runCmd([
    "bash",
    path.join(ROOT_DIR, "scripts", "gitleaks.sh"),
    "--log-opts=-n 1",
  ]);
  assertEquals(res.code, 0, `gitleaks failed: ${res.stderr}`);
  const combined = `${res.stdout}\n${res.stderr}`;
  assertStringIncludes(combined, "no leaks found");
});

// --- Acceptance criteria tests for git-hooks/pre-push ---

Deno.test("refs/heads/feat <sha> refs/heads/feat 0000000000000000000000000000000000000000 scans <sha> --not --remotes", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "pre-push-feat-new-" });
  try {
    await runCmd(["git", "init", "-q"], tempDir);
    const { stubPath, logPath } = await createStub(tempDir, 0);
    const copyStub = await createCleanCopyStub(tempDir);

    const sha = "a1b2c3d4e5f6789012345678901234567890abcd";
    const stdinLine = `refs/heads/feat ${sha} refs/heads/feat ${ZERO_OID}\n`;

    const res = await runCmd(
      ["bash", HOOK_PATH, "origin", "https://github.com/WebJamApps/test.git"],
      tempDir,
      stdinLine,
      { GITLEAKS_SCRIPT: stubPath, CHECK_COPIES_SCRIPT: copyStub },
    );

    assertEquals(res.code, 0, `Hook failed: ${res.stderr}`);
    const log = await Deno.readTextFile(logPath);
    assertStringIncludes(log, `--log-opts=${sha} --not --remotes`);
    assertStringIncludes(log, `--repo`);
    assertStringIncludes(log, tempDir);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("refs/heads/feat <new> refs/heads/feat <old> scans <old>..<new>", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "pre-push-feat-update-" });
  try {
    await runCmd(["git", "init", "-q"], tempDir);
    const { stubPath, logPath } = await createStub(tempDir, 0);
    const copyStub = await createCleanCopyStub(tempDir);

    const oldSha = "1111111111111111111111111111111111111111";
    const newSha = "2222222222222222222222222222222222222222";
    const stdinLine = `refs/heads/feat ${newSha} refs/heads/feat ${oldSha}\n`;

    const res = await runCmd(
      ["bash", HOOK_PATH, "origin", "https://github.com/WebJamApps/test.git"],
      tempDir,
      stdinLine,
      { GITLEAKS_SCRIPT: stubPath, CHECK_COPIES_SCRIPT: copyStub },
    );

    assertEquals(res.code, 0, `Hook failed: ${res.stderr}`);
    const log = await Deno.readTextFile(logPath);
    assertStringIncludes(log, `--log-opts=${oldSha}..${newSha}`);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("(delete) 0000000000000000000000000000000000000000 refs/heads/feat <old> scans nothing for that line", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "pre-push-delete-" });
  try {
    await runCmd(["git", "init", "-q"], tempDir);
    const { stubPath, logPath } = await createStub(tempDir, 0);

    const oldSha = "3333333333333333333333333333333333333333";
    const stdinLine = `(delete) ${ZERO_OID} refs/heads/feat ${oldSha}\n`;

    const res = await runCmd(
      ["bash", HOOK_PATH, "origin", "https://github.com/WebJamApps/test.git"],
      tempDir,
      stdinLine,
      { GITLEAKS_SCRIPT: stubPath },
    );

    assertEquals(res.code, 0, `Hook failed: ${res.stderr}`);
    const logExists = await Deno.stat(logPath).then(() => true).catch(() => false);
    if (logExists) {
      const log = await Deno.readTextFile(logPath);
      assertEquals(log.trim(), "", "Delete ref should not trigger any gitleaks scan");
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("refs/tags/v1 <sha> refs/tags/v1 0000000000000000000000000000000000000000 scans <sha> --not --remotes", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "pre-push-tag-new-" });
  try {
    await runCmd(["git", "init", "-q"], tempDir);
    const { stubPath, logPath } = await createStub(tempDir, 0);
    const copyStub = await createCleanCopyStub(tempDir);

    const tagSha = "4444444444444444444444444444444444444444";
    const stdinLine = `refs/tags/v1 ${tagSha} refs/tags/v1 ${ZERO_OID}\n`;

    const res = await runCmd(
      ["bash", HOOK_PATH, "origin", "https://github.com/WebJamApps/test.git"],
      tempDir,
      stdinLine,
      { GITLEAKS_SCRIPT: stubPath, CHECK_COPIES_SCRIPT: copyStub },
    );

    assertEquals(res.code, 0, `Hook failed: ${res.stderr}`);
    const log = await Deno.readTextFile(logPath);
    assertStringIncludes(log, `--log-opts=${tagSha} --not --remotes`);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("Two lines in one push: both ranges are scanned, and any finding refuses the whole push", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "pre-push-two-lines-" });
  try {
    await runCmd(["git", "init", "-q"], tempDir);

    // Stub exits 2 (finding detected)
    const { stubPath, logPath } = await createStub(
      tempDir,
      2,
      "leak.ts:1 -> google-api-key",
    );

    const sha1 = "5555555555555555555555555555555555555555";
    const sha2 = "6666666666666666666666666666666666666666";
    const stdinContent = `refs/heads/branch-a ${sha1} refs/heads/branch-a ${ZERO_OID}\n` +
      `refs/heads/branch-b ${sha2} refs/heads/branch-b ${ZERO_OID}\n`;

    const res = await runCmd(
      ["bash", HOOK_PATH, "origin", "https://github.com/WebJamApps/test.git"],
      tempDir,
      stdinContent,
      { GITLEAKS_SCRIPT: stubPath },
    );

    // Must be refused
    assertEquals(res.code, 2, "Push with finding must be refused with code 2");
    assertStringIncludes(res.stderr, "PUSH REFUSED");
    assertStringIncludes(res.stderr, "The way out");

    // Both ranges must have been scanned
    const log = await Deno.readTextFile(logPath);
    assertStringIncludes(log, `--log-opts=${sha1} --not --remotes`);
    assertStringIncludes(log, `--log-opts=${sha2} --not --remotes`);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("Empty standard input: the push proceeds", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "pre-push-empty-stdin-" });
  try {
    await runCmd(["git", "init", "-q"], tempDir);
    const { stubPath, logPath } = await createStub(tempDir, 0);

    const res = await runCmd(
      ["bash", HOOK_PATH, "origin", "https://github.com/WebJamApps/test.git"],
      tempDir,
      "",
      { GITLEAKS_SCRIPT: stubPath },
    );

    assertEquals(res.code, 0, `Push with empty stdin should proceed: ${res.stderr}`);
    const logExists = await Deno.stat(logPath).then(() => true).catch(() => false);
    if (logExists) {
      const log = await Deno.readTextFile(logPath);
      assertEquals(log.trim(), "", "Empty stdin should not call scanner");
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("Stubbed scripts/gitleaks.sh exit 0: proceeds; exit 2: refused with way out; exit 1: refused naming failure; script missing: refused", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "pre-push-outcomes-" });
  try {
    await runCmd(["git", "init", "-q"], tempDir);
    const copyStub = await createCleanCopyStub(tempDir);
    const sha = "7777777777777777777777777777777777777777";
    const stdinLine = `refs/heads/main ${sha} refs/heads/main ${ZERO_OID}\n`;

    // 1. Exit 0: proceeds
    const { stubPath: stub0 } = await createStub(tempDir, 0);
    const res0 = await runCmd(
      ["bash", HOOK_PATH, "origin", "https://github.com/WebJamApps/test.git"],
      tempDir,
      stdinLine,
      { GITLEAKS_SCRIPT: stub0, CHECK_COPIES_SCRIPT: copyStub },
    );
    assertEquals(res0.code, 0);

    // 2. Exit 2: refused with the way out printed
    const { stubPath: stub2 } = await createStub(
      tempDir,
      2,
      "leak.ts:10 -> google-api-key",
    );
    const res2 = await runCmd(
      ["bash", HOOK_PATH, "origin", "https://github.com/WebJamApps/test.git"],
      tempDir,
      stdinLine,
      { GITLEAKS_SCRIPT: stub2 },
    );
    assertEquals(res2.code, 2);
    assertStringIncludes(res2.stderr, "PUSH REFUSED");
    assertStringIncludes(res2.stderr, "The way out:");
    assertStringIncludes(res2.stderr, "git commit --amend");
    assertStringIncludes(res2.stderr, ".gitleaksignore");

    // 3. Exit 1: refused naming failure
    const { stubPath: stub1 } = await createStub(
      tempDir,
      1,
      "ERROR: Docker is required to run gitleaks",
    );
    const res1 = await runCmd(
      ["bash", HOOK_PATH, "origin", "https://github.com/WebJamApps/test.git"],
      tempDir,
      stdinLine,
      { GITLEAKS_SCRIPT: stub1 },
    );
    assertEquals(res1.code, 1);
    assertStringIncludes(res1.stderr, "PUSH REFUSED");
    assertStringIncludes(res1.stderr, "secret scanner failed to run");

    // 4. Script missing: refused
    const resMissing = await runCmd(
      ["bash", HOOK_PATH, "origin", "https://github.com/WebJamApps/test.git"],
      tempDir,
      stdinLine,
      { GITLEAKS_SCRIPT: path.join(tempDir, "missing-scanner.sh") },
    );
    assert(resMissing.code !== 0);
    assertStringIncludes(resMissing.stderr, "PUSH REFUSED");
    assertStringIncludes(resMissing.stderr, "not found");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("An executable .git/hooks/pre-push in the repository runs after a clean scan with the same arguments and input, and its non-zero exit refuses the push", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "pre-push-repo-hook-" });
  try {
    await runCmd(["git", "init", "-q"], tempDir);
    const { stubPath } = await createStub(tempDir, 0);

    const repoHookPath = path.join(tempDir, ".git", "hooks", "pre-push");
    const repoLogPath = path.join(tempDir, "repo-hook-receipts.log");
    const copyStub = await createCleanCopyStub(tempDir);

    // Create repo-level pre-push hook that logs arguments and stdin, then exits with custom code
    const repoHookScript = `#!/usr/bin/env bash
echo "ARGS: $@" > "${repoLogPath}"
echo "STDIN:" >> "${repoLogPath}"
cat >> "${repoLogPath}"
exit \${REPO_HOOK_EXIT:-0}
`;
    await Deno.mkdir(path.dirname(repoHookPath), { recursive: true });
    await Deno.writeTextFile(repoHookPath, repoHookScript);
    await Deno.chmod(repoHookPath, 0o755);

    const sha = "8888888888888888888888888888888888888888";
    const stdinLine = `refs/heads/feature ${sha} refs/heads/feature ${ZERO_OID}\n`;
    const hookArgs = ["origin", "git@github.com:WebJamApps/custom.git"];

    // 1. Repo hook exits 0: push proceeds
    const resClean = await runCmd(
      ["bash", HOOK_PATH, ...hookArgs],
      tempDir,
      stdinLine,
      { GITLEAKS_SCRIPT: stubPath, CHECK_COPIES_SCRIPT: copyStub, REPO_HOOK_EXIT: "0" },
    );
    assertEquals(resClean.code, 0, `Push should succeed: ${resClean.stderr}`);

    const logClean = await Deno.readTextFile(repoLogPath);
    assertStringIncludes(logClean, "ARGS: origin git@github.com:WebJamApps/custom.git");
    assertStringIncludes(logClean, stdinLine);

    // 2. Repo hook exits 42: push is refused with exit code 42
    await Deno.remove(repoLogPath).catch(() => {});
    const resRefused = await runCmd(
      ["bash", HOOK_PATH, ...hookArgs],
      tempDir,
      stdinLine,
      { GITLEAKS_SCRIPT: stubPath, CHECK_COPIES_SCRIPT: copyStub, REPO_HOOK_EXIT: "42" },
    );
    assertEquals(
      resRefused.code,
      42,
      "Repository pre-push hook non-zero exit must refuse the push",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("An executable .git/hooks/pre-push in the common repository directory runs when pushing from a linked worktree, and its non-zero exit refuses the push", async () => {
  const mainDir = await Deno.makeTempDir({ prefix: "pre-push-worktree-main-" });
  const worktreeDir = await Deno.makeTempDir({ prefix: "pre-push-worktree-linked-" });
  try {
    await runCmd(["git", "init", "-q"], mainDir);
    await runCmd(["git", "config", "user.email", "test@example.com"], mainDir);
    await runCmd(["git", "config", "user.name", "Test User"], mainDir);
    await runCmd(["git", "commit", "--allow-empty", "-m", "init"], mainDir);

    const { stubPath } = await createStub(mainDir, 0);

    const repoHookPath = path.join(mainDir, ".git", "hooks", "pre-push");
    const repoLogPath = path.join(mainDir, "worktree-hook-receipts.log");
    const copyStub = await createCleanCopyStub(mainDir);

    const repoHookScript = `#!/usr/bin/env bash
echo "ARGS: $@" > "${repoLogPath}"
echo "STDIN:" >> "${repoLogPath}"
cat >> "${repoLogPath}"
exit \${REPO_HOOK_EXIT:-0}
`;
    await Deno.mkdir(path.dirname(repoHookPath), { recursive: true });
    await Deno.writeTextFile(repoHookPath, repoHookScript);
    await Deno.chmod(repoHookPath, 0o755);

    // Create a linked worktree
    const addWt = await runCmd(
      ["git", "worktree", "add", "-b", "feat-worktree", worktreeDir],
      mainDir,
    );
    assertEquals(addWt.code, 0, `worktree add failed: ${addWt.stderr}`);

    const sha = "9999999999999999999999999999999999999999";
    const stdinLine = `refs/heads/feat-worktree ${sha} refs/heads/feat-worktree ${ZERO_OID}\n`;
    const hookArgs = ["origin", "git@github.com:WebJamApps/worktree-test.git"];

    // 1. Repo hook exits 0: push from linked worktree proceeds
    const resClean = await runCmd(
      ["bash", HOOK_PATH, ...hookArgs],
      worktreeDir,
      stdinLine,
      { GITLEAKS_SCRIPT: stubPath, CHECK_COPIES_SCRIPT: copyStub, REPO_HOOK_EXIT: "0" },
    );
    assertEquals(resClean.code, 0, `Push from linked worktree should succeed: ${resClean.stderr}`);

    const logClean = await Deno.readTextFile(repoLogPath);
    assertStringIncludes(logClean, "ARGS: origin git@github.com:WebJamApps/worktree-test.git");
    assertStringIncludes(logClean, stdinLine);

    // 2. Repo hook exits 42: push from linked worktree is refused with exit code 42
    await Deno.remove(repoLogPath).catch(() => {});
    const resRefused = await runCmd(
      ["bash", HOOK_PATH, ...hookArgs],
      worktreeDir,
      stdinLine,
      { GITLEAKS_SCRIPT: stubPath, CHECK_COPIES_SCRIPT: copyStub, REPO_HOOK_EXIT: "42" },
    );
    assertEquals(
      resRefused.code,
      42,
      "Repository pre-push hook non-zero exit must refuse push from linked worktree",
    );

    // 3. Self-recursion check: symlink repo hook to HOOK_PATH should not recurse
    await Deno.remove(repoHookPath).catch(() => {});
    await Deno.symlink(HOOK_PATH, repoHookPath);
    const resSymlink = await runCmd(
      ["bash", HOOK_PATH, ...hookArgs],
      worktreeDir,
      stdinLine,
      { GITLEAKS_SCRIPT: stubPath, CHECK_COPIES_SCRIPT: copyStub },
    );
    assertEquals(
      resSymlink.code,
      0,
      "Self-referential repo hook symlink must be skipped without error",
    );
  } finally {
    await runCmd(["git", "worktree", "remove", "--force", worktreeDir], mainDir).catch(() => {});
    await Deno.remove(worktreeDir, { recursive: true }).catch(() => {});
    await Deno.remove(mainDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("git-hooks/pre-push invokes copy check for each pushed range without --whole-file and refuses on non-zero exit", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "pre-push-copy-stub-" });
  try {
    await runCmd(["git", "init", "-q"], tempDir);
    const { stubPath: gitleaksStub } = await createStub(tempDir, 0);
    const { stubPath: copyPassStub, logPath: copyPassLog } = await createStub(
      tempDir,
      0,
      "",
      "stub-copy-pass.sh",
      "copy-pass.log",
    );

    const sha1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const sha2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const sha3 = "cccccccccccccccccccccccccccccccccccccccc";
    const stdinContent = `refs/heads/feat-a ${sha1} refs/heads/feat-a ${ZERO_OID}\n` +
      `refs/heads/feat-b ${sha3} refs/heads/feat-b ${sha2}\n` +
      `(delete) ${ZERO_OID} refs/heads/old ${sha2}\n`;

    const resPass = await runCmd(
      ["bash", HOOK_PATH, "origin", "https://github.com/WebJamApps/test.git"],
      tempDir,
      stdinContent,
      { GITLEAKS_SCRIPT: gitleaksStub, CHECK_COPIES_SCRIPT: copyPassStub },
    );
    assertEquals(resPass.code, 0, `Clean copy check should pass: ${resPass.stderr}`);

    const log = await Deno.readTextFile(copyPassLog);
    assertStringIncludes(log, `--repo\n${tempDir}`);
    assertStringIncludes(log, `--range\n${sha1} --not --remotes`);
    assertStringIncludes(log, `--range\n${sha2}..${sha3}`);
    assert(!log.includes("--whole-file"), "pre-push must never pass --whole-file");

    const { stubPath: copyFailStub } = await createStub(
      tempDir,
      1,
      "Copy violation in skills/design-issue/SKILL.md",
      "stub-copy-fail.sh",
      "copy-fail.log",
    );
    const resFail = await runCmd(
      ["bash", HOOK_PATH, "origin", "https://github.com/WebJamApps/test.git"],
      tempDir,
      stdinContent,
      { GITLEAKS_SCRIPT: gitleaksStub, CHECK_COPIES_SCRIPT: copyFailStub },
    );
    assertEquals(resFail.code, 1);
    assertStringIncludes(resFail.stderr, "Copy violation in skills/design-issue/SKILL.md");
    assertStringIncludes(resFail.stderr, "PUSH REFUSED");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("git-hooks/pre-push runs real design:check-copies against pushed range and refuses copied wording", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "pre-push-copy-e2e-" });
  const designRoot = path.join(tempDir, "design-docs");
  const bareRepo = path.join(tempDir, "remote.git");
  const workRepo = path.join(tempDir, "work");
  const copiedLine =
    "The lookup debounces typing and asks the backend with a key only the server holds and returns the exact position";
  try {
    const themeDir = path.join(designRoot, "Token_Savings");
    await Deno.mkdir(themeDir, { recursive: true });
    const designDoc = path.join(themeDir, "sample-design-2026-08-23.md");
    await Deno.writeTextFile(
      designDoc,
      `# Sample\n\n## What it is\n\n${copiedLine}\n\n## Both surfaces\n\nAll.\n`,
    );

    await runCmd(["git", "init", "--bare", "-q", bareRepo]);
    await Deno.mkdir(workRepo, { recursive: true });
    await runCmd(["git", "init", "-q", "-b", "dev"], workRepo);
    await runCmd(["git", "config", "user.email", "test@example.com"], workRepo);
    await runCmd(["git", "config", "user.name", "Test User"], workRepo);
    await runCmd(["git", "remote", "add", "origin", bareRepo], workRepo);

    const skillPath = path.join(workRepo, "skills", "design-issue", "SKILL.md");
    await Deno.mkdir(path.dirname(skillPath), { recursive: true });
    await Deno.writeTextFile(skillPath, "# Design Issue\n\nBase text.\n");
    await runCmd(["git", "add", "skills/design-issue/SKILL.md"], workRepo);
    await runCmd(["git", "commit", "-m", "base on dev"], workRepo);
    await runCmd(["git", "push", "-q", "origin", "dev"], workRepo);

    await runCmd(["git", "checkout", "-q", "-b", "feat/copy"], workRepo);
    await Deno.writeTextFile(skillPath, `# Design Issue\n\n${copiedLine}\n`);
    await runCmd(["git", "add", "skills/design-issue/SKILL.md"], workRepo);
    await runCmd(["git", "commit", "-m", "add copied line"], workRepo);
    const headSha = (await runCmd(["git", "rev-parse", "HEAD"], workRepo)).stdout.trim();

    const { stubPath: gitleaksStub } = await createStub(tempDir, 0);
    const stdinLine = `refs/heads/feat/copy ${headSha} refs/heads/feat/copy ${ZERO_OID}\n`;

    const resFail = await runCmd(
      ["bash", HOOK_PATH, "origin", bareRepo],
      workRepo,
      stdinLine,
      {
        GITLEAKS_SCRIPT: gitleaksStub,
        DESIGN_DOCS_ROOT: designRoot,
        DENO_BIN: Deno.execPath(),
      },
    );
    assertEquals(resFail.code, 1, `Expected push refusal, got stdout=${resFail.stdout}`);
    assertStringIncludes(resFail.stderr, "skills/design-issue/SKILL.md");
    assertStringIncludes(resFail.stderr, designDoc);
    assertStringIncludes(resFail.stderr, copiedLine);
    assertStringIncludes(resFail.stderr, "PUSH REFUSED");

    // Remove copied line in a new commit and verify clean push passes
    await Deno.writeTextFile(skillPath, "# Design Issue\n\nClean pointer only.\n");
    await runCmd(["git", "add", "skills/design-issue/SKILL.md"], workRepo);
    await runCmd(["git", "commit", "-m", "remove copied line"], workRepo);
    const cleanSha = (await runCmd(["git", "rev-parse", "HEAD"], workRepo)).stdout.trim();

    const resPass = await runCmd(
      ["bash", HOOK_PATH, "origin", bareRepo],
      workRepo,
      `refs/heads/feat/copy ${cleanSha} refs/heads/feat/copy ${ZERO_OID}\n`,
      {
        GITLEAKS_SCRIPT: gitleaksStub,
        DESIGN_DOCS_ROOT: designRoot,
        DENO_BIN: Deno.execPath(),
      },
    );
    assertEquals(resPass.code, 0, `Clean push should succeed: ${resPass.stderr}`);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});
