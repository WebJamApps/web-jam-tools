/**
 * hooks/lib/fix_pr_target.ts
 *
 * The one pure, synchronous `/fix-pr` target parser, shared by `scripts/push.ts`,
 * `scripts/resolve-fix-pr-target.ts` (through `hooks/lib/fix_run.ts`) and Claude Code's
 * `hooks/lib/opus_gate.ts`. Design: ~/Dropbox/web-jam-llms/Token_Savings/fix-pr-design-2026-10-10.md
 * (revision 1.10.0), "Parsing the pull request target anywhere in the call" and "Accepting CircleCI
 * build and job links".
 *
 * This module imports nothing: the Opus delegation gate loads it under `deno run --no-config`, where
 * bare specifiers such as `@std/path` cannot resolve. It makes no network or `gh` call; resolving a
 * CircleCI link to a pull request lives in `hooks/lib/fix_run.ts`.
 */

/**
 * A target the call names. A `pull-request` whose `repo` is null came from a bare number and names the
 * checkout's repository. A `circleci-job` whose `repo` is null came from a GitHub Checks link, which
 * carries no repository; CircleCI's workflow metadata supplies it.
 */
export type FixPrTarget =
  | { kind: "pull-request"; repo: string | null; number: number }
  | {
    kind: "circleci-build";
    repo: string;
    buildNumber: number;
    workflowId?: string;
    jobId?: string;
  }
  | { kind: "circleci-job"; repo: string | null; workflowId: string; jobId: string };

export type FixPrTargetParse =
  | { ok: true; target: FixPrTarget }
  | { ok: false; reason: string };

export const NAMES_NO_PULL_REQUEST = "the typed fix-pr call names no pull request";
export const NAMES_MORE_THAN_ONE = "the typed fix-pr call names more than one pull request";

