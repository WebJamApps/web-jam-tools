import {
  type CodexSkillCall,
  codexSkillCall,
  readCodexTypedSession,
} from "./codex_session_reader.ts";
import {
  slashCommandFromInvocationWrapper,
  stripUserRequestWrapper,
} from "./check_token_write_authorization.ts";
import {
  extractEntryText,
  isAntigravityEntry,
  isHumanPrompt,
  isOwnSessionUserTurnBoundary,
} from "./select_transcript_entry.ts";
import {
  resolveAntigravityWriteContext,
  resolveClaudeCodeWriteContext,
  type ResolvedWriteContext,
} from "../../scripts/write_issue_approval_token.ts";
import { parseFixPrTarget } from "./fix_pr_target.ts";

export {
  fixPrInstructions,
  type FixPrTarget,
  type FixPrTargetParse,
  NAMES_MORE_THAN_ONE,
  NAMES_NO_PULL_REQUEST,
  parseFixPrTarget,
  trimTargetToken,
} from "./fix_pr_target.ts";

export type SessionEnv = (name: string) => string | undefined;

/** True for the fix-pr skill, typed bare or through a plugin namespace (`webjam-tasks:fix-pr`). */
export function isFixPrSkill(name: string): boolean {
  return name.split(":").at(-1) === "fix-pr";
}

/** Read only human calls in this conversation; plain replies preserve the newest skill. */
export function latestTypedSkillCall(context: ResolvedWriteContext): CodexSkillCall | null {
  if (context.isSubagentInvocation || !context.ownConversationId) return null;
  for (let i = context.entries.length - 1; i >= 0; i--) {
    const entry = context.entries[i];
    const human = isAntigravityEntry(entry)
      ? isOwnSessionUserTurnBoundary(entry, context.ownConversationId)
      : isHumanPrompt(entry);
    if (!human || entry.isMeta === true) continue;
    const content = isAntigravityEntry(entry) ? entry.content : entry.message?.content;
    if (
      typeof content !== "string" &&
      (!Array.isArray(content) || content.some((block) =>
        !block || typeof block !== "object" ||
        (block.type !== "image" && (block.type !== "text" || typeof block.text !== "string"))
      ))
    ) return null;
    const text = stripUserRequestWrapper(extractEntryText(entry));
    const wrapped = slashCommandFromInvocationWrapper(text);
    const dated = (call: CodexSkillCall): CodexSkillCall =>
      typeof entry.timestamp === "string" ? { ...call, timestamp: entry.timestamp } : call;
    if (wrapped) {
      const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
      return dated({ name: wrapped, arguments: args?.[1].trim() ?? "", text });
    }
    const call = codexSkillCall(text);
    if (call) return dated(call);
  }
  return null;
}

/** Use each tool's existing discovery, refusing damaged records and agent-started sessions. */
export async function readTypedSkillCall(
  env: SessionEnv = (name) => Deno.env.get(name),
): Promise<CodexSkillCall | null> {
  try {
    if (env("WJT_UNATTENDED") === "1") return null;
    const codexId = env("CODEX_THREAD_ID");
    const claudeId = env("CLAUDE_CODE_SESSION_ID");
    if (codexId && claudeId) return null;
    if (codexId) return (await readCodexTypedSession({ env })).latestSkillCall;
    const surface = env("WJT_SURFACE");
    if (surface === "codex" || (surface === "claude" && !claudeId)) return null;
    const context = claudeId
      ? await resolveClaudeCodeWriteContext(claudeId, true)
      : await resolveAntigravityWriteContext(true, {
        conversationId: env("AGY_CONVERSATION_ID"),
        transcriptPath: env("AGY_TRANSCRIPT_PATH"),
        recordPath: env("AGY_HOOK_RECORD_PATH"),
      });
    return context ? latestTypedSkillCall(context) : null;
  } catch {
    return null;
  }
}

export interface PullRequestRef {
  repo: string;
  number: number;
}

/**
 * The pull request a typed call names directly (a link, `repo#N`, or a bare number in the checkout),
 * found anywhere in the arguments by the shared parser. A CircleCI link, or a call naming zero or
 * several targets, gives null here: a CircleCI link needs {@link resolveFixPrTarget}.
 */
export function parseFixPrReference(args: string, checkoutRepo: string): PullRequestRef | null {
  const parsed = parseFixPrTarget(args);
  if (!parsed.ok || parsed.target.kind !== "pull-request") return null;
  return { repo: parsed.target.repo ?? checkoutRepo, number: parsed.target.number };
}

/**
 * What a typed target resolves to. `refused` is a definite no (a malformed or untrusted link, a
 * `dev` or `main` build, a conflict, a fork); `unknown` is "the command cannot tell" (a lookup
 * failed, or no single open pull request matched), which never counts as a yes.
 */
