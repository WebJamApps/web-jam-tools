// test/design_issue_lint_doc_premises_table_structure.test.ts
//
// Structural validation of the '## Load-bearing premises' table itself, distinct from the
// existing Proof-cell content checks: a missing/misplaced separator row, a table with no data
// rows, duplicate data rows, and ragged rows (a row whose cell count differs from the header's)
// must all fail the checker, naming the offending line number(s). A well-formed table must still
// pass, and a document missing the '## Load-bearing premises' section entirely must still fail as
// it did before this change.

import { assertEquals } from "@std/assert";
import { lintDesignDoc } from "../src/design-issue/lint_doc.ts";

// This suite tests table *structure*, not the Proved-date freshness rule (web-jam-tools#1025,
// covered in test/design_issue_lint_doc_proved_date.test.ts), so every fixture below carries a
// same-day Proved column to stay out of that rule's way.
const TODAY = new Date().toISOString().slice(0, 10);

function docWithPremisesTable(tableBlock: string): string {
  return `# Title

## What it is
A description of the feature.

## Both surfaces
Parity details.

## Load-bearing premises
${tableBlock}
`;
}

function violationsFor(doc: string, rule: string) {
  const result = lintDesignDoc(doc, "test.md");
  return result.violations.filter((v) => v.rule === rule);
}

Deno.test("lintDesignDoc: well-formed premises table passes (no false positive)", () => {
  const doc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| The runner exists as a deno task | Checked deno.json's tasks map | ${TODAY} |
| The CLI is wired into cli.ts | Read the dispatch table | ${TODAY} |`,
  );

  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("lintDesignDoc: separator row below two data rows fails and names the separator's line", () => {
  // Line-by-line, within the table block (relative), to compute the absolute line number:
  //   1: heading '## Load-bearing premises'
  //   2: header row
  //   3: data row 1
  //   4: data row 2
  //   5: separator row  <-- misplaced, should be line 2
  const doc = docWithPremisesTable(
    `| Premise | Proof |
| P1 | Proof one |
| P2 | Proof two |
|---|---|`,
  );

  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);

  const structural = violationsFor(doc, "load-bearing-premises-malformed-table");
  assertEquals(structural.length > 0, true);

  // The heading is line 9 of docWithPremisesTable's template (see helper), so the separator
  // (4th line of the table block) lands 4 lines after the heading. Rather than hardcode that,
  // compute it directly from the document text to keep this test robust to helper changes.
  const lines = doc.split("\n");
  const separatorLineNum = lines.findIndex((l) => l.trim() === "|---|---|") + 1;
  assertEquals(separatorLineNum > 0, true);

  const namesSeparatorLine = structural.some((v) => v.line === separatorLineNum);
  assertEquals(
    namesSeparatorLine,
    true,
    `Expected a violation naming line ${separatorLineNum} (the misplaced separator); got: ${
      JSON.stringify(structural)
    }`,
  );
});

Deno.test("lintDesignDoc: duplicate data rows fail and name both line numbers", () => {
  const doc = docWithPremisesTable(
    `| Premise | Proof |
|---|---|
| P1 | Proof one |
| P2 | Proof two |
| P1 | Proof one |
| P2 | Proof two |`,
  );

  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);

  const lines = doc.split("\n");
  const firstP1Line = lines.findIndex((l) => l.includes("| P1 | Proof one |")) + 1;
  const secondP1Line = lines.map((l, idx) => ({ l, idx }))
    .filter(({ l }) => l.includes("| P1 | Proof one |"))
    .map(({ idx }) => idx + 1)[1];

  const structural = violationsFor(doc, "load-bearing-premises-malformed-table");
  const dupViolation = structural.find((v) =>
    v.message.includes(`line ${firstP1Line}`) && v.message.includes(`line ${secondP1Line}`)
  );
  assertEquals(
    Boolean(dupViolation),
    true,
    `Expected a duplicate-row violation naming line ${firstP1Line} and line ${secondP1Line}; got: ${
      JSON.stringify(structural)
    }`,
  );
});

Deno.test("lintDesignDoc: a ragged row (wrong cell count) fails", () => {
  const doc = docWithPremisesTable(
    `| Premise | Proof |
|---|---|
| P1 | Proof one | Extra cell |`,
  );

  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);

  const structural = violationsFor(doc, "load-bearing-premises-malformed-table");
  const raggedViolation = structural.find((v) =>
    v.message.includes("cell(s)") && v.message.includes("expected 2")
  );
  assertEquals(Boolean(raggedViolation), true, JSON.stringify(structural));
});

Deno.test("lintDesignDoc: header and separator with no data rows fails", () => {
  const doc = docWithPremisesTable(
    `| Premise | Proof |
|---|---|`,
  );

  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);

  const structural = violationsFor(doc, "load-bearing-premises-malformed-table");
  const noDataViolation = structural.find((v) => v.message.includes("no data rows"));
  assertEquals(Boolean(noDataViolation), true, JSON.stringify(structural));
});

Deno.test("lintDesignDoc: a literal pipe inside a backtick code span in a cell is not a false-positive ragged row", () => {
  // GFM treats a code span as opaque when splitting a table row into cells, so a `|` inside
  // backticks needs no escaping (web-jam-llms/AI_Misbehaves/hooks-design-2026-09-15.md line 364
  // is a real document that hit this before splitTableRow learned to respect code spans).
  const doc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| The matcher is broad | Registered on \`Bash|mcp__.*\`; matches \`gh\` and \`git push\` too. | ${TODAY} |`,
  );

  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("lintDesignDoc: document missing the '## Load-bearing premises' section entirely still fails as before", () => {
  const doc = `# Title

## What it is
A description of the feature.

## Both surfaces
Parity details.
`;

  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);
  const violation = result.violations.find((v) =>
    v.rule === "require-load-bearing-premises-section"
  );
  assertEquals(Boolean(violation), true);
});
