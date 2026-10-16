// test/gitleaks_repo_option.test.ts — web-jam-tools#1403
// Tests for scripts/gitleaks.sh --repo option, tightened rules, fingerprint alignment,
// tool selection precedence, and fail-closed exit codes.

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";

const ROOT_DIR = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const GITLEAKS_SCRIPT = path.join(ROOT_DIR, "scripts", "gitleaks.sh");

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

Deno.test("file test/fixture.ts containing AIza + 35 characters produces a finding, rule google-api-key (exit 2)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gitleaks-test-aiza-" });
  try {
    await runCmd(["git", "init", "-q"], tempDir);
    await Deno.mkdir(path.join(tempDir, "test"), { recursive: true });

    // Built at runtime so no literal sits in test source
    const fakeKey = ["AIza", "x".repeat(35)].join("");
    await Deno.writeTextFile(
      path.join(tempDir, "test", "fixture.ts"),
      `export const key = "${fakeKey}";\n`,
    );

    const res = await runCmd(["bash", GITLEAKS_SCRIPT, "--repo", tempDir]);
    assertEquals(res.code, 2, `Expected exit 2 for credential finding, got ${res.code}`);

    const combined = `${res.stdout}\n${res.stderr}`;
    assertStringIncludes(combined, "google-api-key");
    assertStringIncludes(combined, "test/fixture.ts");
    assert(!combined.includes(fakeKey), "Secret literal was leaked in scan output");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("a line with webjam-fixture-ok marker produces a finding (the marker exempts nothing)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gitleaks-test-fixture-ok-" });
  try {
    await runCmd(["git", "init", "-q"], tempDir);

    const fakeKey = ["AIza", "y".repeat(35)].join("");
    await Deno.writeTextFile(
      path.join(tempDir, "sample.ts"),
      `const k = "${fakeKey}"; // webjam-fixture-ok\n`,
    );

    const res = await runCmd(["bash", GITLEAKS_SCRIPT, "--repo", tempDir]);
    assertEquals(res.code, 2, `Expected exit 2, got ${res.code}`);

    const combined = `${res.stdout}\n${res.stderr}`;
    assertStringIncludes(combined, "google-api-key");
    assert(!combined.includes(fakeKey), "Secret literal was leaked in scan output");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("a line with gitleaks:allow comment produces a finding (gitleaks' own marker exempts nothing)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gitleaks-test-gitleaks-allow-" });
  try {
    await runCmd(["git", "init", "-q"], tempDir);

    const fakeKey = ["AIza", "z".repeat(35)].join("");
    await Deno.writeTextFile(
      path.join(tempDir, "sample.ts"),
      `const k = "${fakeKey}"; // gitleaks:allow\n`,
    );

    const res = await runCmd(["bash", GITLEAKS_SCRIPT, "--repo", tempDir]);
    assertEquals(res.code, 2, `Expected exit 2, got ${res.code}`);

    const combined = `${res.stdout}\n${res.stderr}`;
    assertStringIncludes(combined, "google-api-key");
    assert(!combined.includes(fakeKey), "Secret literal was leaked in scan output");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("mongodb://localhost:27017/test without userinfo produces no finding (exit 0)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gitleaks-test-mongo-clean-" });
  try {
    await runCmd(["git", "init", "-q"], tempDir);
    await Deno.writeTextFile(
      path.join(tempDir, "db.ts"),
      'const uri = "mongodb://localhost:27017/test";\n',
    );

    const res = await runCmd(["bash", GITLEAKS_SCRIPT, "--repo", tempDir]);
    assertEquals(res.code, 0, `Expected exit 0 for no finding, got ${res.code}`);

    const combined = `${res.stdout}\n${res.stderr}`;
    assertStringIncludes(combined, "no leaks found");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("mongodb+srv with credentials produces a finding, rule mongodb-connection-string (exit 2)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gitleaks-test-mongo-cred-" });
  try {
    await runCmd(["git", "init", "-q"], tempDir);

    // Built at runtime so no literal sits in test source
    const fakeMongoUri = ["mongodb+srv://", "user:pass", "@cluster0.example.net/db"].join("");
    await Deno.writeTextFile(
      path.join(tempDir, "db.ts"),
      `const uri = "${fakeMongoUri}";\n`,
    );

    const res = await runCmd(["bash", GITLEAKS_SCRIPT, "--repo", tempDir]);
    assertEquals(res.code, 2, `Expected exit 2 for credential finding, got ${res.code}`);

    const combined = `${res.stdout}\n${res.stderr}`;
    assertStringIncludes(combined, "mongodb-connection-string");
    assert(!combined.includes("user:pass"), "Secret literal was leaked in scan output");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("--repo scans named repository and .gitleaksignore suppresses finding by fingerprint", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gitleaks-test-repo-ignore-" });
  try {
    await runCmd(["git", "init", "-q"], tempDir);

    const fakeKey = ["AIza", "a".repeat(35)].join("");
    await Deno.writeTextFile(
      path.join(tempDir, "fixture.ts"),
      `const k = "${fakeKey}";\n`,
    );

    // Initial scan detects leak on line 1
    const resBefore = await runCmd(["bash", GITLEAKS_SCRIPT, "--repo", tempDir]);
    assertEquals(resBefore.code, 2);

    // Fingerprint on line 1: fixture.ts:google-api-key:1
    await Deno.writeTextFile(
      path.join(tempDir, ".gitleaksignore"),
      "fixture.ts:google-api-key:1\n",
    );

    const resAfter = await runCmd(["bash", GITLEAKS_SCRIPT, "--repo", tempDir]);
    assertEquals(resAfter.code, 0, `Expected exit 0 after .gitleaksignore, got ${resAfter.code}`);

    const combined = `${resAfter.stdout}\n${resAfter.stderr}`;
    assertStringIncludes(combined, "no leaks found");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("fingerprint reads fixture.ts:google-api-key:1 through both Docker and host gitleaks program", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gitleaks-test-fingerprint-" });
  try {
    await runCmd(["git", "init", "-q"], tempDir);

    const fakeKey = ["AIza", "b".repeat(35)].join("");
    await Deno.writeTextFile(
      path.join(tempDir, "fixture.ts"),
      `const k = "${fakeKey}";\n`,
    );

    // 1. Through Docker (when Docker is available)
    const resDocker = await runCmd(["bash", GITLEAKS_SCRIPT, "--repo", tempDir]);
    assertEquals(resDocker.code, 2);
    const dockerOutput = `${resDocker.stdout}\n${resDocker.stderr}`;
    assertStringIncludes(dockerOutput, "Fingerprint: fixture.ts:google-api-key:1");

    // 2. Through installed gitleaks program directly
    const configPath = path.join(ROOT_DIR, ".gitleaks.toml");
    const resHost = await runCmd([
      "gitleaks",
      "detect",
      `--config=${configPath}`,
      "--source",
      ".",
      "--no-git",
      "--no-banner",
      "--redact=100",
      "--exit-code=2",
      "--ignore-gitleaks-allow",
      "-v",
    ], tempDir);
    assertEquals(resHost.code, 2);
    const hostOutput = `${resHost.stdout}\n${resHost.stderr}`;
    assertStringIncludes(hostOutput, "Fingerprint: fixture.ts:google-api-key:1");

    // 3. In both, .gitleaksignore line suppresses the finding
    await Deno.writeTextFile(
      path.join(tempDir, ".gitleaksignore"),
      "fixture.ts:google-api-key:1\n",
    );

    const resDockerIgnored = await runCmd(["bash", GITLEAKS_SCRIPT, "--repo", tempDir]);
    assertEquals(resDockerIgnored.code, 0);

    const resHostIgnored = await runCmd([
      "gitleaks",
      "detect",
      `--config=${configPath}`,
      "--source",
      ".",
      "--no-git",
      "--no-banner",
      "--redact=100",
      "--exit-code=2",
      "--ignore-gitleaks-allow",
      "-v",
    ], tempDir);
    assertEquals(resHostIgnored.code, 0);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("tool selection precedence: Docker available, fallback to PATH binary, fail closed when neither available", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gitleaks-test-tool-order-" });
  const mockBinDir = await Deno.makeTempDir({ prefix: "mock-bin-" });

  try {
    await runCmd(["git", "init", "-q"], tempDir);
    await Deno.writeTextFile(path.join(tempDir, "clean.txt"), "clean text\n");

    // Test Case: Docker absent (shadow docker command to simulate daemon unavailable), gitleaks on PATH
    // Create a mock docker command that exits 1 on docker info
    const mockDocker = path.join(mockBinDir, "docker");
    await Deno.writeTextFile(
      mockDocker,
      "#!/usr/bin/env bash\nexit 1\n",
    );
    await runCmd(["chmod", "+x", mockDocker]);

    // Locate system gitleaks
    const whichGitleaks = await runCmd(["which", "gitleaks"]);
    const gitleaksPath = whichGitleaks.stdout.trim();
    if (gitleaksPath) {
      // Symlink gitleaks into mockBinDir so it is on PATH
      await runCmd(["ln", "-s", gitleaksPath, path.join(mockBinDir, "gitleaks")]);

      const resFallback = await runCmd(
        ["bash", GITLEAKS_SCRIPT, "--repo", tempDir],
        undefined,
        { PATH: `${mockBinDir}:/usr/bin:/bin` },
      );
      assertEquals(
        resFallback.code,
        0,
        `Fallback should succeed, got ${resFallback.code}: ${resFallback.stderr}`,
      );
      const fallbackOut = `${resFallback.stdout}\n${resFallback.stderr}`;
      assertStringIncludes(fallbackOut, "no leaks found");
    }

    // Test Case: Neither Docker nor gitleaks available -> fail closed with error naming Docker
    const emptyBinDir = await Deno.makeTempDir({ prefix: "empty-bin-" });
    try {
      const mockFailingDocker = path.join(emptyBinDir, "docker");
      await Deno.writeTextFile(mockFailingDocker, "#!/usr/bin/env bash\nexit 1\n");
      await runCmd(["chmod", "+x", mockFailingDocker]);

      const resNeither = await runCmd(
        ["bash", GITLEAKS_SCRIPT, "--repo", tempDir],
        undefined,
        { PATH: `${emptyBinDir}:/bin:/usr/bin` },
      );
      assertNotEquals(resNeither.code, 0, "Should refuse when neither is available");
      assertNotEquals(resNeither.code, 2, "Exit code must not be 2 when tool is missing");
      assertStringIncludes(resNeither.stderr, "Docker");
    } finally {
      await Deno.remove(emptyBinDir, { recursive: true }).catch(() => {});
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    await Deno.remove(mockBinDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("exit codes: no finding 0, finding 2, error non-zero and not 2", async () => {
  // Non-existent target repo directory
  const nonExistent = path.join(ROOT_DIR, "non-existent-directory-12345");
  const resError = await runCmd(["bash", GITLEAKS_SCRIPT, "--repo", nonExistent]);
  assertNotEquals(resError.code, 0);
  assertNotEquals(resError.code, 2);
  assertStringIncludes(resError.stderr, "target repository directory does not exist");
});
