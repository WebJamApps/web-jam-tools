// src/design-issue/lint_doc.ts
// Linter for design documents checking against skill body rules (web-jam-tools#742).

import { parseArgs } from "@std/cli/parse-args";
import * as path from "@std/path";
import { expandHome } from "./gate1.ts";

export interface LintViolation {
  rule: string;
  message: string;
  line?: number;
  lineContent?: string;
}

export interface LintDocResult {
  docPath: string;
  valid: boolean;
  violations: LintViolation[];
}

export interface LintDocOptions {
  docPath: string;
  json?: boolean;
}

/** A half-open character range `[start, end)` on a single line that is a mention (inline code
 * span or quoted text) rather than a use, and is therefore exempt from banned-phrase matching. */
interface ExemptRange {
  start: number;
  end: number;
}

/**
 * True when the character at `idx` in `line` is preceded by an odd number of backslashes, i.e.
 * it is escaped (`\`` or `\"` or `\'`) and must not be treated as a delimiter.
 */
function isEscapedAt(line: string, idx: number): boolean {
  let backslashes = 0;
  let j = idx - 1;
  while (j >= 0 && line[j] === "\\") {
    backslashes++;
    j--;
  }
  return backslashes % 2 === 1;
}

/**
 * True when character index `idx` falls inside at least one of `ranges` -- used to keep a
 * delimiter that lives inside an already-established exempt range (e.g. a quote character
 * sitting inside a backtick code span) from being fed to a different collector and paired with
 * an unrelated later occurrence of the same character, which would produce a bogus range
 * spanning genuine bare prose in between.
 */
function isWithinAnyRange(idx: number, ranges: ExemptRange[]): boolean {
  return ranges.some((r) => idx >= r.start && idx < r.end);
}

/**
 * Collects exempt ranges for inline code spans, honoring CommonMark's run-length delimiter
 * rule: a run of N backtick characters opens a code span that closes only at the next run of
 * exactly N backticks; a run of a different length appearing inside is literal content, not a
 * delimiter. Pairing backtick characters positionally instead (1st with 2nd, 3rd with 4th) puts
 * both range boundaries on the delimiters themselves in the two-backtick case, missing the
 * content between them entirely -- this is what makes a double- (or longer-) backtick span
 * correctly exempt a banned phrase inside it. An unclosed run at end of line is discarded --
 * fails closed, never exempting the rest of the line.
 */
function collectBacktickRanges(line: string): ExemptRange[] {
  const ranges: ExemptRange[] = [];
  let i = 0;
  let pendingOpenStart: number | null = null;
  let pendingOpenLen = 0;

  while (i < line.length) {
    if (line[i] !== "`" || isEscapedAt(line, i)) {
      i++;
      continue;
    }

    const runStart = i;
    let j = i;
    while (j < line.length && line[j] === "`") j++;
    const runLen = j - runStart;

    if (pendingOpenStart === null) {
      pendingOpenStart = runStart;
      pendingOpenLen = runLen;
    } else if (runLen === pendingOpenLen) {
      ranges.push({ start: pendingOpenStart, end: j });
      pendingOpenStart = null;
      pendingOpenLen = 0;
    }
    // else: a run of a different length than the pending open is literal content inside the
    // span -- not a delimiter, keep scanning for the matching-length close.
    i = j;
  }

  return ranges;
}

/**
 * Collects exempt ranges for a symmetric delimiter (the same character opens and closes, e.g. a
 * straight double quote). Unescaped occurrences not already inside `excludeRanges` are paired
 * sequentially — 1st with 2nd, 3rd with 4th, etc. A trailing unpaired occurrence produces no
 * range, so it (and everything after it) fails closed rather than being silently exempted.
 */
function collectSymmetricRanges(
  line: string,
  delimiter: string,
  excludeRanges: ExemptRange[],
): ExemptRange[] {
  const positions: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (
      line[i] === delimiter && !isEscapedAt(line, i) && !isWithinAnyRange(i, excludeRanges)
    ) {
      positions.push(i);
    }
  }

  const ranges: ExemptRange[] = [];
  for (let i = 0; i + 1 < positions.length; i += 2) {
    ranges.push({ start: positions[i], end: positions[i + 1] + 1 });
  }
  return ranges;
}

