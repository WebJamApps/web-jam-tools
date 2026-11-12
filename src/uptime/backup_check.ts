import { sendEmail } from "../shared/gmail_send.ts";
import { DEFAULT_ALERT_RECIPIENTS, PRODUCTION_BACKEND_URL } from "./monitor.ts";

export type BackupCheckResult =
  | { state: "healthy" | "stale"; ageHours: number; summary: string }
  | { state: "none" | "unknown" | "unreachable"; summary: string };

const HOUR_MS = 60 * 60 * 1000;
const MAX_AGE_HOURS = 26;

export async function checkBackupStatus(
  fetchFn: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<BackupCheckResult> {
  let response: Response;
  try {
    response = await fetchFn(new URL("/backup/status", PRODUCTION_BACKEND_URL), {
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return {
      state: "unreachable",
      summary: "Backup: status address did not answer (request failed or timed out).",
    };
  }

  if (!response.ok) {
    // An unreadable error body must not suppress the warning about its HTTP status.
    await response.body?.cancel().catch(() => undefined);
    return {
      state: "unknown",
      summary: `Backup: backend cannot determine the newest good run (HTTP ${response.status}).`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { state: "unknown", summary: "Backup: cannot determine age (invalid status response)." };
  }
  const startedAt = body && typeof body === "object" && "newestGoodRun" in body
    ? body.newestGoodRun
    : undefined;
  if (startedAt === "none") {
    return { state: "none", summary: "Backup: no good run exists." };
  }
  const timestamp = typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(timestamp) || timestamp > nowMs) {
    return { state: "unknown", summary: "Backup: cannot determine age (invalid newest good run)." };
  }
  const ageHours = (nowMs - timestamp) / HOUR_MS;
  const stale = ageHours > MAX_AGE_HOURS;
  return {
    state: stale ? "stale" : "healthy",
    ageHours,
    summary: `Backup: newest good run is ${ageHours.toFixed(1)} hours old${
      stale ? " (more than 26 hours; overdue)" : ""
    }.`,
  };
}

export async function sendBackupWarning(
  result: BackupCheckResult,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  // Summary text contains only our fixed labels and validated numeric values.
  return await sendEmail(
    DEFAULT_ALERT_RECIPIENTS,
    "[Uptime Alert] MongoDB backup warning",
    `<h2>MongoDB backup warning</h2><p>${result.summary}</p>`,
    fetchFn,
  );
}

export async function runBackupCheck(
  fetchFn: typeof fetch = fetch,
  sendWarningFn = sendBackupWarning,
  nowMs = Date.now(),
): Promise<BackupCheckResult> {
  const result = await checkBackupStatus(fetchFn, nowMs);
  if (result.state !== "healthy") {
    try {
      await sendWarningFn(result);
    } catch (err) {
      if (err && typeof err === "object") {
        Object.assign(err, { backupResult: result });
      }
      throw err;
    }
  }
  return result;
}
