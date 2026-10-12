import { sendEmail } from "../shared/gmail_send.ts";

export interface UptimeCheckConfig {
  name: string;
  url: string;
  expectedStatus?: number[];
  contentKeywords?: string[];
}

export interface CheckResult {
  config: UptimeCheckConfig;
  success: boolean;
  status?: number;
  error?: string;
}

export const DEFAULT_TARGETS: UptimeCheckConfig[] = [
  {
    name: "Josh & Maria Music",
    url: "https://joshandmariamusic.com",
    expectedStatus: [200],
  },
  {
    name: "Josh & Maria Music (www)",
    url: "https://www.joshandmariamusic.com",
    expectedStatus: [200, 301, 302, 307, 308],
  },
  {
    name: "Web Jam",
    url: "https://web-jam.com",
    expectedStatus: [200],
  },
  {
    name: "Web Jam Music",
    url: "https://web-jam.com/music",
    expectedStatus: [200],
    contentKeywords: ["music"],
  },
  {
    name: "College Lutheran",
    url: "https://collegelutheran.org",
    expectedStatus: [200],
  },
];

export async function runCheck(
  target: UptimeCheckConfig,
  fetchFn: typeof fetch = fetch,
): Promise<CheckResult> {
  const expected = target.expectedStatus ?? [200];
  try {
    const resp = await fetchFn(target.url, { redirect: "follow" });

    if (!expected.includes(resp.status)) {
      return {
        config: target,
        success: false,
        status: resp.status,
        error: `Expected status [${expected.join(", ")}], got ${resp.status}`,
      };
    }

    if (target.contentKeywords && target.contentKeywords.length > 0) {
      const text = await resp.text();
      const lowerText = text.toLowerCase();
      const missingKeywords: string[] = [];

      for (const keyword of target.contentKeywords) {
        if (!lowerText.includes(keyword.toLowerCase())) {
          missingKeywords.push(keyword);
        }
      }

      if (missingKeywords.length > 0) {
        return {
          config: target,
          success: false,
          status: resp.status,
          error: `Missing required content element(s): ${missingKeywords.join(", ")}`,
        };
      }
    }

    return {
      config: target,
      success: true,
      status: resp.status,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      config: target,
      success: false,
      error: `Fetch error: ${errorMsg}`,
    };
  }
}

export async function runAllChecks(
  targets: UptimeCheckConfig[] = DEFAULT_TARGETS,
  fetchFn: typeof fetch = fetch,
): Promise<CheckResult[]> {
  return await Promise.all(targets.map((target) => runCheck(target, fetchFn)));
}

export function formatAlertEmail(failedResults: CheckResult[]): {
  subject: string;
  text: string;
  html: string;
} {
  const count = failedResults.length;
  const subject = `[Uptime Alert] Production Service Failure (${count} check${
    count > 1 ? "s" : ""
  } failed)`;

  const lines = failedResults.map((r) => {
    const statusStr = r.status !== undefined ? ` (Status: ${r.status})` : "";
    return `- ${r.config.name} (${r.config.url})${statusStr}\n  Error: ${
      r.error ?? "Unknown error"
    }`;
  });

  const text = `Uptime Monitoring Alert\n\nThe following check(s) failed:\n\n${
    lines.join("\n\n")
  }\n\nTimestamp: ${new Date().toISOString()}`;

  const htmlList = failedResults
    .map(
      (r) =>
        `<li><strong>${r.config.name}</strong> (<a href="${r.config.url}">${r.config.url}</a>)${
          r.status !== undefined ? ` [Status: ${r.status}]` : ""
        }<br/>Error: <code>${r.error ?? "Unknown error"}</code></li>`,
    )
    .join("");

  const html =
    `<h2>Uptime Monitoring Alert</h2><p>The following check(s) failed:</p><ul>${htmlList}</ul><p><small>Timestamp: ${
      new Date().toISOString()
    }</small></p>`;

  return { subject, text, html };
}

export function formatHeartbeatEmail(results: CheckResult[]): {
  subject: string;
  text: string;
  html: string;
} {
  const failures = results.filter((r) => !r.success);
  const isHealthy = failures.length === 0;

  const subject = isHealthy
    ? `[Uptime Monitor] Daily Heartbeat: All ${results.length} Production Services Healthy`
    : `[Uptime Monitor] Daily Heartbeat: ${failures.length} Issue(s) Detected`;

  const lines = results.map((r) => {
    const statusStr = r.status !== undefined ? ` [${r.status}]` : "";
    const icon = r.success ? "✓ OK" : "✗ FAIL";
    const errorStr = r.error ? ` - Error: ${r.error}` : "";
    return `${icon} ${r.config.name} (${r.config.url})${statusStr}${errorStr}`;
  });

  const text = `Uptime Monitoring Daily Heartbeat\n\nStatus Summary:\n${
    lines.join("\n")
  }\n\nTimestamp: ${new Date().toISOString()}`;

  const htmlList = results
    .map((r) => {
      const color = r.success ? "green" : "red";
      const icon = r.success ? "✓" : "✗";
      const statusStr = r.status !== undefined ? ` [Status: ${r.status}]` : "";
      const errorStr = r.error ? `<br/><small>Error: <code>${r.error}</code></small>` : "";
      return `<li style="color: ${color};"><strong>${icon} ${r.config.name}</strong> (<a href="${r.config.url}">${r.config.url}</a>)${statusStr}${errorStr}</li>`;
    })
    .join("");

  const html =
    `<h2>Uptime Monitoring Daily Heartbeat</h2><p>All monitored production resources are active:</p><ul>${htmlList}</ul><p><small>Timestamp: ${
      new Date().toISOString()
    }</small></p>`;

  return { subject, text, html };
}

export const DEFAULT_ALERT_RECIPIENTS = [
  "joshua.v.sherman@gmail.com",
  "chemmariasherman@gmail.com",
];

export async function sendAlertEmail(
  failedResults: CheckResult[],
  recipientsOrFetch: string[] | typeof fetch = DEFAULT_ALERT_RECIPIENTS,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  let recipients = DEFAULT_ALERT_RECIPIENTS;
  let customFetch = fetchFn;
  if (typeof recipientsOrFetch === "function") {
    customFetch = recipientsOrFetch;
  } else if (Array.isArray(recipientsOrFetch)) {
    recipients = recipientsOrFetch;
  }
  const { subject, html } = formatAlertEmail(failedResults);
  return await sendEmail(recipients, subject, html, customFetch);
}

export async function sendHeartbeatEmail(
  results: CheckResult[],
  recipientsOrFetch: string[] | typeof fetch = DEFAULT_ALERT_RECIPIENTS,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  let recipients = DEFAULT_ALERT_RECIPIENTS;
  let customFetch = fetchFn;
  if (typeof recipientsOrFetch === "function") {
    customFetch = recipientsOrFetch;
  } else if (Array.isArray(recipientsOrFetch)) {
    recipients = recipientsOrFetch;
  }
  const { subject, html } = formatHeartbeatEmail(results);
  return await sendEmail(recipients, subject, html, customFetch);
}
