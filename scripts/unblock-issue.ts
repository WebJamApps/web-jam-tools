#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env
/**
 * scripts/unblock-issue.ts — web-jam-tools#839
 *
 * Guarded CLI to remove self-blocking dependencies (where an issue is blocked by its
 * own parent or an ancestor). hooks/gh-api-guard.sh denies raw `gh api DELETE` to everyone;
 * this is the only agent-reachable removal path and covers only the never-valid shape.
 */
import { getIssueAncestors, normalizeRepo } from "../src/create-issue/lib.ts";
import { type RunCmd, runWithRetry } from "./gh-write/gh_runner.ts";

export interface UnblockIssueOptions {
  repo?: string;
  issue?: number;
  blocker?: number;
  dryRun: boolean;
}

export function parseArgs(args: string[]): UnblockIssueOptions {
  const opts: UnblockIssueOptions = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo" && i + 1 < args.length) opts.repo = args[++i];
    else if (arg.startsWith("--repo=")) opts.repo = arg.slice("--repo=".length);
    else if (arg === "--issue" && i + 1 < args.length) opts.issue = Number(args[++i]);
    else if (arg.startsWith("--issue=")) opts.issue = Number(arg.slice("--issue=".length));
    else if (arg === "--blocker" && i + 1 < args.length) opts.blocker = Number(args[++i]);
    else if (arg.startsWith("--blocker=")) opts.blocker = Number(arg.slice("--blocker=".length));
    else if (arg === "--dry-run") opts.dryRun = true;
  }
  return opts;
}

export interface Deps {
  runCmd: RunCmd;
  sleep?: (ms: number) => Promise<void>;
}

const USAGE = "usage: deno task unblock-issue --repo <owner/repo> --issue <n> --blocker <m> [--dry-run]";

export async function run(args: string[], deps: Deps): Promise<number> {
  const opts = parseArgs(args);
  if (!opts.repo || !opts.issue || !opts.blocker || isNaN(opts.issue) || isNaN(opts.blocker)) {
    console.error(USAGE);
    return 1;
  }

  const repoInfo = normalizeRepo(opts.repo);

  // 1. Fetch current dependencies of issue n
  const depsRes = await deps.runCmd([
    "gh",
    "api",
    `repos/${repoInfo.full}/issues/${opts.issue}/dependencies/blocked_by`,
  ]);
  if (depsRes.code !== 0) {
    console.error(
      `Failed to fetch dependencies for ${repoInfo.name}#${opts.issue}: ${depsRes.stderr || depsRes.stdout}`,
    );
    return 1;
  }

  let depList: Array<{
    id: number;
    number: number;
    repository?: { name?: string; owner?: { login?: string } };
  }> = [];
  try {
    depList = JSON.parse(depsRes.stdout);
  } catch (err) {
    console.error(`Failed to parse dependencies response: ${err}`);
    return 1;
  }

  const matchedDep = depList.find((d) => d.number === opts.blocker);
  if (!matchedDep) {
    console.error(`ERROR: issue ${repoInfo.name}#${opts.issue} is not blocked by #${opts.blocker}.`);
    return 1;
  }

  // 2. Verify that blocker m is an ancestor of issue n
  const ancestors = await getIssueAncestors(repoInfo, opts.issue, deps.runCmd);
  const isAncestor = ancestors.some(
    (a) =>
      a.owner.toLowerCase() === repoInfo.owner.toLowerCase() &&
      a.name.toLowerCase() === repoInfo.name.toLowerCase() &&
      a.number === opts.blocker,
  );

  if (!isAncestor) {
    console.error(
      `ERROR: blocker #${opts.blocker} is not an ancestor of #${opts.issue}. Sibling or unrelated dependencies are not agent-repairable; removing them requires Josh's manual decision.`,
    );
    return 1;
  }

  if (opts.dryRun) {
    console.log(
      `dry run: would remove self-blocking dependency #${opts.blocker} (id: ${matchedDep.id}) from ${repoInfo.name}#${opts.issue}`,
    );
    return 0;
  }

  // 3. Execute removal via DELETE
  const deleteArgs = [
    "gh",
    "api",
    "--method",
    "DELETE",
    `repos/${repoInfo.full}/issues/${opts.issue}/dependencies/blocked_by/${matchedDep.id}`,
  ];

  const result = await runWithRetry(deps.runCmd, deleteArgs, { sleep: deps.sleep });
  if (result.code !== 0) {
    console.error(`Failed to delete dependency after ${result.attempts} attempt(s): ${result.stderr}`);
    return 1;
  }

  console.log(
    `Removed self-blocking dependency: ${repoInfo.name}#${opts.issue} is no longer blocked by ancestor #${opts.blocker}`,
  );
  return 0;
}

async function realRunCmd(cmd: string[]) {
  const command = new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "piped", stderr: "piped" });
  const { code, stdout, stderr } = await command.output();
  return { code, stdout: new TextDecoder().decode(stdout), stderr: new TextDecoder().decode(stderr) };
}

if (import.meta.main) {
  const deps: Deps = { runCmd: realRunCmd };
  Deno.exit(await run(Deno.args, deps));
}