/**
 * Collects exempt ranges for a straight single quote (an apostrophe character). Unlike
 * backticks or double quotes, an apostrophe also appears inside ordinary words (it's, the
 * skill's rules), so a naive sequential pairing would misfire. A character only counts as a
 * candidate open when it is not immediately preceded by a letter/digit (start of line,
 * whitespace, or opening punctuation), and only counts as a candidate close when it is not
 * immediately followed by a letter/digit. An apostrophe inside a word is preceded and followed
 * by a letter, so it never qualifies as either and is left alone. A quote character already
 * inside `excludeRanges` (e.g. one sitting inside a backtick span) is skipped entirely, never
 * treated as open or close. An unclosed open at end of line is discarded -- fails closed, never
 * exempting the rest of the line.
 */
function collectSingleQuoteRanges(line: string, excludeRanges: ExemptRange[]): ExemptRange[] {
  const ranges: ExemptRange[] = [];
  const wordChar = /[A-Za-z0-9]/;
  let pendingOpen: number | null = null;

  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "'" || isEscapedAt(line, i) || isWithinAnyRange(i, excludeRanges)) continue;

    const prev = i > 0 ? line[i - 1] : undefined;
    const next = i + 1 < line.length ? line[i + 1] : undefined;
    const isOpenCandidate = prev === undefined || !wordChar.test(prev);
    const isCloseCandidate = next === undefined || !wordChar.test(next);

    if (pendingOpen === null) {
      if (isOpenCandidate) {
        pendingOpen = i;
      }
      // else: looks like an apostrophe mid-word — not a delimiter, ignore.
    } else if (isCloseCandidate) {
      ranges.push({ start: pendingOpen, end: i + 1 });
      pendingOpen = null;
    }
    // else: ignore (e.g. an apostrophe inside the pending quoted span).
  }

  return ranges;
}

/**
 * Collects exempt ranges for a typographic (curly) quote pair where open and close are distinct
 * characters (e.g. U+201C/U+201D or U+2018/U+2019). A quote character already inside
 * `excludeRanges` is skipped entirely, never treated as open or close. A close with no pending
 * open is ignored; an open with no following close by end of line is discarded -- fails closed.
 */
function collectCurlyQuoteRanges(
  line: string,
  open: string,
  close: string,
  excludeRanges: ExemptRange[],
): ExemptRange[] {
  const ranges: ExemptRange[] = [];
  let pendingOpen: number | null = null;

  for (let i = 0; i < line.length; i++) {
    if (isWithinAnyRange(i, excludeRanges)) continue;
    const ch = line[i];
    if (ch === open && !isEscapedAt(line, i)) {
      if (pendingOpen === null) {
        pendingOpen = i;
      }
    } else if (ch === close && !isEscapedAt(line, i)) {
      if (pendingOpen !== null) {
        ranges.push({ start: pendingOpen, end: i + 1 });
        pendingOpen = null;
      }
    }
  }

  return ranges;
}

/**
 * Computes every mention-not-a-use range on a single (non-fenced-code-block) line: inline code
 * spans (backticks), straight double quotes, straight single quotes, and typographic (curly)
 * quotes. Each collector after the first excludes ranges already claimed by an earlier one, so a
 * quote character sitting inside a backtick span (or a straight quote sitting inside an
 * already-recognized quote span) is never independently paired with an unrelated later
 * occurrence of the same character — see `isWithinAnyRange`. See the per-delimiter helpers above
 * for the fail-closed handling of unclosed and escaped delimiters.
 */
function computeExemptRanges(line: string): ExemptRange[] {
  const backtickRanges = collectBacktickRanges(line);
  const doubleQuoteRanges = collectSymmetricRanges(line, '"', backtickRanges);
  const singleQuoteRanges = collectSingleQuoteRanges(line, [
    ...backtickRanges,
    ...doubleQuoteRanges,
  ]);
  const curlyDoubleOpen = String.fromCharCode(8220);
  const curlyDoubleClose = String.fromCharCode(8221);
  const curlySingleOpen = String.fromCharCode(8216);
  const curlySingleClose = String.fromCharCode(8217);
  const curlyDoubleRanges = collectCurlyQuoteRanges(line, curlyDoubleOpen, curlyDoubleClose, [
    ...backtickRanges,
    ...doubleQuoteRanges,
    ...singleQuoteRanges,
  ]);
  const curlySingleRanges = collectCurlyQuoteRanges(line, curlySingleOpen, curlySingleClose, [
    ...backtickRanges,
    ...doubleQuoteRanges,
    ...singleQuoteRanges,
    ...curlyDoubleRanges,
  ]);
  return [
    ...backtickRanges,
    ...doubleQuoteRanges,
    ...singleQuoteRanges,
    ...curlyDoubleRanges,
    ...curlySingleRanges,
  ];
}

