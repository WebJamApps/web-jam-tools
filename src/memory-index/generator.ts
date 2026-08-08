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
}

/**
 * Derived budget function (Design 1C):
 *   bytes(MEMORY.md) ≈ Σ len(slug) + group markup + live-checkpoint lines
 * Evaluates to ~6.2KB currently; hard budget is 6,500 bytes.
 */

export function parseMemoryFile(content: string, filename: string): MemoryEntry | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

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
    };
  } catch {
    return null;
  }
}

export async function scanMemoryDirectory(dirPath: string): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = [];
  for await (const entry of Deno.readDir(dirPath)) {
    if (!entry.isFile || entry.name === "MEMORY.md" || !entry.name.endsWith(".md")) {
      continue;
    }
    try {
      const content = await Deno.readTextFile(join(dirPath, entry.name));
      const parsed = parseMemoryFile(content, entry.name);
      if (parsed) {
        entries.push(parsed);
      }
    } catch {
      // Ignore unreadable files
    }
  }
  return entries;
}

export async function archiveDoneCheckpoints(
  dirPath: string,
  entries: MemoryEntry[],
): Promise<{ remaining: MemoryEntry[]; archivedCount: number }> {
  const remaining: MemoryEntry[] = [];
  let archivedCount = 0;
  const archiveDir = join(dirPath, "archive");

  for (const entry of entries) {
    if (entry.isCheckpoint && entry.status === "done") {
      await Deno.mkdir(archiveDir, { recursive: true });
      const oldPath = join(dirPath, entry.filename);
      const newPath = join(archiveDir, entry.filename);
      await Deno.rename(oldPath, newPath);
      archivedCount++;
    } else {
      remaining.push(entry);
    }
  }

  return { remaining, archivedCount };
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

    const regularEntries = groupEntries.filter((e) => !e.isCheckpoint);
    const checkpointEntries = groupEntries.filter((e) => e.isCheckpoint);

    // Render regular slugs alphabetically, wrapped at <= 80 chars per line
    if (regularEntries.length > 0) {
      regularEntries.sort((a, b) => a.slug.localeCompare(b.slug));
      const slugs = regularEntries.map((e) => e.slug);

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

    // Render live checkpoints
    if (checkpointEntries.length > 0) {
      checkpointEntries.sort((a, b) => a.slug.localeCompare(b.slug));
      for (const c of checkpointEntries) {
        let stateNote = c.description.split("\n")[0].trim();
        if (stateNote.length > 75) {
          stateNote = stateNote.slice(0, 72) + "...";
        }
        output += `- [${c.slug}](${c.filename}) — ${stateNote}\n`;
      }
      output += "\n";
    }
  }

  return output;
}
