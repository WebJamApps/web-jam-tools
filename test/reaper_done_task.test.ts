import { assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";

const REPO_ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const DONE_SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "reaper-done.ts");

Deno.test("reaper:done: on Codex surface clears claim and calls codex mcp remove reaper", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "reaper-done-test-" });
  try {
    const claimFile = path.join(tmpDir, "claim.json");
    const codexLog = path.join(tmpDir, "codex.log");
    await Deno.writeTextFile(
      claimFile,
      JSON.stringify({ session: "test-session", surface: "codex" }),
    );

    const mockCodex = path.join(tmpDir, "mock-codex.sh");
    await Deno.writeTextFile(
      mockCodex,
      `#!/usr/bin/env bash
echo "CODEX_MCP: $@" >> "${codexLog}"
exit 0
`,
    );
    await Deno.chmod(mockCodex, 0o755);

    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", DONE_SCRIPT_PATH],
      env: {
        REAPER_CLAIM_FILE: claimFile,
        CODEX_MCP_CMD: `${mockCodex} mcp remove reaper`,
        WJT_SURFACE: "codex",
      },
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    assertEquals(output.success, true);
    assertEquals(output.code, 0);

    // Claim file should be removed
    let claimExists = false;
    try {
      await Deno.stat(claimFile);
      claimExists = true;
    } catch {
      claimExists = false;
    }
    assertEquals(claimExists, false);

    // Mock codex should have been invoked with mcp remove reaper
    const logContent = await Deno.readTextFile(codexLog);
    assertStringIncludes(logContent, "CODEX_MCP: mcp remove reaper");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("reaper:done: on agy surface clears claim and calls agy mcp disable reaper", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "reaper-done-test-" });
  try {
    const claimFile = path.join(tmpDir, "claim.json");
    const agyLog = path.join(tmpDir, "agy.log");
    await Deno.writeTextFile(
      claimFile,
      JSON.stringify({ session: "test-session", surface: "agy" }),
    );

    const mockAgy = path.join(tmpDir, "mock-agy.sh");
    await Deno.writeTextFile(
      mockAgy,
      `#!/usr/bin/env bash
echo "AGY_MCP: $@" >> "${agyLog}"
exit 0
`,
    );
    await Deno.chmod(mockAgy, 0o755);

    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", DONE_SCRIPT_PATH],
      env: {
        REAPER_CLAIM_FILE: claimFile,
        AGY_MCP_CMD: `${mockAgy} mcp disable reaper`,
        WJT_SURFACE: "agy",
      },
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    assertEquals(output.success, true);
    assertEquals(output.code, 0);

    let claimExists = false;
    try {
      await Deno.stat(claimFile);
      claimExists = true;
    } catch {
      claimExists = false;
    }
    assertEquals(claimExists, false);

    const logContent = await Deno.readTextFile(agyLog);
    assertStringIncludes(logContent, "AGY_MCP: mcp disable reaper");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("reaper:done: on Claude Code surface clears claim and runs no command", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "reaper-done-test-" });
  try {
    const claimFile = path.join(tmpDir, "claim.json");
    await Deno.writeTextFile(
      claimFile,
      JSON.stringify({ session: "test-session", surface: "claude" }),
    );

    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", DONE_SCRIPT_PATH],
      env: {
        REAPER_CLAIM_FILE: claimFile,
        WJT_SURFACE: "claude",
      },
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    assertEquals(output.success, true);
    assertEquals(output.code, 0);

    let claimExists = false;
    try {
      await Deno.stat(claimFile);
      claimExists = true;
    } catch {
      claimExists = false;
    }
    assertEquals(claimExists, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("reaper:done: exits 0 as no-op when no claim exists", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "reaper-done-test-" });
  try {
    const nonexistentClaim = path.join(tmpDir, "no-claim.json");

    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", DONE_SCRIPT_PATH],
      env: {
        REAPER_CLAIM_FILE: nonexistentClaim,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    assertEquals(output.success, true);
    assertEquals(output.code, 0);

    const stdout = new TextDecoder().decode(output.stdout);
    assertStringIncludes(stdout, "No active REAPER recording claim found. Nothing to do.");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
