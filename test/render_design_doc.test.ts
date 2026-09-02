// test/render_design_doc.test.ts — web-jam-tools#892
//
// Unit and integration tests for scripts/render_design_doc.ts:
// 1. Raw inline and block SVG rendering (AC1, AC2)
// 2. Table column sizing and overflow prevention (AC3, AC4)
// 3. Section navigation collapse and restore controls (AC5)
// 4. Document version and revision date declarations in header (AC6)

import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import {
  parseInlineMarkdown,
  renderDesignDoc,
  renderDesignDocFile,
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
  const md = `# Design with SVG

## Diagram Section

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 200" width="100%">
  <rect width="100" height="50" fill="#60a5fa" />
  <text x="10" y="30">Hello SVG</text>
</svg>

Inline diagram: <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg> in text.
`;

  const html = renderDesignDoc(md);

  assertFalse(html.includes("&lt;svg"));
  assertFalse(html.includes("&lt;/svg&gt;"));
  assertStringIncludes(html, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 200"');
  assertStringIncludes(html, '<circle cx="10" cy="10" r="8"/>');
  assertStringIncludes(html, "</svg>");
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
  assertStringIncludes(html, "overflow-wrap: break-word;");
  assertStringIncludes(html, "white-space: nowrap;");
  assertStringIncludes(html, ".table-wrapper, pre");
  assertStringIncludes(html, "overflow-x: auto;");
  assertStringIncludes(html, "max-width: 100%;");
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

Deno.test("AC6: Document with ## Revision History table renders newest version and date in header and renders table in place", () => {
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
  assertStringIncludes(mainWithTable, '<header class="doc-header">');
  assertStringIncludes(mainWithTable, '<div class="doc-version-line">');
  assertStringIncludes(mainWithTable, '<span class="doc-version">Version: 2.1.0</span>');
  assertStringIncludes(mainWithTable, '<span class="doc-revised">Revised: 2026-09-02</span>');
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
    assertStringIncludes(generatedHtml, "Version: 1.0.0");
    assertStringIncludes(generatedHtml, "Revised: 2026-09-02");
    assertStringIncludes(generatedHtml, "nav-collapse-btn");
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
  }
});