const LEADING_PUNCTUATION = new Set(["(", "[", "<", '"', "'", "“", "‘"]);
const TRAILING_PUNCTUATION = new Set([
  ",",
  ".",
  ";",
  ":",
  ")",
  "]",
  ">",
  '"',
  "'",
  "”",
  "’",
  "!",
  "?",
]);
const LEAD_IN_WORDS = new Set(["for", "on", "pr", "pull", "request", "fix", "rebase"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = "[A-Za-z0-9_.-]+";

type Classified =
  | { type: "target"; target: FixPrTarget }
  | { type: "refuse"; reason: string }
  | { type: "ignore" };

const refuse = (reason: string): Classified => ({ type: "refuse", reason });
const found = (target: FixPrTarget): Classified => ({ type: "target", target });

/** Strip the closed leading and trailing punctuation sets, repeatedly. */
export function trimTargetToken(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && LEADING_PUNCTUATION.has(token[start])) start++;
  while (end > start && TRAILING_PUNCTUATION.has(token[end - 1])) end--;
  return token.slice(start, end);
}

/** A positive safe integer, "unsafe" for digits that are zero, zero-led or too large, else null. */
function positiveNumber(digits: string): number | "unsafe" | null {
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return /^[1-9]\d*$/.test(digits) && Number.isSafeInteger(value) ? value : "unsafe";
}

/** `.` and `..` are path traversal, never an owner or repository name. */
function safeName(name: string): boolean {
  return name !== "." && name !== "..";
}

function repoOf(owner: string, name: string): string | null {
  return safeName(owner) && safeName(name) ? `${owner}/${name}` : null;
}

/** CircleCI's numeric build and workflow-and-job UUID links, on its own two hosts only. */
function classifyCircleCi(url: URL): Classified {
  if (url.protocol !== "https:") return refuse("a CircleCI link must use https");
  if (url.username || url.password) return refuse("a CircleCI link must not carry credentials");
  if (url.port) return refuse("a CircleCI link must not name a port");
  const path = url.pathname;
  if (/\/private\/output\//i.test(path)) {
    return refuse("a signed CircleCI log URL is never a fix-pr target");
  }
  if (/^\/api\//i.test(path)) return refuse("a CircleCI API URL is not a build or job link");
  const noTarget = refuse("the CircleCI link names no build or job");
  const host = url.hostname.toLowerCase();

  if (host === "circleci.com") {
    const v1 = path.match(new RegExp(`^/(?:gh|github)/(${NAME})/(${NAME})/(\\d+)/?$`, "i"));
    if (!v1) return noTarget;
    const repo = repoOf(v1[1], v1[2]);
    const buildNumber = positiveNumber(v1[3]);
    if (!repo || typeof buildNumber !== "number") {
      return refuse("the CircleCI link has a malformed repository or build number");
    }
    return found({ kind: "circleci-build", repo, buildNumber });
  }

  const checks = path.match(/^\/(?:workflow\/([^/]+)\/job|workflows\/([^/]+)\/jobs)\/([^/]+)\/?$/i);
  if (checks) {
    const workflowId = checks[1] ?? checks[2];
    const jobId = checks[3];
    if (!UUID.test(workflowId) || !UUID.test(jobId)) {
      return refuse("the CircleCI link has a malformed workflow or job id");
    }
    return found({
      kind: "circleci-job",
      repo: null,
      workflowId: workflowId.toLowerCase(),
      jobId: jobId.toLowerCase(),
    });
  }

  const pipeline = path.match(
    new RegExp(`^/pipelines/(?:gh|github)/(${NAME})/(${NAME})/(\\d+)(/.*)?$`, "i"),
  );
  if (!pipeline) return noTarget;
  const repo = repoOf(pipeline[1], pipeline[2]);
  if (!repo || typeof positiveNumber(pipeline[3]) !== "number") {
    return refuse("the CircleCI link has a malformed repository or pipeline number");
  }
  const rest = pipeline[4] ?? "";

  const job = rest.match(/^\/workflows\/([^/]+)\/jobs\/(\d+)\/?$/i);
  if (job) {
    const buildNumber = positiveNumber(job[2]);
    if (!UUID.test(job[1]) || typeof buildNumber !== "number") {
      return refuse("the CircleCI link has a malformed workflow id or job number");
    }
    return found({
      kind: "circleci-build",
      repo,
      buildNumber,
      workflowId: job[1].toLowerCase(),
    });
  }

  if (!/^\/details\/?$/i.test(rest)) return noTarget;
  const values: Record<string, string | undefined> = {};
  for (const key of ["buildNumber", "workflowId", "job"]) {
    const all = url.searchParams.getAll(key);
    if (all.length > 1) return refuse(`the CircleCI link repeats the '${key}' query parameter`);
    values[key] = all[0];
  }
  for (const key of ["workflowId", "job"]) {
    const value = values[key];
    if (value !== undefined && !UUID.test(value)) {
      return refuse(`the CircleCI link has a malformed '${key}' query parameter`);
    }
  }
  const workflowId = values.workflowId?.toLowerCase();
  const jobId = values.job?.toLowerCase();
  if (values.buildNumber !== undefined) {
    const buildNumber = positiveNumber(values.buildNumber);
    if (typeof buildNumber !== "number") {
      return refuse("the CircleCI link has a malformed 'buildNumber' query parameter");
    }
    return found({
      kind: "circleci-build",
      repo,
      buildNumber,
      ...(workflowId ? { workflowId } : {}),
      ...(jobId ? { jobId } : {}),
    });
  }
  if (workflowId && jobId) return found({ kind: "circleci-job", repo, workflowId, jobId });
  return noTarget;
}

/** A token holding a scheme: a GitHub pull request link, a CircleCI link, or prose to pass over. */
function classifyUrl(token: string): Classified {
  let url: URL;
  try {
    url = new URL(token);
  } catch {
    return /circleci\.com/i.test(token)
      ? refuse("the CircleCI link is malformed")
      : { type: "ignore" };
  }
  const host = url.hostname.toLowerCase();
  if (host === "circleci.com" || host === "app.circleci.com") return classifyCircleCi(url);
  if (host === "github.com" || host === "www.github.com") {
    const pull = url.pathname.match(new RegExp(`^/(${NAME})/(${NAME})/pull/(\\d+)(?:/.*)?$`, "i"));
    if (!pull) return { type: "ignore" }; // an issue link, or any other GitHub page
    if (url.protocol !== "https:" || url.username || url.password || url.port) {
      return refuse("a GitHub pull request link must be a plain https link");
    }
    const repo = repoOf(pull[1], pull[2]);
    const number = positiveNumber(pull[3]);
    if (!repo || typeof number !== "number") {
      return refuse("the GitHub pull request link has a malformed repository or number");
    }
    return found({ kind: "pull-request", repo, number });
  }
  // A CircleCI-shaped path on any other host is a lookalike, not a link to ignore.
  if (/^\/(?:pipelines\/(?:gh|github)\/|workflows?\/[0-9a-f-]{36}\/jobs?\/)/i.test(url.pathname)) {
    return refuse(`'${host}' is not a CircleCI host`);
  }
  return { type: "ignore" };
}

/** Sources 1, 2, 4 and 5; bare numbers (source 3) are left to the positional scan. */
function classifyExplicit(token: string): Classified {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return classifyUrl(token);
  const named = token.match(new RegExp(`^(?:(${NAME})/)?(${NAME})#(\\d+)$`));
  if (!named) return { type: "ignore" };
  const repo = repoOf(named[1] ?? "WebJamApps", named[2]);
  const number = positiveNumber(named[3]);
  if (!repo || typeof number !== "number") {
    return refuse(`'${token}' does not name a valid pull request`);
  }
  return found({ kind: "pull-request", repo, number });
}

/** Two mentions collapse only when they name the same target in the same form family. */
function targetKey(target: FixPrTarget): string {
  switch (target.kind) {
    case "pull-request":
      return `pr:${target.repo?.toLowerCase() ?? ""}#${target.number}`;
    case "circleci-build":
      return `build:${target.repo.toLowerCase()}:${target.buildNumber}:${target.workflowId ?? ""}:${
        target.jobId ?? ""
      }`;
    case "circleci-job":
      return `job:${target.repo?.toLowerCase() ?? ""}:${target.workflowId}:${target.jobId}`;
  }
}

const BARE = /^#?(\d+)$/;

interface Scan {
  result: FixPrTargetParse;
  /** Indices of the whitespace tokens that mention the target. */
  mentions: number[];
}

function scan(args: string): Scan {
  const raw = args.split(/\s+/).filter((token) => token.length > 0);
  const tokens = raw.map(trimTargetToken);
  const refused = (reason: string): Scan => ({ result: { ok: false, reason }, mentions: [] });

  const targets = new Map<string, FixPrTarget>();
  const mentions: number[] = [];
  for (const [index, token] of tokens.entries()) {
    if (!token) continue;
    const classified = classifyExplicit(token);
    if (classified.type === "refuse") return refused(classified.reason);
    if (classified.type !== "target") continue;
    mentions.push(index);
    // A repeat of the same target collapses onto its first mention.
    const key = targetKey(classified.target);
    if (!targets.has(key)) targets.set(key, classified.target);
  }
  if (targets.size > 1) return refused(NAMES_MORE_THAN_ONE);
  if (targets.size === 1) {
    return { result: { ok: true, target: [...targets.values()][0] }, mentions };
  }

  // Source 3: a bare number only first, or right after leading lead-in words.
  let at = 0;
  while (at < tokens.length && LEAD_IN_WORDS.has(tokens[at].toLowerCase())) at++;
  const bare = tokens[at]?.match(BARE);
  if (!bare) return refused(NAMES_NO_PULL_REQUEST);
  const number = positiveNumber(bare[1]);
  if (typeof number !== "number") {
    return refused(`'${tokens[at]}' is not a valid pull request number`);
  }
  const separator = tokens[at + 1]?.toLowerCase();
  const listed = raw[at].endsWith(",")
    ? BARE.test(tokens[at + 1] ?? "")
    : (separator === "and" || separator === "&") && BARE.test(tokens[at + 2] ?? "");
  if (listed) return refused(NAMES_MORE_THAN_ONE);
  return {
    result: { ok: true, target: { kind: "pull-request", repo: null, number } },
    mentions: [at],
  };
}

/**
 * Find the one pull request or CircleCI build or job the call's arguments name, anywhere in them.
 * Refuses zero targets, two different targets, and every malformed or untrusted link.
 */
export function parseFixPrTarget(args: string): FixPrTargetParse {
  return scan(args).result;
}

/**
 * The call's arguments with every mention of its target removed: what Josh asked the run to do,
 * such as "use a Fable helper". Leading lead-in words before a bare number stay in place.
 */
export function fixPrInstructions(args: string): string {
  const { mentions } = scan(args);
  return args.split(/\s+/).filter((token) => token.length > 0)
    .filter((_, index) => !mentions.includes(index)).join(" ");
}
