#!/usr/bin/env -S deno run --allow-read --allow-env --allow-run=git,timeout
// scripts/session-load-report.ts
// SessionStart hook: reports every session-load part's size against limits (web-jam-tools#1234).
// Emits a single JSON line with a systemMessage for Claude Code tab 1. Always exits 0.
// Appends a stuck-snap-updates line when there is one.

import { generateSessionLoadReport } from "../src/session-load/report.ts";
import { stuckSnapsNotice } from "../src/snap-updates/check_updates.ts";

try {
  const report = await generateSessionLoadReport();
  const snapNotice = await stuckSnapsNotice().catch(() => null);
  console.log(JSON.stringify({ systemMessage: snapNotice ? `${report}\n${snapNotice}` : report }));
} catch (err) {
  // If anything unexpected happens, never crash session start.
  const fallback = err instanceof Error ? err.message : String(err);
  console.log(
    JSON.stringify({
      systemMessage: `Session load report error: ${fallback}`,
    }),
  );
}

Deno.exit(0);
