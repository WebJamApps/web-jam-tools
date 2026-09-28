// test/lint_skill_surfaces.test.ts
// Unit tests for surface-scoped tool lint check (web-jam-tools#1145).

import { assert, assertEquals } from "@std/assert";
import {
  isSkillExempt,
  lintSkillContent,
  lintSkillFile,
  runLintSkillSurfaces,
} from "../scripts/lint-skill-surfaces.ts";

// Resolve from this file, not the cwd, so the suite passes from any directory.
const REPO_ROOT = new URL("..", import.meta.url).pathname;
const repoPath = (rel: string): string => `${REPO_ROOT}${rel}`;

Deno.test("lintSkillContent: a ~/.claude/ path on the line does not scope an mcp__ reference", () => {
  const content = `# s

Run \`mcp__reaper__transport_get_state\`, then log it under ~/.claude/state.
`;
  const result = lintSkillContent(content, "skills/s/SKILL.md");
  assertEquals(result.valid, false);
  assertEquals(result.violations[0].toolName, "mcp__reaper__transport_get_state");
});

Deno.test("runLintSkillSurfaces: the default run over every skill passes", async () => {
  const summary = await runLintSkillSurfaces(undefined, REPO_ROOT);
  assertEquals(
    summary.totalViolations,
    0,
    JSON.stringify(summary.results.flatMap((r) => r.violations), null, 2),
  );
  assertEquals(summary.exemptFiles, 1);
});

Deno.test("lintSkillContent: fixture naming mcp__reaper__transport_get_state with no surface-specific note fails", () => {
  const content = `# record-song

Run \`mcp__reaper__transport_get_state\` to check REAPER status.
`;

  const result = lintSkillContent(content, "skills/record-song/SKILL.md");
  assertEquals(result.valid, false);
  assertEquals(result.exempt, false);
  assertEquals(result.violations.length, 1);
  assertEquals(result.violations[0].toolName, "mcp__reaper__transport_get_state");
  assertEquals(result.violations[0].line, 3);
  assert(result.violations[0].message.includes("Claude-only tool reference"));
});

Deno.test("lintSkillContent: fixture containing surface-scoped note passes", () => {
  const content = `# example-skill

On Claude Code, \`mcp__example__tool\` does X; on Codex, \`deno task example\` does the same.
`;

  const result = lintSkillContent(content, "skills/example-skill/SKILL.md");
  assertEquals(result.valid, true);
  assertEquals(result.exempt, false);
  assertEquals(result.violations.length, 0);
});

Deno.test("lintSkillContent: fixture naming Agent tool without surface note fails", () => {
  const content = `# test-skill

Spawn a subagent via the Agent tool to scan files.
`;

  const result = lintSkillContent(content, "skills/test-skill/SKILL.md");
  assertEquals(result.valid, false);
  assertEquals(result.violations.length, 1);
  assert(result.violations[0].toolName.toLowerCase().includes("agent"));
});

Deno.test("lintSkillContent: fixture with Claude Code surface list item block passes", () => {
  const content = `# multi-surface-skill

1. Launch subagent:
   - **Claude Code surface:**
     Use Agent(subagent_type: "general-purpose", model: "haiku")
   - **Codex surface:**
     Run \`deno task scan\` directly
`;

  const result = lintSkillContent(content, "skills/multi-surface-skill/SKILL.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("isSkillExempt: skills/handle-gmails/SKILL.md is exempt", () => {
  assertEquals(isSkillExempt("skills/handle-gmails/SKILL.md"), true);
  assertEquals(isSkillExempt("/path/to/skills/handle-gmails/SKILL.md"), true);
  assertEquals(isSkillExempt("skills/design-issue/SKILL.md"), false);
  assertEquals(isSkillExempt("skills/handle-gmails-v2/SKILL.md"), false);
});

Deno.test("lintSkillFile: handle-gmails is skipped/exempted, not flagged", async () => {
  const filePath = repoPath("skills/handle-gmails/SKILL.md");
  const result = await lintSkillFile(filePath);
  assertEquals(result.exempt, true);
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("lintSkillFile: all five rewritten skills pass the check", async () => {
  const targetSkills = [
    "skills/design-issue/SKILL.md",
    "skills/file-issue/SKILL.md",
    "skills/flash-issues/SKILL.md",
    "skills/memory-cleanup/SKILL.md",
    "skills/drive-cleanup/SKILL.md",
  ];

  for (const skillRelPath of targetSkills) {
    const fullPath = repoPath(skillRelPath);
    const result = await lintSkillFile(fullPath);
    assertEquals(
      result.valid,
      true,
      `Expected ${skillRelPath} to pass surface lint, but got violations: ${
        JSON.stringify(result.violations, null, 2)
      }`,
    );
    assertEquals(result.exempt, false);
    assertEquals(result.violations.length, 0);
  }
});

Deno.test("runLintSkillSurfaces: batch run against the five rewritten skills passes", async () => {
  const targetSkills = [
    "skills/design-issue/SKILL.md",
    "skills/file-issue/SKILL.md",
    "skills/flash-issues/SKILL.md",
    "skills/memory-cleanup/SKILL.md",
    "skills/drive-cleanup/SKILL.md",
  ].map((p) => repoPath(p));

  const summary = await runLintSkillSurfaces(targetSkills);
  assertEquals(summary.valid, true);
  assertEquals(summary.totalViolations, 0);
  assertEquals(summary.scannedFiles, 5);
  assertEquals(summary.exemptFiles, 0);
});
