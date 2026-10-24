/**
 * src/github-token/check_expiry.ts — web-jam-tools#1534
 *
 * Reads GitHub token expiry date from GitHub-Authentication-Token-Expiration header
 * on an API call, and warns from 14 days before that date.
 *
 * Design reference:
 *   ~/Dropbox/web-jam-llms/Access_Controls/github-token-exposure-design.md
 *   ("The replacement token").
 */

export const RUNBOOK_PATH =
  "~/Dropbox/web-jam-llms/Access_Controls/github-token-swap-manual-steps-2026-10-24.md";
export const EXPIRY_HEADER_NAME = "github-authentication-token-expiration";
export const WARNING_THRESHOLD_DAYS = 14;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface TokenExpiryEvaluation {
  hasExpiry: boolean;
  expiryDateStr?: string;
  expiryDate?: Date;
  diffMs?: number;
  daysRemaining?: number;
  isExpired?: boolean;
  isWarning: boolean;
  message?: string;
}

export function parseExpiryHeader(headersText: string): string | null {
  const lines = headersText.split(/\r?\n/);
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    if (key === EXPIRY_HEADER_NAME) {
      return line.slice(colonIdx + 1).trim();
    }
  }
  return null;
}

export function evaluateExpiry(
  expiryStr: string | null,
  now: Date = new Date(),
): TokenExpiryEvaluation {
  if (!expiryStr) {
    return { hasExpiry: false, isWarning: false };
  }

  // GitHub returns format like "YYYY-MM-DD HH:MM:SS UTC" or ISO string
  const expiryDate = new Date(expiryStr);
  if (isNaN(expiryDate.getTime())) {
    return {
      hasExpiry: true,
      expiryDateStr: expiryStr,
      isWarning: true,
      message:
        `warning: unparseable GitHub token expiration date '${expiryStr}'. Token swap runbook: ${RUNBOOK_PATH}`,
    };
  }

  const diffMs = expiryDate.getTime() - now.getTime();
  const daysRemaining = Math.ceil(diffMs / MS_PER_DAY);
  const isExpired = diffMs <= 0;
  const isWarning = diffMs <= WARNING_THRESHOLD_DAYS * MS_PER_DAY;

  let message: string | undefined;
  if (isWarning) {
    if (isExpired) {
      message =
        `warning: GitHub token expired on ${expiryStr}. Follow the token swap runbook at ${RUNBOOK_PATH}`;
    } else {
      message = `warning: GitHub token expires on ${expiryStr} (${daysRemaining} day${
        daysRemaining === 1 ? "" : "s"
      } remaining). Follow the token swap runbook at ${RUNBOOK_PATH}`;
    }
  }

  return {
    hasExpiry: true,
    expiryDateStr: expiryStr,
    expiryDate,
    diffMs,
    daysRemaining,
    isExpired,
    isWarning,
    message,
  };
}

export interface CheckOptions {
  headersText?: string;
  mockFailure?: boolean;
  now?: Date;
  runCmd?: () => Promise<{ code: number; stdout: string; stderr: string }>;
  warn?: (msg: string) => void;
}

export async function checkTokenExpiry(options: CheckOptions = {}): Promise<{
  status: "ok" | "warning" | "error";
  message?: string;
  evaluation?: TokenExpiryEvaluation;
}> {
  const warn = options.warn ?? ((msg: string) => console.error(msg));
  const now = options.now ??
    (Deno.env.get("GITHUB_TOKEN_EXPIRY_NOW")
      ? new Date(Deno.env.get("GITHUB_TOKEN_EXPIRY_NOW")!)
      : new Date());

  const mockFailure = options.mockFailure ??
    Boolean(Deno.env.get("GITHUB_TOKEN_EXPIRY_MOCK_FAILURE"));
  let headersText = options.headersText ??
    Deno.env.get("GITHUB_TOKEN_EXPIRY_TEST_HEADERS");

  if (mockFailure) {
    const message =
      `warning: could not check GitHub token expiry (gh api call failed). Token swap runbook: ${RUNBOOK_PATH}`;
    warn(message);
    return { status: "error", message };
  }

  if (headersText === undefined) {
    try {
      const runner = options.runCmd ?? (async () => {
        const cmd = new Deno.Command("gh", {
          args: ["api", "user", "-i", "--silent"],
          stdout: "piped",
          stderr: "piped",
        });
        const out = await cmd.output();
        return {
          code: out.code,
          stdout: new TextDecoder().decode(out.stdout),
          stderr: new TextDecoder().decode(out.stderr),
        };
      });

      const res = await runner();
      if (res.code !== 0) {
        const message =
          `warning: could not check GitHub token expiry (gh api call failed). Token swap runbook: ${RUNBOOK_PATH}`;
        warn(message);
        return { status: "error", message };
      }
      headersText = res.stdout;
    } catch {
      const message =
        `warning: could not check GitHub token expiry (gh execution error). Token swap runbook: ${RUNBOOK_PATH}`;
      warn(message);
      return { status: "error", message };
    }
  }

  const headerVal = parseExpiryHeader(headersText);
  const evaluation = evaluateExpiry(headerVal, now);

  if (evaluation.isWarning && evaluation.message) {
    warn(evaluation.message);
    return { status: "warning", message: evaluation.message, evaluation };
  }

  return { status: "ok", evaluation };
}

if (import.meta.main) {
  // Always exit 0 so agents startup is never blocked
  await checkTokenExpiry();
}
