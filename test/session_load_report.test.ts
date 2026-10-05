// test/session_load_report.test.ts
// Unit tests for session load report generator and script (web-jam-tools#1234).

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  computeSessionLoadReport,
  generateSessionLoadReport,
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
  try {
    const text = await Deno.readTextFile(homeSettingsPath);
    assert(
      !text.includes("session-load-report"),
      "~/.claude/settings.json must NOT contain session-load-report",
    );
  } catch {
    // Missing settings is acceptable
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
  try {
    const text = await Deno.readTextFile(agyHooksPath);
    assert(
      !text.includes("session-load-report"),
      "agy hooks.json must NOT register session-load-report",
    );
  } catch {
    // Missing is fine
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
    for (let i = 0; i < limits.bundledSkills.totalCount; i++) {
      skillOverrides[`skill_${i}`] = "name-only";
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
    for (let i = 0; i < limits.bundledSkills.totalCount; i++) {
      skillOverrides[`skill_${i}`] = "name-only";
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
    for (let i = 0; i < limits.bundledSkills.totalCount; i++) {
      skillOverrides[`skill_${i}`] = "name-only";
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

  const result = await lintRunbookFile(runbookPath);
  assertEquals(
    result.valid,
    true,
    `Runbook has violations: ${JSON.stringify(result.violations)}`,
  );
});
