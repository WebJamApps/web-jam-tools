// src/memory-index/generator.ts
// Memory Index generator for web-jam-tools#440

import { parse as parseYaml } from "@std/yaml";
import { join } from "@std/path";

export interface MemoryEntry {
  filename: string;
  slug: string;
  type: "user" | "feedback" | "reference" | "project";
  status?: string;
  description: string;
  isCheckpoint: boolean;
  /** `metadata.guard: true` — a guard rule is never archived by the index run. */
  guard?: boolean;
}

export interface SkippedMemoryFile {
  filename: string;
  reason: string;
}

export type SkipReasonHandler = (reason: string) => void;

export interface MemoryDirectoryScanResult {
  entries: MemoryEntry[];
  skipped: SkippedMemoryFile[];
}

/**
 * Derived budget function (Design 1C / Decision 34):
 *   bytes(MEMORY.md) ≈ Σ len(slug) + group markup
 * Evaluates to ~6.2KB currently; the budget is the `memoryIndex` entry in
 * src/session-load/limits.json.
 */

export function parseMemoryFile(
  content: string,
  filename: string,
  onSkip?: SkipReasonHandler,
): MemoryEntry | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    onSkip?.("no front matter block");
    return null;
  }

  try {
    const fm = (parseYaml(match[1]) || {}) as Record<string, unknown>;
    const metadata =
      (typeof fm.metadata === "object" && fm.metadata !== null ? fm.metadata : {}) as Record<
        string,
        unknown
      >;

    const rawType = (metadata.type || fm.type || "project").toString().toLowerCase();
    const type: MemoryEntry["type"] =
      rawType === "user" || rawType === "feedback" || rawType === "reference" ? rawType : "project";

    const description = (fm.description || "").toString().trim();
    const status = metadata.status ? metadata.status.toString().toLowerCase() : undefined;
    const slug = filename.replace(/\.md$/, "");
    const isCheckpoint = slug.startsWith("session-checkpoint-");

    return {
      filename,
      slug,
      type,
      status,
      description,
      isCheckpoint,
      guard: metadata.guard === true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0].trim() : String(err);
    onSkip?.(msg);
    return null;
  }
}

export async function scanMemoryDirectory(dirPath: string): Promise<MemoryDirectoryScanResult> {
  const entries: MemoryEntry[] = [];
  const skipped: SkippedMemoryFile[] = [];

  for await (const entry of Deno.readDir(dirPath)) {
    if (!entry.isFile || entry.name === "MEMORY.md" || !entry.name.endsWith(".md")) {
      continue;
    }
    try {
      const content = await Deno.readTextFile(join(dirPath, entry.name));
      let skipReason = "";
      const parsed = parseMemoryFile(content, entry.name, (reason) => {
        skipReason = reason;
      });
      if (parsed) {
        entries.push(parsed);
      } else {
        skipped.push({
          filename: entry.name,
          reason: skipReason,
        });
      }
    } catch (err) {
      skipped.push({
        filename: entry.name,
        reason: err instanceof Error ? err.message.split("\n")[0].trim() : String(err),
      });
    }
  }

  skipped.sort((a, b) => a.filename.localeCompare(b.filename));

  return { entries, skipped };
}

/**
 * Done checkpoints are no longer archived by the index run (web-jam-tools#1608, Decision 34).
 * Checkpoint movement to ~/Dropbox/web-jam-llms/resume-records/ is handled by /memory-cleanup.
 */
export function isArchivable(_entry: MemoryEntry, _protectedSlugs?: ReadonlySet<string>): boolean {
  return false;
}

export function archiveDoneCheckpoints(
  _dirPath: string,
  entries: MemoryEntry[],
  _protectedSlugs?: ReadonlySet<string>,
): Promise<{ remaining: MemoryEntry[]; archivedCount: number }> {
  return Promise.resolve({ remaining: [...entries], archivedCount: 0 });
}

export function generateMemoryIndex(entries: MemoryEntry[]): string {
  const groups: Record<MemoryEntry["type"], MemoryEntry[]> = {
    user: [],
    feedback: [],
    reference: [],
    project: [],
  };

  for (const entry of entries) {
    groups[entry.type].push(entry);
  }

  let output = "# Memory Index\n\n";

  for (const type of ["user", "feedback", "reference", "project"] as const) {
    const groupEntries = groups[type];
    if (groupEntries.length === 0) continue;

    output += `## ${type.charAt(0).toUpperCase() + type.slice(1)}\n\n`;

    // Render slugs alphabetically, wrapped at <= 80 chars per line (Decision 34)
    groupEntries.sort((a, b) => a.slug.localeCompare(b.slug));
    const slugs = groupEntries.map((e) => e.slug);

    let currentLine = "";
    for (const slug of slugs) {
      if (!currentLine) {
        currentLine = slug;
      } else if (currentLine.length + 3 + slug.length <= 80) {
        currentLine += " · " + slug;
      } else {
        output += currentLine + "\n";
        currentLine = slug;
      }
    }
    if (currentLine) {
      output += currentLine + "\n";
    }
    output += "\n";
  }

  return output;
}
