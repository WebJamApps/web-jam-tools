import * as path from "jsr:@std/path@^1.0.0";
import type { OtherDesignSweepResult } from "../src/design-issue/gate1_record.ts";
import { slugify, toLocalIsoDate } from "../src/design-issue/lint_doc.ts";
import { PLAN_TABLE_HEADER } from "../src/design-issue/plan_table.ts";

export { slugify };

export interface RenderDesignDocOptions {
  /** Render as a Gate 2 issue plan page (file row order, total row count, pager opens on "All"). */
  isPlanPage?: boolean;
  /** Render the Gate 1 cross-design sweep summary table when present. */
  otherDesignSweep?: OtherDesignSweepResult;
  /** Directory containing the Markdown document, used to resolve local image files safely. */
  docDir?: string;
  /** Temporary approved Markdown copy used to render subtle yellow revision highlights. */
  approvedMarkdown?: string;
  /** ISO timestamp or YYYY-MM-DD approval date shown in the revision banner. */
  approvedAt?: string;
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
 * Sanitizes an SVG markup string by stripping <script> elements, event handler
 * attributes (e.g. onload, onclick), javascript: URIs, and dangerous embedded
 * objects (<foreignObject>, <iframe>) to prevent XSS execution while preserving
 * safe diagram elements and visual styling attributes.
 */
export function sanitizeSvg(svgMarkup: string): string {
  let sanitized = svgMarkup;
  // 1. Strip <script> elements (both paired tags and self-closing/unclosed)
  sanitized = sanitized.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
  sanitized = sanitized.replace(/<script\b[^>]*>/gi, "");

  // 2. Strip event handler attributes (onload, onclick, onerror, onmouseover, onbegin, etc.)
  sanitized = sanitized.replace(
    /\s+on[a-zA-Z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s>]+)/gi,
    "",
  );

  // 3. Strip javascript: URIs in href and xlink:href attributes
  sanitized = sanitized.replace(
    /((?:xlink:)?href)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|`\s*javascript:[^`]*`|javascript:[^\s>]+)/gi,
    "",
  );

  // 4. Strip <foreignObject> and <iframe> elements for defense in depth
  sanitized = sanitized.replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, "");
  sanitized = sanitized.replace(/<foreignObject\b[^>]*>/gi, "");
  sanitized = sanitized.replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, "");
  sanitized = sanitized.replace(/<iframe\b[^>]*>/gi, "");

  return sanitized;
}

/**
 * Checks whether a closing </svg> tag appears in lines at or after startIndex.
 */
function hasClosingSvg(lines: string[], startIndex: number): boolean {
  for (let k = startIndex; k < lines.length; k++) {
    if (lines[k].includes("</svg>")) {
      return true;
    }
  }
  return false;
}

const ALLOWED_IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Renders Markdown image syntax (`![alt](target)`) as an embedded `data:` URI `<img>` only when the
 * target `.png`, `.jpg`, `.webp`, or `.svg` file exists inside `docDir` and is readable as a
 * regular file. Remote URLs, paths escaping the document folder (literal or percent-encoded),
 * missing files, omitted `docDir`, and non-image extensions are never loaded and stay escaped
 * plain text.
 */
function renderMarkdownImage(
  fullMatch: string,
  alt: string,
  rawTarget: string,
  docDir?: string,
): string {
  const target = rawTarget.trim();
  if (
    !docDir ||
    !target ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) ||
    target.startsWith("/") ||
    target.includes("\\")
  ) {
    return escapeHtml(fullMatch);
  }

  const ext = path.extname(target).toLowerCase();
  const mimeType = ALLOWED_IMAGE_MIME_TYPES[ext];
  if (!mimeType) {
    return escapeHtml(fullMatch);
  }

  const resolvedDocDir = path.resolve(docDir);
  const resolvedFile = path.resolve(resolvedDocDir, target);
  const rel = path.relative(resolvedDocDir, resolvedFile);
  if (!rel || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) {
    return escapeHtml(fullMatch);
  }

  try {
    const realDocDir = Deno.realPathSync(resolvedDocDir);
    const realFile = Deno.realPathSync(resolvedFile);
    const realRel = path.relative(realDocDir, realFile);
    if (!realRel || realRel === "." || realRel.startsWith("..") || path.isAbsolute(realRel)) {
      return escapeHtml(fullMatch);
    }
    const stat = Deno.statSync(realFile);
    if (stat.isFile) {
      const bytes = Deno.readFileSync(realFile);
      const srcAttr = `data:${mimeType};base64,${toBase64(bytes)}`;
      return `<img src="${srcAttr}" alt="${escapeHtml(alt)}">`;
    }
  } catch {
    // Missing or unreadable files are never emitted as relative <img> tags; keep escaped plain text.
  }

  return escapeHtml(fullMatch);
}

/**
 * Parses inline Markdown elements (code spans, images, links, bold, italic).
 */
export function parseInlineMarkdown(text: string, docDir?: string): string {
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
      svgBlocks.push(sanitizeSvg(match));
      return `%%SVGBLOCK${idx}%%`;
    },
  );

  // Line breaks: only a bare <br>, <br/>, <br />, or <BR> (any case) is
  // allowed through as a real line break — anything else (attributes,
  // unclosed tags, lookalike tag names) stays as escaped text below. This
  // must run after code-span/SVG extraction so a `<br>` written literally
  // inside a backtick code span or an SVG block is never treated as a
  // line-break tag.
  const brTags: string[] = [];
  placeholderText = placeholderText.replace(
    /<br\s*\/?\s*>/gi,
    () => {
      const idx = brTags.length;
      brTags.push("<br>");
      return `%%BRTAG${idx}%%`;
    },
  );

  // Images: ![alt](target). Run before escapeHtml and links so alt quotes are escaped cleanly and
  // rejected images remain plain text instead of becoming `[alt](url)` hyperlinks.
  const imgBlocks: string[] = [];
  placeholderText = placeholderText.replace(
    /!\[([^\]]*)\]\(([^)\r\n]+)\)/g,
    (fullMatch, alt, target) => {
      const idx = imgBlocks.length;
      imgBlocks.push(renderMarkdownImage(fullMatch, alt, target, docDir));
      return `%%IMGBLOCK${idx}%%`;
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

  // Restore images
  placeholderText = placeholderText.replace(
    /%%IMGBLOCK(\d+)%%/g,
    (_match, idxStr) => {
      return imgBlocks[parseInt(idxStr, 10)];
    },
  );

  // Restore <br> tags
  placeholderText = placeholderText.replace(
    /%%BRTAG(\d+)%%/g,
    (_match, idxStr) => {
      return brTags[parseInt(idxStr, 10)];
    },
  );

  return placeholderText;
}

/**
 * Splits a Markdown table row (e.g. "| a | b\| c | d |") into trimmed cells,
 * treating a backslash-escaped pipe (`\|`) as a literal `|` inside a cell
 * rather than a column separator.
 */
function parseTableRow(rowStr: string): string[] {
  const inner = rowStr.substring(1, rowStr.length - 1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && inner[i + 1] === "|") {
      current += "|";
      i++;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** Returns true when a parsed header row matches the canonical Gate 2 plan table header. */
function isPlanTableHeader(headers: string[]): boolean {
  if (headers.length !== PLAN_TABLE_HEADER.length) return false;
  return headers.every(
    (cell, idx) =>
      cell.replace(/[*_`]/g, "").trim().toLowerCase() ===
        PLAN_TABLE_HEADER[idx].toLowerCase(),
  );
}

