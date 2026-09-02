import * as path from "jsr:@std/path@^1.0.0";

/**
 * Converts a text heading into a URL-friendly slug.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Escapes HTML special characters.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Parses inline Markdown elements (code spans, links, bold, italic).
 */
export function parseInlineMarkdown(text: string): string {
  const codeSpans: string[] = [];
  let placeholderText = text.replace(/`([^`]+)`/g, (_match, codeContent) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code>${escapeHtml(codeContent)}</code>`);
    return `%%CODESPAN${idx}%%`;
  });

  const svgBlocks: string[] = [];
  placeholderText = placeholderText.replace(
    /<svg[\s\S]*?<\/svg>/gi,
    (match) => {
      const idx = svgBlocks.length;
      svgBlocks.push(match);
      return `%%SVGBLOCK${idx}%%`;
    },
  );

  placeholderText = escapeHtml(placeholderText);

  // Links: [text](url)
  placeholderText = placeholderText.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, linkText, url) => {
      return `<a href="${url}">${linkText}</a>`;
    },
  );

  // Bold & Italic: ***text*** or ___text___
  placeholderText = placeholderText.replace(
    /\*\*\*([^*]+)\*\*\*/g,
    "<strong><em>$1</em></strong>",
  );
  placeholderText = placeholderText.replace(
    /___([^_]+)___/g,
    "<strong><em>$1</em></strong>",
  );

  // Bold: **text** or __text__
  placeholderText = placeholderText.replace(
    /\*\*([^*]+)\*\*/g,
    "<strong>$1</strong>",
  );
  placeholderText = placeholderText.replace(
    /__([^_]+)__/g,
    "<strong>$1</strong>",
  );

  // Italic: *text* or _text_
  placeholderText = placeholderText.replace(
    /\*([^*]+)\*/g,
    "<em>$1</em>",
  );
  placeholderText = placeholderText.replace(
    /_([^_]+)_/g,
    "<em>$1</em>",
  );

  // Restore code spans
  placeholderText = placeholderText.replace(
    /%%CODESPAN(\d+)%%/g,
    (_match, idxStr) => {
      return codeSpans[parseInt(idxStr, 10)];
    },
  );

  // Restore SVG blocks
  placeholderText = placeholderText.replace(
    /%%SVGBLOCK(\d+)%%/g,
    (_match, idxStr) => {
      return svgBlocks[parseInt(idxStr, 10)];
    },
  );

  return placeholderText;
}

/**
 * Converts a Markdown document into a standalone HTML document adhering to design rules.
 */
