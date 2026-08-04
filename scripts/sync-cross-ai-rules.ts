import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";

export const START_MARKER = "<!-- CROSS-AI-HARD-RULES-START -->";
export const END_MARKER = "<!-- CROSS-AI-HARD-RULES-END -->";

export const DEFAULT_REPOS = [
  "web-jam-tools",
  "JaMmusic",
  "CollegeLutheran",
  "AppersonAuto",
  "web-jam-back",
  "WebJamSocketCluster",
  "TimShermanMusic",
  "HenricksonForSalem",
];

export function extractHardRulesBlock(crossAiRulesContent: string): string {
  const lines = crossAiRulesContent.split("\n");
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toUpperCase().startsWith("## OPERATIONAL HARD RULES")) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) {
    throw new Error("Could not find ## OPERATIONAL HARD RULES section in cross-ai-rules.md");
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("## ")) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join("\n").trim();
}

export function formatWrappedBlock(canonicalBlock: string): string {
  return `${START_MARKER}\n${canonicalBlock}\n${END_MARKER}`;
}

export function updateAgentsMdContent(existingContent: string, canonicalBlock: string): string {
  const wrapped = formatWrappedBlock(canonicalBlock);
  const startIdx = existingContent.indexOf(START_MARKER);
  const endIdx = existingContent.indexOf(END_MARKER);

  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    const before = existingContent.substring(0, startIdx);
    const after = existingContent.substring(endIdx + END_MARKER.length);
    return (before + wrapped + after).trim() + "\n";
  }

  // If markers are not present, inject before the first `\n## ` section, or append
  const match = existingContent.match(/\n## /);
  if (match && match.index !== undefined) {
    const insertIdx = match.index;
    const before = existingContent.substring(0, insertIdx);
    const after = existingContent.substring(insertIdx);
    return (before + "\n\n" + wrapped + after).trim() + "\n";
  }

  return (existingContent.trim() + "\n\n" + wrapped).trim() + "\n";
}

export function isAgentsMdInSync(existingContent: string, canonicalBlock: string): boolean {
  const startIdx = existingContent.indexOf(START_MARKER);
  const endIdx = existingContent.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return false;
  }
  const currentBlock = existingContent
    .substring(startIdx + START_MARKER.length, endIdx)
    .trim();
  return currentBlock === canonicalBlock.trim();
}

export interface SyncOptions {
  check?: boolean;
  write?: boolean;
  docPath?: string;
  targetFiles?: string[];
  reposDir?: string;
}

export function syncCrossAiRules(options: SyncOptions): {
  driftCount: number;
  updatedCount: number;
  success: boolean;
} {
  const cwd = Deno.cwd();
  const homeDir = Deno.env.get("HOME") || "/home/joshua";
  const defaultReposDir = cwd.endsWith("web-jam-tools")
    ? join(cwd, "..")
    : join(homeDir, "WebJamApps");
  const reposDir = options.reposDir || defaultReposDir;

  let docPath = options.docPath;
  if (!docPath) {
    const localDoc = join(cwd, "docs", "cross-ai-rules.md");
    docPath = tryExistsSync(localDoc)
      ? localDoc
      : join(reposDir, "web-jam-tools", "docs", "cross-ai-rules.md");
  }

  let crossAiRulesContent: string;
  try {
    crossAiRulesContent = Deno.readTextFileSync(docPath);
  } catch (err) {
    console.error(`Error reading ${docPath}: ${(err as Error).message}`);
    return { driftCount: 1, updatedCount: 0, success: false };
  }

  const canonicalBlock = extractHardRulesBlock(crossAiRulesContent);

  const isExplicitTarget = Boolean(options.targetFiles);
  const targetFiles = options.targetFiles ||
    DEFAULT_REPOS.map((repo) => join(reposDir, repo, "AGENTS.md"));

  let driftCount = 0;
  let updatedCount = 0;

  for (const file of targetFiles) {
    let existingContent = "";
    let fileExists = false;
    try {
      existingContent = Deno.readTextFileSync(file);
      fileExists = true;
    } catch {
      fileExists = false;
    }

    if (!fileExists && !isExplicitTarget) {
      const parentDir = join(file, "..");
      if (!tryExistsSync(parentDir)) {
        console.log(`[SKIP] ${file} (repo directory does not exist on this machine)`);
        continue;
      }
    }

    if (options.check) {
      if (!fileExists || !isAgentsMdInSync(existingContent, canonicalBlock)) {
        console.error(`[DRIFT] ${file} is out of sync or missing cross-ai rules block.`);
        driftCount++;
      } else {
        console.log(`[OK] ${file} is in sync.`);
      }
    } else if (options.write) {
      if (fileExists && isAgentsMdInSync(existingContent, canonicalBlock)) {
        console.log(`[UP-TO-DATE] ${file}`);
      } else {
        const newContent = updateAgentsMdContent(existingContent, canonicalBlock);
        Deno.writeTextFileSync(file, newContent);
        updatedCount++;
        console.log(`[${fileExists ? "UPDATED" : "CREATED"}] ${file}`);
      }
    }
  }

  if (options.check) {
    if (driftCount > 0) {
      console.error(`[FAIL] Detected drift in ${driftCount} file(s).`);
      return { driftCount, updatedCount: 0, success: false };
    }
    console.log("[SUCCESS] All AGENTS.md files contain up-to-date cross-ai rules block.");
    return { driftCount: 0, updatedCount: 0, success: true };
  }

  return { driftCount: 0, updatedCount, success: true };
}

function tryExistsSync(p: string): boolean {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    boolean: ["check", "write", "help"],
    string: ["doc", "repos-dir"],
  });

  if (args.help || (!args.check && !args.write)) {
    console.log(
      `Usage: deno run --allow-read --allow-write scripts/sync-cross-ai-rules.ts [--check] [--write] [--doc <path>] [--repos-dir <path>]`,
    );
    Deno.exit(1);
  }

  const result = syncCrossAiRules({
    check: args.check,
    write: args.write,
    docPath: args.doc,
    reposDir: args["repos-dir"],
  });

  if (!result.success) {
    Deno.exit(1);
  }
}
