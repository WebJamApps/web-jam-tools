// src/health-tracker/main.ts
// Entry point for health-report task (web-jam-tools#1660).

import { runHealthReport } from "./report.ts";

if (import.meta.main) {
  const code = await runHealthReport();
  Deno.exit(code);
}
