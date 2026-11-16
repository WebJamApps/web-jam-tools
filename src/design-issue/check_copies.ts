// src/design-issue/check_copies.ts
// Shared copied-word detection ("One document owns each rule") and push-time copy check
// (`deno task design:check-copies`, web-jam-tools#1813).

import { parseArgs } from "@std/cli/parse-args";
import * as path from "@std/path";
import {
  capturedRuleEndMarker,
  isValidSlug,
  parseCapturedRuleMarker,
} from "../../scripts/consume_memory_rules.ts";
import { expandHome, isDesignDocFilename, resolveDesignDocsRoot } from "./gate1.ts";
import type { LintViolation } from "./lint_doc.ts";

export const EXCLUDED_COPIED_TEXT_FOLDERS = new Set([
  "resume-records",
  "claude-backup",
  "backups",
]);
export const MIN_COPIED_WORD_RUN = 12;

const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const BLOCKQUOTE_LINE_RE = /^\s*>/;

export interface BodyWord {
  norm: string;
  raw: string;
  line: number;
}

export interface CopiedWordRun {
  wordCount: number;
  sharedWords: string;
  line: number;
}

export interface DesignDocIndexEntry {
  docPath: string;
  words: BodyWord[];
  grams: Map<string, number[]>;
}

export interface DiffFileHunks {
  filePath: string;
  addedRanges: Array<{ start: number; end: number }>;
}

export interface CheckCopyViolation {
  file: string;
  designDoc: string;
  wordCount: number;
  sharedWords: string;
  line: number;
  message: string;
}

export interface CheckCopiesOptions {
  repoDir?: string;
  range?: string;
  wholeFiles?: string[];
  dropboxDir?: string;
  designDocsRoot?: string;
}

export interface CheckCopiesResult {
  ok: boolean;
  violations: CheckCopyViolation[];
}

function isExcludedCopiedTextSectionHeading(headingText: string): boolean {
  const h = headingText.trim();
  if (/^Revision\s+History\b/i.test(h)) return true;
  if (/\bdecisions?\b/i.test(h) && /\b(?:record|log|table|appendix)\b/i.test(h)) return true;
  if (/^Decisions?\b/i.test(h)) return true;
  if (/^Load-bearing\s+premises\b/i.test(h)) return true;
  if (/^Both\s+surfaces\b/i.test(h)) return true;
  if (/^Where\s+things\s+live\b/i.test(h)) return true;
  if (/^Appendix\b/i.test(h)) return true;
  return false;
}

function preserveNewlinesAsSpaces(match: string): string {
  return match.replace(/[^\n]/g, " ");
}

const HTML_BLOCK_TAGS =
  "address|article|aside|blockquote|body|center|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|html|iframe|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul";
const HTML_BLOCK_OPEN = new RegExp(`^ {0,3}<(${HTML_BLOCK_TAGS})(?=[\\s/>]|$)`, "i");

const HTML_OPEN_TAG = /<([a-z0-9]+)(?=[\s/>])[^>]*?(\/?)>/gi;
const HTML_CLOSE_TAG = /<\/([a-z0-9]+)\s*>/gi;

/** The line a block-level HTML element closes on, or null when its tag is never closed. */
function htmlBlockEnd(lines: string[], start: number, tag: string): number | null {
  const targetTag = tag.toLowerCase();
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const open of lines[i].matchAll(HTML_OPEN_TAG)) {
      if (open[1].toLowerCase() === targetTag && open[2] !== "/") depth++;
    }
    for (const close of lines[i].matchAll(HTML_CLOSE_TAG)) {
      if (close[1].toLowerCase() === targetTag) depth--;
    }
    if (depth <= 0) return i;
  }
  return null;
}

/**
 * Blanks every complete block-level HTML element, from its opening line to its closing line, so
 * the text inside it is not compared. An element that is never closed ends at the next blank line.
 * Line positions are kept.
 */
