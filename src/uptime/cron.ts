import { runAllChecks, sendAlertEmail } from "./monitor.ts";

export async function runCronCheck(): Promise<void> {
  console.log(`[${new Date().toISOString()}] Running Deno Deploy uptime check...`);
  const results = await runAllChecks();
  const failures = results.filter((r) => !r.success);

  if (failures.length > 0) {
    console.error(
      `[${new Date().toISOString()}] Uptime check failed: ${failures.length} targets down.`,
    );
    await sendAlertEmail(failures);
  } else {
    console.log(`[${new Date().toISOString()}] All ${results.length} targets healthy.`);
  }
}

// Native Deno Deploy 24/7 cron trigger (runs every 30 minutes)
if (typeof Deno !== "undefined" && typeof Deno.cron === "function") {
  Deno.cron("WebJam Production Uptime Check", "*/30 * * * *", async () => {
    await runCronCheck();
  });
}
