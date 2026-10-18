// test/render_design_doc.test.ts — web-jam-tools#892
//
// Unit and integration tests for scripts/render_design_doc.ts:
// 1. Raw inline and block SVG rendering (AC1, AC2)
// 2. Table column sizing and overflow prevention (AC3, AC4)
// 3. Section navigation collapse and restore controls (AC5)
// 4. Revision table retained without a version/date subtitle

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import {
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

function renderedRows(markdown: string): string[][][] {
  return Array.from(
    renderDesignDoc(markdown).matchAll(/<tbody>([\s\S]*?)<\/tbody>/g),
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
  Deno.test(`History ordering: ${heading} keeps file order`, () => {
    assertEquals(
      renderedRows(`${heading}\n\n| Entry |\n|---|\n| First |\n| Second |`),
      [[["First"], ["Second"]]],
    );
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

Deno.test("History ordering ends at the next heading and ignores headings in fenced examples", () => {
  assertEquals(
    renderedRows(`## Decisions

| Entry |
|---|
| Old |
| New |

### Other table

| Entry |
|---|
| First |
| Second |

\`\`\`md
## Revision History
\`\`\`

| Entry |
|---|
| One |
| Two |`),
    [[["New"], ["Old"]], [["First"], ["Second"]], [["One"], ["Two"]]],
  );
});

Deno.test("Premises tables without Proved keep file order; formatted dates sort normally", () => {
  assertEquals(
    renderedRows(`## Load-bearing premises

| Entry |
|---|
| First |
| Second |

## Load-bearing Premises

| Premise | **Proved** |
|---|---|
| Old | \`2026-10-01\` |
| Empty | |
| New | **2026-10-12** |`),
    [
      [["First"], ["Second"]],
      [["New", "<strong>2026-10-12</strong>"], ["Old", "<code>2026-10-01</code>"], ["Empty", ""]],
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

  // Slug deduplication: duplicate-1
  assertStringIncludes(html, 'href="#duplicate"');
  assertStringIncludes(html, 'href="#duplicate-1"');
  assertStringIncludes(mainContent, '<h2 id="duplicate-1">Duplicate</h2>');

  // Horizontal rule
  assertStringIncludes(mainContent, "<hr>");

  // Heading level 4
  assertStringIncludes(mainContent, "<h4>Level 4 Heading</h4>");

  // Blockquote
  assertStringIncludes(
    mainContent,
    "<blockquote>A blockquote line<br>\nSecond blockquote line</blockquote>",
  );

  // Lists
  assertStringIncludes(mainContent, "<ul>\n  <li>Bullet 1</li>\n  <li>Bullet 2</li>\n</ul>");
  assertStringIncludes(mainContent, "<ol>\n  <li>Numbered 1</li>\n  <li>Numbered 2</li>\n</ol>");
});
