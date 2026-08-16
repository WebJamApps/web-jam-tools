import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { parseInlineMarkdown, renderDesignDoc, slugify } from "../scripts/render_design_doc.ts";

const SCRIPT_PATH = new URL("../scripts/render-design-doc.sh", import.meta.url).pathname;

Deno.test("slugify converts heading titles into clean URLs", () => {
  assertEquals(slugify("The renames!"), "the-renames");
  assertEquals(slugify("Appendix A — ground details"), "appendix-a-ground-details");
  assertEquals(slugify("  Multiple   Spaces  "), "multiple-spaces");
});

Deno.test("parseInlineMarkdown converts inline emphasis, links, and code spans", () => {
  assertEquals(parseInlineMarkdown("`code`"), "<code>code</code>");
  assertEquals(
    parseInlineMarkdown("[Google](https://google.com)"),
    '<a href="https://google.com">Google</a>',
  );
  assertEquals(parseInlineMarkdown("**bold**"), "<strong>bold</strong>");
  assertEquals(parseInlineMarkdown("*italic*"), "<em>italic</em>");
  assertEquals(
    parseInlineMarkdown("Text with `code`, **bold**, and *italic*."),
    "Text with <code>code</code>, <strong>bold</strong>, and <em>italic</em>.",
  );
});

Deno.test("renderDesignDoc converts markdown structure and builds TOC from H2 headings", () => {
  const md = `# Document Title

## Section One
First section text.

## Section Two
Second section text.
`;
  const html = renderDesignDoc(md);

  assertStringIncludes(html, "<title>Document Title</title>");
  assertStringIncludes(html, '<nav class="toc">');
  assertStringIncludes(html, '<a href="#section-one">Section One</a>');
  assertStringIncludes(html, '<a href="#section-two">Section Two</a>');
  assertStringIncludes(html, '<h2 id="section-one">Section One</h2>');
  assertStringIncludes(html, '<h2 id="section-two">Section Two</h2>');
});

Deno.test("renderDesignDoc folds H3 sections under Appendix H2 into disclosure details elements", () => {
  const md = `# Title

## Appendix A — Ground

### Rule 1
First rule description.

### Rule 2
Second rule description.

## Normal Section
### Normal H3
Normal content.
`;
  const html = renderDesignDoc(md);

  assertStringIncludes(html, "<details>\n  <summary>Rule 1</summary>");
  assertStringIncludes(html, "<details>\n  <summary>Rule 2</summary>");
  assertStringIncludes(html, "<h3>Normal H3</h3>");
});

Deno.test("renderDesignDoc implements all seven layout rules", () => {
  const md = `# Sample Design Doc
## Overview
| Col A | Col B |
| --- | --- |
| Val 1 | Val 2 |

\`\`\`ts
const x = 10;
\`\`\`
`;
  const html = renderDesignDoc(md);

  // Rule 2: Media queries at the END of stylesheet
  const cssTocBasePos = html.indexOf("nav.toc {\n      display: none;\n    }");
  const mediaQueryPos = html.indexOf("@media (min-width: 1080px)");
  assertEquals(cssTocBasePos > -1, true, "base nav.toc CSS rule found");
  assertEquals(mediaQueryPos > -1, true, "@media query found");
  assertEquals(
    mediaQueryPos > cssTocBasePos,
    true,
    "Media queries sit at the END of stylesheet after base rules",
  );

  // Rule 3: Container sets width: 100%
  assertStringIncludes(html, "width: 100%;");

  // Rule 4: Three-place theme tokens & explicit body background
  assertStringIncludes(html, '<html lang="en" data-theme="dark">');
  assertStringIncludes(html, ":root {");
  assertStringIncludes(html, "@media (prefers-color-scheme: dark)");
  assertStringIncludes(html, ':root[data-theme="dark"]');
  assertStringIncludes(html, "body {\n      background-color: var(--bg-color);");

  // Rule 5: Wide content overflow
  assertStringIncludes(html, ".table-wrapper, pre {\n      overflow-x: auto;");
  assertStringIncludes(html, "overflow-wrap: anywhere;");

  // Rule 6: No external assets (no http/https link stylesheets or external scripts)
  assertMatch(html, /^((?!<link[^>]+rel=["']stylesheet["'][^>]+href=["']http).)*$/s);

  // Rule 7: Viewport meta tag plus real title tag
  assertStringIncludes(
    html,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
  );
  assertStringIncludes(html, "<title>Sample Design Doc</title>");
});

Deno.test("scripts/render-design-doc.sh wrapper renders markdown file to HTML file", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "render-doc-test-" });
  const inputMd = `${tempDir}/input.md`;
  const outputHtml = `${tempDir}/output.html`;

  await Deno.writeTextFile(
    inputMd,
    `# E2E Test Doc

## Feature Section
This is a test feature.

| Feature | Status |
| --- | --- |
| Render | Done |

## Appendix B
### Captured Rule
Details here.
`,
  );

  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH, inputMd, outputHtml],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();

  assertEquals(code, 0, `stderr: ${new TextDecoder().decode(stderr)}`);

  const renderedHtml = await Deno.readTextFile(outputHtml);
  assertStringIncludes(renderedHtml, "<title>E2E Test Doc</title>");
  assertStringIncludes(renderedHtml, '<nav class="toc">');
  assertStringIncludes(renderedHtml, '<a href="#feature-section">Feature Section</a>');
  assertStringIncludes(renderedHtml, "<details>\n  <summary>Captured Rule</summary>");
});
