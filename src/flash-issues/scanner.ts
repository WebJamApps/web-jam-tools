// src/flash-issues/scanner.ts
// Network and CLI scanner helpers for interacting with GitHub via `gh`.

import {
  ACTIVE_REPOS,
  type CommandResult,
  type CommandRunner,
  type GhDependencyIssue,
  type GhIssue,
  type GhIssueRestPayload,
  type GhPullRequest,
  REPO_OWNER,
  type RepoScanResult,
} from "./types.ts";

/** The real runner: shells out to `gh` via `Deno.Command`. */
export const runGhCommand: CommandRunner = async (args: string[]): Promise<CommandResult> => {
  const cmd = new Deno.Command("gh", { args, stdout: "piped", stderr: "piped" });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
};

/** Executes a `gh` command and throws on non-zero exit. */
export async function runGh(
  args: string[],
  runner: CommandRunner = runGhCommand,
): Promise<string> {
  const { code, stdout, stderr } = await runner(args);
  if (code !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`);
  }
  return stdout;
}

/** Fetches real label names for a repository. */
export async function fetchRepoLabels(
  repo: string,
  runner: CommandRunner = runGhCommand,
): Promise<string[]> {
  const stdout = await runGh([
    "label",
    "list",
    "--repo",
    `${REPO_OWNER}/${repo}`,
    "--json",
    "name",
    "--limit",
    "200",
  ], runner);
  const parsed = JSON.parse(stdout) as Array<{ name: string }>;
  return parsed.map((l) => l.name);
}

/** Lists open issues for a repository. */
export async function fetchRepoIssues(
  repo: string,
  runner: CommandRunner = runGhCommand,
): Promise<GhIssue[]> {
  const stdout = await runGh([
    "issue",
    "list",
    "--repo",
    `${REPO_OWNER}/${repo}`,
    "--state",
    "open",
    "--limit",
    "200",
    "--json",
    "number,title,labels,body,url,milestone",
  ], runner);
  return JSON.parse(stdout) as GhIssue[];
}

/** Lists open pull requests for a repository. */
export async function fetchRepoPrs(
  repo: string,
  runner: CommandRunner = runGhCommand,
): Promise<GhPullRequest[]> {
  const stdout = await runGh([
    "pr",
    "list",
    "--repo",
    `${REPO_OWNER}/${repo}`,
    "--state",
    "open",
    "--limit",
    "30",
    "--json",
    "number,headRefName,body,url,title,reviews,commits,reviewDecision,statusCheckRollup",
  ], runner);
  return JSON.parse(stdout) as GhPullRequest[];
}

/** Resolves an issue state (e.g. "OPEN" or "CLOSED"). */
export async function fetchIssueState(
  repo: string,
  number: number,
  runner: CommandRunner = runGhCommand,
): Promise<string> {
  const stdout = await runGh([
    "issue",
    "view",
    String(number),
    "--repo",
    `${REPO_OWNER}/${repo}`,
    "--json",
    "state",
    "-q",
    ".state",
  ], runner);
  return stdout.trim().toUpperCase();
}

/** Fetches full REST metadata for an issue (Priority field, Type, and total_blocked_by). */
export async function fetchIssueRestPayload(
  repo: string,
  number: number,
  runner: CommandRunner = runGhCommand,
): Promise<GhIssueRestPayload> {
  const stdout = await runGh([
    "api",
    `repos/${REPO_OWNER}/${repo}/issues/${number}`,
  ], runner);
  return JSON.parse(stdout) as GhIssueRestPayload;
}

/** Fetches direct blocking dependencies for an issue via REST. */
export async function fetchIssueBlockedBy(
  repo: string,
  number: number,
  runner: CommandRunner = runGhCommand,
): Promise<GhDependencyIssue[]> {
  const stdout = await runGh([
    "api",
    `repos/${REPO_OWNER}/${repo}/issues/${number}/dependencies/blocked_by`,
  ], runner);
  return JSON.parse(stdout) as GhDependencyIssue[];
}

/** Applies a model-tier label to an issue. */
export async function applyIssueLabel(
  repo: string,
  number: number,
  label: string,
  runner: CommandRunner = runGhCommand,
): Promise<void> {
  await runGh([
    "issue",
    "edit",
    String(number),
    "--repo",
    `${REPO_OWNER}/${repo}`,
    "--add-label",
    label,
  ], runner);
}

/** Scans labels, issues, and PRs for a single repository. */
export async function scanRepo(
  repo: string,
  runner: CommandRunner = runGhCommand,
): Promise<RepoScanResult> {
  const [labels, issues, prs] = await Promise.all([
    fetchRepoLabels(repo, runner),
    fetchRepoIssues(repo, runner),
    fetchRepoPrs(repo, runner),
  ]);
  return { repo, labels, issues, prs };
}

/** Scans all active repositories. */
export async function scanAllRepos(
  repos: readonly string[] = ACTIVE_REPOS,
  runner: CommandRunner = runGhCommand,
): Promise<RepoScanResult[]> {
  const results: RepoScanResult[] = [];
  for (const repo of repos) {
    results.push(await scanRepo(repo, runner));
  }
  return results;
}
