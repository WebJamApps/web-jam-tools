// test/design_issue_lint_plan.test.ts — web-jam-tools#796
//
// Unit tests for Gate 2 plan-table cell validation: missing values, unknown model tiers
// (including markdown-wrapped and case-variant forms), unknown repos (including bare vs.
// owner-prefixed), personal-name title prefixes (including markdown-hidden), out-of-range
// priorities, unpaired/composite Josh manual rows, uncited cross-repo children, unproven Tests
// cells, deno.json task registration, and the four repo-wide gates. One test per acceptance-
// criteria case (13 cases, web-jam-tools#796).

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { parsePlanTable } from "../src/design-issue/plan_table.ts";
import {
  checkGate1ApprovalRecord,
  checkNeedsDesignRemovals,
  findNarrowedDirective,
  type IssueBodyFetcher,
  lintPlanTableFile as lintPlanFile,
  parseNeedsDesignRemovals,
  type PlanTableViolation,
  runLintPlanCli as lintPlanCli,
  validatePlanTable,
} from "../src/design-issue/lint_plan.ts";
import {
  approveGate1Record,
  getGate1RecordPath,
  openGate1Record,
} from "../src/design-issue/gate1_record.ts";
import type { Schema } from "../src/fix-labels/diff.ts";
import { ACTIVE_REPOS } from "../src/shared/repos.ts";
import denoJson from "../deno.json" with { type: "json" };
import type { CommandRunner, OpenIssueSummary } from "../hooks/lib/detect_duplicate_issue.ts";

// File/CLI tests never call the workstation's gh or use the live backlog.
const emptyOpenIssues: CommandRunner = () => Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
function lintPlanTableFile(file: string, options?: Parameters<typeof lintPlanFile>[1]) {
  return lintPlanFile(file, { runGh: emptyOpenIssues, ...options });
}
function runLintPlanCli(args: string[], options?: Parameters<typeof lintPlanCli>[1]) {
  return lintPlanCli(args, {
    runGh: emptyOpenIssues,
    renderDesignDocFileImpl: () => {},
    openBrowserImpl: () => Promise.resolve(),
    noOpen: options?.openBrowserImpl ? false : true,
    ...options,
  });
}

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
    { name: "Sol", hex: "006B75", repos: "all", modelTier: true },
    { name: "Opus", hex: "B392F0", repos: "all", modelTier: true },
    { name: "Flash", hex: "E67E22", repos: "all", modelTier: true },
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
  "| 1 | Coordinate plan validation delivery | - | Opus | High | web-jam-tools | Unit tests covering every validator rule | all children close |";
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
    title: "Reject missing model tiers",
    epicChild: "Epic #1",
    tier: "Flash",
    priority: "High",
    repo: "web-jam-tools",
    tests: "Unit tests, one per acceptance criterion",
    closes: "PR merges",
    ...overrides,
  };
  return `| 2 | ${c.title} | ${c.epicChild} | ${c.tier} | ${c.priority} | ${c.repo} | ${c.tests} | ${c.closes} |`;
}

// Duplicate-title acceptance fixtures (web-jam-tools#1356).
const PUSH_TITLE =
  "scripts/push: post the fix comment with the push and sign it with the model the tool recorded";
const MODEL_TITLE = "scripts/running-model: print the model the tool recorded for the session";
const REWORDED_MODEL_TITLE = "scripts/running-model: print which model this session is running on";
const FIX_PR_TITLE = "skills/fix-pr: add the skill and install it on Claude Code, agy and Codex";

function duplicateRow(
  title: string,
  id = 1,
  repo = "web-jam-tools",
  tier = "Flash",
  epic = "Epic #1",
): string {
  return `| ${id} | ${title} | ${epic} | ${tier} | Medium | ${repo} | Unit tests cover each acceptance case | PR merges |`;
}

function issueRunner(issues: OpenIssueSummary[]): CommandRunner {
  return (args) => {
    assertEquals(args, [
      "api",
      "repos/WebJamApps/web-jam-tools/issues?state=open&per_page=100&page=1",
    ]);
    return Promise.resolve({ code: 0, stdout: JSON.stringify(issues), stderr: "" });
  };
}

async function lintDuplicateRows(rows: string[], runGh: CommandRunner) {
  const file = await Deno.makeTempFile({ suffix: ".md" });
  try {
    await Deno.writeTextFile(file, planTableDoc(rows));
    return await lintPlanTableFile(file, { schema: TEST_SCHEMA, runGh });
  } finally {
    await Deno.remove(file);
  }
}

Deno.test("duplicate titles: open look-alikes, rewording, exact existing rows, and closed issues", async (t) => {
  const cases = [
    {
      name: "recorded-model look-alike refuses",
      title: MODEL_TITLE,
      open: PUSH_TITLE,
      fails: true,
    },
    {
      name: "different-work rewording passes",
      title: REWORDED_MODEL_TITLE,
      open: PUSH_TITLE,
      fails: false,
    },
    { name: "exact existing issue passes", title: FIX_PR_TITLE, open: FIX_PR_TITLE, fails: false },
    {
      name: "nearly equal fix-pr title refuses",
      title: "skills/fix-pr: add the skill and install it on Claude Code and Codex",
      open: FIX_PR_TITLE,
      fails: true,
    },
    // The runner asserts state=open above; a closed look-alike is absent from that listing.
    { name: "closed look-alike passes", title: MODEL_TITLE, open: null, fails: false },
  ];
  for (const c of cases) {
    await t.step(c.name, async () => {
      const result = await lintDuplicateRows(
        [duplicateRow(c.title)],
        issueRunner(c.open ? [{ number: 137, title: c.open }] : []),
      );
      assertEquals(result.valid, !c.fails);
      if (c.fails) {
        assertEquals(result.violations.length, 1);
        const violation = result.violations[0];
        assertEquals(violation.rule, "duplicate-title");
        assertEquals(violation.line, 7);
        assertEquals(violation.column, "Proposed title");
        assertStringIncludes(violation.message, `web-jam-tools#137 "${c.open}"`);
      } else {
        assertEquals(result.violations, []);
      }
    });
  }
});

