/**
 * scripts/push.ts
 *
 * Guarded push command backing `deno task push`.
 * Pushes only the current feature branch. Outside a typed fix-pr run:
 *   1. deno task push
 *   2. deno task push --force-with-lease
 * From a repo without this task, load the shared config and pass --repo-dir
 * before the push flags to select that repo explicitly.
 * Inside a verified fix-pr run, --fix-comment <file> is required and force-with-lease
 * uses the typed authorization. Comment validation/posting is a separate change.
 * Outside that run, force-with-lease still requires affirmative terminal confirmation.
 *
 * Refuses protected branches (dev, main), plain --force / -f, --delete / -d,
 * colon refspecs (:branch), and fails closed if the branch cannot be determined
 * (e.g. detached HEAD or not inside a git repository).
 */

import {
  checkFixRun,
  type FixRun,
  githubRepository,
  parseFixPrReference,
  type PullRequestRef,
  type PullRequestState,
  readTypedSkillCall,
} from "../hooks/lib/fix_run.ts";
import type { CodexSkillCall } from "../hooks/lib/codex_session_reader.ts";

export type PushOutcome = "allowed" | "refused" | "refused-fail-closed";

export interface PushDecision {
  outcome: PushOutcome;
  rule: string;
  reason: string;
  branch?: string;
  forceWithLease?: boolean;
  fixComment?: string;
  fixRun?: FixRun;
}

/**
 * Evaluates the given arguments and current branch against push policy.
 */
export function evaluatePush(
  args: string[],
  branch: string | null,
  fixRun: FixRun = { kind: "none" },
): PushDecision {
  // Fail closed if the current branch cannot be determined
  if (!branch) {
    return {
      outcome: "refused-fail-closed",
      rule: "cannot-determine-branch",
      reason:
        "current branch cannot be determined (detached HEAD, git rev-parse failed, or not inside a git working tree)",
    };
  }

  // Refuse branch names git could read as an option (-) or a force marker (+)
  if (branch.startsWith("+") || branch.startsWith("-")) {
    return {
      outcome: "refused",
      rule: "unsafe-branch-name",
      reason:
        "current branch name starts with '+' or '-', which git could read as a force marker or an option (rename the branch)",
    };
  }

  // Refuse if current branch is dev or main
  if (branch === "dev" || branch === "main") {
    if (args.includes("--force-with-lease")) {
      return {
        outcome: "refused",
        rule: "protected-branch-force-with-lease",
        reason:
          `cannot push protected branch '${branch}' with '--force-with-lease' (protected branch — open a PR instead)`,
      };
    }
    return {
      outcome: "refused",
      rule: "protected-branch",
      reason: `cannot push protected branch '${branch}' (protected branch — open a PR instead)`,
    };
  }

  // Refuse --delete or -d
  if (
    args.includes("--delete") || args.includes("-d") ||
    args.some((a) => a.startsWith("--delete="))
  ) {
    const flag = args.includes("-d") ? "-d" : "--delete";
    return {
      outcome: "refused",
      rule: "branch-deletion",
      reason:
        `'${flag}' is not permitted via 'deno task push' (deleting remote branches is forbidden)`,
    };
  }

  // Refuse plain --force or -f
  if (
    args.some((a) => a === "--force" || a === "-f" || a.startsWith("--force="))
  ) {
    const flag = args.includes("-f") ? "-f" : "--force";
    return {
      outcome: "refused",
      rule: "plain-force",
      reason:
        `'${flag}' is not permitted via 'deno task push' (use '--force-with-lease' on feature branches)`,
    };
  }

  // Refuse colon refspec
  if (args.some((a) => a.includes(":"))) {
    return {
      outcome: "refused",
      rule: "colon-refspec",
      reason: "a colon refspec is not permitted via 'deno task push'",
    };
  }

  let forceWithLease = false;
  let fixComment: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--force-with-lease" && !forceWithLease) {
      forceWithLease = true;
    } else if (args[i] === "--fix-comment" && fixComment === undefined) {
      const file = args[++i];
      if (!file?.trim() || file.startsWith("-")) {
        return {
          outcome: "refused",
          rule: "missing-fix-comment",
          reason: "--fix-comment needs a file",
        };
      }
      fixComment = file;
    } else {
      return {
        outcome: "refused",
        rule: "unaccepted-arguments",
        reason:
          "deno task push accepts --force-with-lease and, inside a fix run, --fix-comment <file>",
      };
    }
  }
  if (fixRun.kind === "refused") {
    return { outcome: "refused", rule: "fix-run-mismatch", reason: fixRun.reason };
  }
  if (fixRun.kind === "active" && !fixComment) {
    return {
      outcome: "refused",
      rule: "missing-fix-comment",
      reason: "a push inside a typed fix-pr run requires --fix-comment <file>",
    };
  }
  if (fixRun.kind !== "active" && fixComment) {
    return {
      outcome: "refused",
      rule: "fix-comment-outside-run",
      reason: "--fix-comment requires a typed fix-pr run for this open PR branch",
    };
  }
  return {
    outcome: "allowed",
    rule: forceWithLease ? "force-with-lease-push" : "plain-push",
    reason: `pushing feature branch '${branch}'`,
    branch,
    forceWithLease,
    fixComment,
    fixRun,
  };
}

export interface GitResult {
  code: number;
  stdout: string;
}

/** Runs a git command with piped output; injectable so fail-closed paths are testable. */
export type GitRunner = (args: string[], cwd?: string) => Promise<GitResult>;

/** Spawns the push with the given stdio and returns its exit code; injectable for tests. */
export type PushSpawner = (
  args: string[],
  cwd: string | undefined,
  stdio: { stdout: "inherit" | "piped"; stderr: "inherit" | "piped" },
) => Promise<number>;

