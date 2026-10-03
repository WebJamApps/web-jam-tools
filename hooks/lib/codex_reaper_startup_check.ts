import * as path from "@std/path";

// Keep each retained byte (including line endings and blank lines) intact.
// Comments immediately above a table belong to that table; comments above the
// next table must survive when a REAPER section is removed.
export function removeReaperRegistration(content: string): string {
  const lines = content.split(/(?<=\n)/);
  const tables: { header: number; start: number; reaper: boolean }[] = [];
  let multilineQuote: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!multilineQuote && /^\s*\[\[?.+?\]\]?\s*(?:#.*)?$/.test(line.trimEnd())) {
      let start = i;
      while (start > 0 && /^\s*#/.test(lines[start - 1])) start--;
      tables.push({
        header: i,
        start,
        reaper: /^\s*\[mcp_servers\.(?:"reaper"|'reaper'|reaper)(?:\.[^\]]+)?\]\s*(?:#.*)?$/
          .test(line.trimEnd()),
      });
    }
    // Headers inside a TOML multiline string are data, not registrations.
    let quote: string | undefined = multilineQuote;
    for (let j = 0; j < line.length; j++) {
      if (!quote && line[j] === "#") break;
      if (quote?.startsWith('"') && line[j] === "\\") {
        j++;
        continue;
      }
      if (quote) {
        if (line.startsWith(quote, j)) {
          j += quote.length - 1;
          quote = undefined;
        }
      } else if (line[j] === '"' || line[j] === "'") {
        quote = line.startsWith(line[j].repeat(3), j) ? line[j].repeat(3) : line[j];
        j += quote.length - 1;
      }
    }
    multilineQuote = quote?.length === 3 ? quote : undefined;
  }
  const removed = new Set<number>();
  for (let i = 0; i < tables.length; i++) {
    if (!tables[i].reaper) continue;
    let end = tables[i + 1]?.start ?? lines.length;
    // Separators outside the table are retained, rather than normalized globally.
    while (end > tables[i].header + 1 && lines[end - 1].trim() === "") end--;
    for (let j = tables[i].start; j < end; j++) removed.add(j);
  }
  return lines.filter((_, i) => !removed.has(i)).join("");
}

export async function runCodexReaperStartupCheck(options?: {
  configPath?: string;
  claimPath?: string;
  surface?: string;
}): Promise<{ removed: boolean; reason?: string }> {
  if ((options?.surface ?? Deno.env.get("WJT_SURFACE")) !== "codex") {
    return { removed: false, reason: "not a Codex session" };
  }
  const home = Deno.env.get("HOME") ?? "";
  const codexHome = Deno.env.get("CODEX_HOME") ?? (home ? path.join(home, ".codex") : "");
  const defaultCodexConfig = codexHome ? path.join(codexHome, "config.toml") : "";
  const configPath = options?.configPath ?? Deno.env.get("CODEX_CONFIG_PATH") ?? defaultCodexConfig;

  const stateDir = Deno.env.get("CLAUDE_STATE_DIR") ??
    (home ? path.join(home, ".claude", "state") : "");
  const defaultClaimPath = stateDir ? path.join(stateDir, "reaper-recording-claim.json") : "";
  const claimPath = options?.claimPath ?? Deno.env.get("REAPER_CLAIM_FILE") ?? defaultClaimPath;

  // 1. Check if active claim exists
  if (claimPath) {
    try {
      const claimStat = await Deno.stat(claimPath);
      if (claimStat.isFile && claimStat.size > 0) {
        // Active claim file exists, do not remove registration
        return { removed: false, reason: "active claim exists" };
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        return { removed: false, reason: "recording claim could not be checked" };
      }
    }
  }

  // 2. Check if Codex config exists
  if (!configPath) {
    return { removed: false, reason: "no config path" };
  }
  let tomlContent = "";
  try {
    tomlContent = await Deno.readTextFile(configPath);
  } catch {
    return { removed: false, reason: "config file not found or unreadable" };
  }

  const cleaned = removeReaperRegistration(tomlContent);
  if (cleaned === tomlContent) {
    return { removed: false, reason: "no reaper registration found" };
  }

  await Deno.writeTextFile(configPath, cleaned);
  return { removed: true };
}

if (import.meta.main) {
  const result = await runCodexReaperStartupCheck();
  if (result.removed) {
    console.log(JSON.stringify({
      systemMessage:
        "Removed leftover REAPER MCP registration from Codex config.toml (no active recording session).",
    }));
  }
}
