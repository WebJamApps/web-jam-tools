// src/prune-local-permission-allows/prune.ts — web-jam-tools#341

export const R5_BLANKET_WILDCARDS = [
  "Bash(gh pr *)",
  "Bash(gh issue *)",
  "Bash(gh api *)",
  "Bash(gh repo *)",
  "Bash(gh label *)",
  "Bash(gh project *)",
];

export const R11_MCP_ALLOWS = [
  "mcp__claude_ai_GitHub_MCP__add_issue_comment",
  "mcp__claude_ai_GitHub_MCP__issue_write",
  "mcp__claude_ai_GitHub_MCP__sub_issue_write",
];

export const CANONICAL_CREATE_DRAFT_PR_RULES = [
  "Bash(~/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh *)",
  "Bash(/home/joshua/WebJamApps/web-jam-tools/scripts/create-draft-pr.sh *)",
  "Bash(./scripts/create-draft-pr.sh *)",
  "Bash(scripts/create-draft-pr.sh *)",
];

export interface PruneRuleResult {
  prune: boolean;
  reason?: "R-5" | "R-11" | "R-20";
}

export function shouldPruneRule(rule: string): PruneRuleResult {
  if (typeof rule !== "string") {
    return { prune: false };
  }
  const trimmed = rule.trim();

  if (R5_BLANKET_WILDCARDS.includes(trimmed)) {
    return { prune: true, reason: "R-5" };
  }

  if (R11_MCP_ALLOWS.includes(trimmed)) {
    return { prune: true, reason: "R-11" };
  }

  if (trimmed.includes("create-draft-pr.sh")) {
    if (!CANONICAL_CREATE_DRAFT_PR_RULES.includes(trimmed)) {
      return { prune: true, reason: "R-20" };
    }
  }

  return { prune: false };
}

export interface BackupCheckResult {
  present: boolean;
  path: string;
  timestamp?: string;
}

export function checkSettingsBackup(customDstDir?: string): BackupCheckResult {
  const home = Deno.env.get("HOME") || "";
  const dstDir = customDstDir || Deno.env.get("BACKUP_DST_DIR") ||
    `${home}/Dropbox/web-jam-llms/claude-backup`;
  const backupPath = `${dstDir}/claude-config/settings.json`;

  try {
    const stat = Deno.statSync(backupPath);
    if (stat.isFile) {
      const mtime = stat.mtime
        ? stat.mtime.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC")
        : "unknown";
      return { present: true, path: backupPath, timestamp: mtime };
    }
  } catch (_e) {
    // Backup file not present or unreadable
  }
  return { present: false, path: backupPath };
}

export interface FileProcessResult {
  filePath: string;
  exists: boolean;
  validJson: boolean;
  beforeCount: number;
  afterCount: number;
  removedEntries: Array<{ rule: string; reason: "R-5" | "R-11" | "R-20" }>;
  backedUpTo?: string;
}

export function processTargetFile(
  filePath: string,
  apply: boolean,
  stamp: string,
): FileProcessResult {
  let content: string;
  try {
    content = Deno.readTextFileSync(filePath);
  } catch (_e) {
    return {
      filePath,
      exists: false,
      validJson: true,
      beforeCount: 0,
      afterCount: 0,
      removedEntries: [],
    };
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Target file ${filePath} exists but contains invalid JSON: ${(err as Error).message}`,
    );
  }

  const permissions = (data.permissions as Record<string, unknown> | undefined) || {};
  const allowRules = Array.isArray(permissions.allow) ? (permissions.allow as string[]) : [];
  const beforeCount = allowRules.length;

  const remaining: string[] = [];
  const removedEntries: Array<{ rule: string; reason: "R-5" | "R-11" | "R-20" }> = [];

  for (const rule of allowRules) {
    const res = shouldPruneRule(rule);
    if (res.prune && res.reason) {
      removedEntries.push({ rule, reason: res.reason });
    } else {
      remaining.push(rule);
    }
  }

  const afterCount = remaining.length;
  let backedUpTo: string | undefined;

  if (apply && removedEntries.length > 0) {
    backedUpTo = `${filePath}.bak-${stamp}`;
    Deno.writeTextFileSync(backedUpTo, content);

    if (!data.permissions || typeof data.permissions !== "object") {
      data.permissions = {};
    }
    (data.permissions as Record<string, unknown>).allow = remaining;
    const formatted = JSON.stringify(data, null, 2) + "\n";
    Deno.writeTextFileSync(filePath, formatted);
  }

  return {
    filePath,
    exists: true,
    validJson: true,
    beforeCount,
    afterCount,
    removedEntries,
    backedUpTo,
  };
}

export function getDefaultTargetFiles(): string[] {
  const home = Deno.env.get("HOME") || "";
  return [
    `${home}/.claude/settings.local.json`,
    `${home}/WebJamApps/JaMmusic/.claude/settings.local.json`,
    `${home}/WebJamApps/WebJamSocketCluster/.claude/settings.local.json`,
    `${home}/WebJamApps/web-jam-back/.claude/settings.local.json`,
  ];
}

export function generateTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const min = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}
