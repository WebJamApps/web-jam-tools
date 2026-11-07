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

// This suite predates the Proved-date freshness rule (web-jam-tools#1025, covered in
// test/design_issue_lint_doc_proved_date.test.ts); every premises table fixture below carries a
// same-day Proved column purely to stay out of that rule's way.
const TODAY = new Date().toISOString().slice(0, 10);

Deno.test("lintDesignDoc returns valid for compliant design document", () => {
  const validMarkdown = `# My Feature Design

## What it is
A description of what the feature builds and how it operates.

## Architecture
Technical details explaining the implementation.

## Both surfaces
How each mechanism behaves on Claude Code and agy/Antigravity:
| Mechanism | Claude Code | agy | Codex |
|---|---|---|---|
| Runner | deno task | identical | identical |

## Load-bearing premises
| Premise | Proof | Proved |
|---|---|---|
| The runner exists as a deno task | Checked deno.json's tasks map | ${TODAY} |

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
Cross-surface parity is preserved across Claude Code, agy, and Codex.

## Load-bearing premises
| Premise | Proof | Proved |
|---|---|---|
| The status enum has exactly two members | Read the interface definition above | ${TODAY} |
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
    "This document tracks revision history in prose.",
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
Parity details across Claude Code, agy, and Codex.

## Load-bearing premises
| Premise | Proof | Proved |
|---|---|---|
| The folder-naming convention is already established | Read the existing Dropbox theme folders | ${TODAY} |

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
Parity details across Claude Code, agy, and Codex.

## Load-bearing premises
| **Premise** | **Proof** | **Proved** |
|---|---|---|
| The folder-naming convention is already established | Read the existing Dropbox theme folders | ${TODAY} |

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

Deno.test("lintDesignDoc flags '## Both surfaces' table lacking Codex column", () => {
  const doc = `# Feature Design

## What it is
A description of the feature.

## Both surfaces
| Mechanism | Claude Code | agy |
|---|---|---|
| Runner | deno task | identical |

## Load-bearing premises
| Premise | Proof | Proved |
|---|---|---|
| The runner exists | Verified | ${TODAY} |
`;

  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) => v.rule === "require-both-surfaces-codex");
  assertEquals(Boolean(violation), true);
  assertEquals(violation?.message.includes("'Codex' column"), true);
});

Deno.test("lintDesignDoc flags '## Both surfaces' table row with empty Codex entry", () => {
  const doc = `# Feature Design

## What it is
A description of the feature.

## Both surfaces
| Mechanism | Claude Code | agy | Codex |
|---|---|---|---|
| Runner | deno task | identical |  |

## Load-bearing premises
| Premise | Proof | Proved |
|---|---|---|
| The runner exists | Verified | ${TODAY} |
`;

  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) => v.rule === "require-both-surfaces-codex");
  assertEquals(Boolean(violation), true);
  assertEquals(violation?.message.includes("empty Codex entry"), true);
});

Deno.test("lintDesignDoc flags '## Both surfaces' prose that never mentions Codex", () => {
  const doc = `# Feature Design

## What it is
A description of the feature.

## Both surfaces
Cross-surface parity is preserved across Claude Code and agy.

## Load-bearing premises
| Premise | Proof | Proved |
|---|---|---|
| The runner exists | Verified | ${TODAY} |
`;

  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) => v.rule === "require-both-surfaces-codex");
  assertEquals(Boolean(violation), true);
  assertEquals(violation?.message.includes("lacks a Codex entry in prose"), true);
});

Deno.test("lintDesignDoc passes '## Both surfaces' table with Claude Code, agy (Antigravity), and Codex columns", () => {
  const doc = `# Feature Design

## What it is
A description of the feature.

## Both surfaces
| Mechanism | Claude Code | agy (Antigravity) | Codex |
|---|---|---|---|
| Runner | deno task | identical | identical |

## Load-bearing premises
| Premise | Proof | Proved |
|---|---|---|
| The runner exists | Verified | ${TODAY} |
`;

  const result = lintDesignDoc(doc, "test.md");
  const bothSurfacesViolations = result.violations.filter(
    (v) => v.rule === "require-both-surfaces-section" || v.rule === "require-both-surfaces-codex",
  );
  assertEquals(bothSurfacesViolations.length, 0);
  assertEquals(result.valid, true);
});

Deno.test("lintDesignDoc checks each '## Both surfaces' table against its own header", () => {
  const doc = `# Feature Design

## What it is
A description of the feature.

## Both surfaces
| Mechanism | Claude Code | Codex |
|---|---|---|
| Runner | deno task | identical |

| Mechanism | Claude Code | agy |
|---|---|---|
| Hooks | settings.json | hooks.json |

## Load-bearing premises
| Premise | Proof | Proved |
|---|---|---|
| The runner exists | Verified | ${TODAY} |
`;

  const result = lintDesignDoc(doc, "test.md");
  const violations = result.violations.filter((v) => v.rule === "require-both-surfaces-codex");
  assertEquals(violations.length, 1);
  assertEquals(violations[0].message.includes("lacks a 'Codex' column"), true);
});

Deno.test("lintDesignDoc: verbatim Both surfaces excerpt of the Codex integration design passes", () => {
  const excerptDoc = `# ChatGPT and Codex Integration — Design

## What it is
Design for integration of Codex into WebJamApps workflows.

## Both surfaces — Claude Code, agy and Codex

Every design document states, for each mechanism it designs, how it works on Claude Code, agy and Codex; the section keeps its \`## Both surfaces\` heading, and \`deno task design:lint-doc\` requires a Codex entry in it.

| Mechanism | Claude Code | agy (Antigravity) | Codex |
|---|---|---|---|
| Skills | Symlinked from the canonical clone; invoked as \`/name\` | Symlinked into agy's plugin directory; invoked as \`/name\` | Symlinked into \`~/.agents/skills\`; invoked as \`$name\`. |

## Load-bearing premises
| Premise | Proof | Proved |
|---|---|---|
| Codex CLI is installed | Verified | ${TODAY} |
`;
  const result = lintDesignDoc(excerptDoc, "codex-integration-design.md");
  const bothSurfacesViolations = result.violations.filter(
    (v) => v.rule === "require-both-surfaces-section" || v.rule === "require-both-surfaces-codex",
  );
  assertEquals(bothSurfacesViolations, []);
  assertEquals(result.valid, true);
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

Deno.test("AC7 & AC9: lintDesignDoc passes document with valid ## Revision History table", () => {
  const doc = `# Title

## What it is
Design content.

## Revision History

| Version | Date | Epic / Issue | Summary |
|---|---|---|---|
| 1.0.0 | 2026-08-16 | [Issue 1](https://example.com/1) | Initial release |
| 1.1.0 | 2026-09-02 | [Issue 2](https://example.com/2) | Added new features |

## Both surfaces
Parity details across Claude Code, agy, and Codex.

## Load-bearing premises
| # | Premise | Proof | Proved |
|---|---|---|---|
| 1 | P1 | Verified in code | ${TODAY} |
`;
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("AC7: lintDesignDoc passes document without Revision History table", () => {
  const doc = `# Title

## What it is
Content.

## Both surfaces
Parity details across Claude Code, agy, and Codex.

## Load-bearing premises
| # | Premise | Proof | Proved |
|---|---|---|---|
| 1 | P1 | Verified in code | ${TODAY} |
`;
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
});

Deno.test("AC7: lintDesignDoc fails when Revision History table lacks Version column", () => {
  const doc = `# Title

## What it is
Content.

## Revision History

| Date | Epic / Issue | Summary |
|---|---|---|
| 2026-08-16 | [Issue 1](https://example.com/1) | Initial |

## Both surfaces
Parity.

## Load-bearing premises
| # | Premise | Proof |
|---|---|---|
| 1 | P1 | Verified in code |
`;
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) =>
    v.rule === "invalid-revision-history-table" && v.message.includes("'Version'")
  );
  assertEquals(Boolean(violation), true);
});

Deno.test("AC7: lintDesignDoc fails when Revision History table lacks Date column", () => {
  const doc = `# Title

## What it is
Content.

## Revision History

| Version | Epic / Issue | Summary |
|---|---|---|
| 1.0.0 | [Issue 1](https://example.com/1) | Initial |

## Both surfaces
Parity.

## Load-bearing premises
| # | Premise | Proof |
|---|---|---|
| 1 | P1 | Verified in code |
`;
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) =>
    v.rule === "invalid-revision-history-table" && v.message.includes("'Date'")
  );
  assertEquals(Boolean(violation), true);
});

