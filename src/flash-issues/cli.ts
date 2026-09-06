// src/flash-issues/cli.ts
// CLI entry point for deno task flash-issues.

import { parseArgs } from "@std/cli/parse-args";
import { formatConsoleReport, formatMarkdown } from "./formatter.ts";
import { classifyAll, reconcileCounts } from "./reconciler.ts";
import { runGhCommand, scanAllRepos } from "./scanner.ts";
import type { CommandRunner } from "./types.ts";

export function expandHome(path: string): string {
  if (path.startsWith("~/") || path === "~") {
    const home = Deno.env.get("HOME") || "/home/joshua";
    return path.replace(/^~(?:\/|$)/, `${home}/`);
  }
  return path;
}

export const DEFAULT_OUTPUT_PATH = "~/Dropbox/web-jam-llms/flash-issues.md";

export interface CliOptions {
  out?: string;
  output?: string;
  dryRun?: boolean;
  json?: boolean;
  help?: boolean;
}

export async function runCli(
  args: string[] = Deno.args,
  runner: CommandRunner = runGhCommand,
): Promise<number> {
  const flags = parseArgs(args, {
    string: ["out", "output"],
    boolean: ["dry-run", "json", "help"],
    alias: {
      h: "help",
      d: "dry-run",
      o: "out",
    },
    default: {
      "dry-run": false,
      json: false,
      help: false,
    },
  });

  if (flags.help) {
    console.log("Usage: deno task flash-issues [--out <path>] [--dry-run] [--json]");
    console.log("Regenerates the Flash-lane worklist across all 8 active WebJamApps repos.");
    return 0;
  }

  const rawOut = flags.out || flags.output || DEFAULT_OUTPUT_PATH;
  const targetPath = expandHome(rawOut);

  try {
    const scanResults = await scanAllRepos(undefined, runner);
    const classified = await classifyAll(scanResults, {
      dryRun: flags["dry-run"],
      runner,
    });

    const reconciliation = reconcileCounts(scanResults, classified);

    if (!reconciliation.reconciled) {
      console.error(
        `ERROR: Step 8 Reconciliation failed! Scanned ${reconciliation.totalScanned} issues != Categorized ${reconciliation.totalCategorized}`,
      );
      return 1;
    }

    const markdown = formatMarkdown(classified);

    if (!flags["dry-run"]) {
      // Ensure parent directory exists
      const parentDir = targetPath.substring(0, targetPath.lastIndexOf("/"));
      if (parentDir) {
        try {
          await Deno.mkdir(parentDir, { recursive: true });
        } catch {
          // Parent dir exists
        }
      }
      await Deno.writeTextFile(targetPath, markdown);
    }

    if (flags.json) {
      console.log(
        JSON.stringify(
          {
            reconciliation,
            classified,
            markdown,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        formatConsoleReport(reconciliation, classified, scanResults, targetPath),
      );
    }

    return 0;
  } catch (err) {
    console.error(
      `flash-issues: execution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}

if (import.meta.main) {
  const code = await runCli(Deno.args);
  if (code !== 0) {
    Deno.exit(code);
  }
}
