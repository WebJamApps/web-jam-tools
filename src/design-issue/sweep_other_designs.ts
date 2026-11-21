// src/design-issue/sweep_other_designs.ts
// Cross-design sweep for Gate 1 ("Checking the other designs" in
// ~/Dropbox/web-jam-llms/Token_Savings/design-issue-file-issue-design-2026-08-23.md).

import * as path from "@std/path";
import { expandHome } from "./gate1.ts";
import type { OtherDesignSweepEntry, SweepNote } from "./gate1_record.ts";
import { isTableSeparatorRow, splitTableRow, stripCellDecoration } from "./lint_doc.ts";

export const SWEEP_EXCLUDED_FOLDERS = new Set([
  "resume-records",
  "claude-backup",
  "backups",
  "node_modules",
  "Trash",
]);

export interface SearchableLine {
  lineNum: number;
  text: string;
}

export interface UnsettledDesignHit {
  otherPath: string;
  lines: number[];
  terms: string[];
}

export interface UncheckedDesignDoc {
  otherPath: string;
  error: string;
}

export interface ScanOtherDesignDocsOptions {
  docPath: string;
  changedTerms: string[];
  rootDir: string;
  todayIso: string;
  sweepNotes?: SweepNote[];
  readTextFileImpl?: (filePath: string) => Promise<string>;
}

export interface ScanOtherDesignDocsResult {
  terms: string[];
  entries: OtherDesignSweepEntry[];
  unsettled: UnsettledDesignHit[];
  unchecked: UncheckedDesignDoc[];
}

/**
 * Whether `needle` occurs in `text` with no `boundary` character directly before it (when
 * `checkBefore`) or directly after it (when `checkAfter`). A plain string search, so no pattern is
 * ever built from the needle. An empty needle matches, as an empty pattern would.
 */
function hasBoundedOccurrence(
  text: string,
  needle: string,
  boundary: RegExp,
  checkBefore = true,
  checkAfter = true,
): boolean {
  if (needle === "") return true;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    const before = i > 0 ? text[i - 1] : "";
    const after = text[i + needle.length] ?? "";
    if ((!checkBefore || !boundary.test(before)) && (!checkAfter || !boundary.test(after))) {
      return true;
    }
  }
  return false;
}

const DATE_CHAR = /[0-9-]/;
const WORD_CHAR = /[A-Za-z0-9_]/;

function resolveRealPathOrNull(absPath: string): string | null {
  try {
    return Deno.realPathSync(absPath);
  } catch {
    return null;
  }
}

/**
 * Matches `*-design*.md` design documents while excluding Gate 2 plan files (`*-issue-plan-*.md`)
 * and session resume records (`*-run-resume-*.md`).
 */
export function isSweepTargetFilename(filename: string): boolean {
  if (!/-design.*\.md$/i.test(filename)) return false;
  if (/-issue-plan-/i.test(filename) || /-run-resume-/i.test(filename)) return false;
  return true;
}

function matchFence(line: string): { char: string; length: number; info: string } | null {
  const m = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (!m) return null;
  return { char: m[1][0], length: m[1].length, info: m[2] };
}

function isDecisionRecordHeading(headingText: string): boolean {
  const h = stripCellDecoration(headingText);
  return (
    (/\bdecisions?\b/i.test(h) && /\b(?:record|log|table)\b/i.test(h)) ||
    /^decisions?$/i.test(h)
  );
}

function isRevisionHistoryHeading(headingText: string): boolean {
  return /^Revision\s+History\b/i.test(stripCellDecoration(headingText));
}

function isHistorySectionHeading(headingText: string): boolean {
  const h = stripCellDecoration(headingText);
  if (isRevisionHistoryHeading(h)) return true;
  if (isDecisionRecordHeading(h)) return true;
  if (/^Load-bearing\s+premises\b/i.test(h)) return true;
  if (/\bpremises\b/i.test(h) && /\b(?:turned\s+out\s+)?false\b/i.test(h)) return true;
  return false;
}

