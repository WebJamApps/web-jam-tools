// gitleaks_ci_history_scan.test.ts — web-jam-tools#696
// Tests proving CI gitleaks bounded history scan detects secrets committed and
// removed on the same branch while working-tree scan passes.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";

const ROOT_DIR = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const GITLEAKS_SCRIPT = path.join(ROOT_DIR, "scripts", "gitleaks.sh");
const MASTER_CONFIG = path.join(ROOT_DIR, ".gitleaks.toml");

async function runCmd(cmd: string[], cwd?: string, env?: Record<string, string>): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: cwd ?? ROOT_DIR,
    env: env ? { ...Deno.env.toObject(), ...env } : undefined,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });

  const output = await command.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

Deno.test("history scan detects secret committed and removed on same branch while working-tree scan passes", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gitleaks-ci-history-" });
  try {
    // 1. Initialize git repo on dev branch
    await runCmd(["git", "init", "-b", "dev"], tempDir);
    await runCmd(["git", "config", "user.email", "ci-tester@webjam.com"], tempDir);
    await runCmd(["git", "config", "user.name", "CI Tester"], tempDir);

    // Initial commit on dev
    await Deno.writeTextFile(path.join(tempDir, "README.md"), "# Project Root\n");
    await runCmd(["git", "add", "README.md"], tempDir);
    await runCmd(["git", "commit", "-m", "initial commit on dev"], tempDir);

    // 2. Create feature branch off dev
    await runCmd(["git", "checkout", "-b", "feat/temporary-secret"], tempDir);

    // Commit 1: Add a secret matching .gitleaks.toml (Google API key pattern)
    const secretSuffix = "DUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMM"; // 33 chars
    const fakeSecret = `AIzaSy${secretSuffix}`; // 39 chars total
    await Deno.mkdir(path.join(tempDir, "src"), { recursive: true });
    await Deno.writeTextFile(
      path.join(tempDir, "src", "credentials.ts"),
      `export const API_KEY = "${fakeSecret}";\n`,
    );
    await runCmd(["git", "add", "src/credentials.ts"], tempDir);
    await runCmd(["git", "commit", "-m", "feat: add api key temporarily"], tempDir);

    // Commit 2: Remove the secret file completely
    await runCmd(["git", "rm", "src/credentials.ts"], tempDir);
    await runCmd(["git", "commit", "-m", "fix: remove api key before PR"], tempDir);

    // 3. Working-tree scan (--no-git) PASSES because file is no longer in working tree
    const workTreeRes = await runCmd([
      "gitleaks",
      "detect",
      `--config=${MASTER_CONFIG}`,
      "--no-banner",
      "--redact=100",
      "--no-git",
      `--source=${tempDir}`,
    ], tempDir);
    assertEquals(workTreeRes.code, 0, `Working-tree scan should pass: ${workTreeRes.stderr}`);
    const workTreeOutput = `${workTreeRes.stdout}\n${workTreeRes.stderr}`;
    assertStringIncludes(workTreeOutput, "no leaks found");

    // 4. Bounded history scan (${MERGE_BASE}..HEAD) FAILS by finding the leak in commit history
    const mergeBaseRes = await runCmd(["git", "merge-base", "dev", "HEAD"], tempDir);
    assertEquals(mergeBaseRes.code, 0);
    const mergeBase = mergeBaseRes.stdout.trim();

    const historyScanRes = await runCmd([
      "gitleaks",
      "detect",
      `--config=${MASTER_CONFIG}`,
      "--no-banner",
      "--redact=100",
      `--log-opts=${mergeBase}..HEAD`,
    ], tempDir);
    assertEquals(
      historyScanRes.code,
      1,
      "Bounded history scan should fail on secret in commit history",
    );
    const historyOutput = `${historyScanRes.stdout}\n${historyScanRes.stderr}`;
    assertStringIncludes(historyOutput, "leaks found: 1");

    // Secret reporting discipline: the actual secret literal must not appear in output
    assert(!historyOutput.includes(fakeSecret), "Secret literal was leaked in gitleaks output");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("history scan passes on clean feature branch with multiple commits", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gitleaks-clean-branch-" });
  try {
    await runCmd(["git", "init", "-b", "dev"], tempDir);
    await runCmd(["git", "config", "user.email", "ci-tester@webjam.com"], tempDir);
    await runCmd(["git", "config", "user.name", "CI Tester"], tempDir);

    await Deno.writeTextFile(path.join(tempDir, "README.md"), "# Clean Project\n");
    await runCmd(["git", "add", "README.md"], tempDir);
    await runCmd(["git", "commit", "-m", "initial commit on dev"], tempDir);

    await runCmd(["git", "checkout", "-b", "feat/clean-feature"], tempDir);

    await Deno.mkdir(path.join(tempDir, "src"), { recursive: true });
    await Deno.writeTextFile(
      path.join(tempDir, "src", "index.ts"),
      "export const hello = 'world';\n",
    );
    await runCmd(["git", "add", "src/index.ts"], tempDir);
    await runCmd(["git", "commit", "-m", "feat: add index"], tempDir);

    await Deno.writeTextFile(
      path.join(tempDir, "src", "helper.ts"),
      "export const add = (a: number, b: number) => a + b;\n",
    );
    await runCmd(["git", "add", "src/helper.ts"], tempDir);
    await runCmd(["git", "commit", "-m", "feat: add helper"], tempDir);

    const mergeBaseRes = await runCmd(["git", "merge-base", "dev", "HEAD"], tempDir);
    assertEquals(mergeBaseRes.code, 0);
    const mergeBase = mergeBaseRes.stdout.trim();

    const historyScanRes = await runCmd([
      "gitleaks",
      "detect",
      `--config=${MASTER_CONFIG}`,
      "--no-banner",
      "--redact=100",
      `--log-opts=${mergeBase}..HEAD`,
    ], tempDir);
    assertEquals(
      historyScanRes.code,
      0,
      `Clean history scan should pass: ${historyScanRes.stderr}`,
    );
    const historyOutput = `${historyScanRes.stdout}\n${historyScanRes.stderr}`;
    assertStringIncludes(historyOutput, "no leaks found");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("scripts/gitleaks.sh executes history range scan on current repository", async () => {
  const res = await runCmd([
    "bash",
    GITLEAKS_SCRIPT,
    "--log-opts=-n 1",
  ]);
  assertEquals(res.code, 0, `scripts/gitleaks.sh failed: ${res.stderr}`);
  const output = `${res.stdout}\n${res.stderr}`;
  assertStringIncludes(output, "no leaks found");
});
