/** Pure, proposal-only ranking. Human level tests remain owned by skills/file-issue. */
export const LEVELS = ["Urgent", "High", "Medium", "Low"] as const;
export type Priority = typeof LEVELS[number];
export type LevelCounts = Record<Priority, number>;

export interface IssueFacts {
  number: number;
  title: string;
  updatedAt: string;
  milestone: string | null;
  priority: Priority | null;
  epic: boolean;
  labels: string[];
  openWaiting: number;
  blockedByOpen: boolean;
  /** Native open children, including children in other repositories. */
  children: Array<{ number: number; priority: Priority | null }>;
}

export interface Judgment {
  liveBroken: boolean;
  costlyDefect: boolean;
  reason: string;
  /** Caller applies file-issue's level tests; required only below the share floor. */
  levelFromTests?: Priority;
}

export interface RankedIssue {
  number: number;
  title: string;
  priority: Priority | null;
  targetPriority: Priority;
  liveBroken: boolean;
  focus: boolean;
  waiting: number;
  costlyDefect: boolean;
  reason: string;
}

export interface PriorityMove {
  number: number;
  title: string;
  kind: "missing" | "up" | "down" | "epic";
  from: Priority | null;
  to: Priority;
  reason: string;
}

export interface RankResult {
  repo: string;
  focus: string | null;
  notices: string[];
  count: number;
  shares: LevelCounts | null;
  counts: LevelCounts;
  ranking: RankedIssue[];
  moves: PriorityMove[];
}

export function isPriority(value: unknown): value is Priority {
  return typeof value === "string" && LEVELS.some((level) => level === value);
}

const emptyCounts = (): LevelCounts => ({ Urgent: 0, High: 0, Medium: 0, Low: 0 });
const levelIndex = (level: Priority) => LEVELS.indexOf(level);

export function targetShares(count: number): LevelCounts | null {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid issue count");
  if (count < 20) return null;
  return {
    Urgent: Math.round(count * 0.10),
    High: Math.round(count * 0.25),
    Medium: Math.round(count * 0.40),
    Low: Math.round(count * 0.25),
  };
}

function levelAt(index: number, shares: LevelCounts): Priority {
  let boundary = 0;
  for (const level of LEVELS) {
    boundary += shares[level];
    if (index < boundary) return level;
  }
  // Independent rounding can leave a remainder; the final band includes it.
  return "Low";
}

function validateJudgment(
  issue: IssueFacts,
  judgment: Judgment | undefined,
  small: boolean,
): Judgment {
  if (
    !judgment || typeof judgment.liveBroken !== "boolean" ||
    typeof judgment.costlyDefect !== "boolean" || typeof judgment.reason !== "string" ||
    !judgment.reason.trim() || /[\r\n]/.test(judgment.reason)
  ) {
    throw new Error(`Missing or invalid explicit judgment for issue ${issue.number}`);
  }
  if (small && !isPriority(judgment.levelFromTests)) {
    throw new Error(`Issue ${issue.number} requires levelFromTests below the 20-issue floor`);
  }
  if (small && judgment.liveBroken && judgment.levelFromTests !== "Urgent") {
    throw new Error(`Live broken issue ${issue.number} must have an Urgent levelFromTests`);
  }
  return judgment;
}