const defaultGitRunner: GitRunner = async (args, cwd) => {
  const res = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: res.code, stdout: new TextDecoder().decode(res.stdout) };
};

export type PullRequestLookup = (ref: PullRequestRef) => Promise<PullRequestState | null>;

async function lookupPullRequest(ref: PullRequestRef): Promise<PullRequestState | null> {
  const result = await new Deno.Command("gh", {
    args: [
      "pr",
      "view",
      String(ref.number),
      "--repo",
      ref.repo,
      "--json",
      "number,state,headRefName,headRepository,isCrossRepository",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (result.code !== 0) return null;
  const pr = JSON.parse(new TextDecoder().decode(result.stdout));
  if (
    !pr || typeof pr !== "object" || Array.isArray(pr) ||
    !Number.isSafeInteger(pr.number) || typeof pr.state !== "string" ||
    typeof pr.headRefName !== "string" || typeof pr.isCrossRepository !== "boolean" ||
    (pr.headRepository !== null && typeof pr.headRepository?.nameWithOwner !== "string")
  ) return null;
  return pr;
}

export interface FixRunDeps {
  readSkillCall?: () => Promise<CodexSkillCall | null>;
  runGit?: GitRunner;
  lookupPullRequest?: PullRequestLookup;
}

/** Discovery failures are no approval; a verified call for a different branch is refused. */
export async function resolveFixRun(
  branch: string | null,
  cwd?: string,
  deps: FixRunDeps = {},
): Promise<FixRun> {
  if (!branch) return { kind: "none" };
  try {
    const call = await (deps.readSkillCall ?? readTypedSkillCall)();
    if (call?.name.split(":").at(-1) !== "fix-pr") return { kind: "none" };
    const remote = await (deps.runGit ?? defaultGitRunner)(
      ["remote", "get-url", "--push", "--all", "origin"],
      cwd,
    );
    const repo = remote.code === 0 ? githubRepository(remote.stdout) : null;
    if (!repo) return { kind: "none" };
    const ref = parseFixPrReference(call.arguments, repo);
    const preliminary = checkFixRun(call, repo, branch, null);
    if (preliminary.kind === "refused" || !ref) return preliminary;
    const pr = await (deps.lookupPullRequest ?? lookupPullRequest)(ref);
    return checkFixRun(call, repo, branch, pr);
  } catch {
    return { kind: "none" };
  }
}

const defaultPushSpawner: PushSpawner = async (args, cwd, stdio) => {
  const status = await new Deno.Command("git", { args, cwd, ...stdio }).spawn().status;
  return status.code;
};

/** Require a terminal and affirmative confirmation before any force-with-lease push. */
export function confirmForcePush(
  branch: string,
  isTerminal: () => boolean = () => Deno.stdin.isTerminal(),
  ask: (message: string) => boolean = globalThis.confirm,
): boolean {
  return isTerminal() &&
    ask(`Force-push feature branch '${branch}' to origin with --force-with-lease?`);
}

/**
 * Resolves the short name of the currently checked out branch, or null if detached HEAD
 * or not inside a git working tree.
 */
export async function getCurrentBranch(
  cwd?: string,
  run: GitRunner = defaultGitRunner,
): Promise<string | null> {
  try {
    const isInside = await run(["rev-parse", "--is-inside-work-tree"], cwd);
    if (isInside.code !== 0) return null;
    if (isInside.stdout.trim() !== "true") return null;

    const sym = await run(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
    if (sym.code !== 0) return null;

    const branch = sym.stdout.trim();
    if (!branch || branch === "HEAD") return null;
    return branch;
  } catch {
    return null;
  }
}

/**
 * Executes guarded push against the current repository.
 */
export async function runPush(
  args: string[],
  cwd?: string,
  options?: FixRunDeps & {
    branch?: string | null;
    stdout?: "inherit" | "piped";
    stderr?: "inherit" | "piped";
    spawnPush?: PushSpawner;
    confirmForce?: (branch: string) => boolean;
  },
): Promise<number> {
  const branch = options?.branch !== undefined
    ? options.branch
    : await getCurrentBranch(cwd, options?.runGit);

  const fixRun = await resolveFixRun(branch, cwd, options);
  const decision = evaluatePush(args, branch, fixRun);

  if (decision.outcome !== "allowed") {
    console.error(`Refused (${decision.rule}): ${decision.reason}`);
    return 1;
  }

  // Explicit refspec: the branch name can never be read as an option or a force marker.
  const refspec = `refs/heads/${decision.branch!}:refs/heads/${decision.branch!}`;
  const gitArgs = ["push", "-u", "origin"];
  if (decision.forceWithLease) {
    gitArgs.push("--force-with-lease");
  }
  gitArgs.push(refspec);

  try {
    if (
      decision.forceWithLease && fixRun.kind !== "active" &&
      !(options?.confirmForce ?? confirmForcePush)(decision.branch!)
    ) {
      console.error(
        "Refused (force-with-lease-confirmation): --force-with-lease requires affirmative confirmation in an interactive terminal",
      );
      return 1;
    }
    return await (options?.spawnPush ?? defaultPushSpawner)(gitArgs, cwd, {
      stdout: options?.stdout ?? "inherit",
      stderr: options?.stderr ?? "inherit",
    });
  } catch (err) {
    console.error(
      `Failed to execute git push: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}

if (import.meta.main) {
  const args = [...Deno.args];
  let cwd: string | undefined;
  if (args[0] === "--repo-dir") {
    args.shift();
    cwd = args.shift();
    if (!cwd || cwd.startsWith("--")) {
      console.error("Refused (missing-repo-dir): --repo-dir requires a repository directory");
      Deno.exit(1);
    }
  }
  const exitCode = await runPush(args, cwd);
  Deno.exit(exitCode);
}