Deno.test("duplicate titles: new plan rows cite both look-alikes, and rewording passes", async () => {
  const first =
    "skills/backlog-groom: check Priority against the spread, with a focus milestone named for the run";
  const second =
    "Manual verification: run backlog-groom with a focus and approve its first Priority batch";
  const result = await lintDuplicateRows(
    [duplicateRow(first), duplicateRow(second, 2, "web-jam-tools", "Josh")],
    issueRunner([]),
  );
  assertEquals(result.valid, false);
  assertEquals(result.violations.map((v) => [v.rule, v.line]), [
    ["duplicate-title", 7],
    ["duplicate-title", 8],
  ]);
  assertStringIncludes(result.violations[0].message, `plan row 2 (web-jam-tools) "${second}"`);
  assertStringIncludes(result.violations[1].message, `plan row 1 (web-jam-tools) "${first}"`);

  const reworded = await lintDuplicateRows([
    duplicateRow(first),
    duplicateRow(
      "Manual verification: approve the first batch of proposed levels from a focused groom run",
      2,
      "web-jam-tools",
      "Josh",
    ),
  ], issueRunner([]));
  assertEquals(reworded.valid, true);
  assertEquals(reworded.violations, []);
});

Deno.test("duplicate titles: exact existing row stays a candidate for a different new row", async () => {
  const newTitle = "skills/fix-pr: add the skill and install it on Claude Code and Codex";
  const result = await lintDuplicateRows(
    [
      duplicateRow(FIX_PR_TITLE),
      duplicateRow(newTitle, 2),
    ],
    issueRunner([{ number: 42, title: FIX_PR_TITLE }, {
      number: 43,
      title: newTitle + " tomorrow",
    }]),
  );
  assertEquals(result.violations.length, 1);
  assertEquals(result.violations[0].line, 8);
  assertStringIncludes(result.violations[0].message, `web-jam-tools#42 "${FIX_PR_TITLE}"`);
  assertStringIncludes(result.violations[0].message, `web-jam-tools#43 "${newTitle} tomorrow"`);
});

Deno.test("duplicate titles: fewer than three significant tokens and an empty plan never fetch", async () => {
  const unexpectedFetch: CommandRunner = () => {
    throw new Error("short/empty plans must not call gh");
  };
  for (const rows of [[], [duplicateRow("Fix the typo")]]) {
    const result = await lintDuplicateRows(rows, unexpectedFetch);
    assertEquals(result.valid, true);
    assertEquals(result.violations, []);
  }
});

Deno.test("duplicate titles: fetch each row's repository once, even with owner/markdown wrappers", async () => {
  const requests: string[][] = [];
  const runner: CommandRunner = (args) => {
    requests.push(args);
    const title = args[1].includes("/JaMmusic/") ? MODEL_TITLE : PUSH_TITLE;
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify([{ number: 99, title }]),
      stderr: "",
    });
  };
  const result = await lintDuplicateRows([
    duplicateRow(MODEL_TITLE),
    duplicateRow(FIX_PR_TITLE, 2, "`WebJamApps/web-jam-tools`"),
    duplicateRow("Arrange guitar chord positions", 3, "JaMmusic"),
  ], runner);
  assertEquals(requests, [
    ["api", "repos/WebJamApps/web-jam-tools/issues?state=open&per_page=100&page=1"],
    ["api", "repos/WebJamApps/JaMmusic/issues?state=open&per_page=100&page=1"],
  ]);
  assertEquals(result.violations.length, 1);
  assertStringIncludes(result.violations[0].message, `web-jam-tools#99 "${PUSH_TITLE}"`);
});

Deno.test("duplicate titles: failed or incomplete listings refuse and name the repository", async (t) => {
  const failures: [string, CommandRunner][] = [
    ["gh nonzero", () => Promise.resolve({ code: 1, stdout: "", stderr: "offline" })],
    ["runner throws", () => {
      throw new Error("gh unavailable");
    }],
    ["invalid listing", () => Promise.resolve({ code: 0, stdout: "{}", stderr: "" })],
    ["later page fails", (args) => {
      if (args[1].endsWith("page=1")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify(
            Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: PUSH_TITLE })),
          ),
          stderr: "",
        });
      }
      return Promise.resolve({ code: 1, stdout: "", stderr: "rate limited" });
    }],
  ];
  for (const [name, runner] of failures) {
    await t.step(name, async () => {
      const requests: string[][] = [];
      const result = await lintDuplicateRows([duplicateRow(MODEL_TITLE, 1, "JaMmusic")], (args) => {
        requests.push(args);
        return runner(args);
      });
      assertEquals(
        requests,
        (name === "later page fails" ? [1, 2] : [1]).map((page) => [
          "api",
          `repos/WebJamApps/JaMmusic/issues?state=open&per_page=100&page=${page}`,
        ]),
      );
      assertEquals(result.valid, false);
      assertEquals(result.violations.length, 1);
      assertEquals(result.violations[0].rule, "duplicate-title-search-failed");
      assertStringIncludes(
        result.violations[0].message,
        "could not run or finish for WebJamApps/JaMmusic",
      );
    });
  }
});