Deno.test("AC7: lintDesignDoc fails when Revision History table has no data rows", () => {
  const doc = `# Title

## What it is
Content.

## Revision History

| Version | Date | Summary |
|---|---|---|

## Both surfaces
Parity.

## Load-bearing premises
| # | Premise | Proof |
|---|---|---|
| 1 | P1 | Verified in code |
`;
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) =>
    v.rule === "invalid-revision-history-table" && v.message.includes("no data rows")
  );
  assertEquals(Boolean(violation), true);
});

Deno.test("AC7: lintDesignDoc fails when Revision History table carries unparseable version", () => {
  const doc = `# Title

## What it is
Content.

## Revision History

| Version | Date | Summary |
|---|---|---|
| not-a-semver | 2026-08-16 | Initial |

## Both surfaces
Parity.

## Load-bearing premises
| # | Premise | Proof |
|---|---|---|
| 1 | P1 | Verified in code |
`;
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) =>
    v.rule === "invalid-revision-history-table" && v.message.includes("unparseable version")
  );
  assertEquals(Boolean(violation), true);
});

Deno.test("AC7: lintDesignDoc fails when Revision History table carries unparseable date", () => {
  const doc = `# Title

## What it is
Content.

## Revision History

| Version | Date | Summary |
|---|---|---|
| 1.0.0 | August 16 2026 | Initial |

## Both surfaces
Parity.

## Load-bearing premises
| # | Premise | Proof |
|---|---|---|
| 1 | P1 | Verified in code |
`;
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) =>
    v.rule === "invalid-revision-history-table" && v.message.includes("unparseable date")
  );
  assertEquals(Boolean(violation), true);
});

