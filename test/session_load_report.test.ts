// test/session_load_report.test.ts
// Unit tests for session load report generator and script (web-jam-tools#1234).

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  computeSessionLoadReport,
  generateSessionLoadReport,
  inspectClaudeConnectors,
  inspectCodexConnectors,
  loadLimits,
} from "../src/session-load/report.ts";
import { lintRunbookFile } from "../src/design-issue/lint_runbook.ts";

const REPO_ROOT = new URL("../", import.meta.url).pathname;
const LIMITS_PATH = join(REPO_ROOT, "src/session-load/limits.json");

// Helper to create a temp fixture workspace
async function setupFixtureWorkspace() {
  const tempDir = await Deno.makeTempDir({ prefix: "session-load-test-" });
  const homeDir = join(tempDir, "home");
  const webJamAppsDir = join(homeDir, "WebJamApps");

  await Deno.mkdir(homeDir, { recursive: true });
  await Deno.mkdir(webJamAppsDir, { recursive: true });
  await Deno.mkdir(join(homeDir, ".claude"), { recursive: true });
  await Deno.mkdir(join(homeDir, ".claude/projects/-home-joshua/memory"), {
    recursive: true,
  });
  await Deno.mkdir(join(homeDir, ".claude/skills"), { recursive: true });
  await Deno.mkdir(join(homeDir, ".gemini/config/plugins/webjam-tasks/skills"), {
    recursive: true,
  });
  await Deno.mkdir(join(homeDir, ".codex/skills"), { recursive: true });

  await Deno.mkdir(join(webJamAppsDir, "web-jam-tools/docs"), {
    recursive: true,
  });
  await Deno.mkdir(join(webJamAppsDir, "JaMmusic"), { recursive: true });

  return { tempDir, homeDir, webJamAppsDir };
}

Deno.test("limits live strictly in src/session-load/limits.json and are not restated in code or tests", async () => {
  const limits = await loadLimits(LIMITS_PATH);

  // Collect the unique numerical limits
  const numbersToCheck = [
    limits.memoryIndex.lowMark,
    limits.memoryIndex.overMark,
    limits.globalClaudeMd.lowMark,
    limits.globalClaudeMd.overMark,
    limits.mainRules.lowMark,
    limits.mainRules.overMark,
    limits.crossAiRules.lowMark,
    limits.crossAiRules.overMark,
    limits.jammusicRules.lowMark,
    limits.jammusicRules.overMark,
    limits.otherRepoRules.overMark,
  ];

  const filesToCheck = [
    join(REPO_ROOT, "src/session-load/report.ts"),
    join(REPO_ROOT, "scripts/session-load-report.ts"),
    new URL(import.meta.url).pathname,
  ];

  for (const file of filesToCheck) {
    const text = await Deno.readTextFile(file);
    for (const num of numbersToCheck) {
      // Regex matching the number as a numeric token (excluding numbers in comments or regex)
      const regex = new RegExp(`\\b${num}\\b`);
      assert(
        !regex.test(text),
        `File ${file} restates limit number ${num}; limits must live only in limits.json`,
      );
    }
  }
});

