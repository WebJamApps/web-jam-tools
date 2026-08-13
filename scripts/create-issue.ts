#!/usr/bin/env deno run --allow-env --allow-run --allow-read --allow-write
/**
 * Standardized issue creation script (web-jam-tools#514)
 * Sets labels, milestone, native Priority, and parent link, and verifies all attributes stick.
 */
import { createIssueAndVerify, parseArgs } from "../src/create-issue/lib.ts";

async function main() {
  const options = parseArgs(Deno.args);
  if (!options.title || !options.bodyFile) {
    console.error("Usage: deno task create-issue --title \"...\" --body-file <path> [options]");
    console.error("Options:");
    console.error("  --repo <repo>          (default: WebJamApps/web-jam-tools)");
    console.error("  --title <title>        (required)");
    console.error("  --body-file <file>     (required)");
    console.error("  --type <type>          (default: Task)");
    console.error("  --label <label>        (or --labels <l1,l2>)");
    console.error("  --milestone <name>");
    console.error("  --priority <Urgent|High|Medium|Low>");
    console.error("  --parent <issue_num>");
    Deno.exit(1);
  }

  try {
    const result = await createIssueAndVerify(options);
    console.log(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: ${msg}`);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
