// src/design-issue/gate1.ts
// Gate 1 helper: renders markdown to HTML, takes a headless screenshot to confirm layout,
// and opens the HTML in Chrome on the active display (web-jam-tools#741).

import * as path from "@std/path";
import { renderDesignDoc } from "../../scripts/render_design_doc.ts";
import { lintDesignDoc } from "./lint_doc.ts";

export interface Gate1Options {
  docPath: string;
  screenshotPath?: string;
  noOpen?: boolean;
  screenshotImpl?: (htmlPath: string, screenshotPath: string) => Promise<{ sizeBytes: number }>;
  openBrowserImpl?: (htmlPath: string, display?: string) => Promise<void>;
  display?: string;
  dropboxDir?: string;
  findExistingDesignDocsImpl?: typeof findExistingDesignDocs;
}

export interface Gate1Result {
  docPath: string;
  htmlPath: string;
  screenshotPath: string;
  screenshotSizeBytes: number;
  opened: boolean;
}

/**
 * Expands leading `~` to $HOME or /home/joshua.
 */
export function expandHome(filePath: string): string {
  if (filePath.startsWith("~/") || filePath === "~") {
    const home = Deno.env.get("HOME") || "/home/joshua";
    if (filePath === "~") return home;
    return `${home}/${filePath.slice(2)}`;
  }
  return filePath;
}

/**
 * Resolves the destination HTML path for a given markdown path.
 * Replaces .md extension with .html, or appends .html.
 */
export function resolveHtmlPath(markdownPath: string): string {
  const expanded = expandHome(markdownPath);
  const resolved = path.resolve(expanded);
  if (resolved.toLowerCase().endsWith(".md")) {
    return resolved.slice(0, -3) + ".html";
  }
  return resolved + ".html";
}

/**
 * Takes a headless screenshot of the rendered HTML using google-chrome / chromium or playwright.
 * Fails loudly if screenshot generation fails or produces an empty file.
 */
