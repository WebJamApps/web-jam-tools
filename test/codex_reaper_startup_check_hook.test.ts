import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { runCodexReaperStartupCheck } from "../hooks/lib/codex_reaper_startup_check.ts";

const REPO_ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const HOOK_SCRIPT_PATH = path.join(REPO_ROOT, "hooks", "codex-reaper-startup-check.sh");

const SAMPLE_CONFIG_WITH_REAPER = `personality = "pragmatic"
model = "gpt-6-luna"
model_reasoning_effort = "high"

[mcp_servers.reaper]
command = "/home/joshua/WebJamApps/web-jam-tools/scripts/reaper-launcher.sh"
args = []

[mcp_servers.reaper.env]
SAMPLE_RATE = "48000"

[projects."/home/joshua/WebJamApps/CollegeLutheran"]
trust_level = "trusted"
`;

const SAMPLE_CONFIG_WITHOUT_REAPER = `personality = "pragmatic"
model = "gpt-6-luna"
model_reasoning_effort = "high"

[projects."/home/joshua/WebJamApps/CollegeLutheran"]
trust_level = "trusted"
`;

Deno.test("codex-reaper-startup-check: removes leftover reaper entry when no active claim exists", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "codex-reaper-test-" });
  try {
    const configPath = path.join(tmpDir, "config.toml");
    const claimPath = path.join(tmpDir, "claim.json");
    await Deno.writeTextFile(configPath, SAMPLE_CONFIG_WITH_REAPER);

    const result = await runCodexReaperStartupCheck({
      configPath,
      claimPath,
    });
    assertEquals(result.removed, true);

    const updated = await Deno.readTextFile(configPath);
    assertFalse(updated.includes("[mcp_servers.reaper]"));
    assertFalse(updated.includes("reaper-launcher.sh"));
    assertFalse(updated.includes("SAMPLE_RATE"));
    assertStringIncludes(updated, 'personality = "pragmatic"');
    assertStringIncludes(updated, '[projects."/home/joshua/WebJamApps/CollegeLutheran"]');
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("codex-reaper-startup-check: preserves reaper entry when an active claim exists", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "codex-reaper-test-" });
  try {
    const configPath = path.join(tmpDir, "config.toml");
    const claimPath = path.join(tmpDir, "claim.json");
    await Deno.writeTextFile(configPath, SAMPLE_CONFIG_WITH_REAPER);
    await Deno.writeTextFile(
      claimPath,
      JSON.stringify({ session: "active-session", surface: "codex" }),
    );

    const result = await runCodexReaperStartupCheck({
      configPath,
      claimPath,
    });
    assertEquals(result.removed, false);
    assertEquals(result.reason, "active claim exists");

    const content = await Deno.readTextFile(configPath);
    assertStringIncludes(content, "[mcp_servers.reaper]");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("codex-reaper-startup-check: leaves config unchanged when no reaper entry exists", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "codex-reaper-test-" });
  try {
    const configPath = path.join(tmpDir, "config.toml");
    const claimPath = path.join(tmpDir, "claim.json");
    await Deno.writeTextFile(configPath, SAMPLE_CONFIG_WITHOUT_REAPER);

    const result = await runCodexReaperStartupCheck({
      configPath,
      claimPath,
    });
    assertEquals(result.removed, false);
    assertEquals(result.reason, "no reaper registration found");

    const content = await Deno.readTextFile(configPath);
    assertEquals(content, SAMPLE_CONFIG_WITHOUT_REAPER);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("codex-reaper-startup-check: shell hook runs end-to-end and removes leftover registration", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "codex-reaper-test-" });
  try {
    const configPath = path.join(tmpDir, "config.toml");
    const claimPath = path.join(tmpDir, "claim.json");
    await Deno.writeTextFile(configPath, SAMPLE_CONFIG_WITH_REAPER);

    const cmd = new Deno.Command(HOOK_SCRIPT_PATH, {
      env: {
        CODEX_CONFIG_PATH: configPath,
        REAPER_CLAIM_FILE: claimPath,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    assertEquals(output.success, true);
    assertEquals(output.code, 0);

    const stdout = new TextDecoder().decode(output.stdout);
    assertStringIncludes(stdout, "Removed leftover REAPER MCP registration");

    const updated = await Deno.readTextFile(configPath);
    assertFalse(updated.includes("[mcp_servers.reaper]"));
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
