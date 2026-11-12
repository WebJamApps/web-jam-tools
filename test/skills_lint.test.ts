// test/skills_lint.test.ts
// Unit tests for skills linting module (web-jam-tools#744).

import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import * as path from "@std/path";
import {
  AGY_MENTION_PATTERN,
  CLAUDE_ONLY_MACHINERY_LITERALS,
  findSkillFiles,
  lintAllSkills,
  lintSkillFile,
  lintSkillMarkdown,
  runLintSkillsCli,
  SURFACE_SPECIFIC_MACHINERY_PATTERNS,
} from "../src/skills-lint/lint_skills.ts";

Deno.test("lintSkillMarkdown: passes on clean skill markdown", () => {
  const cleanContent = `---
name: sample-skill
description: A clean sample skill with no wiki links.
---

# sample-skill

This is a clean skill body that explains rules directly in prose.
- Rule 1: Always verify state.
- Rule 2: State requirements clearly.
`;

  const result = lintSkillMarkdown(cleanContent, "sample-skill/SKILL.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
  assertEquals(result.filePath, "sample-skill/SKILL.md");
});

Deno.test("lintSkillMarkdown: fails on wiki-links in skill body", () => {
  const failingContent = `---
name: sample-skill
description: A sample skill with wiki links.
---

# sample-skill

See [[manual-steps-go-in-issues]] for instructions.
Related: [[design-record-approve-then-dispatch]], [[github-issues-must-be-closeable]].
`;

  const result = lintSkillMarkdown(failingContent, "sample-skill/SKILL.md");
  assertEquals(result.valid, false);
  assertEquals(result.violations.length, 3);

  assertEquals(result.violations[0].line, 8);
  assertEquals(result.violations[0].linkText, "[[manual-steps-go-in-issues]]");
  assert(result.violations[0].lineContent.includes("manual-steps-go-in-issues"));
  assert(result.violations[0].message.includes("Unresolvable wiki-link"));

  assertEquals(result.violations[1].line, 9);
  assertEquals(result.violations[1].linkText, "[[design-record-approve-then-dispatch]]");

  assertEquals(result.violations[2].line, 9);
  assertEquals(result.violations[2].linkText, "[[github-issues-must-be-closeable]]");
});

Deno.test("lintSkillMarkdown: ignores wiki-links inside fenced code blocks", () => {
  const codeBlockContent = `---
name: sample-skill
description: Skill with code blocks.
---

# sample-skill

Here is an example in a code block:

\`\`\`text
Task 5: Swap devotional source. [[task-spec-devotional-swap]]
\`\`\`

~~~sh
# another code block
echo "[[example-slug]]"
~~~
`;

  const result = lintSkillMarkdown(codeBlockContent, "sample-skill/SKILL.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("lintSkillMarkdown: ignores wiki-links inside inline backticks", () => {
  const inlineCodeContent = `---
name: sample-skill
description: Skill with inline code.
---

# sample-skill

Extract bodies to memory files, leave headlines + \`[[task-spec-<slug>]]\` cross-refs.
Also mandatory grep for inbound \`[[slug]]\` references.
`;

  const result = lintSkillMarkdown(inlineCodeContent, "sample-skill/SKILL.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("lintSkillMarkdown: ignores frontmatter text", () => {
  const frontmatterContent = `---
name: memory-cleanup
description: Scans every memory surface for staleness, dangling [[links]], and drift.
---

# memory-cleanup

Skill body with no wiki links.
`;

  const result = lintSkillMarkdown(frontmatterContent, "memory-cleanup/SKILL.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("lintSkillFile: lints temporary passing and failing files", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "skills-lint-test-" });
  try {
    const passPath = path.join(tempDir, "PASS.md");
    const failPath = path.join(tempDir, "FAIL.md");

    await Deno.writeTextFile(passPath, "# Clean Skill\nAll good.\n");
    await Deno.writeTextFile(failPath, "# Bad Skill\nSee [[some-dead-link]].\n");

    const passResult = await lintSkillFile(passPath);
    assertEquals(passResult.valid, true);
    assertEquals(passResult.violations.length, 0);

    const failResult = await lintSkillFile(failPath);
    assertEquals(failResult.valid, false);
    assertEquals(failResult.violations.length, 1);
    assertEquals(failResult.violations[0].linkText, "[[some-dead-link]]");
    assertEquals(failResult.violations[0].line, 2);

    await assertRejects(
      async () => {
        await lintSkillFile(path.join(tempDir, "NONEXISTENT.md"));
      },
      Error,
      "Failed to read skill file",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findSkillFiles: locates all skills in repo", () => {
  const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const files = findSkillFiles(repoRoot);
  assert(files.length >= 14, `Expected at least 14 skill files, found ${files.length}`);
  for (const f of files) {
    assert(f.endsWith("SKILL.md"), `Expected file to end with SKILL.md: ${f}`);
  }
});

Deno.test("lintAllSkills: current repo skills are 100% clean", async () => {
  const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const summary = await lintAllSkills({ rootDir: repoRoot });

  assertEquals(
    summary.valid,
    true,
    `Expected all skills to be clean, but found ${summary.totalViolations} violation(s)`,
  );
  assertEquals(summary.totalViolations, 0);
  assert(summary.scannedFiles >= 14);
});

Deno.test("lintAllSkills: reports summary with violations when failing file is included", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "skills-lint-summary-" });
  try {
    const failPath = path.join(tempDir, "SKILL.md");
    await Deno.writeTextFile(failPath, "# Bad\n[[broken-link-1]]\n[[broken-link-2]]\n");

    const summary = await lintAllSkills({ files: [failPath] });
    assertEquals(summary.valid, false);
    assertEquals(summary.totalViolations, 2);
    assertEquals(summary.scannedFiles, 1);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runLintSkillsCli: --help exits 0", async () => {
  const exitCode = await runLintSkillsCli(["--help"]);
  assertEquals(exitCode, 0);
});

Deno.test("runLintSkillsCli: clean run exits 0", async () => {
  const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const exitCode = await runLintSkillsCli(["--dir", repoRoot, "--quiet"]);
  assertEquals(exitCode, 0);
});

Deno.test("runLintSkillsCli: failing file exits 1 and supports --json", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "skills-lint-cli-" });
  try {
    const failPath = path.join(tempDir, "SKILL.md");
    await Deno.writeTextFile(failPath, "# Bad\n[[unresolvable-link]]\n");

    // Capture console output during --json
    const originalLog = console.log;
    let jsonOutput = "";
    console.log = (msg: string) => {
      jsonOutput = msg;
    };

    try {
      const exitCode = await runLintSkillsCli([failPath, "--json"]);
      assertEquals(exitCode, 1);

      assertExists(jsonOutput);
      const parsed = JSON.parse(jsonOutput);
      assertEquals(parsed.valid, false);
      assertEquals(parsed.totalViolations, 1);
      assertEquals(parsed.results[0].violations[0].linkText, "[[unresolvable-link]]");
    } finally {
      console.log = originalLog;
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// --- Tests for web-jam-tools#1091 (agy / Antigravity presence rule) ---

Deno.test("lintSkillMarkdown: fixture body naming surface-specific machinery with no agy/Antigravity mention fails (AC 1)", () => {
  const fixture1 = `---
name: sample-skill
description: Fixture naming Claude Code surface.
---

# sample-skill

- On Claude Code, spawn via the Agent tool (model: "haiku").
- Use mcp__google-drive__listFiles to find drive files.
`;

  const result1 = lintSkillMarkdown(fixture1, "claude-skill/SKILL.md");
  assertEquals(result1.valid, false);
  assertEquals(result1.violations.length, 1);
  assertEquals(result1.violations[0].line, 8);
  assertEquals(result1.violations[0].linkText, "Claude Code");
  assert(result1.violations[0].message.includes("must mention 'agy' or 'Antigravity'"));

  // Check another fixture naming only mcp__ machinery
  const fixture2 = `---
name: mcp-skill
description: Fixture naming mcp tools.
---

# mcp-skill

Call mcp__github__issue_read to inspect issue state.
`;
  const result2 = lintSkillMarkdown(fixture2, "mcp-skill/SKILL.md");
  assertEquals(result2.valid, false);
  assertEquals(result2.violations.length, 1);
  assertEquals(result2.violations[0].linkText, "mcp__github__issue_read");

  // Check fixture with invoke_subagent but no agy/Antigravity
  const fixture3 = `# invoke-skill
Dispatch a subagent using invoke_subagent.
`;
  const result3 = lintSkillMarkdown(fixture3, "invoke-skill/SKILL.md");
  assertEquals(result3.valid, false);
  assertEquals(result3.violations.length, 1);
  assertEquals(result3.violations[0].linkText, "invoke_subagent");
});

Deno.test("lintSkillMarkdown: the same body with one agy or Antigravity mention passes (AC 2)", () => {
  const passingAgy = `---
name: dual-surface-skill
description: Fixture naming Claude Code and agy.
---

# dual-surface-skill

- On Claude Code, spawn via the Agent tool (model: "haiku").
- On Antigravity (\`agy\`), dispatch via invoke_subagent.
- Use mcp__google-drive__listFiles or call_mcp_tool on agy.
`;

  const resultAgy = lintSkillMarkdown(passingAgy, "dual-surface-skill/SKILL.md");
  assertEquals(resultAgy.valid, true);
  assertEquals(resultAgy.violations.length, 0);

  const passingAntigravityOnly = `---
name: antigravity-skill
description: Fixture naming Antigravity.
---

# antigravity-skill

- On Claude Code surface: execute directly.
- On Antigravity surface: dispatch task.
`;
  const resultAntigravity = lintSkillMarkdown(passingAntigravityOnly, "antigravity-skill/SKILL.md");
  assertEquals(resultAntigravity.valid, true);
  assertEquals(resultAntigravity.violations.length, 0);
});

Deno.test("lintSkillMarkdown: a body matching only Flash High as a label name still fails (AC 3)", () => {
  const fixtureWithFlashHighLabel = `---
name: fix-labels-fixture
description: Fixture naming Claude machinery and listing Flash High label.
---

# fix-labels-fixture

On Claude Code, spawn via the Agent tool.

Supported GitHub labels:
- Flash High
- Flash Med
- Flash Low
`;

  const result = lintSkillMarkdown(fixtureWithFlashHighLabel, "fix-labels-fixture/SKILL.md");
  assertEquals(result.valid, false);
  assertEquals(result.violations.length, 1);
  assert(result.violations[0].message.includes("must mention 'agy' or 'Antigravity'"));

  // Also verify that a body with model: "haiku" and Flash High as label still fails
  const fixture2 = `# label-fixture
- Model tier label: Flash High
- Subagent dispatch: model: "haiku"
`;
  const result2 = lintSkillMarkdown(fixture2, "label-fixture/SKILL.md");
  assertEquals(result2.valid, false);
  assertEquals(result2.violations.length, 1);
  assert(result2.violations[0].message.includes("must mention 'agy' or 'Antigravity'"));
});

Deno.test("lintSkillMarkdown: ignores surface machinery inside fenced code blocks", () => {
  const codeBlockOnly = `---
name: code-only-skill
description: Surface machinery in code block only.
---

# code-only-skill

Here is an example in a fenced code block:

\`\`\`markdown
- On Claude Code, run tool.
- Model: "haiku"
- mcp__github__issue_read
\`\`\`

Prose has no surface machinery, only standard instructions.
`;

  const result = lintSkillMarkdown(codeBlockOnly, "code-only-skill/SKILL.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("lintSkillMarkdown: ignores surface machinery inside frontmatter", () => {
  const frontmatterOnly = `---
name: frontmatter-skill
description: Mentions Claude Code in frontmatter description only.
---

# frontmatter-skill

Prose body is clean and surface-neutral.
`;

  const result = lintSkillMarkdown(frontmatterOnly, "frontmatter-skill/SKILL.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("AGY_MENTION_PATTERN: strictly matches agy and Antigravity, rejecting Flash and Gemini", () => {
  assert(AGY_MENTION_PATTERN.test("agy"));
  assert(AGY_MENTION_PATTERN.test("AGY"));
  assert(AGY_MENTION_PATTERN.test("Antigravity"));
  assert(AGY_MENTION_PATTERN.test("antigravity"));
  assert(AGY_MENTION_PATTERN.test("(`agy`)"));
  assert(AGY_MENTION_PATTERN.test("Antigravity / agy"));
  assert(AGY_MENTION_PATTERN.test("agy/Flash"));

  // Must reject surface-neutral model labels and names
  assertEquals(AGY_MENTION_PATTERN.test("Flash"), false);
  assertEquals(AGY_MENTION_PATTERN.test("Flash High"), false);
  assertEquals(AGY_MENTION_PATTERN.test("Flash Med"), false);
  assertEquals(AGY_MENTION_PATTERN.test("Flash Low"), false);
  assertEquals(AGY_MENTION_PATTERN.test("Gemini"), false);
  assertEquals(AGY_MENTION_PATTERN.test("Gemini Flash"), false);
});

Deno.test("SURFACE_SPECIFIC_MACHINERY_PATTERNS: matches surface-specific indicators", () => {
  const matchesAny = (str: string) => SURFACE_SPECIFIC_MACHINERY_PATTERNS.some((p) => p.test(str));

  assert(matchesAny("On Claude Code, run the tool."));
  assert(matchesAny("~/.claude/hooks/foo.sh"));
  assert(matchesAny("On Codex, run directly."));
  assert(matchesAny("mcp__github__issue_read"));
  assert(matchesAny('Agent tool with model: "haiku"'));
  assert(matchesAny('Agent(model: "sonnet")'));
  assert(matchesAny("/model haiku"));
  assert(matchesAny('/model "Gemini 3.8 Flash (High)"'));
  assert(matchesAny("Haiku subagents"));
  assert(matchesAny("MUST be on Haiku"));
  assert(matchesAny("invoke_subagent"));
  assert(matchesAny("call_mcp_tool"));

  // Surface-neutral strings and false positives should not match
  assertEquals(matchesAny("Clean instructions for git commit."), false);
  assertEquals(matchesAny("Labels: Flash High, Flash Med, Flash Low"), false);
  assertEquals(matchesAny("See src/shared/model/helpers.ts for model logic."), false);
  assertEquals(matchesAny("Co-Authored-By: Claude Sonnet 5.5"), false);
  // agy / Antigravity is the target mention, not surface machinery
  assertEquals(matchesAny("On agy, run the tool."), false);
  assertEquals(matchesAny("Antigravity surface"), false);
});

Deno.test("lintSkillMarkdown: passes on path segment containing /model/ and bare Claude model attribution without agy mention", () => {
  const content = `---
name: model-attribution-skill
description: Skill mentioning file path and bare model name.
---

# model-attribution-skill

See \`src/shared/model/helpers.ts\` or src/shared/model/helpers.ts for shared helpers.
Commit footer: Co-Authored-By: Claude Sonnet 5.5.
`;

  const result = lintSkillMarkdown(content, "model-attribution-skill/SKILL.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

// --- Tests for web-jam-tools#1090 (literal Claude-only machinery strings) ---

Deno.test("CLAUDE_ONLY_MACHINERY_LITERALS: contains exactly the closed list of 8 strings", () => {
  const expected = [
    "/model haiku",
    "MUST be on Haiku",
    "must run on Haiku",
    "delegate: Haiku",
    "Haiku subagent",
    "Haiku subagents",
    "Never run it on Opus",
    "Flash High multimodal vision",
  ];
  assertEquals([...CLAUDE_ONLY_MACHINERY_LITERALS], expected);
});

Deno.test("lintSkillMarkdown: each of the 8 strings fails a fixture body (AC 1)", () => {
  for (const literal of CLAUDE_ONLY_MACHINERY_LITERALS) {
    const fixture = `---
name: failing-skill
description: Skill testing literal string failure.
---

# failing-skill

Instruction mentioning agy and Antigravity so whole-file rule passes.
Here is the offending machinery: ${literal}
`;

    const result = lintSkillMarkdown(fixture, "failing-skill/SKILL.md");
    assertEquals(
      result.valid,
      false,
      `Expected literal string '${literal}' to fail the fixture, but it passed.`,
    );
    const violation = result.violations.find((v) => v.linkText === literal);
    assertExists(
      violation,
      `Expected violation with linkText '${literal}', but found: ${
        JSON.stringify(result.violations)
      }`,
    );
    assert(
      violation.message.includes("Literal Claude-only machinery string"),
      `Expected message to mention literal Claude-only machinery string: ${violation.message}`,
    );
  }
});

Deno.test("lintSkillMarkdown: literal strings inside fenced code blocks or frontmatter pass", () => {
  for (const literal of CLAUDE_ONLY_MACHINERY_LITERALS) {
    const codeBlockFixture = `---
name: code-block-skill
description: Mentions ${literal} in frontmatter.
---

# code-block-skill

Mentions agy and Antigravity in prose.

\`\`\`markdown
Example of machinery: ${literal}
\`\`\`
`;
    const result = lintSkillMarkdown(codeBlockFixture, "code-block-skill/SKILL.md");
    assertEquals(
      result.valid,
      true,
      `Expected '${literal}' in code block/frontmatter to be ignored, but failed: ${
        JSON.stringify(result.violations)
      }`,
    );
  }
});

Deno.test("lintSkillMarkdown: body containing mcp__claude_ai_GitHub_MCP__issue_read beside an agy clause passes (AC 2)", () => {
  const content = `---
name: dual-mcp-skill
description: Dual surface MCP tool usage.
---

# dual-mcp-skill

- Under Claude Code: call mcp__claude_ai_GitHub_MCP__issue_read to inspect issue state.
- Under agy / Antigravity: use gh issue view.
`;
  const result = lintSkillMarkdown(content, "dual-mcp-skill/SKILL.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test('lintSkillMarkdown: body containing model: "haiku" beside an invoke_subagent line passes (AC 3)', () => {
  const content = `---
name: dual-dispatch-skill
description: Dual surface dispatch instructions.
---

# dual-dispatch-skill

- On Claude Code: dispatch Agent with model: "haiku" to handle dispatch.
- On agy / Antigravity: dispatch with invoke_subagent.
`;
  const result = lintSkillMarkdown(content, "dual-dispatch-skill/SKILL.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("lintSkillMarkdown: singular and plural Haiku subagent disambiguation", () => {
  // 1. Plural only produces exactly one violation for 'Haiku subagents'
  const pluralFixture = `---
name: plural-skill
description: Tests plural disambiguation.
---

# plural-skill

Instruction mentioning agy and Antigravity so whole-file rule passes.
Do not dispatch multiple Haiku subagents for this task.
`;
  const pluralResult = lintSkillMarkdown(pluralFixture, "plural-skill/SKILL.md");
  assertEquals(pluralResult.valid, false);
  assertEquals(pluralResult.violations.length, 1);
  assertEquals(pluralResult.violations[0].linkText, "Haiku subagents");

  // 2. Both singular and plural on the same line produces exactly two violations
  const dualFixture = `---
name: dual-skill
description: Tests both singular and plural on one line.
---

# dual-skill

Instruction mentioning agy and Antigravity so whole-file rule passes.
Neither a single Haiku subagent nor multiple Haiku subagents should be used.
`;
  const dualResult = lintSkillMarkdown(dualFixture, "dual-skill/SKILL.md");
  assertEquals(dualResult.valid, false);
  assertEquals(dualResult.violations.length, 2);
  const dualLiterals = dualResult.violations.map((v) => v.linkText).sort();
  assertEquals(dualLiterals, ["Haiku subagent", "Haiku subagents"]);

  // 3. Singular only produces exactly one violation for 'Haiku subagent'
  const singularFixture = `---
name: singular-skill
description: Tests singular only.
---

# singular-skill

Instruction mentioning agy and Antigravity so whole-file rule passes.
Dispatching via a thin Haiku subagent is prohibited.
`;
  const singularResult = lintSkillMarkdown(singularFixture, "singular-skill/SKILL.md");
  assertEquals(singularResult.valid, false);
  assertEquals(singularResult.violations.length, 1);
  assertEquals(singularResult.violations[0].linkText, "Haiku subagent");
});
