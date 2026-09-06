#!/usr/bin/env -S deno run --allow-run=gh
// scripts/sweep_redundant_blocked_labels.ts
//
// Sweeps open issues across all 8 active WebJamApps repositories to detect
// and remove redundant `Blocked` labels from issues that carry native GitHub
// issue dependencies (`dependencies/blocked_by`).
//
// Per web-jam-tools#725 / web-jam-tools#730:
// - Native GitHub dependencies are the single source of truth for issue-to-issue blockers.
// - The `Blocked` label is reserved exclusively for external/non-issue blockers.

export const ACTIVE_REPOS = [
  "JaMmusic",
  "CollegeLutheran",
  "AppersonAuto",
  "TimShermanMusic",
  "HenricksonForSalem",
  "web-jam-back",
  "WebJamSocketCluster",
  "web-jam-tools",
] as const;

export const REPO_OWNER = "WebJamApps";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (args: string[]) => Promise<CommandResult>;

export const defaultRunner: CommandRunner = async (args: string[]): Promise<CommandResult> => {
  const cmd = new Deno.Command("gh", { args, stdout: "piped", stderr: "piped" });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
};

export interface GhBlockedIssue {
  number: number;
  title: string;
  url: string;
  labels: Array<{ name: string }>;
}

export interface GhDependency {
  number: number;
  state?: string;
  title?: string;
  repository?: { full_name?: string; name?: string };
}

export type ActionStatus = "removed" | "would_remove" | "kept_external";

export interface SweepItem {
  repo: string;
  number: number;
  title: string;
  url: string;
  nativeBlockers: number[];
  isRedundant: boolean;
  actionTaken: ActionStatus;
}

export interface CliOptions {
  apply: boolean;
  repos: string[];
  help: boolean;
}

export interface SweepSummary {
  items: SweepItem[];
  totalExamined: number;
  totalRedundant: number;
  totalModified: number;
  totalKept: number;
  applied: boolean;
}