Deno.test("SessionStart hook exists in scripts/claude-settings.json and nowhere else", async () => {
  const claudeSettingsText = await Deno.readTextFile(
    join(REPO_ROOT, "scripts/claude-settings.json"),
  );
  const claudeSettings = JSON.parse(claudeSettingsText);

  assert(
    claudeSettings?.hooks?.SessionStart,
    "scripts/claude-settings.json must define hooks.SessionStart",
  );
  const commands = claudeSettings.hooks.SessionStart.flatMap(
    (entry: { hooks?: Array<{ command?: string }> }) =>
      entry.hooks?.map((h) => h.command || "") || [],
  );
  assert(
    commands.some((c: string) => c.includes("scripts/session-load-report.ts")),
    "SessionStart in scripts/claude-settings.json must execute session-load-report.ts",
  );

  // Must not be registered in ~/.claude/settings.json
  const homeSettingsPath = join(
    Deno.env.get("HOME") || "/home/joshua",
    ".claude/settings.json",
  );
  let homeSettingsText: string | null = null;
  try {
    homeSettingsText = await Deno.readTextFile(homeSettingsPath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }
  if (homeSettingsText !== null) {
    assert(
      !homeSettingsText.includes("session-load-report"),
      "~/.claude/settings.json must NOT contain session-load-report",
    );
  }

  // Must not be in install-hooks.sh
  const installHooksText = await Deno.readTextFile(
    join(REPO_ROOT, "scripts/install-hooks.sh"),
  );
  assert(
    !installHooksText.includes("session-load-report"),
    "scripts/install-hooks.sh must NOT register session-load-report",
  );

  // Must not be in agy hooks.json
  const agyHooksPath = join(
    Deno.env.get("HOME") || "/home/joshua",
    ".gemini/config/hooks.json",
  );
  let agyHooksText: string | null = null;
  try {
    agyHooksText = await Deno.readTextFile(agyHooksPath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }
  if (agyHooksText !== null) {
    assert(
      !agyHooksText.includes("session-load-report"),
      "agy hooks.json must NOT register session-load-report",
    );
  }

  // scripts/agents.sh passes scripts/claude-settings.json to tab 1
  const agentsSh = await Deno.readTextFile(
    join(REPO_ROOT, "scripts/agents.sh"),
  );
  assert(
    agentsSh.includes('CLAUDE_SETTINGS="$REPO_DIR/scripts/claude-settings.json"'),
    "scripts/agents.sh must define CLAUDE_SETTINGS pointing to scripts/claude-settings.json",
  );
});

Deno.test("All parts under low mark produce one-line ok format across Claude Code, agy, and Codex", async () => {
  const limits = await loadLimits(LIMITS_PATH);
  const { tempDir, homeDir, webJamAppsDir } = await setupFixtureWorkspace();

  try {
    // Configure Claude settings with all bundled skills names-only
    const skillOverrides: Record<string, string> = {};
    for (const skill of limits.bundledSkills.skills ?? []) {
      skillOverrides[skill] = "name-only";
    }
    await Deno.writeTextFile(
      join(homeDir, ".claude/settings.json"),
      JSON.stringify({ skillOverrides }),
    );

    // Create parts strictly UNDER low mark
    const lowDelta = 100;
    await Deno.writeTextFile(
      join(homeDir, ".claude/CLAUDE.md"),
      "x".repeat(limits.globalClaudeMd.lowMark! - lowDelta),
    );
    await Deno.writeTextFile(
      join(homeDir, ".claude/projects/-home-joshua/memory/MEMORY.md"),
      "x".repeat(limits.memoryIndex.lowMark! - lowDelta),
    );
    await Deno.writeTextFile(
      join(webJamAppsDir, "web-jam-tools/AGENTS.md"),
      "x".repeat(limits.mainRules.lowMark! - lowDelta),
    );
    await Deno.writeTextFile(
      join(webJamAppsDir, "web-jam-tools/docs/cross-ai-rules.md"),
      "x".repeat(limits.crossAiRules.lowMark! - lowDelta),
    );
    await Deno.writeTextFile(
      join(webJamAppsDir, "JaMmusic/AGENTS.md"),
      "x".repeat(limits.jammusicRules.lowMark! - lowDelta),
    );

    // Create a compliant skill description in each tool
    const compliantSkillContent =
      `---\nname: test-skill\ndescription: A short description under the limit.\n---\nBody`;

    for (
      const dir of [
        join(homeDir, ".claude/skills/test-skill"),
        join(homeDir, ".gemini/config/plugins/webjam-tasks/skills/test-skill"),
        join(homeDir, ".codex/skills/test-skill"),
      ]
    ) {
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(join(dir, "SKILL.md"), compliantSkillContent);
    }

    const report = await generateSessionLoadReport({
      homeDir,
      webJamAppsDir,
      limitsPath: LIMITS_PATH,
    });

    assertEquals(report, "Session load: Claude Code ok · agy ok · Codex ok");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Parts inside cushion (between lowMark and overMark) do not trigger OVER", async () => {
  const limits = await loadLimits(LIMITS_PATH);
  const { tempDir, homeDir, webJamAppsDir } = await setupFixtureWorkspace();

  try {
    const skillOverrides: Record<string, string> = {};
    for (const skill of limits.bundledSkills.skills ?? []) {
      skillOverrides[skill] = "name-only";
    }
    await Deno.writeTextFile(
      join(homeDir, ".claude/settings.json"),
      JSON.stringify({ skillOverrides }),
    );

    // Set files in the middle of cushion: (lowMark + overMark) / 2
    const midCushion = (low: number, over: number) => Math.floor((low + over) / 2);

    await Deno.writeTextFile(
      join(homeDir, ".claude/CLAUDE.md"),
      "x".repeat(
        midCushion(
          limits.globalClaudeMd.lowMark!,
          limits.globalClaudeMd.overMark,
        ),
      ),
    );
    await Deno.writeTextFile(
      join(homeDir, ".claude/projects/-home-joshua/memory/MEMORY.md"),
      "x".repeat(
        midCushion(limits.memoryIndex.lowMark!, limits.memoryIndex.overMark),
      ),
    );
    await Deno.writeTextFile(
      join(webJamAppsDir, "web-jam-tools/AGENTS.md"),
      "x".repeat(
        midCushion(limits.mainRules.lowMark!, limits.mainRules.overMark),
      ),
    );
    await Deno.writeTextFile(
      join(webJamAppsDir, "web-jam-tools/docs/cross-ai-rules.md"),
      "x".repeat(
        midCushion(limits.crossAiRules.lowMark!, limits.crossAiRules.overMark),
      ),
    );
    await Deno.writeTextFile(
      join(webJamAppsDir, "JaMmusic/AGENTS.md"),
      "x".repeat(
        midCushion(limits.jammusicRules.lowMark!, limits.jammusicRules.overMark),
      ),
    );

    const report = await generateSessionLoadReport({
      homeDir,
      webJamAppsDir,
      limitsPath: LIMITS_PATH,
    });

    assertEquals(report, "Session load: Claude Code ok · agy ok · Codex ok");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Parts over mark trigger per-tool OVER with exact excess format across Claude Code, agy, and Codex", async () => {
  const limits = await loadLimits(LIMITS_PATH);
  const { tempDir, homeDir, webJamAppsDir } = await setupFixtureWorkspace();

  try {
    // Claude Code settings without skillOverrides (all 30 bundled skills over)
    await Deno.writeTextFile(
      join(homeDir, ".claude/settings.json"),
      JSON.stringify({}),
    );

    // Excess values relative to overMark
    const mainRulesExcess = 21846;
    const crossAiRulesExcess = 21824;
    const jammusicRulesExcess = 5418;

    await Deno.writeTextFile(
      join(webJamAppsDir, "web-jam-tools/AGENTS.md"),
      "x".repeat(limits.mainRules.overMark + mainRulesExcess),
    );
    await Deno.writeTextFile(
      join(webJamAppsDir, "web-jam-tools/docs/cross-ai-rules.md"),
      "x".repeat(limits.crossAiRules.overMark + crossAiRulesExcess),
    );
    await Deno.writeTextFile(
      join(webJamAppsDir, "JaMmusic/AGENTS.md"),
      "x".repeat(limits.jammusicRules.overMark + jammusicRulesExcess),
    );

    // Global CLAUDE.md and memory index inside cushion (not over)
    await Deno.writeTextFile(
      join(homeDir, ".claude/CLAUDE.md"),
      "x".repeat(limits.globalClaudeMd.lowMark!),
    );
    await Deno.writeTextFile(
      join(homeDir, ".claude/projects/-home-joshua/memory/MEMORY.md"),
      "x".repeat(limits.memoryIndex.lowMark!),
    );

    // Install 12 over-limit skills in Claude Code and agy
    const overSkillDescription = "a".repeat(
      limits.skillDescription.overMark + 50,
    );
    const overSkillContent = `---\nname: skill\ndescription: ${overSkillDescription}\n---\nBody`;

    for (let i = 0; i < 12; i++) {
      const claudeSkillDir = join(homeDir, `.claude/skills/skill-${i}`);
      const agySkillDir = join(
        homeDir,
        `.gemini/config/plugins/webjam-tasks/skills/skill-${i}`,
      );
      await Deno.mkdir(claudeSkillDir, { recursive: true });
      await Deno.mkdir(agySkillDir, { recursive: true });
      await Deno.writeTextFile(
        join(claudeSkillDir, "SKILL.md"),
        overSkillContent,
      );
      await Deno.writeTextFile(join(agySkillDir, "SKILL.md"), overSkillContent);
    }
    // Codex has NO skills installed in ~/.codex/skills (directory is empty)

    const report = await generateSessionLoadReport({
      homeDir,
      webJamAppsDir,
      limitsPath: LIMITS_PATH,
    });

    const expected = [
      "Session load",
      "Claude Code  OVER  main rules +21,846 · cross-AI rules +21,824 · JaMmusic rules +5,418 · 12 skill descriptions · 30 bundled skills",
      "agy          OVER  main rules +21,846 · cross-AI rules +21,824 · JaMmusic rules +5,418 · 12 skill descriptions",
      "Codex        OVER  main rules +21,846 · cross-AI rules +21,824 · JaMmusic rules +5,418 · no skills installed",
      "Run /memory-cleanup to cut.",
    ].join("\n");

    assertEquals(report, expected);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Single tool OVER displays other tools as ok in multiline report", async () => {
  const limits = await loadLimits(LIMITS_PATH);
  const { tempDir, homeDir, webJamAppsDir } = await setupFixtureWorkspace();

  try {
    // Bundled skills all ok
    const skillOverrides: Record<string, string> = {};
    for (const skill of limits.bundledSkills.skills ?? []) {
      skillOverrides[skill] = "name-only";
    }
    await Deno.writeTextFile(
      join(homeDir, ".claude/settings.json"),
      JSON.stringify({ skillOverrides }),
    );

    // Only global CLAUDE.md is over (Claude Code specific)
    const excess = 500;
    await Deno.writeTextFile(
      join(homeDir, ".claude/CLAUDE.md"),
      "x".repeat(limits.globalClaudeMd.overMark + excess),
    );

    const result = await computeSessionLoadReport({
      homeDir,
      webJamAppsDir,
      limitsPath: LIMITS_PATH,
    });

    assert(result.isOver);
    assert(result.tools.claudeCode.isOver);
    assert(!result.tools.agy.isOver);
    assert(!result.tools.codex.isOver);

    const expected = [
      "Session load",
      `Claude Code  OVER  global CLAUDE.md +${excess}`,
      "agy          ok",
      "Codex        ok",
      "Run /memory-cleanup to cut.",
    ].join("\n");

    assertEquals(result.text, expected);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("report accurately detects memoryIndex, other repo rules, and codex skill descriptions over mark", async () => {
  const limits = await loadLimits(LIMITS_PATH);
  const { tempDir, homeDir, webJamAppsDir } = await setupFixtureWorkspace();

  try {
    // 1. Fallback projects memory directory (not -home-joshua)
    const customProjectMemoryDir = join(
      homeDir,
      ".claude/projects/custom-project/memory",
    );
    await Deno.mkdir(customProjectMemoryDir, { recursive: true });
    const memDelta = 250;
    await Deno.writeTextFile(
      join(customProjectMemoryDir, "MEMORY.md"),
      "x".repeat(limits.memoryIndex.overMark + memDelta),
    );

    // 2. Other repo over mark (e.g. AppersonAuto)
    const otherRepoDelta = 500;
    await Deno.mkdir(join(webJamAppsDir, "AppersonAuto"), { recursive: true });
    await Deno.writeTextFile(
      join(webJamAppsDir, "AppersonAuto/AGENTS.md"),
      "x".repeat(limits.otherRepoRules.overMark + otherRepoDelta),
    );

    // 3. Codex skill with description over mark, plus fallback frontmatter parsing
    const codexOverSkillDir = join(homeDir, ".codex/skills/over-skill");
    await Deno.mkdir(codexOverSkillDir, { recursive: true });
    const longDesc = "y".repeat(limits.skillDescription.overMark + 50);
    await Deno.writeTextFile(
      join(codexOverSkillDir, "SKILL.md"),
      `---\nname: @invalid:yaml:syntax\ndescription: ${longDesc}\n---\nBody`,
    );

    // Also a skill with no frontmatter at all to exercise no-match
    const noFrontmatterSkillDir = join(homeDir, ".codex/skills/no-fm-skill");
    await Deno.mkdir(noFrontmatterSkillDir, { recursive: true });
    await Deno.writeTextFile(
      join(noFrontmatterSkillDir, "SKILL.md"),
      "No frontmatter at all here",
    );

    const result = await computeSessionLoadReport({
      homeDir,
      webJamAppsDir,
      limitsPath: LIMITS_PATH,
    });

    assert(result.isOver);
    assert(result.tools.claudeCode.isOver);
    assert(result.tools.agy.isOver);
    assert(result.tools.codex.isOver);
    assert(result.tools.claudeCode.items.some((i) => i.includes("memory index")));
    assert(result.tools.claudeCode.items.some((i) => i.includes("AppersonAuto rules")));
    assert(result.tools.agy.items.some((i) => i.includes("AppersonAuto rules")));
    assert(result.tools.codex.items.some((i) => i.includes("AppersonAuto rules")));
    assert(result.tools.codex.items.some((i) => i.includes("skill descriptions")));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("scripts/session-load-report.ts prints valid JSON systemMessage and exits 0", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-env",
      join(REPO_ROOT, "scripts/session-load-report.ts"),
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const start = performance.now();
  const output = await cmd.output();
  const duration = performance.now() - start;

  assertEquals(output.code, 0, "session-load-report.ts must exit 0");
  assert(duration < 1000, `Execution took ${duration}ms; expected < 1000ms`);

  const stdout = new TextDecoder().decode(output.stdout).trim();
  const parsed = JSON.parse(stdout);
  assert(
    typeof parsed.systemMessage === "string",
    "stdout must be JSON with a systemMessage string",
  );
  assert(
    parsed.systemMessage.startsWith("Session load"),
    "systemMessage must start with 'Session load'",
  );
});

Deno.test("Manual verification runbook conforms to format requirements", async () => {
  const runbookPath = join(
    Deno.env.get("HOME") || "/home/joshua",
    "Dropbox/web-jam-llms/Token_Savings/standing-preamble-manual-steps-2026-10-03.md",
  );

  try {
    const stat = await Deno.stat(runbookPath);
    if (!stat.isFile) return;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // In CI or environments without Dropbox mounted, skip checking the external runbook
      return;
    }
    throw err;
  }

  const result = await lintRunbookFile(runbookPath);
  assertEquals(
    result.valid,
    true,
    `Runbook has violations: ${JSON.stringify(result.violations)}`,
  );
});

Deno.test("bundled skill overrides: unrelated overrides do not suppress warning, and 1 returning to full size reports exact excess", async () => {
  const limits = await loadLimits(LIMITS_PATH);
  const { tempDir, homeDir, webJamAppsDir } = await setupFixtureWorkspace();

  try {
    // 1. Settings containing 50 unrelated name-only overrides
    const unrelatedOverrides: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      unrelatedOverrides[`unrelated_custom_skill_${i}`] = "name-only";
    }
    await Deno.writeTextFile(
      join(homeDir, ".claude/settings.json"),
      JSON.stringify({ skillOverrides: unrelatedOverrides }),
    );

    let result = await computeSessionLoadReport({
      homeDir,
      webJamAppsDir,
      limitsPath: LIMITS_PATH,
    });

    assert(result.isOver);
    assert(result.tools.claudeCode.isOver);
    assert(
      result.tools.claudeCode.items.some((item) => item.includes("30 bundled skills")),
      `Expected '30 bundled skills' but got: ${result.tools.claudeCode.items.join(" · ")}`,
    );

    // 2. Settings where 29 bundled skills are name-only and 1 returns to full size ("on")
    const almostAllOverrides: Record<string, string> = {};
    const bundledSkills = limits.bundledSkills.skills ?? [];
    for (let i = 0; i < bundledSkills.length - 1; i++) {
      almostAllOverrides[bundledSkills[i]] = "name-only";
    }
    const returnedSkill = bundledSkills[bundledSkills.length - 1];
    almostAllOverrides[returnedSkill] = "on";

    await Deno.writeTextFile(
      join(homeDir, ".claude/settings.json"),
      JSON.stringify({ skillOverrides: almostAllOverrides }),
    );

    result = await computeSessionLoadReport({
      homeDir,
      webJamAppsDir,
      limitsPath: LIMITS_PATH,
    });

    assert(result.isOver);
    assert(result.tools.claudeCode.isOver);
    assert(
      result.tools.claudeCode.items.some((item) => item.includes("1 bundled skill")),
      `Expected '1 bundled skill' but got: ${result.tools.claudeCode.items.join(" · ")}`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("forbidden registration in global Claude settings or agy hooks fails assertion outside try-catch", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const forbiddenSettingsPath = join(tempDir, "settings.json");
    await Deno.writeTextFile(
      forbiddenSettingsPath,
      JSON.stringify({ hooks: { SessionStart: [{ command: "scripts/session-load-report.ts" }] } }),
    );

    let homeSettingsText: string | null = null;
    try {
      homeSettingsText = await Deno.readTextFile(forbiddenSettingsPath);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        throw err;
      }
    }

    let assertionFailed = false;
    try {
      assert(
        !homeSettingsText!.includes("session-load-report"),
        "settings.json must NOT contain session-load-report",
      );
    } catch {
      assertionFailed = true;
    }

    assert(
      assertionFailed,
      "Assertion must fail when forbidden settings file contains session-load-report",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("report-only connectors and agy Google-bundled skills are measured, exposed in result, and rendered when over without imposing limits", async () => {
  const limits = await loadLimits(LIMITS_PATH);
  const { tempDir, homeDir, webJamAppsDir } = await setupFixtureWorkspace();

  try {
    // 1. Configure all bundled skills as name-only
    const skillOverrides: Record<string, string> = {};
    for (const skill of limits.bundledSkills.skills ?? []) {
      skillOverrides[skill] = "name-only";
    }
    await Deno.writeTextFile(
      join(homeDir, ".claude/settings.json"),
      JSON.stringify({ skillOverrides }),
    );

    // 2. Add Claude MCP servers in ~/.claude.json
    const claudeMcpPath = join(homeDir, ".claude.json");
    const mcpServers = {
      "google-drive": {
        command: "node",
        args: ["/path/to/server.js"],
        env: { TOKEN: "secret-token" },
        instructions: "Google Drive storage operations.",
        tools: ["read_file", "search_files"],
      },
      "reaper": {
        command: "reaper-mcp",
        args: [],
        env: {},
        instructions: "Control Reaper DAW playback.",
      },
    };
    await Deno.writeTextFile(
      claudeMcpPath,
      JSON.stringify({ mcpServers }),
    );
    const claudeMcpExpectedBytes = null;

    // 3. Add agy MCP connectors under ~/.gemini/antigravity-cli/mcp
    const agyMcpDir = join(homeDir, ".gemini/antigravity-cli/mcp");
    await Deno.mkdir(join(agyMcpDir, "github"), { recursive: true });
    await Deno.mkdir(join(agyMcpDir, "playwright"), { recursive: true });
    await Deno.writeTextFile(
      join(agyMcpDir, "github/schema.json"),
      "{}".repeat(100),
    );
    await Deno.writeTextFile(
      join(agyMcpDir, "playwright/instructions.md"),
      "x".repeat(300),
    );
    const agyMcpExpectedBytes = 200 + 300;

    // 4. Add nonempty Codex MCP connectors under ~/.codex/mcp
    const codexMcpDir = join(homeDir, ".codex/mcp");
    await Deno.mkdir(join(codexMcpDir, "github"), { recursive: true });
    await Deno.writeTextFile(
      join(codexMcpDir, "github/instructions.md"),
      "x".repeat(350),
    );
    await Deno.mkdir(join(codexMcpDir, "memory"), { recursive: true });
    await Deno.writeTextFile(
      join(codexMcpDir, "memory/schema.json"),
      "y".repeat(150),
    );
    const codexMcpExpectedBytes = 350 + 150;

    // 5. Add agy Google-bundled skills in ~/.gemini/skills
    const agyGoogleSkillsDir = join(homeDir, ".gemini/skills");
    for (let i = 0; i < 5; i++) {
      await Deno.mkdir(join(agyGoogleSkillsDir, `g-skill-${i}`), {
        recursive: true,
      });
    }

    // 6. Test clean state: all parts strictly under low mark
    const lowDelta = 100;
    await Deno.writeTextFile(
      join(homeDir, ".claude/CLAUDE.md"),
      "x".repeat(limits.globalClaudeMd.lowMark! - lowDelta),
    );
    await Deno.writeTextFile(
      join(homeDir, ".claude/projects/-home-joshua/memory/MEMORY.md"),
      "x".repeat(limits.memoryIndex.lowMark! - lowDelta),
    );
    await Deno.writeTextFile(
      join(webJamAppsDir, "web-jam-tools/AGENTS.md"),
      "x".repeat(limits.mainRules.lowMark! - lowDelta),
    );
    await Deno.writeTextFile(
      join(webJamAppsDir, "web-jam-tools/docs/cross-ai-rules.md"),
      "x".repeat(limits.crossAiRules.lowMark! - lowDelta),
    );
    await Deno.writeTextFile(
      join(webJamAppsDir, "JaMmusic/AGENTS.md"),
      "x".repeat(limits.jammusicRules.lowMark! - lowDelta),
    );

    const compliantSkillContent =
      `---\nname: test-skill\ndescription: A short description.\n---\nBody`;
    for (
      const dir of [
        join(homeDir, ".claude/skills/test-skill"),
        join(homeDir, ".gemini/config/plugins/webjam-tasks/skills/test-skill"),
        join(homeDir, ".codex/skills/test-skill"),
      ]
    ) {
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(join(dir, "SKILL.md"), compliantSkillContent);
    }

    const cleanResult = await computeSessionLoadReport({
      homeDir,
      webJamAppsDir,
      limitsPath: LIMITS_PATH,
      claudeMcpPath,
      agyMcpDir,
      codexMcpDir,
      agyGoogleSkillsDir,
    });

    // Having connectors and Google-bundled skills MUST NOT trigger OVER
    assertEquals(cleanResult.isOver, false);
    assertEquals(
      cleanResult.text,
      "Session load: Claude Code ok · agy ok · Codex ok",
    );
    assertEquals(cleanResult.connectors.claudeCode.count, 2);
    assertEquals(
      cleanResult.connectors.claudeCode.sizeBytes,
      claudeMcpExpectedBytes,
    );
    assertEquals(cleanResult.connectors.agy.count, 2);
    assertEquals(cleanResult.connectors.agy.sizeBytes, agyMcpExpectedBytes);
    assertEquals(cleanResult.connectors.codex.count, 2);
    assertEquals(cleanResult.connectors.codex.sizeBytes, codexMcpExpectedBytes);
    assertEquals(cleanResult.googleBundledSkills.agy, 5);

    // 7. Test OVER state: make main rules over mark
    const mainRulesExcess = 1000;
    await Deno.writeTextFile(
      join(webJamAppsDir, "web-jam-tools/AGENTS.md"),
      "x".repeat(limits.mainRules.overMark + mainRulesExcess),
    );

    const overResult = await computeSessionLoadReport({
      homeDir,
      webJamAppsDir,
      limitsPath: LIMITS_PATH,
      claudeMcpPath,
      agyMcpDir,
      codexMcpDir,
      agyGoogleSkillsDir,
    });

    assertEquals(overResult.isOver, true);
    assert(
      overResult.tools.claudeCode.items.some((i) => i.includes("connectors listing unavailable")),
      `Claude Code should report the unavailable connector measurement when over: ${
        overResult.tools.claudeCode.items.join(" · ")
      }`,
    );
    assert(
      overResult.tools.agy.items.some((i) => i.includes("5 Google-bundled skills")),
      `agy should report Google-bundled skills when over: ${
        overResult.tools.agy.items.join(" · ")
      }`,
    );
    assert(
      overResult.tools.agy.items.some((i) => i.includes(`connectors ${agyMcpExpectedBytes}`)),
      `agy should report connector bytes when over: ${overResult.tools.agy.items.join(" · ")}`,
    );
    assert(
      overResult.tools.codex.items.some((i) => i.includes(`connectors ${codexMcpExpectedBytes}`)),
      `Codex should report connector bytes when over: ${overResult.tools.codex.items.join(" · ")}`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Claude Code connectors: collects project-scoped servers under projects[homeDir].mcpServers when root mcpServers is empty", async () => {
  const { tempDir, homeDir, webJamAppsDir } = await setupFixtureWorkspace();
  try {
    const claudeMcpPath = join(homeDir, ".claude.json");
    const projectServerConfig = {
      command: "node",
      args: ["/tmp/scoped.js"],
      env: { SCOPED_ENV: "123" },
      instructions: "Scoped project server instructions.",
      tools: ["scoped_tool"],
    };
    await Deno.writeTextFile(
      claudeMcpPath,
      JSON.stringify({
        projects: {
          [homeDir]: {
            mcpServers: {
              "project-only-server": projectServerConfig,
            },
          },
        },
      }),
    );

    const expectedBytes = null;

    const result = await computeSessionLoadReport({
      homeDir,
      webJamAppsDir,
      limitsPath: LIMITS_PATH,
      claudeMcpPath,
    });

    assertEquals(result.connectors.claudeCode.count, 1);
    assertEquals(result.connectors.claudeCode.sizeBytes, expectedBytes);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Claude Code connectors: safely counts a server named __proto__", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const claudeMcpPath = join(tempDir, ".claude.json");
    const serverConfig = {
      instructions: "Prototype-key server instructions.",
      tools: ["safe_tool"],
    };
    await Deno.writeTextFile(
      claudeMcpPath,
      `{"mcpServers":{"__proto__":${JSON.stringify(serverConfig)}}}`,
    );

    const result = await inspectClaudeConnectors(claudeMcpPath);

    assertEquals(result.count, 1);
    assertEquals(
      result.sizeBytes,
      null,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Claude Code connectors: launcher fields never pretend to be discovered listing content", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const claudeMcpPath = join(tempDir, ".claude.json");

    // 1. Synthetic listing fields in launcher config cannot provide a measurement
    const baseServer = {
      command: "node",
      args: ["app.js"],
      env: { FOO: "bar" },
      instructions: "Core server operations.",
      tools: ["read_data", "write_data"],
    };
    await Deno.writeTextFile(
      claudeMcpPath,
      JSON.stringify({ mcpServers: { "test-server": baseServer } }),
    );

    const baseResult = await inspectClaudeConnectors(claudeMcpPath, [tempDir]);
    assertEquals(baseResult.count, 1);
    const expectedBaseBytes = null;
    assertEquals(baseResult.sizeBytes, expectedBaseBytes);

    // 2. Massively inflate launcher config (command path, 200 args, 15KB env)
    const inflatedLauncherServer = {
      command: "/opt/custom/environments/deeply/nested/runtime/bin/python3.12",
      args: Array(200).fill("--verbose-extended-flag-parameter-long-switch"),
      env: {
        VERY_LONG_AUTH_TOKEN: "a".repeat(8000),
        ADDITIONAL_METADATA_VARIABLE: "b".repeat(7000),
      },
      instructions: "Core server operations.",
      tools: ["read_data", "write_data"],
    };
    await Deno.writeTextFile(
      claudeMcpPath,
      JSON.stringify({ mcpServers: { "test-server": inflatedLauncherServer } }),
    );

    const inflatedResult = await inspectClaudeConnectors(claudeMcpPath, [
      tempDir,
    ]);
    assertEquals(inflatedResult.count, 1);
    // A missing listing remains unavailable despite launcher inflation
    assertEquals(inflatedResult.sizeBytes, baseResult.sizeBytes);

    // 3. Even synthetic listing fields in configuration are not discovered content
    const addedInstruction = " Also supports batch exports.";
    const addedTool = "export_data";
    const mutatedListingServer = {
      ...inflatedLauncherServer,
      instructions: baseServer.instructions + addedInstruction,
      tools: [...baseServer.tools, addedTool],
    };
    await Deno.writeTextFile(
      claudeMcpPath,
      JSON.stringify({ mcpServers: { "test-server": mutatedListingServer } }),
    );

    const mutatedResult = await inspectClaudeConnectors(claudeMcpPath, [
      tempDir,
    ]);
    assertEquals(mutatedResult.count, 1);
    assertEquals(mutatedResult.sizeBytes, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Codex connectors: measures recursive file content size, and changing payload size in files proportionally updates sizeBytes", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const codexMcpDir = join(tempDir, ".codex/mcp");
    const exampleDir = join(codexMcpDir, "example");
    await Deno.mkdir(exampleDir, { recursive: true });

    // 1. Initial 100-byte instructions.md file
    const instructionsPath = join(exampleDir, "instructions.md");
    await Deno.writeTextFile(instructionsPath, "a".repeat(100));

    const initial = await inspectCodexConnectors(codexMcpDir);
    assertEquals(initial.count, 1);
    assertEquals(initial.sizeBytes, 100);

    // 2. Grow instructions.md to 8,000 bytes
    await Deno.writeTextFile(instructionsPath, "b".repeat(8000));

    const grown = await inspectCodexConnectors(codexMcpDir);
    assertEquals(grown.count, 1);
    assertEquals(grown.sizeBytes, 8000);

    // 3. Add nested subdirectory with another payload file
    const nestedDir = join(exampleDir, "schemas");
    await Deno.mkdir(nestedDir, { recursive: true });
    await Deno.writeTextFile(join(nestedDir, "schema.json"), "c".repeat(500));

    const withNested = await inspectCodexConnectors(codexMcpDir);
    assertEquals(withNested.count, 1);
    assertEquals(withNested.sizeBytes, 8500);

    // 4. Add second connector entry
    const secondDir = join(codexMcpDir, "second-connector");
    await Deno.mkdir(secondDir, { recursive: true });
    await Deno.writeTextFile(
      join(secondDir, "instructions.md"),
      "d".repeat(250),
    );

    const twoConnectors = await inspectCodexConnectors(codexMcpDir);
    assertEquals(twoConnectors.count, 2);
    assertEquals(twoConnectors.sizeBytes, 8750);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
