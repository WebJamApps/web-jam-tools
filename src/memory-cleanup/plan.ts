import { isValidSlug } from "../../scripts/consume_memory_rules.ts";

export const GUARD_KINDS = [
  "approval-gate",
  "deletion-guard",
  "credential-rule",
  "spending-rule",
] as const;
export type GuardKind = typeof GUARD_KINDS[number];
export const REMOVAL_REASONS = ["hook-enforced", "already-said", "obsolete", "work-state"] as const;
export type RemovalReason = typeof REMOVAL_REASONS[number];
export interface MergeJudgment {
  keep: string;
  absorb: string[];
}
export interface MoveJudgment {
  slug: string;
  target_skill: string;
}
export interface RemovalJudgment {
  slug: string;
  reason: RemovalReason;
  evidence: string;
}
export interface GuardJudgment {
  slug: string;
  kind: GuardKind;
}
/** Relative directory paths resolve against the plan file. */
export interface LowMarkPlan {
  skills_dir?: string;
  resume_dir?: string;
  merges?: MergeJudgment[];
  moves?: MoveJudgment[];
  removals?: RemovalJudgment[];
  guards?: GuardJudgment[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Plan and its rows must be objects");
  }
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown plan field: ${key}`);
  }
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Expected nonempty plan text");
  return value;
}
function slug(value: unknown): string {
  const result = text(value);
  if (!isValidSlug(result)) throw new Error(`Invalid plan slug: ${result}`);
  return result;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected a plan array");
  return value;
}
function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  const result = text(value);
  const found = allowed.find((item) => item === result);
  if (!found) throw new Error(`Invalid plan choice: ${result}`);
  return found;
}

/** Validate the entire untrusted plan before any memory is changed. */
export function readLowMarkPlan(value: unknown): LowMarkPlan {
  const root = record(value);
  keys(root, ["skills_dir", "resume_dir", "merges", "moves", "removals", "guards"]);
  const plan: LowMarkPlan = {};
  if (root.skills_dir !== undefined) plan.skills_dir = text(root.skills_dir);
  if (root.resume_dir !== undefined) plan.resume_dir = text(root.resume_dir);
  if (root.merges !== undefined) {
    plan.merges = list(root.merges).map((item) => {
      const row = record(item);
      keys(row, ["keep", "absorb"]);
      const absorb = list(row.absorb).map(slug);
      if (!absorb.length) throw new Error("A merge must name absorbed memories");
      return { keep: slug(row.keep), absorb };
    });
  }
  if (root.moves !== undefined) {
    plan.moves = list(root.moves).map((item) => {
      const row = record(item);
      keys(row, ["slug", "target_skill"]);
      return { slug: slug(row.slug), target_skill: slug(row.target_skill) };
    });
  }
  if (root.removals !== undefined) {
    plan.removals = list(root.removals).map((item) => {
      const row = record(item);
      keys(row, ["slug", "reason", "evidence"]);
      return {
        slug: slug(row.slug),
        reason: choice(row.reason, REMOVAL_REASONS),
        evidence: text(row.evidence),
      };
    });
  }
  if (root.guards !== undefined) {
    plan.guards = list(root.guards).map((item) => {
      const row = record(item);
      keys(row, ["slug", "kind"]);
      return { slug: slug(row.slug), kind: choice(row.kind, GUARD_KINDS) };
    });
  }
  return plan;
}
