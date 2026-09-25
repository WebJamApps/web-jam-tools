import { assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";

const REPO_ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const LAUNCHER_PATH = path.join(REPO_ROOT, "scripts", "reaper-launcher.sh");

Deno.test("reaper-launcher: exits at once when there is no recording claim", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "reaper-launcher-test-" });
  try {
    const claimFile = path.join(tmpDir, "claim.json");
    const lockFile = path.join(tmpDir, "session.lock");
    const mockMcp = path.join(tmpDir, "mock-mcp.sh");
    await Deno.writeTextFile(mockMcp, "#!/usr/bin/env bash\necho MCP_RAN\n");
    await Deno.chmod(mockMcp, 0o755);

    const cmd = new Deno.Command(LAUNCHER_PATH, {
      env: {
        REAPER_CLAIM_FILE: claimFile,
        REAPER_LOCK_FILE: lockFile,
        REAPER_MCP_BIN: mockMcp,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    assertEquals(output.success, false);
    assertEquals(output.code, 1);
    const stderr = new TextDecoder().decode(output.stderr);
    assertStringIncludes(stderr, "No active REAPER recording claim found");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("reaper-launcher: starts server and holds lock when claim exists and lock is free", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "reaper-launcher-test-" });
  try {
    const claimFile = path.join(tmpDir, "claim.json");
    const lockFile = path.join(tmpDir, "session.lock");
    const logFile = path.join(tmpDir, "mcp.log");
    const mockMcp = path.join(tmpDir, "mock-mcp.sh");

    await Deno.writeTextFile(
      claimFile,
      JSON.stringify({ session: "test-session-123", surface: "claude" }),
    );

    // Mock MCP script that records invocation and writes arguments
    await Deno.writeTextFile(
      mockMcp,
      `#!/usr/bin/env bash
echo "MCP_STARTED with args: $@" > "${logFile}"
exit 0
`,
    );
    await Deno.chmod(mockMcp, 0o755);

    const cmd = new Deno.Command(LAUNCHER_PATH, {
      args: ["--arg1", "value1"],
      env: {
        REAPER_CLAIM_FILE: claimFile,
        REAPER_LOCK_FILE: lockFile,
        REAPER_MCP_BIN: mockMcp,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    assertEquals(output.success, true);
    assertEquals(output.code, 0);

    const logContent = await Deno.readTextFile(logFile);
    assertStringIncludes(logContent, "MCP_STARTED with args: --arg1 value1");

    // Lock file should have been written with the session name
    const lockContent = await Deno.readTextFile(lockFile);
    assertStringIncludes(lockContent, "test-session-123");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("reaper-launcher: exits at once when another session already holds the lock", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "reaper-launcher-test-" });
  try {
    const claimFile = path.join(tmpDir, "claim.json");
    const lockFile = path.join(tmpDir, "session.lock");
    const mockMcp = path.join(tmpDir, "mock-mcp.sh");

    await Deno.writeTextFile(
      claimFile,
      JSON.stringify({ session: "new-session-456", surface: "codex" }),
    );

    await Deno.writeTextFile(mockMcp, "#!/usr/bin/env bash\necho FAIL\nexit 1\n");
    await Deno.chmod(mockMcp, 0o755);

    // Spawn a background lock holder process that acquires flock and writes holding session
    const holderScript = path.join(tmpDir, "holder.sh");
    await Deno.writeTextFile(
      holderScript,
      `#!/usr/bin/env bash
touch "${lockFile}"
exec 200<>"${lockFile}"
flock -n 200
printf "holding-session-999\\n" >&200
# Signal ready
echo READY
sleep 2
`,
    );
    await Deno.chmod(holderScript, 0o755);

    const holderCmd = new Deno.Command(holderScript, {
      stdout: "piped",
      stderr: "piped",
    });
    const holderProcess = holderCmd.spawn();

    // Wait until holder signals READY
    const reader = holderProcess.stdout.getReader();
    let readyText = "";
    while (!readyText.includes("READY")) {
      const { value, done } = await reader.read();
      if (done) break;
      readyText += new TextDecoder().decode(value);
    }
    reader.releaseLock();

    try {
      // Now run reaper-launcher.sh
      const cmd = new Deno.Command(LAUNCHER_PATH, {
        env: {
          REAPER_CLAIM_FILE: claimFile,
          REAPER_LOCK_FILE: lockFile,
          REAPER_MCP_BIN: mockMcp,
        },
        stdout: "piped",
        stderr: "piped",
      });
      const output = await cmd.output();
      assertEquals(output.success, false);
      assertEquals(output.code, 1);

      const stderr = new TextDecoder().decode(output.stderr);
      assertStringIncludes(
        stderr,
        "REAPER lock is already held by holding-session-999. Refusing to start a second server.",
      );
    } finally {
      // Clean up holder process
      try {
        holderProcess.kill("SIGTERM");
      } catch {
        // ignore
      }
      await holderProcess.status;
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