/** True when `[start, end)` is entirely contained in at least one exempt range — i.e. the whole
 * match is a mention. A match only partially covered by a range (e.g. a backtick span covering
 * only part of a banned phrase) is NOT exempt. */
function isFullyExempt(start: number, end: number, ranges: ExemptRange[]): boolean {
  return ranges.some((r) => start >= r.start && end <= r.end);
}

/**
 * A line with every *confirmed* delimiter character (the paired backtick/quote marks behind
 * `ranges`) removed, plus a map from each remaining character's index back to its index on the
 * original line. The banned-phrase regexes require literal adjacency (`\s+` between words, no
 * gap inside a token), so a delimiter sitting inside a phrase — e.g. a backtick covering only
 * "design" of "design complete" — would otherwise stop the regex from matching at all rather
 * than being weighed for exemption. Matching against the delimiter-stripped text and mapping the
 * result back is what lets a *partially* quoted/backticked phrase still be recognized (and, once
 * recognized, correctly judged not-fully-exempt). An unpaired or escaped delimiter is never in
 * `ranges`, so it is left in place here too — it keeps interrupting the regex exactly as before,
 * which is how the fail-closed behavior for unclosed/escaped delimiters is preserved.
 */
function buildStrippedLine(
  line: string,
  ranges: ExemptRange[],
): { text: string; toOriginal: number[] } {
  const stripIndices = new Set<number>();
  for (const r of ranges) {
    stripIndices.add(r.start);
    stripIndices.add(r.end - 1);
  }

  let text = "";
  const toOriginal: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (stripIndices.has(i)) continue;
    text += line[i];
    toOriginal.push(i);
  }
  return { text, toOriginal };
}

/**
 * Scans `regexes` in order and returns the first match, across all occurrences on the line, that
 * is not fully covered by an exempt range. Matching runs against the delimiter-stripped text (see
 * `buildStrippedLine`) so a partially-quoted phrase is still found; the match is then mapped back
 * to original-line coordinates to decide exemption. Occurrences inside an exempt range are
 * skipped rather than stopping the scan, so a bare occurrence later in the same line (or matched
 * by a later regex) is still found — this is what makes "one quoted mention + one bare use on the
 * same line" report exactly one violation, for the bare one.
 */
function firstNonExemptMatch(
  line: string,
  regexes: RegExp[],
  ranges: ExemptRange[],
): { text: string } | null {
  const { text: strippedText, toOriginal } = buildStrippedLine(line, ranges);

  for (const regex of regexes) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(strippedText)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex++;
        continue;
      }

      const strippedStart = match.index;
      const strippedEnd = strippedStart + match[0].length;
      const origStart = toOriginal[strippedStart];
      const origEnd = toOriginal[strippedEnd - 1] + 1;

      if (!isFullyExempt(origStart, origEnd, ranges)) {
        regex.lastIndex = 0;
        return { text: match[0] };
      }

      if (!regex.global) {
        break;
      }
    }
    regex.lastIndex = 0;
  }
  return null;
}

/**
 * Checks a design document markdown string against the skill body rules:
 * 1. Fails if the document contains a status line (e.g., Status: / status: ...).
 * 2. Fails if the document contains a gate or approval state (e.g., Gate 1, Gate 2 approval state).
 * 3. Fails if the document contains the phrase "design complete" (case-insensitive).
 * 4. Fails if the document contains revision narration ("what changed", "an earlier version said", before/after framing).
 * 5. Fails if the document contains bare decision labels (e.g., "per D-7", "R-39").
 * 6. Fails if the document lacks a "## Both surfaces" section.
 */
