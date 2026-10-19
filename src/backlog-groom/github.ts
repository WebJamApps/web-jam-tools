import { ACTIVE_REPOS, type CommandRunner, REPO_OWNER } from "../shared/repos.ts";
import { isPriority, type IssueFacts, type Priority } from "./rank.ts";

export type JsonObject = Record<string, unknown>;

export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a GitHub object");
  }
  return value as JsonObject;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected a GitHub array");
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a GitHub string");
  return value;
}

function number(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error("Expected a positive GitHub issue number");
  }
  return value as number;
}

function labels(issue: JsonObject): string[] {
  return array(issue.labels).map((label) =>
    typeof label === "string" ? label : text(object(label).name)
  );
}

function open(issue: JsonObject): boolean {
  if (issue.state !== "open" && issue.state !== "closed") {
    throw new Error("Missing GitHub issue state");
  }
  return issue.state === "open";
}

function priority(issue: JsonObject): Priority | null {
  const fields = array(issue.issue_field_values);
  const field = fields.map(object).find((field) => field.issue_field_name === "Priority");
  if (!field) return null;
  if (field.single_select_option === null || field.single_select_option === undefined) {
    if (field.value === null || field.value === undefined) return null;
    throw new Error("Native Priority option could not be read");
  }
  const value = object(field.single_select_option).name;
  if (!isPriority(value)) throw new Error("Unknown native Priority value");
  return value;
}

export async function readArray(path: string, runner: CommandRunner): Promise<JsonObject[]> {
  const result = await runner([
    "api",
    path,
    "--method",
    "GET",
    "--paginate",
    "--slurp",
  ]);
  if (result.code !== 0) {
    throw new Error(`GitHub read failed for ${path} (exit ${result.code})`);
  }
  try {
    return array(JSON.parse(result.stdout)).flatMap((page) => array(page).map(object));
  } catch {
    throw new Error(`Invalid GitHub response for ${path}`);
  }
}

export const runGh: CommandRunner = async (args) => {
  const { code, stdout, stderr } = await new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return { code, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) };
};

export async function readRepository(
  repo: string,
  runner: CommandRunner = runGh,
): Promise<{ issues: IssueFacts[]; milestones: string[] }> {
  if (!ACTIVE_REPOS.some((active) => active === repo)) {
    throw new Error("Name one active WebJamApps repo");
  }
  const root = `repos/${REPO_OWNER}/${repo}`;
  const raw = await readArray(`${root}/issues?state=open&per_page=100`, runner);
  const milestones = (await readArray(`${root}/milestones?state=all&per_page=100`, runner))
    .map((milestone) => text(milestone.title));
  const issues: IssueFacts[] = [];
  for (const issue of raw) {
    if (issue.pull_request || !open(issue)) continue;
    const issueNumber = number(issue.number);
    const path = `${root}/issues/${issueNumber}`;
    const epic = issue.type !== null && issue.type !== undefined &&
      object(issue.type).name === "Epic";
    const children = epic ? await readArray(`${path}/sub_issues?per_page=100`, runner) : [];
    const blockers = epic
      ? []
      : await readArray(`${path}/dependencies/blocked_by?per_page=100`, runner);
    const waiting = epic
      ? []
      : await readArray(`${path}/dependencies/blocking?per_page=100`, runner);
    issues.push(issueFacts(issue, children, blockers, waiting));
  }
  return { issues, milestones };
}

export function issueFacts(
  issue: JsonObject,
  children: JsonObject[],
  blockers: JsonObject[],
  waiting: JsonObject[],
): IssueFacts {
  const issueNumber = number(issue.number);
  const issueLabels = labels(issue);
  const epic = issue.type !== null && issue.type !== undefined &&
    object(issue.type).name === "Epic";
  return {
    number: issueNumber,
    title: text(issue.title),
    updatedAt: text(issue.updated_at),
    milestone: issue.milestone === null ? null : text(object(issue.milestone).title),
    priority: priority(issue),
    epic,
    labels: issueLabels,
    openWaiting: waiting.filter(open).length,
    blockedByOpen: blockers.some(open),
    children: children.filter(open)
      .map((child) => ({ number: number(child.number), priority: priority(child) })),
  };
}
