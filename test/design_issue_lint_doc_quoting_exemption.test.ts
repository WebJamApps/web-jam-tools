// test/design_issue_lint_doc_quoting_exemption.test.ts — web-jam-tools#797
//
// A banned phrase that a document is quoting or naming (inline code span, straight quotes, or
// typographic/curly quotes) is a mention, not a use, and must not be flagged as a violation.
// Bare, unquoted prose must still violate — the guard must not weaken. Unclosed backticks or
// quotes must fail closed rather than silently exempting the rest of the line. Covers the three
// rules affected by the false positive: no-gate-or-approval-state, no-design-complete, and
// no-bare-decision-labels.

import { assertEquals } from "@std/assert";
import { lintDesignDoc } from "../src/design-issue/lint_doc.ts";

function docWith(line: string): string {
  return `# Title\n\n## What it is\n${line}\n\n## Both surfaces\nParity`;
}

function violationsFor(line: string, rule: string): number {
  const result = lintDesignDoc(docWith(line), "test.md");
  return result.violations.filter((v) => v.rule === rule).length;
}

// A representative bare-prose example for each of the three affected rules, used throughout.
const BARE_EXAMPLES: Record<string, string> = {
  "no-gate-or-approval-state": "Gate 1: Approved",
  "no-design-complete": "design complete",
  "no-bare-decision-labels": "per D-7",
};

// 1. Inline code span (backticks) is a mention, not a violation.
Deno.test("lintDesignDoc: banned phrase inside a backtick span is exempt (all three rules)", () => {
  for (const [rule, phrase] of Object.entries(BARE_EXAMPLES)) {
    const line = `The linter flags \`${phrase}\` as a banned phrase.`;
    assertEquals(violationsFor(line, rule), 0, `Expected no ${rule} violation for: ${line}`);
  }
});

// 2. Straight double quotes are a mention, not a violation.
Deno.test("lintDesignDoc: banned phrase inside straight double quotes is exempt (all three rules)", () => {
  for (const [rule, phrase] of Object.entries(BARE_EXAMPLES)) {
    const line = `The linter flags "${phrase}" as a banned phrase.`;
    assertEquals(violationsFor(line, rule), 0, `Expected no ${rule} violation for: ${line}`);
  }
});

// 3. Straight single quotes are a mention, not a violation.
Deno.test("lintDesignDoc: banned phrase inside straight single quotes is exempt (all three rules)", () => {
  for (const [rule, phrase] of Object.entries(BARE_EXAMPLES)) {
    const line = `The linter flags '${phrase}' as a banned phrase.`;
    assertEquals(violationsFor(line, rule), 0, `Expected no ${rule} violation for: ${line}`);
  }
});

// 4. Typographic/curly quotes are a mention, not a violation.
Deno.test("lintDesignDoc: banned phrase inside curly quotes is exempt (all three rules)", () => {
  for (const [rule, phrase] of Object.entries(BARE_EXAMPLES)) {
    const doubleLine = `The linter flags “${phrase}” as a banned phrase.`;
    assertEquals(
      violationsFor(doubleLine, rule),
      0,
      `Expected no ${rule} violation for curly double quotes: ${doubleLine}`,
    );

    const singleLine = `The linter flags ‘${phrase}’ as a banned phrase.`;
    assertEquals(
      violationsFor(singleLine, rule),
      0,
      `Expected no ${rule} violation for curly single quotes: ${singleLine}`,
    );
  }
});

// 5. Bare, unquoted prose still violates — the guard must not weaken.
Deno.test("lintDesignDoc: bare unquoted banned phrase still violates (all three rules)", () => {
  for (const [rule, phrase] of Object.entries(BARE_EXAMPLES)) {
    assertEquals(violationsFor(phrase, rule), 1, `Expected ${rule} violation for bare: ${phrase}`);
  }
});

