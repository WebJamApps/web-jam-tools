/**
 * scripts/resolve-fix-pr-target.ts
 *
 * Read-only `deno task fix-pr:resolve-target`: resolves the pull request a `/fix-pr` call names (a
 * GitHub link, `repo#N`, a bare number in this checkout, or a CircleCI build or job link) through the
 * shared parser and resolver in `hooks/lib/fix_run.ts`, then checks the pull request is open, in this
 * checkout's repository, from no fork, and not headed by `dev` or `main`.
 *
 * Two modes:
 * - `<the call's arguments>` resolves arguments passed on the command line.
 * - `--from-session [--repo-dir <path>]` reads the call Josh typed in the live session through
 *   `readTypedSkillCall()` (the reader `deno task push` uses), requires its newest typed skill call to
 *   be fix-pr, and resolves that call's arguments. `--repo-dir` names the checkout whose `origin` the
 *   pull request must belong to; without it the command's working directory is used.
 *
 * Prints `{ repo, number, branch, build }` as JSON on success; exits 1 with the refusal on stderr.
 * Design: ~/Dropbox/web-jam-llms/Token_Savings/fix-pr-design-2026-10-10.md, "Accepting CircleCI build
 * and job links" (Permissions and CLI).
 */

import type { CodexSkillCall } from "../hooks/lib/codex_session_reader.ts";
import {
  githubRepository,
  isFixPrSkill,
  parseFixPrTarget,
  PR_FIELDS,
  type PullRequestState,
  readTypedSkillCall,
  resolveFixPrTarget,
  runGhCommand,
  type SessionEnv,
  type TargetResolverDeps,
} from "../hooks/lib/fix_run.ts";

export interface ResolvedFixPrTarget {
  repo: string;
  number: number;
  branch: string;
  build: number | null;
}

export type ResolveCliResult =
  | { ok: true; target: ResolvedFixPrTarget }
  | { ok: false; reason: string };

export interface ResolveCliDeps extends TargetResolverDeps {
  /**
   * The GitHub repository of the checkout at `repoDir` (the working directory when omitted), or
   * null when it cannot be read.
   */
  checkoutRepo?: (repoDir?: string) => Promise<string | null>;
  /** The newest skill call typed in the live session; defaults to `readTypedSkillCall()`. */
  readSkillCall?: () => Promise<CodexSkillCall | null>;
  /** The environment the session is found through; defaults to `Deno.env`. */
  env?: SessionEnv;
}

