// test/design_issue_lint_plan.test.ts — web-jam-tools#796
//
// Unit tests for Gate 2 plan-table cell validation: missing values, unknown model tiers
// (including markdown-wrapped and case-variant forms), unknown repos (including bare vs.
// owner-prefixed), personal-name title prefixes (including markdown-hidden), out-of-range
// priorities, unpaired/composite Josh manual rows, uncited cross-repo children, unproven Tests
// cells, deno.json task registration, and the four repo-wide gates. One test per acceptance-
// criteria case (13 cases, web-jam-tools#796).

import { assertEquals, assertRejects } from "@std/assert";
import { parsePlanTable } from "../src/design-issue/plan_table.ts";
import {
  lintPlanTableFile,
  type PlanTableViolation,
  runLintPlanCli,
  validatePlanTable,
} from "../src/design-issue/lint_plan.ts";
import type { Schema } from "../src/fix-labels/diff.ts";
import { ACTIVE_REPOS } from "../src/flash-issues/types.ts";
import denoJson from "../deno.json" with { type: "json" };

const HEADER_LINE =
  "| # | Proposed title | Epic / child of | Model tier | Priority | Repo | Tests | Closes when |";
const ALIGNMENT_LINE = "|---|---|---|---|---|---|---|---|";

function planTableDoc(rows: string[]): string {
  return `# Plan\n\n## Phase 2\n\n${HEADER_LINE}\n${ALIGNMENT_LINE}\n${rows.join("\n")}\n`;
}

/** A minimal, deterministic model-tier schema -- decoupled from the live labels.yaml file so
 * these unit tests never drift with real-world label edits. Mirrors labels.yaml's shape: five
 * `modelTier: true` entries, plus `Josh` present but NOT modelTier (exactly as labels.yaml has
 * it -- Josh is a status label the plan table's Manual Steps convention reuses as a tier value). */
const TEST_SCHEMA: Schema = {
  repoClasses: { frontend: [], other: [] },
  keep: {},
  milestoneTopics: [],
  labels: [
    { name: "Haiku", hex: "0E8A16", repos: "all", modelTier: true },
    { name: "Sonnet", hex: "1D76DB", repos: "all", modelTier: true },
    { name: "Opus", hex: "B392F0", repos: "all", modelTier: true },
    { name: "Flash Med", hex: "FBCA04", repos: "all", modelTier: true },
    { name: "Flash High", hex: "E67E22", repos: "all", modelTier: true },
    { name: "Josh", hex: "795548", repos: "all" },
  ],
};

function validate(doc: string): PlanTableViolation[] {
  const parsed = parsePlanTable(doc);
  if (parsed === null) throw new Error("test fixture has no plan table");
  return validatePlanTable(parsed, { schema: TEST_SCHEMA, activeRepos: ACTIVE_REPOS });
}

function findRule(violations: PlanTableViolation[], rule: string): PlanTableViolation[] {
  return violations.filter((v) => v.rule === rule);
}

// A clean baseline epic + child row pair, reused (with mutations) by every test below so each
// test isolates exactly the one cell/case it targets.
const EPIC_ROW =
  "| 1 | Add design:lint-plan cell validation | - | Opus | High | web-jam-tools | Unit tests covering every validator rule | all children close |";
function childRow(overrides: Partial<{
  title: string;
  epicChild: string;
  tier: string;
  priority: string;
  repo: string;
  tests: string;
  closes: string;
}> = {}): string {
  const c = {
    title: "Add cell validators for design:lint-plan",
    epicChild: "Epic #1",
    tier: "Flash High",
    priority: "High",
    repo: "web-jam-tools",
    tests: "Unit tests, one per acceptance criterion",
    closes: "PR merges",
    ...overrides,
  };
  return `| 2 | ${c.title} | ${c.epicChild} | ${c.tier} | ${c.priority} | ${c.repo} | ${c.tests} | ${c.closes} |`;
}

// --- 1. Missing cell values ---

