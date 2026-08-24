// src/design-issue/lint_runbook.ts
// Linter for manual verification runbooks checking against required format (web-jam-tools#743).

import { parseArgs } from "@std/cli/parse-args";
import * as path from "@std/path";
import { expandHome } from "./gate1.ts";

export interface LintRunbookViolation {
  rule: string;
  message: string;
  line?: number;
  lineContent?: string;
}

export interface LintRunbookResult {
  runbookPath: string;
  valid: boolean;
  violations: LintRunbookViolation[];
}

export interface LintRunbookOptions {
  runbookPath: string;
  json?: boolean;
}

interface StepBlock {
  stepNum: number;
  headingLine: number;
  headingText: string;
  startLineIndex: number;
  endLineIndex: number;
}

interface CodeBlockInfo {
  startLine: number;
  endLine: number;
  language: string;
  lines: Array<{ lineNum: number; content: string }>;
}

const HTML_TAGS = new Set([
  "br",
  "hr",
  "p",
  "div",
  "span",
  "code",
  "pre",
  "a",
  "img",
  "b",
  "i",
  "em",
  "strong",
  "table",
  "tr",
  "td",
  "th",
  "tbody",
  "thead",
  "ul",
  "ol",
  "li",
]);

/**
 * Scans a single line for command/path placeholders.
 */
function findLinePlaceholders(line: string): string[] {
  const found: string[] = [];

  // 1. Angle-bracket placeholders: <placeholder>, <google-app-password>, <token>, <branch>, etc.
  // Must avoid matching shell redirections (e.g. `< /dev/null`, `<<<`) or HTML tags.
  const angleRegex = /(?<!<)<([a-zA-Z0-9_.:\/\s-]+)>(?!>)/g;
  let match: RegExpExecArray | null;
  while ((match = angleRegex.exec(line)) !== null) {
    const inner = match[1].trim();
    const lowerInner = inner.toLowerCase();
    if (HTML_TAGS.has(lowerInner) || lowerInner.startsWith("/") || lowerInner.startsWith("!--")) {
      continue;
    }
    if (match[0].startsWith("< ") || match[0].startsWith("</")) {
      continue;
    }
    found.push(match[0]);
  }

  // 2. Bracket and uppercase placeholder patterns
  const explicitPatterns = [
    /\bYOUR_[A-Z0-9_]+\b/g,
    /\bINSERT_[A-Z0-9_]+\b/g,
    /\bTODO\b/g,
    /\bFIXME\b/g,
    /\bREPLACE_ME\b/g,
    /\bTBD\b/g,
    /\bXXX\b/g,
    /\[(?:placeholder|YOUR_[A-Z0-9_]+|INSERT_[A-Z0-9_]+|TODO|FIXME|REPLACE_ME)\]/gi,
  ];

  for (const pattern of explicitPatterns) {
    let patMatch: RegExpExecArray | null;
    while ((patMatch = pattern.exec(line)) !== null) {
      found.push(patMatch[0]);
    }
  }

  return found;
}

/**
 * Checks a runbook markdown string against the required format rules:
 * 1. Fails if the runbook lacks an H1 title or if the title carries a personal name.
 * 2. Fails if the runbook lacks sequentially numbered `## STEP N` headings starting at 1.
 * 3. Fails if a step contains placeholders instead of literal commands.
 * 4. Fails if a step is missing what it proves or what a correct result looks like.
 * 5. Fails if a step carries more than one action (multiple command blocks, sub-steps, or multiple surfaces).
 */
