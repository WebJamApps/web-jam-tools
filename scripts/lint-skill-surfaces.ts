// scripts/lint-skill-surfaces.ts
// Linter checking that shared skills do not depend unconditionally on Claude-only tools
// (mcp__* or Agent/Task tool) outside explicitly surface-specific notes (web-jam-tools#1145).

import { parseArgs } from "@std/cli/parse-args";
import * as path from "@std/path";

export interface SurfaceLintViolation {
  file: string;
  line: number;
  toolName: string;
  lineContent: string;
  message: string;
}

export interface SurfaceLintResult {
  filePath: string;
  valid: boolean;
  exempt: boolean;
  violations: SurfaceLintViolation[];
}

export interface SurfaceLintSummary {
  valid: boolean;
  scannedFiles: number;
  exemptFiles: number;
  totalViolations: number;
  results: SurfaceLintResult[];
}

/**
 * Surface scoping indicators. A tool reference is valid if the line or its immediate
 * enclosing block carries an explicit surface indicator.
 */
export const SURFACE_INDICATORS: RegExp[] = [
  /\bclaude(?:\s+code)?\b/i,
  /\bclaude-only\b/i,
  /\(laptop only\)/i,
  /\blaptop\s*—/i,
  /\bphone\s*—/i,
  /\bon\s+haiku\b/i,
  /\bunder\s+haiku\b/i,
];

export const MCP_REGEX = /\bmcp__[a-zA-Z0-9_*]+/i;
export const AGENT_TOOL_REGEX =
  /\bAgent\s*\(|(?:the\s+)?`?Agent`?[\s-]tool\b|(?:the\s+)?`?Task`?[\s-]tool\b|\b`?Agent`?[\s-]tool-dispatched\b|\b`?Agent`?\s*(?:\/|\s+or\s+)\s*`?invoke_subagent`?\s+tool\b/i;

/**
 * Tests whether a given file path is exempt from the surface lint check.
 * skills/handle-gmails/SKILL.md is exempt: it runs only on Haiku via the Gmail MCP server,
 * and Gmail is kept off Codex (web-jam-tools#1145).
 */
export function isSkillExempt(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    normalized.endsWith("skills/handle-gmails/SKILL.md") ||
    normalized.endsWith("/handle-gmails/SKILL.md") ||
    normalized === "skills/handle-gmails/SKILL.md" ||
    normalized.includes("handle-gmails")
  );
}

/**
 * Checks whether a line or block context indicates surface scoping.
 */
export function isSurfaceScoped(
  line: string,
  context?: { inSurfaceBlock?: boolean },
): boolean {
  if (context?.inSurfaceBlock) {
    return true;
  }
  return SURFACE_INDICATORS.some((re) => re.test(line));
}

/**
 * Lints markdown content for un-scoped Claude-only tool references.
 */
export function lintSkillContent(
  content: string,
  filePath: string = "",
): SurfaceLintResult {
  if (isSkillExempt(filePath)) {
    return {
      filePath,
      valid: true,
      exempt: true,
      violations: [],
    };
  }

  const violations: SurfaceLintViolation[] = [];
  const lines = content.split(/\r?\n/);

  let inSurfaceBlock = false;
  let blockIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNumber = i + 1;
    const trimmed = rawLine.trim();

    // Check list item context
    const indentMatch = rawLine.match(/^(\s*)[-*+]\s+/);
    if (indentMatch) {
      const currentIndent = indentMatch[1].length;
      if (SURFACE_INDICATORS.some((re) => re.test(rawLine))) {
        inSurfaceBlock = true;
        blockIndent = currentIndent;
      } else if (inSurfaceBlock && currentIndent <= blockIndent) {
        inSurfaceBlock = false;
      }
    } else if (inSurfaceBlock && trimmed === "") {
      inSurfaceBlock = false;
    } else if (trimmed.startsWith("#")) {
      inSurfaceBlock = SURFACE_INDICATORS.some((re) => re.test(rawLine));
    }

    const mcpMatch = rawLine.match(MCP_REGEX);
    const agentMatch = rawLine.match(AGENT_TOOL_REGEX);
    const toolMatch = mcpMatch ? mcpMatch[0] : (agentMatch ? agentMatch[0] : null);

    if (toolMatch) {
      const scoped = isSurfaceScoped(rawLine, { inSurfaceBlock });
      if (!scoped) {
        violations.push({
          file: filePath,
          line: lineNumber,
          toolName: toolMatch,
          lineContent: rawLine,
          message:
            `Claude-only tool reference '${toolMatch}' found at line ${lineNumber} outside an explicitly surface-specific note. Use surface-neutral gh CLI or deno task commands, or scope the reference (e.g. 'on Claude Code, ...').`,
        });
      }
    }
  }

  return {
    filePath,
    valid: violations.length === 0,
    exempt: false,
    violations,
  };
}

