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
    /\bgate\s+[12]\s*(?:[:=-]|—)\s*(?:approved|passed|pending|in\s*progress|open|completed|done|rejected|active)\b/i,
    /\bgate\s+[12]\s+(?:approval\s+state|approval\s+status|state|status)\b/i,
    /\b(?:approved|passed|pending)\s+at\s+gate\s+[12]\b/i,
    /\b(?:pending|awaiting)\s+gate\s+[12]\s+approval\b/i,
    /\bgate\s+[12]\s+(?:approved|passed|pending)\b/i,
    /\bapproval\s+state\s*[:=-]\s*\S+/i,
    /\bapproval\s+status\s*[:=-]\s*\S+/i,
    /\bapproval\s+state\b/i,
    /\bnothing\s+filed\b/i,
  ];

  const designCompleteRegexes = [
    /\bdesign\s+complete\b/i,
    /\bdesign\s+is\s+complete\b/i,
    /\bdesign\s+completed\b/i,
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
    /\bper\s+[DR]-\d+\b/i,
    /\bper\s+[A-Z]-\d+\b/i,
    /\b(?:as\s+decided\s+in|under|following|see|from)\s+[DR]-\d+\b/i,
  ];

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

    // 2. Gate or approval state check
    for (const regex of gateStateRegexes) {
      const match = line.match(regex);
      if (match) {
        violations.push({
          rule: "no-gate-or-approval-state",
          message: `Design document contains gate or approval state: "${match[0]}"`,
          line: lineNum,
          lineContent: line,
        });
        break;
      }
    }

    // 3. Phrase "design complete" check
    for (const regex of designCompleteRegexes) {
      const match = line.match(regex);
      if (match) {
        violations.push({
          rule: "no-design-complete",
          message: `Design document contains banned phrase "design complete": "${match[0]}"`,
          line: lineNum,
          lineContent: line,
        });
        break;
      }
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
    for (const regex of bareDecisionLabelRegexes) {
      const match = line.match(regex);
      if (match) {
        violations.push({
          rule: "no-bare-decision-labels",
          message: `Design document contains bare decision label: "${match[0]}"`,
          line: lineNum,
          lineContent: line,
        });
        bareLabelFound = true;
        break;
      }
    }

    if (!bareLabelFound) {
      // Check for standalone [DR]-\d+ in prose (not as a decision table definition row `| D-1 |` or `| R-1 |`)
      const isTableDefinitionCell = /^\s*\|\s*[DR]-\d+\s*\|/i.test(line);
      if (!isTableDefinitionCell) {
        const match = line.match(/\b[DR]-\d+\b/);
        if (match) {
          violations.push({
            rule: "no-bare-decision-labels",
            message: `Design document contains bare decision label: "${match[0]}"`,
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