export function parseCliArgs(args: string[]): CliOptions {
  let apply = false;
  let help = false;
  const repos: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--dry-run") {
      apply = false;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--repo") {
      const next = args[++i];
      if (next) {
        repos.push(next.replace(/^WebJamApps\//, ""));
      }
    } else if (arg.startsWith("--repo=")) {
      const val = arg.slice("--repo=".length).replace(/^WebJamApps\//, "");
      if (val) {
        repos.push(val);
      }
    }
  }

  return {
    apply,
    repos: repos.length > 0 ? repos : [...ACTIVE_REPOS],
    help,
  };
}

export async function fetchBlockedIssues(
  repo: string,
  runner: CommandRunner = defaultRunner,
): Promise<GhBlockedIssue[]> {
  const { code, stdout, stderr } = await runner([
    "issue",
    "list",
    "--repo",
    `${REPO_OWNER}/${repo}`,
    "--state",
    "open",
    "--label",
    "Blocked",
    "--limit",
    "200",
    "--json",
    "number,title,labels,url",
  ]);

  if (code !== 0) {
    throw new Error(`Failed to list Blocked issues for ${repo}: ${stderr.trim()}`);
  }

  if (!stdout.trim()) {
    return [];
  }

  return JSON.parse(stdout) as GhBlockedIssue[];
}

export async function fetchBlockedByDependencies(
  repo: string,
  issueNumber: number,
  runner: CommandRunner = defaultRunner,
): Promise<GhDependency[]> {
  const { code, stdout, stderr } = await runner([
    "api",
    `repos/${REPO_OWNER}/${repo}/issues/${issueNumber}/dependencies/blocked_by`,
  ]);

  if (code !== 0) {
    throw new Error(
      `Failed to fetch blocked_by dependencies for ${repo}#${issueNumber}: ${stderr.trim()}`,
    );
  }

  if (!stdout.trim()) {
    return [];
  }

  return JSON.parse(stdout) as GhDependency[];
}

export async function removeBlockedLabel(
  repo: string,
  issueNumber: number,
  runner: CommandRunner = defaultRunner,
): Promise<void> {
  const { code, stderr } = await runner([
    "issue",
    "edit",
    String(issueNumber),
    "--repo",
    `${REPO_OWNER}/${repo}`,
    "--remove-label",
    "Blocked",
  ]);

  if (code !== 0) {
    throw new Error(
      `Failed to remove Blocked label from ${repo}#${issueNumber}: ${stderr.trim()}`,
    );
  }
}

export async function sweepRepo(
  repo: string,
  options: { apply: boolean },
  runner: CommandRunner = defaultRunner,
): Promise<SweepItem[]> {
  const issues = await fetchBlockedIssues(repo, runner);
  const items: SweepItem[] = [];

  for (const issue of issues) {
    const dependencies = await fetchBlockedByDependencies(repo, issue.number, runner);
    const nativeBlockers = dependencies.map((d) => d.number);
    const isRedundant = nativeBlockers.length > 0;

    let actionTaken: ActionStatus = "kept_external";
    if (isRedundant) {
      if (options.apply) {
        await removeBlockedLabel(repo, issue.number, runner);
        actionTaken = "removed";
      } else {
        actionTaken = "would_remove";
      }
    }

    items.push({
      repo,
      number: issue.number,
      title: issue.title,
      url: issue.url,
      nativeBlockers,
      isRedundant,
      actionTaken,
    });
  }

  return items;
}

export async function sweepAll(
  repos: readonly string[],
  options: { apply: boolean },
  runner: CommandRunner = defaultRunner,
): Promise<SweepSummary> {
  const items: SweepItem[] = [];

  for (const repo of repos) {
    const repoItems = await sweepRepo(repo, options, runner);
    items.push(...repoItems);
  }

  const totalExamined = items.length;
  const totalRedundant = items.filter((i) => i.isRedundant).length;
  const totalModified = items.filter((i) => i.actionTaken === "removed").length;
  const totalKept = items.filter((i) => i.actionTaken === "kept_external").length;

  return {
    items,
    totalExamined,
    totalRedundant,
    totalModified,
    totalKept,
    applied: options.apply,
  };
}

export function formatSummaryTable(summary: SweepSummary): string {
  const lines: string[] = [];
  lines.push("## Sweep Redundant Blocked Labels Summary");
  lines.push(`Mode: **${summary.applied ? "APPLY" : "DRY RUN"}**`);
  lines.push("");

  if (summary.items.length === 0) {
    lines.push("No open issues with `Blocked` label found.");
    return lines.join("\n");
  }

  lines.push("| Repo | Issue | Title | Native Blockers | Action / Status |");
  lines.push("| --- | --- | --- | --- | --- |");

  for (const item of summary.items) {
    const blockerText = item.nativeBlockers.length > 0
      ? item.nativeBlockers.map((b) => `#${b}`).join(", ")
      : "*(none — external)*";

    let statusText = "";
    if (item.actionTaken === "removed") {
      statusText = "✅ **REMOVED**";
    } else if (item.actionTaken === "would_remove") {
      statusText = "⚠️ **WOULD REMOVE (Dry Run)**";
    } else {
      statusText = "🔒 **KEPT (External Blocker)**";
    }

    lines.push(
      `| \`${item.repo}\` | #${item.number} | ${
        item.title.replace(/\|/g, "\\|")
      } | ${blockerText} | ${statusText} |`,
    );
  }

  lines.push("");
  lines.push("### Totals");
  lines.push(`- **Total Blocked issues examined**: ${summary.totalExamined}`);
  lines.push(`- **Redundant Blocked labels identified**: ${summary.totalRedundant}`);
  if (summary.applied) {
    lines.push(`- **Blocked labels removed**: ${summary.totalModified}`);
  } else {
    lines.push(`- **Blocked labels to remove on --apply**: ${summary.totalRedundant}`);
  }
  lines.push(`- **External blockers preserved**: ${summary.totalKept}`);

  return lines.join("\n");
}

export async function main(
  args: string[] = Deno.args,
  runner: CommandRunner = defaultRunner,
): Promise<void> {
  const options = parseCliArgs(args);

  if (options.help) {
    console.log(`Usage: deno task sweep:redundant-blocked-labels [options]

Options:
  --dry-run   Simulate the sweep without modifying issues (default)
  --apply     Remove redundant Blocked labels via GitHub CLI
  --repo <r>  Limit sweep to a specific repository (e.g. JaMmusic)
  --help, -h  Show this help message
`);
    return;
  }

  console.log(
    `Starting Blocked label sweep across ${options.repos.length} repos (mode: ${
      options.apply ? "APPLY" : "DRY RUN"
    })...\n`,
  );

  const summary = await sweepAll(options.repos, { apply: options.apply }, runner);
  const formatted = formatSummaryTable(summary);
  console.log(formatted);
}

if (import.meta.main) {
  await main();
}
