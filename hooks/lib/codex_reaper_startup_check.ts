import * as path from "@std/path";

export async function runCodexReaperStartupCheck(options?: {
  configPath?: string;
  claimPath?: string;
}): Promise<{ removed: boolean; reason?: string }> {
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
    } catch {
      // File does not exist or cannot be accessed -> no active claim
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

  // 3. Check for [mcp_servers.reaper] or [mcp_servers."reaper"]
  const reaperSectionRegex = /^\[mcp_servers\.(?:"reaper"|reaper)(?:\..*)?\]/m;
  if (!reaperSectionRegex.test(tomlContent)) {
    return { removed: false, reason: "no reaper registration found" };
  }

  // Remove the reaper section(s)
  const lines = tomlContent.split("\n");
  const newLines: string[] = [];
  let skippingReaper = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      if (/^\[mcp_servers\.(?:"reaper"|reaper)(?:\..*)?\]$/.test(trimmed)) {
        skippingReaper = true;
        continue;
      } else {
        skippingReaper = false;
      }
    }
    if (!skippingReaper) {
      newLines.push(line);
    }
  }

  let cleaned = newLines.join("\n");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

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
