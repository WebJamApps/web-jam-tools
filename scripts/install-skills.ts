#!/usr/bin/env -S deno run --allow-env --allow-run --allow-read --allow-write
/**
 * install-skills.ts — make this repo the single source of truth for Claude Code & agy skills.
 * (web-jam-tools#669)
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
