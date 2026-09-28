// src/memory-cleanup/cli.ts — web-jam-tools#1166
// CLI entrypoint for `deno task memory-cleanup:scan`.

import { parseArgs } from "@std/cli/parse-args";
import { DEFAULT_QUEUE_FILENAMES, runMemoryCleanupScan } from "./scan.ts";

function expandHome(path: string): string {
  if (path.startsWith("~/") || path === "~") {
    const home = Deno.env.get("HOME") || "/home/joshua";
    return path.replace(/^~(?:\/|$)/, `${home}/`);
  }
  return path;
}

export async function runCli(args: string[]): Promise<number> {
  const flags = parseArgs(args, {
    boolean: ["help"],
    string: ["dir", "shared-dir", "dropbox-dir"],
    default: {
      help: false,
    },
  });

  if (flags.help) {
    console.log(
      "Usage: deno task memory-cleanup:scan [--dir <path>] [--shared-dir <path>] [--dropbox-dir <path>]",
    );
    console.log(
      "Runs the deterministic Phase 1 mechanical checks for /memory-cleanup surfaces 1, 6, and 10.",
    );
    console.log("Prints one JSON object on stdout. Read-only — never writes anything.");
    return 0;
  }

  const surface1Dir = expandHome(flags.dir || "~/.claude/projects/-home-joshua/memory");
  const surface10Dir = expandHome(flags["shared-dir"] || "~/.claude/shared-memory");
  const dropboxDir = expandHome(flags["dropbox-dir"] || "~/Dropbox/web-jam-llms");
  const surface6Paths = DEFAULT_QUEUE_FILENAMES.map((name) => `${dropboxDir}/${name}`);

  const result = await runMemoryCleanupScan({ surface1Dir, surface10Dir, surface6Paths });
  console.log(JSON.stringify(result, null, 2));

  const hasError = result.surfaces.some(
    (s) => s.status === "error" || s.findings?.some((f) => f.status === "error"),
  );
  return hasError ? 1 : 0;
}

if (import.meta.main) {
  const exitCode = await runCli(Deno.args);
  if (exitCode !== 0) {
    Deno.exit(exitCode);
  }
}