export function lintRunbook(content: string, runbookPath: string = ""): LintRunbookResult {
  const violations: LintRunbookViolation[] = [];
  const lines = content.split(/\r?\n/);

  let inCodeBlock = false;
  let h1Found = false;
  const stepHeadings: Array<{ stepNum: number; lineNum: number; text: string; lineIndex: number }> =
    [];

  const h1Regex = /^\s*#\s+(.+)$/;
  const personalNameRegex = /\b(?:josh|joshua|maria|tim|henrickson)\b/i;
  const stepHeadingRegex = /^\s*##\s+(?:STEP|Step)\s+(\d+)(?:\s*:\s*(.*))?\s*$/;
  const genericStepHeadingRegex = /^\s*#{1,6}\s+(?:STEP|Step)\b/i;

  // Pass 1: Parse top-level structure (H1 title, step headings, code block boundaries)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      continue;
    }

    // Check H1 Title
    if (!h1Found && h1Regex.test(line)) {
      h1Found = true;
      const titleMatch = line.match(h1Regex);
      const titleText = titleMatch ? titleMatch[1] : "";
      const personalMatch = titleText.match(personalNameRegex);
      if (personalMatch) {
        violations.push({
          rule: "no-personal-name-in-title",
          message: `Runbook title contains a personal name: "${personalMatch[0]}"`,
          line: lineNum,
          lineContent: line,
        });
      }
    }

    // Check Step headings
    if (stepHeadingRegex.test(line)) {
      const match = line.match(stepHeadingRegex);
      const stepNum = match ? parseInt(match[1], 10) : 0;
      stepHeadings.push({
        stepNum,
        lineNum,
        text: line,
        lineIndex: i,
      });
    } else if (genericStepHeadingRegex.test(line)) {
      violations.push({
        rule: "malformed-step-heading",
        message: `Malformed step heading: "${line.trim()}" (expected '## STEP N: <title>')`,
        line: lineNum,
        lineContent: line,
      });
    }
  }

  if (!h1Found) {
    violations.push({
      rule: "require-h1-title",
      message: "Runbook is missing an H1 title (expected '# <Title>')",
    });
  }

  if (stepHeadings.length === 0) {
    violations.push({
      rule: "require-step-headings",
      message:
        "Runbook contains no step headings (expected sequentially numbered '## STEP N' headings starting at 1)",
    });
    return {
      runbookPath,
      valid: violations.length === 0,
      violations,
    };
  }

  // Check sequential numbering
  if (stepHeadings[0].stepNum !== 1) {
    violations.push({
      rule: "sequential-step-numbering",
      message: `Steps must start at STEP 1 (found STEP ${stepHeadings[0].stepNum})`,
      line: stepHeadings[0].lineNum,
      lineContent: stepHeadings[0].text,
    });
  }

  for (let i = 0; i < stepHeadings.length; i++) {
    const expected = i + 1;
    const current = stepHeadings[i];
    if (current.stepNum !== expected && (i > 0 || current.stepNum !== 1)) {
      violations.push({
        rule: "sequential-step-numbering",
        message: `Expected STEP ${expected} but found STEP ${current.stepNum}`,
        line: current.lineNum,
        lineContent: current.text,
      });
    }
  }

  // Construct step blocks
  const stepBlocks: StepBlock[] = [];
  for (let i = 0; i < stepHeadings.length; i++) {
    const current = stepHeadings[i];
    const nextIndex = i + 1 < stepHeadings.length
      ? stepHeadings[i + 1].lineIndex - 1
      : lines.length - 1;
    stepBlocks.push({
      stepNum: current.stepNum,
      headingLine: current.lineNum,
      headingText: current.text,
      startLineIndex: current.lineIndex,
      endLineIndex: nextIndex,
    });
  }

  const proofRegex =
    /^\s*(?:\*{1,2}|_{1,2}|#{2,6}\s+)?(?:what\s+(?:this|it)\s+(?:proves|tests|verifies)|proves)(?:\*{1,2}|_{1,2})?\s*[:=-]?/i;
  const expectedResultRegex =
    /^\s*(?:\*{1,2}|_{1,2}|#{2,6}\s+)?(?:expected\s+(?:result|output|behavior)|what\s+a\s+correct\s+result\s+looks\s+like)(?:\*{1,2}|_{1,2})?\s*[:=-]?/i;
  const surfaceRegex =
    /^\s*(?:\*{1,2}|_{1,2})?Surface(?:\*{1,2}|_{1,2})?\s*[:=-]\s*(?:\*{1,2}|_{1,2})?\s*(.+)$/i;

  // Pass 2: Validate each step block
  for (const block of stepBlocks) {
    let hasProof = false;
    let hasExpectedResult = false;
    const codeBlocks: CodeBlockInfo[] = [];
    const subActions: Array<{ lineNum: number; content: string; num: number }> = [];

    let currentCodeBlock: CodeBlockInfo | null = null;

    for (let idx = block.startLineIndex + 1; idx <= block.endLineIndex; idx++) {
      const line = lines[idx];
      const lineNum = idx + 1;

      // Handle code block boundaries
      if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) {
        if (!currentCodeBlock) {
          const langMatch = line.match(/^\s*(?:```|~~~)(.*)$/);
          currentCodeBlock = {
            startLine: lineNum,
            endLine: lineNum,
            language: langMatch ? langMatch[1].trim() : "",
            lines: [],
          };
        } else {
          currentCodeBlock.endLine = lineNum;
          codeBlocks.push(currentCodeBlock);
          currentCodeBlock = null;
        }
        continue;
      }

      if (currentCodeBlock) {
        currentCodeBlock.lines.push({ lineNum, content: line });
        // Scan for placeholders inside code block
        const placeholders = findLinePlaceholders(line);
        for (const ph of placeholders) {
          violations.push({
            rule: "no-command-placeholders",
            message: `STEP ${block.stepNum} contains a placeholder in command block: "${ph}"`,
            line: lineNum,
            lineContent: line,
          });
        }
        continue;
      }

      // Check Proof statement
      if (
        proofRegex.test(line) || /\bwhat\s+(?:this|it)\s+(?:proves|tests|verifies)\b/i.test(line)
      ) {
        hasProof = true;
      }

      // Check Expected Result statement
      if (
        expectedResultRegex.test(line) ||
        /\bexpected\s+(?:result|output|behavior)\b/i.test(line) ||
        /\bwhat\s+a\s+correct\s+result\s+looks\s+like\b/i.test(line)
      ) {
        hasExpectedResult = true;
      }

      // Check for multiple surfaces
      const surfaceMatch = line.match(surfaceRegex);
      if (surfaceMatch) {
        const surfaceVal = surfaceMatch[1].replace(/[\*_]/g, "").trim();
        if (/(?:\/|\band\b|,)/i.test(surfaceVal)) {
          violations.push({
            rule: "single-surface-per-step",
            message:
              `STEP ${block.stepNum} specifies multiple surfaces: "${surfaceVal}" (expected one surface per step)`,
            line: lineNum,
            lineContent: line,
          });
        }
      }

      // Check for numbered sub-actions outside code blocks (e.g. 1. ... 2. ...)
      const subActionMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);
      if (subActionMatch) {
        subActions.push({
          lineNum,
          content: line,
          num: parseInt(subActionMatch[1], 10),
        });
      }

      // Also check for command line placeholders in non-fenced command lines (e.g. **Command:** `...`)
      if (/^\s*(?:\*{1,2}|_{1,2})?Command(?:\*{1,2}|_{1,2})?\s*:/i.test(line)) {
        const inlinePlaceholders = findLinePlaceholders(line);
        for (const ph of inlinePlaceholders) {
          violations.push({
            rule: "no-command-placeholders",
            message: `STEP ${block.stepNum} contains a placeholder in command: "${ph}"`,
            line: lineNum,
            lineContent: line,
          });
        }
      }
    }

    // Verify proof statement existence
    if (!hasProof) {
      violations.push({
        rule: "require-step-proof",
        message:
          `STEP ${block.stepNum} is missing a statement of what the step proves (e.g. '**What this proves:**')`,
        line: block.headingLine,
        lineContent: block.headingText,
      });
    }

    // Verify expected result existence
    if (!hasExpectedResult) {
      violations.push({
        rule: "require-expected-result",
        message:
          `STEP ${block.stepNum} is missing a statement of what a correct result looks like (e.g. '**Expected result:**')`,
        line: block.headingLine,
        lineContent: block.headingText,
      });
    }

    // Verify single action per step (multiple code blocks)
    if (codeBlocks.length > 1) {
      violations.push({
        rule: "single-action-per-step",
        message:
          `STEP ${block.stepNum} carries multiple distinct command blocks (expected exactly one action per step)`,
        line: codeBlocks[1].startLine,
      });
    }

    // Verify single action per step (numbered sub-actions)
    if (subActions.length >= 2) {
      violations.push({
        rule: "single-action-per-step",
        message:
          `STEP ${block.stepNum} carries multiple numbered sub-actions (expected a single action per step, not sub-steps)`,
        line: subActions[1].lineNum,
        lineContent: subActions[1].content,
      });
    }
  }

  return {
    runbookPath,
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Reads and lints a runbook file from disk.
 */
export async function lintRunbookFile(filePath: string): Promise<LintRunbookResult> {
  if (!filePath || filePath.trim() === "") {
    throw new Error("Runbook path is required");
  }

  const absPath = path.resolve(expandHome(filePath.trim()));

  let content: string;
  try {
    content = await Deno.readTextFile(absPath);
  } catch (err) {
    throw new Error(
      `Runbook not found or cannot be read at ${absPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (content.trim() === "") {
    throw new Error(`Runbook at ${absPath} is empty`);
  }

  return lintRunbook(content, absPath);
}

/**
 * CLI runner for deno task design:lint-runbook <runbook.md>.
 */
export async function runLintRunbookCli(args: string[]): Promise<number> {
  const flags = parseArgs(args, {
    boolean: ["help", "json"],
    string: ["runbook", "doc"],
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
    console.log(`Usage: deno task design:lint-runbook <runbook.md> [options]

Checks a manual verification runbook against required format rules:
  - Fails if the runbook lacks an H1 title or if the title carries a personal name.
  - Fails if the runbook lacks sequentially numbered '## STEP N' headings starting at 1.
  - Fails if a step contains placeholders instead of literal commands.
  - Fails if a step is missing what it proves or what a correct result looks like.
  - Fails if a step carries more than one action (multiple command blocks, sub-steps, or multiple surfaces).

Arguments:
  <runbook.md>      Path to runbook markdown file

Options:
  --runbook <path>  Explicit runbook file path
  --doc <path>      Alias for runbook file path
  -j, --json        Output result as JSON
  -h, --help        Show this help message
`);
    return 0;
  }

  const runbookPath = flags.runbook || flags.doc || (flags._.length > 0 ? String(flags._[0]) : "");
  if (!runbookPath) {
    console.error("Error: Missing required runbook path.");
    console.error("Usage: deno task design:lint-runbook <runbook.md>");
    return 1;
  }

  try {
    const result = await lintRunbookFile(runbookPath);

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.valid) {
      console.log(
        `[design:lint-runbook] PASS: ${result.runbookPath} satisfies all runbook format rules.`,
      );
    } else {
      console.error(
        `[design:lint-runbook] FAIL: ${result.runbookPath} has ${result.violations.length} violation(s):`,
      );
      for (const v of result.violations) {
        const location = v.line ? ` (line ${v.line})` : "";
        console.error(`  - [${v.rule}]${location} ${v.message}`);
      }
    }

    return result.valid ? 0 : 1;
  } catch (err) {
    console.error(
      `[design:lint-runbook] Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}