Deno.test("AC7: lintDesignDoc fails when Revision History table lists rows newest-first", () => {
  const doc = `# Title

## What it is
Content.

## Revision History

| Version | Date | Summary |
|---|---|---|
| 2.0.0 | 2026-09-02 | Major update |
| 1.0.0 | 2026-08-16 | Initial |

## Both surfaces
Parity.

## Load-bearing premises
| # | Premise | Proof |
|---|---|---|
| 1 | P1 | Verified in code |
`;
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) =>
    v.rule === "invalid-revision-history-table" && v.message.includes("newest-first")
  );
  assertEquals(Boolean(violation), true);
});

Deno.test("AC9: lintDesignDoc fails when banned prose appears inside Revision History summary cell", () => {
  const doc = `# Title

## What it is
Content.

## Revision History

| Version | Date | Summary |
|---|---|---|
| 1.0.0 | 2026-08-16 | An earlier version said we would use MySQL. |

## Both surfaces
Parity.

## Load-bearing premises
| # | Premise | Proof |
|---|---|---|
| 1 | P1 | Verified in code |
`;
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) => v.rule === "no-revision-narration");
  assertEquals(Boolean(violation), true);
});

// --- Copied text between design documents ("One document owns each rule", web-jam-tools#1636) ---

const COPIED_LINE =
  "The lookup debounces typing and asks the backend with a key only the server holds and returns the exact position";

