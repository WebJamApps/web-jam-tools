// scripts/venue-tag-backfill.ts
// CLI script backing `deno task venue-tag:backfill-types` (web-jam-tools#1126, D-79).

import { runBackfillCli } from "../src/venue-tag/backfill.ts";

if (import.meta.main) {
  const code = await runBackfillCli(Deno.args);
  Deno.exit(code);
}