export async function defaultScreenshotImpl(
  htmlPath: string,
  screenshotPath: string,
  execCommand?: (
    bin: string,
    args: string[],
  ) => Promise<{ success: boolean; code?: number }>,
): Promise<{ sizeBytes: number }> {
  const fileUrl = `file://${path.resolve(htmlPath)}`;
  const tempUserDataDir = await Deno.makeTempDir({ prefix: "gate1-chrome-profile-" });

  try {
    // Try CLI browser binaries first
    for (const bin of ["google-chrome", "chromium", "chromium-browser"]) {
      let outputSuccess = false;
      const args = [
        "--headless=new",
        `--user-data-dir=${tempUserDataDir}`,
        `--screenshot=${screenshotPath}`,
        "--window-size=1400,900",
        fileUrl,
      ];

      if (execCommand) {
        try {
          const res = await execCommand(bin, args);
          outputSuccess = res.success;
        } catch {
          continue;
        }
      } else {
        try {
          const cmd = new Deno.Command(bin, {
            args,
            stdout: "piped",
            stderr: "piped",
          });
          const output = await cmd.output();
          outputSuccess = output.success;
        } catch {
          continue;
        }
      }

      if (outputSuccess) {
        try {
          const fileInfo = await Deno.stat(screenshotPath);
          if (fileInfo.size > 0) {
            return { sizeBytes: fileInfo.size };
          }
        } catch {
          // continue
        }
      }
    }

    // Fallback to Playwright
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
        await page.goto(fileUrl, { waitUntil: "load" });
        await page.screenshot({ path: screenshotPath, fullPage: true });
        const fileInfo = await Deno.stat(screenshotPath);
        if (fileInfo.size > 0) {
          return { sizeBytes: fileInfo.size };
        }
      } finally {
        await browser.close();
      }
    } catch (err) {
      throw new Error(
        `Headless screenshot failed: no working browser executable found (checked google-chrome, chromium, chromium-browser, and playwright): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    throw new Error(`Screenshot output file at ${screenshotPath} is empty (0 bytes)`);
  } finally {
    try {
      await Deno.remove(tempUserDataDir, { recursive: true });
    } catch {
      // ignore if already removed
    }
  }
}

/**
 * Opens the rendered HTML in Google Chrome on the active display in the background.
 */
export async function defaultOpenBrowserImpl(
  htmlPath: string,
  display?: string,
  execCommand?: (
    cmd: string,
    env: Record<string, string>,
  ) => Promise<{ success: boolean; code: number }>,
): Promise<void> {
  const absHtmlPath = path.resolve(htmlPath);
  const activeDisplay = display || Deno.env.get("DISPLAY") || ":0";
  const shellCmd =
    `DISPLAY="${activeDisplay}" google-chrome "file://${absHtmlPath}" >/dev/null 2>&1 &`;
  const env = { ...Deno.env.toObject(), DISPLAY: activeDisplay };

  if (execCommand) {
    const output = await execCommand(shellCmd, env);
    if (!output.success) {
      throw new Error(`Failed to launch Google Chrome (exit code ${output.code})`);
    }
    return;
  }

  const cmd = new Deno.Command("bash", {
    args: ["-c", shellCmd],
    env,
    stdout: "null",
    stderr: "null",
  });

  const output = await cmd.output();
  if (!output.success) {
    throw new Error(`Failed to launch Google Chrome (exit code ${output.code})`);
  }
}

/**
 * Runs Gate 1 end-to-end:
 * 1. Validates and reads the markdown design doc.
 * 2. Renders it to HTML with design rules.
 * 3. Takes a headless screenshot to verify layout.
 * 4. Opens the HTML in Chrome on the active display.
 */
export async function runGate1(options: Gate1Options): Promise<Gate1Result> {
  if (!options.docPath || options.docPath.trim() === "") {
    throw new Error("Design document path is required");
  }

  const absDocPath = path.resolve(expandHome(options.docPath.trim()));

  let markdownContent: string;
  try {
    markdownContent = await Deno.readTextFile(absDocPath);
  } catch (err) {
    throw new Error(
      `Design document not found or cannot be read at ${absDocPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (markdownContent.trim() === "") {
    throw new Error(`Design document at ${absDocPath} is empty`);
  }

  // Refuse to render or open a document whose design:lint-doc run does not pass, so the checker
  // cannot be bypassed by invoking Gate 1 directly instead of running the linter first
  // (web-jam-tools#815). There is no flag to skip this — the whole point is that it can't be
  // walked around.
  const lintResult = lintDesignDoc(markdownContent, absDocPath);
  if (!lintResult.valid) {
    const violationLines = lintResult.violations
      .map((v) => `  - [${v.rule}]${v.line ? ` (line ${v.line})` : ""} ${v.message}`)
      .join("\n");
    throw new Error(
      `Design document at ${absDocPath} failed design:lint-doc with ${lintResult.violations.length} violation(s) — refusing to render or open Gate 1:\n${violationLines}`,
    );
  }

  // Refuse to render or open a redundant parallel design document when a pre-existing
  // canonical design document already exists for the same topic (web-jam-tools#886).
  const docFilename = path.basename(absDocPath);
  const docTopic = extractTopicFromText(docFilename);
  if (docTopic) {
    const finder = options.findExistingDesignDocsImpl || findExistingDesignDocs;
    const existing = await finder({
      topic: docTopic,
      dropboxDir: options.dropboxDir,
    });
    const olderCanonical = existing.find(
      (doc) => path.resolve(doc.path) !== absDocPath && doc.isMatch,
    );
    if (olderCanonical) {
      throw new Error(
        `Refusing to process redundant parallel design document for "${docTopic}": pre-existing canonical design document already exists at ${olderCanonical.path}. Perform a Major Revision to the existing document in-place instead.`,
      );
    }
  }

  const htmlPath = resolveHtmlPath(absDocPath);
  const fallbackTitle = path.basename(absDocPath, path.extname(absDocPath));
  const renderedHtml = renderDesignDoc(markdownContent, fallbackTitle);

  if (!renderedHtml || renderedHtml.trim() === "") {
    throw new Error(`Rendered HTML for ${absDocPath} is empty`);
  }

  await Deno.writeTextFile(htmlPath, renderedHtml);

  // Determine screenshot path
  const screenshotPath = options.screenshotPath
    ? path.resolve(expandHome(options.screenshotPath))
    : path.join(
      await Deno.makeTempDir({ prefix: "gate1-screenshot-" }),
      "rendered-design-doc.png",
    );

  const screenshotRunner = options.screenshotImpl || defaultScreenshotImpl;
  const { sizeBytes: screenshotSizeBytes } = await screenshotRunner(htmlPath, screenshotPath);

  let opened = false;
  if (!options.noOpen) {
    const openRunner = options.openBrowserImpl || defaultOpenBrowserImpl;
    await openRunner(htmlPath, options.display);
    opened = true;
  }

  return {
    docPath: absDocPath,
    htmlPath,
    screenshotPath,
    screenshotSizeBytes,
    opened,
  };
}

export interface ExistingDesignDocMatch {
  path: string;
  theme: string;
  filename: string;
  topic: string;
  date?: string;
  isMatch: boolean;
  suggestion: string;
}

export interface FindDesignDocOptions {
  theme?: string;
  topic?: string;
  title?: string;
  dropboxDir?: string;
}

/**
 * Resolves the root directory that holds `<Theme>/<topic>-design-*.md` documents.
 *
 * Precedence: an explicit `dropboxDir` argument, then `DESIGN_DOCS_ROOT`, then `DROPBOX_BASE_DIR`,
 * then the default `~/Dropbox/web-jam-llms`. `DESIGN_DOCS_ROOT` names this resolver's own subject
 * (design documents) rather than Dropbox as a whole, so pointing a run at a scratch or nonexistent
 * root does not require repointing every other Dropbox-backed task.
 */
export function resolveDesignDocsRoot(dropboxDir?: string): string {
  if (dropboxDir) return path.resolve(expandHome(dropboxDir));

  const designDocsRoot = Deno.env.get("DESIGN_DOCS_ROOT");
  if (designDocsRoot) return path.resolve(expandHome(designDocsRoot));

  const dropboxBaseDir = Deno.env.get("DROPBOX_BASE_DIR");
  if (dropboxBaseDir) return path.resolve(expandHome(dropboxBaseDir));

  return path.resolve(expandHome("~/Dropbox/web-jam-llms"));
}

/**
 * Normalizes a topic string into a clean lowercase slug (e.g. "design-issue").
 */
export function normalizeTopicSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Extracts a topic slug from free-form text such as an issue title, epic title, or scope prefix.
 * e.g. "skills/design-issue: automatically match..." -> "design-issue"
 *      "[Epic] book-gig skill enhancements" -> "book-gig"
 */
export function extractTopicFromText(text: string): string {
  if (!text || typeof text !== "string") return "";

  let cleaned = text.trim();

  // Strip wrapping quotes or parens e.g. ("...")
  cleaned = cleaned.replace(/^\(+/, "").replace(/\)+$/, "").trim();
  cleaned = cleaned.replace(/^["']+|["']+$/g, "").trim();

  // Strip repo#issue citations e.g. web-jam-tools#737 or #737
  cleaned = cleaned.replace(/^[a-zA-Z0-9_-]+#\d+\s*/, "");
  cleaned = cleaned.replace(/^#\d+\s*/, "");

  // Strip [Epic] or Epic: prefixes
  cleaned = cleaned.replace(/^\[epic\]\s*/i, "");
  cleaned = cleaned.replace(/^epic:\s*/i, "");

  // Check prefix before colon if present
  const colonIndex = cleaned.indexOf(":");
  if (colonIndex !== -1) {
    const prefix = cleaned.slice(0, colonIndex).trim();
    let candidate = prefix
      .replace(/^(skills|src|tools|scripts)\//i, "")
      .replace(/\[.*?\]/g, "")
      .trim();
    if (candidate.includes("/")) {
      candidate = candidate.split("/")[0].trim();
    }
    if (candidate && !/^(feat|fix|test|chore|docs|refactor)$/i.test(candidate)) {
      return normalizeTopicSlug(candidate);
    }
    cleaned = cleaned.slice(colonIndex + 1).trim();
  }

  // Strip path prefixes
  cleaned = cleaned.replace(/^(skills|src|tools|scripts)\//i, "");

  // Check for "<word>-skill"
  const skillMatch = cleaned.match(/\b([a-z0-9]+(?:-[a-z0-9]+)*)-skill\b/i);
  if (skillMatch) {
    return normalizeTopicSlug(skillMatch[1]);
  }

  // Check for "<word> skill"
  const skillWordMatch = cleaned.match(/\b([a-z0-9]+(?:-[a-z0-9]+)*)\s+skill\b/i);
  if (skillWordMatch) {
    return normalizeTopicSlug(skillWordMatch[1]);
  }

  // Check for hyphenated words like "design-issue" or "book-gig"
  const hyphenatedMatch = cleaned.match(/\b([a-z0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*)\b/i);
  if (hyphenatedMatch) {
    return normalizeTopicSlug(hyphenatedMatch[1]);
  }

  // Fallback to first non-trivial token
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    return normalizeTopicSlug(words[0]);
  }

  return "";
}

/**
 * Checks if a filename is a candidate design document markdown file.
 * Excludes runbooks, walkthroughs, test logs, backups, and non-markdown files.
 */
export function isDesignDocFilename(filename: string): boolean {
  if (!filename) return false;
  const lower = filename.toLowerCase();
  if (!lower.endsWith(".md")) return false;
  if (lower.includes(".bak") || lower.includes(".bak-")) return false;
  if (
    lower.includes("-manual-steps-") ||
    lower.includes("-josh-steps-") ||
    lower.includes("-steps-") ||
    lower.includes("-run-") ||
    lower.includes("manual-steps")
  ) {
    return false;
  }
  return lower.includes("-design-") || lower.endsWith("-design.md");
}

/**
 * Extracts date (YYYY-MM-DD) from filename if present.
 */
export function extractDateFromFilename(filename: string): string | undefined {
  const match = filename.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return match ? match[1] : undefined;
}

/**
 * Checks whether a design document filename matches a given topic slug.
 * Avoids dynamic RegExp construction for ReDoS safety.
 */
export function matchesTopic(filename: string, topic: string): boolean {
  if (!filename || !topic) return false;
  if (!isDesignDocFilename(filename)) return false;

  const base = path.basename(filename).toLowerCase();
  const normTopic = normalizeTopicSlug(topic);
  if (!normTopic) return false;

  // Direct prefix match: <topic>-*
  if (base.startsWith(`${normTopic}-`) || base.startsWith(`${normTopic}.`)) {
    return true;
  }

  // Topic with underscores
  const topicUnderscore = normTopic.replace(/-/g, "_");
  if (base.startsWith(`${topicUnderscore}-`) || base.startsWith(`${topicUnderscore}.`)) {
    return true;
  }

  // Check prefix before the final "-design"
  const designIndex = base.lastIndexOf("-design");
  if (designIndex !== -1) {
    const prefix = base.slice(0, designIndex);
    if (prefix === normTopic || prefix.startsWith(`${normTopic}-`)) {
      return true;
    }
    const tokens = normTopic.split("-").filter(Boolean);
    if (tokens.length > 1 && tokens.every((tok) => prefix.includes(tok))) {
      return true;
    }
  }

  return false;
}

/**
 * Formats a clear, actionable prompt proposing a Major Revision to an existing design document.
 */
export function formatMajorRevisionPrompt(docPath: string, topic: string): string {
  return (
    `Found existing canonical design document for "${topic}":\n` +
    `  ${docPath}\n` +
    `Proposing a Major Revision to the existing document rather than spawning a new standalone file.\n` +
    `Protocol:\n` +
    `  1. Record a new entry in ## Revision History (increment version, record date, Epic / Issue link, summary).\n` +
    `  2. Update architecture, ERD, decisions, and both-surfaces sections in-place.\n` +
    `  3. Preserve the document as the single source of truth for the feature.\n` +
    `  4. Strictly refuse creating redundant parallel design documents (e.g. *-phase-2-design-*.md).`
  );
}

/**
 * Scans ~/Dropbox/web-jam-llms/<Theme>/ for existing topic design documents.
 * Returns matches sorted newest-first by revision date.
 */
export async function findExistingDesignDocs(
  options: FindDesignDocOptions,
): Promise<ExistingDesignDocMatch[]> {
  const topic = options.topic || (options.title ? extractTopicFromText(options.title) : "");
  if (!topic) return [];

  const baseDir = resolveDesignDocsRoot(options.dropboxDir);

  const themesToScan: string[] = [];

  if (options.theme) {
    themesToScan.push(options.theme);
  } else {
    try {
      for await (const entry of Deno.readDir(baseDir)) {
        if (entry.isDirectory && !entry.name.startsWith(".")) {
          themesToScan.push(entry.name);
        }
      }
    } catch {
      return [];
    }
  }

  const matches: ExistingDesignDocMatch[] = [];

  for (const theme of themesToScan) {
    const themeDir = path.join(baseDir, theme);
    try {
      for await (const entry of Deno.readDir(themeDir)) {
        if (entry.isFile && matchesTopic(entry.name, topic)) {
          const fullPath = path.join(themeDir, entry.name);
          const docDate = extractDateFromFilename(entry.name);
          matches.push({
            path: fullPath,
            theme,
            filename: entry.name,
            topic,
            date: docDate,
            isMatch: true,
            suggestion: formatMajorRevisionPrompt(fullPath, topic),
          });
        }
      }
    } catch {
      // directory unreadable or doesn't exist, continue
    }
  }

  // Sort newest-first (date descending, then filename descending)
  matches.sort((a, b) => {
    if (a.date && b.date) {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
    } else if (a.date) {
      return -1;
    } else if (b.date) {
      return 1;
    }
    return b.filename.localeCompare(a.filename);
  });

  return matches;
}

/**
 * Finds the canonical existing design document for a feature/topic, returning the newest match or null.
 */
export async function findExistingDesignDoc(
  options: FindDesignDocOptions,
): Promise<ExistingDesignDocMatch | null> {
  const docs = await findExistingDesignDocs(options);
  return docs.length > 0 ? docs[0] : null;
}

/** One row of a design document's decisions-record appendix: its ID and its recorded outcome. */
export interface DecisionRecordEntry {
  id: string;
  outcome: string;
}

/**
 * Which of the two determinate states the canonical-document precondition found.
 * The third state — "cannot tell" — is never a return value; it throws
 * `DesignDocResolutionRefusal`, so it cannot be mistaken for "no document".
 */
export type CanonicalDesignDocOutcome = "existing-document" | "no-document";

export interface CanonicalDesignDocResolution {
  outcome: CanonicalDesignDocOutcome;
  topic: string;
  root: string;
  match: ExistingDesignDocMatch | null;
  decisions: DecisionRecordEntry[];
}

/**
 * Thrown when the canonical-document precondition cannot determine whether a design document
 * exists — a missing design-documents root, an unmounted Dropbox, an unreadable theme directory,
 * an unresolvable topic, or a canonical document that cannot be read.
 *
 * This is the fail-closed outcome. A silent "no document found" and a silent "could not look" are
 * indistinguishable to an agent, and both let a design run proceed against an already-designed
 * feature, so the indeterminate case refuses rather than returning an empty result
 * (web-jam-tools#942).
 */
export class DesignDocResolutionRefusal extends Error {
  readonly resolutionPath: string;
  readonly reason: string;

  constructor(resolutionPath: string, reason: string) {
    super(
      `Refusing to proceed with the design run: cannot determine whether a canonical design ` +
        `document already exists, because ${reason} at ${resolutionPath}. Fix or mount that path ` +
        `and re-run. The run must not continue as though no design document existed.`,
    );
    this.name = "DesignDocResolutionRefusal";
    this.resolutionPath = resolutionPath;
    this.reason = reason;
  }
}

const DECISIONS_RECORD_HEADING = /^#{2,4}\s+.*\bdecisions?\b[\s\S]{0,40}?\brecord\b/i;
const ANY_HEADING = /^#{1,6}\s+/;
const TABLE_SEPARATOR_ROW = /^\|[\s:|-]+\|?\s*$/;
const NON_ID_HEADER_CELLS = new Set(["", "#", "id", "no", "no.", "num", "decision", "topic"]);

/** Collapses a markdown table cell to a single readable line. */
function flattenDecisionCell(cell: string): string {
  return cell
    .replace(/<br\s*\/?>/gi, "; ")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts the ID and outcome of every row in a design document's decisions-record appendix.
 *
 * Tolerates the heading and column shapes actually in use across the design documents
 * (`## Appendix — Decisions Record` with an `| ID | Topic | Options | Decision / Outcome |` table,
 * and `## Appendix B — decision record` with a `| # | Decision | Outcome |` table): the first cell
 * is the ID and the last cell is the outcome in both.
 */
export function parseDecisionsRecord(
  markdown: string,
  maxOutcomeLength = 240,
): DecisionRecordEntry[] {
  if (!markdown) return [];

  const lines = markdown.split(/\r?\n/);
  const entries: DecisionRecordEntry[] = [];
  let inSection = false;

  for (const line of lines) {
    if (ANY_HEADING.test(line)) {
      inSection = DECISIONS_RECORD_HEADING.test(line);
      continue;
    }
    if (!inSection) continue;

    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    if (TABLE_SEPARATOR_ROW.test(trimmed)) continue;

    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
    if (cells.length < 2) continue;

    const id = flattenDecisionCell(cells[0]);
    if (NON_ID_HEADER_CELLS.has(id.toLowerCase())) continue;

    let outcome = flattenDecisionCell(cells[cells.length - 1]);
    if (outcome.length > maxOutcomeLength) {
      outcome = `${outcome.slice(0, maxOutcomeLength).trimEnd()}…`;
    }

    entries.push({ id, outcome });
  }

  return entries;
}

export interface ResolveCanonicalDesignDocOptions extends FindDesignDocOptions {
  findExistingDesignDocsImpl?: typeof findExistingDesignDocs;
  readTextFileImpl?: (filePath: string) => Promise<string>;
}

/** Reads a directory purely to prove it is readable, refusing (never returning empty) if it is not. */
async function assertDirectoryReadable(dirPath: string, describe: string): Promise<void> {
  try {
    const info = await Deno.stat(dirPath);
    if (!info.isDirectory) {
      throw new DesignDocResolutionRefusal(dirPath, `${describe} is not a directory`);
    }
  } catch (err) {
    if (err instanceof DesignDocResolutionRefusal) throw err;
    throw new DesignDocResolutionRefusal(
      dirPath,
      `${describe} is missing or unreadable (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  try {
    for await (const _entry of Deno.readDir(dirPath)) {
      // Enumerating is the probe; the entries themselves are matched by findExistingDesignDocs.
    }
  } catch (err) {
    throw new DesignDocResolutionRefusal(
      dirPath,
      `${describe} could not be listed (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/**
 * The canonical-document precondition for a design run (web-jam-tools#942).
 *
 * Unlike the Gate 1 refusal below — which fires late, on the act of rendering a duplicate file, and
 * so never fires at all for a run that writes no file — this resolves the topic's canonical design
 * document up front, so a run cannot put a decision to Josh without having read what the existing
 * document already settles.
 *
 * Three outcomes, all of them specified:
 *   1. a canonical document exists — returns `existing-document` with the match and its
 *      decisions-record entries, which the caller reads in full and reports;
 *   2. none exists — returns `no-document`, and the run creates a new document as before;
 *   3. it cannot tell — throws `DesignDocResolutionRefusal`, naming the path. It never
 *      degrades to outcome 2.
 */
export async function resolveCanonicalDesignDoc(
  options: ResolveCanonicalDesignDocOptions,
): Promise<CanonicalDesignDocResolution> {
  const topic = options.topic || (options.title ? extractTopicFromText(options.title) : "");
  const root = resolveDesignDocsRoot(options.dropboxDir);

  if (!topic) {
    throw new DesignDocResolutionRefusal(
      root,
      `no topic slug could be resolved from ${
        JSON.stringify(options.topic ?? options.title ?? "")
      }, so no canonical design document could be searched for`,
    );
  }

  await assertDirectoryReadable(root, "the design-documents root");

  const themes: string[] = [];
  if (options.theme) {
    themes.push(options.theme);
  } else {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isDirectory && !entry.name.startsWith(".")) {
        themes.push(entry.name);
      }
    }
  }

  for (const theme of themes) {
    await assertDirectoryReadable(path.join(root, theme), `the theme folder "${theme}"`);
  }

  const finder = options.findExistingDesignDocsImpl ?? findExistingDesignDocs;
  const matches = await finder({ topic, theme: options.theme, dropboxDir: root });

  if (matches.length === 0) {
    return { outcome: "no-document", topic, root, match: null, decisions: [] };
  }

  const match = matches[0];
  const readTextFile = options.readTextFileImpl ?? Deno.readTextFile;

  let contents: string;
  try {
    contents = await readTextFile(match.path);
  } catch (err) {
    throw new DesignDocResolutionRefusal(
      match.path,
      `the canonical design document was found but could not be read (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }

  return {
    outcome: "existing-document",
    topic,
    root,
    match,
    decisions: parseDecisionsRecord(contents),
  };
}

/**
 * Formats the resolution for a CLI, as the lines a design run must see before it puts any
 * decision to Josh.
 */
export function formatCanonicalDesignDocResolution(
  resolution: CanonicalDesignDocResolution,
  prefix: string,
): string[] {
  if (resolution.outcome === "no-document" || !resolution.match) {
    return [`${prefix} No existing design document found for "${resolution.topic}".`];
  }

  const lines = [
    `${prefix} Resolved existing canonical design document for "${resolution.match.topic}":`,
    `  ${resolution.match.path}`,
  ];

  if (resolution.decisions.length === 0) {
    lines.push(
      `${prefix} Decisions record: no decisions-record appendix found in that document — read it end to end before putting any decision to Josh.`,
    );
  } else {
    lines.push(
      `${prefix} Decisions record — ${resolution.decisions.length} entr${
        resolution.decisions.length === 1 ? "y" : "ies"
      } already settled. Read the document end to end before putting any decision to Josh:`,
    );
    for (const entry of resolution.decisions) {
      lines.push(`  ${entry.id}: ${entry.outcome}`);
    }
  }

  return lines;
}

/**
 * Refuses creation of redundant parallel design documents when a canonical design document
 * already exists for the given feature/topic. Throws an Error on collision.
 */
export async function refuseRedundantDesignDoc(
  topicOrOptions: string | FindDesignDocOptions,
  options?: FindDesignDocOptions,
): Promise<ExistingDesignDocMatch | null> {
  const opts: FindDesignDocOptions = typeof topicOrOptions === "string"
    ? { topic: topicOrOptions, ...options }
    : topicOrOptions;

  const match = await findExistingDesignDoc(opts);
  if (match) {
    throw new Error(
      `Refusing to create redundant parallel design document for "${match.topic}": pre-existing canonical design document already exists at ${match.path}. Perform a Major Revision to the existing document in-place instead.`,
    );
  }
  return null;
}
