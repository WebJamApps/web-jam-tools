/**
 * check_permission_wildcard_drift.ts — web-jam-tools#784
 *
 * SessionStart detector for over-broad permission allow rules in settings.local.json
 * files where a wildcard `*` sits anywhere other than the end of the rule,
 * causing option positions to be spanned and unintended commands auto-approved.
 *
 * Scans the four standard settings.local.json locations:
 * 1. $HOME/.claude/settings.local.json
 * 2. $HOME/WebJamApps/JaMmusic/.claude/settings.local.json
 * 3. $HOME/WebJamApps/WebJamSocketCluster/.claude/settings.local.json
 * 4. $HOME/WebJamApps/web-jam-back/.claude/settings.local.json
 *
 * Read-only: never writes to files, never blocks session (exits 0).
 * Emits SessionStart JSON {"systemMessage": "..."} when offenders exist.
 */

import * as path from "jsr:@std/path@^1.0.0";

export interface WildcardDriftOptions {
  homeDir?: string;
  targetFiles?: string[];
}

export interface FileWildcardDrift {
  filePath: string;
  offenders: string[];
}

export interface WildcardDriftResult {
  hasDrift: boolean;
  files: FileWildcardDrift[];
}

export function tryExistsSync(p: string): boolean {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * An entry in `permissions.allow` is an offender when it contains a `*`
 * sitting anywhere other than the trailing wildcard position.
 * Leaves trailing wildcards like `Bash(git *)`, `Bash(curl *)`, and `Read(//dev/pts/**)` alone,
 * while catching internal wildcards even when a trailing wildcard is also present
 * (e.g. `Bash(find . -name "*.env*" *)`).
 */
export function isNonTrailingWildcardRule(rule: string): boolean {
  if (typeof rule !== "string") {
    return false;
  }
  const trimmed = rule.trim();
  if (!trimmed.includes("*")) {
    return false;
  }
  // Strip optional trailing ')' and any trailing '*' characters
  const withoutParen = trimmed.endsWith(")") ? trimmed.slice(0, -1).trimEnd() : trimmed;
  const withoutTrailingStars = withoutParen.replace(/\*+$/, "");
  return withoutTrailingStars.includes("*");
}

export function getDefaultTargetFiles(homeDir?: string): string[] {
  const home = homeDir ||
    Deno.env.get("CLAUDE_HOME") ||
    Deno.env.get("HOME") ||
    "";
  return [
    path.join(home, ".claude/settings.local.json"),
    path.join(home, "WebJamApps/JaMmusic/.claude/settings.local.json"),
    path.join(home, "WebJamApps/WebJamSocketCluster/.claude/settings.local.json"),
    path.join(home, "WebJamApps/web-jam-back/.claude/settings.local.json"),
  ];
}

export function checkFileForWildcardDrift(filePath: string): string[] {
  if (!tryExistsSync(filePath)) {
    return [];
  }

  try {
    const raw = Deno.readTextFileSync(filePath);
    if (!raw.trim()) return [];
    const data = JSON.parse(raw);
    const allowRules = data?.permissions?.allow;
    if (!Array.isArray(allowRules)) return [];

    const offenders: string[] = [];
    for (const rule of allowRules) {
      if (typeof rule === "string" && isNonTrailingWildcardRule(rule)) {
        offenders.push(rule.trim());
      }
    }
    return offenders;
  } catch {
    return [];
  }
}

export function detectWildcardDrift(
  options: WildcardDriftOptions = {},
): WildcardDriftResult {
  const targetFiles = options.targetFiles && options.targetFiles.length > 0
    ? options.targetFiles
    : getDefaultTargetFiles(options.homeDir);

  const files: FileWildcardDrift[] = [];

  for (const filePath of targetFiles) {
    const offenders = checkFileForWildcardDrift(filePath);
    if (offenders.length > 0) {
      files.push({ filePath, offenders });
    }
  }

  return {
    hasDrift: files.length > 0,
    files,
  };
}

export function formatWildcardDriftMessage(result: WildcardDriftResult): string {
  if (!result.hasDrift || result.files.length === 0) {
    return "";
  }

  const lines: string[] = [
    "WARNING: Over-broad permission allow rules with non-trailing wildcards detected:",
  ];

  for (const file of result.files) {
    lines.push(`  • ${file.filePath}:`);
    for (const rule of file.offenders) {
      lines.push(`    - ${rule}`);
    }
  }

  lines.push(
    "Run 'scripts/prune-local-permission-allows.sh --apply' in ~/WebJamApps/web-jam-tools to prune them.",
  );

  return lines.join("\n");
}

if (import.meta.main) {
  const result = detectWildcardDrift();
  const message = formatWildcardDriftMessage(result);
  if (message) {
    console.log(JSON.stringify({ systemMessage: message }));
  }
}
