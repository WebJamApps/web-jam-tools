// test/design_issue_lint_doc_citation_location.test.ts — web-jam-tools#1025 follow-up
//
// A design document records how the system works and what was decided — never GitHub issue/PR
// history. Josh's ruling, 2026-09-16: "please do not keep records of github issues in the design
// documents ... we have github itself and git itself to track issues, we do not need a third
// record to track issues that then becomes out of date, stale, and additional beauracracty and
// token waster." `deno task design:lint-doc` enforces this with a new BLOCKING rule,
// `no-issue-citation-outside-exempt-locations`: a design document fails if it contains an
// issue/PR citation anywhere other than the `## Revision History` table or a verbatim quote block
// (a markdown blockquote line, `> ...` — the one concrete convention this repo's design documents
// already use for Josh's own words). This suite pins the literal case list that citation form and
// exemption boundary were enumerated against.

import { assertEquals } from "@std/assert";
import { lintDesignDoc } from "../src/design-issue/lint_doc.ts";

const TODAY = new Date().toISOString().slice(0, 10);

/** A minimal document that already satisfies every other lint-doc rule (Both surfaces,
 * Load-bearing premises with a same-day Proved date), so each test below isolates the citation
 * rule rather than tripping an unrelated one. `body` is inserted after the premises table. */
function doc(body: string): string {
  return `# Title

## What it is
Text.

## Both surfaces
| Mechanism | Claude Code | agy | Codex |
|---|---|---|---|
| Runner | deno task | identical | identical |

## Load-bearing premises
| Premise | Proof | Proved |
|---|---|---|
| The runner exists as a deno task | Checked deno.json's tasks map | ${TODAY} |

${body}
`;
}

function citationViolations(result: ReturnType<typeof lintDesignDoc>) {
  return result.violations.filter((v) => v.rule === "no-issue-citation-outside-exempt-locations");
}

// --- Violations: citation forms outside any exempt location ---

Deno.test("citation-location: repo#N in a code span, outside Revision History or a quote, violates", () => {
  const result = lintDesignDoc(
    doc("The fix for this is `web-jam-tools#748` and it changed the resolver."),
    "test.md",
  );
  assertEquals(result.valid, false);
  const violations = citationViolations(result);
  assertEquals(violations.length, 1);
  assertEquals(violations[0].message.includes("web-jam-tools#748"), true);
});

Deno.test("citation-location: owner/repo#N (no title) outside any exempt location violates", () => {
  const result = lintDesignDoc(
    doc("See WebJamApps/web-jam-tools#1018 for the original report."),
    "test.md",
  );
  assertEquals(result.valid, false);
  const violations = citationViolations(result);
  assertEquals(violations.length, 1);
  assertEquals(violations[0].message.includes("WebJamApps/web-jam-tools#1018"), true);
});

Deno.test("citation-location: a GitHub issue URL inside a markdown link violates", () => {
  const result = lintDesignDoc(
    doc(
      "This was raised in [the epic](https://github.com/WebJamApps/web-jam-tools/issues/1025) directly.",
    ),
    "test.md",
  );
  assertEquals(result.valid, false);
  const violations = citationViolations(result);
  assertEquals(violations.length, 1);
  assertEquals(
    violations[0].message.includes("https://github.com/WebJamApps/web-jam-tools/issues/1025"),
    true,
  );
});

Deno.test("citation-location: a GitHub pull request URL violates the same way an issues URL does", () => {
  const result = lintDesignDoc(
    doc("Merged as https://github.com/WebJamApps/web-jam-tools/pull/1030 last week."),
    "test.md",
  );
  assertEquals(result.valid, false);
  const violations = citationViolations(result);
  assertEquals(violations.length, 1);
  assertEquals(
    violations[0].message.includes("https://github.com/WebJamApps/web-jam-tools/pull/1030"),
    true,
  );
});

Deno.test("citation-location: a bare #838 with no repo prefix violates", () => {
  const result = lintDesignDoc(
    doc("This bug was originally reported in #838 before the split."),
    "test.md",
  );
  assertEquals(result.valid, false);
  const violations = citationViolations(result);
  assertEquals(violations.length, 1);
  assertEquals(violations[0].message.includes("#838"), true);
});

Deno.test("citation-location: a citation inside a table cell outside Revision History violates", () => {
  const result = lintDesignDoc(
    doc(`## Appendix C — Decision record

| # | Decision | Outcome | Rejected alternatives |
|---|---|---|---|
| 1 | Which milestone | token-savings; web-jam-tools#724 moves into the same milestone | A new milestone |
`),
    "test.md",
  );
  assertEquals(result.valid, false);
  const violations = citationViolations(result);
  assertEquals(violations.length, 1);
  assertEquals(violations[0].message.includes("web-jam-tools#724"), true);
});

Deno.test("citation-location: multiple citations on one line each produce their own violation", () => {
  const result = lintDesignDoc(
    doc("Folded web-jam-tools#737 into web-jam-tools#808 during this run."),
    "test.md",
  );
  assertEquals(result.valid, false);
  const violations = citationViolations(result);
  assertEquals(violations.length, 2);
});

// --- Exemptions ---

