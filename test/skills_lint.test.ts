// test/skills_lint.test.ts
// Unit tests for skills linting module (web-jam-tools#744).

import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import * as path from "@std/path";
import {
  findSkillFiles,
  lintAllSkills,
  lintSkillFile,
  lintSkillMarkdown,
  runLintSkillsCli,
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
