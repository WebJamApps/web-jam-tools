// test/render_design_doc.test.ts — web-jam-tools#892
//
// Unit and integration tests for scripts/render_design_doc.ts:
// 1. Raw inline and block SVG rendering (AC1, AC2)
// 2. Table column sizing and overflow prevention (AC3, AC4)
// 3. Section navigation collapse and restore controls (AC5)
// 4. Revision table retained without a version/date subtitle

import { assert, assertEquals, assertFalse, assertMatch, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import {
  computeNextChangeIndex,
  computePagerRowModel,
  computeTablePagination,
  parseInlineMarkdown,
  renderDesignDoc,
  renderDesignDocFile,
  sanitizeSvg,
  slugify,
} from "../scripts/render_design_doc.ts";

Deno.test("slugify converts headings to URL-friendly slugs", () => {
  assertEquals(slugify("Hello World"), "hello-world");
  assertEquals(slugify("Section 1: The Basics & Overview!"), "section-1-the-basics-overview");
  assertEquals(slugify("   Trim Spaces   "), "trim-spaces");
});

Deno.test("parseInlineMarkdown handles code spans, links, bold, italic", () => {
  const md = "This has `code`, [link](https://example.com), **bold**, and *italic*.";
  const html = parseInlineMarkdown(md);
  assertStringIncludes(html, "<code>code</code>");
  assertStringIncludes(html, '<a href="https://example.com">link</a>');
  assertStringIncludes(html, "<strong>bold</strong>");
  assertStringIncludes(html, "<em>italic</em>");
});

Deno.test("AC1: Raw SVG blocks render as drawn diagram and &lt;svg does not appear", () => {
  const md = `# SVG Test

## Diagram Section

<svg viewBox="0 0 100 100" width="100" height="100">
  <circle cx="50" cy="50" r="40" fill="red" />
</svg>

Inline diagram: <svg width="20" height="20"><rect width="20" height="20" fill="blue" /></svg> in text.
`;

  const html = renderDesignDoc(md);

  // Both should render as raw HTML <svg> tags, not escaped entities
  assertStringIncludes(html, '<svg viewBox="0 0 100 100" width="100" height="100">');
  assertStringIncludes(html, '<circle cx="50" cy="50" r="40" fill="red" />');
  assertStringIncludes(
    html,
    '<svg width="20" height="20"><rect width="20" height="20" fill="blue" /></svg>',
  );
  assertFalse(html.includes("&lt;svg"));
});

Deno.test("AC2: Prose containing script tags is properly escaped and contains no executable script", () => {
  const md = `# Security Test

## Prose Section

A malicious probe like <script>alert(1)</script> or <img src=x onerror=alert(2)> in prose.
`;

  const html = renderDesignDoc(md);

  // Escaped in prose
  assertStringIncludes(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
  assertStringIncludes(html, "&lt;img src=x onerror=alert(2)&gt;");

  // Verify no unescaped script tag in main content
  const mainContent = html.split("<main>")[1]?.split("</main>")[0] ?? "";
  assertFalse(mainContent.includes("<script>"));
  assertFalse(mainContent.includes("<img src=x"));
});

Deno.test("AC2 (Must Fix): SVG sanitization strips <script> elements, event handlers, and javascript URIs from raw and inline SVGs", () => {
  // Direct sanitizeSvg unit tests
  assertEquals(
    sanitizeSvg('<svg onload="alert(1)"><rect width="10" height="10"/></svg>'),
    '<svg><rect width="10" height="10"/></svg>',
  );
  assertEquals(
    sanitizeSvg('<svg><script>alert("evil")</script><circle r="5"/></svg>'),
    '<svg><circle r="5"/></svg>',
  );
  assertEquals(
    sanitizeSvg('<svg><a href="javascript:alert(3)"><text>click</text></a></svg>'),
    "<svg><a ><text>click</text></a></svg>",
  );
  assertEquals(
    sanitizeSvg("<svg><foreignObject><script>alert(4)</script></foreignObject></svg>"),
    "<svg></svg>",
  );

  // End-to-end renderDesignDoc test with malicious probes inside SVG
  const md = `# Malicious SVG Test

## Diagram Block

<svg xmlns="http://www.w3.org/2000/svg" onload="alert('block-onload')">
  <script>alert(document.cookie)</script>
  <rect x="0" y="0" width="100" height="100" fill="blue" />
  <a href="javascript:alert('click')"><text>Click Me</text></a>
</svg>

Inline diagram: <svg onload="alert('inline-onload')"><script>alert('inline-script')</script><circle r="10" /></svg> in prose.
`;

  const html = renderDesignDoc(md);
  const mainContent = html.split("<main>")[1]?.split("</main>")[0] ?? "";

  // Verify that all attack vectors were stripped
  assertFalse(mainContent.includes("<script"));
  assertFalse(mainContent.includes("onload"));
  assertFalse(mainContent.includes("javascript:"));
  assertFalse(mainContent.includes("alert("));
  assertFalse(mainContent.includes("document.cookie"));

  // Verify that valid diagram elements were preserved
  assertStringIncludes(mainContent, '<rect x="0" y="0" width="100" height="100" fill="blue" />');
  assertStringIncludes(mainContent, '<circle r="10" />');
  assertStringIncludes(mainContent, "<text>Click Me</text>");
});

Deno.test("Suggestion: Unterminated <svg> block does not swallow subsequent document sections", () => {
  const md = `# Unterminated Test

<svg viewBox="0 0 100 100" width="100" height="100">
<rect x="0" y="0" width="50" height="50" fill="red"/>

## Section Two

This section should render cleanly rather than being consumed.

| Header 1 | Header 2 |
|---|---|
| Value 1 | Value 2 |
`;

  const html = renderDesignDoc(md);
  const mainContent = html.split("<main>")[1]?.split("</main>")[0] ?? "";

  // The unterminated <svg> is safely escaped in a paragraph fallback
  assertStringIncludes(mainContent, "&lt;svg viewBox=");
  assertStringIncludes(mainContent, "&lt;rect x=");
  assertFalse(mainContent.includes("<svg viewBox="));

  // Subsequent sections, paragraphs, and tables render normally
  assertStringIncludes(mainContent, '<h2 id="section-two">Section Two</h2>');
  assertStringIncludes(
    mainContent,
    "This section should render cleanly rather than being consumed.",
  );
  assertStringIncludes(mainContent, "<table>");
  assertStringIncludes(mainContent, "<td>Value 1</td>");
});

Deno.test("AC3 & AC4: Table styling preserves narrow columns and enables wrapper horizontal scrolling", () => {
  const md = `# Table Test

## Wide Table

| Date | Phase / Milestone | Epic Link | Summary |
|---|---|---|---|
| 2026-08-16 | Phase 1 (Live Pilot) | [#484](https://example.com/484) | A very long description detailing major enhancements across multiple components. |
`;

  const html = renderDesignDoc(md);

  // Verifies table CSS rules in generated HTML
  assertStringIncludes(html, "width: max-content;");
  assertStringIncludes(html, "max-width: 500px;");
  assertStringIncludes(html, "overflow-wrap: anywhere;");
  assertStringIncludes(html, "word-break: break-word;");
  assertStringIncludes(html, "white-space: nowrap;");
  assertStringIncludes(html, ".table-wrapper, pre");
  assertStringIncludes(html, "overflow-x: auto;");
  assertStringIncludes(html, "max-width: 100%;");
});

Deno.test("Every rendered <table> is wrapped in a horizontally-scrollable container, and the wrapping CSS is present", () => {
  const md = `# Multi-Table Test

## First Table

| A | B |
|---|---|
| 1 | 2 |

## Second Table

| X | Y | Z |
|---|---|---|
| a | b | c |
| d | e | f |
`;
  const html = renderDesignDoc(md);
  const mainContent = html.split("<main>")[1]?.split("</main>")[0] ?? "";

  const tableCount = (mainContent.match(/<table>/g) ?? []).length;
  const wrapperCount = (mainContent.match(/<div class="table-wrapper">/g) ?? []).length;
  assertEquals(tableCount, 2);
  assertEquals(wrapperCount, 2);
  // Every table-wrapper must directly precede its <table> (i.e. the table
  // itself, not some other element, is what's placed inside the scroll
  // container) so a table can never render outside its wrapper.
  for (const match of mainContent.matchAll(/<div class="table-wrapper">\s*<table>/g)) {
    assertStringIncludes(match[0], "<table>");
  }

  // The wrapping CSS that makes the container (not the page) scroll.
  assertStringIncludes(html, ".table-wrapper, pre {");
  assertStringIncludes(html, "overflow-x: auto;");
  assertStringIncludes(html, "max-width: 100%;");

  // Images/SVGs are capped so a fixed-pixel-width diagram cannot force page
  // scroll (web-jam-tools responsiveness fix).
  assertStringIncludes(html, "img, svg {");
});

Deno.test("A fixed-pixel-width raw SVG is capped to its container instead of overflowing the page", () => {
  const md = `# Wide SVG Test

## Diagram

<svg width="2000" height="200" viewBox="0 0 2000 200">
  <rect x="0" y="0" width="2000" height="200" fill="blue" />
</svg>
`;
  const html = renderDesignDoc(md);

  // The raw width="2000" attribute is preserved in the markup (we don't
  // rewrite the SVG's own attributes)...
  assertStringIncludes(html, '<svg width="2000" height="200" viewBox="0 0 2000 200">');
  // ...but the stylesheet caps it to the container so it cannot force
  // document.documentElement.scrollWidth past the viewport width.
  assertStringIncludes(html, "img, svg {\n      max-width: 100%;\n    }");
});

function makeRowsTable(rowCount: number): string {
  const header = "| # | Value |\n|---|---|\n";
  const rows = Array.from(
    { length: rowCount },
    (_, i) => `| ${i + 1} | v${i + 1} |`,
  ).join("\n");
  return `# Pagination Test\n\n## Big Table\n\n${header}${rows}\n`;
}

function renderedRows(
  markdown: string,
  options?: Parameters<typeof renderDesignDoc>[2],
): string[][][] {
  return Array.from(
    renderDesignDoc(markdown, undefined, options).matchAll(/<tbody>([\s\S]*?)<\/tbody>/g),
    (body) =>
      Array.from(
        body[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g),
        (row) => Array.from(row[1].matchAll(/<td>([\s\S]*?)<\/td>/g), (cell) => cell[1]),
      ),
  );
}

for (
  const heading of [
    "## Revision History",
    "## Appendix C — Decision Record",
    "## Appendix B — Decision record",
    "## Appendix — decision record",
    "## Appendix — Decisions Record",
    "## Appendix B — decisions record",
    "## 7. Decision Log",
    "## Decisions",
  ]
) {
  Deno.test(`History ordering: ${heading} shows bottom row first`, () => {
    assertEquals(
      renderedRows(`${heading}\n\n| Entry |\n|---|\n| Oldest |\n| Latest |`),
      [[["Latest"], ["Oldest"]]],
    );
  });
}

for (
  const heading of [
    "## Decisions made so far (each is written into its document with Josh's words)",
    "## The Two Approval Gates (/design-issue)",
    "## Plan table",
    "## Both surfaces",
  ]
) {
  Deno.test(`Table ordering: ${heading} shows bottom row first on design pages and file order on plan pages`, () => {
    const md = `${heading}\n\n| Entry |\n|---|\n| First |\n| Second |`;
    assertEquals(renderedRows(md), [[["Second"], ["First"]]]);
    assertEquals(renderedRows(md, { isPlanPage: true }), [[["First"], ["Second"]]]);
  });
}

for (const heading of ["## Load-bearing premises", "## Load-bearing Premises"]) {
  Deno.test(`History ordering: ${heading} sorts by Proved date, newest first`, () => {
    // Dates deliberately disagree with file order; Proved is not the last column.
    assertEquals(
      renderedRows(`${heading}

| Premise | Proved | Proof |
|---|---|---|
| Latest | 2026-10-12 | Verified |
| Oldest | 2026-10-01 | Verified |
| Middle | 2026-10-10 | Verified |`),
      [[
        ["Latest", "2026-10-12", "Verified"],
        ["Middle", "2026-10-10", "Verified"],
        ["Oldest", "2026-10-01", "Verified"],
      ]],
    );
  });
}

Deno.test("Premises with equal Proved dates show bottom row first and empty dates last", () => {
  assertEquals(
    renderedRows(`## Load-bearing premises

| Premise | Proved |
|---|---|
| Empty | |
| First tied | 2026-10-10 |
| Oldest | 2026-10-01 |
| Second tied | 2026-10-10 |`),
    [[
      ["Second tied", "2026-10-10"],
      ["First tied", "2026-10-10"],
      ["Oldest", "2026-10-01"],
      ["Empty", ""],
    ]],
  );
});

Deno.test("Premises sorting ends at the next heading and ignores headings in fenced examples", () => {
  const md = `## Load-bearing premises

| Premise | Proved |
|---|---|
| Old | 2026-10-01 |
| New | 2026-10-10 |

### Other table

| Entry |
|---|
| First |
| Second |

\`\`\`md
## Load-bearing premises
\`\`\`

| Premise | Proved |
|---|---|
| First | 2026-10-01 |
| Second | 2026-10-10 |`;
  // Every design-doc table reverses when it is not a Load-bearing premises table with Proved;
  // under `### Other table`, the 2-column Proved table at the end is NOT under Load-bearing
  // premises (the fenced heading is ignored), so only bottom-row-first reversal applies (here
  // also yielding Second then First), while plan pages keep file order everywhere.
  assertEquals(
    renderedRows(md),
    [
      [["New", "2026-10-10"], ["Old", "2026-10-01"]],
      [["Second"], ["First"]],
      [["Second", "2026-10-10"], ["First", "2026-10-01"]],
    ],
  );
  assertEquals(
    renderedRows(md, { isPlanPage: true }),
    [
      [["Old", "2026-10-01"], ["New", "2026-10-10"]],
      [["First"], ["Second"]],
      [["First", "2026-10-01"], ["Second", "2026-10-10"]],
    ],
  );
});

Deno.test("Premises tables without Proved show bottom row first on design pages; formatted dates sort normally", () => {
  const md = `## Load-bearing premises

| Entry |
|---|
| First |
| Second |

## Load-bearing Premises

| Premise | **Proved** |
|---|---|
| Old | \`2026-10-01\` |
| Empty | |
| New | **2026-10-12** |`;
  assertEquals(
    renderedRows(md),
    [
      [["Second"], ["First"]],
      [["New", "<strong>2026-10-12</strong>"], ["Old", "<code>2026-10-01</code>"], ["Empty", ""]],
    ],
  );
  assertEquals(
    renderedRows(md, { isPlanPage: true }),
    [
      [["First"], ["Second"]],
      [
        ["Old", "<code>2026-10-01</code>"],
        ["Empty", ""],
        ["New", "<strong>2026-10-12</strong>"],
      ],
    ],
  );
});

Deno.test("Pagination uses 10, 20, 30 and All with correct ranges, clamping and controls", () => {
  for (const [size, lastPage, lastStart] of [[10, 4, 31], [20, 2, 21], [30, 2, 31]]) {
    const first = computeTablePagination(38, 1, String(size));
    assertEquals([first.startIdx, first.endIdx, first.statusText], [0, size, `1-${size} of 38`]);
    assertEquals([first.prevDisabled, first.nextDisabled], [true, false]);
    const last = computeTablePagination(38, 99, size);
    assertEquals([last.currentPage, last.totalPages, last.startDisplay, last.endDisplay], [
      lastPage,
      lastPage,
      lastStart,
      38,
    ]);
    assertEquals([last.prevDisabled, last.nextDisabled], [false, true]);
  }
  const all = computeTablePagination(38, 99, "all");
  assertEquals([all.currentPage, all.statusText, all.prevDisabled, all.nextDisabled], [
    1,
    "1-38 of 38",
    true,
    true,
  ]);
  const invalidSize = computeTablePagination(38, 1, "invalid");
  assertEquals([invalidSize.pageSize, invalidSize.statusText], [10, "1-10 of 38"]);
  for (const rows of [0, 1, 10]) {
    const state = computeTablePagination(rows, 1, 10);
    assertEquals([state.startIdx, state.endIdx, state.prevDisabled, state.nextDisabled], [
      0,
      rows,
      true,
      true,
    ]);
  }
});

Deno.test("Table pagination: a table with more than 10 rows emits the pagination script/CSS and every row is still present in the DOM", () => {
  const html = renderDesignDoc(makeRowsTable(25));
  const mainContent = html.split("<main>")[1]?.split("</main>")[0] ?? "";

  // All 25 body rows are present in the static, no-JS DOM (only client-side
  // JS hides rows at load — nothing is ever dropped server-side).
  const bodyRowCount = (mainContent.match(/<td>v\d+<\/td>/g) ?? []).length;
  assertEquals(bodyRowCount, 25);

  // The pagination script, size selector, and its CSS classes are present.
  assertStringIncludes(html, "table-pager");
  assertStringIncludes(html, ".table-pager-btn");
  assertStringIncludes(html, "table-pager-hidden-row");
  assertStringIncludes(html, "table-pager-size");
  assertStringIncludes(html, "DEFAULT_PAGE_SIZE = 10");
  assertStringIncludes(html, 'var sizeOptions = ["10", "20", "30", "All"];');
  assertStringIncludes(html, "@media print {");

  // A print stylesheet forces any JS-hidden row back to visible.
  assertStringIncludes(
    html,
    "tr.table-pager-hidden-row {\n        display: table-row !important;\n      }",
  );
});

Deno.test("Table pagination: the pagination initializer only activates on tables with more than 10 rows", () => {
  const html = renderDesignDoc(makeRowsTable(10));
  // The script text itself is always emitted (it's a static asset embedded
  // once per page), so this is a source-level pin on the runtime guard that
  // keeps it a no-op for <=10 row tables, not a DOM assertion.
  assertStringIncludes(html, "if (rows.length <= DEFAULT_PAGE_SIZE) return;");
});

Deno.test("Sticky header and scrolling wrapper: thead cells are styled with position: sticky and table-wrapper has max-height and overflow scrolling", () => {
  const html = renderDesignDoc(makeRowsTable(10));
  assertStringIncludes(html, "thead th {");
  assertStringIncludes(html, "position: sticky;");
  assertStringIncludes(html, "top: 0;");
  assertStringIncludes(html, "z-index: 2;");
  assertStringIncludes(html, "background-color: var(--toc-bg);");
  assertStringIncludes(
    html,
    "box-shadow: inset 0 1px 0 var(--border-color), inset 0 -1px 0 var(--border-color);",
  );

  assertStringIncludes(html, ".table-wrapper {");
  assertStringIncludes(html, "max-height: 70vh;");
  assertStringIncludes(html, "overflow-y: auto;");
});

Deno.test("Table pagination: page navigation uses the tested pagination state", () => {
  const html = renderDesignDoc(makeRowsTable(40));
  // Verifies the position format `<start>-<end> of <total>` emitted in the pager logic
  assertStringIncludes(
    html,
    "status.textContent = state.statusText;",
  );
  assertStringIncludes(html, "Rows per page: ");
});

Deno.test("Table pagination: embedded calculator runs independently and matches exported state", () => {
  const html = renderDesignDoc(makeRowsTable(38));
  const embedded = html.match(/var computePagination = ([\s\S]*?);\s*var tables =/);
  assert(embedded, "Generated HTML must include the pagination calculator");

  // Function creates a fresh scope without access to this module's imports or helpers.
  const computeEmbedded = new Function(
    `return (${embedded[1]});`,
  )() as typeof computeTablePagination;
  const cases: Parameters<typeof computeTablePagination>[] = [
    [38, 99, "20"],
    [38, 1, "all"],
    [38, 2, 10],
    [38, 0, "30"],
    [38, 1, "invalid"],
    [0, 1, 10],
  ];
  for (const args of cases) {
    assertEquals(computeEmbedded(...args), computeTablePagination(...args));
  }
});

Deno.test("computeTablePagination: calculates correct ranges and boundary states for 40 rows with pageSize 5", () => {
  // Page 1
  const page1 = computeTablePagination(40, 1, 5);
  assertEquals(page1.startDisplay, 1);
  assertEquals(page1.endDisplay, 5);
  assertEquals(page1.totalPages, 8);
  assertEquals(page1.statusText, "1-5 of 40");
  assertEquals(page1.prevDisabled, true);
  assertEquals(page1.nextDisabled, false);

  // Page 2
  const page2 = computeTablePagination(40, 2, 5);
  assertEquals(page2.startDisplay, 6);
  assertEquals(page2.endDisplay, 10);
  assertEquals(page2.totalPages, 8);
  assertEquals(page2.statusText, "6-10 of 40");
  assertEquals(page2.prevDisabled, false);
  assertEquals(page2.nextDisabled, false);

  // Page 8
  const page8 = computeTablePagination(40, 8, 5);
  assertEquals(page8.startDisplay, 36);
  assertEquals(page8.endDisplay, 40);
  assertEquals(page8.totalPages, 8);
  assertEquals(page8.statusText, "36-40 of 40");
  assertEquals(page8.prevDisabled, false);
  assertEquals(page8.nextDisabled, true);
});

Deno.test("computeTablePagination: handles remainder page calculation for 38 rows with pageSize 5", () => {
  const page8 = computeTablePagination(38, 8, 5);
  assertEquals(page8.startDisplay, 36);
  assertEquals(page8.endDisplay, 38);
  assertEquals(page8.statusText, "36-38 of 38");
  assertEquals(page8.nextDisabled, true);
});

Deno.test("computeTablePagination: calculates correct ranges for 40 rows with pageSize 25", () => {
  // Page 1
  const page1 = computeTablePagination(40, 1, 25);
  assertEquals(page1.startDisplay, 1);
  assertEquals(page1.endDisplay, 25);
  assertEquals(page1.statusText, "1-25 of 40");
  assertEquals(page1.prevDisabled, true);
  assertEquals(page1.nextDisabled, false);

  // Page 2
  const page2 = computeTablePagination(40, 2, 25);
  assertEquals(page2.startDisplay, 26);
  assertEquals(page2.endDisplay, 40);
  assertEquals(page2.statusText, "26-40 of 40");
  assertEquals(page2.prevDisabled, false);
  assertEquals(page2.nextDisabled, true);
});

Deno.test("computeTablePagination: handles pageSize 'all'", () => {
  const state = computeTablePagination(40, 1, "all");
  assertEquals(state.isAll, true);
  assertEquals(state.totalPages, 1);
  assertEquals(state.currentPage, 1);
  assertEquals(state.startDisplay, 1);
  assertEquals(state.endDisplay, 40);
  assertEquals(state.statusText, "1-40 of 40");
  assertEquals(state.prevDisabled, true);
  assertEquals(state.nextDisabled, true);
});

Deno.test("computeTablePagination: handles page clamping and edge cases", () => {
  // Requested page 0 or negative clamps to page 1
  const clampedZero = computeTablePagination(40, 0, 5);
  assertEquals(clampedZero.currentPage, 1);
  const clampedNeg = computeTablePagination(40, -5, 5);
  assertEquals(clampedNeg.currentPage, 1);

  // Requested page 99 with 8 total pages clamps to page 8
  const clampedHigh = computeTablePagination(40, 99, 5);
  assertEquals(clampedHigh.currentPage, 8);

  // 0 total rows returns "0 of 0", both prev and next disabled
  const empty = computeTablePagination(0, 1, 5);
  assertEquals(empty.statusText, "0 of 0");
  assertEquals(empty.prevDisabled, true);
  assertEquals(empty.nextDisabled, true);
});

Deno.test("Table degradation without JavaScript: all rows present in HTML without display:none", () => {
  const md = `# Multi-Table Threshold Test

## Small Table (3 rows)
| A | B |
|---|---|
| 1 | 2 |
| 3 | 4 |
| 5 | 6 |

## Large Table (7 rows)
| X | Y |
|---|---|
| a | 1 |
| b | 2 |
| c | 3 |
| d | 4 |
| e | 5 |
| f | 6 |
| g | 7 |
`;
  const html = renderDesignDoc(md);
  const mainContent = html.split("<main>")[1]?.split("</main>")[0] ?? "";

  // Verify all rows are emitted in static HTML
  const totalRows = (mainContent.match(/<tr>/g) ?? []).length;
  // 2 header rows + 3 small rows + 7 large rows = 12 <tr> tags
  assertEquals(totalRows, 12);

  // Verify no rows carry display:none server-side
  assertFalse(mainContent.includes('style="display:none"'));
  assertFalse(mainContent.includes('style="display: none"'));
});

Deno.test("AC5: Section navigation includes collapse and restore controls", () => {
  const md = `# Doc with TOC

## Section One
Content 1

## Section Two
Content 2
`;

  const html = renderDesignDoc(md);

  // Check collapse button in nav.toc
  assertStringIncludes(html, 'id="nav-collapse-btn"');
  assertStringIncludes(html, 'class="nav-collapse-btn"');

  // Check restore button
  assertStringIncludes(html, 'id="nav-restore-btn"');
  assertStringIncludes(html, 'class="nav-restore-btn"');

  // Check styling rules for collapsed nav
  assertStringIncludes(html, ".layout.nav-collapsed");
  assertStringIncludes(html, ".layout.nav-collapsed nav.toc");
  assertStringIncludes(html, ".layout.nav-collapsed .nav-restore-btn");

  // Check script wiring
  assertStringIncludes(html, 'collapseBtn.addEventListener("click"');
  assertStringIncludes(html, 'restoreBtn.addEventListener("click"');
  assertStringIncludes(html, 'layout.classList.add("nav-collapsed")');
  assertStringIncludes(html, 'layout.classList.remove("nav-collapsed")');
});

Deno.test("renderDesignDoc: revision metadata stays in the table without a title subtitle", () => {
  // Case A: Document with ## Revision History table
  const docWithTable = `# Design Document Title

## Revision History

| Version | Date | Epic / Issue | Summary |
|---|---|---|---|
| 1.0.0 | 2026-08-16 | [Issue 1](https://example.com/1) | Initial release |
| 2.1.0 | 2026-09-02 | [Issue 2](https://example.com/2) | Major revision |

## First Section
Section text.
`;
  const htmlWithTable = renderDesignDoc(docWithTable);
  const mainWithTable = htmlWithTable.split("<main>")[1]?.split("</main>")[0] ?? "";
  assertStringIncludes(mainWithTable, "<h1>Design Document Title</h1>");
  assertFalse(htmlWithTable.includes("doc-version"));
  assertFalse(htmlWithTable.includes("doc-revised"));
  assertFalse(mainWithTable.includes("Version:"));
  assertFalse(mainWithTable.includes("Revised:"));
  assertEquals(mainWithTable.match(/2\.1\.0/g)?.length, 1);
  assertEquals(mainWithTable.match(/2026-09-02/g)?.length, 1);
  // Table must render in place in the body
  assertStringIncludes(mainWithTable, '<h2 id="revision-history">Revision History</h2>');
  assertStringIncludes(mainWithTable, "<th>Version</th>");
  assertStringIncludes(mainWithTable, "<td>2.1.0</td>");
  assertStringIncludes(mainWithTable, "<td>Major revision</td>");

  // Case B: Document without Revision History table
  const docWithoutTable = `# Clean Title

## First Section
Section text.
`;
  const htmlWithoutTable = renderDesignDoc(docWithoutTable);
  const mainWithoutTable = htmlWithoutTable.split("<main>")[1]?.split("</main>")[0] ?? "";
  assertFalse(mainWithoutTable.includes("doc-header"));
  assertFalse(mainWithoutTable.includes("doc-version-line"));
  assertFalse(mainWithoutTable.includes("Version:"));
  assertFalse(mainWithoutTable.includes("Revised:"));
  assertStringIncludes(mainWithoutTable, "<h1>Clean Title</h1>");
});

Deno.test("renderDesignDoc: a revision table without H1 uses the title fallback without metadata", () => {
  const html = renderDesignDoc(
    `## Revision History

| Version | Date | Summary |
|---|---|---|
| 1.0.0 | 2026-10-10 | Initial |
`,
    "Fallback title",
  );
  assertStringIncludes(html, "<title>Fallback title</title>");
  assertStringIncludes(html, "<h1>Fallback title</h1>");
  assertFalse(html.includes("doc-version"));
  assertFalse(html.includes("doc-revised"));
  assertStringIncludes(html, "<td>1.0.0</td>");
  assertStringIncludes(html, "<td>2026-10-10</td>");
});

Deno.test("parseInlineMarkdown renders <br> variants as real line breaks in table cells", () => {
  assertEquals(parseInlineMarkdown("a<br>b"), "a<br>b");
  assertEquals(parseInlineMarkdown("a<br/>b"), "a<br>b");
  assertEquals(parseInlineMarkdown("a<br />b"), "a<br>b");
  assertEquals(parseInlineMarkdown("a<BR>b"), "a<br>b");
  assertEquals(
    parseInlineMarkdown("1. Option A (Rec)<br>2. Option B<br>3. Option C"),
    "1. Option A (Rec)<br>2. Option B<br>3. Option C",
  );
});

Deno.test("parseInlineMarkdown keeps unsafe or malformed <br>-like input escaped as text", () => {
  assertEquals(
    parseInlineMarkdown('<br onclick="x">'),
    "&lt;br onclick=&quot;x&quot;&gt;",
  );
  assertEquals(
    parseInlineMarkdown('<br style="x">'),
    "&lt;br style=&quot;x&quot;&gt;",
  );
  assertEquals(
    parseInlineMarkdown("<script>alert(1)</script>"),
    "&lt;script&gt;alert(1)&lt;/script&gt;",
  );
  assertEquals(
    parseInlineMarkdown("<img src=x onerror=alert(1)>"),
    "&lt;img src=x onerror=alert(1)&gt;",
  );
  assertEquals(parseInlineMarkdown("<b>bold</b>"), "&lt;b&gt;bold&lt;/b&gt;");
  assertEquals(parseInlineMarkdown("<brx>"), "&lt;brx&gt;");
  assertEquals(parseInlineMarkdown("<br"), "&lt;br");
});

Deno.test("parseInlineMarkdown never double-unescapes an already-escaped &lt;br&gt; entity into a tag", () => {
  const html = parseInlineMarkdown("literal &lt;br&gt; text");
  assertStringIncludes(html, "&amp;lt;br&amp;gt;");
  assertFalse(html.includes("<br>"));
});

Deno.test("parseInlineMarkdown keeps <br> literal inside a backtick code span", () => {
  const html = parseInlineMarkdown("Use `<br>` for a line break.");
  assertStringIncludes(html, "<code>&lt;br&gt;</code>");
  // Only the code-span's own <code> tag should be present — no bare <br> tag.
  assertFalse(html.replace("<code>&lt;br&gt;</code>", "").includes("<br>"));
});

Deno.test("Design-doc table cells with <br> render real line breaks, not literal &lt;br&gt; text", () => {
  const md = `# Decisions Test

## Decisions

| # | Question | Options |
|---|---|---|
| 1 | Which approach? | 1. Option A (Rec)<br>2. Option B<br>3. Option C |
`;
  const html = renderDesignDoc(md);
  const mainContent = html.split("<main>")[1]?.split("</main>")[0] ?? "";

  assertFalse(mainContent.includes("&lt;br&gt;"));
  assertStringIncludes(
    mainContent,
    "<td>1. Option A (Rec)<br>2. Option B<br>3. Option C</td>",
  );
});

Deno.test("Optional fix: escaped pipe (\\|) in a table cell renders as a literal | without splitting the cell", () => {
  const md = `# Escaped Pipe Test

## Table

| Name | Formula |
|---|---|
| Sum | a \\| b |
`;
  const html = renderDesignDoc(md);
  const mainContent = html.split("<main>")[1]?.split("</main>")[0] ?? "";

  // The row must still have exactly 2 columns (not split into 3 by the escaped pipe).
  assertStringIncludes(mainContent, "<td>Sum</td>");
  assertStringIncludes(mainContent, "<td>a | b</td>");
});

Deno.test("renderDesignDocFile reads markdown file and writes HTML", () => {
  const tempDir = Deno.makeTempDirSync({ prefix: "render-doc-test-" });
  try {
    const mdPath = path.join(tempDir, "test.md");
    const htmlPath = path.join(tempDir, "test.html");
    Deno.writeTextFileSync(
      mdPath,
      "# File Test\n\n## Revision History\n\n| Version | Date | Summary |\n|---|---|---|\n| 1.0.0 | 2026-09-02 | Initial |\n\n## Section\nText",
    );
    renderDesignDocFile(mdPath, htmlPath);

    const generatedHtml = Deno.readTextFileSync(htmlPath);
    assertStringIncludes(generatedHtml, "File Test");
    assertFalse(generatedHtml.includes("doc-version"));
    assertFalse(generatedHtml.includes("doc-revised"));
    assertStringIncludes(generatedHtml, "<td>1.0.0</td>");
    assertStringIncludes(generatedHtml, "<td>2026-09-02</td>");
    assertStringIncludes(generatedHtml, "nav-collapse-btn");
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
  }
});

Deno.test("renderDesignDoc handles blockquotes, lists, hr, h4, and duplicate heading slugs", () => {
  const md = `# General Markdown Features

## Duplicate
First instance

## Duplicate
Second instance

---

#### Level 4 Heading

> A blockquote line
> Second blockquote line

- Bullet 1
- Bullet 2

1. Numbered 1
2. Numbered 2
`;
  const html = renderDesignDoc(md);
  const mainContent = html.split("<main>")[1]?.split("</main>")[0] ?? "";

  // Slug deduplication: duplicate-2
  assertStringIncludes(html, 'href="#duplicate"');
  assertStringIncludes(html, 'href="#duplicate-2"');
  assertStringIncludes(mainContent, '<h2 id="duplicate-2">Duplicate</h2>');

  // Horizontal rule
  assertStringIncludes(mainContent, "<hr>");

  // Heading level 4
  assertStringIncludes(mainContent, '<h4 id="level-4-heading">Level 4 Heading</h4>');

  // Blockquote
  assertStringIncludes(
    mainContent,
    "<blockquote>A blockquote line<br>\nSecond blockquote line</blockquote>",
  );

  // Lists
  assertStringIncludes(mainContent, "<ul>\n  <li>Bullet 1</li>\n  <li>Bullet 2</li>\n</ul>");
  assertStringIncludes(mainContent, "<ol>\n  <li>Numbered 1</li>\n  <li>Numbered 2</li>\n</ol>");
});

async function countNearWhitePixels(pngBytes: Uint8Array): Promise<number> {
  const view = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idatChunks: Uint8Array[] = [];

  while (offset < pngBytes.length) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(pngBytes.subarray(offset + 4, offset + 8));
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      colorType = pngBytes[offset + 17];
    } else if (type === "IDAT") {
      idatChunks.push(pngBytes.subarray(offset + 8, offset + 8 + length));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  const totalIdatLength = idatChunks.reduce((acc, c) => acc + c.length, 0);
  const combinedIdat = new Uint8Array(totalIdatLength);
  let idatOffset = 0;
  for (const chunk of idatChunks) {
    combinedIdat.set(chunk, idatOffset);
    idatOffset += chunk.length;
  }

  const ds = new DecompressionStream("deflate");
  const response = new Response(new Blob([combinedIdat]).stream().pipeThrough(ds));
  const decompressed = new Uint8Array(await response.arrayBuffer());

  const bytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : 4;
  const stride = width * bytesPerPixel;
  let count = 0;

  const prevRow = new Uint8Array(stride);
  const currRow = new Uint8Array(stride);
  let srcPos = 0;

  for (let y = 0; y < height; y++) {
    const filter = decompressed[srcPos++];
    for (let i = 0; i < stride; i++) {
      const x = decompressed[srcPos++];
      const a = i >= bytesPerPixel ? currRow[i - bytesPerPixel] : 0;
      const b = prevRow[i];
      const c = i >= bytesPerPixel ? prevRow[i - bytesPerPixel] : 0;
      let val = x;
      if (filter === 0) val = x;
      else if (filter === 1) val = (x + a) & 0xff;
      else if (filter === 2) val = (x + b) & 0xff;
      else if (filter === 3) val = (x + Math.floor((a + b) / 2)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        val = (x + pr) & 0xff;
      }
      currRow[i] = val;
    }

    for (let x = 0; x < width; x++) {
      const idx = x * bytesPerPixel;
      const r = currRow[idx];
      const g = currRow[idx + 1];
      const b = currRow[idx + 2];
      if (r >= 230 && g >= 230 && b >= 230) {
        count++;
      }
    }

    prevRow.set(currRow);
  }

  return count;
}

Deno.test("renderDesignDoc: declares color-scheme: dark so scrollbars draw dark", () => {
  const html = renderDesignDoc("# Title\n\nContent");
  assertStringIncludes(html, "color-scheme: dark");
});

Deno.test("Rendered Chrome check at 1600 x 1000 finds no near-white pixel", async () => {
  let chromeBin = "";
  for (const bin of ["google-chrome", "chromium", "chromium-browser"]) {
    try {
      const cmd = new Deno.Command(bin, {
        args: ["--version"],
        stdout: "null",
        stderr: "null",
      });
      if ((await cmd.output()).success) {
        chromeBin = bin;
        break;
      }
    } catch {
      // not available
    }
  }

  if (!chromeBin) {
    return;
  }

  let md = "# Sample Design Document\n\n";
  for (let i = 0; i < 40; i++) {
    md +=
      `## Section ${i}\n\nThis is paragraph ${i} with enough text to make the page scroll vertically in Chrome.\n\n`;
  }

  const html = renderDesignDoc(md);
  const tempDir = await Deno.makeTempDir({ prefix: "render-chrome-check-" });
  try {
    const htmlPath = path.join(tempDir, "page.html");
    const screenshotPath = path.join(tempDir, "screenshot.png");
    await Deno.writeTextFile(htmlPath, html);

    const cmd = new Deno.Command(chromeBin, {
      args: [
        "--headless=new",
        `--user-data-dir=${tempDir}/profile`,
        `--screenshot=${screenshotPath}`,
        "--window-size=1600,1000",
        `file://${htmlPath}`,
      ],
      stdout: "null",
      stderr: "null",
    });
    const output = await cmd.output();
    assertEquals(output.success, true, "Chrome screenshot command must succeed");

    const pngBytes = await Deno.readFile(screenshotPath);
    const nearWhiteCount = await countNearWhitePixels(pngBytes);
    assertEquals(nearWhiteCount, 0, `Expected 0 near-white pixels, found ${nearWhiteCount}`);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Plan page: only the Gate 2 table starts on all, and the revision history keeps file order", () => {
  const planHeader =
    "| # | Proposed title | Epic / child of | Model tier | Priority | Repo | Design | Tests | Closes when |";
  const planRows = Array.from(
    { length: 11 },
    (_, i) =>
      `| ${i + 1} | Plan row ${
        i + 1
      } | row 1 | Terra | High | web-jam-tools | design.md | Tests | \`deno task test\` passes |`,
  );
  const otherRows = Array.from({ length: 12 }, (_, i) => `| Item ${i + 1} | ${i + 1} |`);
  const md = [
    "# Plan",
    "",
    "## Revision History",
    "",
    "| Version | Date | Notes |",
    "|---|---|---|",
    "| 1.0 | 2026-11-01 | First revision |",
    "| 2.0 | 2026-11-02 | Second revision |",
    "",
    "## Phase 2 — The Issue Plan",
    "",
    planHeader,
    "|---|---|---|---|---|---|---|---|---|",
    ...planRows,
    "",
    "## Other",
    "",
    "| Name | Count |",
    "|---|---|",
    ...otherRows,
  ].join("\n");
  const html = renderDesignDoc(md, "Plan", { isPlanPage: true });
  assertStringIncludes(html, "First revision");
  assertStringIncludes(html, "Second revision");
  assertEquals(html.indexOf("First revision") < html.indexOf("Second revision"), true);
  assertEquals(html.match(/data-default-size="all"/g)?.length, 1);
  assertEquals(html.match(/<div class="table-wrapper">/g)?.length, 2);
  assertEquals(html.match(/plan-table-total">Total rows/g)?.length, 1);

  const regularHtml = renderDesignDoc(md);
  assertEquals(regularHtml.includes('class="plan-table-total"'), false);
  assertEquals(regularHtml.includes('data-default-size="all"'), false);
  assertEquals(
    regularHtml.indexOf("Second revision") < regularHtml.indexOf("First revision"),
    true,
  );
  assertEquals(regularHtml.indexOf("Item 12") < regularHtml.indexOf("Item 1</td>"), true);
});

Deno.test("Gate 1 page renders otherDesignSweep table with revised, noted, and unreadable-noted entries", () => {
  const md = `# Owner Design

## Revision History

| Version | Date | Summary |
|---|---|---|
| 1.0.0 | 2026-11-21 | Initial |

## Body

Rule content.
`;
  const html = renderDesignDoc(md, "Owner", {
    otherDesignSweep: {
      terms: ["Hydrogen", "2.28.0"],
      checkedAt: "2026-11-21T12:00:00Z",
      presentingDay: "2026-11-21",
      entries: [
        {
          otherPath: "/tmp/docs/pointer-design.md",
          lines: [14],
          terms: ["Hydrogen"],
          status: "revised",
          revisionDate: "2026-11-21",
        },
        {
          otherPath: "/tmp/docs/workflow-design.md",
          lines: [9, 22],
          terms: ["Hydrogen", "2.28.0"],
          status: "noted",
          reason: "Uses owner result in local workflow <script> & nothing restated",
        },
        {
          otherPath: "/tmp/docs/locked-design.md",
          lines: [],
          terms: [],
          status: "unreadable-noted",
          reason: "Permission denied on archive mount",
        },
      ],
    },
  });

  assertStringIncludes(html, 'href="#other-designs-checked-for-changed-rulings"');
  assertStringIncludes(
    html,
    '<h2 id="other-designs-checked-for-changed-rulings">Other designs checked for changed rulings</h2>',
  );
  assertStringIncludes(html, "<code>Hydrogen</code>, <code>2.28.0</code>");
  assertStringIncludes(html, "<td><code>/tmp/docs/pointer-design.md</code></td>");
  assertStringIncludes(html, "<td>Revised</td>");
  assertStringIncludes(html, "<td>Revised on 2026-11-21</td>");
  assertStringIncludes(html, "<td>9, 22</td>");
  assertStringIncludes(html, "<td>Noted</td>");
  assertStringIncludes(
    html,
    "<td>Uses owner result in local workflow &lt;script&gt; &amp; nothing restated</td>",
  );
  assertStringIncludes(html, "<td>Unchecked (unreadable, noted)</td>");
  assertStringIncludes(html, "<td>Permission denied on archive mount</td>");
});

Deno.test("Gate 1 page renders otherDesignSweep with zero hits and omits it on plan pages", () => {
  const md = "# Owner\n\n## Section\nBody.\n";
  const html = renderDesignDoc(md, "Owner", {
    otherDesignSweep: {
      terms: ["Hydrogen"],
      checkedAt: "2026-11-21T12:00:00Z",
      presentingDay: "2026-11-21",
      entries: [],
    },
  });
  assertStringIncludes(html, "Other designs checked for changed rulings");
  assertStringIncludes(html, "No hits found in other design documents.");

  const planHtml = renderDesignDoc(md, "Owner", {
    isPlanPage: true,
    otherDesignSweep: {
      terms: ["Hydrogen"],
      checkedAt: "2026-11-21T12:00:00Z",
      presentingDay: "2026-11-21",
      entries: [],
    },
  });
  assertFalse(planHtml.includes("other-design-sweep"));
});

Deno.test("renderDesignDoc assigns deterministic id anchors on h2, h3, and h4 with -2, -3 deduplication across heading levels", () => {
  const md = `# Anchors Test

### History tables point at the body
First instance.

#### Sub check
Sub details.

### History tables point at the body
Second instance.

## Shared Name
H2 first.

### Shared Name
H3 second.

#### Shared Name
H4 third.
`;
  const html = renderDesignDoc(md);
  const mainContent = html.split("<main>")[1]?.split("</main>")[0] ?? "";

  assertStringIncludes(
    mainContent,
    '<h3 id="history-tables-point-at-the-body">History tables point at the body</h3>',
  );
  assertStringIncludes(mainContent, '<h4 id="sub-check">Sub check</h4>');
  assertStringIncludes(
    mainContent,
    '<h3 id="history-tables-point-at-the-body-2">History tables point at the body</h3>',
  );
  assertStringIncludes(mainContent, '<h2 id="shared-name">Shared Name</h2>');
  assertStringIncludes(mainContent, '<h3 id="shared-name-2">Shared Name</h3>');
  assertStringIncludes(mainContent, '<h4 id="shared-name-3">Shared Name</h4>');
  assertStringIncludes(html, 'href="#shared-name"');
});

Deno.test("renderDesignDoc assigns id anchors on appendix ### details in document order and auto-opens hash targets", () => {
  const md = `# Appendix Anchors Test

## Overview
Body content.

### Duplicate Cases
Body subsection.

## Appendix D — Case Lists

### Model-label cases
Cases list.

### Duplicate Cases
Appendix subsection.
`;
  const html = renderDesignDoc(md);
  const mainContent = html.split("<main>")[1]?.split("</main>")[0] ?? "";

  assertStringIncludes(mainContent, '<h3 id="duplicate-cases">Duplicate Cases</h3>');
  assertStringIncludes(
    mainContent,
    '<details id="model-label-cases">\n  <summary>Model-label cases</summary>',
  );
  assertStringIncludes(
    mainContent,
    '<details id="duplicate-cases-2">\n  <summary>Duplicate Cases</summary>',
  );
  assertStringIncludes(html, "openDetailsForHash");
  assertStringIncludes(html, 'window.addEventListener("hashchange", openDetailsForHash)');
});

Deno.test("Revision table is placed first directly under the title on design pages even when written lower down", () => {
  const md = `# My Design Doc

Intro paragraph that sat above sections.

## Overview

\`\`\`md
## Revision History
\`\`\`

Overview body.

## Revision History

| Version | Date | Summary |
|---|---|---|
| 1.0.0 | 2026-10-01 | Initial |
| 1.1.0 | 2026-10-20 | Latest |

## Appendix A

Appendix body.
`;
  const html = renderDesignDoc(md);
  const mainContent = html.split("<main>")[1]?.split("</main>")[0] ?? "";
  const h1Pos = mainContent.indexOf("<h1>My Design Doc</h1>");
  const revPos = mainContent.indexOf('<h2 id="revision-history">Revision History</h2>');
  const overviewPos = mainContent.indexOf('<h2 id="overview">Overview</h2>');
  const appendixPos = mainContent.indexOf('<h2 id="appendix-a">Appendix A</h2>');

  assert(h1Pos >= 0 && revPos > h1Pos, "Revision History follows H1");
  assert(revPos < overviewPos && overviewPos < appendixPos, "Revision History precedes Overview");
  // The text directly between <h1>...</h1> and <h2 id="revision-history"> has no other section.
  assertFalse(mainContent.slice(h1Pos, revPos).includes("<h2"));

  // TOC lists Revision History first, matching body order.
  const tocSection = html.split('<nav class="toc">')[1]?.split("</nav>")[0] ?? "";
  assert(
    tocSection.indexOf('href="#revision-history"') < tocSection.indexOf('href="#overview"'),
  );

  // Latest revision row is shown first.
  assert(mainContent.indexOf("1.1.0") < mainContent.indexOf("1.0.0"));

  // Fenced example remained in Overview's code block rather than being hoisted.
  assertStringIncludes(
    mainContent.slice(overviewPos, appendixPos),
    '<pre><code class="language-md">## Revision History</code></pre>',
  );

  // Also works with fallbackTitle when markdown has no H1.
  const noH1Html = renderDesignDoc(
    `## Overview

Text.

## Revision History

| Version | Date |
|---|---|
| 1.0.0 | 2026-10-01 |
`,
    "Fallback Doc Title",
  );
  const noH1Main = noH1Html.split("<main>")[1]?.split("</main>")[0] ?? "";
  assert(
    noH1Main.indexOf("<h1>Fallback Doc Title</h1>") <
      noH1Main.indexOf('<h2 id="revision-history">Revision History</h2>'),
  );
  assert(
    noH1Main.indexOf('<h2 id="revision-history">Revision History</h2>') <
      noH1Main.indexOf('<h2 id="overview">Overview</h2>'),
  );
});

Deno.test("Images on the rendered page: renders local images beside doc and leaves remote, outside, non-image, and raw HTML as text", () => {
  const rootDir = Deno.makeTempDirSync({ prefix: "render-doc-images-" });
  const docDir = path.join(rootDir, "design");
  const subImgDir = path.join(docDir, "img");
  const otherDir = path.join(rootDir, "other");
  const outDir = path.join(rootDir, "output");
  Deno.mkdirSync(subImgDir, { recursive: true });
  Deno.mkdirSync(otherDir, { recursive: true });
  Deno.mkdirSync(outDir, { recursive: true });

  try {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpgBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const webpBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>';
    Deno.writeFileSync(path.join(docDir, "gigs-gig-page-phone.png"), pngBytes);
    Deno.writeTextFileSync(path.join(subImgDir, "diagram.svg"), svgContent);
    Deno.writeFileSync(path.join(docDir, "photo.jpg"), jpgBytes);
    Deno.writeFileSync(path.join(docDir, "pic.webp"), webpBytes);
    Deno.writeFileSync(path.join(otherDir, "a.png"), pngBytes);
    Deno.writeTextFileSync(path.join(docDir, "a.js"), "console.log(1);");
    Deno.symlinkSync(path.join(otherDir, "a.png"), path.join(docDir, "escaped-link.png"));

    const md = `# Images Test

## Mockups

![phone](gigs-gig-page-phone.png)

![diagram](img/diagram.svg)

![photo](photo.jpg)

![pic](pic.webp)

#### Heading image ![head-phone](gigs-gig-page-phone.png)

![remote](https://example.com/a.png)

![outside](../other/a.png)

![encoded](%2e%2e/other/a.png)

![missing](nope.png)

![symlink](escaped-link.png)

![script](a.js)

<img src="gigs-gig-page-phone.png" onerror="alert(1)">

![a "quoted" alt](gigs-gig-page-phone.png)
`;
    const mdPath = path.join(docDir, "doc.md");
    const htmlPath = path.join(outDir, "doc.html");
    Deno.writeTextFileSync(mdPath, md);
    renderDesignDocFile(mdPath, htmlPath);
    const html = Deno.readTextFileSync(htmlPath);
    const main = html.split("<main>")[1]?.split("</main>")[0] ?? "";

    // Sized to the page via stylesheet
    assertStringIncludes(html, "img, svg {\n      max-width: 100%;\n    }");
    assertStringIncludes(html, "img {\n      height: auto;\n    }");

    // Valid local images render as <img> with embedded data URIs from files beside the doc
    assertMatch(main, /<img src="data:image\/png;base64,[^"]+" alt="phone">/);
    assertMatch(main, /<img src="data:image\/svg\+xml;base64,[^"]+" alt="diagram">/);
    assertMatch(main, /<img src="data:image\/jpeg;base64,[^"]+" alt="photo">/);
    assertMatch(main, /<img src="data:image\/webp;base64,[^"]+" alt="pic">/);
    assertMatch(
      main,
      /<h4 id="heading-image-head-phonegigs-gig-page-phonepng">Heading image <img src="data:image\/png;base64,[^"]+" alt="head-phone"><\/h4>/,
    );

    // Quoted alt attribute is HTML-escaped
    assertMatch(
      main,
      /<img src="data:image\/png;base64,[^"]+" alt="a &quot;quoted&quot; alt">/,
    );

    // Remote, outside-folder (literal and percent-encoded), missing, escaping symlink, and non-image
    // paths render as literal text (no <img> or <a>)
    assertStringIncludes(main, "![remote](https://example.com/a.png)");
    assertStringIncludes(main, "![outside](../other/a.png)");
    assertStringIncludes(main, "![encoded](%2e%2e/other/a.png)");
    assertStringIncludes(main, "![missing](nope.png)");
    assertStringIncludes(main, "![symlink](escaped-link.png)");
    assertStringIncludes(main, "![script](a.js)");
    assertFalse(main.includes('src="%2e%2e/other/a.png"'));
    assertFalse(main.includes('src="nope.png"'));
    assertFalse(main.includes('https://example.com/a.png">'));
    assertFalse(main.includes('<a href="https://example.com/a.png"'));
    assertFalse(main.includes('<a href="../other/a.png"'));
    assertFalse(main.includes('<a href="%2e%2e/other/a.png"'));
    assertFalse(main.includes('<a href="nope.png"'));
    assertFalse(main.includes('<a href="a.js"'));

    // Without docDir, even a relative image filename is never emitted as a live <img>
    assertEquals(
      parseInlineMarkdown("![phone](gigs-gig-page-phone.png)"),
      "![phone](gigs-gig-page-phone.png)",
    );

    // Raw <img> HTML stays escaped
    assertStringIncludes(
      main,
      "&lt;img src=&quot;gigs-gig-page-phone.png&quot; onerror=&quot;alert(1)&quot;&gt;",
    );
    assertFalse(main.includes('onerror="alert(1)"'));
  } finally {
    Deno.removeSync(rootDir, { recursive: true });
  }
});

Deno.test("Revision highlights: highlights changed heading, paragraph, list item, table row, deletion markers, and top banner", () => {
  const approvedMd = `# Design Doc

## Revision History

| Version | Date | Why |
|---|---|---|
| 1.0.0 | 2026-10-01 | Initial version |

## Overview

Unchanged intro paragraph.

Paragraph that will change.

Paragraph that will be deleted.

- Keep bullet
- Edit bullet

## Details

| Item | State |
|---|---|
| Row A | unchanged |
| Row B | deleted |
`;

  const revisedMd = `# Design Doc

## Revision History

| Version | Date | Why |
|---|---|---|
| 1.0.0 | 2026-10-01 | Initial version |
| 1.1.0 | 2026-11-26 | Updated overview |

## Overview Revised

Unchanged intro paragraph.

Paragraph that changed in revision.

- Keep bullet
- Edited bullet
- Added bullet

## Details

| Item | State |
|---|---|
| Row A | unchanged |
| Row C | added |
`;

  const html = renderDesignDoc(revisedMd, "Design Doc", {
    approvedMarkdown: approvedMd,
    approvedAt: "2026-10-01T12:00:00.000Z",
  });
  const main = html.split("<main>")[1]?.split("</main>")[0] ?? "";

  // Subtle dark-mode styling and transparent table containers
  assertStringIncludes(html, "rgba(250, 204, 21, 0.085)");
  assertStringIncludes(html, "border-left: 2px solid rgba(250, 204, 21, 0.75);");
  assertStringIncludes(html, "box-shadow: inset 2px 0 0 rgba(250, 204, 21, 0.75);");
  assertStringIncludes(html, "background-color: transparent;");
  assertStringIncludes(html, "body.highlights-hidden");

  // Changed heading, paragraph, list items, table rows, and deletion marker
  assertStringIncludes(
    main,
    '<h2 id="overview-revised" class="rev-changed" data-rev-change="true">Overview Revised</h2>',
  );
  assertStringIncludes(main, "<p>Unchanged intro paragraph.</p>");
  assertStringIncludes(
    main,
    '<p class="rev-changed" data-rev-change="true">Paragraph that changed in revision.</p>',
  );
  assertStringIncludes(
    main,
    '<div class="rev-removed" data-rev-change="true"><span class="rev-removed-badge">removed here</span></div>',
  );
  assertStringIncludes(main, "  <li>Keep bullet</li>");
  assertStringIncludes(
    main,
    '  <li class="rev-changed" data-rev-change="true">Edited bullet</li>',
  );
  assertStringIncludes(
    main,
    '  <li class="rev-changed" data-rev-change="true">Added bullet</li>',
  );

  // Revision History: only the new row (1.1.0) is highlighted; old row (1.0.0) stays plain
  assertStringIncludes(
    main,
    '<tr class="rev-changed" data-rev-change="true">\n  <td>1.1.0</td>',
  );
  assertStringIncludes(main, "<tr>\n  <td>1.0.0</td>");

  // Details table: Row C is highlighted; Row A stays plain
  assertStringIncludes(main, "<tr>\n  <td>Row A</td>");
  assertStringIncludes(
    main,
    '<tr class="rev-changed" data-rev-change="true">\n  <td>Row C</td>',
  );

  // Top banner reports exact change count + date + Next change & Hide highlights buttons
  // Changes: 1.1.0 row (1) + Overview Revised (2) + changed paragraph (3) + removed paragraph (4) + Edited bullet (5) + Added bullet (6) + Row C (7) = 7
  assertStringIncludes(main, "7 changes since you approved this on 2026-10-01");
  assertStringIncludes(main, 'id="rev-next-btn">Next change</button>');
  assertStringIncludes(main, 'id="rev-toggle-btn" aria-pressed="false">Hide highlights</button>');
});

Deno.test("Revision highlights: deletion markers inside lists and tables and singular/zero banner states", () => {
  const approvedListAndTable = `# Test

## Items

- First
- Removed item
- Last

| Col |
|---|
| Keep |
| Drop |
`;
  const revisedListAndTable = `# Test

## Items

- First
- Last

| Col |
|---|
| Keep |
`;
  const html = renderDesignDoc(revisedListAndTable, "Test", {
    approvedMarkdown: approvedListAndTable,
    approvedAt: "2026-11-20",
  });
  const main = html.split("<main>")[1]?.split("</main>")[0] ?? "";
  assertStringIncludes(
    main,
    '<li class="rev-removed-item" data-rev-change="true"><span class="rev-removed-badge">removed here</span></li>',
  );
  assertStringIncludes(
    main,
    '<tr class="rev-removed-row" data-rev-change="true">\n  <td colspan="1"><span class="rev-removed-badge">removed here</span></td>\n</tr>',
  );
  assertStringIncludes(main, "2 changes since you approved this on 2026-11-20");

  // Single change uses singular "1 change"
  const singleHtml = renderDesignDoc("# Test\n\nNew text.\n", "Test", {
    approvedMarkdown: "# Test\n\nOld text.\n",
    approvedAt: "2026-11-20",
  });
  assertStringIncludes(singleHtml, "1 change since you approved this on 2026-11-20");

  // Identical approved copy shows 0 changes with Next change button disabled
  const zeroHtml = renderDesignDoc("# Test\n\nSame text.\n", "Test", {
    approvedMarkdown: "# Test\n\nSame text.\n",
    approvedAt: "2026-11-20",
  });
  assertStringIncludes(zeroHtml, "0 changes since you approved this on 2026-11-20");
  assertStringIncludes(zeroHtml, 'id="rev-next-btn" disabled>Next change</button>');
});

Deno.test("Revision highlights: omitted approved copy and Gate 2 plan pages never render highlights or banner", () => {
  const md = `# Plan Page

## Section

Updated paragraph.
`;
  const withoutCopy = renderDesignDoc(md);
  const withoutMain = withoutCopy.split("<main>")[1]?.split("</main>")[0] ?? "";
  assertFalse(withoutMain.includes('id="rev-banner"'));
  assertFalse(withoutMain.includes("rev-changed"));
  assertFalse(withoutMain.includes("data-rev-change"));
  assertFalse(withoutMain.includes("since you approved this"));

  const planPageWithCopy = renderDesignDoc(md, "Plan Page", {
    isPlanPage: true,
    approvedMarkdown: "# Plan Page\n\n## Section\n\nOld paragraph.\n",
    approvedAt: "2026-11-20",
  });
  const planMain = planPageWithCopy.split("<main>")[1]?.split("</main>")[0] ?? "";
  assertFalse(planMain.includes('id="rev-banner"'));
  assertFalse(planMain.includes("rev-changed"));
  assertFalse(planMain.includes("data-rev-change"));
  assertFalse(planMain.includes("since you approved this"));
});

Deno.test("Revision highlights: computeNextChangeIndex advances and wraps cleanly in exported and embedded script", () => {
  assertEquals(computeNextChangeIndex(-1, 3), 0);
  assertEquals(computeNextChangeIndex(0, 3), 1);
  assertEquals(computeNextChangeIndex(1, 3), 2);
  assertEquals(computeNextChangeIndex(2, 3), 0);
  assertEquals(computeNextChangeIndex(0, 0), -1);

  const html = renderDesignDoc("# Doc\n\nAfter.\n", "Doc", {
    approvedMarkdown: "# Doc\n\nBefore.\n",
    approvedAt: "2026-11-20",
  });
  const embedded = html.match(/var computeNext = ([\s\S]*?);\s*var changes =/);
  assert(embedded, "Generated HTML must include computeNext helper");
  const computeEmbedded = new Function(
    `return (${embedded[1]});`,
  )() as typeof computeNextChangeIndex;
  for (const [idx, total] of [[-1, 4], [0, 4], [3, 4], [0, 0]] as const) {
    assertEquals(computeEmbedded(idx, total), computeNextChangeIndex(idx, total));
  }
});

Deno.test("Revision highlights: a deleted block replaced by a block of another kind still gets a removed marker", () => {
  const removedMarker =
    '<div class="rev-removed" data-rev-change="true"><span class="rev-removed-badge">removed here</span></div>';
  const count = (html: string) => html.split(removedMarker).length - 1;
  const render = (approvedMarkdown: string, revised: string) =>
    renderDesignDoc(revised, "Test", { approvedMarkdown, approvedAt: "2026-11-20" });

  // Approved list replaced by a paragraph: marker, then the highlighted paragraph.
  const listToParagraph = render(
    "# Test\n\n## Items\n\n- old a\n- old b\n",
    "# Test\n\n## Items\n\nBrand new paragraph.\n",
  );
  const listMain = listToParagraph.split("<main>")[1]?.split("</main>")[0] ?? "";
  assertEquals(count(listMain), 1);
  assertStringIncludes(
    listMain,
    '<p class="rev-changed" data-rev-change="true">Brand new paragraph.</p>',
  );
  assertStringIncludes(listMain, "2 changes since you approved this on 2026-11-20");
  assert(
    listMain.indexOf(removedMarker) <
      listMain.indexOf('<p class="rev-changed" data-rev-change="true">Brand new paragraph.</p>'),
    "marker stands where the deleted list was, before its replacement",
  );

  // Paragraph replaced by a table, and a code block replaced by a paragraph, behave the same.
  const paragraphToTable = render(
    "# Test\n\n## Items\n\nOld paragraph text.\n",
    "# Test\n\n## Items\n\n| A |\n|---|\n| 1 |\n",
  );
  assertEquals(count(paragraphToTable.split("<main>")[1] ?? ""), 1);
  const codeToParagraph = render(
    "# Test\n\n## Items\n\n```\nold code\n```\n",
    "# Test\n\n## Items\n\nReplacement paragraph.\n",
  );
  assertEquals(count(codeToParagraph.split("<main>")[1] ?? ""), 1);

  // Two paragraphs replaced by one still renders exactly one marker (unchanged behaviour).
  const twoToOne = render(
    "# Test\n\n## Items\n\nFirst old paragraph.\n\nSecond old paragraph.\n",
    "# Test\n\n## Items\n\nOne new paragraph.\n",
  );
  assertEquals(count(twoToOne.split("<main>")[1] ?? ""), 1);
});

Deno.test("computePagerRowModel: marker rows are never counted and follow their anchor data row", () => {
  assertEquals(computePagerRowModel([]), { dataRowIndexes: [], markers: [] });
  assertEquals(computePagerRowModel([false, false]), { dataRowIndexes: [0, 1], markers: [] });
  assertEquals(computePagerRowModel([false, true, false, true, true]), {
    dataRowIndexes: [0, 2],
    markers: [
      { rowIndex: 1, anchor: 1 },
      { rowIndex: 3, anchor: 1 },
      { rowIndex: 4, anchor: 1 },
    ],
  });
  // A leading marker stays with the first data row; only markers means nothing to page.
  assertEquals(computePagerRowModel([true, false]), {
    dataRowIndexes: [1],
    markers: [{ rowIndex: 0, anchor: 0 }],
  });
  assertEquals(computePagerRowModel([true]), {
    dataRowIndexes: [],
    markers: [{ rowIndex: 0, anchor: 0 }],
  });
});

Deno.test("Revision highlights: removed-here table rows stay out of the pager's row count", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `| Row ${i + 1} |`).join("\n");
  const approved = `# Test\n\n## Rows\n\n| Col |\n|---|\n${rows(11)}\n`;
  const revised = `# Test\n\n## Rows\n\n| Col |\n|---|\n${rows(10)}\n`;
  const html = renderDesignDoc(revised, "Test", {
    approvedMarkdown: approved,
    approvedAt: "2026-11-20",
  });
  const tbody = html.split("<tbody>")[1]?.split("</tbody>")[0] ?? "";

  // The marker is a real <tr>, so the table holds 11 <tr>s but only 10 data rows.
  assertEquals(tbody.split("<tr").length - 1, 11);
  assertEquals(tbody.split('class="rev-removed-row"').length - 1, 1);

  // The page script derives its row list from the model, so the marker is not a counted row.
  const embedded = html.match(/var computeRowModel = ([\s\S]*?);\s*var computePagination =/);
  assert(embedded, "Generated HTML must include the computeRowModel helper");
  const computeEmbedded = new Function(
    `return (${embedded[1]});`,
  )() as typeof computePagerRowModel;
  const flags = Array.from({ length: 11 }, (_, i) => i === 10);
  assertEquals(computeEmbedded(flags), computePagerRowModel(flags));
  assertEquals(computePagerRowModel(flags).dataRowIndexes.length, 10);
  assertFalse(
    html.includes('var rows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));'),
  );
});
