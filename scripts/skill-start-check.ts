#!/usr/bin/env -S deno run
import { parseArgs } from "@std/cli/parse-args";
import { dirname, fromFileUrl, join } from "@std/path";
import { runSkillStartCheck } from "../src/skill-start-check/mod.ts";
import type { ToolTarget } from "../src/skill-start-check/types.ts";

function printUsage(): void {
  console.log(`Usage: deno task skill-start-check <skill-name> [--tool claude|agy|all]

Proves a skill still starts after its description or listing changes, on Claude Code and on agy.
Runs two checks per tool: started when typed by name, and started on its own from a work situation.

Arguments:
  <skill-name>            Name of the skill under skills/ (e.g. sheet-music)

Options:
  --tool claude|agy|all   Which tool to test (default: all)
  --skills-dir <dir>      Path to skills directory (default: <repo-root>/skills)
  --work-dir <dir>        Working directory for Claude Code session (default: ~/WebJamApps/web-jam-tools)
  --timeout <ms>          Timeout per check in milliseconds (default: 30000ms for Claude, 180000ms for agy)
  --help, -h              Show this help message
`);
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    string: ["tool", "skills-dir", "work-dir", "timeout"],
    boolean: ["help"],
    alias: { h: "help" },
    default: { tool: "all" },
  });

  if (args.help) {
    printUsage();
    Deno.exit(0);
  }

  const skillName = args._[0]?.toString().trim();
  if (!skillName) {
    console.error("Error: <skill-name> argument is required.\n");
    printUsage();
    Deno.exit(1);
  }

  const toolRaw = (args.tool ?? "all").toLowerCase();
  if (toolRaw !== "claude" && toolRaw !== "agy" && toolRaw !== "all") {
    console.error(`Error: Invalid --tool '${args.tool}'. Must be 'claude', 'agy', or 'all'.\n`);
    printUsage();
    Deno.exit(1);
  }
  const tool: ToolTarget = toolRaw as ToolTarget;

  const scriptDir = dirname(fromFileUrl(import.meta.url));
  const repoRoot = join(scriptDir, "..");
  const skillsDir = args["skills-dir"] ?? join(repoRoot, "skills");
  const workDir = args["work-dir"] ?? "/home/joshua/WebJamApps/web-jam-tools";
  const timeoutMs = args.timeout ? parseInt(args.timeout, 10) : undefined;

  try {
    const { allPassed, formattedLines } = await runSkillStartCheck(skillName, {
      tool,
      skillsDir,
      workDir,
      timeoutMs,
    });

    for (const line of formattedLines) {
      console.log(line);
    }

    if (!allPassed) {
      Deno.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
