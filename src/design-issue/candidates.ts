// src/design-issue/candidates.ts
// Helper script for scanning active WebJamApps repositories for open issues labeled "Needs Design" (web-jam-tools#745).

import { parseArgs } from "@std/cli/parse-args";
import {
  ACTIVE_REPOS,
  type CommandResult,
  type CommandRunner,
  REPO_OWNER,
} from "../shared/repos.ts";
import {
  DesignDocResolutionRefusal,
  type ExistingDesignDocMatch,
  type FindDesignDocOptions,
  findExistingDesignDoc,
  formatCanonicalDesignDocResolution,
  resolveCanonicalDesignDoc,
} from "./gate1.ts";

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
  dropboxDir?: string;
  findDesignDocImpl?: (options: FindDesignDocOptions) => Promise<ExistingDesignDocMatch | null>;
  annotateExisting?: boolean;
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
  const errorLog = options.errorLog ?? console.error;
  const runner = options.runner ?? defaultCommandRunner;
  const finder = options.findDesignDocImpl ?? findExistingDesignDoc;

  const flags = parseArgs(args, {
    boolean: ["help", "find-existing"],
    string: ["epic", "issue", "topic", "theme", "dropbox-dir"],
    alias: {
      h: "help",
    },
    default: {
      help: false,
      "find-existing": false,
    },
  });

  if (flags.help) {
    log(`Usage: deno task design:candidates [options] [epic-citation | topic]

Scans all active WebJamApps repositories for open issues labeled 'Needs Design'
and matches pre-existing canonical design documents in Dropbox for Major Revisions.

Options:
  --epic <citation>     Resolve canonical design document for an Epic and prompt for Major Revision
  --topic <topic>       Look up a path, issue citation or whole topic
  --theme <theme>       Scope design document search to a specific theme directory
  --dropbox-dir <path>  Override the design-documents root (also DESIGN_DOCS_ROOT)
  -h, --help            Show this help message

When resolving a topic or Epic, this is the canonical-document precondition of a design run:
it runs before any decision is put to Josh, and exits 2 (REFUSED, naming the path) rather than
reporting "no existing design document" when it cannot tell whether one exists.`);
    return 0;
  }

  // Check if an epic or topic query was explicitly passed
  const targetQuery = flags.epic || flags.topic || flags.issue ||
    flags._.map(String).join(" ");
  if (
    !targetQuery &&
    (flags.epic !== undefined || flags.issue !== undefined || flags.topic !== undefined)
  ) {
    errorLog("Usage: deno task design:candidates --epic <citation>");
    return 1;
  }

  if (targetQuery) {
    let resolution;
    try {
      resolution = await resolveCanonicalDesignDoc({
        title: targetQuery,
        theme: flags.theme,
        runner,
        dropboxDir: flags["dropbox-dir"] || options.dropboxDir,
      });
    } catch (err) {
      if (err instanceof DesignDocResolutionRefusal) {
        errorLog(`[design:candidates] ${err.message}`);
        return 2;
      }
      errorLog(
        `[design:candidates] could not tell: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 2;
    }

    for (const line of formatCanonicalDesignDocResolution(resolution, "[design:candidates]")) {
      log(line);
    }

    if (resolution.outcome === "existing-document" && resolution.match) {
      log(`[design:candidates] Suggested action: Major Revision to existing design document.`);
      log(resolution.match.suggestion);
      return 0;
    }

    return 2;
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
    let match: ExistingDesignDocMatch | null = null;
    if (options.annotateExisting === true || flags["find-existing"]) {
      match = await finder({
        title: issue.title,
        dropboxDir: options.dropboxDir,
      });
    }
    if (match) {
      log(
        `${
          formatCandidateCitation(issue)
        }\n  -> Matches existing design doc: ${match.path} (Propose Major Revision)`,
      );
    } else {
      log(formatCandidateCitation(issue));
    }
  }

  return 0;
}