Deno.test("citation-location: a citation inside a blockquote (verbatim quote) is exempt", () => {
  const result = lintDesignDoc(
    doc(`## Appendix B — What Josh asked for, verbatim

> Include this as part of the epic: https://github.com/WebJamApps/web-jam-tools/issues/724
`),
    "test.md",
  );
  assertEquals(result.valid, true, JSON.stringify(citationViolations(result)));
});

Deno.test("citation-location: a citation inside the ## Revision History table is exempt", () => {
  const result = lintDesignDoc(
    doc(`## Revision History

| Version | Date | Epic / Issue | Summary |
|---|---|---|---|
| 1.0.0 | ${TODAY} | [some epic](https://github.com/WebJamApps/web-jam-tools/issues/1025) | web-jam-tools#1025 initial design. |
`),
    "test.md",
  );
  assertEquals(result.valid, true, JSON.stringify(citationViolations(result)));
});

Deno.test("citation-location: a citation inside a code span INSIDE a blockquote stays exempt (blockquote, not code-span, drives the exemption)", () => {
  const result = lintDesignDoc(
    doc(`## Appendix B — What Josh asked for, verbatim

> fold \`web-jam-tools#737\` into the token-savings milestone
`),
    "test.md",
  );
  assertEquals(result.valid, true, JSON.stringify(citationViolations(result)));
});

// --- Must NOT match: syntax that looks like a citation but is not one ---

Deno.test("citation-location: a hex color like #fff does not match", () => {
  // A letter-bearing hex color never matches `\d+`. An all-numeric hex color (e.g. `#000000`) is a
  // documented, accepted false positive of the bare-number form — see CITATION_BARE_NUMBER_REGEX's
  // own comment in lint_doc.ts — and is deliberately not asserted here.
  const result = lintDesignDoc(
    doc("The header background is `#fff` on light mode, chosen over a darker accent."),
    "test.md",
  );
  assertEquals(citationViolations(result).length, 0, JSON.stringify(citationViolations(result)));
});

Deno.test("citation-location: a heading '# Title' does not match", () => {
  const result = lintDesignDoc(doc("# A New Section Heading\n\nSome text below it."), "test.md");
  assertEquals(citationViolations(result).length, 0, JSON.stringify(citationViolations(result)));
});

Deno.test("citation-location: a citation inside a fenced code block is skipped, matching the rest of this linter's convention", () => {
  const result = lintDesignDoc(
    doc('```text\nExample: web-jam-tools#999 "example only"\n```'),
    "test.md",
  );
  assertEquals(citationViolations(result).length, 0, JSON.stringify(citationViolations(result)));
});

// --- web-jam-tools#1097: Hex colour codes must NOT be flagged as issue citations ---

Deno.test("citation-location: hex colours (#475569, #334155, #166534, #1e1e24, #FEF2C0) are NOT flagged (web-jam-tools#1097 AC1)", () => {
  const hexColors = ["#475569", "#334155", "#166534", "#1e1e24", "#FEF2C0"];
  for (const color of hexColors) {
    const result = lintDesignDoc(
      doc(`The diagram uses colour ${color} for accents and borders.`),
      "test.md",
    );
    assertEquals(
      citationViolations(result).length,
      0,
      `Expected ${color} to not be flagged as an issue citation, got: ${
        JSON.stringify(citationViolations(result))
      }`,
    );
  }
});

Deno.test("citation-location: hex colours inside inline SVG diagrams are NOT flagged (web-jam-tools#1097 AC1)", () => {
  const svgBlock = `<svg width="200" height="100">
  <rect fill="#475569" stroke="#334155" width="50" height="50" />
  <path fill="#166534" d="M10 10" />
  <circle fill="#1e1e24" r="5" />
  <text fill="#FEF2C0">Diagram</text>
</svg>`;
  const result = lintDesignDoc(
    doc(svgBlock),
    "test.md",
  );
  assertEquals(
    citationViolations(result).length,
    0,
    `Expected inline SVG hex colours to not be flagged, got: ${
      JSON.stringify(citationViolations(result))
    }`,
  );
});

Deno.test("citation-location: valid issue citations (#881, repo#N, URL) STILL flagged (web-jam-tools#1097 AC2)", () => {
  const citations = [
    { text: "#881", snippet: "Reported in #881 earlier." },
    { text: "web-jam-tools#744", snippet: "See web-jam-tools#744 for the ticket." },
    { text: "web-jam-back#1052", snippet: "Couples with web-jam-back#1052 endpoint." },
    { text: "JaMmusic#1347", snippet: "Aligns with JaMmusic#1347 UI change." },
    {
      text: "https://github.com/WebJamApps/web-jam-tools/issues/744",
      snippet: "Full link: https://github.com/WebJamApps/web-jam-tools/issues/744 to check.",
    },
  ];
  for (const c of citations) {
    const result = lintDesignDoc(doc(c.snippet), "test.md");
    const violations = citationViolations(result);
    assertEquals(
      violations.length >= 1,
      true,
      `Expected ${c.text} to be flagged as an issue citation in: ${c.snippet}`,
    );
    assertEquals(
      violations.some((v) => v.message.includes(c.text)),
      true,
      `Expected violation message to name ${c.text}, got: ${JSON.stringify(violations)}`,
    );
  }
});
