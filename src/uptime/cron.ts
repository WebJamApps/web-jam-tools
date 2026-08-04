import {
  runAllChecks as defaultRunAllChecks,
  sendAlertEmail as defaultSendAlertEmail,
  sendHeartbeatEmail as defaultSendHeartbeatEmail,
} from "./monitor.ts";

export async function runCronCheck(
  runAllChecksFn = defaultRunAllChecks,
  sendAlertEmailFn = defaultSendAlertEmail,
): Promise<void> {
  console.log(`[${new Date().toISOString()}] Running Deno Deploy uptime check...`);
  const results = await runAllChecksFn();
  const failures = results.filter((r) => !r.success);

  if (failures.length > 0) {
    console.error(
      `[${new Date().toISOString()}] Uptime check failed: ${failures.length} targets down.`,
    );
    await sendAlertEmailFn(failures);
  } else {
    console.log(`[${new Date().toISOString()}] All ${results.length} targets healthy.`);
  }
}

export async function runDailyHeartbeatCheck(
  runAllChecksFn = defaultRunAllChecks,
  sendHeartbeatEmailFn = defaultSendHeartbeatEmail,
): Promise<void> {
  console.log(`[${new Date().toISOString()}] Running Daily 8:00 AM Uptime Heartbeat check...`);
  const results = await runAllChecksFn();
  console.log(`[${new Date().toISOString()}] Dispatching daily heartbeat status email...`);
  await sendHeartbeatEmailFn(results);
}

// Native Deno Deploy 24/7 cron triggers
if (typeof Deno !== "undefined" && typeof Deno.cron === "function") {
  // Every 30 minutes: 24/7 failure monitoring check (silent on success, email on outage)
  Deno.cron("WebJam Production Uptime Check", "*/30 * * * *", async () => {
    await runCronCheck();
  });

  // Daily 8:00 AM EDT (12:00 UTC): Self-health heartbeat report email
  Deno.cron("WebJam Production Daily Heartbeat", "0 12 * * *", async () => {
    await runDailyHeartbeatCheck();
  });
}

if (import.meta.main && typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve((_req) => new Response("WebJam Uptime Monitor active 24/7"));
}
