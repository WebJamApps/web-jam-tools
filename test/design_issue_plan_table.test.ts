// test/design_issue_plan_table.test.ts — web-jam-tools#795
//
// Unit tests for the Gate 2 plan-table parser: row splitting (leading/trailing pipes,
// escaped pipes, code spans, tab/space padding), alignment row recognition in all four
// forms, CRLF handling, fenced-code-block exclusion, header-based table identification
// among multiple tables, header-only tables, malformed row reporting, and blank-line/EOF
// table termination. One test per acceptance-criteria case.

import { assertEquals, assertRejects } from "@std/assert";
import * as path from "@std/path";
import {
  parsePlanTable,
  parsePlanTableFromFile,
  PLAN_TABLE_HEADER,
  splitTableRowCells,
} from "../src/design-issue/plan_table.ts";

const HEADER_LINE =
  "| # | Proposed title | Epic / child of | Model tier | Priority | Repo | Tests | Closes when |";
const ALIGNMENT_LINE = "|---|---|---|---|---|---|---|---|";
const DATA_LINE =
  "| 1 | Add a Gate 2 plan-table parser | Epic web-jam-tools#793 | Sonnet | High | web-jam-tools | Unit tests | PR merges |";

function planTableDoc(body: string): string {
  return `# Plan\n\n## Phase 2\n\n${HEADER_LINE}\n${ALIGNMENT_LINE}\n${body}\n`;
}

Deno.test("PLAN_TABLE_HEADER matches the Gate 2 plan table header in the skill body", () => {
  assertEquals(PLAN_TABLE_HEADER, [
    "#",
    "Proposed title",
    "Epic / child of",
    "Model tier",
    "Priority",
    "Repo",
    "Tests",
    "Closes when",
  ]);
});

// Case 1: rows with leading/trailing pipes AND rows without them.
Deno.test("splitTableRowCells parses rows with and without leading/trailing pipes", () => {
  assertEquals(splitTableRowCells("| a | b | c |"), ["a", "b", "c"]);
  assertEquals(splitTableRowCells("a | b | c"), ["a", "b", "c"]);
});

// Case 2: an escaped pipe inside a cell does not split the cell.
Deno.test("splitTableRowCells does not split on an escaped pipe", () => {
  assertEquals(splitTableRowCells("| foo \\| bar | baz |"), ["foo | bar", "baz"]);
});

// Case 3: a pipe inside an inline code span does not split the cell.
Deno.test("splitTableRowCells does not split on a pipe inside a code span", () => {
  assertEquals(splitTableRowCells("| `a|b` | c |"), ["`a|b`", "c"]);
  // Longer backtick run as the code-span delimiter.
  assertEquals(splitTableRowCells("| ``a|`b`` | c |"), ["``a|`b``", "c"]);
});

// Case 4: alignment rows in all forms, both spaced and unspaced.
Deno.test("parsePlanTable recognizes alignment rows in every form, unspaced", () => {
  const alignment = "|---|:---|---:|:---:|---|---|---|---|";
  const doc = `${HEADER_LINE}\n${alignment}\n${DATA_LINE}\n`;
  const result = parsePlanTable(doc);
  assertEquals(result?.rows.length, 1);
});

Deno.test("parsePlanTable recognizes alignment rows in every form, spaced", () => {
  const alignment = "| --- | :--- | ---: | :---: | --- | --- | --- | --- |";
  const doc = `${HEADER_LINE}\n${alignment}\n${DATA_LINE}\n`;
  const result = parsePlanTable(doc);
  assertEquals(result?.rows.length, 1);
});

// Case 5: CRLF line endings parse identically to LF.
Deno.test("parsePlanTable parses CRLF line endings identically to LF", () => {
  const lfDoc = planTableDoc(DATA_LINE);
  const crlfDoc = lfDoc.replace(/\n/g, "\r\n");

  const lfResult = parsePlanTable(lfDoc);
  const crlfResult = parsePlanTable(crlfDoc);

  assertEquals(crlfResult?.headerCells, lfResult?.headerCells);
  assertEquals(crlfResult?.rows, lfResult?.rows);
  assertEquals(crlfResult?.malformedRows, lfResult?.malformedRows);
});

// Case 6: tab and multi-space cell padding is stripped.
Deno.test("splitTableRowCells strips tab and multi-space cell padding", () => {
  assertEquals(splitTableRowCells("|\ta\t|   b   |"), ["a", "b"]);
});

