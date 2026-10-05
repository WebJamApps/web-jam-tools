// src/session-load/report.ts
// Reads session load parts from disk, compares with limits in limits.json,
// and produces the session load report for Claude Code tab 1 (web-jam-tools#1234).

import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { ACTIVE_REPOS } from "../shared/repos.ts";

export interface PartLimit {
  lowMark?: number;
  overMark: number;
}

export interface SkillDescriptionLimit {
  lowMark?: number;
  overMark: number;
  maxCharacters?: number;
}

export interface BundledSkillsLimit {
  totalCount: number;
}

export interface SessionLoadLimits {
  memoryIndex: PartLimit;
  globalClaudeMd: PartLimit;
  mainRules: PartLimit;
  crossAiRules: PartLimit;
  jammusicRules: PartLimit;
  otherRepoRules: PartLimit;
  skillDescription: SkillDescriptionLimit;
  bundledSkills: BundledSkillsLimit;
}

export interface SessionLoadReportOptions {
  /** Home directory (defaults to $HOME or /home/joshua). */
  homeDir?: string;
  /** WebJamApps parent directory holding repo checkouts (defaults to $HOME/WebJamApps). */
  webJamAppsDir?: string;
  /** Path to Claude Code settings.json (defaults to $HOME/.claude/settings.json). */
  claudeSettingsPath?: string;
  /** Path to canonical limits.json (defaults to src/session-load/limits.json). */
  limitsPath?: string;
  /** Directory holding Claude Code skills (defaults to $HOME/.claude/skills). */
  claudeSkillsDir?: string;
  /** Directory holding agy skills (defaults to $HOME/.gemini/config/plugins/webjam-tasks/skills). */
  agySkillsDir?: string;
  /** Directory holding Codex skills (defaults to $HOME/.codex/skills). */
  codexSkillsDir?: string;
  /** Path to MEMORY.md (defaults to $HOME/.claude/projects/-home-joshua/memory/MEMORY.md). */
  memoryIndexPath?: string;
  /** Path to global CLAUDE.md (defaults to $HOME/.claude/CLAUDE.md). */
  globalClaudeMdPath?: string;
}

export interface ToolReportResult {
  isOver: boolean;
  items: string[];
}

export interface SessionLoadReportResult {
  text: string;
  isOver: boolean;
  tools: {
    claudeCode: ToolReportResult;
    agy: ToolReportResult;
    codex: ToolReportResult;
  };
}

/**
 * Loads canonical limits from limits.json.
 */
export async function loadLimits(customPath?: string): Promise<SessionLoadLimits> {
  const targetPath = customPath ??
    new URL("./limits.json", import.meta.url).pathname;
  const content = await Deno.readTextFile(targetPath);
  return JSON.parse(content) as SessionLoadLimits;
}

/** Formats a number with comma thousands separators. */
function formatNumber(num: number): string {
  return num.toLocaleString("en-US");
}

/** Safely gets file size in bytes; returns 0 if missing or unreadable. */
async function getFileSize(filePath: string): Promise<number> {
  try {
    const stat = await Deno.stat(filePath);
    return stat.isFile ? stat.size : 0;
  } catch {
    return 0;
  }
}

/** Extracts frontmatter description text from SKILL.md. */
function extractSkillDescription(text: string): string | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  try {
    const parsed = parseYaml(match[1]) as Record<string, unknown>;
    if (typeof parsed?.description === "string") {
      return parsed.description;
    }
  } catch {
    const fallbackMatch = match[1].match(
      /(?:^|\n)description:\s*(?:>|\|)?\s*\n?([^\n]+(?:\n\s+[^\n]+)*)/,
    );
    if (fallbackMatch) {
      return fallbackMatch[1].trim();
    }
  }
  return null;
}

/** Inspects a skills folder for count and descriptions exceeding limit. */
async function inspectSkillsDirectory(
  dirPath: string,
  maxDescriptionChars: number,
): Promise<{ installedCount: number; overCount: number }> {
  let installedCount = 0;
  let overCount = 0;

  try {
    for await (const entry of Deno.readDir(dirPath)) {
      if (entry.name.startsWith(".")) continue;
      const skillMdPath = join(dirPath, entry.name, "SKILL.md");
      try {
        const text = await Deno.readTextFile(skillMdPath);
        installedCount++;
        const desc = extractSkillDescription(text);
        if (desc && desc.length > maxDescriptionChars) {
          overCount++;
        }
      } catch {
        // Entry is not a skill or SKILL.md unreadable
      }
    }
  } catch {
    // Directory missing or unreadable
  }

  return { installedCount, overCount };
}

/** Counts bundled skills that are not set to name-only in Claude settings. */
async function inspectBundledSkills(
  claudeSettingsPath: string,
  totalBundledCount: number,
): Promise<number> {
  let namesOnlyCount = 0;
  try {
    const text = await Deno.readTextFile(claudeSettingsPath);
    const settings = JSON.parse(text) as Record<string, unknown>;
    if (
      settings &&
      typeof settings.skillOverrides === "object" &&
      settings.skillOverrides !== null
    ) {
      const overrides = settings.skillOverrides as Record<string, unknown>;
      for (const val of Object.values(overrides)) {
        if (val === "name-only") {
          namesOnlyCount++;
        }
      }
    }
  } catch {
    // Settings file missing or unparseable
  }

  return Math.max(0, totalBundledCount - namesOnlyCount);
}

