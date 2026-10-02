// test/design_issue_lint_doc_proved_date.test.ts — web-jam-tools#1025
//
// The '## Load-bearing premises' table's 'Proved' column: every row must carry a same-day (or
// later) ISO date recording when that row's proof was last actually run, so Gate 1 cannot assert
// in the present tense that a premise proved on an earlier day is proven today. The column is
// located by header name, never by position. "Today" is injectable via lintDesignDoc's `nowImpl`
// option (this repo's existing `xImpl` dependency-injection convention) so these tests are
// deterministic regardless of wall-clock time; the production path (CLI, Gate 1) never passes it
// and always uses the real clock — the last test below proves that directly.

import { assertEquals } from "@std/assert";
import { lintDesignDoc } from "../src/design-issue/lint_doc.ts";

const FIXED_TODAY = "2026-09-16";
const FIXED_NOW = () => new Date(`${FIXED_TODAY}T12:00:00Z`);

function docWithPremisesTable(tableBlock: string): string {
  return `# Title

## What it is
A description of the feature.

## Both surfaces
Parity details across Claude Code, agy, and Codex.

## Load-bearing premises
${tableBlock}
`;
}

function lineNumOf(doc: string, needle: string): number {
  return doc.split("\n").findIndex((l) => l.includes(needle)) + 1;
}

Deno.test("lintDesignDoc: a premises table with a valid same-day Proved date on every row passes", () => {
  const doc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| P1 | Proof one | ${FIXED_TODAY} |
| P2 | Proof two | ${FIXED_TODAY} |`,
  );

  const result = lintDesignDoc(doc, "test.md", { nowImpl: FIXED_NOW });
  assertEquals(result.valid, true, JSON.stringify(result.violations));
  assertEquals(result.violations.length, 0);
});

Deno.test("lintDesignDoc: a missing Proved column fails", () => {
  const doc = docWithPremisesTable(
    `| Premise | Proof |
|---|---|
| P1 | Proof one |`,
  );

  const result = lintDesignDoc(doc, "test.md", { nowImpl: FIXED_NOW });
  assertEquals(result.valid, false);

  const violation = result.violations.find((v) =>
    v.rule === "load-bearing-premises-missing-proved-column"
  );
  assertEquals(Boolean(violation), true, JSON.stringify(result.violations));
  assertEquals(violation?.message.includes("no 'Proved' column"), true);
});

Deno.test("lintDesignDoc: an empty Proved cell fails, naming the line and the premise text", () => {
  const doc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| P1 needs a real date | Proof one |  |`,
  );
  const rowLineNum = lineNumOf(doc, "P1 needs a real date");

  const result = lintDesignDoc(doc, "test.md", { nowImpl: FIXED_NOW });
  assertEquals(result.valid, false);

  const violation = result.violations.find((v) =>
    v.rule === "load-bearing-premises-stale-proof" && v.line === rowLineNum
  );
  assertEquals(Boolean(violation), true, JSON.stringify(result.violations));
  assertEquals(violation?.message.includes("P1 needs a real date"), true);
  assertEquals(violation?.message.includes(String(rowLineNum)), true);
});

Deno.test("lintDesignDoc: a malformed Proved cell fails, naming the line and the premise text", () => {
  const doc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| P2 has a bad date | Proof two | not-a-date |`,
  );
  const rowLineNum = lineNumOf(doc, "P2 has a bad date");

  const result = lintDesignDoc(doc, "test.md", { nowImpl: FIXED_NOW });
  assertEquals(result.valid, false);

  const violation = result.violations.find((v) =>
    v.rule === "load-bearing-premises-stale-proof" && v.line === rowLineNum
  );
  assertEquals(Boolean(violation), true, JSON.stringify(result.violations));
  assertEquals(violation?.message.includes("P2 has a bad date"), true);
  assertEquals(violation?.message.includes("not-a-date"), true);
});

Deno.test("lintDesignDoc: an impossible calendar date (e.g. Feb 30) is treated as malformed", () => {
  const doc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| P2b has an impossible date | Proof two-b | 2026-02-30 |`,
  );
  const rowLineNum = lineNumOf(doc, "P2b has an impossible date");

  const result = lintDesignDoc(doc, "test.md", { nowImpl: FIXED_NOW });
  assertEquals(result.valid, false);

  const violation = result.violations.find((v) =>
    v.rule === "load-bearing-premises-stale-proof" && v.line === rowLineNum
  );
  assertEquals(Boolean(violation), true, JSON.stringify(result.violations));
});

Deno.test("lintDesignDoc: an earlier-dated Proved cell fails, naming the line, the premise text, the recorded date, and today's date", () => {
  const doc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| P3 was proved yesterday | Proof three | 2026-09-15 |`,
  );
  const rowLineNum = lineNumOf(doc, "P3 was proved yesterday");

  const result = lintDesignDoc(doc, "test.md", { nowImpl: FIXED_NOW });
  assertEquals(result.valid, false);

  const violation = result.violations.find((v) =>
    v.rule === "load-bearing-premises-stale-proof" && v.line === rowLineNum
  );
  assertEquals(Boolean(violation), true, JSON.stringify(result.violations));
  assertEquals(violation?.message.includes("P3 was proved yesterday"), true);
  assertEquals(violation?.message.includes("2026-09-15"), true);
  assertEquals(violation?.message.includes(FIXED_TODAY), true);
});

Deno.test("lintDesignDoc: a Proved date matching today passes (same-day is the pass condition)", () => {
  const doc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| P4 was proved today | Proof four | ${FIXED_TODAY} |`,
  );

  const result = lintDesignDoc(doc, "test.md", { nowImpl: FIXED_NOW });
  assertEquals(result.valid, true, JSON.stringify(result.violations));
});

Deno.test("lintDesignDoc: the Proved column is located by header name, not by position", () => {
  const doc = docWithPremisesTable(
    `| Proved | Premise | Proof |
|---|---|---|
| ${FIXED_TODAY} | P5 | Proof five |`,
  );

  const result = lintDesignDoc(doc, "test.md", { nowImpl: FIXED_NOW });
  assertEquals(result.valid, true, JSON.stringify(result.violations));
});

Deno.test("lintDesignDoc: without an nowImpl override, the production path uses the real current date", () => {
  const today = new Date().toISOString().slice(0, 10);
  const doc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| P6 | Proof six | ${today} |`,
  );

  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true, JSON.stringify(result.violations));

  const staleDoc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| P7 was proved on a fixed past date | Proof seven | 2020-01-01 |`,
  );
  const staleResult = lintDesignDoc(staleDoc, "test.md");
  assertEquals(staleResult.valid, false);
  const violation = staleResult.violations.find((v) =>
    v.rule === "load-bearing-premises-stale-proof"
  );
  assertEquals(Boolean(violation), true, JSON.stringify(staleResult.violations));
});

Deno.test("lintDesignDoc: today's local calendar date always passes without timezone false positives", () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const localToday = `${y}-${m}-${d}`;

  const doc = docWithPremisesTable(
    `| Premise | Proof | Proved |
|---|---|---|
| P8 proved today locally | Proof eight | ${localToday} |`,
  );

  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true, JSON.stringify(result.violations));
});
