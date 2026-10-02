/**
 * scripts/gh-write/guard.ts — web-jam-tools#685
 *
 * The form guards shared by all four `deno task` GitHub-write CLIs
 * (post-pr-review, post-pr-comment, post-issue-comment, edit-issue). Per the
 * design's boundary (§4 of
 * ~/Dropbox/web-jam-llms/Token_Savings/pr-review-self-posting-design-2026-08-22.md):
 * these guards check that a body is well-formed and safe to publish. They
 * never check whether its findings are correct — that stays the reviewing
 * model's job, never the transport's.
 */
import { findCredentialLiteral } from "../../hooks/lib/detect_credential_literal.ts";

export const REVIEW_SUMMARY_HEADER = "## PR Review Summary";

export interface GuardResult {
  ok: boolean;
  error?: string;
}

/** Refuses an empty body — an empty write is never intentional. */
export function checkNotEmpty(body: string): GuardResult {
  if (body.trim().length === 0) {
    return { ok: false, error: "refusing to post: body is empty" };
  }
  return { ok: true };
}

/**
 * Refuses a body carrying a credential-shaped literal — the guard is the
 * last checkpoint before the text is made public.
 */
export function checkNoCredentialLiteral(body: string): GuardResult {
  const match = findCredentialLiteral(body);
  if (match) {
    return {
      ok: false,
      error: `refusing to post: body contains a credential-shaped literal (${match}) — ` +
        "the guard is the last checkpoint before this text is public",
    };
  }
  return { ok: true };
}

/**
 * Refuses a review body with no "## PR Review Summary" header — a malformed
 * review is a failed run, not a post. Binds the review verb only (§4).
 */
export function checkReviewSummaryHeader(body: string): GuardResult {
  if (!body.includes(REVIEW_SUMMARY_HEADER)) {
    return {
      ok: false,
      error: `refusing to post: review body is missing the "${REVIEW_SUMMARY_HEADER}" ` +
        "header — a malformed review is a failed run, not a post",
    };
  }
  return { ok: true };
}

/**
 * A reviewer line stands alone on its own line: "🤖 Reviewed by <tool> — <model>",
 * with an em dash and one space on each side, and a non-empty tool and model.
 * web-jam-tools#1193.
 */
const REVIEWER_LINE = /^🤖 Reviewed by (\S.*?) — (\S.*?)\s*$/u;

/**
 * Checks whether a tool or model string is invalid: empty, an angle-bracket
 * placeholder (e.g. "<tool>" or "<model>"), or consisting solely of dash punctuation.
 */
function isInvalidToolOrModel(val: string): boolean {
  const trimmed = val.trim();
  if (!trimmed) return true;
  if (/^<.*>$/.test(trimmed)) return true;
  if (/^[\s\p{Pd}]+$/u.test(trimmed)) return true;
  return false;
}

/**
 * Refuses a review body with no well-formed "🤖 Reviewed by <tool> — <model>"
 * line, so a posted review always says which agent and model wrote it. A
 * pure function of the body text: it has no way to fail on its own, so there
 * is no "cannot be determined" outcome. It checks the line is present and
 * well-formed on the last non-empty line — never that the named model is the
 * one really running.
 */
export function checkReviewerLine(body: string): GuardResult {
  const lines = body.trimEnd().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? "";
  const match = lastLine.match(REVIEWER_LINE);
  if (!match) {
    return {
      ok: false,
      error:
        'refusing to post: review body is missing the "🤖 Reviewed by <tool> — <model>" line — ' +
        "the reviewing model must name itself (the agent tool and the model actually running the review) on the last line.",
    };
  }
  const [, tool, model] = match;
  if (isInvalidToolOrModel(tool) || isInvalidToolOrModel(model)) {
    return {
      ok: false,
      error:
        'refusing to post: review body is missing the "🤖 Reviewed by <tool> — <model>" line — ' +
        "the reviewing model must name itself (the agent tool and the model actually running the review) on the last line.",
    };
  }
  return { ok: true };
}