export function lintDesignDoc(content: string, docPath: string = ""): LintDocResult {
  const violations: LintViolation[] = [];
  const lines = content.split(/\r?\n/);

  let inCodeBlock = false;
  let hasBothSurfacesSection = false;

  // Patterns for rules
  const statusLineRegex =
    /^\s*(?:[-*+]|\d+\.)?\s*(?:\*{1,2}|_{1,2})?status(?:\*{1,2}|_{1,2})?\s*[:=-]\s*\S+/i;
  const statusHeadingRegex = /^\s*#{1,6}\s+status\s*[:=-]?\s*$/i;

  const gateStateRegexes = [
    /\bgate\s+[12]\s*(?:[:=-]|—)\s*(?:approved|passed|pending|in\s*progress|open|completed|done|rejected|active)\b/gi,
    /\bgate\s+[12]\s+(?:approval\s+state|approval\s+status|state|status)\b/gi,
    /\b(?:approved|passed|pending)\s+at\s+gate\s+[12]\b/gi,
    /\b(?:pending|awaiting)\s+gate\s+[12]\s+approval\b/gi,
    /\bgate\s+[12]\s+(?:approved|passed|pending)\b/gi,
    /\bapproval\s+state\s*[:=-]\s*\S+/gi,
    /\bapproval\s+status\s*[:=-]\s*\S+/gi,
    /\bapproval\s+state\b/gi,
    /\bnothing\s+filed\b/gi,
  ];

  const designCompleteRegexes = [
    /\bdesign\s+complete\b/gi,
    /\bdesign\s+is\s+complete\b/gi,
    /\bdesign\s+completed\b/gi,
  ];

  const revisionNarrationRegexes = [
    /\bwhat\s+changed\b/i,
    /\ban\s+earlier\s+version\s+said\b/i,
    /\ba\s+previous\s+version\s+said\b/i,
    /\ban\s+earlier\s+draft\s+said\b/i,
    /\ba\s+previous\s+draft\s+said\b/i,
    /\bwhy\s+this\s+was\s+withdrawn\b/i,
    /\bwhy\s+this\s+was\s+abandoned\b/i,
    /\bchangelog\b/i,
    /\brevision\s+history\b/i,
    /\bbefore\/after\s+(?:framing|comparison)\b/i,
    /\bbefore\s+and\s+after\s+(?:framing|comparison)\b/i,
    /\bbefore\/after\b/i,
    /\bin\s+(?:an|a)\s+(?:earlier|previous)\s+(?:version|draft|iteration)\b/i,
    /\bthis\s+turned\s+out\s+to\s+be\s+false\b/i,
  ];

  const bareDecisionLabelRegexes = [
    /\bper\s+[DR]-\d+\b/gi,
    /\bper\s+[A-Z]-\d+\b/gi,
    /\b(?:as\s+decided\s+in|under|following|see|from)\s+[DR]-\d+\b/gi,
  ];

  const standaloneDecisionLabelRegexes = [/\b[DR]-\d+\b/gi];

  const bothSurfacesHeadingRegex = /^\s*#{1,6}\s+Both surfaces\b/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Toggle fenced code block
    if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      continue;
    }

    // Check for ## Both surfaces section heading
    if (bothSurfacesHeadingRegex.test(line)) {
      hasBothSurfacesSection = true;
    }

    // 1. Status line check
    if (statusLineRegex.test(line) || statusHeadingRegex.test(line)) {
      violations.push({
        rule: "no-status-line",
        message: `Design document contains a status line: "${line.trim()}"`,
        line: lineNum,
        lineContent: line,
      });
    }

    // Ranges on this line that are a mention (inline code span or quoted text) rather than a
    // use — exempt from the banned-phrase rules below (web-jam-tools#797). Unclosed backticks
    // or quotes fail closed: see computeExemptRanges and its helpers.
    const exemptRanges = computeExemptRanges(line);

    // 2. Gate or approval state check
    const gateMatch = firstNonExemptMatch(line, gateStateRegexes, exemptRanges);
    if (gateMatch) {
      violations.push({
        rule: "no-gate-or-approval-state",
        message: `Design document contains gate or approval state: "${gateMatch.text}"`,
        line: lineNum,
        lineContent: line,
      });
    }

    // 3. Phrase "design complete" check
    const designCompleteMatch = firstNonExemptMatch(line, designCompleteRegexes, exemptRanges);
    if (designCompleteMatch) {
      violations.push({
        rule: "no-design-complete",
        message:
          `Design document contains banned phrase "design complete": "${designCompleteMatch.text}"`,
        line: lineNum,
        lineContent: line,
      });
    }

    // 4. Revision narration check
    for (const regex of revisionNarrationRegexes) {
      const match = line.match(regex);
      if (match) {
        violations.push({
          rule: "no-revision-narration",
          message: `Design document contains revision narration: "${match[0]}"`,
          line: lineNum,
          lineContent: line,
        });
        break;
      }
    }

    // 5. Bare decision labels check
    let bareLabelFound = false;
    const bareLabelMatch = firstNonExemptMatch(line, bareDecisionLabelRegexes, exemptRanges);
    if (bareLabelMatch) {
      violations.push({
        rule: "no-bare-decision-labels",
        message: `Design document contains bare decision label: "${bareLabelMatch.text}"`,
        line: lineNum,
        lineContent: line,
      });
      bareLabelFound = true;
    }

    if (!bareLabelFound) {
      // Check for standalone [DR]-\d+ in prose (not as a decision table definition row `| D-1 |` or `| R-1 |`)
      const isTableDefinitionCell = /^\s*\|\s*[DR]-\d+\s*\|/i.test(line);
      if (!isTableDefinitionCell) {
        const standaloneMatch = firstNonExemptMatch(
          line,
          standaloneDecisionLabelRegexes,
          exemptRanges,
        );
        if (standaloneMatch) {
          violations.push({
            rule: "no-bare-decision-labels",
            message: `Design document contains bare decision label: "${standaloneMatch.text}"`,
            line: lineNum,
            lineContent: line,
          });
        }
      }
    }
  }

  // 6. Check for Both surfaces section
  if (!hasBothSurfacesSection) {
    violations.push({
      rule: "require-both-surfaces-section",
      message: "Design document lacks required '## Both surfaces' section",
    });
  }

  return {
    docPath,
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Reads and lints a design document file from disk.
 */
export async function lintDesignDocFile(filePath: string): Promise<LintDocResult> {
  if (!filePath || filePath.trim() === "") {
    throw new Error("Design document path is required");
  }

  const absPath = path.resolve(expandHome(filePath.trim()));

  let content: string;
  try {
    content = await Deno.readTextFile(absPath);
  } catch (err) {
    throw new Error(
      `Design document not found or cannot be read at ${absPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (content.trim() === "") {
    throw new Error(`Design document at ${absPath} is empty`);
  }

  return lintDesignDoc(content, absPath);
}

/**
 * CLI runner for deno task design:lint-doc <doc.md>.
 */
export async function runLintDocCli(args: string[]): Promise<number> {
  const flags = parseArgs(args, {
    boolean: ["help", "json"],
    string: ["doc"],
    alias: {
      h: "help",
      j: "json",
    },
    default: {
      help: false,
      json: false,
    },
  });

  if (flags.help) {
    console.log(`Usage: deno task design:lint-doc <doc.md> [options]

Checks a design document against the skill's body rules:
  - Fails if the document contains a status line (e.g. Status: Approved).
  - Fails if the document contains a gate or approval state (e.g. Gate 1 approval state).
  - Fails if the document contains the phrase "design complete" (case-insensitive).
  - Fails if the document contains revision narration ("what changed", "an earlier version said").
  - Fails if the document contains bare decision labels ("per D-7", "R-39").
  - Fails if the document lacks a "## Both surfaces" section.

Arguments:
  <doc.md>        Path to design document markdown file

Options:
  --doc <path>    Explicit design document path
  -j, --json      Output result as JSON
  -h, --help      Show this help message
`);
    return 0;
  }

  const docPath = flags.doc || (flags._.length > 0 ? String(flags._[0]) : "");
  if (!docPath) {
    console.error("Error: Missing required design document path.");
    console.error("Usage: deno task design:lint-doc <doc.md>");
    return 1;
  }

  try {
    const result = await lintDesignDocFile(docPath);

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.valid) {
      console.log(`[design:lint-doc] PASS: ${result.docPath} satisfies all design document rules.`);
    } else {
      console.error(
        `[design:lint-doc] FAIL: ${result.docPath} has ${result.violations.length} violation(s):`,
      );
      for (const v of result.violations) {
        const location = v.line ? ` (line ${v.line})` : "";
        console.error(`  - [${v.rule}]${location} ${v.message}`);
      }
    }

    return result.valid ? 0 : 1;
  } catch (err) {
    console.error(`[design:lint-doc] Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