/**
 * Orders every table on a design-document page newest first (Premises by `Proved` date with ties
 * broken bottom-row-first; every other table reversed). Gate 2 plan pages keep file order.
 */
function orderTableRows(
  heading: string,
  headers: string[],
  rows: string[][],
  options?: RenderDesignDocOptions,
): string[][] {
  if (options?.isPlanPage) return rows;
  const plainText = (text: string) => text.replace(/[*_`]/g, "").trim();
  const title = plainText(heading);
  if (/^load-bearing premises$/i.test(title)) {
    const provedColumn = headers.findIndex((header) => /^proved$/i.test(plainText(header)));
    if (provedColumn >= 0) {
      const provedDate = (row: string[]) => {
        const value = plainText(row[provedColumn] ?? "");
        return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
      };
      // Stable sorting after reversing gives bottom-row-first order for equal dates.
      return rows.toReversed().sort((a, b) => provedDate(b).localeCompare(provedDate(a)));
    }
  }
  return rows.toReversed();
}

/**
 * Places the `## Revision History` section directly under the document title (`# ...`) and before
 * every other section, regardless of where it sits in the Markdown file. Ignores headings inside
 * fenced code blocks.
 */
function hoistRevisionHistorySection(lines: string[]): string[] {
  let inFence = false;
  let revStart = -1;
  let revEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (revStart === -1) {
      if (trimmed.startsWith("## ")) {
        const heading = trimmed.substring(3).replace(/[*_`]/g, "").trim();
        if (/^revision history$/i.test(heading)) {
          revStart = i;
        }
      }
    } else if (/^#{1,2}\s+/.test(trimmed)) {
      revEnd = i;
      break;
    }
  }

  if (revStart === -1) return lines;

  const revSection = lines.slice(revStart, revEnd);
  while (revSection.length > 0 && revSection[revSection.length - 1].trim() === "") {
    revSection.pop();
  }

  const before = lines.slice(0, revStart);
  const after = lines.slice(revEnd);
  while (after.length > 0 && after[0].trim() === "") {
    after.shift();
  }
  const remaining = before.length > 0 && after.length > 0
    ? [
      ...before,
      ...(before[before.length - 1].trim() === "" ? [] : [""]),
      ...after,
    ]
    : [...before, ...after];

  // Find first H1 heading outside fenced code blocks in remaining lines.
  inFence = false;
  let h1Idx = -1;
  for (let i = 0; i < remaining.length; i++) {
    const trimmed = remaining[i].trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (trimmed.startsWith("# ")) {
      h1Idx = i;
      break;
    }
  }

  if (h1Idx === -1) {
    while (remaining.length > 0 && remaining[0].trim() === "") {
      remaining.shift();
    }
    return remaining.length > 0 ? [...revSection, "", ...remaining] : revSection;
  }

  const head = remaining.slice(0, h1Idx + 1);
  const tail = remaining.slice(h1Idx + 1);
  while (tail.length > 0 && tail[0].trim() === "") {
    tail.shift();
  }
  return tail.length > 0 ? [...head, "", ...revSection, "", ...tail] : [...head, "", ...revSection];
}

function renderOtherDesignSweepSection(sweep: OtherDesignSweepResult, slug?: string): string {
  const title = "Other designs checked for changed rulings";
  const headingSlug = slug ?? slugify(title);
  const termsHtml = sweep.terms.map((t) => `<code>${escapeHtml(t)}</code>`).join(", ");
  let contentHtml: string;
  if (sweep.entries.length === 0) {
    contentHtml = `<p>No hits found in other design documents.</p>`;
  } else {
    const rowsHtml = sweep.entries.map((entry) => {
      const termsCell = entry.terms.length > 0
        ? entry.terms.map((t) => `<code>${escapeHtml(t)}</code>`).join(", ")
        : "—";
      const linesCell = entry.lines.length > 0 ? entry.lines.join(", ") : "—";
      const statusLabel = entry.status === "revised"
        ? "Revised"
        : entry.status === "noted"
        ? "Noted"
        : "Unchecked (unreadable, noted)";
      const detailParts: string[] = [];
      if (entry.revisionDate) {
        detailParts.push(`Revised on ${escapeHtml(entry.revisionDate)}`);
      }
      if (entry.reason) {
        detailParts.push(escapeHtml(entry.reason));
      }
      const detailCell = detailParts.length > 0 ? detailParts.join("; ") : "—";
      return (
        `<tr>\n` +
        `  <td><code>${escapeHtml(entry.otherPath)}</code></td>\n` +
        `  <td>${termsCell}</td>\n` +
        `  <td>${linesCell}</td>\n` +
        `  <td>${statusLabel}</td>\n` +
        `  <td>${detailCell}</td>\n` +
        `</tr>`
      );
    }).join("\n");
    contentHtml = `<div class="table-wrapper">\n` +
      `<table>\n` +
      `<thead>\n` +
      `<tr>\n` +
      `  <th>Design</th>\n` +
      `  <th>Terms</th>\n` +
      `  <th>Lines</th>\n` +
      `  <th>Status</th>\n` +
      `  <th>Reason / Revision</th>\n` +
      `</tr>\n` +
      `</thead>\n` +
      `<tbody>\n${rowsHtml}\n</tbody>\n` +
      `</table>\n` +
      `</div>`;
  }
  return (
    `<section class="other-design-sweep" id="other-designs-checked">\n` +
    `<h2 id="${headingSlug}">${escapeHtml(title)}</h2>\n` +
    `<p><strong>Changed terms:</strong> ${termsHtml}</p>\n` +
    `${contentHtml}\n` +
    `</section>`
  );
}

type ParsedBlock =
  | { kind: "code"; lang: string; code: string }
  | { kind: "svg"; rawSvg: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "hr" }
  | {
    kind: "table";
    tableHeading: string;
    headers: string[];
    bodyRows: string[][];
    isGate2PlanTable: boolean;
  }
  | { kind: "blockquote"; quoteLines: string[] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "paragraph"; text: string };

type DiffEntry<T> =
  | { kind: "item"; value: T; state: "unchanged" | "changed" }
  | { kind: "removed" };

type RenderableBlock =
  | { kind: "removedMarker" }
  | { kind: "code"; lang: string; code: string; state: "unchanged" | "changed" }
  | { kind: "svg"; rawSvg: string; state: "unchanged" | "changed" }
  | { kind: "heading"; level: number; text: string; state: "unchanged" | "changed" }
  | { kind: "hr"; state: "unchanged" | "changed" }
  | {
    kind: "table";
    tableHeading: string;
    headers: string[];
    rows: DiffEntry<string[]>[];
    isGate2PlanTable: boolean;
  }
  | { kind: "blockquote"; quoteLines: string[]; state: "unchanged" | "changed" }
  | { kind: "list"; ordered: boolean; items: DiffEntry<string>[]; state: "unchanged" | "changed" }
  | { kind: "paragraph"; text: string; state: "unchanged" | "changed" };

function parseMarkdownBlocks(
  markdownContent: string,
  options?: RenderDesignDocOptions,
): ParsedBlock[] {
  const rawLines = markdownContent.split(/\r?\n/);
  const lines = options?.isPlanPage ? rawLines : hoistRevisionHistorySection(rawLines);
  const blocks: ParsedBlock[] = [];
  let tableHeading = "";
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (line.trim().startsWith("```")) {
      const lang = line.trim().substring(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ kind: "code", lang, code: codeLines.join("\n") });
      continue;
    }

    if (line.trim().startsWith("<svg") && hasClosingSvg(lines, i)) {
      const svgLines: string[] = [];
      while (i < lines.length) {
        svgLines.push(lines[i]);
        if (lines[i].includes("</svg>")) {
          i++;
          break;
        }
        i++;
      }
      blocks.push({ kind: "svg", rawSvg: svgLines.join("\n") });
      continue;
    }

    if (line.startsWith("#")) {
      const match = line.match(/^(#{1,6})\s+(.*)$/);
      if (match) {
        const level = match[1].length;
        const text = match[2].trim();
        tableHeading = text;
        blocks.push({ kind: "heading", level, text });
        i++;
        continue;
      }
    }

    if (/^(---|[*]{3}|_{3})$/.test(line.trim())) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

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
        const headerCells = parseTableRow(tableLines[0]);
        const bodyRows = orderTableRows(
          tableHeading,
          headerCells,
          tableLines.slice(2).map(parseTableRow),
          options,
        );
        const isPlanPage = Boolean(options?.isPlanPage);
        blocks.push({
          kind: "table",
          tableHeading,
          headers: headerCells,
          bodyRows,
          isGate2PlanTable: isPlanPage && isPlanTableHeader(headerCells),
        });
      }
      continue;
    }

    if (line.trim().startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        let qLine = lines[i].trim().substring(1);
        if (qLine.startsWith(" ")) qLine = qLine.substring(1);
        quoteLines.push(qLine);
        i++;
      }
      blocks.push({ kind: "blockquote", quoteLines });
      continue;
    }

    const ulMatch = line.trim().match(/^([-*+])\s+(.*)$/);
    const olMatch = line.trim().match(/^(\d+)\.\s+(.*)$/);
    if (ulMatch || olMatch) {
      const ordered = !!olMatch;
      const items: string[] = [];
      while (i < lines.length) {
        const itemLine = lines[i].trim();
        const m = ordered
          ? itemLine.match(/^(\d+)\.\s+(.*)$/)
          : itemLine.match(/^([-*+])\s+(.*)$/);
        if (m) {
          items.push(m[2]);
          i++;
        } else {
          break;
        }
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

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
      !(lines[i].trim().startsWith("<svg") && hasClosingSvg(lines, i))
    ) {
      paragraphLines.push(lines[i]);
      i++;
    }
    if (paragraphLines.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraphLines.join("\n") });
    }
  }

  return blocks;
}

/** Computes longest-common-subsequence index pairs using weighted equality matching. */
function lcsMatchPairs<A, B>(
  a: readonly A[],
  b: readonly B[],
  scoreFn: (x: A, y: B) => number,
): Array<[number, number]> {
  const m = a.length;
  const n = b.length;
  const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const s = scoreFn(a[i], b[j]);
      if (s > 0) {
        dp[i][j] = s + dp[i + 1][j + 1];
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    const s = scoreFn(a[i], b[j]);
    if (s > 0 && dp[i][j] === s + dp[i + 1][j + 1]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

function diffSequence<T>(
  oldItems: readonly T[],
  newItems: readonly T[],
  keyFn: (item: T) => string,
): DiffEntry<T>[] {
  const oldKeys = oldItems.map(keyFn);
  const newKeys = newItems.map(keyFn);
  const matches = lcsMatchPairs(oldKeys, newKeys, (a, b) => (a === b ? 1 : 0));
  const out: DiffEntry<T>[] = [];

  let prevA = -1;
  let prevB = -1;
  for (const [ai, bi] of [...matches, [oldItems.length, newItems.length]] as Array<[number, number]>) {
    const removedCount = ai - prevA - 1;
    const addedCount = bi - prevB - 1;
    if (removedCount > 0 && addedCount === 0) {
      out.push({ kind: "removed" });
    } else {
      for (let k = prevB + 1; k < bi; k++) {
        out.push({ kind: "item", value: newItems[k], state: "changed" });
      }
    }
    if (bi < newItems.length) {
      out.push({ kind: "item", value: newItems[bi], state: "unchanged" });
    }
    prevA = ai;
    prevB = bi;
  }

  return out;
}

function blockEqualityKey(block: ParsedBlock): string {
  switch (block.kind) {
    case "heading":
      return `H${block.level}:${block.text}`;
    case "paragraph":
      return `P:${block.text}`;
    case "hr":
      return "HR";
    case "code":
      return `CODE:${block.lang}:${block.code}`;
    case "svg":
      return `SVG:${block.rawSvg}`;
    case "blockquote":
      return `QUOTE:${block.quoteLines.join("\n")}`;
    case "list":
      return `LIST:${block.ordered ? "ol" : "ul"}:${JSON.stringify(block.items)}`;
    case "table":
      return `TABLE:${block.headers.join("\t")}:${JSON.stringify(block.bodyRows)}`;
  }
}

function pairableBlockScore(a: ParsedBlock, b: ParsedBlock): number {
  if (a.kind !== b.kind) return 0;
  if (a.kind === "heading" && b.kind === "heading") {
    return a.level === b.level ? 1 : 0;
  }
  if (a.kind === "list" && b.kind === "list") {
    return a.ordered === b.ordered ? 2 : 0;
  }
  if (a.kind === "table" && b.kind === "table") {
    const sameHeaders = a.headers.join("\t") === b.headers.join("\t");
    if (!sameHeaders && a.tableHeading !== b.tableHeading) return 0;
    return a.tableHeading === b.tableHeading ? 4 : 2;
  }
  return 1;
}

function toUnchangedRenderable(block: ParsedBlock): RenderableBlock {
  switch (block.kind) {
    case "table":
      return {
        kind: "table",
        tableHeading: block.tableHeading,
        headers: block.headers,
        rows: block.bodyRows.map((row) => ({ kind: "item", value: row, state: "unchanged" })),
        isGate2PlanTable: block.isGate2PlanTable,
      };
    case "list":
      return {
        kind: "list",
        ordered: block.ordered,
        items: block.items.map((item) => ({ kind: "item", value: item, state: "unchanged" })),
        state: "unchanged",
      };
    default:
      return { ...block, state: "unchanged" };
  }
}

function toChangedRenderable(block: ParsedBlock): RenderableBlock {
  switch (block.kind) {
    case "table":
      return {
        kind: "table",
        tableHeading: block.tableHeading,
        headers: block.headers,
        rows: block.bodyRows.map((row) => ({ kind: "item", value: row, state: "changed" })),
        isGate2PlanTable: block.isGate2PlanTable,
      };
    case "list":
      return {
        kind: "list",
        ordered: block.ordered,
        items: block.items.map((item) => ({ kind: "item", value: item, state: "changed" })),
        state: "changed",
      };
    default:
      return { ...block, state: "changed" };
  }
}

function pairModifiedBlock(oldBlock: ParsedBlock, newBlock: ParsedBlock): RenderableBlock {
  if (oldBlock.kind === "table" && newBlock.kind === "table") {
    return {
      kind: "table",
      tableHeading: newBlock.tableHeading,
      headers: newBlock.headers,
      rows: diffSequence(oldBlock.bodyRows, newBlock.bodyRows, (row) => JSON.stringify(row)),
      isGate2PlanTable: newBlock.isGate2PlanTable,
    };
  }
  if (oldBlock.kind === "list" && newBlock.kind === "list") {
    return {
      kind: "list",
      ordered: newBlock.ordered,
      items: diffSequence(oldBlock.items, newBlock.items, (item) => item),
      state: "changed",
    };
  }
  return toChangedRenderable(newBlock);
}

function diffParsedBlocks(
  approvedBlocks: readonly ParsedBlock[],
  currentBlocks: readonly ParsedBlock[],
): RenderableBlock[] {
  const approvedKeys = approvedBlocks.map(blockEqualityKey);
  const currentKeys = currentBlocks.map(blockEqualityKey);
  const anchors = lcsMatchPairs(approvedKeys, currentKeys, (a, b) => (a === b ? 1 : 0));
  const out: RenderableBlock[] = [];

  let prevA = -1;
  let prevC = -1;
  for (
    const [nextA, nextC] of [
      ...anchors,
      [approvedBlocks.length, currentBlocks.length],
    ] as Array<[number, number]>
  ) {
    const oldSlice = approvedBlocks.slice(prevA + 1, nextA);
    const newSlice = currentBlocks.slice(prevC + 1, nextC);

    if (oldSlice.length > 0 && newSlice.length === 0) {
      out.push({ kind: "removedMarker" });
    } else if (oldSlice.length === 0 && newSlice.length > 0) {
      for (const blk of newSlice) {
        out.push(toChangedRenderable(blk));
      }
    } else if (oldSlice.length > 0 && newSlice.length > 0) {
      const subPairs = lcsMatchPairs(oldSlice, newSlice, pairableBlockScore);
      let subPrevA = -1;
      let subPrevC = -1;
      for (
        const [subA, subC] of [
          ...subPairs,
          [oldSlice.length, newSlice.length],
        ] as Array<[number, number]>
      ) {
        const subOldCount = subA - subPrevA - 1;
        const subNewCount = subC - subPrevC - 1;
        if (subOldCount > 0 && subNewCount === 0) {
          out.push({ kind: "removedMarker" });
        } else {
          for (let k = subPrevC + 1; k < subC; k++) {
            out.push(toChangedRenderable(newSlice[k]));
          }
        }
        if (subC < newSlice.length) {
          out.push(pairModifiedBlock(oldSlice[subA], newSlice[subC]));
        }
        subPrevA = subA;
        subPrevC = subC;
      }
    }

    if (nextC < currentBlocks.length) {
      out.push(toUnchangedRenderable(currentBlocks[nextC]));
    }
    prevA = nextA;
    prevC = nextC;
  }

  return out;
}

function formatApprovalDateLabel(approvedAt?: string): string {
  if (!approvedAt || !approvedAt.trim()) return "";
  const trimmed = approvedAt.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return "";
  return toLocalIsoDate(parsed);
}

/**
 * Computes the next highlighted change index (0-based) for the "Next change" banner button,
 * advancing sequentially and wrapping from the last change back to 0.
 */
export function computeNextChangeIndex(currentIndex: number, totalChanges: number): number {
  if (totalChanges <= 0 || !Number.isFinite(totalChanges)) return -1;
  if (!Number.isFinite(currentIndex) || currentIndex < 0 || currentIndex >= totalChanges - 1) {
    return 0;
  }
  return currentIndex + 1;
}

/** Converts a Markdown document into a standalone HTML document adhering to design rules. */
export function renderDesignDoc(
  markdownContent: string,
  fallbackTitle: string = "Design Document",
  options?: RenderDesignDocOptions,
): string {
  const docDir = options?.docDir;
  const currentBlocks = parseMarkdownBlocks(markdownContent, options);
  const compareApproved = !options?.isPlanPage && options?.approvedMarkdown !== undefined;
  const renderBlocks: RenderableBlock[] = compareApproved
    ? diffParsedBlocks(
      parseMarkdownBlocks(options.approvedMarkdown!, options),
      currentBlocks,
    )
    : currentBlocks.map(toUnchangedRenderable);

  let documentTitle = fallbackTitle;
  let hasDocumentTitle = false;
  const tocEntries: Array<{ title: string; slug: string }> = [];
  const usedSlugs = new Set<string>();
  const allocateSlug = (headingText: string): string => {
    const baseSlug = slugify(headingText) || "section";
    let slug = baseSlug;
    let counter = 2;
    while (usedSlugs.has(slug)) {
      slug = `${baseSlug}-${counter++}`;
    }
    usedSlugs.add(slug);
    return slug;
  };

  // Render blocks into body HTML while collecting H2 TOC entries and allocating deterministic
  // heading anchors in document order across H2, H3, and H4.
  const bodyHtmlParts: string[] = [];
  let inAppendix = false;
  let inAppendixDetails = false;
  let changeCount = 0;

  const changeAttrs = (changed: boolean): string => {
    if (!changed) return "";
    changeCount++;
    return ` class="rev-changed" data-rev-change="true"`;
  };

  for (const block of renderBlocks) {
    switch (block.kind) {
      case "removedMarker": {
        changeCount++;
        bodyHtmlParts.push(
          `<div class="rev-removed" data-rev-change="true"><span class="rev-removed-badge">removed here</span></div>`,
        );
        break;
      }
      case "code": {
        const escapedCode = escapeHtml(block.code);
        const codeClass = block.lang ? ` class="language-${escapeHtml(block.lang)}"` : "";
        const preAttrs = block.state === "changed"
          ? ` class="rev-changed" data-rev-change="true"`
          : "";
        if (block.state === "changed") changeCount++;
        bodyHtmlParts.push(`<pre${preAttrs}><code${codeClass}>${escapedCode}</code></pre>`);
        break;
      }
      case "svg": {
        const sanitized = sanitizeSvg(block.rawSvg);
        if (block.state === "changed") {
          changeCount++;
          bodyHtmlParts.push(`<div class="rev-changed" data-rev-change="true">${sanitized}</div>`);
        } else {
          bodyHtmlParts.push(sanitized);
        }
        break;
      }
      case "heading": {
        const { level, text } = block;
        const changed = block.state === "changed";
        if (level === 1) {
          if (!hasDocumentTitle) {
            documentTitle = text;
            hasDocumentTitle = true;
          }
          bodyHtmlParts.push(`<h1${changeAttrs(changed)}>${parseInlineMarkdown(text, docDir)}</h1>`);
        } else if (level === 2) {
          if (inAppendixDetails) {
            bodyHtmlParts.push(`</div>\n</details>`);
            inAppendixDetails = false;
          }
          const cleanTitle = text
            .replace(/[*_`[\]]/g, "")
            .replace(/\([^)]*\)/g, "")
            .trim();
          const slug = allocateSlug(text);
          tocEntries.push({ title: cleanTitle || text, slug });

          inAppendix = /\bappendix\b/i.test(text);
          bodyHtmlParts.push(
            `<h2 id="${slug}"${changeAttrs(changed)}>${parseInlineMarkdown(text, docDir)}</h2>`,
          );
        } else if (level === 3) {
          const slug = allocateSlug(text);
          if (inAppendix) {
            if (inAppendixDetails) {
              bodyHtmlParts.push(`</div>\n</details>`);
            }
            bodyHtmlParts.push(
              `<details id="${slug}">\n  <summary${changeAttrs(changed)}>${
                parseInlineMarkdown(text, docDir)
              }</summary>\n  <div class="appendix-content">`,
            );
            inAppendixDetails = true;
          } else {
            bodyHtmlParts.push(
              `<h3 id="${slug}"${changeAttrs(changed)}>${parseInlineMarkdown(text, docDir)}</h3>`,
            );
          }
        } else if (level === 4) {
          const slug = allocateSlug(text);
          bodyHtmlParts.push(
            `<h4 id="${slug}"${changeAttrs(changed)}>${parseInlineMarkdown(text, docDir)}</h4>`,
          );
        } else {
          const hTag = `h${level}`;
          bodyHtmlParts.push(
            `<${hTag}${changeAttrs(changed)}>${parseInlineMarkdown(text, docDir)}</${hTag}>`,
          );
        }
        break;
      }
      case "hr": {
        if (block.state === "changed") {
          changeCount++;
          bodyHtmlParts.push(`<hr class="rev-changed" data-rev-change="true">`);
        } else {
          bodyHtmlParts.push(`<hr>`);
        }
        break;
      }
      case "table": {
        const wrapperAttrs = block.isGate2PlanTable
          ? ` class="table-wrapper" data-default-size="all"`
          : ` class="table-wrapper"`;

        let tableHtml = block.isGate2PlanTable
          ? `<p class="plan-table-total">Total rows: ${block.rows.length}</p>\n`
          : "";
        tableHtml += `<div${wrapperAttrs}>\n<table>\n<thead>\n<tr>\n`;
        for (const cell of block.headers) {
          tableHtml += `  <th>${parseInlineMarkdown(cell, docDir)}</th>\n`;
        }
        tableHtml += `</tr>\n</thead>\n<tbody>\n`;
        for (const rowEntry of block.rows) {
          if (rowEntry.kind === "removed") {
            changeCount++;
            tableHtml +=
              `<tr class="rev-removed-row" data-rev-change="true">\n  <td colspan="${block.headers.length}"><span class="rev-removed-badge">removed here</span></td>\n</tr>\n`;
            continue;
          }
          const rowAttrs = rowEntry.state === "changed"
            ? ` class="rev-changed" data-rev-change="true"`
            : "";
          if (rowEntry.state === "changed") changeCount++;
          tableHtml += `<tr${rowAttrs}>\n`;
          for (const cell of rowEntry.value) {
            tableHtml += `  <td>${parseInlineMarkdown(cell, docDir)}</td>\n`;
          }
          tableHtml += `</tr>\n`;
        }
        tableHtml += `</tbody>\n</table>\n</div>`;
        bodyHtmlParts.push(tableHtml);
        break;
      }
      case "blockquote": {
        const quoteContent = block.quoteLines
          .map((l) => parseInlineMarkdown(l, docDir))
          .join("<br>\n");
        bodyHtmlParts.push(
          `<blockquote${changeAttrs(block.state === "changed")}>${quoteContent}</blockquote>`,
        );
        break;
      }
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        let listHtml = `<${tag}>\n`;
        for (const itemEntry of block.items) {
          if (itemEntry.kind === "removed") {
            changeCount++;
            listHtml +=
              `  <li class="rev-removed-item" data-rev-change="true"><span class="rev-removed-badge">removed here</span></li>\n`;
            continue;
          }
          const itemAttrs = itemEntry.state === "changed"
            ? ` class="rev-changed" data-rev-change="true"`
            : "";
          if (itemEntry.state === "changed") changeCount++;
          listHtml += `  <li${itemAttrs}>${parseInlineMarkdown(itemEntry.value, docDir)}</li>\n`;
        }
        listHtml += `</${tag}>`;
        bodyHtmlParts.push(listHtml);
        break;
      }
      case "paragraph": {
        bodyHtmlParts.push(
          `<p${changeAttrs(block.state === "changed")}>${
            parseInlineMarkdown(block.text, docDir)
          }</p>`,
        );
        break;
      }
    }
  }

  if (inAppendixDetails) {
    bodyHtmlParts.push(`</div>\n</details>`);
  }

  if (!hasDocumentTitle) {
    bodyHtmlParts.unshift(`<h1>${escapeHtml(documentTitle)}</h1>`);
  }

  if (compareApproved) {
    const dateLabel = formatApprovalDateLabel(options?.approvedAt);
    const changeWord = changeCount === 1 ? "change" : "changes";
    const summaryText = dateLabel
      ? `${changeCount} ${changeWord} since you approved this on ${dateLabel}`
      : `${changeCount} ${changeWord} since you approved this`;
    const nextDisabled = changeCount === 0 ? " disabled" : "";
    const bannerHtml = `<div class="rev-banner" id="rev-banner" role="region" aria-label="Revision changes">\n` +
      `  <span class="rev-banner-text">${escapeHtml(summaryText)}</span>\n` +
      `  <div class="rev-banner-actions">\n` +
      `    <button type="button" class="rev-banner-btn" id="rev-next-btn"${nextDisabled}>Next change</button>\n` +
      `    <button type="button" class="rev-banner-btn" id="rev-toggle-btn" aria-pressed="false">Hide highlights</button>\n` +
      `  </div>\n` +
      `</div>`;
    bodyHtmlParts.unshift(bannerHtml);
  }

  if (options?.otherDesignSweep && !options.isPlanPage) {
    const sweepTitle = "Other designs checked for changed rulings";
    const sweepSlug = allocateSlug(sweepTitle);
    tocEntries.push({ title: sweepTitle, slug: sweepSlug });
    bodyHtmlParts.push(renderOtherDesignSweepSection(options.otherDesignSweep, sweepSlug));
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
        color-scheme: dark;
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
      color-scheme: dark;
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

    .table-wrapper, pre {
      overflow-x: auto;
      max-width: 100%;
    }

    .table-wrapper {
      max-height: 70vh;
      overflow-y: auto;
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
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    img, svg {
      max-width: 100%;
    }

    img {
      height: auto;
    }

    th {
      background-color: var(--toc-bg);
      white-space: nowrap;
    }

    thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      background-color: var(--toc-bg);
      box-shadow: inset 0 1px 0 var(--border-color), inset 0 -1px 0 var(--border-color);
    }

    .table-pager {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      margin: 8px 0 1.5rem;
      font-size: 0.9rem;
    }

    .table-pager-size-label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--text-color);
      opacity: 0.85;
    }

    .table-pager-size {
      background-color: var(--bg-color);
      border: 1px solid var(--border-color);
      color: var(--text-color);
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 0.85rem;
      cursor: pointer;
    }

    .table-pager-size:focus {
      outline: 2px solid var(--link-color);
      outline-offset: 1px;
    }

    .table-pager-btn {
      background: transparent;
      border: 1px solid var(--border-color);
      color: var(--text-color);
      border-radius: 4px;
      padding: 4px 12px;
      font-size: 0.85rem;
      cursor: pointer;
    }

    .table-pager-btn:hover:not(:disabled) {
      background-color: var(--code-bg);
    }

    .table-pager-btn:disabled {
      opacity: 0.4;
      cursor: default;
    }

    .table-pager-status {
      color: var(--text-color);
      opacity: 0.85;
    }

    .plan-table-total {
      font-size: 0.9rem;
      font-weight: 600;
      margin: 1rem 0 0.4rem;
      color: var(--text-color);
      opacity: 0.85;
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

    .rev-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      padding: 10px 14px;
      margin-bottom: 1.25rem;
      background-color: rgba(250, 204, 21, 0.085);
      border: 1px solid rgba(250, 204, 21, 0.35);
      border-left: 2px solid rgba(250, 204, 21, 0.8);
      border-radius: 6px;
      font-size: 0.92rem;
    }

    .rev-banner-actions {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    .rev-banner-btn {
      background: transparent;
      border: 1px solid rgba(250, 204, 21, 0.45);
      color: var(--text-color);
      border-radius: 4px;
      padding: 4px 12px;
      font-size: 0.85rem;
      cursor: pointer;
    }

    .rev-banner-btn:hover:not(:disabled) {
      background-color: rgba(250, 204, 21, 0.14);
    }

    .rev-banner-btn:disabled {
      opacity: 0.45;
      cursor: default;
    }

    table,
    .table-wrapper {
      background-color: transparent;
    }

    .rev-changed {
      background-color: rgba(250, 204, 21, 0.085);
      border-left: 2px solid rgba(250, 204, 21, 0.75);
      padding-left: 10px;
      border-radius: 2px;
    }

    li.rev-changed {
      padding-left: 8px;
    }

    tr.rev-changed td {
      background-color: rgba(250, 204, 21, 0.085);
    }

    tr.rev-changed td:first-child {
      box-shadow: inset 2px 0 0 rgba(250, 204, 21, 0.75);
    }

    [data-rev-change].rev-active:not(tr) {
      background-color: rgba(250, 204, 21, 0.15);
      outline: 1px solid rgba(250, 204, 21, 0.65);
    }

    tr[data-rev-change].rev-active td {
      background-color: rgba(250, 204, 21, 0.15);
    }

    .rev-removed {
      margin: 0.45rem 0;
    }

    .rev-removed-item {
      list-style: none;
      margin: 0.35rem 0;
    }

    .rev-removed-badge {
      display: inline-block;
      font-size: 0.78rem;
      font-weight: 600;
      color: #facc15;
      background-color: rgba(250, 204, 21, 0.09);
      border: 1px solid rgba(250, 204, 21, 0.45);
      border-left: 2px solid rgba(250, 204, 21, 0.85);
      border-radius: 3px;
      padding: 1px 8px;
    }

    body.highlights-hidden .rev-changed {
      background-color: transparent;
      border-left-color: transparent;
      outline: none;
    }

    body.highlights-hidden tr.rev-changed td {
      background-color: transparent;
      box-shadow: none;
    }

    body.highlights-hidden .rev-removed,
    body.highlights-hidden .rev-removed-item,
    body.highlights-hidden .rev-removed-row {
      display: none !important;
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

    @media print {
      .table-wrapper {
        max-height: none;
        overflow: visible;
      }

      .table-pager {
        display: none;
      }

      tr.table-pager-hidden-row {
        display: table-row !important;
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

    (function() {
      var DEFAULT_PAGE_SIZE = 10;
      var computePagination = ${computeTablePagination.toString()};
      var tables = document.querySelectorAll(".table-wrapper > table");
      for (var t = 0; t < tables.length; t++) {
        (function(table) {
          var tbody = table.querySelector("tbody");
          if (!tbody) return;
          var rows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));
          if (rows.length <= DEFAULT_PAGE_SIZE) return;

          var wrapper = table.closest(".table-wrapper");
          if (!wrapper || !wrapper.parentNode) return;

          var defaultSizeAttr = wrapper.getAttribute("data-default-size");
          var initialOptionValue = defaultSizeAttr === "all" ? "all" : String(DEFAULT_PAGE_SIZE);
          var currentSize = defaultSizeAttr === "all" ? "all" : DEFAULT_PAGE_SIZE;
          var currentPage = 1;

          var pager = document.createElement("div");
          pager.className = "table-pager";
          pager.setAttribute("role", "navigation");
          pager.setAttribute("aria-label", "Table pagination");

          var sizeLabel = document.createElement("label");
          sizeLabel.className = "table-pager-size-label";
          sizeLabel.textContent = "Rows per page: ";

          var sizeSelect = document.createElement("select");
          sizeSelect.className = "table-pager-size";
          sizeSelect.setAttribute("aria-label", "Rows per page");

          var sizeOptions = ["10", "20", "30", "All"];
          for (var o = 0; o < sizeOptions.length; o++) {
            var opt = document.createElement("option");
            opt.value = sizeOptions[o].toLowerCase();
            opt.textContent = sizeOptions[o];
            if (opt.value === initialOptionValue) opt.selected = true;
            sizeSelect.appendChild(opt);
          }
          sizeLabel.appendChild(sizeSelect);

          var prevBtn = document.createElement("button");
          prevBtn.type = "button";
          prevBtn.className = "table-pager-btn table-pager-prev";
          prevBtn.textContent = "Previous";

          var status = document.createElement("span");
          status.className = "table-pager-status";

          var nextBtn = document.createElement("button");
          nextBtn.type = "button";
          nextBtn.className = "table-pager-btn table-pager-next";
          nextBtn.textContent = "Next";

          pager.appendChild(sizeLabel);
          pager.appendChild(prevBtn);
          pager.appendChild(status);
          pager.appendChild(nextBtn);
          wrapper.parentNode.insertBefore(pager, wrapper.nextSibling);

          function render() {
            var state = computePagination(rows.length, currentPage, currentSize);
            currentPage = state.currentPage;

            for (var i = 0; i < rows.length; i++) {
              var visible = i >= state.startIdx && i < state.endIdx;
              rows[i].style.display = visible ? "" : "none";
              if (visible) {
                rows[i].classList.remove("table-pager-hidden-row");
              } else {
                rows[i].classList.add("table-pager-hidden-row");
              }
            }

            status.textContent = state.statusText;
            prevBtn.disabled = state.prevDisabled;
            nextBtn.disabled = state.nextDisabled;
          }

          sizeSelect.addEventListener("change", function() {
            var val = sizeSelect.value;
            currentSize = val === "all" ? "all" : parseInt(val, 10);
            currentPage = 1;
            render();
          });

          prevBtn.addEventListener("click", function() {
            if (currentPage > 1) {
              currentPage--;
              render();
            }
          });
          nextBtn.addEventListener("click", function() {
            if (!computePagination(rows.length, currentPage, currentSize).nextDisabled) {
              currentPage++;
              render();
            }
          });

          table._revealRow = function(tr) {
            var idx = rows.indexOf(tr);
            if (idx === -1) return;
            if (currentSize !== "all") {
              currentPage = Math.floor(idx / currentSize) + 1;
              render();
            }
          };

          render();
        })(tables[t]);
      }

      function openDetailsForHash() {
        var rawHash = window.location.hash ? window.location.hash.slice(1) : "";
        if (!rawHash) return;
        var id = rawHash;
        try {
          id = decodeURIComponent(rawHash);
        } catch (_e) {
          // Keep raw fragment when percent-decoding fails.
        }
        var target = document.getElementById(id);
        if (!target) return;
        var details = target.tagName === "DETAILS" ? target : target.closest("details");
        if (details) {
          details.open = true;
        }
      }
      openDetailsForHash();
      window.addEventListener("hashchange", openDetailsForHash);
    })();

    (function() {
      var banner = document.getElementById("rev-banner");
      if (!banner) return;
      var nextBtn = document.getElementById("rev-next-btn");
      var toggleBtn = document.getElementById("rev-toggle-btn");
      var computeNext = ${computeNextChangeIndex.toString()};
      var changes = Array.prototype.slice.call(document.querySelectorAll("[data-rev-change='true']"));
      var currentIdx = -1;

      if (nextBtn) {
        nextBtn.addEventListener("click", function() {
          if (changes.length === 0 || document.body.classList.contains("highlights-hidden")) return;
          if (currentIdx >= 0 && currentIdx < changes.length) {
            changes[currentIdx].classList.remove("rev-active");
          }
          currentIdx = computeNext(currentIdx, changes.length);
          if (currentIdx < 0) return;
          var target = changes[currentIdx];
          var det = target.closest("details");
          if (det) det.open = true;
          var tr = target.tagName === "TR" ? target : target.closest("tr");
          if (tr) {
            var tbl = tr.closest("table");
            if (tbl && typeof tbl._revealRow === "function") tbl._revealRow(tr);
          }
          target.classList.add("rev-active");
          target.scrollIntoView({ behavior: "smooth", block: "center" });
        });
      }

      if (toggleBtn) {
        toggleBtn.addEventListener("click", function() {
          var hidden = document.body.classList.toggle("highlights-hidden");
          toggleBtn.textContent = hidden ? "Show highlights" : "Hide highlights";
          toggleBtn.setAttribute("aria-pressed", hidden ? "true" : "false");
          if (nextBtn) {
            nextBtn.disabled = hidden || changes.length === 0;
          }
        });
      }
    })();
  </script>
</body>
</html>
`;
}

export interface TablePaginationState {
  pageSize: number;
  isAll: boolean;
  totalPages: number;
  currentPage: number;
  startIdx: number; // 0-based inclusive
  endIdx: number; // 0-based exclusive
  startDisplay: number; // 1-based display
  endDisplay: number; // 1-based display
  statusText: string; // e.g. "1-10 of 40" or "0 of 0"
  prevDisabled: boolean;
  nextDisabled: boolean;
}

export function computeTablePagination(
  totalRows: number,
  requestedPage: number,
  pageSizeOption: number | "all" | string,
): TablePaginationState {
  const isAll = typeof pageSizeOption === "string" &&
    pageSizeOption.toLowerCase() === "all";
  const parsedSize = typeof pageSizeOption === "number"
    ? pageSizeOption
    : parseInt(String(pageSizeOption), 10);
  const pageSize = isAll ? totalRows : (isNaN(parsedSize) || parsedSize <= 0 ? 10 : parsedSize);

  const totalPages = totalRows === 0 ? 1 : (isAll ? 1 : Math.ceil(totalRows / pageSize));
  const currentPage = Math.max(1, Math.min(requestedPage, totalPages));

  if (totalRows === 0) {
    return {
      pageSize,
      isAll,
      totalPages: 1,
      currentPage: 1,
      startIdx: 0,
      endIdx: 0,
      startDisplay: 0,
      endDisplay: 0,
      statusText: "0 of 0",
      prevDisabled: true,
      nextDisabled: true,
    };
  }

  const startIdx = (currentPage - 1) * pageSize;
  const endIdx = isAll ? totalRows : Math.min(startIdx + pageSize, totalRows);
  const startDisplay = startIdx + 1;
  const endDisplay = endIdx;
  const statusText = `${startDisplay}-${endDisplay} of ${totalRows}`;
  const prevDisabled = currentPage <= 1;
  const nextDisabled = currentPage >= totalPages;

  return {
    pageSize,
    isAll,
    totalPages,
    currentPage,
    startIdx,
    endIdx,
    startDisplay,
    endDisplay,
    statusText,
    prevDisabled,
    nextDisabled,
  };
}

export function renderDesignDocFile(
  inputPath: string,
  outputPath: string,
  options?: RenderDesignDocOptions,
): void {
  const content = Deno.readTextFileSync(inputPath);
  const fallbackTitle = path.basename(inputPath, path.extname(inputPath));
  const resolvedOptions: RenderDesignDocOptions = {
    ...options,
    docDir: options?.docDir ?? path.dirname(path.resolve(inputPath)),
  };
  const html = renderDesignDoc(content, fallbackTitle, resolvedOptions);
  Deno.writeTextFileSync(outputPath, html);
}

if (import.meta.main) {
  const isPlanPage = Deno.args.includes("--plan-page");
  const args = Deno.args.filter((a) => a !== "--plan-page");
  if (args.length < 2) {
    console.error(
      "Usage: render_design_doc.ts [--plan-page] <input_markdown_path> <output_html_path>",
    );
    Deno.exit(1);
  }
  try {
    renderDesignDocFile(args[0], args[1], { isPlanPage });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error rendering design doc: ${message}`);
    Deno.exit(1);
  }
}
