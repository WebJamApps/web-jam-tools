#!/usr/bin/env -S deno run --allow-env --allow-run --allow-read --allow-write
/**
 * install-skills.ts — make this repo the single source of truth for Claude Code & agy skills.
 * (web-jam-tools#668, web-jam-tools#669)
 *
 * Retention Policy:
 * Backups of replaced skills are saved outside scanned skill directories
 * (~/.claude/skills-backups and ~/.gemini/config/plugins/webjam-tasks/skills-backups).
 * Stale backups older than the 14-day retention window are automatically pruned on each run.
 */
import { installSkills, parseArgs } from "../src/install-skills/lib.ts";

async function main() {
  try {
    const options = parseArgs(Deno.args);
    const result = await installSkills(options);
    if (!options.quiet) {
      for (const msg of result.messages) {
        console.log(msg);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: ${msg}`);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
