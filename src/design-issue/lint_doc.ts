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
  openLen?: number;
  closeLen?: number;
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

const CURLY_DOUBLE_OPEN = String.fromCharCode(8220); // “
const CURLY_DOUBLE_CLOSE = String.fromCharCode(8221); // ”
const CURLY_SINGLE_OPEN = String.fromCharCode(8216); // ‘
const CURLY_SINGLE_CLOSE = String.fromCharCode(8217); // ’
const WORD_CHAR = /[A-Za-z0-9]/;

/**
 * Computes every mention-not-a-use range on a single (non-fenced-code-block) line in a single
 * left-to-right pass: inline code spans (backticks), straight double quotes, straight single
 * quotes, and typographic (curly) quotes.
 *
 * Scanning left-to-right in a single pass ensures that delimiters of different types nested inside
 * an established span (e.g. a double quote inside a single-quote span, or quotes inside a backtick
 * span) are consumed as literal span content rather than leaking into separate delimiter pairing
 * with unrelated trailing quotes on the line.
 *
 * Backtick code spans honor CommonMark's run-length delimiter rule: an opening run of N backticks
 * closes only at the next run of exactly N unescaped backticks.
 *
 * Straight single quotes (apostrophes) must be preceded by a non-word character (or line start) to
 * open and followed by a non-word character (or line end) to close, preventing mid-word apostrophes
 * (e.g. "it's", "skill's") from opening or closing spurious spans.
 *
 * Any unclosed delimiter fails closed, never exempting the rest of the line.
 */
function computeExemptRanges(line: string): ExemptRange[] {
  const ranges: ExemptRange[] = [];
  let i = 0;

  while (i < line.length) {
    if (isEscapedAt(line, i)) {
      i++;
      continue;
    }

    const ch = line[i];

    // 1. Backtick inline code span (CommonMark run-length rule)
    if (ch === "`") {
      let j = i;
      while (j < line.length && line[j] === "`") j++;
      const runLen = j - i;

      let closeStart: number | null = null;
      let k = j;
      while (k < line.length) {
        if (line[k] === "`" && !isEscapedAt(line, k)) {
          const crStart = k;
          while (k < line.length && line[k] === "`") k++;
          const crLen = k - crStart;
          if (crLen === runLen) {
            closeStart = crStart;
            break;
          }
        } else {
          k++;
        }
      }

      if (closeStart !== null) {
        ranges.push({
          start: i,
          end: closeStart + runLen,
          openLen: runLen,
          closeLen: runLen,
        });
        i = closeStart + runLen;
      } else {
        // Unclosed backtick run fails closed; advance past this run
        i = j;
      }
      continue;
    }

    // 2. Straight double quote
    if (ch === '"') {
      let closeIdx: number | null = null;
      for (let k = i + 1; k < line.length; k++) {
        if (line[k] === '"' && !isEscapedAt(line, k)) {
          closeIdx = k;
          break;
        }
      }

      if (closeIdx !== null) {
        ranges.push({
          start: i,
          end: closeIdx + 1,
          openLen: 1,
          closeLen: 1,
        });
        i = closeIdx + 1;
      } else {
        // Unclosed double quote fails closed
        i++;
      }
      continue;
    }

    // 3. Straight single quote
    if (ch === "'") {
      const prev = i > 0 ? line[i - 1] : undefined;
      const isOpenCandidate = prev === undefined || !WORD_CHAR.test(prev);

      if (isOpenCandidate) {
        let closeIdx: number | null = null;
        for (let k = i + 1; k < line.length; k++) {
          if (line[k] === "'" && !isEscapedAt(line, k)) {
            const next = k + 1 < line.length ? line[k + 1] : undefined;
            const isCloseCandidate = next === undefined || !WORD_CHAR.test(next);
            if (isCloseCandidate) {
              closeIdx = k;
              break;
            }
          }
        }

        if (closeIdx !== null) {
          ranges.push({
            start: i,
            end: closeIdx + 1,
            openLen: 1,
            closeLen: 1,
          });
          i = closeIdx + 1;
        } else {
          // Unclosed single quote fails closed
          i++;
        }
      } else {
        // Mid-word apostrophe (e.g. "it's") — not an open delimiter
        i++;
      }
      continue;
    }

    // 4. Typographic double quotes (“...”)
    if (ch === CURLY_DOUBLE_OPEN) {
      let closeIdx: number | null = null;
      for (let k = i + 1; k < line.length; k++) {
        if (line[k] === CURLY_DOUBLE_CLOSE && !isEscapedAt(line, k)) {
          closeIdx = k;
          break;
        }
      }

      if (closeIdx !== null) {
        ranges.push({
          start: i,
          end: closeIdx + 1,
          openLen: 1,
          closeLen: 1,
        });
        i = closeIdx + 1;
      } else {
        i++;
      }
      continue;
    }

    // 5. Typographic single quotes (‘...’)
    if (ch === CURLY_SINGLE_OPEN) {
      let closeIdx: number | null = null;
      for (let k = i + 1; k < line.length; k++) {
        if (line[k] === CURLY_SINGLE_CLOSE && !isEscapedAt(line, k)) {
          closeIdx = k;
          break;
        }
      }

      if (closeIdx !== null) {
        ranges.push({
          start: i,
          end: closeIdx + 1,
          openLen: 1,
          closeLen: 1,
        });
        i = closeIdx + 1;
      } else {
        i++;
      }
      continue;
    }

    // Normal character or unmatched close delimiter
    i++;
  }

  return ranges;
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
    const openLen = r.openLen ?? 1;
    const closeLen = r.closeLen ?? 1;
    for (let k = 0; k < openLen; k++) {
      stripIndices.add(r.start + k);
    }
    for (let k = 0; k < closeLen; k++) {
      stripIndices.add(r.end - 1 - k);
    }
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

  const standaloneDecisionLabelRegexes = [/\b[DR]-\d+\b/g];

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