export type TargetResolution =
  | { kind: "resolved"; ref: PullRequestRef; branch?: string; build?: number }
  | { kind: "refused"; reason: string }
  | { kind: "unknown"; reason: string };

export interface GhResult {
  code: number;
  stdout: string;
}

export interface TargetResolverDeps {
  /** CircleCI's API is reached through this fetch only; tests inject it. */
  fetch?: typeof fetch;
  /** Sent as `Circle-Token` to `https://circleci.com/api/...` only. */
  circleToken?: string | null;
  runGh?: (args: string[]) => Promise<GhResult>;
}

export const PR_FIELDS = "number,state,headRefName,headRepository,isCrossRepository";

/** Runs `gh` with piped output. */
export const runGhCommand = async (args: string[]): Promise<GhResult> => {
  const result = await new Deno.Command("gh", { args, stdout: "piped", stderr: "piped" }).output();
  return { code: result.code, stdout: new TextDecoder().decode(result.stdout) };
};

function envCircleToken(): string | null {
  try {
    return Deno.env.get("CIRCLECI_TOKEN") || null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

type Lookup<T> = { ok: true; value: T } | { ok: false; resolution: TargetResolution };

/** GET CircleCI API JSON; the token goes to `https://circleci.com/api/` and nowhere else. */
async function circleJson(url: string, deps: TargetResolverDeps): Promise<Lookup<unknown>> {
  const unknown = (reason: string): Lookup<unknown> => ({
    ok: false,
    resolution: { kind: "unknown", reason },
  });
  if (!/^https:\/\/circleci\.com\/api\/(?:v1\.1|v2)\//.test(url)) {
    return unknown("refusing to call a CircleCI URL outside its API");
  }
  const token = deps.circleToken !== undefined ? deps.circleToken : envCircleToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Circle-Token"] = token;
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return unknown(
      `CircleCI could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    return unknown(`CircleCI answered HTTP ${response.status}`);
  }
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return unknown("CircleCI returned malformed JSON");
  }
}

function prFromJson(value: unknown): PullRequestState | null {
  if (
    !isRecord(value) || !Number.isSafeInteger(value.number) || typeof value.state !== "string" ||
    typeof value.headRefName !== "string" || typeof value.isCrossRepository !== "boolean" ||
    (value.headRepository !== null &&
      (!isRecord(value.headRepository) ||
        typeof value.headRepository.nameWithOwner !== "string"))
  ) return null;
  return value as unknown as PullRequestState;
}

/** Exactly one open, same-repository pull request on the build's branch, or a refusal. */
function choosePullRequest(
  repo: string,
  branch: string,
  candidates: PullRequestState[],
): TargetResolution {
  const fits = candidates.filter((pr) =>
    pr.state === "OPEN" && pr.isCrossRepository === false &&
    sameRepo(pr.headRepository?.nameWithOwner ?? "", repo) && pr.headRefName === branch
  );
  if (fits.length === 1) return { kind: "resolved", ref: { repo, number: fits[0].number }, branch };
  if (fits.length > 1) {
    return {
      kind: "unknown",
      reason: `more than one open pull request in ${repo} matches branch '${branch}'`,
    };
  }
  if (candidates.some((pr) => pr.isCrossRepository !== false)) {
    return {
      kind: "refused",
      reason: "the CircleCI build's pull request comes from another repository (a fork)",
    };
  }
  return {
    kind: "unknown",
    reason: `no open pull request in ${repo} matches the CircleCI build's branch '${branch}'`,
  };
}

/** CircleCI's `pull_requests` first, verified through `gh pr view`; else the open-PR branch lookup. */
async function pullRequestForBuild(
  repo: string,
  branch: string,
  pullRequests: unknown,
  deps: TargetResolverDeps,
): Promise<TargetResolution> {
  const runGh = deps.runGh ?? runGhCommand;
  const ghFailed: TargetResolution = {
    kind: "unknown",
    reason: "GitHub could not be read for the build's pull request",
  };
  if (pullRequests !== undefined && pullRequests !== null && !Array.isArray(pullRequests)) {
    return { kind: "unknown", reason: "CircleCI returned malformed pull request metadata" };
  }
  const numbers = new Set<number>();
  for (const item of (pullRequests as unknown[] | null | undefined) ?? []) {
    const url = typeof item === "string" ? item : isRecord(item) ? item.url : null;
    if (typeof url !== "string") continue;
    const match = url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/i);
    if (match && sameRepo(match[1], repo) && Number.isSafeInteger(Number(match[2]))) {
      numbers.add(Number(match[2]));
    }
  }
  try {
    if (numbers.size > 0) {
      const candidates: PullRequestState[] = [];
      for (const number of numbers) {
        const view = await runGh([
          "pr",
          "view",
          String(number),
          "--repo",
          repo,
          "--json",
          PR_FIELDS,
        ]);
        const pr = view.code === 0 ? prFromJson(JSON.parse(view.stdout)) : null;
        if (!pr || pr.number !== number) return ghFailed;
        candidates.push(pr);
      }
      return choosePullRequest(repo, branch, candidates);
    }
    const list = await runGh([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      PR_FIELDS,
    ]);
    if (list.code !== 0) return ghFailed;
    const parsed: unknown = JSON.parse(list.stdout);
    if (!Array.isArray(parsed)) return ghFailed;
    const candidates = parsed.map(prFromJson);
    if (candidates.some((pr) => pr === null)) return ghFailed;
    return choosePullRequest(repo, branch, candidates as PullRequestState[]);
  } catch {
    return ghFailed;
  }
}

async function resolveBuild(
  repo: string,
  buildNumber: number,
  workflowId: string | undefined,
  jobId: string | undefined,
  deps: TargetResolverDeps,
): Promise<TargetResolution> {
  const [owner, name] = repo.split("/");
  const fetched = await circleJson(
    `https://circleci.com/api/v1.1/project/github/${encodeURIComponent(owner)}/${
      encodeURIComponent(name)
    }/${buildNumber}`,
    deps,
  );
  if (!fetched.ok) return fetched.resolution;
  const build = fetched.value;
  if (
    !isRecord(build) || typeof build.username !== "string" || typeof build.reponame !== "string"
  ) {
    return { kind: "unknown", reason: "CircleCI returned malformed build metadata" };
  }
  if (!sameRepo(`${build.username}/${build.reponame}`, repo)) {
    return { kind: "refused", reason: "the CircleCI build belongs to another repository" };
  }
  const workflows = isRecord(build.workflows) ? build.workflows : {};
  const differs = (supplied: string | undefined, actual: unknown) =>
    supplied !== undefined &&
    (typeof actual !== "string" || actual.toLowerCase() !== supplied.toLowerCase());
  if (differs(workflowId, workflows.workflow_id) || differs(jobId, workflows.job_id)) {
    return {
      kind: "refused",
      reason: "the CircleCI link's workflow or job does not match its build",
    };
  }
  const branch = build.branch;
  if (typeof branch !== "string" || !branch) {
    return { kind: "refused", reason: "the CircleCI build names no branch" };
  }
  if (branch === "dev" || branch === "main") {
    return { kind: "refused", reason: `the CircleCI build ran on protected branch '${branch}'` };
  }
  const resolution = await pullRequestForBuild(repo, branch, build.pull_requests, deps);
  return resolution.kind === "resolved" ? { ...resolution, build: buildNumber } : resolution;
}

async function resolveJob(
  repo: string | null,
  workflowId: string,
  jobId: string,
  deps: TargetResolverDeps,
): Promise<TargetResolution> {
  const fetched = await circleJson(
    `https://circleci.com/api/v2/workflow/${workflowId}/job`,
    deps,
  );
  if (!fetched.ok) return fetched.resolution;
  const items = isRecord(fetched.value) ? fetched.value.items : null;
  if (!Array.isArray(items)) {
    return { kind: "unknown", reason: "CircleCI returned malformed workflow job metadata" };
  }
  const matches = items.filter((item) =>
    isRecord(item) && typeof item.id === "string" && item.id.toLowerCase() === jobId
  );
  if (matches.length !== 1) {
    return { kind: "refused", reason: "the CircleCI workflow has no single job with that id" };
  }
  const job = matches[0] as Record<string, unknown>;
  const slug = typeof job.project_slug === "string"
    ? job.project_slug.match(/^(?:gh|github)\/([\w.-]+)\/([\w.-]+)$/i)
    : null;
  const jobNumber = job.job_number;
  if (
    !slug || slug[1] === "." || slug[1] === ".." || slug[2] === "." || slug[2] === ".." ||
    typeof jobNumber !== "number" || !Number.isSafeInteger(jobNumber) || jobNumber < 1
  ) {
    return { kind: "unknown", reason: "CircleCI's job carries no GitHub project or build number" };
  }
  const slugRepo = `${slug[1]}/${slug[2]}`;
  if (repo && !sameRepo(repo, slugRepo)) {
    return {
      kind: "refused",
      reason: "the CircleCI link's repository does not match its workflow's project",
    };
  }
  return resolveBuild(slugRepo, jobNumber, workflowId, jobId, deps);
}

/**
 * Resolve the call's one target to a pull request. A GitHub target needs no lookup here; a CircleCI
 * build or job link is resolved through CircleCI's API (v2 workflow jobs, then v1.1 build) and GitHub,
 * never fetching a step's `output_url`. The caller checks the result against its checkout.
 */
export function resolveFixPrTarget(
  args: string,
  checkoutRepo: string | null,
  deps: TargetResolverDeps = {},
): Promise<TargetResolution> {
  const parsed = parseFixPrTarget(args);
  if (!parsed.ok) return Promise.resolve({ kind: "refused", reason: parsed.reason });
  const target = parsed.target;
  switch (target.kind) {
    case "pull-request": {
      const repo = target.repo ?? checkoutRepo;
      if (!repo) {
        return Promise.resolve({
          kind: "refused",
          reason: "a bare pull request number needs a checkout whose GitHub repository can be read",
        });
      }
      return Promise.resolve({ kind: "resolved", ref: { repo, number: target.number } });
    }
    case "circleci-build":
      return resolveBuild(target.repo, target.buildNumber, target.workflowId, target.jobId, deps);
    case "circleci-job":
      return resolveJob(target.repo, target.workflowId, target.jobId, deps);
  }
}

/** The synchronous reading of a call: a GitHub target resolves, a CircleCI link cannot be told. */
function resolveSynchronously(args: string, checkoutRepo: string): TargetResolution {
  const parsed = parseFixPrTarget(args);
  if (!parsed.ok) return { kind: "refused", reason: parsed.reason };
  if (parsed.target.kind !== "pull-request") {
    return { kind: "unknown", reason: "a CircleCI link needs CircleCI's metadata to resolve" };
  }
  return {
    kind: "resolved",
    ref: { repo: parsed.target.repo ?? checkoutRepo, number: parsed.target.number },
  };
}

/** GitHub HTTPS and SSH remotes, with no credentials or alternative host accepted. */
export function githubRepository(remote: string): string | null {
  const match = remote.trim().match(
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i,
  );
  return match?.[1] ?? null;
}

export interface PullRequestState {
  number: number;
  state: string;
  headRefName: string;
  headRepository: { nameWithOwner: string } | null;
  isCrossRepository: boolean;
}

export type FixRun =
  | { kind: "none" }
  | { kind: "refused"; reason: string }
  | { kind: "active"; pullRequest: PullRequestRef; headRefName: string };

/**
 * End terminal runs, or bind an open run to its repository and head or throwaway fix branch.
 * `resolution` is the call's target as {@link resolveFixPrTarget} resolved it; without one, only a
 * GitHub target can be read, and a CircleCI link gives no fix run.
 */
export function checkFixRun(
  call: CodexSkillCall | null,
  checkoutRepo: string,
  branch: string,
  pr: PullRequestState | null,
  resolution?: TargetResolution,
): FixRun {
  if (!call || !isFixPrSkill(call.name)) return { kind: "none" };
  const target = resolution ?? resolveSynchronously(call.arguments, checkoutRepo);
  if (target.kind === "refused") return { kind: "refused", reason: target.reason };
  if (target.kind === "unknown") return { kind: "none" };
  const ref = target.ref;
  if (!pr) return { kind: "none" };
  if (pr.number !== ref.number) {
    return {
      kind: "refused",
      reason: "GitHub returned a different pull request than the typed call",
    };
  }
  if (pr.state === "MERGED" || pr.state === "CLOSED") return { kind: "none" };
  if (pr.state !== "OPEN") {
    return { kind: "refused", reason: "GitHub returned an unexpected pull request state" };
  }
  if (ref.repo.toLowerCase() !== checkoutRepo.toLowerCase()) {
    return { kind: "refused", reason: "the typed fix-pr call names another repository" };
  }
  if (pr.headRefName === "dev" || pr.headRefName === "main") {
    return {
      kind: "refused",
      reason: `the pull request targets protected branch '${pr.headRefName}'`,
    };
  }
  if (!pr.headRefName || pr.headRefName.startsWith("+") || pr.headRefName.startsWith("-")) {
    return { kind: "refused", reason: "the pull request targets an unsafe branch name" };
  }
  const isFixBranch = branch === pr.headRefName || branch === `fix-pr/${pr.number}`;
  if (
    !isFixBranch ||
    pr.isCrossRepository !== false ||
    pr.headRepository?.nameWithOwner?.toLowerCase() !== checkoutRepo.toLowerCase()
  ) {
    return { kind: "refused", reason: "the typed fix-pr call does not name this open PR branch" };
  }
  return { kind: "active", pullRequest: ref, headRefName: pr.headRefName };
}
