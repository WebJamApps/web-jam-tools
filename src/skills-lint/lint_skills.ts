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
 * Checks a skill markdown string for unresolvable [[...]] wiki-link syntax.
 * Skill bodies must be self-contained and state rules in prose without wiki-link syntax.
 *
 * Rules:
 * 1. Fails if the skill body (outside fenced code blocks and inline backtick code) contains `[[...]]`.
 * 2. Frontmatter (`--- ... ---`) and fenced/inline code blocks are ignored.
 */
export function lintSkillMarkdown(content: string, filePath: string = ""): LintSkillResult {
  const violations: SkillLintViolation[] = [];
  const lines = content.split(/\r?\n/);

  let inFrontmatter = false;
  let inCodeBlock = false;

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

Lints skill markdown files (skills/*/SKILL.md) to ensure they contain no unresolvable [[...]] wiki-links.
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
      console.error(`[lint:skills] FAILED: Skill bodies must not contain [[...]] wiki-links.`);
      return 1;
    }

    if (!flags.quiet) {
      console.log(
        `[lint:skills] Checked ${summary.scannedFiles} skill file(s): all clean (0 wiki-links found).`,
      );
    }
    return 0;
  } catch (err) {
    console.error(`[lint:skills] Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