function blankHtmlBlocks(lines: string[]): string[] {
  const kept = [...lines];
  for (let i = 0; i < kept.length; i++) {
    const open = kept[i].match(HTML_BLOCK_OPEN);
    if (!open) continue;
    let end = htmlBlockEnd(kept, i, open[1]);
    if (end === null) {
      end = i;
      while (end + 1 < kept.length && kept[end + 1].trim() !== "") end++;
    }
    for (let j = i; j <= end; j++) kept[j] = "";
    i = end;
  }
  return kept;
}

/**
 * Finds captured memory rule blocks (web-jam-tools#1317). Returns the document lines with every
 * line of a well-formed block blanked (line numbers unchanged) plus one violation per malformed
 * marker. Malformed markers exempt nothing (fail closed): a block holding a malformed marker is
 * not blanked. The first whole-line END marker with the block's slug closes it, as in
 * captureAndVerifyRulesInDesignDoc; markers inside a fenced code block are not markers.
 */
export function blankCapturedRuleBlocks(
  rawLines: string[],
): { lines: string[]; violations: LintViolation[] } {
  const lines = [...rawLines];
  const violations: LintViolation[] = [];
  const isFence = (line: string) => /^\s*```/.test(line) || /^\s*~~~/.test(line);
  const malformed = (i: number, why: string) =>
    violations.push({
      rule: "captured-rule-block-malformed",
      message: `Captured rule marker is malformed (${why}): "${rawLines[i].trim()}"`,
      line: i + 1,
      lineContent: rawLines[i],
    });
  let inFence = false;
  // An unmatched START stays open to the end of the document, so nothing after it is exempted.
  let unclosedStartOpen = false;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (isFence(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const marker = parseCapturedRuleMarker(line);
    if (!marker) continue;
    if (!isValidSlug(marker.slug)) {
      malformed(i, "invalid slug");
      continue;
    }
    if (marker.kind === "END") {
      malformed(i, "END marker with no open block");
      continue;
    }
    if (unclosedStartOpen) {
      malformed(i, "START marker while another block is open");
      continue;
    }
    const endMarker = capturedRuleEndMarker(marker.slug);
    const end = rawLines.findIndex((l, j) => j > i && l.trimEnd() === endMarker);
    if (end === -1) {
      malformed(i, "START marker with no later END marker of the same slug");
      unclosedStartOpen = true;
      continue;
    }
    // Inspect every marker inside the block; any malformed one leaves the whole block linted.
    let innerFence = false;
    let clean = true;
    const nestedOpen = new Map<string, number>();
    for (let j = i + 1; j < end; j++) {
      if (isFence(rawLines[j])) {
        innerFence = !innerFence;
        continue;
      }
      if (innerFence) continue;
      const inner = parseCapturedRuleMarker(rawLines[j]);
      if (!inner) continue;
      if (!isValidSlug(inner.slug)) {
        malformed(j, "invalid slug");
        clean = false;
      } else if (inner.kind === "START") {
        malformed(j, "START marker while another block is open");
        nestedOpen.set(inner.slug, (nestedOpen.get(inner.slug) ?? 0) + 1);
        clean = false;
      } else if (inner.kind === "END") {
        const open = nestedOpen.get(inner.slug) ?? 0;
        if (open > 0) {
          nestedOpen.set(inner.slug, open - 1);
        } else {
          malformed(j, "END marker with no open block");
          clean = false;
        }
      }
    }
    if (clean) {
      for (let j = i; j <= end; j++) lines[j] = "";
    }
    i = end;
  }
  return { lines, violations };
}

/**
 * Extracts normalized consecutive words from a markdown document's body for "One document owns each
 * rule". Leaves out captured rule blocks, fenced code blocks, anything in backticks or double
 * quotes, raw HTML, verbatim quotes (`>`), the revision table, the decision record, the
 * `Load-bearing Premises`, `Both Surfaces` and `Where Things Live` sections, and every section
 * whose heading begins `Appendix`.
 */
export function extractDesignBodyWords(content: string): BodyWord[] {
  const { lines } = blankCapturedRuleBlocks(content.split(/\r?\n/));
  const keptLines: string[] = [];
  // The opening fence's character and length: only a fence of the same character, at least as
  // long and with nothing after it closes the block, so a shorter fence inside it is plain text.
  let openFence: { char: string; length: number } | null = null;
  let excludedSectionLevel: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (openFence) {
      if (
        fence && fence[1][0] === openFence.char && fence[1].length >= openFence.length &&
        fence[2].trim() === ""
      ) openFence = null;
      keptLines.push("");
      continue;
    }
    // A backtick fence's info string holds no backtick, so a line like ```code``` is inline code.
    if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      openFence = { char: fence[1][0], length: fence[1].length };
      keptLines.push("");
      continue;
    }

    const headingMatch = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();
      if (excludedSectionLevel !== null && level <= excludedSectionLevel) {
        excludedSectionLevel = null;
      }
      if (excludedSectionLevel === null && isExcludedCopiedTextSectionHeading(headingText)) {
        excludedSectionLevel = level;
      }
      keptLines.push("");
      continue;
    }

    if (excludedSectionLevel !== null || BLOCKQUOTE_LINE_RE.test(line)) {
      keptLines.push("");
      continue;
    }

    keptLines.push(line);
  }

  let bodyText = blankHtmlBlocks(keptLines).join("\n");
  // Strip raw HTML comments, multi-line SVG/style blocks, and HTML tags while preserving line count
  bodyText = bodyText.replace(/<!--[\s\S]*?-->/g, preserveNewlinesAsSpaces);
  bodyText = bodyText.replace(/<svg\b[\s\S]*?<\/svg>/gi, preserveNewlinesAsSpaces);
  bodyText = bodyText.replace(/<style\b[\s\S]*?<\/style>/gi, preserveNewlinesAsSpaces);
  bodyText = bodyText.replace(/<\/?[A-Za-z!][^>\n]*>/g, preserveNewlinesAsSpaces);

  // Strip inline backtick spans and double-quoted spans (straight and curly)
  bodyText = bodyText.replace(/(`+)(?:[^`\n]|\n(?!\s*\n))*?\1/g, preserveNewlinesAsSpaces);
  bodyText = bodyText.replace(/"(?:\\.|[^"\\\n]|\n(?!\s*\n))*"/g, preserveNewlinesAsSpaces);
  bodyText = bodyText.replace(
    /\u201c(?:[^\u201d\n]|\n(?!\s*\n))*\u201d/g,
    preserveNewlinesAsSpaces,
  );

  const cleanedLines = bodyText.split("\n");
  const words: BodyWord[] = [];
  for (let i = 0; i < cleanedLines.length; i++) {
    const line = cleanedLines[i];
    for (const match of line.matchAll(/[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*/g)) {
      const raw = match[0];
      const norm = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (norm) {
        words.push({ norm, raw, line: i + 1 });
      }
    }
  }
  return words;
}

/** Lists design document files under the given design-documents root. */
export function listDesignDocsUnderRoot(rootDir: string, label = "design:lint-doc"): string[] {
  const absRoot = path.resolve(expandHome(rootDir.trim()));
  let rootEntries: Deno.DirEntry[];
  try {
    rootEntries = [...Deno.readDirSync(absRoot)];
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return [];
    }
    throw new Error(
      `Refusing ${label}: design-documents root cannot be read at ${absRoot}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const found: string[] = [];
  for (const entry of rootEntries) {
    if (entry.name.startsWith(".") || EXCLUDED_COPIED_TEXT_FOLDERS.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(absRoot, entry.name);
    if (entry.isDirectory) {
      let themeEntries: Deno.DirEntry[];
      try {
        themeEntries = [...Deno.readDirSync(entryPath)];
      } catch (err) {
        throw new Error(
          `Refusing ${label}: theme folder cannot be read at ${entryPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      for (const child of themeEntries) {
        if (child.isFile && isDesignDocFilename(child.name)) {
          found.push(path.join(entryPath, child.name));
        }
      }
    } else if (entry.isFile && isDesignDocFilename(entry.name)) {
      found.push(entryPath);
    }
  }

  return found.sort();
}

function buildWordGramIndex(words: BodyWord[]): Map<string, number[]> {
  const grams = new Map<string, number[]>();
  for (let j = 0; j + MIN_COPIED_WORD_RUN <= words.length; j++) {
    const gram = words
      .slice(j, j + MIN_COPIED_WORD_RUN)
      .map((w) => w.norm)
      .join(" ");
    const list = grams.get(gram);
    if (list) {
      list.push(j);
    } else {
      grams.set(gram, [j]);
    }
  }
  return grams;
}

/** Finds all maximal runs of >= MIN_COPIED_WORD_RUN consecutive normalized words. */
export function findCopiedRuns(
  docWords: BodyWord[],
  otherWords: BodyWord[],
  otherGrams: Map<string, number[]>,
): CopiedWordRun[] {
  if (docWords.length < MIN_COPIED_WORD_RUN || otherWords.length < MIN_COPIED_WORD_RUN) {
    return [];
  }
  const runs: CopiedWordRun[] = [];
  for (let i = 0; i + MIN_COPIED_WORD_RUN <= docWords.length; i++) {
    const gram = docWords
      .slice(i, i + MIN_COPIED_WORD_RUN)
      .map((w) => w.norm)
      .join(" ");
    const matchStarts = otherGrams.get(gram);
    if (!matchStarts) continue;

    let bestLen = MIN_COPIED_WORD_RUN;
    for (const j of matchStarts) {
      let len = MIN_COPIED_WORD_RUN;
      while (
        i + len < docWords.length &&
        j + len < otherWords.length &&
        docWords[i + len].norm === otherWords[j + len].norm
      ) {
        len++;
      }
      if (len > bestLen) {
        bestLen = len;
      }
    }

    const sharedWords = docWords
      .slice(i, i + bestLen)
      .map((w) => w.raw)
      .join(" ");
    runs.push({
      wordCount: bestLen,
      sharedWords,
      line: docWords[i].line,
    });
    i += bestLen - 1;
  }
  return runs;
}

function resolveRealPathOrSelf(absPath: string): string {
  try {
    return Deno.realPathSync(absPath);
  } catch {
    return absPath;
  }
}

/** Loads and indexes every design document under `rootDir` (refusing if any cannot be read). */
export function loadDesignDocsIndex(
  rootDir: string,
  options: { excludeDocPath?: string; label?: string } = {},
): DesignDocIndexEntry[] {
  const label = options.label ?? "design:lint-doc";
  const otherPaths = listDesignDocsUnderRoot(rootDir, label);
  if (otherPaths.length === 0) return [];

  const absDocPath = options.excludeDocPath
    ? path.resolve(expandHome(options.excludeDocPath.trim()))
    : "";
  const realDocPath = absDocPath ? resolveRealPathOrSelf(absDocPath) : null;

  const entries: DesignDocIndexEntry[] = [];
  for (const otherPath of otherPaths) {
    const resolvedOther = path.resolve(otherPath);
    if (absDocPath && resolvedOther === absDocPath) {
      continue;
    }
    if (realDocPath !== null) {
      let realOther: string | null = null;
      try {
        realOther = Deno.realPathSync(resolvedOther);
      } catch {
        realOther = null;
      }
      if (realOther !== null && realOther === realDocPath) {
        continue;
      }
    }

    let otherContent: string;
    try {
      otherContent = Deno.readTextFileSync(resolvedOther);
    } catch (err) {
      const noun = label === "design:lint-doc" ? "another design document" : "design document";
      throw new Error(
        `Refusing ${label}: ${noun} cannot be read at ${resolvedOther}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const words = extractDesignBodyWords(otherContent);
    if (words.length < MIN_COPIED_WORD_RUN) {
      continue;
    }
    entries.push({
      docPath: resolvedOther,
      words,
      grams: buildWordGramIndex(words),
    });
  }

  return entries;
}

/** Checks a design document's body against every other design document under `rootDir`. */
export function checkCopiedTextAcrossDesignDocs(
  content: string,
  docPath: string,
  rootDir: string,
): LintViolation[] {
  const index = loadDesignDocsIndex(rootDir, {
    excludeDocPath: docPath,
    label: "design:lint-doc",
  });
  if (index.length === 0) return [];

  const docWords = extractDesignBodyWords(content);
  if (docWords.length < MIN_COPIED_WORD_RUN) return [];

  const violations: LintViolation[] = [];
  for (const other of index) {
    for (const run of findCopiedRuns(docWords, other.words, other.grams)) {
      violations.push({
        rule: "no-copied-text",
        message: `Design document ${
          docPath || "<document>"
        } shares a run of ${run.wordCount} consecutive words with ${other.docPath}: "${run.sharedWords}"`,
        line: run.line,
      });
    }
  }
  return violations;
}

/** Returns true when `relPath` is an instruction file subject to push-time copy checks. */
export function isTargetCopyCheckFile(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith("skills/") || normalized.startsWith("docs/")) {
    return true;
  }
  const base = path.basename(normalized);
  return base === "AGENTS.md" || base === "CLAUDE.md";
}

/** Parses `git diff -U0` output into per-file 1-based inclusive added line ranges. */
export function parseUnifiedDiffAddedRanges(diffText: string): DiffFileHunks[] {
  const files: DiffFileHunks[] = [];
  let current: DiffFileHunks | null = null;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      current = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).replace(/\t$/, "");
      if (target === "/dev/null") {
        current = null;
        continue;
      }
      const filePath = target.startsWith("b/") ? target.slice(2) : target;
      current = { filePath, addedRanges: [] };
      files.push(current);
      continue;
    }
    if (current && line.startsWith("@@ ")) {
      const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!match) continue;
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      if (count > 0) {
        current.addedRanges.push({ start, end: start + count - 1 });
      }
    }
  }
  return files;
}