Deno.test("AC1: empty, whitespace-only, and -/—/N/A cells are all reported as missing", () => {
  const cases = ["", "   ", "-", "—", "N/A", "n/a"];
  for (const value of cases) {
    const doc = planTableDoc([EPIC_ROW, childRow({ tier: value })]);
    const violations = findRule(validate(doc), "cell-missing");
    assertEquals(
      violations.length,
      1,
      `expected exactly one cell-missing violation for tier value "${value}"`,
    );
    assertEquals(violations[0].column, "Model tier");
  }
});

// --- 2. Unknown model tier (including case variants) ---

Deno.test("AC2: a model tier absent from labels.yaml is reported, including case/hyphen variants", () => {
  const cases = ["Flash-High", "flash high", "FLASH HIGH", "Gemini Ultra"];
  for (const tier of cases) {
    const doc = planTableDoc([EPIC_ROW, childRow({ tier })]);
    const violations = findRule(validate(doc), "tier-unknown");
    assertEquals(violations.length, 1, `expected tier-unknown violation for "${tier}"`);
  }
});

// --- 3. Markdown-wrapped tier still validates ---

Deno.test("AC3: a tier wrapped in backticks or bold still validates correctly", () => {
  const cases = ["`Flash High`", "**Flash High**", "**`Flash High`**", "_Flash High_"];
  for (const tier of cases) {
    const doc = planTableDoc([EPIC_ROW, childRow({ tier })]);
    const violations = validate(doc);
    assertEquals(
      findRule(violations, "tier-unknown").length,
      0,
      `"${tier}" should not be reported unknown`,
    );
    assertEquals(findRule(violations, "cell-missing").length, 0);
  }
});

// --- 4. Unknown repo; bare vs. owner-prefixed accepted as the same repo ---

Deno.test("AC4: a repo absent from ACTIVE_REPOS is reported; WebJamApps/X and bare X are the same repo", () => {
  const badDoc = planTableDoc([EPIC_ROW, childRow({ repo: "SomeOtherRepo" })]);
  const badViolations = findRule(validate(badDoc), "repo-unknown");
  assertEquals(badViolations.length, 1);

  for (const repo of ["JaMmusic", "WebJamApps/JaMmusic"]) {
    const doc = planTableDoc([EPIC_ROW, childRow({ repo })]);
    const violations = findRule(validate(doc), "repo-unknown");
    assertEquals(violations.length, 0, `"${repo}" should be accepted`);
  }
});

// --- 5. Personal-name prefix in title ---

Deno.test("AC5: a personal-name prefix in a title is reported, with and without trailing space", () => {
  const cases = [
    "Josh: review the validator output",
    "josh: review the validator output",
    "JOSH: review the validator output",
    "Josh — review the validator output",
    "Josh - review the validator output",
    "Josh:review the validator output",
  ];
  for (const title of cases) {
    const doc = planTableDoc([EPIC_ROW, childRow({ title, tier: "Josh" })]);
    const violations = findRule(validate(doc), "title-personal-name-prefix");
    assertEquals(violations.length, 1, `expected personal-name violation for "${title}"`);
  }
});

// --- 6. Personal-name prefix hidden inside backticks or bold ---

Deno.test("AC6: a personal-name prefix hidden inside backticks or bold is still reported", () => {
  const cases = [
    "**Josh:** review the validator output",
    "`Josh:` review the validator output",
    "**Josh —** review the validator output",
  ];
  for (const title of cases) {
    const doc = planTableDoc([EPIC_ROW, childRow({ title, tier: "Josh" })]);
    const violations = findRule(validate(doc), "title-personal-name-prefix");
    assertEquals(violations.length, 1, `expected personal-name violation for "${title}"`);
  }
});

// --- 7. Priority outside native levels ---

