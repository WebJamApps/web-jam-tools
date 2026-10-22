import { ACTIVE_REPOS, type CommandRunner, REPO_OWNER } from "../shared/repos.ts";
import { issueFacts, type JsonObject, object, readArray, runGh } from "./github.ts";
import type { IssueFacts } from "./rank.ts";

export interface CollectedIssue {
  issue: JsonObject;
  blockers: JsonObject[];
  blocking: JsonObject[];
  children: JsonObject[];
  parent: JsonObject | null;
}
export interface RepositorySnapshot {
  repo: string;
  issues: CollectedIssue[];
  milestones: JsonObject[];
}
export interface Snapshot {
  schemaVersion: 1;
  owner: typeof REPO_OWNER;
  startedAt: string;
  completedAt: string;
  requests: number;
  repositories: RepositorySnapshot[];
}

/** One shared semaphore bounds subprocesses across all repos and relationship reads. */
export function limitRunner(runner: CommandRunner, concurrency: number): CommandRunner {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("Concurrency must be an integer from 1 to 16");
  }
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (args) => {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await runner(args);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

function emptySummary(issue: JsonObject, summary: string, count: string): boolean {
  const value = issue[summary];
  if (value === undefined || value === null) return false;
  const total = object(value)[count];
  if (total === undefined) return false;
  if (!Number.isSafeInteger(total) || (total as number) < 0) {
    throw new Error(`Malformed ${summary}.${count}`);
  }
  return total === 0;
}

async function readParent(path: string, runner: CommandRunner): Promise<JsonObject | null> {
  const result = await runner(["api", `${path}/parent`, "--method", "GET"]);
  if (result.code !== 0) {
    // gh's HTTP response body establishes absence; arbitrary failures never mean no parent.
    try {
      if (object(JSON.parse(result.stdout)).status === "404") return null;
    } catch { /* Report the failed read below. */ }
    throw new Error(`GitHub parent read failed for ${path} (exit ${result.code})`);
  }
  return object(JSON.parse(result.stdout));
}

export async function collectSnapshot(
  runner: CommandRunner = runGh,
  concurrency = 6,
  now: () => Date = () => new Date(),
): Promise<Snapshot> {
  const startedAt = now().toISOString();
  let requests = 0;
  const limited = limitRunner((args) => {
    requests++;
    return runner(args);
  }, concurrency);
  const repositories = await Promise.all(ACTIVE_REPOS.map(async (repo) => {
    const root = `repos/${REPO_OWNER}/${repo}`;
    const [raw, milestones] = await Promise.all([
      readArray(`${root}/issues?state=open&per_page=100`, limited),
      readArray(`${root}/milestones?state=all&per_page=100`, limited),
    ]);
    const issues = await Promise.all(
      raw.filter((issue) => !issue.pull_request).map(async (issue) => {
        if (
          issue.state !== "open" || !Number.isSafeInteger(issue.number) ||
          (issue.number as number) < 1
        ) {
          throw new Error(`Invalid open issue in ${repo}`);
        }
        const path = `${root}/issues/${issue.number}`;
        const relation = (summary: string, count: string, suffix: string) =>
          emptySummary(issue, summary, count)
            ? Promise.resolve([])
            : readArray(`${path}/${suffix}?per_page=100`, limited);
        const [blockers, blocking, children, parent] = await Promise.all([
          relation("issue_dependencies_summary", "blocked_by", "dependencies/blocked_by"),
          relation("issue_dependencies_summary", "blocking", "dependencies/blocking"),
          relation("sub_issues_summary", "total", "sub_issues"),
          readParent(path, limited),
        ]);
        return { issue, blockers, blocking, children, parent };
      }),
    );
    return { repo, issues, milestones };
  }));
  const snapshot: Snapshot = {
    schemaVersion: 1,
    owner: REPO_OWNER,
    startedAt,
    completedAt: now().toISOString(),
    requests,
    repositories,
  };
  return validateSnapshot(snapshot, now());
}

function validateIssue(issue: JsonObject): void {
  issueFacts(issue, [], [], []);
  if (issue.body !== null && typeof issue.body !== "string") {
    throw new Error(`Missing issue body for ${issue.repository_url}#${issue.number}`);
  }
  for (const field of ["html_url", "repository_url"]) {
    if (typeof issue[field] !== "string") throw new Error(`Missing issue ${field}`);
  }
  if (
    !Object.hasOwn(issue, "type") ||
    (issue.type !== null && typeof object(issue.type).name !== "string")
  ) {
    throw new Error("Missing or malformed native Type");
  }
  if (issue.state !== "open" && issue.state !== "closed") throw new Error("Invalid issue state");
  if (!Number.isFinite(Date.parse(String(issue.updated_at)))) {
    throw new Error("Invalid issue timestamp");
  }
  if (
    !/^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
      String(issue.repository_url),
    )
  ) throw new Error("Invalid issue repository identity");
}