function buildCompliantDesignDoc(
  bodySection: string,
  extraOptions: { premisesProse?: string; appendixSection?: string } = {},
): string {
  const premisesProse = extraOptions.premisesProse ? `${extraOptions.premisesProse}\n\n` : "";
  const appendixSection = extraOptions.appendixSection ? `\n${extraOptions.appendixSection}\n` : "";
  return `# Test Feature Design

## What it is
${bodySection}

## Both surfaces
| Mechanism | Claude Code | agy | Codex |
|---|---|---|---|
| Runner | deno task | identical | identical |

## Load-bearing Premises
${premisesProse}| Premise | Proof | Proved |
|---|---|---|
| Local filesystem is readable | Verified via Deno.readDirSync in unit test | ${TODAY} |
${appendixSection}`;
}

async function withTempDesignRoot(
  fn: (root: string, otherDocPath: string) => Promise<void> | void,
  options: { inAppendixOnly?: boolean; underResumeRecords?: boolean } = {},
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "lint-doc-copied-text-" });
  try {
    const folder = options.underResumeRecords ? "resume-records" : "Token_Savings";
    const dir = path.join(root, folder);
    await Deno.mkdir(dir, { recursive: true });
    const otherDocPath = path.join(dir, "other-design-2026-08-23.md");
    const otherContent = options.inAppendixOnly
      ? buildCompliantDesignDoc("Distinct body text that shares nothing.", {
        appendixSection: `## Appendix B — What Josh Asked For, Verbatim\n\n${COPIED_LINE}`,
      })
      : buildCompliantDesignDoc(COPIED_LINE);
    await Deno.writeTextFile(otherDocPath, otherContent);
    await fn(root, otherDocPath);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

Deno.test(
  "Copied text between design documents: the same line, in its body -> fail, naming the other document and the words",
  async () => {
    await withTempDesignRoot(async (root, otherDocPath) => {
      const checkedPath = path.join(root, "Token_Savings", "checked-design-2026-08-23.md");
      const doc = buildCompliantDesignDoc(COPIED_LINE);
      await Deno.writeTextFile(checkedPath, doc);

      const result = lintDesignDoc(doc, checkedPath, { dropboxDir: root });
      assertEquals(result.valid, false);
      const violation = result.violations.find((v) => v.rule === "no-copied-text");
      assertEquals(Boolean(violation), true);
      assertStringIncludes(violation!.message, otherDocPath);
      assertStringIncludes(violation!.message, checkedPath);
      assertStringIncludes(violation!.message, COPIED_LINE);

      const prevRoot = Deno.env.get("DESIGN_DOCS_ROOT");
      Deno.env.set("DESIGN_DOCS_ROOT", root);
      try {
        const exitCode = await runCli(["lint-doc", checkedPath]);
        assertEquals(exitCode, 1);
      } finally {
        if (prevRoot === undefined) Deno.env.delete("DESIGN_DOCS_ROOT");
        else Deno.env.set("DESIGN_DOCS_ROOT", prevRoot);
      }
    });
  },
);

Deno.test(
  "Copied text between design documents: the first 11 words of that line, in its body -> pass",
  async () => {
    await withTempDesignRoot((root) => {
      const first11Words = COPIED_LINE.split(" ").slice(0, 11).join(" ");
      const doc = buildCompliantDesignDoc(first11Words);
      const result = lintDesignDoc(doc, "checked-design.md", { dropboxDir: root });
      assertEquals(result.valid, true);
      assertEquals(result.violations.length, 0);
    });
  },
);

Deno.test(
  "Copied text between design documents: the same line with the case changed and a comma added -> fail — case and punctuation are ignored",
  async () => {
    await withTempDesignRoot((root, otherDocPath) => {
      const alteredLine =
        "THE LOOKUP DEBOUNCES TYPING, and asks the backend with a key, only the server holds and returns the exact position.";
      const doc = buildCompliantDesignDoc(alteredLine);
      const result = lintDesignDoc(doc, "checked-design.md", { dropboxDir: root });
      assertEquals(result.valid, false);
      const violation = result.violations.find((v) => v.rule === "no-copied-text");
      assertEquals(Boolean(violation), true);
      assertStringIncludes(violation!.message, otherDocPath);
      assertStringIncludes(
        violation!.message.toLowerCase(),
        "the lookup debounces typing",
      );
    });
  },
);

Deno.test(
  "Copied text between design documents: the same line in a > quote -> pass",
  async () => {
    await withTempDesignRoot((root) => {
      const doc = buildCompliantDesignDoc(`> ${COPIED_LINE}`);
      const result = lintDesignDoc(doc, "checked-design.md", { dropboxDir: root });
      assertEquals(result.valid, true);
    });
  },
);

Deno.test(
  "Copied text between design documents: the same line inside a fenced code block -> pass",
  async () => {
    await withTempDesignRoot((root) => {
      const doc = buildCompliantDesignDoc(`\`\`\`text\n${COPIED_LINE}\n\`\`\``);
      const result = lintDesignDoc(doc, "checked-design.md", { dropboxDir: root });
      assertEquals(result.valid, true);
    });
  },
);

Deno.test(
  "Copied text between design documents: the same line in double quotes -> pass",
  async () => {
    await withTempDesignRoot((root) => {
      const doc = buildCompliantDesignDoc(`"${COPIED_LINE}"`);
      const result = lintDesignDoc(doc, "checked-design.md", { dropboxDir: root });
      assertEquals(result.valid, true);
    });
  },
);

Deno.test(
  "Copied text between design documents: the same line under ## Load-bearing Premises -> pass",
  async () => {
    await withTempDesignRoot((root) => {
      const doc = buildCompliantDesignDoc("Distinct body content.", {
        premisesProse: COPIED_LINE,
        appendixSection:
          `## Where Things Live\n\n${COPIED_LINE}\n\n## Decision Record\n\n${COPIED_LINE}`,
      });
      const result = lintDesignDoc(doc, "checked-design.md", { dropboxDir: root });
      assertEquals(result.valid, true);
    });
  },
);

Deno.test(
  "Copied text between design documents: the same line under ## Appendix B — What Josh Asked For, Verbatim -> pass",
  async () => {
    await withTempDesignRoot((root) => {
      const doc = buildCompliantDesignDoc(
        `Distinct body content.\n\n<svg><text>${COPIED_LINE}</text></svg>`,
        {
          appendixSection:
            `## Appendix B — What Josh Asked For, Verbatim\n\n### Context\n\n${COPIED_LINE}`,
        },
      );
      const result = lintDesignDoc(doc, "checked-design.md", { dropboxDir: root });
      assertEquals(result.valid, true);
    });
  },
);

Deno.test(
  "Copied text between design documents: a pointer naming the other document's path in backticks and its section in double quotes -> pass",
  async () => {
    await withTempDesignRoot((root, otherDocPath) => {
      const pointerLine = `See \`${otherDocPath}\` ("${COPIED_LINE}") for the rule.`;
      const doc = buildCompliantDesignDoc(pointerLine);
      const result = lintDesignDoc(doc, "checked-design.md", { dropboxDir: root });
      assertEquals(result.valid, true);
    });
  },
);

Deno.test(
  "Copied text between design documents: the same line where the other design holds it only in its appendix -> pass",
  async () => {
    await withTempDesignRoot(
      (root) => {
        const doc = buildCompliantDesignDoc(COPIED_LINE);
        const result = lintDesignDoc(doc, "checked-design.md", { dropboxDir: root });
        assertEquals(result.valid, true);
      },
      { inAppendixOnly: true },
    );
  },
);

Deno.test(
  "Copied text between design documents: the checked document is the other design itself -> pass — a document is not compared with itself",
  async () => {
    await withTempDesignRoot(async (root, otherDocPath) => {
      const content = await Deno.readTextFile(otherDocPath);
      const result = lintDesignDoc(content, otherDocPath, { dropboxDir: root });
      assertEquals(result.valid, true);
    });
  },
);

Deno.test(
  "Copied text between design documents: another design cannot be read -> refuse, naming it",
  async () => {
    await withTempDesignRoot(async (root, otherDocPath) => {
      const checkedPath = path.join(root, "Token_Savings", "checked-design-2026-08-23.md");
      await Deno.writeTextFile(checkedPath, buildCompliantDesignDoc("Distinct body content."));
      await Deno.chmod(otherDocPath, 0o000);
      try {
        await assertRejects(
          () => lintDesignDocFile(checkedPath, { dropboxDir: root }),
          Error,
          otherDocPath,
        );

        const errors: string[] = [];
        const origError = console.error;
        console.error = (...args: unknown[]) => errors.push(args.join(" "));
        try {
          const exitCode = await runCli(["lint-doc", checkedPath], { dropboxDir: root });
          assertEquals(exitCode, 1);
        } finally {
          console.error = origError;
        }
        assertStringIncludes(errors.join("\n"), otherDocPath);
      } finally {
        await Deno.chmod(otherDocPath, 0o644);
      }
    });
  },
);

Deno.test(
  "Copied text between design documents: a file under resume-records/ holds the line -> pass — not a design document",
  async () => {
    await withTempDesignRoot(
      (root) => {
        const doc = buildCompliantDesignDoc(COPIED_LINE);
        const result = lintDesignDoc(doc, "checked-design.md", { dropboxDir: root });
        assertEquals(result.valid, true);
      },
      { underResumeRecords: true },
    );
  },
);

// --- Exclusions the copied-text check must honour exactly (review of the first head) ---

function passesAgainstOtherDoc(bodySection: string, valid: boolean): Promise<void> {
  return withTempDesignRoot((root) => {
    const result = lintDesignDoc(buildCompliantDesignDoc(bodySection), "checked-design.md", {
      dropboxDir: root,
    });
    // Only the copied-text rule is judged: other rules track fences their own way.
    assertEquals(
      result.violations.some((v) => v.rule === "no-copied-text"),
      !valid,
      JSON.stringify(result.violations),
    );
  });
}

Deno.test(
  "Copied text between design documents: the same line inside a multi-line <div> -> pass — raw HTML is left out",
  async () => {
    await passesAgainstOtherDoc(`<div>\n${COPIED_LINE}\n</div>`, true);
    await passesAgainstOtherDoc(
      `<details>\n<summary>More</summary>\n${COPIED_LINE}\n</details>`,
      true,
    );
    await passesAgainstOtherDoc(`<div><div>inner</div>\n${COPIED_LINE}\n</div>`, true);
  },
);

Deno.test(
  "Copied text between design documents: the same line after a closed <div> and after an unclosed <div>'s blank line -> fail",
  async () => {
    await passesAgainstOtherDoc(`<div>\nOther words.\n</div>\n\n${COPIED_LINE}`, false);
    await passesAgainstOtherDoc(`<div>\nOther words.\n\n${COPIED_LINE}`, false);
  },
);

Deno.test(
  "Copied text between design documents: the same line in double quotes that hold a pipe -> pass",
  async () => {
    await passesAgainstOtherDoc(`"${COPIED_LINE} | Section title"`, true);
    await passesAgainstOtherDoc(`“${COPIED_LINE} | Section title”`, true);
  },
);

Deno.test(
  "Copied text between design documents: a four-backtick fence holding a three-backtick line -> the contents stay left out until the real close",
  async () => {
    const nested = "````md\n```\n" + COPIED_LINE + "\n````";
    await passesAgainstOtherDoc(nested, true);
    await passesAgainstOtherDoc(`${nested}\n\n${COPIED_LINE}`, false);
  },
);

Deno.test(
  "Copied text between design documents: a tilde line inside a backtick fence does not close it, and the next prose is still compared",
  async () => {
    await passesAgainstOtherDoc("```text\n~~~\n" + COPIED_LINE + "\n```", true);
    await passesAgainstOtherDoc("```text\nCode.\n```\n\n" + COPIED_LINE, false);
  },
);