Deno.test("AC7: a priority outside the native Priority levels is reported", () => {
  const cases = ["Critical", "P0", "medium", ""];
  for (const priority of cases) {
    const doc = planTableDoc([EPIC_ROW, childRow({ priority })]);
    const violations = validate(doc);
    const bad = findRule(violations, "priority-invalid");
    const missing = findRule(violations, "cell-missing").filter((v) => v.column === "Priority");
    assertEquals(
      bad.length + missing.length,
      1,
      `expected exactly one priority-related violation for "${priority}"`,
    );
  }

  for (const priority of ["Urgent", "High", "Medium", "Low"]) {
    const doc = planTableDoc([EPIC_ROW, childRow({ priority })]);
    assertEquals(findRule(validate(doc), "priority-invalid").length, 0, priority);
  }
});

// --- 8. Josh-labeled manual row with no paired agent row ---

Deno.test("AC8: a Josh-labeled manual row with no paired agent row is reported", () => {
  // Lone Josh row: no sibling row anywhere shares its "Epic / child of" parent.
  const doc = planTableDoc([
    "| 1 | Manual verification: confirm the CLI output | Epic #9 | Josh | Medium | web-jam-tools | none | Josh confirms he ran it |",
  ]);
  const violations = findRule(validate(doc), "josh-row-unpaired");
  assertEquals(violations.length, 1);
});

Deno.test("AC8 (paired case): a Josh row sharing its parent with a valid agent row is not reported", () => {
  const doc = planTableDoc([
    EPIC_ROW,
    childRow({ epicChild: "Epic #1" }),
    "| 3 | Manual verification: confirm the CLI output | Epic #1 | Josh | Medium | web-jam-tools | none | Josh confirms he ran it |",
  ]);
  const violations = findRule(validate(doc), "josh-row-unpaired");
  assertEquals(violations.length, 0);
});

// --- 9. Composite manual row (artifact/doc review + live walkthrough) ---

Deno.test("AC9: a composite manual row combining artifact/doc review with a live walkthrough is reported", () => {
  // The precedent case cited by skills/design-issue/SKILL.md itself (web-jam-tools#614/#622).
  const doc = planTableDoc([
    EPIC_ROW,
    childRow({ epicChild: "Epic #1" }),
    "| 3 | Manual verification: verify shoelace reference guide in Google Chrome | Epic #1 | Josh | Medium | web-jam-tools | none | Josh confirms he reviewed and taught the shoelace-tying walkthrough |",
  ]);
  const violations = findRule(validate(doc), "josh-row-composite");
  assertEquals(violations.length, 1);
});

Deno.test("AC9 (non-composite case): a single-surface Josh row is not reported composite", () => {
  const doc = planTableDoc([
    EPIC_ROW,
    childRow({ epicChild: "Epic #1" }),
    "| 3 | Manual verification: confirm validator output in Google Chrome | Epic #1 | Josh | Medium | web-jam-tools | none | Josh confirms he reviewed it |",
  ]);
  const violations = findRule(validate(doc), "josh-row-composite");
  assertEquals(violations.length, 0);
});

// --- 10. Cross-repo child not cited as repo#number "title" ---

Deno.test('AC10: a child row whose repo differs from the epic\'s and is not cited as repo#number "title" is reported', () => {
  const doc = planTableDoc([
    EPIC_ROW, // repo: web-jam-tools
    childRow({ epicChild: "Epic #1", repo: "JaMmusic" }), // cross-repo, cited only as "Epic #1"
  ]);
  const violations = findRule(validate(doc), "cross-repo-child-uncited");
  assertEquals(violations.length, 1);
});

Deno.test('AC10 (properly cited case): a cross-repo child cited as repo#number "title" is not reported', () => {
  const doc = planTableDoc([
    EPIC_ROW,
    childRow({
      epicChild: 'Epic web-jam-tools#793 "design-issue skill enhancements and fixes"',
      repo: "JaMmusic",
    }),
  ]);
  const violations = findRule(validate(doc), "cross-repo-child-uncited");
  assertEquals(violations.length, 0);
});

// --- 11. Tests cell with no statement of what proves the issue ---