function runGit(
  repoDir: string,
  args: string[],
): { code: number; stdout: string; stderr: string } {
  const out = new Deno.Command("git", {
    args: ["-C", repoDir, ...args],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

function resolveCommitParentOrEmptyTree(repoDir: string, commitOid: string): string {
  const parent = runGit(repoDir, ["rev-parse", "--verify", "--quiet", `${commitOid}^`]);
  if (parent.code === 0) {
    return parent.stdout.trim();
  }
  return EMPTY_TREE_OID;
}

interface CheckedFileSlice {
  displayPath: string;
  content: string;
  addedRanges?: Array<{ start: number; end: number }>;
}

function collectDiffSlicesForCommitPair(
  repoDir: string,
  baseRev: string,
  targetRev: string | null,
): CheckedFileSlice[] {
  const diffArgs = ["-c", "core.quotePath=false", "diff", "-U0", "--no-color", "--no-ext-diff"];
  diffArgs.push(baseRev);
  if (targetRev !== null) diffArgs.push(targetRev);

  const diffRes = runGit(repoDir, diffArgs);
  if (diffRes.code !== 0) {
    throw new Error(
      `Refusing design:check-copies: git diff failed in ${repoDir}: ${diffRes.stderr.trim()}`,
    );
  }

  const slices: CheckedFileSlice[] = [];
  for (const entry of parseUnifiedDiffAddedRanges(diffRes.stdout)) {
    if (!isTargetCopyCheckFile(entry.filePath) || entry.addedRanges.length === 0) {
      continue;
    }
    let content: string;
    if (targetRev !== null) {
      const showRes = runGit(repoDir, ["show", `${targetRev}:${entry.filePath}`]);
      if (showRes.code !== 0) {
        throw new Error(
          `Refusing design:check-copies: could not read ${entry.filePath} at ${targetRev}: ${showRes.stderr.trim()}`,
        );
      }
      content = showRes.stdout;
    } else {
      const absFile = path.resolve(repoDir, entry.filePath);
      try {
        content = Deno.readTextFileSync(absFile);
      } catch (err) {
        throw new Error(
          `Refusing design:check-copies: could not read ${entry.filePath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    slices.push({
      displayPath: entry.filePath,
      content,
      addedRanges: entry.addedRanges,
    });
  }
  return slices;
}

function collectAddedSlicesForRange(repoDir: string, range: string): CheckedFileSlice[] {
  const tokens = range.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("Refusing design:check-copies: --range must not be empty.");
  }

  // Two-dot range <old>..<new>
  if (tokens.length === 1 && tokens[0].includes("..") && !tokens[0].includes("...")) {
    const [oldRev, newRev] = tokens[0].split("..");
    if (!oldRev || !newRev) {
      throw new Error(`Refusing design:check-copies: invalid range "${range}".`);
    }
    const verifyNew = runGit(repoDir, ["rev-parse", "--verify", `${newRev}^{commit}`]);
    if (verifyNew.code !== 0) {
      throw new Error(
        `Refusing design:check-copies: invalid commit "${newRev}" in range "${range}": ${verifyNew.stderr.trim()}`,
      );
    }
    const isAncestor = runGit(repoDir, ["merge-base", "--is-ancestor", oldRev, newRev]);
    if (isAncestor.code === 0) {
      const merges = runGit(repoDir, ["rev-list", "--merges", tokens[0]]);
      if (merges.code !== 0) {
        throw new Error(
          `Refusing design:check-copies: git rev-list failed for "${range}": ${merges.stderr.trim()}`,
        );
      }
      if (merges.stdout.trim() === "") {
        return collectDiffSlicesForCommitPair(repoDir, oldRev, newRev);
      }
      // If a branch merged dev, check only the branch's own non-merge commits still relevant to newRev.
      return collectSlicesFromCommits(repoDir, [tokens[0]]);
    }
    if (isAncestor.code === 1) {
      // Force-pushed / rebased branch: evaluate commits on newRev not on oldRev or remotes.
      return collectSlicesFromCommits(repoDir, [newRev, "--not", oldRev, "--remotes"], newRev);
    }
    throw new Error(
      `Refusing design:check-copies: could not resolve range "${range}": ${isAncestor.stderr.trim()}`,
    );
  }

  // `<sha> --not --remotes` or general rev-list range expression
  const targetRev = tokens.find((t) => !t.startsWith("-"));
  if (!targetRev) {
    throw new Error(`Refusing design:check-copies: invalid range "${range}".`);
  }
  const verifyTarget = runGit(repoDir, ["rev-parse", "--verify", `${targetRev}^{commit}`]);
  if (verifyTarget.code !== 0) {
    throw new Error(
      `Refusing design:check-copies: invalid commit "${targetRev}" in range "${range}": ${verifyTarget.stderr.trim()}`,
    );
  }

  const merges = runGit(repoDir, ["rev-list", "--merges", ...tokens]);
  if (merges.code !== 0) {
    throw new Error(
      `Refusing design:check-copies: git rev-list failed for "${range}": ${merges.stderr.trim()}`,
    );
  }
  if (merges.stdout.trim() === "") {
    const revList = runGit(repoDir, ["rev-list", "--topo-order", "--reverse", ...tokens]);
    if (revList.code !== 0) {
      throw new Error(
        `Refusing design:check-copies: git rev-list failed for "${range}": ${revList.stderr.trim()}`,
      );
    }
    const commits = revList.stdout.trim().split(/\r?\n/).filter(Boolean);
    if (commits.length === 0) return [];
    const baseRev = resolveCommitParentOrEmptyTree(repoDir, commits[0]);
    return collectDiffSlicesForCommitPair(repoDir, baseRev, targetRev);
  }

  return collectSlicesFromCommits(repoDir, tokens, targetRev);
}

function collectSlicesFromCommits(
  repoDir: string,
  revListArgs: string[],
  fallbackTip?: string,
): CheckedFileSlice[] {
  const revList = runGit(repoDir, [
    "rev-list",
    "--topo-order",
    "--reverse",
    "--no-merges",
    ...revListArgs,
  ]);
  if (revList.code !== 0) {
    throw new Error(
      `Refusing design:check-copies: git rev-list failed: ${revList.stderr.trim()}`,
    );
  }
  const commits = revList.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (commits.length === 0) {
    if (fallbackTip && revListArgs.includes("--remotes")) {
      // Fallback when remote refs are unavailable/empty for force-push comparison.
      const withoutRemotes = revListArgs.filter((a) => a !== "--remotes");
      const retry = runGit(repoDir, [
        "rev-list",
        "--topo-order",
        "--reverse",
        "--no-merges",
        ...withoutRemotes,
      ]);
      if (retry.code === 0) {
        const retryCommits = retry.stdout.trim().split(/\r?\n/).filter(Boolean);
        if (retryCommits.length > 0) {
          const baseRev = resolveCommitParentOrEmptyTree(repoDir, retryCommits[0]);
          return collectDiffSlicesForCommitPair(repoDir, baseRev, fallbackTip);
        }
      }
    }
    return [];
  }

  const slices: CheckedFileSlice[] = [];
  for (const commit of commits) {
    const parent = resolveCommitParentOrEmptyTree(repoDir, commit);
    slices.push(...collectDiffSlicesForCommitPair(repoDir, parent, commit));
  }
  return slices;
}

function collectDefaultBranchSlices(repoDir: string): CheckedFileSlice[] {
  const head = runGit(repoDir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.code !== 0) {
    return [];
  }

  let baseRef: string | null = null;
  for (const candidate of ["origin/dev", "dev", "origin/main", "main"]) {
    const check = runGit(repoDir, ["rev-parse", "--verify", "--quiet", candidate]);
    if (check.code === 0) {
      baseRef = candidate;
      break;
    }
  }
  if (!baseRef) {
    throw new Error(
      `Refusing design:check-copies: could not find base branch (origin/dev, dev, origin/main, or main) in ${repoDir}; pass --range or --whole-file.`,
    );
  }

  const mergeBase = runGit(repoDir, ["merge-base", baseRef, "HEAD"]);
  if (mergeBase.code !== 0) {
    throw new Error(
      `Refusing design:check-copies: could not find merge-base between ${baseRef} and HEAD in ${repoDir}: ${mergeBase.stderr.trim()}`,
    );
  }

  return collectDiffSlicesForCommitPair(repoDir, mergeBase.stdout.trim(), null);
}

function collectWholeFileSlices(repoDir: string, wholeFiles: string[]): CheckedFileSlice[] {
  const slices: CheckedFileSlice[] = [];
  for (const rawPath of wholeFiles) {
    const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(repoDir, rawPath);
    let content: string;
    try {
      content = Deno.readTextFileSync(absPath);
    } catch (err) {
      throw new Error(
        `Refusing design:check-copies: file cannot be read at ${rawPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    slices.push({
      displayPath: rawPath,
      content,
    });
  }
  return slices;
}

function checkSliceAgainstIndex(
  slice: CheckedFileSlice,
  index: DesignDocIndexEntry[],
): CheckCopyViolation[] {
  const bodyWords = extractDesignBodyWords(slice.content);
  if (bodyWords.length < MIN_COPIED_WORD_RUN) return [];

  const wordGroups: BodyWord[][] = slice.addedRanges
    ? slice.addedRanges
      .map((range) => bodyWords.filter((w) => w.line >= range.start && w.line <= range.end))
      .filter((group) => group.length >= MIN_COPIED_WORD_RUN)
    : [bodyWords];

  if (wordGroups.length === 0) return [];

  const violations: CheckCopyViolation[] = [];
  for (const words of wordGroups) {
    for (const designDoc of index) {
      for (const run of findCopiedRuns(words, designDoc.words, designDoc.grams)) {
        violations.push({
          file: slice.displayPath,
          designDoc: designDoc.docPath,
          wordCount: run.wordCount,
          sharedWords: run.sharedWords,
          line: run.line,
          message:
            `Copy violation in ${slice.displayPath} (line ${run.line}): shares ${run.wordCount} consecutive words with ${designDoc.docPath}: "${run.sharedWords}"`,
        });
      }
    }
  }
  return violations;
}

/**
 * Checks added lines (or explicit `--whole-file` targets) for 12+ consecutive words copied from
 * any design document's body under the design-documents root.
 */
export function checkCopies(options: CheckCopiesOptions = {}): CheckCopiesResult {
  const repoDir = path.resolve(expandHome(options.repoDir ?? Deno.cwd()));
  const wholeFiles = options.wholeFiles ?? [];

  if (wholeFiles.length > 0 && options.range !== undefined) {
    throw new Error("Refusing design:check-copies: --whole-file and --range cannot be combined.");
  }

  const slices = wholeFiles.length > 0
    ? collectWholeFileSlices(repoDir, wholeFiles)
    : options.range !== undefined
    ? collectAddedSlicesForRange(repoDir, options.range)
    : collectDefaultBranchSlices(repoDir);

  if (slices.length === 0) {
    return { ok: true, violations: [] };
  }

  const rootDir = resolveDesignDocsRoot(options.dropboxDir ?? options.designDocsRoot);
  const index = loadDesignDocsIndex(rootDir, { label: "design:check-copies" });
  if (index.length === 0) {
    return { ok: true, violations: [] };
  }

  const violations: CheckCopyViolation[] = [];
  for (const slice of slices) {
    violations.push(...checkSliceAgainstIndex(slice, index));
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

/**
 * CLI runner for `deno task design:check-copies`.
 */
export function runCheckCopiesCli(
  args: string[],
  options: {
    dropboxDir?: string;
    log?: (msg: string) => void;
    errorLog?: (msg: string) => void;
  } = {},
): number {
  const log = options.log ?? console.log;
  const errorLog = options.errorLog ?? console.error;

  const flags = parseArgs(args, {
    boolean: ["help", "json"],
    string: ["repo", "range", "dropbox-dir", "whole-file"],
    collect: ["whole-file"],
    alias: { h: "help", j: "json" },
    default: { help: false, json: false },
  });

  if (flags.help) {
    log(`Usage: deno task design:check-copies [options]

Checks instruction files (skills/, docs/, AGENTS.md, CLAUDE.md) for runs of 12 or more
consecutive words copied from a design document's body.

Options:
  --repo <path>         Repository root to inspect (default: current directory)
  --range <git-range>   Git revision range (e.g. "<old>..<new>" or "<sha> --not --remotes")
  --whole-file <path>   Check every line of a file instead of added lines (repeatable)
  --dropbox-dir <path>  Override the design-documents root (also DESIGN_DOCS_ROOT)
  -j, --json            Output results as JSON
  -h, --help            Show this help message
`);
    return 0;
  }

  const rawWholeFiles = (flags["whole-file"] as string[] | undefined) ?? [];
  for (const wf of rawWholeFiles) {
    if (!wf || wf.trim() === "") {
      errorLog("[design:check-copies] Error: --whole-file requires a file path.");
      return 1;
    }
  }

  try {
    const result = checkCopies({
      repoDir: flags.repo ? String(flags.repo) : undefined,
      range: flags.range !== undefined ? String(flags.range) : undefined,
      wholeFiles: rawWholeFiles,
      dropboxDir: flags["dropbox-dir"] ? String(flags["dropbox-dir"]) : options.dropboxDir,
    });

    if (flags.json) {
      log(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }

    if (result.ok) {
      return 0;
    }

    errorLog(
      `[design:check-copies] Refusing: found ${result.violations.length} copied design-document wording violation(s):`,
    );
    for (const v of result.violations) {
      errorLog(`- ${v.message}`);
    }
    return 1;
  } catch (err) {
    errorLog(
      `[design:check-copies] Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}