/**
 * Returns true when the document's decision record table holds a data row dated `dateIso`
 * (matched as a standalone ISO date token inside any data cell of a decision-record table).
 */
export function hasDecisionRowDated(markdown: string, dateIso: string): boolean {
  if (!markdown || !dateIso) return false;
  const lines = markdown.split(/\r?\n/);
  const isDated = (cell: string) => hasBoundedOccurrence(cell, dateIso, DATE_CHAR);

  let openFence: { char: string; length: number } | null = null;
  let decisionSectionLevel: number | null = null;
  let inTable = false;
  let sawHeader = false;

  for (const line of lines) {
    const fence = matchFence(line);
    if (openFence) {
      if (
        fence &&
        fence.char === openFence.char &&
        fence.length >= openFence.length &&
        fence.info.trim() === ""
      ) {
        openFence = null;
      }
      continue;
    }
    if (fence && !(fence.char === "`" && fence.info.includes("`"))) {
      openFence = { char: fence.char, length: fence.length };
      inTable = false;
      sawHeader = false;
      continue;
    }

    const headingMatch = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();
      if (decisionSectionLevel !== null && level <= decisionSectionLevel) {
        decisionSectionLevel = null;
      }
      if (decisionSectionLevel === null && isDecisionRecordHeading(headingText)) {
        decisionSectionLevel = level;
      }
      inTable = false;
      sawHeader = false;
      continue;
    }

    if (decisionSectionLevel === null) continue;

    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      inTable = false;
      sawHeader = false;
      continue;
    }

    const cells = splitTableRow(trimmed);
    if (cells.length === 0) continue;

    if (!inTable) {
      inTable = true;
      if (!isTableSeparatorRow(cells)) {
        sawHeader = true;
        continue; // Header row
      }
    }

    if (isTableSeparatorRow(cells)) continue;
    if (!sawHeader) {
      sawHeader = true;
      continue;
    }

    if (cells.some((cell) => isDated(stripCellDecoration(cell)))) {
      return true;
    }
  }

  return false;
}

/**
 * Returns true when the document's `## Revision History` table carries a data row whose `Date`
 * column equals `dateIso`.
 */
export function hasRevisionRowDated(markdown: string, dateIso: string): boolean {
  if (!markdown || !dateIso) return false;
  const lines = markdown.split(/\r?\n/);

  let openFence: { char: string; length: number } | null = null;
  let revSectionLevel: number | null = null;
  let dateColIdx = -1;
  let sawHeader = false;

  for (const line of lines) {
    const fence = matchFence(line);
    if (openFence) {
      if (
        fence &&
        fence.char === openFence.char &&
        fence.length >= openFence.length &&
        fence.info.trim() === ""
      ) {
        openFence = null;
      }
      continue;
    }
    if (fence && !(fence.char === "`" && fence.info.includes("`"))) {
      openFence = { char: fence.char, length: fence.length };
      continue;
    }

    const headingMatch = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();
      if (revSectionLevel !== null && level <= revSectionLevel) {
        revSectionLevel = null;
        dateColIdx = -1;
        sawHeader = false;
      }
      if (revSectionLevel === null && isRevisionHistoryHeading(headingText)) {
        revSectionLevel = level;
        dateColIdx = -1;
        sawHeader = false;
      }
      continue;
    }

    if (revSectionLevel === null) continue;

    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      dateColIdx = -1;
      sawHeader = false;
      continue;
    }

    const cells = splitTableRow(trimmed);
    if (cells.length === 0 || isTableSeparatorRow(cells)) continue;

    if (!sawHeader) {
      sawHeader = true;
      dateColIdx = cells.findIndex((c) => /^date$/i.test(stripCellDecoration(c)));
      continue;
    }

    if (dateColIdx === -1) continue;
    const rawDate = stripCellDecoration(cells[dateColIdx] ?? "");
    if (rawDate === dateIso) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts every line outside the history: excludes the revision table, the decision record,
 * verbatim quotes (`>`), the premises table, and an appendix of premises that turned out false.
 * Text in backticks or double quotes, fenced code blocks outside history, and case-list appendices
 * remain included.
 */
