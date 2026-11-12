// src/memory-index/cli.ts
// CLI script for deno task memory-index

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { generateMemoryIndex, scanMemoryDirectory } from "./generator.ts";

function expandHome(path: string): string {
  if (path.startsWith("~/") || path === "~") {
    const home = Deno.env.get("HOME") || "/home/joshua";
    return path.replace(/^~(?:\/|$)/, `${home}/`);
  }
  return path;
}

export async function runCli(args: string[]): Promise<number> {
  const flags = parseArgs(args, {
    boolean: ["check", "help", "quiet"],
    string: ["dir", "protect"],
    collect: ["protect"],
    default: {
      check: false,
      help: false,
      quiet: false,
    },
  });

  if (flags.help) {
    console.log(
      "Usage: deno task memory-index [--check] [--quiet] [--dir <path>] [--protect <slug>]...",
    );
    console.log("Generates MEMORY.md for the target memory directory.");
    console.log(
      "--protect <slug> (deprecated / no-op) retained for compatibility with /memory-cleanup.",
    );
    return 0;
  }

  const defaultDir = "~/.claude/projects/-home-joshua/memory";
  const targetDir = expandHome(flags.dir || defaultDir);

  const { entries, skipped } = await scanMemoryDirectory(targetDir);

  if (!flags.quiet) {
    for (const skip of skipped) {
      console.error(`Skipped ${skip.filename}: ${skip.reason}`);
    }
  }

  if (flags.check) {
    // In check mode: do not modify disk.
    const expected = generateMemoryIndex(entries);
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

    if (skipped.length > 0) {
      return 1;
    }

    console.log(`MEMORY.md is up to date (${expectedBytes} bytes).`);
    return 0;
  }

  // Write mode
  const newContent = generateMemoryIndex(entries);
  const memoryMdPath = join(targetDir, "MEMORY.md");
  await Deno.writeTextFile(memoryMdPath, newContent);

  const byteCount = new TextEncoder().encode(newContent).length;
  if (!flags.quiet) {
    console.log(`Wrote ${memoryMdPath} (${byteCount} bytes).`);
  }
  return skipped.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  const exitCode = await runCli(Deno.args);
  if (exitCode !== 0) {
    Deno.exit(exitCode);
  }
}
