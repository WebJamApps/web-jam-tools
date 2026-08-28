// test/design_issue_lint_doc.test.ts — web-jam-tools#742
//
// Unit and integration tests for design document linter: status lines, gate/approval states,
// "design complete", revision narration, bare decision labels, and "Both surfaces" section requirement.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { lintDesignDoc, lintDesignDocFile, runLintDocCli } from "../src/design-issue/lint_doc.ts";
import { runCli } from "../src/design-issue/cli.ts";

const FIXTURES_DIR = path.resolve(
  new URL("../test/fixtures/design-issue", import.meta.url).pathname,
);

Deno.test("lintDesignDoc returns valid for compliant design document", () => {
  const validMarkdown = `# My Feature Design

## What it is
A description of what the feature builds and how it operates.

## Architecture
Technical details explaining the implementation.

## Both surfaces
How each mechanism behaves on Claude Code and agy/Antigravity:
| Mechanism | Claude Code | agy |
|---|---|---|
| Runner | deno task | identical |

## Load-bearing premises
| Premise | Proof |
|---|---|
| The runner exists as a deno task | Checked deno.json's tasks map |

## Appendix — Decision Record
| # | Decision | Outcome | Rejected alternatives |
|---|---|---|---|
| 1 | Choice A | Option 1 | Option 2 |
`;

  const result = lintDesignDoc(validMarkdown, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("lintDesignDoc flags status lines", () => {
  const variations = [
    "Status: Approved",
    "status: in progress",
    "**Status**: Draft",
    "*Status*: Pending",
    "- Status: completed",
    "1. status: under review",
    "## Status",
  ];

  for (const line of variations) {
    const doc = `# Title\n\n${line}\n\n## What it is\nText\n\n## Both surfaces\nText`;
    const result = lintDesignDoc(doc, "test.md");
    assertEquals(result.valid, false, `Expected failure for status line: ${line}`);
    const violation = result.violations.find((v) => v.rule === "no-status-line");
    assertEquals(Boolean(violation), true);
  }
});

Deno.test("lintDesignDoc ignores status properties inside fenced code blocks", () => {
  const docWithCode = `# Feature

## What it is
Text

\`\`\`ts
interface State {
  status: "active" | "inactive";
}
const status: string = "active";
\`\`\`

\`\`\`json
{
  "status": "ok"
}
\`\`\`

## Both surfaces
Cross-surface parity is preserved.

## Load-bearing premises
| Premise | Proof |
|---|---|
| The status enum has exactly two members | Read the interface definition above |
`;

  const result = lintDesignDoc(docWithCode, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("lintDesignDoc flags gate and approval states", () => {
  const variations = [
    "Gate 1: Approved",
    "Gate 1 - Approved",
    "Gate 1 approval state: Approved",
    "Gate 2 state: Passed",
    "Approved at Gate 1",
    "Pending Gate 2 approval",
    "Gate 1 approved",
    "Approval state: Approved",
    "Approval status: Approved",
    "Nothing filed yet",
  ];

  for (const variation of variations) {
    const doc = `# Title\n\n## What it is\n${variation}\n\n## Both surfaces\nParity`;
    const result = lintDesignDoc(doc, "test.md");
    assertEquals(result.valid, false, `Expected failure for gate state: ${variation}`);
    const violation = result.violations.find((v) => v.rule === "no-gate-or-approval-state");
    assertEquals(Boolean(violation), true);
  }
});

Deno.test("lintDesignDoc flags phrase 'design complete'", () => {
  const variations = [
    "The design complete and ready.",
    "design complete",
    "DESIGN COMPLETE",
    "Design is complete",
    "design completed",
  ];

  for (const phrase of variations) {
    const doc = `# Title\n\n## What it is\n${phrase}\n\n## Both surfaces\nParity`;
    const result = lintDesignDoc(doc, "test.md");
    assertEquals(result.valid, false, `Expected failure for phrase: ${phrase}`);
    const violation = result.violations.find((v) => v.rule === "no-design-complete");
    assertEquals(Boolean(violation), true);
  }
});

Deno.test("lintDesignDoc flags revision narration phrases", () => {
  const variations = [
    "## What changed",
    "An earlier version said we would use Python.",
    "A previous version said to use MySQL.",
    "In an earlier draft, we considered polling.",
    "Why this was withdrawn from the scope.",
    "Why this was abandoned during design.",
    "## Changelog",
    "## Revision history",
    "Before/after framing of the system.",
    "Before and after comparison.",
    "This turned out to be false when tested.",
  ];

  for (const phrase of variations) {
    const doc = `# Title\n\n## What it is\n${phrase}\n\n## Both surfaces\nParity`;
    const result = lintDesignDoc(doc, "test.md");
    assertEquals(result.valid, false, `Expected failure for narration: ${phrase}`);
    const violation = result.violations.find((v) => v.rule === "no-revision-narration");
    assertEquals(Boolean(violation), true);
  }
});

Deno.test("lintDesignDoc flags bare decision labels in prose", () => {
  const variations = [
    "We implement caching per D-7.",
    "Follows rule per R-39.",
    "Per D-1, the folder will be renamed.",
    "As decided in D-2, use WebSocket.",
    "Under D-5, the hook is bypassed.",
    "See D-3 for details.",
    "Configured via R-10.",
  ];

  for (const label of variations) {
    const doc = `# Title\n\n## What it is\n${label}\n\n## Both surfaces\nParity`;
    const result = lintDesignDoc(doc, "test.md");
    assertEquals(result.valid, false, `Expected failure for bare label: ${label}`);
    const violation = result.violations.find((v) => v.rule === "no-bare-decision-labels");
    assertEquals(Boolean(violation), true);
  }
});

Deno.test("lintDesignDoc allows table row IDs in Decision Record tables", () => {
  const doc = `# Title

## What it is
Clean description without bare labels in prose.

## Both surfaces
Parity details.

## Load-bearing premises
| Premise | Proof |
|---|---|
| The folder-naming convention is already established | Read the existing Dropbox theme folders |

## Appendix — Decision Record
| D-1 | Folder naming convention | Milestone name | Repo name |
| D-2 | Cache layer | In-memory | Redis |
`;

  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("lintDesignDoc recognizes decorated/bold Proof column headers", () => {
  const doc = `# Title

## What it is
Clean description.

## Both surfaces
Parity details.

## Load-bearing premises
| **Premise** | **Proof** |
|---|---|
| The folder-naming convention is already established | Read the existing Dropbox theme folders |

## Appendix — Decision Record
| D-1 | Folder naming convention | Milestone name | Repo name |
`;

  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("lintDesignDoc flags missing '## Both surfaces' section", () => {
  const docWithoutBothSurfaces = `# Feature Design

## What it is
A description of the feature.

## Architecture
Architecture details.
`;

  const result = lintDesignDoc(docWithoutBothSurfaces, "test.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) => v.rule === "require-both-surfaces-section");
  assertEquals(Boolean(violation), true);
});

Deno.test("lintDesignDocFile throws when path is missing or empty", async () => {
  await assertRejects(
    async () => {
      await lintDesignDocFile("");
    },
    Error,
    "Design document path is required",
  );

  await assertRejects(
    async () => {
      await lintDesignDocFile("   ");
    },
    Error,
    "Design document path is required",
  );
});

Deno.test("lintDesignDocFile throws when file does not exist", async () => {
  await assertRejects(
    async () => {
      await lintDesignDocFile("/tmp/non-existent-design-file-12345.md");
    },
    Error,
    "Design document not found or cannot be read",
  );
});

Deno.test("lintDesignDocFile throws when file is empty", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "lint-test-empty-" });
  const emptyPath = path.join(tempDir, "empty.md");
  await Deno.writeTextFile(emptyPath, "   \n\n\t  ");

  try {
    await assertRejects(
      async () => {
        await lintDesignDocFile(emptyPath);
      },
      Error,
      "is empty",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("lintDesignDocFile passes valid fixture valid-doc.md", async () => {
  const validFixturePath = path.join(FIXTURES_DIR, "valid-doc.md");
  const result = await lintDesignDocFile(validFixturePath);
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("lintDesignDocFile fails invalid fixture invalid-doc.md with all violations", async () => {
  const invalidFixturePath = path.join(FIXTURES_DIR, "invalid-doc.md");
  const result = await lintDesignDocFile(invalidFixturePath);
  assertEquals(result.valid, false);

  const rulesViolated = result.violations.map((v) => v.rule);
  assertEquals(rulesViolated.includes("no-status-line"), true);
  assertEquals(rulesViolated.includes("no-gate-or-approval-state"), true);
  assertEquals(rulesViolated.includes("no-design-complete"), true);
  assertEquals(rulesViolated.includes("no-revision-narration"), true);
  assertEquals(rulesViolated.includes("no-bare-decision-labels"), true);
  assertEquals(rulesViolated.includes("require-both-surfaces-section"), true);
  assertEquals(rulesViolated.includes("require-load-bearing-premises-section"), true);
  assertEquals(rulesViolated.includes("require-target-issue-verbatim-appendix"), true);
});

Deno.test("lintDesignDocFile correctly flags individual invalid fixtures", async () => {
  const fixtures: Record<string, string> = {
    "invalid-status-line.md": "no-status-line",
    "invalid-gate-state.md": "no-gate-or-approval-state",
    "invalid-design-complete.md": "no-design-complete",
    "invalid-revision-narration.md": "no-revision-narration",
    "invalid-bare-decision-label.md": "no-bare-decision-labels",
    "invalid-missing-both-surfaces.md": "require-both-surfaces-section",
    "invalid-missing-load-bearing-premises.md": "require-load-bearing-premises-section",
    "invalid-hedged-premise-proof.md": "load-bearing-premises-unproven-row",
    "invalid-target-issue-no-appendix.md": "require-target-issue-verbatim-appendix",
  };

  for (const [filename, expectedRule] of Object.entries(fixtures)) {
    const fixturePath = path.join(FIXTURES_DIR, filename);
    const result = await lintDesignDocFile(fixturePath);
    assertEquals(result.valid, false, `Expected ${filename} to be invalid`);
    const hasExpectedRule = result.violations.some((v) => v.rule === expectedRule);
    assertEquals(
      hasExpectedRule,
      true,
      `Expected ${filename} to have violation for rule ${expectedRule}`,
    );
  }
});

Deno.test("runLintDocCli handles --help cleanly", async () => {
  const exitCode = await runLintDocCli(["--help"]);
  assertEquals(exitCode, 0);
});

Deno.test("runLintDocCli returns exit code 1 when doc argument is missing", async () => {
  const exitCode = await runLintDocCli([]);
  assertEquals(exitCode, 1);
});

Deno.test("runLintDocCli returns exit code 1 when file does not exist", async () => {
  const exitCode = await runLintDocCli(["/tmp/non-existent-doc-999.md"]);
  assertEquals(exitCode, 1);
});

Deno.test("runLintDocCli exits 0 for valid fixture", async () => {
  const validFixturePath = path.join(FIXTURES_DIR, "valid-doc.md");
  const exitCode = await runLintDocCli([validFixturePath]);
  assertEquals(exitCode, 0);
});

Deno.test("runLintDocCli exits 1 for invalid fixture", async () => {
  const invalidFixturePath = path.join(FIXTURES_DIR, "invalid-doc.md");
  const exitCode = await runLintDocCli([invalidFixturePath]);
  assertEquals(exitCode, 1);
});

Deno.test("runLintDocCli supports --json flag", async () => {
  const validFixturePath = path.join(FIXTURES_DIR, "valid-doc.md");
  const exitCode = await runLintDocCli([validFixturePath, "--json"]);
  assertEquals(exitCode, 0);
});

Deno.test("cli.ts routes lint-doc subcommand correctly", async () => {
  const validFixturePath = path.join(FIXTURES_DIR, "valid-doc.md");
  const exitCodeValid = await runCli(["lint-doc", validFixturePath]);
  assertEquals(exitCodeValid, 0);

  const invalidFixturePath = path.join(FIXTURES_DIR, "invalid-doc.md");
  const exitCodeInvalid = await runCli(["lint-doc", invalidFixturePath]);
  assertEquals(exitCodeInvalid, 1);
});

Deno.test("deno.json defines design:lint-doc task", async () => {
  const denoJsonContent = await Deno.readTextFile(
    new URL("../deno.json", import.meta.url).pathname,
  );
  const config = JSON.parse(denoJsonContent);

  assertEquals(typeof config.tasks["design:lint-doc"], "string");
  assertStringIncludes(config.tasks["design:lint-doc"], "src/design-issue/cli.ts lint-doc");
});