/** Snapshots are single-run inputs, never approval records. Recollect after one hour. */
export function validateSnapshot(value: unknown, now = new Date()): Snapshot {
  const snapshot = object(value);
  if (snapshot.schemaVersion !== 1 || snapshot.owner !== REPO_OWNER) {
    throw new Error("Invalid snapshot identity/schema");
  }
  const started = Date.parse(String(snapshot.startedAt));
  const completed = Date.parse(String(snapshot.completedAt));
  if (
    !Number.isFinite(started) || !Number.isFinite(completed) ||
    new Date(started).toISOString() !== snapshot.startedAt ||
    new Date(completed).toISOString() !== snapshot.completedAt || completed < started ||
    completed > now.getTime() + 60_000 || now.getTime() - started > 3_600_000
  ) {
    throw new Error("Snapshot is stale or has invalid timestamps; collect again");
  }
  if (!Number.isSafeInteger(snapshot.requests) || (snapshot.requests as number) < 16) {
    throw new Error("Invalid snapshot request count");
  }
  if (
    !Array.isArray(snapshot.repositories) || snapshot.repositories.length !== ACTIVE_REPOS.length
  ) throw new Error("Incomplete snapshot repositories");
  const seen = new Set<string>();
  for (const raw of snapshot.repositories) {
    const repository = object(raw);
    const repo = String(repository.repo);
    if (!ACTIVE_REPOS.some((active) => active === repo) || seen.has(repo)) {
      throw new Error("Invalid or duplicate snapshot repo");
    }
    seen.add(repo);
    if (!Array.isArray(repository.issues) || !Array.isArray(repository.milestones)) {
      throw new Error("Incomplete repository snapshot");
    }
    for (const milestone of repository.milestones) {
      if (typeof object(milestone).title !== "string") throw new Error("Invalid milestone");
    }
    const numbers = new Set<number>();
    for (const rawIssue of repository.issues) {
      const row = object(rawIssue);
      const issue = object(row.issue);
      validateIssue(issue);
      if (
        issue.state !== "open" || issue.pull_request ||
        issue.repository_url !== `https://api.github.com/repos/${REPO_OWNER}/${repo}` ||
        numbers.has(issue.number as number)
      ) throw new Error("Invalid snapshot issue identity");
      numbers.add(issue.number as number);
      for (const relation of ["blockers", "blocking", "children"]) {
        if (!Array.isArray(row[relation])) throw new Error(`Missing ${relation}`);
        for (const related of row[relation] as unknown[]) validateIssue(object(related));
      }
      if (row.parent !== null) validateIssue(object(row.parent));
    }
  }
  return snapshot as unknown as Snapshot;
}

export function repositoryFacts(
  snapshot: Snapshot,
  repo: string,
): { issues: IssueFacts[]; milestones: string[] } {
  const repository = snapshot.repositories.find((item) => item.repo === repo);
  if (!repository) throw new Error("Repository absent from snapshot");
  return {
    issues: repository.issues.map(({ issue, children, blockers, blocking }) =>
      issueFacts(issue, children, blockers, blocking)
    ),
    milestones: repository.milestones.map((milestone) => milestone.title as string),
  };
}

export function snapshotPath(path: string): string {
  if (!/^\/tmp\/backlog-groom\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/.test(path)) {
    throw new Error("Use a JSON file under /tmp/backlog-groom; traversal is refused");
  }
  return path;
}

async function safeRead(path: string): Promise<string> {
  if (await Deno.realPath(path) !== path) {
    throw new Error("Snapshot path must not contain symlinks");
  }
  return await Deno.readTextFile(path);
}

export async function readSnapshot(
  path: string,
  read: (path: string) => Promise<string> = safeRead,
): Promise<Snapshot> {
  return validateSnapshot(JSON.parse(await read(snapshotPath(path))));
}
