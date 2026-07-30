// milestone-diff.ts — web-jam-tools#300
//
// Computes GitHub MILESTONE-name drift for /fix-labels, the sibling check to
// src/fix-labels/diff.ts's label drift. Topic labels (formerly
// `gig-outreach`, plus the `backup-restore` `keep:` entry) were replaced by
// per-repo milestones — design amendment on web-jam-tools#287 "fix-labels
// skill expanded / corrected" (2026-07-29): no custom issue field renders
// when unset, so none is writable by Josh by hand; a milestone is the only
// surface that is both always-visible-when-unset and writable in the UI.
//
// Cross-repo topic matching is by EXACT milestone name, so a typo or a
// missing milestone silently splits or hides a topic. `classifyMilestoneDrift`
// is a pure function (schema, repo, actual milestones) -> classified drift
// list, mirroring classifyRepoDrift in diff.ts — no network, fully
// unit-testable. Only `main()` (and the `fetch*` helper) touch the network
// via `gh`.
//
// Run: deno task fix-labels:milestone-diff [--json]

import {
  type CanonicalTopic,
  type CommandResult,
  type CommandRunner,
  DEFAULT_SCHEMA_PATH,
  loadSchema,
  runGh,
  runGhCommand,
  type Schema,
} from "./diff.ts";

export type { CanonicalTopic, CommandResult, CommandRunner };

// --- Drift types ---

export type MilestoneDriftKind = "missing" | "misspelled" | "non-canonical";
export type MilestoneDriftAction = "create" | "rename" | "review";

export interface MilestoneDriftItem {
  kind: MilestoneDriftKind;
  action: MilestoneDriftAction;
  /** Canonical name (create/rename target) or the existing name (review). */
  name: string;
  /** Existing (misspelled/case-variant) name being renamed away from. */
  fromName?: string;
  /** Existing milestone number — needed to PATCH a rename. */
  number?: number;
  /** Extra context for a non-canonical line (e.g. "belongs to another repo"). */
  note?: string;
}

export interface ActualMilestone {
  title: string;
  number: number;
  state: string;
}

/** Case-insensitive/typo tolerance: anything within this edit distance of a
 * canonical name is treated as a misspelling to propose renaming, not a
 * fresh non-canonical milestone. */
const MISSPELL_DISTANCE_THRESHOLD = 2;

/** Plain Levenshtein edit distance — small strings only (milestone names), no need to optimize. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Pure diff: classify one repo's actual milestones against the canonical
 * topic list. No network calls — safe to unit test with hand-built fixtures.
 */
export function classifyMilestoneDrift(
  schema: Schema,
  repo: string,
  actual: ActualMilestone[],
): MilestoneDriftItem[] {
  const drift: MilestoneDriftItem[] = [];
  const consumed = new Set<number>();
  const topics = schema.milestoneTopics ?? [];
  const requiredHere = topics.filter((t) => t.repos.includes(repo));

  for (const topic of requiredHere) {
    const exact = actual.find((m) => !consumed.has(m.number) && m.title === topic.name);
    if (exact) {
      consumed.add(exact.number);
      continue;
    }

    // Case-insensitive exact match (e.g. "Gig-Outreach" vs. "gig-outreach").
    const caseVariant = actual.find(
      (m) => !consumed.has(m.number) && m.title.toLowerCase() === topic.name.toLowerCase(),
    );
    if (caseVariant) {
      consumed.add(caseVariant.number);
      drift.push({
        kind: "misspelled",
        action: "rename",
        name: topic.name,
        fromName: caseVariant.title,
        number: caseVariant.number,
      });
      continue;
    }

    // Fuzzy typo match — closest unconsumed milestone within the threshold.
    const candidates = actual
      .filter((m) => !consumed.has(m.number))
      .map((m) => ({ m, dist: levenshtein(m.title.toLowerCase(), topic.name.toLowerCase()) }))
      .filter(({ dist }) => dist > 0 && dist <= MISSPELL_DISTANCE_THRESHOLD)
      .sort((a, b) => a.dist - b.dist);
    if (candidates.length > 0) {
      const { m } = candidates[0];
      consumed.add(m.number);
      drift.push({
        kind: "misspelled",
        action: "rename",
        name: topic.name,
        fromName: m.title,
        number: m.number,
      });
      continue;
    }

    drift.push({ kind: "missing", action: "create", name: topic.name });
  }

  for (const m of actual) {
    if (consumed.has(m.number)) continue;
    const canonicalElsewhere = topics.find((t) => t.name === m.title);
    if (canonicalElsewhere) {
      drift.push({
        kind: "non-canonical",
        action: "review",
        name: m.title,
        note: `canonical topic "${canonicalElsewhere.name}" is not designated for this repo`,
      });
      continue;
    }
    drift.push({ kind: "non-canonical", action: "review", name: m.title });
  }

  return drift;
}

