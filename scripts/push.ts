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
  const colonArg = args.find((a) => a.includes(":"));
  if (colonArg) {
    return {
      outcome: "refused",
      rule: "colon-refspec",
      reason: `colon refspec '${colonArg}' is not permitted via 'deno task push'`,
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
      `'deno task push' accepts only two forms: 'deno task push' and 'deno task push --force-with-lease'. Received: ${
        args.join(" ")
      }`,
  };
}

/**
 * Resolves the short name of the currently checked out branch, or null if detached HEAD
 * or not inside a git working tree.
 */
export async function getCurrentBranch(cwd?: string): Promise<string | null> {
  try {
    const isInsideCmd = new Deno.Command("git", {
      args: ["rev-parse", "--is-inside-work-tree"],
      cwd,
      stdout: "piped",
      stderr: "piped",
    });
    const isInsideRes = await isInsideCmd.output();
    if (isInsideRes.code !== 0) return null;
    const isInsideText = new TextDecoder().decode(isInsideRes.stdout).trim();
    if (isInsideText !== "true") return null;

    const symCmd = new Deno.Command("git", {
      args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
      cwd,
      stdout: "piped",
      stderr: "piped",
    });
    const symRes = await symCmd.output();
    if (symRes.code !== 0) return null;

    const branch = new TextDecoder().decode(symRes.stdout).trim();
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
  },
): Promise<number> {
  const branch = options?.branch !== undefined ? options.branch : await getCurrentBranch(cwd);

  const decision = evaluatePush(args, branch);

  if (decision.outcome !== "allowed") {
    console.error(`Refused (${decision.rule}): ${decision.reason}`);
    return 1;
  }

  const gitArgs = ["push", "-u", "origin", decision.branch!];
  if (decision.forceWithLease) {
    gitArgs.push("--force-with-lease");
  }

  try {
    const cmd = new Deno.Command("git", {
      args: gitArgs,
      cwd,
      stdout: options?.stdout ?? "inherit",
      stderr: options?.stderr ?? "inherit",
    });
    const status = await cmd.spawn().status;
    return status.code;
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
