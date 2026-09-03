/**
 * Duplicate-search enforcement for issue creation (web-jam-tools#901).
 *
 * `skills/file-issue/SKILL.md` opens its "Before you file" list with a
 * duplicate search, but until this module existed nothing enforced it — an
 * agent that skipped the search was never stopped, only reminded in prose.
 * This module is shared by both enforcement points: the Claude Code
 * PreToolUse hook (`hooks/lib/check_model_label_on_issue_create.ts`) and the
 * agy/Antigravity fallback inside `src/create-issue/lib.ts`'s
 * `createIssueAndVerify()`, the same split already used for the Gate 2
 * approval-token check (`hooks/lib/check_issue_approval_token.ts`).
 *
 * Three outcomes (web-jam-tools#901, mirroring SKILL.md item 15's "a guard
 * has three outcomes, not two"):
 *   1. No similar OPEN issue found         -> "pass"
 *   2. One or more similar OPEN issues found -> "deny_duplicate"
 *   3. The search itself could not run     -> "deny_search_failed" (fails
 *      CLOSED — a dedup check that fails open protects nothing precisely
 *      when it is least noticed)
 * An explicit override (a non-empty reason) clears outcomes 2 and 3.
 *
 * Deliberately scoped to only run when a target repo AND a title with at
 * least DUPLICATE_MIN_SHARED_TOKENS significant words are both known — see
 * `classifyDuplicate()`. Below that token count, the similarity threshold
 * below can never be reached (intersection can't exceed the shorter side's
 * token count), so searching would only spend a network call for a result
 * that is mathematically guaranteed to be "no candidates."
 */

/** Small, deliberately short stopword list — issue titles are short technical strings, not prose. */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "for",
  "to",
  "of",
  "in",
  "on",
  "or",
  "is",
  "are",
  "this",
  "that",
  "with",
  "from",
  "by",
  "as",
  "be",
  "it",
  "its",
  "into",
]);

export interface OpenIssueSummary {
  number: number;
  title: string;
}

export interface DuplicateCandidate {
  number: number;
  title: string;
  similarity: number;
}

/** Jaccard similarity requires at least this many shared significant tokens to flag a candidate. */
export const DUPLICATE_MIN_SHARED_TOKENS = 3;

/** Jaccard similarity (token-set intersection / union) threshold to flag a candidate. */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.3;

/** Lowercase, alphanumeric-token, stopword-filtered, deduplicated tokenization of a title. */
export function tokenizeTitle(title: string): string[] {
  const raw = (title.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
    (w) => w.length > 1 && !STOPWORDS.has(w),
  );
  return Array.from(new Set(raw));
}