/**
 * Lints a single skill file on disk.
 */
export async function lintSkillFile(
  filePath: string,
): Promise<SurfaceLintResult> {
  const resolvedPath = path.resolve(filePath);
  if (isSkillExempt(resolvedPath)) {
    return {
      filePath: resolvedPath,
      valid: true,
      exempt: true,
      violations: [],
    };
  }

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

  return lintSkillContent(content, resolvedPath);
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
          // No SKILL.md in this directory
        }
      }
    }
  } catch {
    // skillsDir does not exist
  }

  return results.sort();
}

/**
 * Lints multiple skill files and aggregates results.
 */
export async function runLintSkillSurfaces(
  filePaths?: string[],
  baseDir: string = ".",
): Promise<SurfaceLintSummary> {
  const targets = (filePaths && filePaths.length > 0) ? filePaths : findSkillFiles(baseDir);

  const results: SurfaceLintResult[] = [];
  let totalViolations = 0;
  let exemptFiles = 0;

  for (const target of targets) {
    const result = await lintSkillFile(target);
    results.push(result);
    if (result.exempt) {
      exemptFiles++;
    } else {
      totalViolations += result.violations.length;
    }
  }

  return {
    valid: totalViolations === 0,
    scannedFiles: targets.length,
    exemptFiles,
    totalViolations,
    results,
  };
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["base-dir"],
    boolean: ["help"],
    alias: { h: "help" },
  });

  if (args.help) {
    console.log(`Usage: deno run scripts/lint-skill-surfaces.ts [files...]
Checks that SKILL.md bodies do not depend unconditionally on Claude-only tools (mcp__* or Agent/Task tool) outside surface-scoped notes.

Options:
  --base-dir <path>  Base directory containing skills/ (default: current directory)
  -h, --help         Show this help message
`);
    Deno.exit(0);
  }

  const explicitFiles = args._.map(String);
  const summary = await runLintSkillSurfaces(
    explicitFiles.length > 0 ? explicitFiles : undefined,
    args["base-dir"] || ".",
  );

  for (const res of summary.results) {
    if (res.exempt) {
      console.log(`[EXEMPT] ${res.filePath}`);
    } else if (res.valid) {
      console.log(`[PASS] ${res.filePath}`);
    } else {
      console.error(`[FAIL] ${res.filePath} (${res.violations.length} violations)`);
      for (const v of res.violations) {
        console.error(`  Line ${v.line}: ${v.message}`);
        console.error(`    > ${v.lineContent.trim()}`);
      }
    }
  }

  if (!summary.valid) {
    console.error(
      `\nSurface lint failed: ${summary.totalViolations} violation(s) across ${summary.scannedFiles} file(s).`,
    );
    Deno.exit(1);
  } else {
    console.log(
      `\nSurface lint passed: ${summary.scannedFiles} file(s) checked (${summary.exemptFiles} exempt).`,
    );
    Deno.exit(0);
  }
}