export function extractSearchableLines(markdown: string): SearchableLine[] {
  const lines = markdown.split(/\r?\n/);
  const result: SearchableLine[] = [];

  let openFence: { char: string; length: number } | null = null;
  let excludedSectionLevel: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = matchFence(line);
    if (openFence) {
      if (
        fence &&
        fence.char === openFence.char &&
        fence.length >= openFence.length &&
        fence.info.trim() === ""
      ) {
        openFence = null;
      }
      if (excludedSectionLevel === null) {
        result.push({ lineNum: i + 1, text: line });
      }
      continue;
    }
    if (fence && !(fence.char === "`" && fence.info.includes("`"))) {
      openFence = { char: fence.char, length: fence.length };
      if (excludedSectionLevel === null) {
        result.push({ lineNum: i + 1, text: line });
      }
      continue;
    }

    const headingMatch = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();
      if (excludedSectionLevel !== null && level <= excludedSectionLevel) {
        excludedSectionLevel = null;
      }
      if (excludedSectionLevel === null && isHistorySectionHeading(headingText)) {
        excludedSectionLevel = level;
      }
      if (excludedSectionLevel === null) {
        result.push({ lineNum: i + 1, text: line });
      }
      continue;
    }

    if (excludedSectionLevel !== null) {
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      continue;
    }

    result.push({ lineNum: i + 1, text: line });
  }

  return result;
}

/** A whole-word test for `term`: a word character may not touch a word-character end of it. */
function wholeWordMatcher(term: string): (text: string) => boolean {
  const checkBefore = /^[A-Za-z0-9_]/.test(term);
  const checkAfter = /[A-Za-z0-9_]$/.test(term);
  return (text) => hasBoundedOccurrence(text, term, WORD_CHAR, checkBefore, checkAfter);
}

/**
 * Matches each changed term as a whole word, case-sensitively, across all non-history lines.
 */
export function findChangedTermHits(
  markdown: string,
  terms: string[],
): { lines: number[]; terms: string[] } {
  const searchable = extractSearchableLines(markdown);
  const compiled = terms.map((term) => ({ term, matches: wholeWordMatcher(term) }));
  const matchedLines: number[] = [];
  const matchedTermsSet = new Set<string>();

  for (const { lineNum, text } of searchable) {
    let lineMatched = false;
    for (const { term, matches } of compiled) {
      if (matches(text)) {
        matchedTermsSet.add(term);
        lineMatched = true;
      }
    }
    if (lineMatched) {
      matchedLines.push(lineNum);
    }
  }

  const matchedTerms = terms.filter((t) => matchedTermsSet.has(t));
  return { lines: matchedLines, terms: matchedTerms };
}

/**
 * Lists every `*-design*.md` file under `rootDir` except `excludeDocPath` and excluded folders
 * (`resume-records`, `claude-backup`, `backups`, etc.). Fails closed if `rootDir` or a
 * non-excluded subfolder cannot be read.
 */
