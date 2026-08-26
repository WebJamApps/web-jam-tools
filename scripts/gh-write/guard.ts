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

export interface FormGuardOptions {
  /** Only true for the review verb — the header check binds it alone. */
  requireReviewHeader?: boolean;
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

  return { ok: true };
}

export interface RunCmd {
  (cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface AlreadyReviewedResult {
  skip: boolean;
  reason?: string;
}

/**
 * A PR that already carries an automated review at the current head SHA is
 * SKIPPED, not double-posted — re-running a dispatch must not double-post
 * (§4). Mirrors the "Already-Reviewed Check" in skills/pr-review/SKILL.md
 * Step 1, so the guard and the skill agree on what counts as "already
 * reviewed".
 *
 * Fails OPEN (never skips) when the check itself is inconclusive — an
 * ambiguous state must never silently swallow a real review post.
 */
export async function isAlreadyReviewedAtHeadSha(
  repo: string,
  prNumber: number,
  runCmd: RunCmd,
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
    if (
      typeof parsed.last_review_sha === "string" &&
      typeof parsed.head_sha === "string" &&
      parsed.last_review_sha === parsed.head_sha
    ) {
      return { skip: true, reason: `already reviewed at head SHA ${parsed.head_sha}` };
    }
  } catch {
    // Unparseable — inconclusive, do not block the post.
  }

  return { skip: false };
}
