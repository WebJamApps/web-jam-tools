// src/skills-lint/lint_skills.ts
// Skill body linter checking for unresolvable wiki-links (web-jam-tools#744).

import { parseArgs } from "@std/cli/parse-args";
import * as path from "@std/path";

export interface SkillLintViolation {
  file: string;
  line: number;
  linkText: string;
  lineContent: string;
  message: string;
}

export interface LintSkillResult {
  filePath: string;
  valid: boolean;
  violations: SkillLintViolation[];
}

export interface LintSkillsSummary {
  valid: boolean;
  totalViolations: number;
  scannedFiles: number;
  results: LintSkillResult[];
}

/**
 * Patterns identifying surface-specific machinery in skill bodies (web-jam-tools#1091).
 * When any of these are present outside frontmatter and fenced code blocks, the skill
 * body must mention `agy` or `Antigravity` at least once.
 */
export const SURFACE_SPECIFIC_MACHINERY_PATTERNS: RegExp[] = [
  /\bClaude\s+Code\b/i,
  /(?<!\w)\.claude\b/i,
  /\bCodex\b/i,
  /\bmcp__\w*/,
  /\bmodel:\s*["'][^"']+["']/i,
  /\bAgent\s+tool\b/i,
  /\bAgent\s*\(/,
  /(?<![\w/])\/model\s+\S+/i,
  /\bHaiku\s+subagents?\b/i,
  /\bMUST\s+be\s+on\s+Haiku\b/i,
  /\b(?:must\s+)?run\s+on\s+Haiku\b/i,
  /\bdelegate:\s*Haiku\b/i,
  /\bdelegate\s+(?:to\s+)?Haiku\b/i,
  /\bNever\s+run\s+it\s+on\s+Opus\b/i,
  /\bFlash\s+High\s+multimodal\s+vision\b/i,
  /\binvoke_subagent\b/,
  /\bcall_mcp_tool\b/,
];

/**
 * Predicate pattern for required presence of agy or Antigravity (web-jam-tools#1091).
 * Keys strictly on `agy` or `Antigravity` and NOTHING else.
 * Does NOT accept `Flash` or `Gemini`.
 */
export const AGY_MENTION_PATTERN = /\b(?:agy|Antigravity)\b/i;

/**
 * Checks a skill markdown string for:
 * 1. Unresolvable [[...]] wiki-link syntax (web-jam-tools#744).
 * 2. Surface-specific machinery requirement: any skill body naming surface-specific machinery
 *    must mention 'agy' or 'Antigravity' at least once (web-jam-tools#1091).
 *
 * Rules:
 * 1. Fails if the skill body (outside fenced code blocks and inline backtick code) contains `[[...]]`.
 * 2. Fails if the skill body (outside frontmatter and fenced code blocks) names surface-specific
 *    machinery but does not contain at least one mention of `agy` or `Antigravity`.
 *    The predicate keys on `agy` and `Antigravity` and on nothing else (it does not accept `Flash` or `Gemini`).
 * 3. Frontmatter (`--- ... ---`) and fenced code blocks are ignored.
 */
export function lintSkillMarkdown(content: string, filePath: string = ""): LintSkillResult {
  const violations: SkillLintViolation[] = [];
  const lines = content.split(/\r?\n/);

  let inFrontmatter = false;
  let inCodeBlock = false;

  let hasAgyMention = false;
  let firstMachineryViolation: {
    line: number;
    text: string;
    lineContent: string;
  } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNumber = i + 1;
    const trimmed = rawLine.trim();

    // Check frontmatter boundaries at top of file
    if (i === 0 && trimmed === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (trimmed === "---") {
        inFrontmatter = false;
      }
      continue;
    }

    // Toggle fenced code blocks (``` or ~~~)
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      continue;
    }

    // Check for agy / Antigravity presence in body outside code blocks
    if (AGY_MENTION_PATTERN.test(rawLine)) {
      hasAgyMention = true;
    }

    // Check for first occurrence of surface-specific machinery
    if (!firstMachineryViolation) {
      for (const pattern of SURFACE_SPECIFIC_MACHINERY_PATTERNS) {
        const match = pattern.exec(rawLine);
        if (match) {
          firstMachineryViolation = {
            line: lineNumber,
            text: match[0],
            lineContent: rawLine,
          };
          break;
        }
      }
    }

    // Strip inline backticks from checking: `...`
    const lineWithoutInlineCode = rawLine.replace(
      /`[^`\r\n]*`/g,
      (match) => " ".repeat(match.length),
    );

    // Match [[...]]
    const wikiLinkRegex = /\[\[([^\]\r\n]+)\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = wikiLinkRegex.exec(lineWithoutInlineCode)) !== null) {
      const linkText = match[0];
      violations.push({
        file: filePath,
        line: lineNumber,
        linkText,
        lineContent: rawLine,
        message:
          `Unresolvable wiki-link '${linkText}' found at line ${lineNumber}. Skill bodies must be self-contained and state rules in prose without [[...]] links.`,
      });
    }
  }

  // Whole-file rule: any skill body naming surface-specific machinery must mention agy or Antigravity
  if (firstMachineryViolation && !hasAgyMention) {
    violations.push({
      file: filePath,
      line: firstMachineryViolation.line,
      linkText: firstMachineryViolation.text,
      lineContent: firstMachineryViolation.lineContent,
      message:
        `Skill body names surface-specific machinery ('${firstMachineryViolation.text}') at line ${firstMachineryViolation.line}, but does not mention 'agy' or 'Antigravity'. Any skill body naming surface-specific machinery must mention 'agy' or 'Antigravity' at least once.`,
    });
  }

  return {
    filePath,
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Lints a single skill markdown file at `filePath`.
 */
export async function lintSkillFile(filePath: string): Promise<LintSkillResult> {
  const resolvedPath = path.resolve(filePath);
  let content: string;
  try {
    content = await Deno.readTextFile(resolvedPath);
  } catch (err) {
    throw new Error(
      `Failed to read skill file at ${resolvedPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return lintSkillMarkdown(content, resolvedPath);
}

/**
 * Finds all `skills/<name>/SKILL.md` files under a base directory.
 */
export function findSkillFiles(baseDir: string = "."): string[] {
  const resolvedBase = path.resolve(baseDir);
  const skillsDir = path.join(resolvedBase, "skills");

  const results: string[] = [];

  try {
    const dirEntries = Deno.readDirSync(skillsDir);
    for (const entry of dirEntries) {
      if (entry.isDirectory) {
        const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
        try {
          const stat = Deno.statSync(skillMd);
          if (stat.isFile) {
            results.push(skillMd);
          }
        } catch {
          // No SKILL.md in this directory, skip
        }
      }
    }
  } catch {
    // skillsDir not found under baseDir; check if baseDir itself contains SKILL.md or is a skill dir
    try {
      const stat = Deno.statSync(resolvedBase);
      if (stat.isFile && resolvedBase.endsWith(".md")) {
        results.push(resolvedBase);
      }
    } catch {
      // Ignore
    }
  }

  return results.sort();
}

/**
 * Lints all skill files found or provided.
 */
export async function lintAllSkills(options?: {
  rootDir?: string;
  files?: string[];
}): Promise<LintSkillsSummary> {
  let targetFiles: string[] = options?.files || [];

  if (targetFiles.length === 0) {
    targetFiles = findSkillFiles(options?.rootDir || ".");
  }

  const results: LintSkillResult[] = [];
  let totalViolations = 0;

  for (const file of targetFiles) {
    const res = await lintSkillFile(file);
    results.push(res);
    totalViolations += res.violations.length;
  }

  return {
    valid: totalViolations === 0,
    totalViolations,
    scannedFiles: targetFiles.length,
    results,
  };
}

/**
 * CLI runner for `deno task lint:skills`.
 */
export async function runLintSkillsCli(args: string[]): Promise<number> {
  const flags = parseArgs(args, {
    boolean: ["help", "json", "quiet"],
    string: ["dir"],
    alias: {
      h: "help",
      d: "dir",
      q: "quiet",
    },
    default: {
      help: false,
      json: false,
      quiet: false,
    },
  });

  if (flags.help) {
    console.log(`Usage: deno task lint:skills [files...] [options]

Lints skill markdown files (skills/*/SKILL.md) to ensure:
1. They contain no unresolvable [[...]] wiki-links (web-jam-tools#744).
2. Any skill body naming surface-specific machinery mentions agy or Antigravity (web-jam-tools#1091).
Skill bodies must be self-contained and state rules in prose without wiki-link syntax.

Arguments:
  [files...]       Optional specific skill markdown file(s) to lint (defaults to all skills/*/SKILL.md)

Options:
  -d, --dir <path> Root directory containing skills/ (defaults to current working directory)
  --json           Output results as JSON
  -q, --quiet      Suppress progress output, print errors only
  -h, --help       Show this help message
`);
    return 0;
  }

  const positionalFiles = flags._.map(String);
  const rootDir = flags.dir || ".";

  try {
    const summary = await lintAllSkills({
      rootDir,
      files: positionalFiles.length > 0 ? positionalFiles : undefined,
    });

    if (flags.json) {
      console.log(JSON.stringify(summary, null, 2));
      return summary.valid ? 0 : 1;
    }

    if (!summary.valid) {
      console.error(
        `[lint:skills] Found ${summary.totalViolations} violation(s) across ${
          summary.results.filter((r) => !r.valid).length
        } file(s):\n`,
      );
      for (const res of summary.results) {
        if (!res.valid) {
          console.error(`  File: ${res.filePath}`);
          for (const v of res.violations) {
            console.error(`    Line ${v.line}: ${v.linkText}`);
            console.error(`      ${v.lineContent.trim()}`);
            console.error(`      ${v.message}\n`);
          }
        }
      }
      console.error(`[lint:skills] FAILED: Skill bodies must satisfy all skill-lint rules.`);
      return 1;
    }

    if (!flags.quiet) {
      console.log(
        `[lint:skills] Checked ${summary.scannedFiles} skill file(s): all clean (0 violations found).`,
      );
    }
    return 0;
  } catch (err) {
    console.error(`[lint:skills] Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
