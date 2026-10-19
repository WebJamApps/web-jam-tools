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
): Promise<{ stubPath: string; logPath: string }> {
  const stubPath = path.join(dir, "stub-gitleaks.sh");
  const logPath = path.join(dir, "gitleaks-call.log");
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

    const sha = "a1b2c3d4e5f6789012345678901234567890abcd";
    const stdinLine = `refs/heads/feat ${sha} refs/heads/feat ${ZERO_OID}\n`;

    const res = await runCmd(
      ["bash", HOOK_PATH, "origin", "https://github.com/WebJamApps/test.git"],
      tempDir,
      stdinLine,
      { GITLEAKS_SCRIPT: stubPath },
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

    const oldSha = "1111111111111111111111111111111111111111";
    const newSha = "2222222222222222222222222222222222222222";
    const stdinLine = `refs/heads/feat ${newSha} refs/heads/feat ${oldSha}\n`;

    const res = await runCmd(
      ["bash", HOOK_PATH, "origin", "https://github.com/WebJamApps/test.git"],
      tempDir,
      stdinLine,
      { GITLEAKS_SCRIPT: stubPath },
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

    const tagSha = "4444444444444444444444444444444444444444";
    const stdinLine = `refs/tags/v1 ${tagSha} refs/tags/v1 ${ZERO_OID}\n`;

    const res = await runCmd(
      ["bash", HOOK_PATH, "origin", "https://github.com/WebJamApps/test.git"],
      tempDir,
      stdinLine,
      { GITLEAKS_SCRIPT: stubPath },
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
    const sha = "7777777777777777777777777777777777777777";
    const stdinLine = `refs/heads/main ${sha} refs/heads/main ${ZERO_OID}\n`;

    // 1. Exit 0: proceeds
    const { stubPath: stub0 } = await createStub(tempDir, 0);
    const res0 = await runCmd(
      ["bash", HOOK_PATH, "origin", "https://github.com/WebJamApps/test.git"],
      tempDir,
      stdinLine,
      { GITLEAKS_SCRIPT: stub0 },
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
      { GITLEAKS_SCRIPT: stubPath, REPO_HOOK_EXIT: "0" },
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
      { GITLEAKS_SCRIPT: stubPath, REPO_HOOK_EXIT: "42" },
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
