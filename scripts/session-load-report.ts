#!/usr/bin/env -S deno run --allow-read --allow-env
// scripts/session-load-report.ts
// SessionStart hook: reports every session-load part's size against limits (web-jam-tools#1234).
// Emits a single JSON line with a systemMessage for Claude Code tab 1. Always exits 0.

import { generateSessionLoadReport } from "../src/session-load/report.ts";

try {
  const report = await generateSessionLoadReport();
  console.log(JSON.stringify({ systemMessage: report }));
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
