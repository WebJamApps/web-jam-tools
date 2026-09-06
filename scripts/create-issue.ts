#!/usr/bin/env deno run --allow-env --allow-run --allow-read --allow-write
/**
 * Standardized issue creation script (web-jam-tools#514)
 * Sets labels, milestone, native Priority, parent link, and blocked-by dependencies, and verifies all attributes stick.
 *
 * Gate 2 approval-token enforcement (web-jam-tools#747) lives inside
 * src/create-issue/lib.ts's createIssueAndVerify(), not here — it is the
 * ONLY enforcement point on agy/Antigravity, which runs this exact `deno
 * task create-issue` path and has no hook mechanism of its own.
 */
import { createIssueAndVerify, parseArgs } from "../src/create-issue/lib.ts";

async function main() {
  const options = parseArgs(Deno.args);
  if (!options.title || !options.bodyFile) {
    console.error('Usage: deno task create-issue --title "..." --body-file <path> [options]');
    console.error("Options:");
    console.error("  --repo <repo>          (default: WebJamApps/web-jam-tools)");
    console.error("  --title <title>        (required)");
    console.error("  --body-file <file>     (required)");
    console.error("  --type <type>          (default: Task)");
    console.error("  --label <label>        (or --labels <l1,l2>)");
    console.error("  --milestone <name>");
    console.error("  --priority <Urgent|High|Medium|Low>");
    console.error("  --parent <issue_num>");
    console.error("  --blocked-by <issue>   (repeatable, e.g. 123, #123, repo#123)");
    console.error("  --escalation-reason <why>");
    console.error("  --dedup-override <repo#number>       (candidate considered, for the record)");
    console.error(
      "  --dedup-override-reason <why>        (required to clear a duplicate-search deny)",
    );
    console.error("  --dry-run");
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
