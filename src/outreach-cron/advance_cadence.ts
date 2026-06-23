// Outreach cadence cron (gig-outreach: web-jam-back#824/#825, web-jam-tools#100).
//
// Drives the follow-up cadence without a paid Heroku Scheduler: a free Deno Cron
// (Deno Deploy) POSTs web-jam-back's `/outreach/advance` endpoint, which actions
// every due touch — EMAIL follow-ups go out via the mailer, CALL touches drop an
// all-day call-task on Josh's Google Calendar (#825) — and parks exhausted
// sequences. The endpoint is idempotent per tick: it only touches records whose
// `nextTouchDue <= now`, so an extra run is a cheap no-op.
//
// Auth: forwards the shared `web-jam-llm` AI-agent bearer token (env
// WEB_JAM_LLM_TOKEN); web-jam-back enforces the `outreach:edit` capability. The
// token is a Deno Deploy env secret — Deno Deploy has no persistent filesystem,
// so it can't read the local token file the way the laptop tools do.
//
// Schedule: once daily at 09:00 America/New_York. The cadence is day-grained
// (touch offsets are whole days), so daily is sufficient — and it keeps
// follow-up emails landing at a civil morning hour rather than overnight. (The
// #824 design floated "hourly"; that was for fast reply-detection, which is the
// deferred gmail.metadata half of #825. Switch the cron lines below to hourly if
// that lands and wants it.)
//
// Run locally (single advance, e.g. for testing): deno task outreach:advance,
// with WEB_JAM_LLM_TOKEN set (and optionally WEB_JAM_BACK_URL).

const DEFAULT_BACKEND = "https://webjamsalem.herokuapp.com";

export interface BackendConfig {
  baseUrl: string;
  token: string;
}

export function backendConfig(): BackendConfig {
  // Trailing slash trimmed so `${baseUrl}/outreach/advance` never doubles up.
  const baseUrl = (Deno.env.get("WEB_JAM_BACK_URL") || DEFAULT_BACKEND).replace(/\/+$/, "");
  const token = Deno.env.get("WEB_JAM_LLM_TOKEN");
  if (!token) {
    throw new Error("Missing WEB_JAM_LLM_TOKEN (the web-jam-llm AI-agent bearer token)");
  }
  return { baseUrl, token };
}

// The advance endpoint's tick summary (web-jam-back OutreachController.advanceCadence).
export interface AdvanceResult {
  processed: number;
  sent: number;
  called: number;
  parked: number;
  skipped: number;
}

export async function triggerAdvance(): Promise<AdvanceResult> {
  const { baseUrl, token } = backendConfig();
  const resp = await fetch(`${baseUrl}/outreach/advance`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!resp.ok) throw new Error(`outreach advance: ${resp.status} ${await resp.text()}`);
  return (await resp.json()) as AdvanceResult;
}

export async function main(): Promise<number> {
  const result = await triggerAdvance();
  console.error(`[outreach-cron] advance: ${JSON.stringify(result)}`);
  return 0;
}

// Deno Deploy runs Deno.cron schedules in UTC (no timezone support), so to land
// on 09:00 America/New_York year-round we register both candidate UTC hours —
// 13:00 (09:00 EDT) and 14:00 (09:00 EST) — and only actually run when it is in
// fact 09:00 Eastern. The off-season hour is a cheap no-op; there is never a
// double run. (Same trick as the daily devotional, web-jam-tools#69.)
export function easternHour(now: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hour12: false,
    }).format(now),
  );
}

export async function runAtNineEastern(now: Date = new Date()): Promise<void> {
  if (easternHour(now) !== 9) return;
  const result = await triggerAdvance();
  console.error(`[outreach-cron] advance: ${JSON.stringify(result)}`);
}

if (import.meta.main) {
  if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
    // On Deno Deploy: register the schedule and let the runtime invoke it. Cron
    // NAMES may contain only alphanumerics, whitespace, hyphens, and underscores
    // — no parens/colons, or the revision fails "Invalid cron name" (#69).
    Deno.cron("outreach cadence advance 0900 EDT", "0 13 * * *", runAtNineEastern);
    Deno.cron("outreach cadence advance 0900 EST", "0 14 * * *", runAtNineEastern);
    // Deno Deploy provisions an HTTP route per revision; serve a trivial response
    // so the isolate stays addressable (cron itself needs no server).
    Deno.serve(() => new Response("outreach cadence cron service: alive\n"));
  } else {
    // Local / manual run (deno task outreach:advance): advance once, now.
    try {
      Deno.exit(await main());
    } catch (err) {
      console.error(err);
      Deno.exit(1);
    }
  }
}
