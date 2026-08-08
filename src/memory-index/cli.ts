// src/memory-index/cli.ts
// CLI script for deno task memory-index

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { archiveDoneCheckpoints, generateMemoryIndex, scanMemoryDirectory } from "./generator.ts";

function expandHome(path: string): string {
  if (path.startsWith("~/") || path === "~") {
    const home = Deno.env.get("HOME") || "/home/joshua";
    return path.replace(/^~(?:\/|$)/, `${home}/`);
  }
  return path;
}

export async function runCli(args: string[]): Promise<number> {
  const flags = parseArgs(args, {
    boolean: ["check", "help"],
    string: ["dir"],
    default: {
      check: false,
      help: false,
    },
  });

  if (flags.help) {
    console.log("Usage: deno task memory-index [--check] [--dir <path>]");
    console.log("Generates MEMORY.md for the target memory directory.");
    return 0;
  }

  const defaultDir = "~/.claude/projects/-home-joshua/memory";
  const targetDir = expandHome(flags.dir || defaultDir);

  const entries = await scanMemoryDirectory(targetDir);

  if (flags.check) {
    // In check mode: do not modify disk. Simulate filtering out done checkpoints.
    const activeEntries = entries.filter((e) => !(e.isCheckpoint && e.status === "done"));
    const expected = generateMemoryIndex(activeEntries);
    const expectedBytes = new TextEncoder().encode(expected).length;

    const memoryMdPath = join(targetDir, "MEMORY.md");
    let actual = "";
    try {
      actual = await Deno.readTextFile(memoryMdPath);
    } catch {
      console.error(`MEMORY.md missing at ${memoryMdPath}`);
      return 1;
    }

    if (actual !== expected) {
      console.error(
        `MEMORY.md is out of date at ${memoryMdPath}. Run 'deno task memory-index' to regenerate.`,
      );
      return 1;
    }

    console.log(`MEMORY.md is up to date (${expectedBytes} bytes).`);
    return 0;
  }

  // Write mode
  const { remaining, archivedCount } = await archiveDoneCheckpoints(targetDir, entries);
  const newContent = generateMemoryIndex(remaining);
  const memoryMdPath = join(targetDir, "MEMORY.md");
  await Deno.writeTextFile(memoryMdPath, newContent);

  const byteCount = new TextEncoder().encode(newContent).length;
  console.log(
    `Wrote ${memoryMdPath} (${byteCount} bytes). Archived ${archivedCount} done checkpoints.`,
  );
  return 0;
}

if (import.meta.main) {
  const exitCode = await runCli(Deno.args);
  if (exitCode !== 0) {
    Deno.exit(exitCode);
  }
}