// Case 7: a markdown table inside a fenced code block is NOT treated as the plan table.
Deno.test("parsePlanTable ignores a plan table that only appears inside a fenced code block", () => {
  const doc =
    `# Plan\n\nExample:\n\n\`\`\`\n${HEADER_LINE}\n${ALIGNMENT_LINE}\n${DATA_LINE}\n\`\`\`\n`;
  const result = parsePlanTable(doc);
  assertEquals(result, null);
});

// Case 8: when the document holds more than one table, the plan table is identified by its
// header row, not by position.
Deno.test("parsePlanTable identifies the plan table by header when another table precedes it", () => {
  const unrelatedTable = "| Name | Age |\n|---|---|\n| Alice | 30 |\n";
  const doc = `# Plan\n\n${unrelatedTable}\n${HEADER_LINE}\n${ALIGNMENT_LINE}\n${DATA_LINE}\n`;
  const result = parsePlanTable(doc);
  assertEquals(result?.headerCells, [...PLAN_TABLE_HEADER]);
  assertEquals(result?.rows.length, 1);
  assertEquals(result?.rows[0].cells[1], "Add a Gate 2 plan-table parser");
});

// Case 9: a header-only table with zero data rows is handled without error.
Deno.test("parsePlanTable handles a header-only table with zero data rows", () => {
  const doc = `${HEADER_LINE}\n${ALIGNMENT_LINE}\n`;
  const result = parsePlanTable(doc);
  assertEquals(result?.rows, []);
  assertEquals(result?.malformedRows, []);
});

// Case 10: a row with fewer or more cells than the header is reported as malformed rather
// than silently truncated or padded.
Deno.test("parsePlanTable reports rows with too few or too many cells as malformed, unmodified", () => {
  const shortRow = "| 1 | Only three cells | Epic |";
  const longRow = "| 2 | Ten cells total | a | b | c | d | e | f | g | h |";
  const doc = `${HEADER_LINE}\n${ALIGNMENT_LINE}\n${shortRow}\n${longRow}\n`;

  const result = parsePlanTable(doc);
  assertEquals(result?.rows.length, 0);
  assertEquals(result?.malformedRows.length, 2);

  const [short, long] = result!.malformedRows;
  assertEquals(short.expectedCellCount, 8);
  assertEquals(short.actualCellCount, 3);
  assertEquals(short.cells, ["1", "Only three cells", "Epic"]);

  assertEquals(long.expectedCellCount, 8);
  assertEquals(long.actualCellCount, 10);
  assertEquals(long.cells.length, 10);
});

// Case 11: a table terminated by a blank line and one terminated by EOF both parse.
Deno.test("parsePlanTable parses a table terminated by a blank line", () => {
  const doc =
    `${HEADER_LINE}\n${ALIGNMENT_LINE}\n${DATA_LINE}\n\nSome trailing prose that is not a row.\n`;
  const result = parsePlanTable(doc);
  assertEquals(result?.rows.length, 1);
});

Deno.test("parsePlanTable parses a table terminated by end of file", () => {
  const doc = `${HEADER_LINE}\n${ALIGNMENT_LINE}\n${DATA_LINE}`;
  const result = parsePlanTable(doc);
  assertEquals(result?.rows.length, 1);
});

// Extra coverage: no matching table anywhere in the document.
Deno.test("parsePlanTable returns null when no table matches the plan table header", () => {
  const doc = "# Plan\n\n| Name | Age |\n|---|---|\n| Alice | 30 |\n";
  const result = parsePlanTable(doc);
  assertEquals(result, null);
});

// Extra coverage: parsePlanTableFromFile reads and parses successfully.
Deno.test("parsePlanTableFromFile reads a plan table from disk", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "plan-table-test-" });
  const tmpPath = path.join(tmpDir, "plan.md");
  try {
    await Deno.writeTextFile(tmpPath, planTableDoc(DATA_LINE));
    const result = await parsePlanTableFromFile(tmpPath);
    assertEquals(result?.rows.length, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("parsePlanTableFromFile rejects on a missing file", async () => {
  await assertRejects(
    () => parsePlanTableFromFile("/tmp/does-not-exist-plan-table-795.md"),
    Error,
    "not found or cannot be read",
  );
});

Deno.test("parsePlanTableFromFile rejects on an empty path", async () => {
  await assertRejects(
    () => parsePlanTableFromFile(""),
    Error,
    "Plan document path is required",
  );
});