/**
 * Computes the session load report across Claude Code, agy, and Codex.
 */
export async function computeSessionLoadReport(
  options: SessionLoadReportOptions = {},
): Promise<SessionLoadReportResult> {
  const limits = await loadLimits(options.limitsPath);

  const homeDir = options.homeDir || Deno.env.get("HOME") || "/home/joshua";
  const webJamAppsDir = options.webJamAppsDir || join(homeDir, "WebJamApps");

  // Determine paths
  const globalClaudeMdPath = options.globalClaudeMdPath ||
    join(homeDir, ".claude/CLAUDE.md");

  let memoryIndexPath = options.memoryIndexPath;
  if (!memoryIndexPath) {
    const primaryCandidate = join(
      homeDir,
      ".claude/projects/-home-joshua/memory/MEMORY.md",
    );
    try {
      const stat = await Deno.stat(primaryCandidate);
      if (stat.isFile) {
        memoryIndexPath = primaryCandidate;
      }
    } catch {
      // Look for any project memory directory under ~/.claude/projects/
      const projectsDir = join(homeDir, ".claude/projects");
      try {
        for await (const entry of Deno.readDir(projectsDir)) {
          if (!entry.isDirectory) continue;
          const candidate = join(projectsDir, entry.name, "memory/MEMORY.md");
          try {
            const stat = await Deno.stat(candidate);
            if (stat.isFile) {
              memoryIndexPath = candidate;
              break;
            }
          } catch {
            // keep searching
          }
        }
      } catch {
        // projects directory missing
      }
    }
    if (!memoryIndexPath) {
      memoryIndexPath = primaryCandidate;
    }
  }

  const mainRulesPath = join(webJamAppsDir, "web-jam-tools/AGENTS.md");
  const crossAiRulesPath = join(
    webJamAppsDir,
    "web-jam-tools/docs/cross-ai-rules.md",
  );
  const jammusicRulesPath = join(webJamAppsDir, "JaMmusic/AGENTS.md");

  const claudeSettingsPath = options.claudeSettingsPath ||
    join(homeDir, ".claude/settings.json");
  const claudeSkillsDir = options.claudeSkillsDir ||
    join(homeDir, ".claude/skills");
  const agySkillsDir = options.agySkillsDir ||
    join(homeDir, ".gemini/config/plugins/webjam-tasks/skills");
  const codexSkillsDir = options.codexSkillsDir ||
    join(homeDir, ".codex/skills");

  // Read sizes
  const globalClaudeMdSize = await getFileSize(globalClaudeMdPath);
  const memoryIndexSize = await getFileSize(memoryIndexPath);

  let mainRulesSize = await getFileSize(mainRulesPath);
  if (mainRulesSize === 0) {
    const homeAgentsPath = join(homeDir, ".agents/AGENTS.md");
    mainRulesSize = await getFileSize(homeAgentsPath);
  }

  const crossAiRulesSize = await getFileSize(crossAiRulesPath);
  const jammusicRulesSize = await getFileSize(jammusicRulesPath);

  // Other repos' rules files
  const otherRepoSizes: Record<string, number> = {};
  for (const repo of ACTIVE_REPOS) {
    if (repo === "web-jam-tools" || repo === "JaMmusic") continue;
    const repoRulesPath = join(webJamAppsDir, repo, "AGENTS.md");
    otherRepoSizes[repo] = await getFileSize(repoRulesPath);
  }

  // Skills inspection
  const maxDescChars = limits.skillDescription.overMark ??
    limits.skillDescription.maxCharacters;

  const claudeSkills = await inspectSkillsDirectory(
    claudeSkillsDir,
    maxDescChars,
  );
  const agySkills = await inspectSkillsDirectory(agySkillsDir, maxDescChars);
  const codexSkills = await inspectSkillsDirectory(codexSkillsDir, maxDescChars);

  const bundledSkillsOver = await inspectBundledSkills(
    claudeSettingsPath,
    limits.bundledSkills.totalCount,
  );

  // Build items for Claude Code
  const claudeItems: string[] = [];
  if (globalClaudeMdSize > limits.globalClaudeMd.overMark) {
    const excess = globalClaudeMdSize - limits.globalClaudeMd.overMark;
    claudeItems.push(`global CLAUDE.md +${formatNumber(excess)}`);
  }
  if (memoryIndexSize > limits.memoryIndex.overMark) {
    const excess = memoryIndexSize - limits.memoryIndex.overMark;
    claudeItems.push(`memory index +${formatNumber(excess)}`);
  }
  if (mainRulesSize > limits.mainRules.overMark) {
    const excess = mainRulesSize - limits.mainRules.overMark;
    claudeItems.push(`main rules +${formatNumber(excess)}`);
  }
  if (crossAiRulesSize > limits.crossAiRules.overMark) {
    const excess = crossAiRulesSize - limits.crossAiRules.overMark;
    claudeItems.push(`cross-AI rules +${formatNumber(excess)}`);
  }
  if (jammusicRulesSize > limits.jammusicRules.overMark) {
    const excess = jammusicRulesSize - limits.jammusicRules.overMark;
    claudeItems.push(`JaMmusic rules +${formatNumber(excess)}`);
  }
  for (const repo of ACTIVE_REPOS) {
    if (repo === "web-jam-tools" || repo === "JaMmusic") continue;
    const size = otherRepoSizes[repo] ?? 0;
    if (size > limits.otherRepoRules.overMark) {
      const excess = size - limits.otherRepoRules.overMark;
      claudeItems.push(`${repo} rules +${formatNumber(excess)}`);
    }
  }
  if (claudeSkills.overCount > 0) {
    claudeItems.push(`${claudeSkills.overCount} skill descriptions`);
  }
  if (bundledSkillsOver > 0) {
    claudeItems.push(`${bundledSkillsOver} bundled skills`);
  }

  // Build items for agy
  const agyItems: string[] = [];
  if (mainRulesSize > limits.mainRules.overMark) {
    const excess = mainRulesSize - limits.mainRules.overMark;
    agyItems.push(`main rules +${formatNumber(excess)}`);
  }
  if (crossAiRulesSize > limits.crossAiRules.overMark) {
    const excess = crossAiRulesSize - limits.crossAiRules.overMark;
    agyItems.push(`cross-AI rules +${formatNumber(excess)}`);
  }
  if (jammusicRulesSize > limits.jammusicRules.overMark) {
    const excess = jammusicRulesSize - limits.jammusicRules.overMark;
    agyItems.push(`JaMmusic rules +${formatNumber(excess)}`);
  }
  for (const repo of ACTIVE_REPOS) {
    if (repo === "web-jam-tools" || repo === "JaMmusic") continue;
    const size = otherRepoSizes[repo] ?? 0;
    if (size > limits.otherRepoRules.overMark) {
      const excess = size - limits.otherRepoRules.overMark;
      agyItems.push(`${repo} rules +${formatNumber(excess)}`);
    }
  }
  if (agySkills.overCount > 0) {
    agyItems.push(`${agySkills.overCount} skill descriptions`);
  }

  // Build items for Codex
  const codexItems: string[] = [];
  if (mainRulesSize > limits.mainRules.overMark) {
    const excess = mainRulesSize - limits.mainRules.overMark;
    codexItems.push(`main rules +${formatNumber(excess)}`);
  }
  if (crossAiRulesSize > limits.crossAiRules.overMark) {
    const excess = crossAiRulesSize - limits.crossAiRules.overMark;
    codexItems.push(`cross-AI rules +${formatNumber(excess)}`);
  }
  if (jammusicRulesSize > limits.jammusicRules.overMark) {
    const excess = jammusicRulesSize - limits.jammusicRules.overMark;
    codexItems.push(`JaMmusic rules +${formatNumber(excess)}`);
  }
  for (const repo of ACTIVE_REPOS) {
    if (repo === "web-jam-tools" || repo === "JaMmusic") continue;
    const size = otherRepoSizes[repo] ?? 0;
    if (size > limits.otherRepoRules.overMark) {
      const excess = size - limits.otherRepoRules.overMark;
      codexItems.push(`${repo} rules +${formatNumber(excess)}`);
    }
  }
  if (codexSkills.installedCount === 0) {
    if (codexItems.length > 0) {
      codexItems.push("no skills installed");
    }
  } else if (codexSkills.overCount > 0) {
    codexItems.push(`${codexSkills.overCount} skill descriptions`);
  }

  const claudeOver = claudeItems.length > 0;
  const agyOver = agyItems.length > 0;
  const codexOver = codexItems.length > 0;

  const anyOver = claudeOver || agyOver || codexOver;

  let text: string;
  if (!anyOver) {
    text = "Session load: Claude Code ok · agy ok · Codex ok";
  } else {
    const formatToolLine = (name: string, isOver: boolean, items: string[]): string => {
      const paddedName = name.padEnd(11);
      if (isOver) {
        return `${paddedName}  OVER  ${items.join(" · ")}`;
      }
      return `${paddedName}  ok`;
    };

    text = [
      "Session load",
      formatToolLine("Claude Code", claudeOver, claudeItems),
      formatToolLine("agy", agyOver, agyItems),
      formatToolLine("Codex", codexOver, codexItems),
      "Run /memory-cleanup to cut.",
    ].join("\n");
  }

  return {
    text,
    isOver: anyOver,
    tools: {
      claudeCode: { isOver: claudeOver, items: claudeItems },
      agy: { isOver: agyOver, items: agyItems },
      codex: { isOver: codexOver, items: codexItems },
    },
  };
}

/**
 * Generates the session load report string.
 */
export async function generateSessionLoadReport(
  options: SessionLoadReportOptions = {},
): Promise<string> {
  const result = await computeSessionLoadReport(options);
  return result.text;
}