/** Every repo any canonical topic names, deduplicated, first-appearance order. */
export function milestoneTopicRepos(schema: Schema): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const topic of schema.milestoneTopics ?? []) {
    for (const repo of topic.repos) {
      if (!seen.has(repo)) {
        seen.add(repo);
        out.push(repo);
      }
    }
  }
  return out;
}

// --- `gh` shell-outs (main() only — never called from the pure function) ---

export async function fetchActualMilestones(
  repo: string,
  runner: CommandRunner = runGhCommand,
): Promise<ActualMilestone[]> {
  // `state` MUST travel in the query string, not as a `-f` form field: `gh api`
  // treats any request carrying form fields as a POST, so `-f state=all` tried
  // to CREATE a milestone and GitHub rejected it with HTTP 422 ("all is not a
  // member of [open, closed]" / "title wasn't supplied"). That made this scan —
  // and therefore the whole milestone half of /fix-labels — fail every run.
  const out = await runGh([
    "api",
    `repos/WebJamApps/${repo}/milestones?state=all`,
    "--paginate",
  ], runner);
  const parsed = JSON.parse(out) as Array<{ title: string; number: number; state: string }>;
  return parsed.map((m) => ({ title: m.title, number: m.number, state: m.state }));
}

export async function scanRepoMilestones(
  schema: Schema,
  repo: string,
  runner: CommandRunner = runGhCommand,
): Promise<MilestoneDriftItem[]> {
  const actual = await fetchActualMilestones(repo, runner);
  return classifyMilestoneDrift(schema, repo, actual);
}

// --- Report formatting ---

function formatMilestoneDriftLine(item: MilestoneDriftItem): string {
  switch (item.action) {
    case "create":
      return `- CREATE milestone \`${item.name}\` — missing`;
    case "rename":
      return `- RENAME milestone \`${item.fromName}\` → \`${item.name}\` — misspelled`;
    case "review":
      return item.note
        ? `- REVIEW milestone \`${item.name}\` — non-canonical (${item.note})`
        : `- REVIEW milestone \`${item.name}\` — non-canonical, not on the topic list`;
  }
}

export function formatMilestoneReport(
  perRepo: Record<string, MilestoneDriftItem[]>,
  now: Date = new Date(),
): string {
  const lines: string[] = [`## fix-labels milestone report — ${now.toISOString()}`, ""];
  for (const [repo, items] of Object.entries(perRepo)) {
    lines.push(`### ${repo}`);
    if (items.length === 0) {
      lines.push("no changes");
    } else {
      for (const item of items) lines.push(formatMilestoneDriftLine(item));
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

// --- main() ---

export async function main(
  args: string[] = Deno.args,
  runner: CommandRunner = runGhCommand,
  schemaPath: string = DEFAULT_SCHEMA_PATH,
): Promise<number> {
  const jsonOutput = args.includes("--json");

  let schema: Schema;
  try {
    schema = await loadSchema(schemaPath);
  } catch (err) {
    console.error(
      `fix-labels:milestone-diff: failed to load schema: ${
        err instanceof Error ? err.message : err
      }`,
    );
    return 1;
  }

  const perRepo: Record<string, MilestoneDriftItem[]> = {};
  try {
    for (const repo of milestoneTopicRepos(schema)) {
      perRepo[repo] = await scanRepoMilestones(schema, repo, runner);
    }
  } catch (err) {
    console.error(
      `fix-labels:milestone-diff: scan failed: ${err instanceof Error ? err.message : err}`,
    );
    return 1;
  }

  if (jsonOutput) {
    console.log(JSON.stringify(perRepo, null, 2));
  } else {
    console.log(formatMilestoneReport(perRepo));
  }
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