async function originRepo(repoDir?: string): Promise<string | null> {
  try {
    const result = await new Deno.Command("git", {
      args: ["remote", "get-url", "--push", "--all", "origin"],
      cwd: repoDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return result.code === 0 ? githubRepository(new TextDecoder().decode(result.stdout)) : null;
  } catch {
    return null;
  }
}

const refuse = (reason: string): ResolveCliResult => ({ ok: false, reason });

/** Resolve and verify the target; every failure, including a lookup error, is a refusal. */
async function verifyTarget(
  callArgs: string,
  checkoutRepo: string | null,
  deps: ResolveCliDeps,
): Promise<ResolveCliResult> {
  // A link naming another repository is refused before any CircleCI or GitHub lookup.
  const parsed = parseFixPrTarget(callArgs);
  const named = parsed.ok ? parsed.target.repo : null;
  if (checkoutRepo && named && named.toLowerCase() !== checkoutRepo.toLowerCase()) {
    return refuse(`the target is in ${named}, not this checkout's ${checkoutRepo}`);
  }
  const resolution = await resolveFixPrTarget(callArgs, checkoutRepo, deps);
  if (resolution.kind !== "resolved") return refuse(resolution.reason);
  const { ref } = resolution;
  if (checkoutRepo && ref.repo.toLowerCase() !== checkoutRepo.toLowerCase()) {
    return refuse(`the target is in ${ref.repo}, not this checkout's ${checkoutRepo}`);
  }
  let pr: PullRequestState;
  try {
    const view = await (deps.runGh ?? runGhCommand)([
      "pr",
      "view",
      String(ref.number),
      "--repo",
      ref.repo,
      "--json",
      PR_FIELDS,
    ]);
    if (view.code !== 0) return refuse("GitHub could not be read for the pull request");
    pr = JSON.parse(view.stdout);
  } catch {
    return refuse("GitHub returned malformed pull request data");
  }
  if (
    !pr || typeof pr !== "object" || pr.number !== ref.number ||
    typeof pr.headRefName !== "string"
  ) {
    return refuse("GitHub returned malformed pull request data");
  }
  if (pr.state !== "OPEN") {
    return refuse(`pull request ${ref.repo}#${ref.number} is ${pr.state}, not open`);
  }
  if (
    pr.isCrossRepository !== false ||
    pr.headRepository?.nameWithOwner?.toLowerCase() !== ref.repo.toLowerCase()
  ) {
    return refuse("the pull request comes from another repository (a fork)");
  }
  if (!pr.headRefName || pr.headRefName === "dev" || pr.headRefName === "main") {
    return refuse(`the pull request's head branch '${pr.headRefName}' is protected`);
  }
  if (resolution.branch !== undefined && resolution.branch !== pr.headRefName) {
    return refuse("the pull request's head branch no longer matches the build");
  }
  return {
    ok: true,
    target: {
      repo: ref.repo,
      number: ref.number,
      branch: pr.headRefName,
      build: resolution.build ?? null,
    },
  };
}

/** Why no typed call could be read, named as precisely as the environment allows. */
function noTypedCallReason(env: SessionEnv): string {
  const read = (name: string) => {
    try {
      return env(name);
    } catch {
      return undefined;
    }
  };
  if (read("WJT_UNATTENDED") === "1") return "an unattended run has no typed fix-pr call";
  const codex = read("CODEX_THREAD_ID");
  const claude = read("CLAUDE_CODE_SESSION_ID");
  if (codex && claude) {
    return "both CODEX_THREAD_ID and CLAUDE_CODE_SESSION_ID are set, so the session cannot be told";
  }
  if (!codex && !claude && !read("AGY_CONVERSATION_ID")) {
    return "no session is named (CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID or AGY_CONVERSATION_ID)";
  }
  return "no typed skill call could be read: the session record is missing or unreadable, " +
    "or this is a helper's turn";
}

/** `--from-session [--repo-dir <path>]`: verify the newest call typed in the live session. */
async function resolveFromSession(
  args: string[],
  deps: ResolveCliDeps,
): Promise<ResolveCliResult> {
  let repoDir: string | undefined;
  let fromSession = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--from-session") fromSession++;
    else if (arg === "--repo-dir" || arg.startsWith("--repo-dir=")) {
      if (repoDir !== undefined) return refuse("--repo-dir was given more than once");
      repoDir = arg === "--repo-dir" ? args[++i] : arg.slice("--repo-dir=".length);
      if (!repoDir || repoDir.startsWith("--")) {
        return refuse("--repo-dir requires a repository directory");
      }
    } else {
      return refuse(`--from-session reads the call from the session; '${arg}' is not accepted`);
    }
  }
  if (fromSession !== 1) return refuse("--from-session was given more than once");
  const env = deps.env ?? ((name: string) => Deno.env.get(name));
  const call = await (deps.readSkillCall ?? (() => readTypedSkillCall(env)))();
  if (!call) return refuse(noTypedCallReason(env));
  if (!isFixPrSkill(call.name)) {
    return refuse(`the newest skill call typed in this session is '${call.name}', not fix-pr`);
  }
  // Only --repo-dir names a checkout to match. The task always runs with web-jam-tools as its
  // working directory, so reading that origin without --repo-dir would bind every call to
  // web-jam-tools: a target in another repository would be refused and a bare number would
  // resolve there instead of being refused for lack of a checkout.
  if (repoDir === undefined) return verifyTarget(call.arguments, null, deps);
  const checkoutRepo = await (deps.checkoutRepo ?? originRepo)(repoDir);
  if (!checkoutRepo) {
    return refuse(`the GitHub repository of --repo-dir '${repoDir}' could not be read`);
  }
  return verifyTarget(call.arguments, checkoutRepo, deps);
}

/** Explicit `<arguments>` or `--from-session [--repo-dir <path>]`; every failure is a refusal. */
export async function resolveTargetCli(
  args: string[],
  deps: ResolveCliDeps = {},
): Promise<ResolveCliResult> {
  if (args.includes("--from-session")) return resolveFromSession(args, deps);
  const flag = args.find((arg) => arg.startsWith("--"));
  if (flag) {
    return refuse(`'${flag}' is not supported; pass the call's arguments or --from-session`);
  }
  return verifyTarget(args.join(" "), await (deps.checkoutRepo ?? originRepo)(), deps);
}

if (import.meta.main) {
  if (Deno.args.length === 1 && Deno.args[0] === "--help") {
    console.log("usage: deno task fix-pr:resolve-target <the /fix-pr call's arguments>");
    console.log("       deno task fix-pr:resolve-target --from-session [--repo-dir <path>]");
    console.log("Prints { repo, number, branch, build } as JSON, or exits 1 with the refusal.");
    Deno.exit(0);
  }
  const result = await resolveTargetCli([...Deno.args]);
  if (!result.ok) {
    console.error(`Refused: ${result.reason}`);
    Deno.exit(1);
  }
  console.log(JSON.stringify(result.target));
}