function stripCellDecoration(cell: string): string {
  return cell.replace(/[`*_"'“”‘’]/g, "").trim();
}

export function renderDesignDoc(
  markdownContent: string,
  fallbackTitle: string = "Design Document",
): string {
  const lines = markdownContent.split(/\r?\n/);

  let documentTitle = fallbackTitle;
  let version = "";
  let revised = "";
  const tocEntries: Array<{ title: string; slug: string }> = [];
  const usedSlugs = new Set<string>();

  // Pass 1: Extract document title, revision history version/date, and H2 TOC entries
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("# ") && documentTitle === fallbackTitle) {
      documentTitle = line.substring(2).trim();
    } else if (line.startsWith("## ")) {
      const headingText = line.substring(3).trim();
      const cleanTitle = headingText
        .replace(/[*_`[\]]/g, "")
        .replace(/\([^)]*\)/g, "")
        .trim();
      const baseSlug = slugify(cleanTitle) || "section";
      let slug = baseSlug;
      let counter = 1;
      while (usedSlugs.has(slug)) {
        slug = `${baseSlug}-${counter++}`;
      }
      usedSlugs.add(slug);
      tocEntries.push({ title: cleanTitle || headingText, slug });

      if (/^Revision\s+History$/i.test(cleanTitle)) {
        // Look ahead for the table under ## Revision History
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === "") {
          j++;
        }
        if (j < lines.length && lines[j].trim().startsWith("|")) {
          const tableLines: string[] = [];
          while (
            j < lines.length &&
            lines[j].trim().startsWith("|") &&
            lines[j].trim().endsWith("|")
          ) {
            tableLines.push(lines[j].trim());
            j++;
          }
          if (tableLines.length >= 3) {
            const parseRow = (rowStr: string) => {
              return rowStr
                .substring(1, rowStr.length - 1)
                .split("|")
                .map((c) => c.trim());
            };
            const headerCells = parseRow(tableLines[0]);
            const versionIdx = headerCells.findIndex((c) =>
              /^version$/i.test(stripCellDecoration(c))
            );
            const dateIdx = headerCells.findIndex((c) =>
              /^date$/i.test(stripCellDecoration(c))
            );
            if (versionIdx !== -1 && dateIdx !== -1) {
              const dataRows = tableLines.slice(2).map(parseRow);
              if (dataRows.length > 0) {
                // Newest row is the last row (oldest-to-newest order)
                const lastRow = dataRows[dataRows.length - 1];
                version = stripCellDecoration(lastRow[versionIdx] ?? "");
                revised = stripCellDecoration(lastRow[dateIdx] ?? "");
              }
            }
          }
        }
      }
    }
  }

  // Generate TOC HTML
  let tocHtml = "";
  if (tocEntries.length > 0) {
    tocHtml =
      `<button type="button" class="nav-restore-btn" id="nav-restore-btn" aria-label="Restore section navigation" title="Restore section navigation">▶ Sections</button>\n` +
      `<nav class="toc">\n` +
      `  <div class="toc-header">\n` +
      `    <h2>Sections</h2>\n` +
      `    <button type="button" class="nav-collapse-btn" id="nav-collapse-btn" aria-label="Collapse section navigation" title="Collapse section navigation">◀</button>\n` +
      `  </div>\n  <ul>\n`;
    for (const entry of tocEntries) {
      tocHtml += `    <li><a href="#${entry.slug}">${escapeHtml(entry.title)}</a></li>\n`;
    }
    tocHtml += `  </ul>\n</nav>`;
  }

  // Pass 2: Parse blocks into body HTML
  const bodyHtmlParts: string[] = [];
  let inAppendix = false;
  let inAppendixDetails = false;
  let h2Count = 0;
  let hasRenderedHeader = false;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block: ```
    if (line.trim().startsWith("```")) {
      const lang = line.trim().substring(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      const escapedCode = escapeHtml(codeLines.join("\n"));
      const codeClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      bodyHtmlParts.push(`<pre><code${codeClass}>${escapedCode}</code></pre>`);
      continue;
    }

    // Raw SVG block
    if (line.trim().startsWith("<svg")) {
      const svgLines: string[] = [];
      while (i < lines.length) {
        svgLines.push(lines[i]);
        if (lines[i].includes("</svg>")) {
          i++;
          break;
        }
        i++;
      }
      bodyHtmlParts.push(svgLines.join("\n"));
      continue;
    }

    // Headings
    if (line.startsWith("#")) {
      const match = line.match(/^(#{1,6})\s+(.*)$/);
      if (match) {
        const level = match[1].length;
        const text = match[2].trim();

        if (level === 1) {
          hasRenderedHeader = true;
          if (version || revised) {
            let metaHtml = `<div class="doc-version-line">\n`;
            if (version) {
              metaHtml += `    <span class="doc-version">Version: ${escapeHtml(version)}</span>\n`;
            }
            if (revised) {
              metaHtml += `    <span class="doc-revised">Revised: ${escapeHtml(revised)}</span>\n`;
            }
            metaHtml += `  </div>`;
            bodyHtmlParts.push(
              `<header class="doc-header">\n  <h1>${parseInlineMarkdown(text)}</h1>\n  ${metaHtml}\n</header>`,
            );
          } else {
            bodyHtmlParts.push(`<h1>${parseInlineMarkdown(text)}</h1>`);
          }
        } else if (level === 2) {
          if (!hasRenderedHeader && (version || revised)) {
            hasRenderedHeader = true;
            let metaHtml = `<div class="doc-version-line">\n`;
            if (version) {
              metaHtml += `    <span class="doc-version">Version: ${escapeHtml(version)}</span>\n`;
            }
            if (revised) {
              metaHtml += `    <span class="doc-revised">Revised: ${escapeHtml(revised)}</span>\n`;
            }
            metaHtml += `  </div>`;
            bodyHtmlParts.push(
              `<header class="doc-header">\n  <h1>${escapeHtml(documentTitle)}</h1>\n  ${metaHtml}\n</header>`,
            );
          }
          if (inAppendixDetails) {
            bodyHtmlParts.push(`</div>\n</details>`);
            inAppendixDetails = false;
          }
          const entry = tocEntries[h2Count];
          const slug = entry ? entry.slug : slugify(text);
          h2Count++;

          inAppendix = /\bappendix\b/i.test(text);
          bodyHtmlParts.push(
            `<h2 id="${slug}">${parseInlineMarkdown(text)}</h2>`,
          );
        } else if (level === 3) {
          if (inAppendix) {
            if (inAppendixDetails) {
              bodyHtmlParts.push(`</div>\n</details>`);
            }
            bodyHtmlParts.push(
              `<details>\n  <summary>${
                parseInlineMarkdown(text)
              }</summary>\n  <div class="appendix-content">`,
            );
            inAppendixDetails = true;
          } else {
            bodyHtmlParts.push(`<h3>${parseInlineMarkdown(text)}</h3>`);
          }
        } else {
          const hTag = `h${level}`;
          bodyHtmlParts.push(`<${hTag}>${parseInlineMarkdown(text)}</${hTag}>`);
        }
        i++;
        continue;
      }
    }

    // Horizontal rule
    if (/^(---|[*]{3}|_{3})$/.test(line.trim())) {
      bodyHtmlParts.push(`<hr>`);
      i++;
      continue;
    }

    // Table
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      const tableLines: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim().startsWith("|") &&
        lines[i].trim().endsWith("|")
      ) {
        tableLines.push(lines[i].trim());
        i++;
      }
      if (tableLines.length >= 2) {
        const parseRow = (rowStr: string) => {
          return rowStr
            .substring(1, rowStr.length - 1)
            .split("|")
            .map((c) => c.trim());
        };
        const headerCells = parseRow(tableLines[0]);
        const bodyRows = tableLines.slice(2).map(parseRow);

        let tableHtml = `<div class="table-wrapper">\n<table>\n<thead>\n<tr>\n`;
        for (const cell of headerCells) {
          tableHtml += `  <th>${parseInlineMarkdown(cell)}</th>\n`;
        }
        tableHtml += `</tr>\n</thead>\n<tbody>\n`;
        for (const row of bodyRows) {
          tableHtml += `<tr>\n`;
          for (const cell of row) {
            tableHtml += `  <td>${parseInlineMarkdown(cell)}</td>\n`;
          }
          tableHtml += `</tr>\n`;
        }
        tableHtml += `</tbody>\n</table>\n</div>`;
        bodyHtmlParts.push(tableHtml);
      }
      continue;
    }

    // Blockquote: lines starting with >
    if (line.trim().startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        let qLine = lines[i].trim().substring(1);
        if (qLine.startsWith(" ")) qLine = qLine.substring(1);
        quoteLines.push(qLine);
        i++;
      }
      const quoteContent = quoteLines
        .map((l) => parseInlineMarkdown(l))
        .join("<br>\n");
      bodyHtmlParts.push(`<blockquote>${quoteContent}</blockquote>`);
      continue;
    }

    // List: unordered (- , * , + ) or ordered (\d+\. )
    const ulMatch = line.trim().match(/^([-*+])\s+(.*)$/);
    const olMatch = line.trim().match(/^(\d+)\.\s+(.*)$/);
    if (ulMatch || olMatch) {
      const isOl = !!olMatch;
      const tag = isOl ? "ol" : "ul";
      const listItems: string[] = [];
      while (i < lines.length) {
        const itemLine = lines[i].trim();
        const m = isOl ? itemLine.match(/^(\d+)\.\s+(.*)$/) : itemLine.match(/^([-*+])\s+(.*)$/);
        if (m) {
          listItems.push(m[2]);
          i++;
        } else {
          break;
        }
      }
      let listHtml = `<${tag}>\n`;
      for (const item of listItems) {
        listHtml += `  <li>${parseInlineMarkdown(item)}</li>\n`;
      }
      listHtml += `</${tag}>`;
      bodyHtmlParts.push(listHtml);
      continue;
    }

    // Paragraph
    const paragraphLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trim().startsWith("```") &&
      !lines[i].startsWith("#") &&
      !/^(---|[*]{3}|_{3})$/.test(lines[i].trim()) &&
      !(lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) &&
      !lines[i].trim().startsWith(">") &&
      !lines[i].trim().match(/^([-*+])\s+/) &&
      !lines[i].trim().match(/^(\d+)\.\s+/) &&
      !lines[i].trim().startsWith("<svg")
    ) {
      paragraphLines.push(lines[i]);
      i++;
    }
    if (paragraphLines.length > 0) {
      const paraText = paragraphLines.join("\n");
      bodyHtmlParts.push(`<p>${parseInlineMarkdown(paraText)}</p>`);
    }
  }

  if (inAppendixDetails) {
    bodyHtmlParts.push(`</div>\n</details>`);
  }

  const bodyHtml = bodyHtmlParts.join("\n\n");

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(documentTitle)}</title>
  <style>
    :root {
      --bg-color: #ffffff;
      --text-color: #1a1a1a;
      --toc-bg: #f8f9fa;
      --toc-border: #e9ecef;
      --border-color: #dee2e6;
      --code-bg: #f6f8fa;
      --link-color: #0969da;
      --quote-border: #d0d7de;
      --header-bg: #ffffff;
      --details-bg: #f8f9fa;
    }

    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --bg-color: #0d1117;
        --text-color: #c9d1d9;
        --toc-bg: #161b22;
        --toc-border: #30363d;
        --border-color: #30363d;
        --code-bg: #161b22;
        --link-color: #58a6ff;
        --quote-border: #30363d;
        --header-bg: #0d1117;
        --details-bg: #161b22;
      }
    }

    :root[data-theme="dark"] {
      --bg-color: #0d1117;
      --text-color: #c9d1d9;
      --toc-bg: #161b22;
      --toc-border: #30363d;
      --border-color: #30363d;
      --code-bg: #161b22;
      --link-color: #58a6ff;
      --quote-border: #30363d;
      --header-bg: #0d1117;
      --details-bg: #161b22;
    }

    body {
      background-color: var(--bg-color);
      color: var(--text-color);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      margin: 0;
      padding: 0;
      overflow-wrap: anywhere;
    }

    p, td, li, th, blockquote, h1, h2, h3, h4, h5, h6 {
      overflow-wrap: anywhere;
    }

    .container {
      width: 100%;
      max-width: 1400px;
      margin: 0 auto;
      padding: 24px;
      box-sizing: border-box;
    }

    .layout {
      display: block;
    }

    main {
      min-width: 0;
    }

    .doc-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 16px;
    }

    .doc-header h1 {
      margin: 0;
    }

    .doc-version-line {
      display: flex;
      gap: 16px;
      font-size: 0.95rem;
      color: var(--text-color);
      opacity: 0.8;
    }

    .table-wrapper, pre {
      overflow-x: auto;
      max-width: 100%;
    }

    table {
      border-collapse: collapse;
      margin: 1rem 0;
      width: max-content;
      max-width: none;
    }

    th, td {
      border: 1px solid var(--border-color);
      padding: 8px 12px;
      text-align: left;
      max-width: 500px;
      overflow-wrap: break-word;
    }

    th {
      background-color: var(--toc-bg);
      white-space: nowrap;
    }

    pre {
      background-color: var(--code-bg);
      padding: 16px;
      border-radius: 6px;
      border: 1px solid var(--border-color);
    }

    code {
      font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
      font-size: 0.9em;
      overflow-wrap: anywhere;
    }

    p code, li code, td code, th code {
      background-color: var(--code-bg);
      padding: 0.2em 0.4em;
      border-radius: 3px;
    }

    blockquote {
      border-left: 4px solid var(--quote-border);
      margin: 1em 0;
      padding-left: 1em;
      opacity: 0.9;
    }

    details {
      background-color: var(--details-bg);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 12px 16px;
      margin: 1em 0;
    }

    summary {
      font-weight: 600;
      cursor: pointer;
    }

    summary h3 {
      display: inline;
      font-size: 1.1em;
      margin: 0;
    }

    nav.toc {
      display: none;
    }

    .toc-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }

    .toc-header h2 {
      font-size: 1rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin: 0;
      color: var(--text-color);
      opacity: 0.8;
    }

    .nav-collapse-btn {
      background: transparent;
      border: 1px solid var(--border-color);
      color: var(--text-color);
      border-radius: 4px;
      padding: 2px 8px;
      font-size: 0.85rem;
      cursor: pointer;
      opacity: 0.7;
      line-height: 1;
    }

    .nav-collapse-btn:hover {
      opacity: 1;
      background-color: var(--code-bg);
    }

    .nav-restore-btn {
      display: none;
    }

    a {
      color: var(--link-color);
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    hr {
      border: 0;
      height: 1px;
      background: var(--border-color);
      margin: 2rem 0;
    }

    /* MEDIA QUERIES AT THE END OF THE STYLESHEET */
    @media (min-width: 1080px) {
      .layout {
        display: grid;
        grid-template-columns: 280px minmax(0, 1fr);
        gap: 40px;
        align-items: start;
      }
      .layout.nav-collapsed {
        display: block;
      }
      .layout.nav-collapsed nav.toc {
        display: none;
      }
      .layout.nav-collapsed .nav-restore-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        position: fixed;
        top: 20px;
        left: 20px;
        z-index: 100;
        background-color: var(--toc-bg);
        color: var(--text-color);
        border: 1px solid var(--toc-border);
        border-radius: 6px;
        padding: 6px 12px;
        cursor: pointer;
        font-size: 0.85rem;
        font-weight: 500;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
      }
      .layout.nav-collapsed .nav-restore-btn:hover {
        background-color: var(--code-bg);
      }
      nav.toc {
        display: block;
        position: sticky;
        top: 24px;
        max-height: calc(100vh - 48px);
        overflow-y: auto;
        background-color: var(--toc-bg);
        border: 1px solid var(--toc-border);
        border-radius: 6px;
        padding: 20px;
      }
      nav.toc ul {
        list-style: none;
        padding-left: 0;
        margin: 0;
      }
      nav.toc li {
        margin-bottom: 8px;
        font-size: 0.95rem;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="layout">
      ${tocHtml}
      <main>
        ${bodyHtml}
      </main>
    </div>
  </div>
  <script>
    (function() {
      var collapseBtn = document.getElementById("nav-collapse-btn");
      var restoreBtn = document.getElementById("nav-restore-btn");
      var layout = document.querySelector(".layout");
      if (collapseBtn && layout) {
        collapseBtn.addEventListener("click", function() {
          layout.classList.add("nav-collapsed");
        });
      }
      if (restoreBtn && layout) {
        restoreBtn.addEventListener("click", function() {
          layout.classList.remove("nav-collapsed");
        });
      }
    })();
  </script>
</body>
</html>
`;
}

export function renderDesignDocFile(
  inputPath: string,
  outputPath: string,
): void {
  const content = Deno.readTextFileSync(inputPath);
  const fallbackTitle = path.basename(inputPath, path.extname(inputPath));
  const html = renderDesignDoc(content, fallbackTitle);
  Deno.writeTextFileSync(outputPath, html);
}

if (import.meta.main) {
  const args = Deno.args;
  if (args.length < 2) {
    console.error(
      "Usage: render_design_doc.ts <input_markdown_path> <output_html_path>",
    );
    Deno.exit(1);
  }
  try {
    renderDesignDocFile(args[0], args[1]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error rendering design doc: ${message}`);
    Deno.exit(1);
  }
}
