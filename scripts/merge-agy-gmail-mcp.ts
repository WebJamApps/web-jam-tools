#!/usr/bin/env deno run --allow-read --allow-write
/**
 * merge-agy-gmail-mcp.ts — web-jam-tools#432 scope item 2.
 *
 * Idempotently merges a `gmail` MCP server entry into Antigravity's
 * mcp_config.json, mirroring Claude Code's existing entry
 * (`npx -y @gongrzhe/server-gmail-autoauth-mcp`) so the same `~/.gmail-mcp/`
 * credentials authenticate agy the same way. Purely additive: every other
 * `mcpServers` entry (playwright, reaper, ...) and every other top-level key
 * is left untouched.
 *
 * NOT wired into scripts/install-hooks.sh and NOT run automatically by any
 * agent session — connecting a new MCP server to a Flash surface requires
 * Josh's explicit authorization naming that connection. This script only
 * makes the change REPRODUCIBLE FROM THIS REPO instead of a hand-applied,
 * untracked laptop edit; Josh runs it himself (via
 * scripts/install-agy-gmail-mcp.sh) when he's ready to apply it.
 */

export const GMAIL_MCP_ENTRY = {
  command: "npx",
  args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
};

export function merge(configPath: string): { changed: boolean; message: string } {
  let data: Record<string, unknown> = {};
  let fileExists = true;
  try {
    const raw = Deno.readTextFileSync(configPath);
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      fileExists = false;
    } else {
      return { changed: false, message: `error: ${configPath} is not valid JSON, refusing to touch it: ${e}` };
    }
  }

  if (!data.mcpServers || typeof data.mcpServers !== "object") {
    data.mcpServers = {};
  }
  const servers = data.mcpServers as Record<string, unknown>;

  const existing = servers.gmail;
  if (
    existing && typeof existing === "object" &&
    JSON.stringify(existing) === JSON.stringify(GMAIL_MCP_ENTRY)
  ) {
    return { changed: false, message: `${configPath}: gmail MCP server entry already up to date (no-op)` };
  }

  servers.gmail = GMAIL_MCP_ENTRY;

  if (fileExists) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    Deno.copyFileSync(configPath, `${configPath}.bak-${stamp}`);
  }
  const dir = configPath.slice(0, configPath.lastIndexOf("/"));
  if (dir) Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(configPath, JSON.stringify(data, null, 2) + "\n");

  return {
    changed: true,
    message: `${configPath}: added gmail MCP server entry (mirrors Claude Code's ~/.claude/mcp_config.json entry)`,
  };
}

if (import.meta.main) {
  const configPath = Deno.args[0];
  if (!configPath) {
    console.error("usage: merge-agy-gmail-mcp.ts <mcp_config.json path>");
    Deno.exit(1);
  }
  const result = merge(configPath);
  console.log(result.message);
  if (!result.changed && result.message.startsWith("error:")) {
    Deno.exit(1);
  }
}
