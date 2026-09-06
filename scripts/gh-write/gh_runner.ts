/**
 * scripts/gh-write/gh_runner.ts — web-jam-tools#685
 *
 * The transient-failure retry wrapper shared by all four guarded CLIs.
 * Origin: two consecutive `i/o timeout` failures posting a review to
 * `https://api.github.com/graphql` on 2026-08-20 each cost a separate
 * orchestrating-session round trip; a third identical invocation succeeded.
 * A transient failure is retried rather than surfaced on the first attempt
 * (§4 of the design document).
 */

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCmd = (cmd: string[]) => Promise<CmdResult>;

const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  /i\/o timeout/i,
  /timeout/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /connection reset/i,
  /temporary failure/i,
  /EOF/i,
];

/** True when `stderr` names a condition that is ordinary and transient, not a real refusal. */
export function isTransientError(stderr: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some((re) => re.test(stderr));
}

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** Delay between attempts in ms. Default 500. Tests inject `sleep` to skip real waiting. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RetryResult extends CmdResult {
  attempts: number;
}

/**
 * Runs `run`, retrying only when the failure looks transient
 * (`isTransientError`). A non-transient failure (a real refusal) surfaces on
 * the first attempt — retrying it would just repeat the same rejection.
 */
export async function runWithRetry(
  run: RunCmd,
  cmd: string[],
  opts: RetryOptions = {},
): Promise<RetryResult> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let last: CmdResult = { code: 1, stdout: "", stderr: "" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await run(cmd);
    if (last.code === 0 || !isTransientError(last.stderr)) {
      return { ...last, attempts: attempt };
    }
    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }
  return { ...last, attempts };
}