// 6. Fenced code block exemption is preserved (existing behavior, unaffected by this change).
Deno.test("lintDesignDoc: banned phrase inside a fenced code block is still exempt", () => {
  const doc = `# Title

## What it is
Text before.

\`\`\`text
Gate 1: Approved
design complete
per D-7
\`\`\`

## Both surfaces
Parity
`;
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

// 7. A backtick span covering only part of the phrase still violates.
Deno.test("lintDesignDoc: a backtick span covering only part of the phrase still violates", () => {
  // Only "design" is inside backticks; "complete" is bare — the whole phrase is not fully
  // contained in the exempt range, so it must still be flagged.
  assertEquals(violationsFor("The `design` complete state.", "no-design-complete"), 1);
  assertEquals(violationsFor("The design `complete` state.", "no-design-complete"), 1);
  assertEquals(violationsFor("`Gate 1`: Approved", "no-gate-or-approval-state"), 1);
  assertEquals(violationsFor("per `D-7`", "no-bare-decision-labels"), 1);
});

// 8. Two banned phrases on one line, one quoted and one bare, report exactly one violation — the
// bare one.
Deno.test("lintDesignDoc: quoted mention plus bare use on one line reports exactly one violation", () => {
  const gateLine = 'We renamed away from "Gate 1: Approved" but Gate 1: Approved is still here.';
  const gateResult = lintDesignDoc(docWith(gateLine), "test.md");
  const gateViolations = gateResult.violations.filter((v) =>
    v.rule === "no-gate-or-approval-state"
  );
  assertEquals(gateViolations.length, 1);
  assertEquals(gateViolations[0].message.includes("Gate 1: Approved"), true);

  const designLine = 'The phrase "design complete" is banned; do not write design complete here.';
  const designResult = lintDesignDoc(docWith(designLine), "test.md");
  const designViolations = designResult.violations.filter((v) => v.rule === "no-design-complete");
  assertEquals(designViolations.length, 1);

  const labelLine = "We renamed away from `per D-7` but still decided per D-7.";
  const labelResult = lintDesignDoc(docWith(labelLine), "test.md");
  const labelViolations = labelResult.violations.filter((v) =>
    v.rule === "no-bare-decision-labels"
  );
  assertEquals(labelViolations.length, 1);
});

// 9. An unclosed backtick or unclosed quote fails closed (still violates) and never silently
// exempts the rest of the line.
Deno.test("lintDesignDoc: unclosed backtick fails closed — still violates", () => {
  // A single, unpaired backtick before the phrase must not exempt anything.
  assertEquals(violationsFor("` design complete", "no-design-complete"), 1);
  assertEquals(
    violationsFor("Gate 1: Approved and then a stray ` backtick.", "no-gate-or-approval-state"),
    1,
  );
});

Deno.test("lintDesignDoc: unclosed double quote fails closed — still violates", () => {
  assertEquals(violationsFor('" design complete', "no-design-complete"), 1);
  assertEquals(
    violationsFor('a stray " quote then Gate 1: Approved', "no-gate-or-approval-state"),
    1,
  );
});

Deno.test("lintDesignDoc: unclosed single quote fails closed — still violates", () => {
  assertEquals(violationsFor("' design complete", "no-design-complete"), 1);
  assertEquals(
    violationsFor("a stray ' quote then per D-7", "no-bare-decision-labels"),
    1,
  );
});

// 10. An escaped backtick or escaped quote inside the phrase is handled (not treated as a real
// delimiter, so it does not create a bogus exempt span).
Deno.test("lintDesignDoc: escaped backtick inside the phrase does not create a bogus exempt span", () => {
  // The escaped backtick (\`) is not a real delimiter, so nothing here is closed — the bare
  // phrase after it must still violate.
  const line = "An escaped \\` backtick precedes design complete in bare prose.";
  assertEquals(violationsFor(line, "no-design-complete"), 1);
});

Deno.test("lintDesignDoc: escaped quote inside the phrase does not create a bogus exempt span", () => {
  const line = 'An escaped \\" quote precedes Gate 1: Approved in bare prose.';
  assertEquals(violationsFor(line, "no-gate-or-approval-state"), 1);
});

Deno.test("lintDesignDoc: a real quoted mention survives an escaped quote earlier on the line", () => {
  // The escaped quote is not a delimiter; the two real straight quotes around the phrase still
  // pair up and exempt it.
  const line = 'An escaped \\" quote, then a real "design complete" mention.';
  assertEquals(violationsFor(line, "no-design-complete"), 0);
});

// 11. A quoted banned phrase inside a markdown table cell (pipes present) is still exempt.
Deno.test("lintDesignDoc: quoted banned phrase inside a markdown table cell is still exempt", () => {
  const line =
    "| `deno task design:lint-doc` | Flags a bare `Gate 1: Approved` state and \"design complete\" and 'per D-7' as violations. |";
  const result = lintDesignDoc(docWith(line), "test.md");
  assertEquals(result.violations.filter((v) => v.rule === "no-gate-or-approval-state").length, 0);
  assertEquals(result.violations.filter((v) => v.rule === "no-design-complete").length, 0);
  assertEquals(result.violations.filter((v) => v.rule === "no-bare-decision-labels").length, 0);
});

// 12. All three affected rules honor the exemption identically — a single mixed line exercising
// all three at once, entirely quoted/backticked, produces zero violations; the same line with
// the phrases bared produces three.
Deno.test("lintDesignDoc: all three affected rules honor the quoting exemption identically", () => {
  const quotedLine =
    "The linter mentions `Gate 1: Approved`, \"design complete\", and 'per D-7' as examples only.";
  const quotedResult = lintDesignDoc(docWith(quotedLine), "test.md");
  assertEquals(
    quotedResult.violations.filter((v) =>
      ["no-gate-or-approval-state", "no-design-complete", "no-bare-decision-labels"].includes(
        v.rule,
      )
    ).length,
    0,
  );

  const bareLine = "The linter flags Gate 1: Approved, design complete, and per D-7 for real.";
  const bareResult = lintDesignDoc(docWith(bareLine), "test.md");
  assertEquals(
    bareResult.violations.filter((v) => v.rule === "no-gate-or-approval-state").length,
    1,
  );
  assertEquals(bareResult.violations.filter((v) => v.rule === "no-design-complete").length, 1);
  assertEquals(
    bareResult.violations.filter((v) => v.rule === "no-bare-decision-labels").length,
    1,
  );
});

// Regression guard: apostrophes in ordinary prose must not be mistaken for quote delimiters and
// must not accidentally exempt a later bare banned phrase on the same line.
Deno.test("lintDesignDoc: an apostrophe in ordinary prose does not create a bogus exempt span", () => {
  const line = "The linter's own rules still flag Gate 1: Approved in bare prose.";
  assertEquals(violationsFor(line, "no-gate-or-approval-state"), 1);
});
