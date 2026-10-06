// Claude's launcher configuration identifies servers; it does not contain their
// discovered listings. Read native discovery entries without connecting to a
// server or accessing the credentials used to seal newer cache entries.
import { join } from "@std/path";

export interface ConnectorInfo {
  count: number;
  /** Null means the listing footprint cannot be measured from disk. */
  sizeBytes: number | null;
  listingNote?: string;
  /** Names in readable discovery entries, not a complete session footprint. */
  cachedToolNameBytes?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Read configured identities and whatever native listing data exists on disk. */
export async function inspectClaudeConnectors(
  configPath: string,
  projectPaths: string[] = [],
  discoveryDir?: string,
): Promise<ConnectorInfo> {
  const servers = new Set<string>();
  try {
    const config = record(JSON.parse(await Deno.readTextFile(configPath)));
    if (!config) throw new Error("invalid configuration");
    const add = (value: unknown) => {
      for (const name of Object.keys(record(value) ?? {})) servers.add(name);
    };
    add(config.mcpServers);
    const projects = record(config.projects);
    for (const path of projectPaths) {
      const normalized = path.replace(/\/+$/, "");
      const project = record(
        projects?.[path] ?? projects?.[normalized] ?? projects?.[`${normalized}/`],
      );
      add(project?.mcpServers);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { count: 0, sizeBytes: 0 };
    return { count: 0, sizeBytes: null, listingNote: "configuration unavailable" };
  }
  if (servers.size === 0) return { count: 0, sizeBytes: 0 };

  // Verified against Claude Code 2.1.291's native v1 discoveryWireSchemas:
  // {v, serverName, cacheKey, savedAt, tools, commands, resources, ...}.
  // Its persisted shape does not contain initialize.instructions. Newer sealed
  // entries cannot be decoded as JSON and remain unavailable, rather than being
  // mistaken for their ciphertext's byte length.
  const latest = new Map<string, { savedAt: number; bytes: number }>();
  if (discoveryDir) {
    try {
      for await (const file of Deno.readDir(discoveryDir)) {
        if (!file.isFile || !file.name.endsWith(".json")) continue;
        try {
          const path = join(discoveryDir, file.name);
          // Native discovery entries are capped at 8 MiB. Never read arbitrary
          // oversized files in this directory at session startup.
          if ((await Deno.lstat(path)).size > 8 * 1024 * 1024) continue;
          const entry = record(JSON.parse(await Deno.readTextFile(path)));
          if (
            !entry || entry.v !== 1 || typeof entry.serverName !== "string" ||
            !servers.has(entry.serverName) || typeof entry.cacheKey !== "string" ||
            typeof entry.savedAt !== "number" || !Number.isFinite(entry.savedAt) ||
            !Array.isArray(entry.tools)
          ) continue;
          const names = entry.tools.map((tool: unknown) => record(tool)?.name);
          if (names.some((name: unknown) => typeof name !== "string")) continue;
          const bytes = names.reduce<number>(
            (sum, name) => sum + new TextEncoder().encode(String(name)).length,
            0,
          );
          const previous = latest.get(entry.serverName);
          if (!previous || entry.savedAt > previous.savedAt) {
            latest.set(entry.serverName, { savedAt: entry.savedAt, bytes });
          }
        } catch {
          // Missing, sealed, malformed, and unreadable entries give no measurement.
        }
      }
    } catch {
      // The discovery cache is optional and may not exist.
    }
  }
  return {
    count: servers.size,
    sizeBytes: null,
    listingNote: latest.size > 0
      ? "server instructions unavailable; cached tool names are a partial measurement"
      : "tool names and server instructions unavailable from disk",
    ...(latest.size > 0
      ? {
        cachedToolNameBytes: [...latest.values()].reduce((sum, entry) => sum + entry.bytes, 0),
      }
      : {}),
  };
}
