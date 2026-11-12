/** Shared lookup, mutation and CLI handling for existing issues' blocked-by links. */
import { type RunCmd, runWithRetry } from "./gh_runner.ts";

type Action = "block" | "unblock";

export interface Deps {
  runCmd: RunCmd;
  sleep?: (ms: number) => Promise<void>;
}

export interface DependencyOptions {
  repo: string;
  issue: number;
  blocker: string;
  dryRun: boolean;
}

interface IssueRef {
  repo: string;
  number: number;
}

interface Issue extends IssueRef {
  id: number;
  title: string;
}

const REPO = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/;
const CROSS_REPO_ISSUE = /^([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;

function validateRepo(repo: string): void {
  if (!REPO.test(repo) || [".", ".."].includes(repo.split("/")[1])) {
    throw new Error("--repo must be owner/repo without path traversal");
  }
}

function issueNumber(raw: string): number {
  const n = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(n)) {
    throw new Error(`Invalid issue number: ${raw}`);
  }
  return n;
}

function blockerRef(raw: string, repo: string): IssueRef {
  const crossRepo = CROSS_REPO_ISSUE.exec(raw);
  if (crossRepo) validateRepo(crossRepo[1]);
  return crossRepo
    ? { repo: crossRepo[1], number: issueNumber(crossRepo[2]) }
    : { repo, number: issueNumber(raw) };
}

export function parseArgs(args: string[]): DependencyOptions {
  const values = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    const separator = arg.indexOf("=");
    const key = separator < 0 ? arg : arg.slice(0, separator);
    if (!["--repo", "--issue", "--blocker"].includes(key) || values.has(key)) {
      throw new Error(`Unknown or repeated argument: ${arg}`);
    }
    const value = separator < 0 ? args[++i] : arg.slice(separator + 1);
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    values.set(key, value);
  }
  const repo = values.get("--repo");
  const issue = values.get("--issue");
  const blocker = values.get("--blocker");
  if (!repo || !issue || !blocker) throw new Error("--repo, --issue and --blocker are required");
  validateRepo(repo);
  blockerRef(blocker, repo);
  return { repo, issue: issueNumber(issue), blocker, dryRun };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIssue(value: unknown): value is { id: number; number: number; title: string } {
  return record(value) && Number.isSafeInteger(value.id) && Number(value.id) > 0 &&
    Number.isSafeInteger(value.number) && Number(value.number) > 0 &&
    typeof value.title === "string" && !("pull_request" in value);
}

async function readJson(cmd: string[], deps: Deps): Promise<unknown> {
  const result = await deps.runCmd(cmd);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "GitHub lookup failed");
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("GitHub lookup returned unreadable JSON");
  }
}

async function readIssue(ref: IssueRef, deps: Deps): Promise<Issue> {
  const value = await readJson(["gh", "api", `repos/${ref.repo}/issues/${ref.number}`], deps);
  if (!isIssue(value) || value.number !== ref.number) {
    throw new Error(`Unreadable issue response for ${ref.repo}#${ref.number}`);
  }
  return { ...ref, id: value.id, title: value.title };
}

function citation(issue: Issue): string {
  return `${issue.repo}#${issue.number} ${JSON.stringify(issue.title)}`;
}

/**
 * Changes exactly one link after all lookups succeed. Shared with callers that already
 * have an approved plan; this function does not decide whether a link should exist.
 */
export async function changeIssueDependency(
  action: Action,
  opts: DependencyOptions,
  deps: Deps,
): Promise<{ issue: Issue; blocker: Issue; undo: string }> {
  validateRepo(opts.repo);
  issueNumber(String(opts.issue));
  const blockingRef = blockerRef(opts.blocker, opts.repo);
  const issue = await readIssue({ repo: opts.repo, number: opts.issue }, deps);
  const blocker = await readIssue(blockingRef, deps);
  const endpoint = `repos/${issue.repo}/issues/${issue.number}/dependencies/blocked_by`;
  // --slurp preserves page boundaries, letting us reject incomplete/malformed replies.
  const pages = await readJson(["gh", "api", "--paginate", "--slurp", endpoint], deps);
  if (
    !Array.isArray(pages) || pages.length === 0 ||
    !pages.every((page) => Array.isArray(page) && page.every(isIssue))
  ) {
    throw new Error(`Unreadable dependencies response for ${citation(issue)}`);
  }
  // GitHub IDs are global. A same-number issue in another repo is a different link.
  const present = pages.some((page) =>
    page.some((entry: { id: number }) => entry.id === blocker.id)
  );
  if (action === "block" ? present : !present) {
    throw new Error(
      `${citation(issue)} ${present ? "is already" : "is not"} blocked by ${
        citation(blocker)
      }; nothing changed`,
    );
  }

  if (!opts.dryRun) {
    const cmd = action === "block"
      ? ["gh", "api", "--method", "POST", endpoint, "-F", `issue_id=${blocker.id}`]
      : ["gh", "api", "--method", "DELETE", `${endpoint}/${blocker.id}`];
    const result = await runWithRetry(deps.runCmd, cmd, { sleep: deps.sleep });
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "GitHub refused the dependency change");
    }
  }

  const blockerArg = blocker.repo.toLowerCase() === issue.repo.toLowerCase()
    ? String(blocker.number)
    : `${blocker.repo}#${blocker.number}`;
  return {
    issue,
    blocker,
    undo: `deno task ${
      action === "block" ? "unblock" : "block"
    }-issue --repo ${issue.repo} --issue ${issue.number} --blocker ${blockerArg}`,
  };
}

export async function runDependencyCommand(
  action: Action,
  args: string[],
  deps: Deps,
): Promise<number> {
  const usage =
    `usage: deno task ${action}-issue --repo <owner/repo> --issue <n> --blocker <m|owner/repo#m> [--dry-run]`;
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return 0;
  }
  let opts: DependencyOptions;
  try {
    opts = parseArgs(args);
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${usage}`);
    return 1;
  }
  try {
    const result = await changeIssueDependency(action, opts, deps);
    console.log(
      `${opts.dryRun ? "dry run: would " : ""}${
        action === "block" ? "add" : "remove"
      } blocked-by link: ${citation(result.issue)} ${
        action === "block" ? "blocked by" : "no longer blocked by"
      } ${citation(result.blocker)}`,
    );
    console.log(`${opts.dryRun ? "After applying, undo with" : "Undo"}: ${result.undo}`);
    return 0;
  } catch (error) {
    console.error(`Refused: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export async function realRunCmd(cmd: string[]) {
  const { code, stdout, stderr } = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}
