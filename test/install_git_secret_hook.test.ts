// install_git_secret_hook.test.ts — web-jam-tools#658
// Tests for scripts/install-git-secret-hook.sh, .gitleaks.toml, and pre-push secret guard.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";

const ROOT_DIR = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const SCRIPT_PATH = path.join(ROOT_DIR, "scripts", "install-git-secret-hook.sh");
const MASTER_CONFIG = path.join(ROOT_DIR, ".gitleaks.toml");

async function runCmd(cmd: string[], cwd?: string, stdinText?: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: cwd ?? ROOT_DIR,
    stdin: stdinText ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  });

  const process = command.spawn();
  if (stdinText) {
    const writer = process.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdinText));
    await writer.close();
  }

  const output = await process.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

Deno.test("master .gitleaks.toml exists and has valid structure", async () => {
  const content = await Deno.readTextFile(MASTER_CONFIG);
  assertStringIncludes(content, "WebJamApps Gitleaks Configuration");
  assertStringIncludes(content, "google-api-key");
  assertStringIncludes(content, "github-pat");
  assertStringIncludes(content, "webjam-fixture-ok");
});

Deno.test("install-git-secret-hook.sh installs hook into Node repo (.husky/pre-push)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "node-repo-" });
  try {
    await runCmd(["git", "init"], tempDir);
    await Deno.writeTextFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "mock-node-repo" }),
    );

    const res = await runCmd(["bash", SCRIPT_PATH, "--repo", tempDir]);
    assertEquals(res.code, 0, `Script failed: ${res.stderr}`);
    assertStringIncludes(res.stdout, "Installed pre-push secret guard at");
    assertStringIncludes(res.stdout, "(node)");

    const hookPath = path.join(tempDir, ".husky", "pre-push");
    const hookExists = await Deno.stat(hookPath).then(() => true).catch(() => false);
    assert(hookExists, ".husky/pre-push was not created");

    const configPath = path.join(tempDir, ".gitleaks.toml");
    const configExists = await Deno.stat(configPath).then(() => true).catch(() => false);
    assert(configExists, ".gitleaks.toml was not created");

    // Test --check mode
    const checkRes = await runCmd(["bash", SCRIPT_PATH, "--repo", tempDir, "--check"]);
    assertEquals(checkRes.code, 0, `Check failed: ${checkRes.stderr}`);
    assertStringIncludes(checkRes.stdout, "OK: git-secret-hook is installed and in sync");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("install-git-secret-hook.sh installs hook into Deno repo (.git/hooks/pre-push)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "deno-repo-" });
  try {
    await runCmd(["git", "init"], tempDir);
    await Deno.writeTextFile(
      path.join(tempDir, "deno.json"),
      JSON.stringify({ name: "mock-deno-repo" }),
    );

    const res = await runCmd(["bash", SCRIPT_PATH, "--repo", tempDir]);
    assertEquals(res.code, 0, `Script failed: ${res.stderr}`);
    assertStringIncludes(res.stdout, "Installed pre-push secret guard at");
    assertStringIncludes(res.stdout, "(deno)");

    const hookPath = path.join(tempDir, ".git", "hooks", "pre-push");
    const hookExists = await Deno.stat(hookPath).then(() => true).catch(() => false);
    assert(hookExists, ".git/hooks/pre-push was not created");

    const configPath = path.join(tempDir, ".gitleaks.toml");
    const configExists = await Deno.stat(configPath).then(() => true).catch(() => false);
    assert(configExists, ".gitleaks.toml was not created");

    // Test --check mode
    const checkRes = await runCmd(["bash", SCRIPT_PATH, "--repo", tempDir, "--check"]);
    assertEquals(checkRes.code, 0, `Check failed: ${checkRes.stderr}`);
    assertStringIncludes(checkRes.stdout, "OK: git-secret-hook is installed and in sync");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("install-git-secret-hook.sh is idempotent", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "idempotent-test-" });
  try {
    await runCmd(["git", "init"], tempDir);
    await Deno.writeTextFile(
      path.join(tempDir, "deno.json"),
      JSON.stringify({ name: "mock-deno-repo" }),
    );

    const run1 = await runCmd(["bash", SCRIPT_PATH, "--repo", tempDir]);
    assertEquals(run1.code, 0);

    const hookContent1 = await Deno.readTextFile(path.join(tempDir, ".git", "hooks", "pre-push"));

    const run2 = await runCmd(["bash", SCRIPT_PATH, "--repo", tempDir]);
    assertEquals(run2.code, 0);
    assertStringIncludes(run2.stdout, ".gitleaks.toml already in sync");

    const hookContent2 = await Deno.readTextFile(path.join(tempDir, ".git", "hooks", "pre-push"));
    assertEquals(hookContent1, hookContent2);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("install-git-secret-hook.sh --check reports drift when files are missing or modified", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "drift-test-" });
  try {
    await runCmd(["git", "init"], tempDir);
    await Deno.writeTextFile(
      path.join(tempDir, "deno.json"),
      JSON.stringify({ name: "mock-deno-repo" }),
    );

    // Before install: check should fail
    const preCheck = await runCmd(["bash", SCRIPT_PATH, "--repo", tempDir, "--check"]);
    assertEquals(preCheck.code, 1);
    assertStringIncludes(preCheck.stderr, "DRIFT");

    // Install
    await runCmd(["bash", SCRIPT_PATH, "--repo", tempDir]);

    // Modify .gitleaks.toml to cause drift
    await Deno.writeTextFile(path.join(tempDir, ".gitleaks.toml"), "# modified config\n");
    const driftCheck = await runCmd(["bash", SCRIPT_PATH, "--repo", tempDir, "--check"]);
    assertEquals(driftCheck.code, 1);
    assertStringIncludes(driftCheck.stderr, "differs from master");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("pre-push hook blocks push containing credential literal and does not leak secret value", async () => {
  const remoteDir = await Deno.makeTempDir({ prefix: "git-remote-" });
  const localDir = await Deno.makeTempDir({ prefix: "git-local-" });

  try {
    // 1. Set up bare remote
    await runCmd(["git", "init", "--bare", remoteDir]);

    // 2. Clone to local
    await runCmd(["git", "clone", remoteDir, localDir]);
    await runCmd(["git", "config", "user.email", "tester@webjam.com"], localDir);
    await runCmd(["git", "config", "user.name", "Tester"], localDir);

    // Initial clean commit + push
    await Deno.writeTextFile(path.join(localDir, "README.md"), "# Probe Repo\n");
    await runCmd(["git", "add", "README.md"], localDir);
    await runCmd(["git", "commit", "-m", "initial commit"], localDir);
    await runCmd(["git", "push", "origin", "HEAD:main"], localDir);

    // 3. Install secret hook
    const installRes = await runCmd(["bash", SCRIPT_PATH, "--repo", localDir]);
    assertEquals(installRes.code, 0);

    // 4. Test clean push succeeds
    await Deno.writeTextFile(path.join(localDir, "src.ts"), "export const a = 1;\n");
    await runCmd(["git", "add", "src.ts"], localDir);
    await runCmd(["git", "commit", "-m", "clean change"], localDir);
    const cleanPush = await runCmd(["git", "push", "origin", "HEAD:main"], localDir);
    assertEquals(cleanPush.code, 0, `Clean push failed: ${cleanPush.stderr}`);

    // 5. Test secret commit push is refused
    const secretSuffix = "DUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMM"; // 33 chars after Sy
    const fakeKey = `AIzaSy${secretSuffix}`; // 39 chars total Google API key shape
    await Deno.writeTextFile(path.join(localDir, "leak.ts"), `const key = "${fakeKey}";\n`);
    await runCmd(["git", "add", "leak.ts"], localDir);
    await runCmd(["git", "commit", "-m", "probe secret commit"], localDir);

    const leakPush = await runCmd(["git", "push", "origin", "HEAD:main"], localDir);
    assertEquals(leakPush.code, 1, "Push with secret should have been refused");
    assertStringIncludes(leakPush.stderr, "PUSH REFUSED");
    assertStringIncludes(leakPush.stderr, "google-api-key");
    assertStringIncludes(leakPush.stderr, "leak.ts");

    // Reporting discipline: The refusal message must NEVER echo the secret literal
    assert(!leakPush.stderr.includes(fakeKey), "Secret literal was leaked in stderr output");
    assert(!leakPush.stdout.includes(fakeKey), "Secret literal was leaked in stdout output");

    // 6. Test fixture with pragma succeeds
    await runCmd(["git", "rm", "leak.ts"], localDir);
    await Deno.writeTextFile(
      path.join(localDir, "fixture.ts"),
      `const key = "${fakeKey}"; // webjam-fixture-ok\n`,
    );
    await runCmd(["git", "add", "fixture.ts"], localDir);
    await runCmd(["git", "commit", "--amend", "-m", "probe with pragma"], localDir);

    const pragmaPush = await runCmd(["git", "push", "origin", "HEAD:main"], localDir);
    assertEquals(pragmaPush.code, 0, `Push with pragma should succeed: ${pragmaPush.stderr}`);
  } finally {
    await Deno.remove(remoteDir, { recursive: true }).catch(() => {});
    await Deno.remove(localDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("pre-push hook blocks push in Node repo with husky and catches GitHub token", async () => {
  const remoteDir = await Deno.makeTempDir({ prefix: "node-remote-" });
  const localDir = await Deno.makeTempDir({ prefix: "node-local-" });

  try {
    await runCmd(["git", "init", "--bare", remoteDir]);
    await runCmd(["git", "clone", remoteDir, localDir]);
    await runCmd(["git", "config", "user.email", "tester@webjam.com"], localDir);
    await runCmd(["git", "config", "user.name", "Tester"], localDir);
    await Deno.writeTextFile(
      path.join(localDir, "package.json"),
      JSON.stringify({ name: "test-node-pkg" }),
    );

    await runCmd(["git", "add", "package.json"], localDir);
    await runCmd(["git", "commit", "-m", "init package"], localDir);
    await runCmd(["git", "push", "origin", "HEAD:main"], localDir);

    // Install hook into Node repo
    const installRes = await runCmd(["bash", SCRIPT_PATH, "--repo", localDir]);
    assertEquals(installRes.code, 0);

    // Git config to ensure husky hook is called if core.hooksPath is used, or directly invoke hook
    const fakeToken = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`; // 40 chars GitHub PAT
    await Deno.writeTextFile(
      path.join(localDir, "auth.ts"),
      `export const token = "${fakeToken}";\n`,
    );
    await runCmd(["git", "add", "auth.ts"], localDir);
    await runCmd(["git", "commit", "-m", "add auth token"], localDir);

    // Run husky pre-push hook directly with git pre-push stdin format
    const localOid = (await runCmd(["git", "rev-parse", "HEAD"], localDir)).stdout.trim();
    const remoteOid = (await runCmd(["git", "rev-parse", "origin/main"], localDir)).stdout.trim();
    const hookPath = path.join(localDir, ".husky", "pre-push");
    const hookRes = await runCmd(
      ["bash", hookPath],
      localDir,
      `refs/heads/main ${localOid} refs/heads/main ${remoteOid}\n`,
    );
    assertEquals(hookRes.code, 1, "Husky hook should fail on unpushed secret");
    assertStringIncludes(hookRes.stderr, "PUSH REFUSED");
    assertStringIncludes(hookRes.stderr, "github-pat");
    assert(!hookRes.stderr.includes(fakeToken), "GitHub token was leaked");
  } finally {
    await Deno.remove(remoteDir, { recursive: true }).catch(() => {});
    await Deno.remove(localDir, { recursive: true }).catch(() => {});
  }
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