export function collectOtherDesignDocPaths(
  rootDir: string,
  excludeDocPath: string,
): string[] {
  const absRoot = path.resolve(expandHome(rootDir.trim()));
  let rootInfo: Deno.FileInfo;
  try {
    rootInfo = Deno.statSync(absRoot);
  } catch (err) {
    throw new Error(
      `Refusing design:gate1: design-documents root cannot be read at ${absRoot}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!rootInfo.isDirectory) {
    throw new Error(
      `Refusing design:gate1: design-documents root at ${absRoot} is not a directory`,
    );
  }

  const absExclude = path.resolve(expandHome(excludeDocPath.trim()));
  const realExclude = resolveRealPathOrNull(absExclude);
  const found: string[] = [];
  const visitedDirs = new Set<string>();

  function visit(dir: string): void {
    const realDir = resolveRealPathOrNull(dir) ?? dir;
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch (err) {
      throw new Error(
        `Refusing design:gate1: design folder cannot be read at ${dir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || SWEEP_EXCLUDED_FOLDERS.has(entry.name)) {
        continue;
      }
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory) {
        visit(entryPath);
        continue;
      }
      if (entry.isSymlink) {
        try {
          const targetInfo = Deno.statSync(entryPath);
          if (targetInfo.isDirectory) {
            visit(entryPath);
            continue;
          }
        } catch {
          // Broken symlink: if it looks like a design doc, include it so the read step flags it as unchecked.
        }
      }
      if (!isSweepTargetFilename(entry.name)) {
        continue;
      }
      const resolved = path.resolve(entryPath);
      if (resolved === absExclude) {
        continue;
      }
      if (realExclude !== null) {
        const realCandidate = resolveRealPathOrNull(resolved);
        if (realCandidate !== null && realCandidate === realExclude) {
          continue;
        }
      }
      found.push(resolved);
    }
  }

  visit(absRoot);
  return found.sort();
}

function findMatchingSweepNote(
  otherPath: string,
  sweepNotes: SweepNote[],
): SweepNote | undefined {
  const absOther = path.resolve(otherPath);
  const realOther = resolveRealPathOrNull(absOther);
  for (const note of sweepNotes) {
    const absNote = path.resolve(expandHome(note.otherPath));
    if (absNote === absOther) return note;
    if (realOther !== null) {
      const realNote = resolveRealPathOrNull(absNote);
      if (realNote !== null && realNote === realOther) return note;
    }
  }
  return undefined;
}

/**
 * Scans every other design document under `options.rootDir` for `options.changedTerms`,
 * classifying hits as revised, noted, or unsettled, and unreadable files as unreadable-noted or
 * unchecked.
 */
export async function scanOtherDesignDocs(
  options: ScanOtherDesignDocsOptions,
): Promise<ScanOtherDesignDocsResult> {
  const terms = Array.from(new Set(options.changedTerms.map((t) => t.trim()).filter(Boolean)));
  const reader = options.readTextFileImpl ?? Deno.readTextFile;
  const sweepNotes = options.sweepNotes ?? [];

  const otherPaths = collectOtherDesignDocPaths(options.rootDir, options.docPath);
  const entries: OtherDesignSweepEntry[] = [];
  const unsettled: UnsettledDesignHit[] = [];
  const unchecked: UncheckedDesignDoc[] = [];

  for (const otherPath of otherPaths) {
    const note = findMatchingSweepNote(otherPath, sweepNotes);

    let content: string;
    try {
      content = await reader(otherPath);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (note) {
        entries.push({
          otherPath,
          lines: [],
          terms: [],
          status: "unreadable-noted",
          reason: note.reason,
        });
      } else {
        unchecked.push({ otherPath, error: errMsg });
      }
      continue;
    }

    const hits = findChangedTermHits(content, terms);
    if (hits.lines.length === 0) {
      continue;
    }

    const revisedToday = hasRevisionRowDated(content, options.todayIso);
    if (revisedToday) {
      entries.push({
        otherPath,
        lines: hits.lines,
        terms: hits.terms,
        status: "revised",
        revisionDate: options.todayIso,
        ...(note ? { reason: note.reason } : {}),
      });
    } else if (note) {
      entries.push({
        otherPath,
        lines: hits.lines,
        terms: hits.terms,
        status: "noted",
        reason: note.reason,
      });
    } else {
      unsettled.push({
        otherPath,
        lines: hits.lines,
        terms: hits.terms,
      });
    }
  }

  return { terms, entries, unsettled, unchecked };
}