export interface FormGuardOptions {
  /** Only true for the review verb — the header check binds it alone. */
  requireReviewHeader?: boolean;
  /** True for the review verb and for a comment carrying the review header. */
  requireReviewerLine?: boolean;
}

/** Runs the guards that bind every verb, then any verb-specific ones. */
export function runFormGuards(body: string, opts: FormGuardOptions = {}): GuardResult {
  const notEmpty = checkNotEmpty(body);
  if (!notEmpty.ok) return notEmpty;

  const noCredential = checkNoCredentialLiteral(body);
  if (!noCredential.ok) return noCredential;

  if (opts.requireReviewHeader) {
    const hasHeader = checkReviewSummaryHeader(body);
    if (!hasHeader.ok) return hasHeader;
  }

  if (opts.requireReviewerLine) {
    const hasReviewer = checkReviewerLine(body);
    if (!hasReviewer.ok) return hasReviewer;
  }

  return { ok: true };
}

export interface RunCmd {
  (cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface AlreadyReviewedResult {
  skip: boolean;
  reason?: string;
  /**
   * True when a caller-supplied `--head-sha` was checked against the PR's
   * live head and the two disagree — the review was composed against a
   * commit the branch has since moved past (e.g. a force-push mid-review).
   * `skip` is always false alongside `stale: true`: this is a refusal, not
   * a silent no-op — the caller must exit non-zero and post nothing.
   */
  stale?: boolean;
}

/**
 * A PR that already carries an automated review at the current head SHA is
 * SKIPPED, not double-posted — re-running a dispatch must not double-post
 * (§4). Mirrors the "Already-Reviewed Check" in skills/pr-review/SKILL.md
 * Step 1, so the guard and the skill agree on what counts as "already
 * reviewed".
 *
 * When `callerHeadSha` is supplied (the head SHA the caller's findings were
 * actually derived from — web-jam-tools#825), it is checked against the
 * PR's live head SHA first, ahead of the already-reviewed comparison. GitHub
 * stamps a posted review with whatever head is current *at post time*, not
 * the head the findings were composed against — so a force-push landing
 * between composing the review and posting it can make a stale review look
 * current, silently occupying the already-reviewed slot and blocking the
 * corrected re-review. A SHA mismatch here is refused outright rather than
 * posted: refusing is recoverable (re-run the review against the new head),
 * posting a review stamped onto the wrong commit is not. Omitting
 * `callerHeadSha` leaves this check out entirely — behaviour is then
 * byte-identical to before web-jam-tools#825.
 *
 * Fails OPEN (never skips, never refuses) when the check itself is
 * inconclusive — an ambiguous state must never silently swallow a real
 * review post.
 */
export async function isAlreadyReviewedAtHeadSha(
  repo: string,
  prNumber: number,
  runCmd: RunCmd,
  callerHeadSha?: string,
): Promise<AlreadyReviewedResult> {
  const { code, stdout } = await runCmd([
    "gh",
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "reviews,commits",
    "--jq",
    '{last_review_sha: (.reviews | map(select((.body // "") | test("(?i)## PR Review Summary"))) | last | .commit.oid), head_sha: (.commits | last | .oid)}',
  ]);

  if (code !== 0) {
    return { skip: false };
  }

  try {
    const parsed = JSON.parse(stdout);
    const headSha = typeof parsed.head_sha === "string" ? parsed.head_sha : undefined;

    if (callerHeadSha && headSha && callerHeadSha !== headSha) {
      return {
        skip: false,
        stale: true,
        reason: `refusing to post: review was composed against head SHA ${callerHeadSha}, ` +
          `but the PR's current head is ${headSha} — the branch moved (e.g. a force-push) ` +
          "since the review was written. Re-run the review against the new head and post again.",
      };
    }

    if (
      typeof parsed.last_review_sha === "string" &&
      headSha !== undefined &&
      parsed.last_review_sha === headSha
    ) {
      return { skip: true, reason: `already reviewed at head SHA ${headSha}` };
    }
  } catch {
    // Unparseable — inconclusive, do not block the post.
  }

  return { skip: false };
}
