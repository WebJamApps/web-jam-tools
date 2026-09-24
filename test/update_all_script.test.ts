// update_all_script.test.ts — web-jam-tools#1129
//
// Tests for scripts/update-all.sh master update script:
//   - File existence and executable bit
//   - --help and -h flags
//   - --dry-run flag
//   - Rejection of unknown options
//   - Ordered execution of all 4 updates (claude, agy, codex, reaper-update)
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
}

async function runUpdateAll(
  args: string[] = [],
  envOverrides: Record<string, string> = {},
): Promise<RunResult> {
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    ...envOverrides,
  };
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH, ...args],
    stdout: "piped",
    stderr: "piped",
    env,
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
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
  const result = await runUpdateAll(["--dry-run"]);
  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "(dry-run) Would execute: claude update");
  assertStringIncludes(result.stdout, "(dry-run) Would execute: agy update");
  assertStringIncludes(result.stdout, "(dry-run) Would execute: codex update");
  assertStringIncludes(result.stdout, "claude update:   DRY-RUN");
  assertStringIncludes(result.stdout, "agy update:      DRY-RUN");
  assertStringIncludes(result.stdout, "codex update:    DRY-RUN");
  assertStringIncludes(result.stdout, "reaper-update:   DRY-RUN");
  assertStringIncludes(result.stdout, "Dry run completed successfully.");
});

Deno.test("scripts/update-all.sh executes all 4 updates in exact sequence and records success", async () => {
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
      `#!/bin/bash\necho "4: reaper $@" >> "${logFile}"\nexit 0\n`,
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

    assertEquals(result.code, 0, `Expected 0 exit, stderr: ${result.stderr}`);
    assertStringIncludes(result.stdout, "claude update:   SUCCESS");
    assertStringIncludes(result.stdout, "agy update:      SUCCESS");
    assertStringIncludes(result.stdout, "codex update:    SUCCESS");
    assertStringIncludes(result.stdout, "reaper-update:   SUCCESS");
    assertStringIncludes(
      result.stdout,
      "All available developer tool updates completed successfully (4 succeeded).",
    );

    const logContent = await Deno.readTextFile(logFile);
    const lines = logContent.trim().split("\n");
    assertEquals(lines, [
      "1: claude update",
      "2: agy update",
      "3: codex update",
      "4: reaper",
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
      "All available developer tool updates completed successfully (1 succeeded).",
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

Deno.test("scripts/update-all.sh fails with code 1 if all tools are missing", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const result = await runUpdateAll([], {
      CLAUDE_BIN: join(tempDir, "nonexistent-claude"),
      AGY_BIN: join(tempDir, "nonexistent-agy"),
      CODEX_BIN: join(tempDir, "nonexistent-codex"),
      REAPER_UPDATE_BIN: join(tempDir, "nonexistent-reaper"),
    });

    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "No developer tools were found to update.");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