/** Jaccard similarity between two titles' token sets (0 when either has no significant tokens). */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(tokenizeTitle(a));
  const tb = new Set(tokenizeTitle(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Finds OPEN issues whose title is similar enough to `newTitle` to be a
 * plausible duplicate, sorted most-similar first. Pure — no network.
 */
export function findSimilarOpenIssues(
  newTitle: string,
  openIssues: OpenIssueSummary[],
): DuplicateCandidate[] {
  const ta = new Set(tokenizeTitle(newTitle));
  if (ta.size === 0) return [];
  const results: DuplicateCandidate[] = [];
  for (const issue of openIssues) {
    const tb = new Set(tokenizeTitle(issue.title));
    if (tb.size === 0) continue;
    let intersection = 0;
    for (const t of ta) if (tb.has(t)) intersection++;
    if (intersection < DUPLICATE_MIN_SHARED_TOKENS) continue;
    const union = ta.size + tb.size - intersection;
    const similarity = union === 0 ? 0 : intersection / union;
    if (similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
      results.push({ number: issue.number, title: issue.title, similarity });
    }
  }
  return results.sort((a, b) => b.similarity - a.similarity);
}

export interface DedupOverride {
  /** The candidate issue considered (e.g. "web-jam-tools#885"), for the record — not verified against search results. */
  candidate?: string | null;
  /** Why the filer judges this is not a duplicate. Non-empty reason is what actually clears the gate. */
  reason?: string | null;
}

export type DuplicateCheckResult =
  | { outcome: "skip" }
  | { outcome: "pass" }
  | { outcome: "deny_duplicate"; repoFull: string; candidates: DuplicateCandidate[] }
  | { outcome: "deny_search_failed"; repoFull: string };

function hasOverrideReason(override: DedupOverride | null | undefined): boolean {
  return !!(override?.reason && override.reason.trim());
}

/**
 * Pure decision function: given a (possibly null / already-fetched) open
 * issue list, decide the outcome. No network — the network fetch is a
 * separate, thin step (`fetchOpenIssueTitles`) so this stays unit-testable
 * without mocking a command runner.
 *
 * `openIssues === null` means the search was attempted and failed (network,
 * auth, rate limit, or an unparseable response) — distinct from `[]`, which
 * means the search succeeded and found no OPEN issues at all.
 */
export function classifyDuplicate(
  newTitle: string,
  repoFull: string | null | undefined,
  openIssues: OpenIssueSummary[] | null,
  override: DedupOverride | null = null,
): DuplicateCheckResult {
  if (!repoFull || !newTitle.trim()) return { outcome: "skip" };
  if (hasOverrideReason(override)) return { outcome: "pass" };
  if (tokenizeTitle(newTitle).length < DUPLICATE_MIN_SHARED_TOKENS) return { outcome: "skip" };
  if (openIssues === null) return { outcome: "deny_search_failed", repoFull };
  const candidates = findSimilarOpenIssues(newTitle, openIssues);
  if (candidates.length > 0) return { outcome: "deny_duplicate", repoFull, candidates };
  return { outcome: "pass" };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (args: string[]) => Promise<RunResult>;

/** Real runner: shells out to `gh` via `Deno.Command`. */
export const runGhCommand: CommandRunner = async (args: string[]) => {
  try {
    const cmd = new Deno.Command("gh", { args, stdout: "piped", stderr: "piped" });
    const { code, stdout, stderr } = await cmd.output();
    return {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  } catch (e) {
    return { code: 1, stdout: "", stderr: String(e) };
  }
};

/** Fetches OPEN issue titles for `repoFull`. Returns null (search failed) rather than throwing. */
export async function fetchOpenIssueTitles(
  repoFull: string,
  runner: CommandRunner = runGhCommand,
): Promise<OpenIssueSummary[] | null> {
  const res = await runner([
    "issue",
    "list",
    "--repo",
    repoFull,
    "--state",
    "open",
    "--json",
    "number,title",
    "--limit",
    "300",
  ]);
  if (res.code !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((x) => x && typeof x.number === "number" && typeof x.title === "string")
      .map((x) => ({ number: x.number, title: x.title }));
  } catch {
    return null;
  }
}

/**
 * Full async orchestration: skip / override short-circuit, else fetch OPEN
 * issues and classify. This is what both enforcement points call.
 */
export async function checkDuplicateTitle(
  newTitle: string,
  repoFull: string | null | undefined,
  override: DedupOverride | null = null,
  runner: CommandRunner = runGhCommand,
): Promise<DuplicateCheckResult> {
  if (!repoFull || !newTitle.trim()) return { outcome: "skip" };
  if (hasOverrideReason(override)) return { outcome: "pass" };
  if (tokenizeTitle(newTitle).length < DUPLICATE_MIN_SHARED_TOKENS) return { outcome: "skip" };
  const openIssues = await fetchOpenIssueTitles(repoFull, runner);
  return classifyDuplicate(newTitle, repoFull, openIssues, override);
}

/** Formats candidates as `repo#number "title"` for a denial message, per the citation convention. */
export function formatCandidates(repoFull: string, candidates: DuplicateCandidate[]): string {
  const repoName = repoFull.includes("/") ? repoFull.split("/").pop()! : repoFull;
  return candidates.map((c) => `${repoName}#${c.number} "${c.title}"`).join(", ");
}
