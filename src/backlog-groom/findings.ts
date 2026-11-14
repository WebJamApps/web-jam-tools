/** Versioned proposals shared by filtering, reporting, and the later apply command. */
import { dirname } from "@std/path";
import { ACTIVE_REPOS } from "../shared/repos.ts";
import { isPriority, type Priority } from "./rank.ts";
import { snapshotPath } from "./snapshot.ts";

export interface IssueReference {
  /** Fully qualified owner/repository for cross-repository relationships. */
  repo: string;
  number: number;
}

const ISSUE_TYPES = ["Task", "Bug", "Feature", "Epic"] as const;
type IssueType = typeof ISSUE_TYPES[number];

export type FindingChange =
  | { kind: "labels"; remove: string[]; add: string[] }
  | { kind: "milestone"; before: string | null; after: string }
  | { kind: "type"; before: IssueType | null; after: IssueType }
  | { kind: "priority"; before: Priority | null; after: Priority }
  | { kind: "parent"; before: IssueReference | null; after: IssueReference }
  | { kind: "blocked-by"; issue: IssueReference; before: boolean; after: boolean }
  | { kind: "body"; beforeSha256: string; bodyFile: string };

export interface Finding {
  /** Unique across the main list and the Flash batch; never renumbered by filtering. */
  number: number;
  repo: typeof ACTIVE_REPOS[number];
  issue: number;
  category: string;
  finding: string;
  reason: string;
  changes: FindingChange[];
  /** A proposed close is displayed separately, never represented as an apply change. */
  proposedClose?: boolean;
}

export interface FindingsFile {
  schemaVersion: 1;
  items: Finding[];
  flashBatch: Finding[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a findings object");
  }
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("Unknown findings field");
  }
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function number(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function reference(value: unknown): boolean {
  const ref = record(value);
  fields(ref, ["repo", "number"]);
  return text(ref.repo) && /^[\w.-]+\/[\w.-]+$/.test(ref.repo) && number(ref.number);
}

function labels(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
}

function validateChange(value: unknown): void {
  const change = record(value);
  let valid: boolean;
  switch (change.kind) {
    case "labels":
      fields(change, ["kind", "remove", "add"]);
      valid = labels(change.remove) && labels(change.add) &&
        change.remove.length + change.add.length > 0 &&
        !change.remove.some((label) => (change.add as string[]).includes(label));
      break;
    case "milestone":
      fields(change, ["kind", "before", "after"]);
      valid = (change.before === null || text(change.before)) && text(change.after);
      break;
    case "type":
      fields(change, ["kind", "before", "after"]);
      valid = (change.before === null || ISSUE_TYPES.some((type) => type === change.before)) &&
        ISSUE_TYPES.some((type) => type === change.after);
      break;
    case "priority":
      fields(change, ["kind", "before", "after"]);
      valid = (change.before === null || isPriority(change.before)) && isPriority(change.after);
      break;
    case "parent":
      fields(change, ["kind", "before", "after"]);
      valid = (change.before === null || reference(change.before)) && reference(change.after);
      break;
    case "blocked-by":
      fields(change, ["kind", "issue", "before", "after"]);
      valid = reference(change.issue) && typeof change.before === "boolean" &&
        typeof change.after === "boolean" && change.before !== change.after;
      break;
    case "body":
      fields(change, ["kind", "beforeSha256", "bodyFile"]);
      valid = typeof change.beforeSha256 === "string" &&
        /^[a-fA-F0-9]{64}$/.test(change.beforeSha256) && text(change.bodyFile);
      break;
    default:
      throw new Error(`Unknown findings change kind: ${change.kind}`);
  }
  if (!valid) throw new Error(`Invalid ${change.kind} change`);
}

function validateItem(value: unknown, seen: Set<number>): Finding {
  const item = record(value);
  fields(item, [
    "number",
    "repo",
    "issue",
    "category",
    "finding",
    "reason",
    "changes",
    "proposedClose",
  ]);
  if (
    !number(item.number) || seen.has(item.number) || !number(item.issue) ||
    !ACTIVE_REPOS.some((repo) => repo === item.repo) || !text(item.category) ||
    !text(item.finding) || !text(item.reason) || /[\r\n]/.test(item.reason) ||
    !Array.isArray(item.changes) ||
    (item.proposedClose !== undefined && typeof item.proposedClose !== "boolean")
  ) throw new Error("Invalid or duplicate finding item");
  if (item.proposedClose ? item.changes.length !== 0 : item.changes.length === 0) {
    throw new Error(
      "An edit needs changes; a proposed close must be a separate item without changes",
    );
  }
  seen.add(item.number);
  item.changes.forEach(validateChange);
  return item as unknown as Finding;
}

/** Helpers may omit an initially empty Flash batch. Every item is checked before any write. */
export function validateFindings(value: unknown): FindingsFile {
  const file = record(value);
  fields(file, ["schemaVersion", "items", "flashBatch"]);
  if (
    file.schemaVersion !== 1 || !Array.isArray(file.items) ||
    (file.flashBatch !== undefined && !Array.isArray(file.flashBatch))
  ) throw new Error("Invalid findings schema");
  const seen = new Set<number>();
  return {
    schemaVersion: 1,
    items: file.items.map((item) => validateItem(item, seen)),
    flashBatch: ((file.flashBatch ?? []) as unknown[]).map((item) => validateItem(item, seen)),
  };
}

export async function readFindings(file: string): Promise<FindingsFile> {
  snapshotPath(file);
  if (await Deno.realPath(file) !== file) {
    throw new Error("Findings path must not contain symlinks");
  }
  return validateFindings(JSON.parse(await Deno.readTextFile(file)));
}

/** Publish a complete validated file by rename; failure leaves the previous bytes intact. */
export async function writeFindings(file: string, findings: FindingsFile): Promise<void> {
  const contents = JSON.stringify(validateFindings(findings), null, 2) + "\n";
  snapshotPath(file);
  const directory = dirname(file);
  if (await Deno.realPath(directory) !== directory) {
    throw new Error("Findings directory must not contain symlinks");
  }
  await refuseSymlink(file);
  const temporary = await Deno.makeTempFile({ dir: directory, prefix: ".findings-" });
  try {
    await Deno.writeTextFile(temporary, contents);
    await refuseSymlink(file);
    await Deno.rename(temporary, file);
  } finally {
    await removeTemporary(temporary);
  }
}

async function removeTemporary(file: string): Promise<void> {
  try {
    await Deno.remove(file);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function refuseSymlink(file: string): Promise<void> {
  try {
    const info = await Deno.lstat(file);
    if (info.isSymlink || !info.isFile) {
      throw new Error("Findings must be a regular file, not a symlink");
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