Deno.test('AC11: a Tests cell saying only "yes" or "tests" is reported', () => {
  for (const tests of ["yes", "Yes", "tests", "Tests"]) {
    const doc = planTableDoc([EPIC_ROW, childRow({ tests })]);
    const violations = findRule(validate(doc), "tests-insufficient");
    assertEquals(violations.length, 1, `expected tests-insufficient violation for "${tests}"`);
  }

  const okDoc = planTableDoc([
    EPIC_ROW,
    childRow({ tests: "Unit tests assert each validator rule fires on its fixture" }),
  ]);
  assertEquals(findRule(validate(okDoc), "tests-insufficient").length, 0);
});

// --- 12. deno task design:lint-plan is registered in deno.json and runs from the repo root ---

Deno.test("AC12: design:lint-plan is registered in deno.json and its command runs the CLI's lint-plan subcommand", () => {
  const tasks = (denoJson as { tasks: Record<string, string> }).tasks;
  const task = tasks["design:lint-plan"];
  assertEquals(typeof task, "string");
  assertEquals(task.includes("src/design-issue/cli.ts"), true);
  assertEquals(task.includes("lint-plan"), true);
});

// --- 13. Repo-wide gates: sanity check that a fully clean plan table reports zero violations ---

Deno.test("AC13: a fully clean plan table (every rule satisfied) reports zero violations", () => {
  const doc = planTableDoc([
    EPIC_ROW,
    childRow({ epicChild: "Epic #1" }),
    "| 3 | Manual verification: confirm validator output in Google Chrome | Epic #1 | Josh | Medium | web-jam-tools | none | Josh confirms he reviewed it |",
  ]);
  const violations = validate(doc);
  assertEquals(violations, []);
});

Deno.test("AC13: lintPlanTableFile throws a clear error when the document has no plan table", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".md" });
  try {
    await Deno.writeTextFile(tmpFile, "# Just a heading\n\nNo table here.\n");
    await assertRejects(
      () => lintPlanTableFile(tmpFile),
      Error,
      "No Gate 2 plan table found",
    );
  } finally {
    await Deno.remove(tmpFile);
  }
});

// --- Malformed rows pass through as their own violation (not one of the 13 AC cases, but a
// direct consequence of consuming the parser's full output rather than dropping information). ---

Deno.test("malformed rows from the parser are surfaced as malformed-row violations", () => {
  const doc = planTableDoc([EPIC_ROW, "| 2 | Missing cells | Epic #1 |"]);
  const violations = findRule(validate(doc), "malformed-row");
  assertEquals(violations.length, 1);
});

// --- CLI Runner (runLintPlanCli) tests ---

Deno.test("runLintPlanCli: --help exits with 0", async () => {
  const code = await runLintPlanCli(["--help"]);
  assertEquals(code, 0);
});

Deno.test("runLintPlanCli: missing path argument exits with 1", async () => {
  const code = await runLintPlanCli([]);
  assertEquals(code, 1);
});

Deno.test("runLintPlanCli: non-existent document file exits with 1", async () => {
  const code = await runLintPlanCli(["/tmp/non-existent-plan-doc-12345.md"]);
  assertEquals(code, 1);
});

Deno.test("runLintPlanCli: valid document passes with exit code 0", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".md" });
  try {
    const doc = planTableDoc([
      EPIC_ROW,
      childRow({ epicChild: "Epic #1" }),
      "| 3 | Manual verification: confirm validator output in Google Chrome | Epic #1 | Josh | Medium | web-jam-tools | none | Josh confirms he reviewed it |",
    ]);
    await Deno.writeTextFile(tmpFile, doc);

    const code = await runLintPlanCli([tmpFile]);
    assertEquals(code, 0);

    const jsonCode = await runLintPlanCli(["--doc", tmpFile, "--json"]);
    assertEquals(jsonCode, 0);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("runLintPlanCli: document with violations exits with code 1", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".md" });
  try {
    const doc = planTableDoc([
      EPIC_ROW,
      childRow({ tier: "Flash-High" }),
    ]);
    await Deno.writeTextFile(tmpFile, doc);

    const code = await runLintPlanCli([tmpFile]);
    assertEquals(code, 1);

    const jsonCode = await runLintPlanCli(["--json", tmpFile]);
    assertEquals(jsonCode, 1);
  } finally {
    await Deno.remove(tmpFile);
  }
});
