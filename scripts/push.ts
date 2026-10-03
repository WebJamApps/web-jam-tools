/**
 * scripts/push.ts
 *
 * Guarded push command backing `deno task push`.
 * Pushes only the current feature branch, accepting exactly two forms:
 *   1. deno task push
 *   2. deno task push --force-with-lease
 *
 * Refuses protected branches (dev, main), plain --force / -f, --delete / -d,
 * colon refspecs (:branch), and fails closed if the branch cannot be determined
 * (e.g. detached HEAD or not inside a git repository).
 */

export type PushOutcome = "allowed" | "refused" | "refused-fail-closed";

export interface PushDecision {
  outcome: PushOutcome;
  rule: string;
  reason: string;
  branch?: string;
  forceWithLease?: boolean;
}

/**
 * Evaluates the given arguments and current branch against push policy.
 */
export function evaluatePush(args: string[], branch: string | null): PushDecision {
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

  // Accepted form 1: plain push
  if (args.length === 0) {
    return {
      outcome: "allowed",
      rule: "plain-push",
      reason: `pushing feature branch '${branch}'`,
      branch,
      forceWithLease: false,
    };
  }

  // Accepted form 2: force-with-lease push
  if (args.length === 1 && args[0] === "--force-with-lease") {
    return {
      outcome: "allowed",
      rule: "force-with-lease-push",
      reason: `pushing feature branch '${branch}' with '--force-with-lease'`,
      branch,
      forceWithLease: true,
    };
  }

  // Any other argument form is unaccepted
  return {
    outcome: "refused",
    rule: "unaccepted-arguments",
    reason:
      "'deno task push' accepts only two forms: 'deno task push' and 'deno task push --force-with-lease'. Other arguments are not accepted.",
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

const defaultPushSpawner: PushSpawner = async (args, cwd, stdio) => {
  const status = await new Deno.Command("git", { args, cwd, ...stdio }).spawn().status;
  return status.code;
};

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
  options?: {
    branch?: string | null;
    stdout?: "inherit" | "piped";
    stderr?: "inherit" | "piped";
    spawnPush?: PushSpawner;
  },
): Promise<number> {
  const branch = options?.branch !== undefined ? options.branch : await getCurrentBranch(cwd);

  const decision = evaluatePush(args, branch);

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
  const exitCode = await runPush(Deno.args);
  Deno.exit(exitCode);
}
