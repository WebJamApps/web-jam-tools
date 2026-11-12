// update_all_script.test.ts — web-jam-tools#1129
//
// Tests for scripts/update-all.sh master update script:
//   - File existence and executable bit
//   - --help and -h flags
//   - --dry-run flag
//   - Rejection of unknown options
//   - Ordered execution of all 5 updates, including checksum-verified GitHub MCP
//   - Fallback resolution of reaper-update script
//   - Failure handling and exit codes
//   - Missing tool detection and strict mode

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

const SCRIPT_PATH = new URL("../scripts/update-all.sh", import.meta.url).pathname;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  installed: string | null;
  installedMode: number;
  downloads: string[];
  staging: string[];
}

const RELEASE_PROGRAM = "#!/bin/sh\n# fixture GitHub MCP release\nexit 0\n";
const ARCHIVE = "github-mcp-server_Linux_x86_64.tar.gz";
const RELEASE_URL = "https://github.com/github/github-mcp-server/releases/download/v99.0.0/";

interface ReleaseFixture {
  downloadFailure?: "metadata" | "archive" | "checksums";
  checksumMismatch?: boolean;
  missingChecksum?: boolean;
  invalidArchive?: boolean;
  existingProgram?: string;
}

async function runUpdateAll(
  args: string[] = [],
  envOverrides: Record<string, string> = {},
  fixture: ReleaseFixture = {},
): Promise<RunResult> {
  const dir = await Deno.makeTempDir({ prefix: "update-all-fixture-" });
  try {
    const bin = join(dir, "bin");
    const home = join(dir, "home");
    const installedDir = join(home, ".local/bin");
    const payload = join(dir, "payload");
    for (const path of [bin, installedDir, payload]) {
      await Deno.mkdir(path, { recursive: true });
    }
    await Deno.writeTextFile(join(payload, "github-mcp-server"), RELEASE_PROGRAM);
    const archive = join(dir, ARCHIVE);
    const packed = await new Deno.Command("tar", {
      args: ["-czf", archive, "-C", payload, "github-mcp-server"],
      clearEnv: true,
      env: { PATH: "/usr/bin:/bin" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(packed.code, 0);
    if (fixture.invalidArchive) await Deno.writeTextFile(archive, "not an archive");
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", await Deno.readFile(archive))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    await Deno.writeTextFile(
      join(dir, "checksums.txt"),
      `${fixture.checksumMismatch ? "0".repeat(64) : hash}  ${
        fixture.missingChecksum ? "different-archive.tar.gz" : ARCHIVE
      }\n`,
    );
    await Deno.writeTextFile(
      join(dir, "release.json"),
      JSON.stringify({
        assets: [ARCHIVE, "github-mcp-server_99.0.0_checksums.txt"].map((name) => ({
          name,
          browser_download_url: `${RELEASE_URL}${name}`,
        })),
      }),
    );
    // Every execution is isolated: curl can only copy fixture files and HOME is temporary.
    await Deno.writeTextFile(
      join(bin, "curl"),
      `#!/bin/bash
destination=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) destination="$2"; shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  https://api.github.com/repos/github/github-mcp-server/releases/latest)
    kind=metadata; source=release.json
    if [ -n "\${UPDATE_ORDER_LOG:-}" ]; then echo '5: github-mcp' >> "$UPDATE_ORDER_LOG"; fi ;;
  ${RELEASE_URL}${ARCHIVE}) kind=archive; source=${ARCHIVE} ;;
  ${RELEASE_URL}github-mcp-server_99.0.0_checksums.txt) kind=checksums; source=checksums.txt ;;
  *) exit 99 ;;
esac
echo "$kind" >> "$FIXTURE_DIR/downloads"
if [ "$kind" = "$FIXTURE_DOWNLOAD_FAILURE" ]; then exit 22; fi
cp "$FIXTURE_DIR/$source" "$destination"
`,
    );
    await Deno.writeTextFile(
      join(bin, "uname"),
      '#!/bin/bash\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n',
    );
    await Deno.chmod(join(bin, "curl"), 0o755);
    await Deno.chmod(join(bin, "uname"), 0o755);
    const installedPath = join(installedDir, "github-mcp-server");
    if (fixture.existingProgram !== undefined) {
      await Deno.writeTextFile(installedPath, fixture.existingProgram);
      await Deno.chmod(installedPath, 0o755);
    }
    const cmd = new Deno.Command("bash", {
      args: [SCRIPT_PATH, ...args],
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: {
        ...envOverrides,
        HOME: home,
        PATH: `${bin}:${envOverrides.PATH ?? "/usr/bin:/bin"}`,
        FIXTURE_DIR: dir,
        FIXTURE_DOWNLOAD_FAILURE: fixture.downloadFailure ?? "",
      },
    });
    const { code, stdout, stderr } = await cmd.output();
    let installed: string | null = null;
    let installedMode = 0;
    let downloads: string[] = [];
    try {
      installed = await Deno.readTextFile(installedPath);
      installedMode = (await Deno.stat(installedPath)).mode ?? 0;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    try {
      downloads = (await Deno.readTextFile(join(dir, "downloads"))).trim().split("\n");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
      installed,
      installedMode,
      downloads,
      staging: [...Deno.readDirSync(installedDir)].filter((entry) =>
        entry.name.startsWith(".github-mcp-update.")
      ).map((entry) => entry.name),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("scripts/update-all.sh exists and is executable", async () => {
  const stat = await Deno.stat(SCRIPT_PATH);
  assert(stat.isFile, "update-all.sh should be a regular file");
  assert(
    ((stat.mode ?? 0) & 0o111) !== 0,
    `update-all.sh should have executable bit set, got mode ${stat.mode?.toString(8)}`,
  );
});

Deno.test("scripts/update-all.sh --help displays usage and returns 0", async () => {
  const result = await runUpdateAll(["--help"]);
  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "Usage: update-all.sh [OPTIONS]");
  assertStringIncludes(result.stdout, "1. claude update");
  assertStringIncludes(result.stdout, "2. agy update");
  assertStringIncludes(result.stdout, "3. codex update");
  assertStringIncludes(result.stdout, "4. reaper-update");
  assertStringIncludes(result.stdout, "Tool Installation Quick Reference (Linux):");
});

Deno.test("scripts/update-all.sh -h displays usage and returns 0", async () => {
  const result = await runUpdateAll(["-h"]);
  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "Usage: update-all.sh [OPTIONS]");
});

Deno.test("scripts/update-all.sh rejects unknown options with code 1", async () => {
  const result = await runUpdateAll(["--nonexistent-flag"]);
  assertEquals(result.code, 1);
  assertStringIncludes(result.stderr, "Unknown option '--nonexistent-flag'");
});

Deno.test("scripts/update-all.sh --dry-run prints planned execution in order without running commands", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const claudeMock = join(tempDir, "claude");
    const agyMock = join(tempDir, "agy");
    const codexMock = join(tempDir, "codex");
    const reaperMock = join(tempDir, "reaper-update");

    await Deno.writeTextFile(claudeMock, "#!/bin/bash\nexit 0\n");
    await Deno.writeTextFile(agyMock, "#!/bin/bash\nexit 0\n");
    await Deno.writeTextFile(codexMock, "#!/bin/bash\nexit 0\n");
    await Deno.writeTextFile(reaperMock, "#!/bin/bash\nexit 0\n");

    await Deno.chmod(claudeMock, 0o755);
    await Deno.chmod(agyMock, 0o755);
    await Deno.chmod(codexMock, 0o755);
    await Deno.chmod(reaperMock, 0o755);

    const result = await runUpdateAll(["--dry-run"], {
      PATH: `${tempDir}:${Deno.env.get("PATH") ?? ""}`,
    });
    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout, "(dry-run) Would execute: claude update");
    assertStringIncludes(result.stdout, "(dry-run) Would execute: agy update");
    assertStringIncludes(result.stdout, "(dry-run) Would execute: codex update");
    assertStringIncludes(result.stdout, "claude update:   DRY-RUN");
    assertStringIncludes(result.stdout, "agy update:      DRY-RUN");
    assertStringIncludes(result.stdout, "codex update:    DRY-RUN");
    assertStringIncludes(result.stdout, "reaper-update:   DRY-RUN");
    assertStringIncludes(result.stdout, "Dry run completed successfully.");
    assertEquals(result.downloads, []);
    assertEquals(result.installed, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("update-all run through its ~/.local/bin symlink falls back to the repo's scripts/reaper-update.sh", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const link = join(tempDir, "update-all");
    await Deno.symlink(SCRIPT_PATH, link);
    for (const tool of ["claude", "agy", "codex"]) {
      await Deno.writeTextFile(join(tempDir, tool), "#!/bin/bash\nexit 0\n");
      await Deno.chmod(join(tempDir, tool), 0o755);
    }

    // No reaper-update on PATH and no REAPER_UPDATE_BIN, so only the fallback can find it.
    const cmd = new Deno.Command(link, {
      args: ["--dry-run"],
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: { PATH: `${tempDir}:/usr/bin:/bin` },
    });
    const { code, stdout } = await cmd.output();
    const out = new TextDecoder().decode(stdout);
    const repoReaper = new URL("../scripts/reaper-update.sh", import.meta.url).pathname;

    assertEquals(code, 0, out);
    assertStringIncludes(out, `(dry-run) Would execute: ${repoReaper}`);
    assertStringIncludes(out, "reaper-update:   DRY-RUN");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("scripts/update-all.sh --dry-run reports skipped status when a tool is not installed", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const claudeMock = join(tempDir, "mock-claude.sh");
    await Deno.writeTextFile(claudeMock, "#!/bin/bash\nexit 0\n");
    await Deno.chmod(claudeMock, 0o755);

    const result = await runUpdateAll(["--dry-run"], {
      CLAUDE_BIN: claudeMock,
      AGY_BIN: join(tempDir, "nonexistent-agy"),
      CODEX_BIN: join(tempDir, "nonexistent-codex"),
      REAPER_UPDATE_BIN: join(tempDir, "nonexistent-reaper"),
    });

    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout, `(dry-run) Would execute: ${claudeMock} update`);
    assertStringIncludes(result.stdout, "claude update:   DRY-RUN");
    assertStringIncludes(result.stdout, "agy update:      SKIPPED (not installed)");
    assertStringIncludes(result.stdout, "codex update:    SKIPPED (not installed)");
    assertStringIncludes(result.stdout, "reaper-update:   SKIPPED (not installed)");
    assertStringIncludes(result.stdout, "Dry run completed successfully.");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("scripts/update-all.sh executes all 5 updates in exact sequence and records success", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const logFile = join(tempDir, "execution.log");

    const claudeMock = join(tempDir, "mock-claude.sh");
    const agyMock = join(tempDir, "mock-agy.sh");
    const codexMock = join(tempDir, "mock-codex.sh");
    const reaperMock = join(tempDir, "mock-reaper.sh");

    await Deno.writeTextFile(
      claudeMock,
      `#!/bin/bash\necho "1: claude $@" >> "${logFile}"\nexit 0\n`,
    );
    await Deno.writeTextFile(
      agyMock,
      `#!/bin/bash\necho "2: agy $@" >> "${logFile}"\nexit 0\n`,
    );
    await Deno.writeTextFile(
      codexMock,
      `#!/bin/bash\necho "3: codex $@" >> "${logFile}"\nexit 0\n`,
    );
    await Deno.writeTextFile(
      reaperMock,
      `#!/bin/bash\necho "4: reaper" >> "${logFile}"\nexit 0\n`,
    );

    await Deno.chmod(claudeMock, 0o755);
    await Deno.chmod(agyMock, 0o755);
    await Deno.chmod(codexMock, 0o755);
    await Deno.chmod(reaperMock, 0o755);

    const result = await runUpdateAll([], {
      CLAUDE_BIN: claudeMock,
      AGY_BIN: agyMock,
      CODEX_BIN: codexMock,
      REAPER_UPDATE_BIN: reaperMock,
      UPDATE_ORDER_LOG: logFile,
    });

    assertEquals(result.code, 0, `Expected 0 exit, stderr: ${result.stderr}`);
    assertStringIncludes(result.stdout, "claude update:   SUCCESS");
    assertStringIncludes(result.stdout, "agy update:      SUCCESS");
    assertStringIncludes(result.stdout, "codex update:    SUCCESS");
    assertStringIncludes(result.stdout, "reaper-update:   SUCCESS");
    assertStringIncludes(
      result.stdout,
      "All available developer tool updates completed successfully (5 succeeded).",
    );

    const logContent = await Deno.readTextFile(logFile);
    const lines = logContent.trim().split("\n");
    assertEquals(lines, [
      "1: claude update",
      "2: agy update",
      "3: codex update",
      "4: reaper",
      "5: github-mcp",
    ]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("scripts/update-all.sh handles command failure gracefully and exits with code 1", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const logFile = join(tempDir, "execution.log");

    const claudeMock = join(tempDir, "mock-claude.sh");
    const agyMock = join(tempDir, "mock-agy.sh");
    const codexMock = join(tempDir, "mock-codex.sh");
    const reaperMock = join(tempDir, "mock-reaper.sh");

    // agy fails with exit code 2
    await Deno.writeTextFile(
      claudeMock,
      `#!/bin/bash\necho "claude" >> "${logFile}"\nexit 0\n`,
    );
    await Deno.writeTextFile(
      agyMock,
      `#!/bin/bash\necho "agy" >> "${logFile}"\nexit 2\n`,
    );
    await Deno.writeTextFile(
      codexMock,
      `#!/bin/bash\necho "codex" >> "${logFile}"\nexit 0\n`,
    );
    await Deno.writeTextFile(
      reaperMock,
      `#!/bin/bash\necho "reaper" >> "${logFile}"\nexit 0\n`,
    );

    await Deno.chmod(claudeMock, 0o755);
    await Deno.chmod(agyMock, 0o755);
    await Deno.chmod(codexMock, 0o755);
    await Deno.chmod(reaperMock, 0o755);

    const result = await runUpdateAll([], {
      CLAUDE_BIN: claudeMock,
      AGY_BIN: agyMock,
      CODEX_BIN: codexMock,
      REAPER_UPDATE_BIN: reaperMock,
    });

    assertEquals(result.code, 1);
    assertStringIncludes(result.stdout, "claude update:   SUCCESS");
    assertStringIncludes(result.stdout, "agy update:      FAILED");
    assertStringIncludes(result.stdout, "codex update:    SUCCESS");
    assertStringIncludes(result.stdout, "reaper-update:   SUCCESS");
    assertStringIncludes(result.stderr, "Antigravity update failed with exit code 2");
    assertStringIncludes(result.stderr, "Update completed with 1 failure(s).");

    // Confirms subsequent tools still ran despite step 2 failure
    const logContent = await Deno.readTextFile(logFile);
    assertEquals(logContent.trim().split("\n"), ["claude", "agy", "codex", "reaper"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("scripts/update-all.sh reports skipped status when a tool is not installed", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const claudeMock = join(tempDir, "mock-claude.sh");
    await Deno.writeTextFile(claudeMock, `#!/bin/bash\nexit 0\n`);
    await Deno.chmod(claudeMock, 0o755);

    const result = await runUpdateAll([], {
      CLAUDE_BIN: claudeMock,
      AGY_BIN: join(tempDir, "nonexistent-agy"),
      CODEX_BIN: join(tempDir, "nonexistent-codex"),
      REAPER_UPDATE_BIN: join(tempDir, "nonexistent-reaper"),
    });

    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout, "claude update:   SUCCESS");
    assertStringIncludes(result.stdout, "agy update:      SKIPPED (not installed)");
    assertStringIncludes(result.stdout, "codex update:    SKIPPED (not installed)");
    assertStringIncludes(result.stdout, "reaper-update:   SKIPPED (not installed)");
    assertStringIncludes(result.stderr, "Antigravity CLI not found");
    assertStringIncludes(result.stderr, "OpenAI Codex CLI not found");
    assertStringIncludes(result.stderr, "REAPER updater not found");
    assertStringIncludes(
      result.stdout,
      "All available developer tool updates completed successfully (2 succeeded).",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("scripts/update-all.sh --strict fails if any tool is missing", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const claudeMock = join(tempDir, "mock-claude.sh");
    await Deno.writeTextFile(claudeMock, `#!/bin/bash\nexit 0\n`);
    await Deno.chmod(claudeMock, 0o755);

    const result = await runUpdateAll(["--strict"], {
      CLAUDE_BIN: claudeMock,
      AGY_BIN: join(tempDir, "nonexistent-agy"),
      CODEX_BIN: join(tempDir, "nonexistent-codex"),
      REAPER_UPDATE_BIN: join(tempDir, "nonexistent-reaper"),
    });

    assertEquals(result.code, 1);
    assertStringIncludes(
      result.stderr,
      "Strict mode failed: 3 tool(s) missing or not installed.",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("scripts/update-all.sh installs GitHub MCP even when the four other tools are missing", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const result = await runUpdateAll([], {
      CLAUDE_BIN: join(tempDir, "nonexistent-claude"),
      AGY_BIN: join(tempDir, "nonexistent-agy"),
      CODEX_BIN: join(tempDir, "nonexistent-codex"),
      REAPER_UPDATE_BIN: join(tempDir, "nonexistent-reaper"),
    });

    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.installed, RELEASE_PROGRAM);
    assertStringIncludes(result.stdout, "github-mcp:      SUCCESS");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

const OTHER_UPDATERS = {
  CLAUDE_BIN: "/bin/true",
  AGY_BIN: "/bin/true",
  CODEX_BIN: "/bin/true",
  REAPER_UPDATE_BIN: "/bin/true",
};

for (const existingProgram of [undefined, "installed older release\n"]) {
  Deno.test(`GitHub MCP matching checksum ${existingProgram ? "replaces" : "installs"} the program`, async () => {
    const result = await runUpdateAll([], OTHER_UPDATERS, { existingProgram });
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.installed, RELEASE_PROGRAM);
    assertEquals(result.installedMode & 0o777, 0o755);
    assertEquals(result.downloads, ["metadata", "archive", "checksums"]);
    assertEquals(result.staging, []);
    assertStringIncludes(result.stdout, "github-mcp:      SUCCESS");
  });
}

const FAILED_RELEASES: Array<[string, ReleaseFixture]> = [
  ["checksum mismatch", { checksumMismatch: true }],
  ["missing matching checksum", { missingChecksum: true }],
  ["failed metadata download", { downloadFailure: "metadata" }],
  ["failed archive download", { downloadFailure: "archive" }],
  ["failed checksums download", { downloadFailure: "checksums" }],
  ["invalid archive", { invalidArchive: true }],
];
for (const [name, fixture] of FAILED_RELEASES) {
  Deno.test(`GitHub MCP ${name} preserves the installed program and update-all continues`, async () => {
    const previous = "#!/bin/sh\n# installed release must survive\nexit 0\n";
    const result = await runUpdateAll([], OTHER_UPDATERS, {
      ...fixture,
      existingProgram: previous,
    });
    assertEquals(result.code, 1);
    assertEquals(result.installed, previous);
    assertEquals(result.installedMode & 0o777, 0o755);
    assertEquals(result.staging, []);
    assertStringIncludes(result.stdout, "github-mcp:      FAILED");
    assertStringIncludes(result.stdout, "==================== Summary");
    assertStringIncludes(result.stdout, "reaper-update:   SUCCESS");
    assertStringIncludes(result.stderr, "keeping the installed program (if any). Continuing.");
  });
}