export function rankIssues(
  repo: string,
  issues: readonly IssueFacts[],
  judgments: Readonly<Record<string, Judgment>>,
  milestones: readonly string[] = [],
  focus?: string,
): RankResult {
  const active = issues;
  const regular = active.filter((issue) => !issue.epic);
  const shares = targetShares(regular.length);
  const effectiveFocus = focus && milestones.includes(focus) ? focus : null;
  const counts = emptyCounts();
  const seen = new Set<number>();
  for (const issue of active) {
    if (
      !Number.isSafeInteger(issue.number) || issue.number <= 0 || seen.has(issue.number) ||
      !Number.isFinite(Date.parse(issue.updatedAt)) ||
      !Number.isSafeInteger(issue.openWaiting) || issue.openWaiting < 0 ||
      typeof issue.blockedByOpen !== "boolean" ||
      (issue.priority !== null && !isPriority(issue.priority))
    ) throw new Error(`Invalid or duplicate issue facts for ${issue.number}`);
    seen.add(issue.number);
  }
  const ordered = regular.map((issue) => {
    const judgment = validateJudgment(issue, judgments[String(issue.number)], shares === null);
    if (issue.priority) counts[issue.priority]++;
    return {
      issue,
      judgment,
      focus: effectiveFocus !== null && issue.milestone === effectiveFocus,
      waiting: issue.blockedByOpen ? 0 : issue.openWaiting,
    };
  }).sort((a, b) =>
    Number(b.judgment.liveBroken) - Number(a.judgment.liveBroken) ||
    Number(b.focus) - Number(a.focus) ||
    b.waiting - a.waiting ||
    Number(b.judgment.costlyDefect) - Number(a.judgment.costlyDefect) ||
    Date.parse(b.issue.updatedAt) - Date.parse(a.issue.updatedAt) ||
    a.issue.number - b.issue.number
  );
  const ranking: RankedIssue[] = ordered.map(({ issue, judgment, focus, waiting }, index) => ({
    number: issue.number,
    title: issue.title,
    priority: issue.priority,
    targetPriority: judgment.liveBroken
      ? "Urgent"
      : shares
      ? levelAt(index, shares)
      : judgment.levelFromTests!,
    liveBroken: judgment.liveBroken,
    focus,
    waiting,
    costlyDefect: judgment.costlyDefect,
    reason: judgment.reason,
  }));
  const moves: PriorityMove[] = [];
  const propose = (row: RankedIssue, to: Priority, kind: PriorityMove["kind"], reason: string) => {
    moves.push({
      number: row.number,
      title: row.title,
      kind,
      from: row.priority,
      to,
      reason: `${reason}; ${row.reason}`,
    });
  };
  for (const [index, row] of ranking.entries()) {
    const explanation = shares
      ? `Rank ${index + 1} of ${ranking.length} falls in ${row.targetPriority}`
      : `Caller level tests give ${row.targetPriority}`;
    if (row.priority === null) propose(row, row.targetPriority, "missing", explanation);
    else if (levelIndex(row.targetPriority) < levelIndex(row.priority)) {
      propose(row, row.targetPriority, "up", explanation);
    } else if (!shares && levelIndex(row.targetPriority) > levelIndex(row.priority)) {
      propose(row, row.targetPriority, "down", explanation);
    }
  }
  if (shares) {
    // Measure overflow from the snapshot, never cascading hypothetical moves into other bands.
    for (const [index, level] of LEVELS.entries()) {
      const excess = counts[level] - shares[level];
      if (excess <= 3 || index === LEVELS.length - 1) continue;
      const candidates = ranking.filter((row) =>
        row.priority === level && !row.liveBroken &&
        !moves.some((move) => move.number === row.number)
      ).reverse();
      for (const row of candidates.slice(0, excess)) {
        propose(
          row,
          LEVELS[index + 1],
          "down",
          `${level} holds ${excess} above its share; among its lowest-ranked issues`,
        );
      }
    }
  }
  for (const epic of active.filter((issue) => issue.epic)) {
    const childLevels = epic.children.map((child) => child.priority).filter(isPriority);
    if (!childLevels.length) continue;
    const highest = childLevels.reduce((a, b) => levelIndex(a) <= levelIndex(b) ? a : b);
    if (epic.priority !== highest) {
      moves.push({
        number: epic.number,
        title: epic.title,
        kind: "epic",
        from: epic.priority,
        to: highest,
        reason: `Highest native open child Priority is ${highest}`,
      });
    }
  }
  return {
    repo,
    focus: effectiveFocus,
    notices: focus && effectiveFocus === null
      ? [`Milestone "${focus}" does not exist in ${repo}; ranking without the focus step.`]
      : [],
    count: regular.length,
    shares,
    counts,
    ranking,
    moves,
  };
}
