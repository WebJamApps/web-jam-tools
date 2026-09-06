// src/flash-issues/types.ts
// Type definitions for the flash-issues scanner, reconciler, and formatter.

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (args: string[]) => Promise<CommandResult>;

export const ACTIVE_REPOS = [
  "web-jam-tools",
  "JaMmusic",
  "CollegeLutheran",
  "AppersonAuto",
  "web-jam-back",
  "WebJamSocketCluster",
  "TimShermanMusic",
  "HenricksonForSalem",
] as const;

export type ActiveRepo = (typeof ACTIVE_REPOS)[number];
export const REPO_OWNER = "WebJamApps";

export interface GhLabel {
  name: string;
  color?: string;
  description?: string;
}

export interface GhMilestone {
  title?: string;
  name?: string;
  number?: number;
}

export interface GhIssue {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
  body?: string | null;
  url: string;
  milestone?: GhMilestone | string | null;
}

export interface GhCommit {
  oid: string;
  messageHeadline?: string;
}

export interface GhReview {
  author?: { login: string };
  body?: string;
  state?: string;
  submittedAt?: string;
  commit?: { oid: string };
}

export interface GhStatusCheck {
  name?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

export interface GhPullRequest {
  number: number;
  headRefName: string;
  body?: string | null;
  url: string;
  title: string;
  reviews?: GhReview[];
  commits?: GhCommit[];
  reviewDecision?: string | null;
  statusCheckRollup?: GhStatusCheck[];
}

export interface GhIssueRestFieldOption {
  id?: string;
  name?: string;
}

export interface GhIssueRestFieldValue {
  issue_field_name: string;
  single_select_option?: GhIssueRestFieldOption | null;
  text?: string | null;
}

export interface GhIssueRestType {
  id?: string;
  name?: string;
}

export interface GhIssueRestDependenciesSummary {
  total_blocked_by: number;
}

export interface GhIssueRestPayload {
  number: number;
  title: string;
  issue_field_values?: GhIssueRestFieldValue[];
  type?: GhIssueRestType | null;
  issue_dependencies_summary?: GhIssueRestDependenciesSummary | null;
}

export interface GhDependencyIssue {
  number: number;
  state: "open" | "closed" | string;
  repository?: { full_name?: string; name?: string };
  title: string;
  labels?: Array<{ name: string }>;
}

export type FlashTier = "Flash" | "Flash Med" | "Flash High" | "Flash Low";
export type Priority = "Urgent" | "High" | "Medium" | "Low";

export interface RepoScanResult {
  repo: string;
  labels: string[];
  issues: GhIssue[];
  prs: GhPullRequest[];
}

export interface FlashCandidate {
  repo: string;
  number: number;
  title: string;
  url: string;
  milestone?: string;
  tier: FlashTier;
  body: string;
  labels: string[];
  priority?: Priority;
  type?: string | null;
  blockedByCount?: number;
  dependencies?: GhDependencyIssue[];
}

export interface InFlightCandidate extends FlashCandidate {
  prNumber: number;
  prUrl: string;
  headRefName: string;
  ciFailing: boolean;
  reviewState?: "approved" | "changes_requested" | "unreviewed";
  mustFixCount?: number;
  reviewUrl?: string;
}

export interface BlockedCandidate extends FlashCandidate {
  blockedReason: string;
}

export interface RunnableCandidate extends FlashCandidate {
  samePoolDependency?: { repo: string; number: number };
}

export interface NeedsReviewItem {
  repo: string;
  number: number;
  title: string;
  url: string;
  recommendation: string;
}

export interface ClassifiedResult {
  fixPrs: InFlightCandidate[];
  runnable: RunnableCandidate[];
  inFlight: InFlightCandidate[];
  blocked: BlockedCandidate[];
  needsReview: NeedsReviewItem[];
  skippedOtherModel: Array<{ repo: string; number: number; model: string }>;
  skippedParkedJosh: Array<{ repo: string; number: number; reason: string }>;
  newlyLabeled: Array<{ repo: string; number: number; label: string }>;
}

export interface FlashIssuesReconciliation {
  totalScanned: number;
  totalCategorized: number;
  bucketCounts: {
    fixPrs: { total: number; changesRequested: number; ciFailing: number };
    runnable: number;
    inFlight: { total: number; unreviewed: number; approved: number };
    blocked: number;
    needsReview: number;
    skippedOtherModel: number;
    skippedParkedJosh: number;
  };
  reconciled: boolean;
}
