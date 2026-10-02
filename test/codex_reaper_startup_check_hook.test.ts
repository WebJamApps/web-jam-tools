import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import {
  removeReaperRegistration,
  runCodexReaperStartupCheck,
} from "../hooks/lib/codex_reaper_startup_check.ts";

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
      surface: "codex",
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
      surface: "codex",
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
      surface: "codex",
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
        WJT_SURFACE: "codex",
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

Deno.test("codex-reaper-startup-check: preserves unrelated bytes and removes attached REAPER comments", () => {
  const before = 'model = "gpt-6-luna"\r\n\r\n\r\n\r\n';
  const after =
    '\r\n\r\n\r\n# Other server\r\n[mcp_servers.reaper_tools] # unrelated\r\ncommand = "other"\r\n\r\n\r\n';
  const reaper =
    '# REAPER server\r\n# Remove this comment too\r\n [mcp_servers."reaper"] # local bridge\r\ncommand = "reaper"\r\n';
  const input = before + reaper + after;
  assertEquals(removeReaperRegistration(input), before + after);
});

Deno.test("codex-reaper-startup-check: removes only REAPER tables including quoted children", () => {
  const input = `[mcp_servers.'reaper']
command = "reaper"
[mcp_servers.'reaper'.env]
RATE = "48000"
# Keep the next section's comment
[[hooks.SessionStart]]
matcher = "startup"
`;
  assertEquals(
    removeReaperRegistration(input),
    '# Keep the next section\'s comment\n[[hooks.SessionStart]]\nmatcher = "startup"\n',
  );
});

Deno.test("codex-reaper-startup-check: header-looking strings are never removed", () => {
  const input = `# A comment mentioning """ is not a string
developer_instructions = """
[mcp_servers.reaper]
Use the example above, including # comments.
"""
literal = '''
[mcp_servers.reaper]
'''
[mcp_servers.other]
command = "other"
`;
  assertEquals(removeReaperRegistration(input), input);
  const reaper = '[mcp_servers.reaper]\ncommand = "reaper"\n';
  assertEquals(removeReaperRegistration(input + reaper), input);
});

Deno.test("codex-reaper-startup-check: other surfaces and missing surface leave config unchanged", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "codex-reaper-surface-test-" });
  try {
    const configPath = path.join(tmpDir, "config.toml");
    const claimPath = path.join(tmpDir, "claim.json");
    await Deno.writeTextFile(configPath, SAMPLE_CONFIG_WITH_REAPER);
    for (const surface of ["", "claude", "agy"]) {
      assertEquals(
        await runCodexReaperStartupCheck({ configPath, claimPath, surface }),
        { removed: false, reason: "not a Codex session" },
      );
      const output = await new Deno.Command(HOOK_SCRIPT_PATH, {
        env: { WJT_SURFACE: surface, CODEX_CONFIG_PATH: configPath, REAPER_CLAIM_FILE: claimPath },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(output.code, 0);
      assertEquals(output.stdout.length, 0);
      assertEquals(await Deno.readTextFile(configPath), SAMPLE_CONFIG_WITH_REAPER);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
