// src/design-issue/candidates.ts
// Helper script for scanning active WebJamApps repositories for open issues labeled "Needs Design" (web-jam-tools#745).

import {
  ACTIVE_REPOS,
  type CommandResult,
  type CommandRunner,
  REPO_OWNER,
} from "../flash-issues/types.ts";

export interface NeedsDesignIssue {
  repo: string;
  number: number;
  title: string;
  url?: string;
  labels?: Array<{ name: string }>;
}

export interface ScanCandidatesOptions {
  runner?: CommandRunner;
  repos?: readonly string[];
  owner?: string;
  log?: (msg: string) => void;
  errorLog?: (msg: string) => void;
}

export interface ScanCandidatesResult {
  issues: NeedsDesignIssue[];
  errors: Array<{ repo: string; error: string }>;
}

export const defaultCommandRunner: CommandRunner = async (
  args: string[],
): Promise<CommandResult> => {
  const cmd = new Deno.Command("gh", { args, stdout: "piped", stderr: "piped" });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
};

export async function scanNeedsDesignCandidates(
  options: ScanCandidatesOptions = {},
): Promise<ScanCandidatesResult> {
  const runner = options.runner ?? defaultCommandRunner;
  const repos = options.repos ?? ACTIVE_REPOS;
  const owner = options.owner ?? REPO_OWNER;
  const errorLog = options.errorLog ?? console.error;

  const issues: NeedsDesignIssue[] = [];
  const errors: Array<{ repo: string; error: string }> = [];

  for (const repo of repos) {
    try {
      const result = await runner([
        "issue",
        "list",
        "--repo",
        `${owner}/${repo}`,
        "--state",
        "open",
        "--label",
        "Needs Design",
        "--json",
        "number,title,labels,url",
      ]);

      if (result.code !== 0) {
        const errorMsg = result.stderr.trim() || `Command failed with exit code ${result.code}`;
        errors.push({ repo, error: errorMsg });
        errorLog(`[design:candidates] Warning: Failed to query ${repo}: ${errorMsg}`);
        continue;
      }

      const trimmed = result.stdout.trim();
      if (!trimmed) {
        continue;
      }

      const parsed = JSON.parse(trimmed) as Array<{
        number: number;
        title: string;
        labels?: Array<{ name: string }>;
        url?: string;
      }>;

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          issues.push({
            repo,
            number: item.number,
            title: item.title,
            url: item.url,
            labels: item.labels,
          });
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      errors.push({ repo, error: errorMsg });
      errorLog(`[design:candidates] Warning: Error querying ${repo}: ${errorMsg}`);
    }
  }

  return { issues, errors };
}

export function formatCandidateCitation(issue: NeedsDesignIssue): string {
  return `${issue.repo}#${issue.number} "${issue.title}"`;
}

export async function runCandidatesCli(
  args: string[] = [],
  options: ScanCandidatesOptions = {},
): Promise<number> {
  const log = options.log ?? console.log;

  if (args.includes("--help") || args.includes("-h")) {
    log(`Usage: deno task design:candidates

Scans all active WebJamApps repositories for open issues labeled 'Needs Design'
and prints candidate issue citations.`);
    return 0;
  }

  const { issues } = await scanNeedsDesignCandidates(options);

  if (issues.length === 0) {
    log(
      "No open 'Needs Design' candidate issues found across active repositories (0 candidates found).",
    );
    return 0;
  }

  log(
    `Found ${issues.length} open 'Needs Design' candidate issue${issues.length === 1 ? "" : "s"}:`,
  );
  for (const issue of issues) {
    log(formatCandidateCitation(issue));
  }

  return 0;
}
