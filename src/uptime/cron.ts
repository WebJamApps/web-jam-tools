import {
  runAllChecks as defaultRunAllChecks,
  sendAlertEmail as defaultSendAlertEmail,
  sendHeartbeatEmail as defaultSendHeartbeatEmail,
} from "./monitor.ts";
import type { CheckResult } from "./monitor.ts";
import { runBackupCheck as defaultRunBackupCheck } from "./backup_check.ts";
import type { BackupCheckResult } from "./backup_check.ts";

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
  sendHeartbeatEmailFn = (results: CheckResult[], backupSummary: string) =>
    defaultSendHeartbeatEmail(results, undefined, undefined, backupSummary),
  runBackupCheckFn = defaultRunBackupCheck,
): Promise<void> {
  console.log(`[${new Date().toISOString()}] Running daily 12:00 UTC uptime heartbeat check...`);
  const [results, backup] = await Promise.all([
    runAllChecksFn(),
    runBackupCheckFn().catch((err: unknown) => {
      console.error(
        `[${new Date().toISOString()}] Backup warning email failed to send: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      if (err && typeof err === "object" && "backupResult" in err) {
        return (err as { backupResult: BackupCheckResult }).backupResult;
      }
      return undefined;
    }),
  ]);
  console.log(`[${new Date().toISOString()}] Dispatching daily heartbeat status email...`);
  await sendHeartbeatEmailFn(results, backup?.summary ?? "Backup: status check failed.");
}

export function registerCronJobs(
  register: (name: string, schedule: string, handler: () => Promise<void>) => void,
  jobs = {
    uptime: runCronCheck,
    daily: runDailyHeartbeatCheck,
    backup: async () => {
      await defaultRunBackupCheck();
    },
  },
): void {
  // Every 30 minutes: 24/7 failure monitoring check (silent on success, email on outage)
  register("WebJam Production Uptime Check", "*/30 * * * *", jobs.uptime);

  // Daily 8:00 AM EDT (12:00 UTC): Self-health heartbeat report email
  register("WebJam Production Daily Heartbeat", "0 12 * * *", jobs.daily);
  register("WebJam Production Midnight Backup Check", "0 0 * * *", jobs.backup);
}

// Native Deno Deploy 24/7 cron triggers
if (typeof Deno !== "undefined" && typeof Deno.cron === "function") {
  registerCronJobs(Deno.cron);
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const viewA = new Uint8Array(digestA);
  const viewB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < viewA.length; i++) {
    diff |= viewA[i] ^ viewB[i];
  }
  return diff === 0;
}

export async function handleHttpReq(
  req: Request,
  runDailyHeartbeatFn = runDailyHeartbeatCheck,
  runCronCheckFn = runCronCheck,
): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/test-heartbeat" || url.pathname === "/test-check") {
    const testKeySetting = Deno.env.get("UPTIME_TEST_KEY");
    const reqKey = req.headers.get("x-test-key");

    if (!testKeySetting || !reqKey || !(await timingSafeEqual(reqKey, testKeySetting))) {
      return new Response("Not Found", { status: 404 });
    }

    if (url.pathname === "/test-heartbeat") {
      try {
        await runDailyHeartbeatFn();
        return new Response("Heartbeat email dispatched successfully!", { status: 200 });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(`Heartbeat email failed: ${msg}`, { status: 500 });
      }
    }

    if (url.pathname === "/test-check") {
      try {
        await runCronCheckFn();
        return new Response("Uptime check completed successfully!", { status: 200 });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(`Uptime check failed: ${msg}`, { status: 500 });
      }
    }
  }

  return new Response("WebJam Uptime Monitor active 24/7");
}

if (import.meta.main && typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve((req) => handleHttpReq(req));
}