Deno.test("duplicate titles: CLI forwards the injected runner and refuses despite approved Gate 1", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const doc = `${dir}/design.md`;
    const plan = `${dir}/plan.md`;
    await Deno.writeTextFile(doc, "# Design\n");
    await Deno.writeTextFile(plan, planTableDoc([duplicateRow(MODEL_TITLE)]));
    await openGate1Record(doc, "# Design\n", { stateDir: dir });
    await approveGate1Record(doc, "Gate 1 approved by Josh.", { stateDir: dir });
    const output: string[] = [];
    const errors: string[] = [];
    const code = await runLintPlanCli([plan, "--design-doc", doc, "--state-dir", dir, "--json"], {
      schema: TEST_SCHEMA,
      runGh: issueRunner([{ number: 137, title: PUSH_TITLE }]),
      log: (line) => output.push(line),
      errorLog: (line) => errors.push(line),
    });
    assertEquals(code, 1);
    assertEquals(errors, []);
    const result = JSON.parse(output.join("\n"));
    assertEquals(result.valid, false);
    assertEquals(result.violations.length, 1);
    assertStringIncludes(result.violations[0].message, `web-jam-tools#137 "${PUSH_TITLE}"`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

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

Deno.test("lint-plan applies the shared plan reader and pair rule without an escalation column", () => {
  for (const tier of ["Sonnet / Sol", "Sol / Sonnet", "Sonnet/Sol", "**Sonnet  /  Sol**"]) {
    assertEquals(validate(planTableDoc([EPIC_ROW, childRow({ tier })])), [], tier);
  }
  for (
    const tier of [
      "Sonnet / Flash",
      "Sol / Opus",
      "Sol / Sonnet / Opus",
      "Sonnet / Bogus",
      "Sonnet / ",
    ]
  ) {
    assertEquals(
      findRule(validate(planTableDoc([EPIC_ROW, childRow({ tier })])), "tier-unknown").length,
      1,
      tier,
    );
  }
});

Deno.test("resolveTierVocabulary: a schema that resolves to zero tiers throws rather than skipping validation", () => {
  const degradedSchema: Schema = {
    repoClasses: { frontend: [], other: [] },
    keep: {},
    milestoneTopics: [],
    labels: [{ name: "Needs Design", hex: "000000", repos: "all" }],
  };
  const doc = planTableDoc([EPIC_ROW, childRow({ tier: "Sonnet" })]);
  const parsed = parsePlanTable(doc);
  if (parsed === null) throw new Error("test fixture has no plan table");
  let threw = false;
  try {
    validatePlanTable(parsed, { schema: degradedSchema, activeRepos: ACTIVE_REPOS });
  } catch {
    threw = true;
  }
  assertEquals(threw, true, "expected an empty resolved vocabulary to throw, not skip");
});

Deno.test("validatePlanTable: an omitted schema skips tier validation entirely (no throw)", () => {
  const doc = planTableDoc([EPIC_ROW, childRow({ tier: "NotARealTier" })]);
  const parsed = parsePlanTable(doc);
  if (parsed === null) throw new Error("test fixture has no plan table");
  const violations = validatePlanTable(parsed, { activeRepos: ACTIVE_REPOS });
  assertEquals(findRule(violations, "tier-unknown").length, 0);
});

// --- 3. Markdown-wrapped tier still validates ---

Deno.test("AC3: a tier wrapped in backticks or bold still validates correctly", () => {
  const cases = ["`Flash`", "**Flash**", "**`Flash`**", "_Flash_"];
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

// --- 10. Epic requirement and cross-repo epics (web-jam-tools#1398) ---

Deno.test("AC4 (#1398): a non-epic row whose Epic / child of cell is empty or none is reported as row-missing-epic", () => {
  const emptyCellDoc = planTableDoc([
    EPIC_ROW,
    childRow({ epicChild: "" }),
  ]);
  const emptyViolations = findRule(validate(emptyCellDoc), "row-missing-epic");
  assertEquals(emptyViolations.length, 1);
  assertEquals(emptyViolations[0].column, "Epic / child of");

  const noneCellDoc = planTableDoc([
    EPIC_ROW,
    childRow({ epicChild: "none" }),
  ]);
  const noneViolations = findRule(validate(noneCellDoc), "row-missing-epic");
  assertEquals(noneViolations.length, 1);
  assertEquals(noneViolations[0].column, "Epic / child of");

  const upperNoneDoc = planTableDoc([
    EPIC_ROW,
    childRow({ epicChild: "None" }),
  ]);
  const upperNoneViolations = findRule(validate(upperNoneDoc), "row-missing-epic");
  assertEquals(upperNoneViolations.length, 1);

  for (const missing of ["-", "—", "n/a", "N/A", "Standalone issue", "standalone issue"]) {
    const doc = planTableDoc([
      EPIC_ROW,
      childRow({ epicChild: missing }),
    ]);
    const violations = findRule(validate(doc), "row-missing-epic");
    assertEquals(violations.length, 1, `expected row-missing-epic for "${missing}"`);
  }
});

Deno.test("AC4 (#1398): a non-epic row whose Epic / child of cell names an epic or plan row passes", () => {
  for (const epicChild of ["Epic #1", "row 1", "web-jam-tools#1355"]) {
    const doc = planTableDoc([
      EPIC_ROW,
      childRow({ epicChild }),
    ]);
    const violations = findRule(validate(doc), "row-missing-epic");
    assertEquals(violations.length, 0, `expected no row-missing-epic for "${epicChild}"`);
  }
});

Deno.test("a task mentioning an epic in its test description still requires a parent", () => {
  const doc = planTableDoc([
    EPIC_ROW,
    childRow({ epicChild: "none", tests: "Unit tests reject a task without an epic" }),
  ]);
  assertEquals(findRule(validate(doc), "row-missing-epic").length, 1);
});

Deno.test("cross-repo epic validation resolves qualified parent citations", () => {
  const title = "Coordinate cross-repo music features";
  const epic =
    `| 1 | ${title} | Epic | Opus | High | JaMmusic | Tests cover both child repositories | all children close |`;
  for (const prefix of ["", "Epic "]) {
    for (const repo of ["JaMmusic", "WebJamApps/JaMmusic"]) {
      const epicChild = `${prefix}${repo}#1355 "${title}"`;
      const doc = planTableDoc([
        epic,
        childRow({ epicChild, repo: "JaMmusic" }),
        childRow({ epicChild, repo: "web-jam-back", title: "Add backend audio routes" }),
      ]);
      assertEquals(
        findRule(validate(doc), "cross-repo-epic-not-in-web-jam-tools").length,
        1,
        epicChild,
      );
    }
  }
});

Deno.test("qualified parent citations do not match a different repository or owner", () => {
  const title = "Coordinate cross-repo music features";
  const epic =
    `| 1 | ${title} | Epic | Opus | High | JaMmusic | Tests cover both child repositories | all children close |`;
  for (const repo of ["AppersonAuto", "OtherOrg/JaMmusic"]) {
    const epicChild = `${repo}#1355 "${title}"`;
    const doc = planTableDoc([
      epic,
      childRow({ epicChild, repo: "JaMmusic" }),
      childRow({ epicChild, repo: "web-jam-back", title: "Add backend audio routes" }),
    ]);
    assertEquals(findRule(validate(doc), "cross-repo-epic-not-in-web-jam-tools").length, 0);
  }
});

Deno.test("AC5 (#1398): an Epic row whose children sit in more than one repo fails when Repo is not web-jam-tools", () => {
  const epicJaMmusic =
    "| 1 | Coordinate cross-repo music features | Epic | Opus | High | JaMmusic | Unit tests | all children close |";
  const doc = planTableDoc([
    epicJaMmusic,
    childRow({ epicChild: "row 1", repo: "JaMmusic" }),
    childRow({ epicChild: "row 1", repo: "web-jam-back", title: "Add backend audio routes" }),
  ]);
  const violations = findRule(validate(doc), "cross-repo-epic-not-in-web-jam-tools");
  assertEquals(violations.length, 1);
  assertEquals(violations[0].column, "Repo");
  assertStringIncludes(violations[0].message, "web-jam-tools");
});

Deno.test("AC5 (#1398): an Epic row whose children sit in more than one repo passes when Repo is web-jam-tools", () => {
  const doc = planTableDoc([
    EPIC_ROW, // repo: web-jam-tools
    childRow({ epicChild: "Epic #1", repo: "JaMmusic" }),
    childRow({ epicChild: "Epic #1", repo: "web-jam-back", title: "Add backend audio routes" }),
  ]);
  const violations = findRule(validate(doc), "cross-repo-epic-not-in-web-jam-tools");
  assertEquals(violations.length, 0);
});

Deno.test("AC5 (#1398): an Epic row whose children sit in a single repo passes when Repo matches that repo", () => {
  const epicJaMmusic =
    "| 1 | Coordinate single-repo music features | Epic | Opus | High | JaMmusic | Unit tests | all children close |";
  const doc = planTableDoc([
    epicJaMmusic,
    childRow({ epicChild: "row 1", repo: "JaMmusic" }),
    childRow({ epicChild: "row 1", repo: "JaMmusic", title: "Add frontend audio player" }),
  ]);
  const violations = findRule(validate(doc), "cross-repo-epic-not-in-web-jam-tools");
  assertEquals(violations.length, 0);
});

// --- 11. Tests cell with no statement of what proves the issue ---

Deno.test("AC11: a Tests cell naming only a testing kind, not what it proves, is reported", () => {
  for (
    const tests of [
      "yes",
      "Yes",
      "tests",
      "Tests",
      "y",
      "Y",
      "test",
      "unit tests",
      "Unit Tests",
      "unit test",
      "covered",
      "Covered",
    ]
  ) {
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
  const output: string[] = [];
  const code = await runLintPlanCli(["--help"], { log: (line) => output.push(line) });
  assertEquals(code, 0);
  assertStringIncludes(output.join("\n"), "new titles resembling open issues");
  assertStringIncludes(output.join("\n"), "other new");
  assertStringIncludes(output.join("\n"), "failed title listing refuses the plan");
});

Deno.test("runLintPlanCli: missing path argument exits with 1", async () => {
  const code = await runLintPlanCli([]);
  assertEquals(code, 1);
});

Deno.test("runLintPlanCli: non-existent document file exits with 1", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const fakeDoc = `${tmpDir}/fake-design.md`;
    await Deno.writeTextFile(fakeDoc, "# Design\n");
    const code = await runLintPlanCli([
      "/tmp/non-existent-plan-doc-12345.md",
      "--design-doc",
      fakeDoc,
      "--state-dir",
      tmpDir,
    ]);
    assertEquals(code, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("runLintPlanCli: valid document passes with exit code 0", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const planFile = `${tmpDir}/plan.md`;
    const designDoc = `${tmpDir}/design.md`;
    const designContent = "# Canonical Design\n";
    await Deno.writeTextFile(designDoc, designContent);

    const doc = planTableDoc([
      EPIC_ROW,
      childRow({ epicChild: "Epic #1" }),
      "| 3 | Manual verification: confirm validator output in Google Chrome | Epic #1 | Josh | Medium | web-jam-tools | none | Josh confirms he reviewed it |",
    ]);
    await Deno.writeTextFile(planFile, doc);

    await openGate1Record(designDoc, designContent, { stateDir: tmpDir });
    await approveGate1Record(designDoc, "Gate 1 approved by Josh.", { stateDir: tmpDir });

    const code = await runLintPlanCli([
      planFile,
      "--design-doc",
      designDoc,
      "--state-dir",
      tmpDir,
    ]);
    assertEquals(code, 0);

    const jsonCode = await runLintPlanCli([
      "--doc",
      planFile,
      "--design-doc",
      designDoc,
      "--state-dir",
      tmpDir,
      "--json",
    ]);
    assertEquals(jsonCode, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("runLintPlanCli: document with violations exits with code 1", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const planFile = `${tmpDir}/plan.md`;
    const designDoc = `${tmpDir}/design.md`;
    const designContent = "# Canonical Design\n";
    await Deno.writeTextFile(designDoc, designContent);

    const doc = planTableDoc([
      EPIC_ROW,
      childRow({ tier: "Flash-High" }),
    ]);
    await Deno.writeTextFile(planFile, doc);

    await openGate1Record(designDoc, designContent, { stateDir: tmpDir });
    await approveGate1Record(designDoc, "Gate 1 approved by Josh.", { stateDir: tmpDir });

    const code = await runLintPlanCli([
      planFile,
      "--design-doc",
      designDoc,
      "--state-dir",
      tmpDir,
    ]);
    assertEquals(code, 1);

    const jsonCode = await runLintPlanCli([
      "--json",
      planFile,
      "--design-doc",
      designDoc,
      "--state-dir",
      tmpDir,
    ]);
    assertEquals(jsonCode, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// --- Needs Design removals: "Not resolved" must not narrow the issue's own directive
// (web-jam-tools#1131). The fixtures reproduce the Gate 2 plan that parked part of
// web-jam-tools#485 "new skill record-song" as "not resolved" instead of designing it. ---

const ISSUE_485_BODY = "new skill record-song\n" +
  "knows how to use reaper mcp\n" +
  "knows how to setup things based on previous recordings\n";
const NARROWED_FIXTURE =
  new URL("./fixtures/design-issue/plan-needs-design-narrowed.md", import.meta.url).pathname;
const RESOLVED_FIXTURE =
  new URL("./fixtures/design-issue/plan-needs-design-resolved.md", import.meta.url).pathname;

function stubBodies(bodies: Record<string, string>): IssueBodyFetcher {
  return (repo, number) => {
    const body = bodies[`${repo}#${number}`];
    return body === undefined
      ? Promise.reject(new Error(`no such issue ${repo}#${number}`))
      : Promise.resolve(body);
  };
}

function removalsDoc(item: string): string {
  return `${planTableDoc([EPIC_ROW])}\n## Needs Design label removals\n\n1. ${item}\n`;
}

Deno.test("#1131: parseNeedsDesignRemovals reads the issue and its Not resolved part", async () => {
  const removals = parseNeedsDesignRemovals(await Deno.readTextFile(NARROWED_FIXTURE));
  assertEquals(removals.length, 1);
  assertEquals(removals[0].repo, "web-jam-tools");
  assertEquals(removals[0].number, 485);
  assertEquals(
    removals[0].notResolved?.startsWith('"setup things based on previous recordings" is limited'),
    true,
  );
});

Deno.test("#1131: parseNeedsDesignRemovals joins a wrapped item and stops at the next heading", () => {
  const removals = parseNeedsDesignRemovals(
    "## Needs Design label removals\n\n" +
      '1. WebJamApps/JaMmusic#12 "t" — done.\n   Not resolved: the Android\n   surface. Remove the label?\n' +
      "\n## Dependency chain\n\n1. web-jam-tools#9 not a removal. Not resolved: x\n",
  );
  assertEquals(removals.length, 1);
  assertEquals(removals[0].repo, "WebJamApps/JaMmusic");
  assertEquals(removals[0].notResolved, "the Android surface.");
});

Deno.test("#1131: refuses a removal whose Not resolved part quotes the issue's directive line", async () => {
  const result = await lintPlanTableFile(NARROWED_FIXTURE, {
    schema: TEST_SCHEMA,
    fetchIssueBody: stubBodies({ "web-jam-tools#485": ISSUE_485_BODY }),
  });
  assertEquals(result.valid, false);
  const [v] = findRule(result.violations, "needs-design-directive-narrowed");
  assertEquals(v.line, 11);
  assertStringIncludes(v.message, "web-jam-tools#485");
  assertStringIncludes(v.message, '"knows how to setup things based on previous recordings"');
});

Deno.test("#1131: refuses a removal that narrows a directive line without quoting it", async () => {
  const violations = await checkNeedsDesignRemovals(
    removalsDoc(
      'web-jam-tools#485 "new skill record-song" — done. Not resolved: setup things based on ' +
        "previous recordings covers track layout only. Remove the label?",
    ),
    stubBodies({ "web-jam-tools#485": ISSUE_485_BODY }),
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0].rule, "needs-design-directive-narrowed");
});

Deno.test("#1131: passes the same plan when Not resolved says nothing", async () => {
  let fetched = 0;
  const result = await lintPlanTableFile(RESOLVED_FIXTURE, {
    schema: TEST_SCHEMA,
    fetchIssueBody: () => {
      fetched++;
      return Promise.resolve(ISSUE_485_BODY);
    },
  });
  assertEquals(result.violations, []);
  assertEquals(fetched, 0);
});

Deno.test("#1131: passes a Not resolved part that names nothing from the issue's directive", async () => {
  const violations = await checkNeedsDesignRemovals(
    removalsDoc(
      'web-jam-tools#485 "new skill record-song" — done. Not resolved: the agy surface\'s ' +
        "REAPER bridge, which a later design run owns. Remove the label?",
    ),
    stubBodies({ "web-jam-tools#485": ISSUE_485_BODY }),
  );
  assertEquals(violations, []);
});

Deno.test("#1131: fails closed, naming the issue, when its body cannot be read", async () => {
  const violations = await checkNeedsDesignRemovals(
    removalsDoc('web-jam-tools#485 "new skill record-song" — done. Not resolved: something.'),
    () => Promise.reject(new Error("HTTP 401: Bad credentials")),
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0].rule, "needs-design-issue-unreadable");
  assertStringIncludes(violations[0].message, "web-jam-tools#485");
  assertStringIncludes(violations[0].message, "Bad credentials");
});

Deno.test("#1131: findNarrowedDirective ignores quotes shorter than three words", () => {
  assertEquals(findNarrowedDirective('the "reaper mcp" bridge is deferred', ISSUE_485_BODY), null);
});

// --- Gate 1 approval verification before Gate 2 (web-jam-tools#1156) ---

Deno.test("AC1 (#1156): passes ONLY when Gate 1 disk record shows an approved, unchanged design doc; prints Gate 1 approval recorded line", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const planFile = `${tmpDir}/plan.md`;
    const designDoc = `${tmpDir}/design.md`;
    const designContent = "# Approved Design\n\nContent.\n";
    await Deno.writeTextFile(designDoc, designContent);

    const doc = planTableDoc([
      EPIC_ROW,
      childRow({ epicChild: "Epic #1" }),
      "| 3 | Manual verification: test in browser | Epic #1 | Josh | Medium | web-jam-tools | none | Josh confirms review |",
    ]);
    await Deno.writeTextFile(planFile, doc);

    await openGate1Record(designDoc, designContent, { stateDir: tmpDir });
    const replyText = "Approved with no changes.";
    await approveGate1Record(designDoc, replyText, { stateDir: tmpDir });

    const logs: string[] = [];
    const errLogs: string[] = [];
    const code = await runLintPlanCli(
      [planFile, "--design-doc", designDoc, "--state-dir", tmpDir],
      {
        log: (msg) => logs.push(msg),
        errorLog: (msg) => errLogs.push(msg),
        schema: TEST_SCHEMA,
      },
    );

    assertEquals(code, 0);
    assertEquals(errLogs.length, 0);
    const hasApprovalLine = logs.some((l) =>
      l.startsWith("Gate 1 approval recorded ") && l.endsWith(`: "${replyText}"`)
    );
    assertEquals(hasApprovalLine, true);
    assertEquals(logs.some((l) => l.includes("[design:lint-plan] PASS:")), true);

    // Direct checkGate1ApprovalRecord check
    const gate1Result = await checkGate1ApprovalRecord(designDoc, { stateDir: tmpDir });
    assertEquals(gate1Result.valid, true);
    assertEquals(gate1Result.status, "approved");
    assertEquals(gate1Result.reply, replyText);
    assertStringIncludes(gate1Result.approvalLine ?? "", replyText);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AC2 (#1156): refuses when --design-doc is omitted", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const planFile = `${tmpDir}/plan.md`;
    const doc = planTableDoc([EPIC_ROW, childRow({ epicChild: "Epic #1" })]);
    await Deno.writeTextFile(planFile, doc);

    const logs: string[] = [];
    const errLogs: string[] = [];
    const code = await runLintPlanCli([planFile], {
      log: (msg) => logs.push(msg),
      errorLog: (msg) => errLogs.push(msg),
      schema: TEST_SCHEMA,
    });

    assertEquals(code, 1);
    assertEquals(
      errLogs.some((l) => l.includes("Error: Missing required --design-doc argument.")),
      true,
    );

    // Direct checkGate1ApprovalRecord check
    const gate1Result = await checkGate1ApprovalRecord(undefined);
    assertEquals(gate1Result.valid, false);
    assertStringIncludes(gate1Result.error ?? "", "Missing required --design-doc argument");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AC3 (#1156): refuses when no record exists for the document", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const planFile = `${tmpDir}/plan.md`;
    const designDoc = `${tmpDir}/unpresented-design.md`;
    await Deno.writeTextFile(designDoc, "# Unpresented\n");
    const doc = planTableDoc([EPIC_ROW, childRow({ epicChild: "Epic #1" })]);
    await Deno.writeTextFile(planFile, doc);

    const logs: string[] = [];
    const errLogs: string[] = [];
    const code = await runLintPlanCli(
      [planFile, "--design-doc", designDoc, "--state-dir", tmpDir],
      {
        log: (msg) => logs.push(msg),
        errorLog: (msg) => errLogs.push(msg),
        schema: TEST_SCHEMA,
      },
    );

    assertEquals(code, 1);
    assertEquals(errLogs.some((l) => l.includes("No Gate 1 record exists for")), true);

    // Direct checkGate1ApprovalRecord check
    const gate1Result = await checkGate1ApprovalRecord(designDoc, { stateDir: tmpDir });
    assertEquals(gate1Result.valid, false);
    assertEquals(gate1Result.status, "not presented");
    assertStringIncludes(gate1Result.error ?? "", "No Gate 1 record exists for");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AC4 (#1156): refuses when record is open but never approved", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const planFile = `${tmpDir}/plan.md`;
    const designDoc = `${tmpDir}/open-design.md`;
    const designContent = "# Open Design\n";
    await Deno.writeTextFile(designDoc, designContent);
    const doc = planTableDoc([EPIC_ROW, childRow({ epicChild: "Epic #1" })]);
    await Deno.writeTextFile(planFile, doc);

    await openGate1Record(designDoc, designContent, { stateDir: tmpDir });

    const logs: string[] = [];
    const errLogs: string[] = [];
    const code = await runLintPlanCli(
      [planFile, "--design-doc", designDoc, "--state-dir", tmpDir],
      {
        log: (msg) => logs.push(msg),
        errorLog: (msg) => errLogs.push(msg),
        schema: TEST_SCHEMA,
      },
    );

    assertEquals(code, 1);
    assertEquals(
      errLogs.some((l) => l.includes("is open but has not been approved yet")),
      true,
    );

    // Direct checkGate1ApprovalRecord check
    const gate1Result = await checkGate1ApprovalRecord(designDoc, { stateDir: tmpDir });
    assertEquals(gate1Result.valid, false);
    assertEquals(gate1Result.status, "open");
    assertStringIncludes(gate1Result.error ?? "", "is open but has not been approved yet");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AC5 (#1156): refuses when document changed since approval (fingerprint mismatch)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const planFile = `${tmpDir}/plan.md`;
    const designDoc = `${tmpDir}/design.md`;
    const designContent = "# Approved Design Initial\n";
    await Deno.writeTextFile(designDoc, designContent);
    const doc = planTableDoc([EPIC_ROW, childRow({ epicChild: "Epic #1" })]);
    await Deno.writeTextFile(planFile, doc);

    await openGate1Record(designDoc, designContent, { stateDir: tmpDir });
    await approveGate1Record(designDoc, "Approved initially.", { stateDir: tmpDir });

    // Modify the design doc content
    await Deno.writeTextFile(designDoc, "# Approved Design Modified After Gate 1\n");

    const logs: string[] = [];
    const errLogs: string[] = [];
    const code = await runLintPlanCli(
      [planFile, "--design-doc", designDoc, "--state-dir", tmpDir],
      {
        log: (msg) => logs.push(msg),
        errorLog: (msg) => errLogs.push(msg),
        schema: TEST_SCHEMA,
      },
    );

    assertEquals(code, 1);
    assertEquals(
      errLogs.some((l) => l.includes("has changed since Gate 1 approval")),
      true,
    );

    // Direct checkGate1ApprovalRecord check
    const gate1Result = await checkGate1ApprovalRecord(designDoc, { stateDir: tmpDir });
    assertEquals(gate1Result.valid, false);
    assertEquals(gate1Result.status, "changed since approval");
    assertStringIncludes(gate1Result.error ?? "", "has changed since Gate 1 approval");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AC6 (#1156): refuses when record file cannot be read", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const planFile = `${tmpDir}/plan.md`;
    const designDoc = `${tmpDir}/design.md`;
    await Deno.writeTextFile(designDoc, "# Design Doc\n");
    const doc = planTableDoc([EPIC_ROW, childRow({ epicChild: "Epic #1" })]);
    await Deno.writeTextFile(planFile, doc);

    // Write a corrupt (unparseable) record file
    const absDocPath = path.resolve(designDoc);
    const recordPath = getGate1RecordPath(absDocPath, tmpDir);
    await Deno.writeTextFile(recordPath, "INVALID_CORRUPT_JSON{{{");

    const logs: string[] = [];
    const errLogs: string[] = [];
    const code = await runLintPlanCli(
      [planFile, "--design-doc", designDoc, "--state-dir", tmpDir],
      {
        log: (msg) => logs.push(msg),
        errorLog: (msg) => errLogs.push(msg),
        schema: TEST_SCHEMA,
      },
    );

    assertEquals(code, 1);
    assertEquals(
      errLogs.some((l) =>
        l.includes("Cannot parse Gate 1 record") || l.includes("Cannot read Gate 1 record")
      ),
      true,
    );

    // Direct checkGate1ApprovalRecord check
    const gate1Result = await checkGate1ApprovalRecord(designDoc, { stateDir: tmpDir });
    assertEquals(gate1Result.valid, false);
    assertStringIncludes(gate1Result.error ?? "", "Cannot parse Gate 1 record");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AC7 (#1156): refuses when design document cannot be read", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const planFile = `${tmpDir}/plan.md`;
    const doc = planTableDoc([EPIC_ROW, childRow({ epicChild: "Epic #1" })]);
    await Deno.writeTextFile(planFile, doc);

    const nonExistentDesignDoc = `${tmpDir}/non-existent-doc-9999.md`;

    const logs: string[] = [];
    const errLogs: string[] = [];
    const code = await runLintPlanCli(
      [planFile, "--design-doc", nonExistentDesignDoc, "--state-dir", tmpDir],
      {
        log: (msg) => logs.push(msg),
        errorLog: (msg) => errLogs.push(msg),
        schema: TEST_SCHEMA,
      },
    );

    assertEquals(code, 1);
    assertEquals(
      errLogs.some((l) => l.includes("Cannot read design document at")),
      true,
    );

    // Direct checkGate1ApprovalRecord check
    const gate1Result = await checkGate1ApprovalRecord(nonExistentDesignDoc, { stateDir: tmpDir });
    assertEquals(gate1Result.valid, false);
    assertStringIncludes(gate1Result.error ?? "", "Cannot read design document at");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// --- HTML rendering and Chrome opening (AC6 #1398) ---

Deno.test("AC6 (#1398): passing runLintPlanCli renders <plan>.html and opens in Chrome", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const planFile = `${tmpDir}/plan.md`;
    const designDoc = `${tmpDir}/design.md`;
    const designContent = "# Approved Design\n";
    await Deno.writeTextFile(designDoc, designContent);
    const doc = planTableDoc([EPIC_ROW, childRow({ epicChild: "Epic #1" })]);
    await Deno.writeTextFile(planFile, doc);

    await openGate1Record(designDoc, designContent, { stateDir: tmpDir });
    await approveGate1Record(designDoc, "Approved.", { stateDir: tmpDir });

    let renderedInput = "";
    let renderedOutput = "";
    let openedHtml = "";
    let openedDisplay: string | undefined = undefined;

    const code = await runLintPlanCli(
      [planFile, "--design-doc", designDoc, "--state-dir", tmpDir],
      {
        schema: TEST_SCHEMA,
        renderDesignDocFileImpl: (inPath, outPath) => {
          renderedInput = inPath;
          renderedOutput = outPath;
        },
        openBrowserImpl: (htmlPath, display) => {
          openedHtml = htmlPath;
          openedDisplay = display;
          return Promise.resolve();
        },
      },
    );

    assertEquals(code, 0);
    assertEquals(renderedInput, planFile);
    assertEquals(renderedOutput, `${tmpDir}/plan.html`);
    assertEquals(openedHtml, `${tmpDir}/plan.html`);
    assertEquals(openedDisplay, undefined);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AC6 (#1398): passing runLintPlanCli with --no-open renders <plan>.html but skips browser open", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const planFile = `${tmpDir}/plan.md`;
    const designDoc = `${tmpDir}/design.md`;
    const designContent = "# Approved Design\n";
    await Deno.writeTextFile(designDoc, designContent);
    const doc = planTableDoc([EPIC_ROW, childRow({ epicChild: "Epic #1" })]);
    await Deno.writeTextFile(planFile, doc);

    await openGate1Record(designDoc, designContent, { stateDir: tmpDir });
    await approveGate1Record(designDoc, "Approved.", { stateDir: tmpDir });

    let rendered = false;
    let opened = false;

    const code = await runLintPlanCli(
      [planFile, "--design-doc", designDoc, "--state-dir", tmpDir, "--no-open"],
      {
        schema: TEST_SCHEMA,
        renderDesignDocFileImpl: () => {
          rendered = true;
        },
        openBrowserImpl: () => {
          opened = true;
          return Promise.resolve();
        },
      },
    );

    assertEquals(code, 0);
    assertEquals(rendered, true);
    assertEquals(opened, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AC6 (#1398): passing runLintPlanCli prints warning and exits 0 when Chrome is unavailable", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const planFile = `${tmpDir}/plan.md`;
    const designDoc = `${tmpDir}/design.md`;
    const designContent = "# Approved Design\n";
    await Deno.writeTextFile(designDoc, designContent);
    const doc = planTableDoc([EPIC_ROW, childRow({ epicChild: "Epic #1" })]);
    await Deno.writeTextFile(planFile, doc);

    await openGate1Record(designDoc, designContent, { stateDir: tmpDir });
    await approveGate1Record(designDoc, "Approved.", { stateDir: tmpDir });

    const errLogs: string[] = [];

    const code = await runLintPlanCli(
      [planFile, "--design-doc", designDoc, "--state-dir", tmpDir],
      {
        schema: TEST_SCHEMA,
        errorLog: (msg) => errLogs.push(msg),
        renderDesignDocFileImpl: () => {},
        openBrowserImpl: () => {
          return Promise.reject(new Error("google-chrome: command not found"));
        },
      },
    );

    assertEquals(code, 0);
    assertEquals(
      errLogs.some((l) => l.includes("Warning") && l.includes("Google Chrome is unavailable")),
      true,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AC6 (#1398): failing plan writes and opens nothing", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const planFile = `${tmpDir}/plan.md`;
    const designDoc = `${tmpDir}/design.md`;
    const designContent = "# Approved Design\n";
    await Deno.writeTextFile(designDoc, designContent);
    // Missing epic in child row
    const doc = planTableDoc([EPIC_ROW, childRow({ epicChild: "none" })]);
    await Deno.writeTextFile(planFile, doc);

    await openGate1Record(designDoc, designContent, { stateDir: tmpDir });
    await approveGate1Record(designDoc, "Approved.", { stateDir: tmpDir });

    let rendered = false;
    let opened = false;

    const code = await runLintPlanCli(
      [planFile, "--design-doc", designDoc, "--state-dir", tmpDir],
      {
        schema: TEST_SCHEMA,
        renderDesignDocFileImpl: () => {
          rendered = true;
        },
        openBrowserImpl: () => {
          opened = true;
          return Promise.resolve();
        },
      },
    );

    assertEquals(code, 1);
    assertEquals(rendered, false);
    assertEquals(opened, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("lint-plan CLI warns when Chrome is absent using the real browser launcher", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const binDir = path.join(tmpDir, "bin");
    await Deno.mkdir(binDir);
    await Deno.symlink("/bin/bash", path.join(binDir, "bash"));
    await Deno.writeTextFile(path.join(binDir, "gh"), "#!/bin/bash\nprintf '[]\\n'\n", {
      mode: 0o755,
    });
    const planFile = path.join(tmpDir, "plan.md");
    const designDoc = path.join(tmpDir, "design.md");
    const designContent = "# Approved Design\n";
    await Deno.writeTextFile(designDoc, designContent);
    await Deno.writeTextFile(planFile, planTableDoc([EPIC_ROW, childRow()]));
    await openGate1Record(designDoc, designContent, { stateDir: tmpDir });
    await approveGate1Record(designDoc, "Approved.", { stateDir: tmpDir });

    const repoDir = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--cached-only",
        "--config",
        path.join(repoDir, "deno.json"),
        "-A",
        path.join(repoDir, "src/design-issue/cli.ts"),
        "lint-plan",
        planFile,
        "--design-doc",
        designDoc,
        "--state-dir",
        tmpDir,
      ],
      env: { PATH: binDir },
      stdout: "piped",
      stderr: "piped",
    }).output();

    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    assertEquals(result.code, 0, stderr);
    assertStringIncludes(stdout, "[design:lint-plan] PASS:");
    assertStringIncludes(stderr, "Warning: Google Chrome is unavailable");
    assertEquals((await Deno.stat(path.join(tmpDir, "plan.html"))).isFile, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
