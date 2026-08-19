// src/flash-issues/classifier.ts
// Classification and triage logic for GitHub issues and PRs according to SKILL.md.

import {
  ACTIVE_REPOS,
  type FlashCandidate,
  type FlashTier,
  type GhIssue,
  type GhPullRequest,
  type InFlightCandidate,
} from "./types.ts";

export function extractMilestoneName(
  milestone?: GhIssue["milestone"],
): string | undefined {
  if (!milestone) return undefined;
  if (typeof milestone === "string") {
    const trimmed = milestone.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const name = milestone.title || milestone.name;
  if (name && typeof name === "string") {
    const trimmed = name.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

export function getParkedOrJosh(issue: GhIssue): string | null {
  for (const label of issue.labels || []) {
    const lower = label.name.trim().toLowerCase();
    if (lower === "parked") return "parked";
    if (lower === "josh") return "Josh";
  }
  return null;
}

const REPO_SHORTHANDS: Record<string, string> = {
  wjt: "web-jam-tools",
  "web-jam-tools": "web-jam-tools",
  jam: "JaMmusic",
  jammusic: "JaMmusic",
  cl: "CollegeLutheran",
  collegelutheran: "CollegeLutheran",
  aa: "AppersonAuto",
  appersonauto: "AppersonAuto",
  wjb: "web-jam-back",
  "web-jam-back": "web-jam-back",
  wjsc: "WebJamSocketCluster",
  webjamsocketcluster: "WebJamSocketCluster",
  tsm: "TimShermanMusic",
  timshermanmusic: "TimShermanMusic",
  hfs: "HenricksonForSalem",
  henricksonforsalem: "HenricksonForSalem",
};

export function normalizeRepoName(repoRef: string, fallbackRepo: string): string {
  const cleaned = repoRef.replace(/^WebJamApps\//i, "").trim();
  const lower = cleaned.toLowerCase();
  if (REPO_SHORTHANDS[lower]) {
    return REPO_SHORTHANDS[lower];
  }
  const match = ACTIVE_REPOS.find((r) => r.toLowerCase() === lower);
  return match || cleaned || fallbackRepo;
}

export interface MarkerCheckResult {
  isBlocked: boolean;
  reason?: string;
}

export async function checkDoNotDispatchMarker(
  body: string | null | undefined,
  currentRepo: string,
  fetchState: (repo: string, num: number) => Promise<string>,
): Promise<MarkerCheckResult> {
  if (!body || body.trim() === "") {
    return { isBlocked: false };
  }

  // Check if body is just a discussion or decision log citation, e.g. "decisions on #123"
  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Decision-log or discussion citation is NOT a dependency blocker
    if (
      /(?:decisions|discussion)\s+(?:on|in|at)\s+(?:[A-Za-z0-9_/-]+#[0-9]+|#[0-9]+)/i.test(
        trimmed,
      ) &&
      !/(?:⛔|do not (?:start|build)|blocked)/i.test(trimmed)
    ) {
      continue;
    }

    // Conditional marker citing an issue reference
    const conditionalMatch = trimmed.match(
      /(?:do not (?:start|build) until|blocked.*?until|waiting on)\s+([A-Za-z0-9_/-]+#[0-9]+|#[0-9]+)/i,
    );
    if (conditionalMatch) {
      const fullRef = conditionalMatch[1];
      let refRepo = currentRepo;
      let refNum = 0;
      if (fullRef.startsWith("#")) {
        refNum = parseInt(fullRef.slice(1), 10);
      } else {
        const [repoPart, numPart] = fullRef.split("#");
        refRepo = normalizeRepoName(repoPart, currentRepo);
        refNum = parseInt(numPart, 10);
      }

      if (refNum > 0) {
        try {
          const state = await fetchState(refRepo, refNum);
          if (["CLOSED", "MERGED"].includes(state.toUpperCase())) {
            // Condition is satisfied!
            continue;
          } else {
            return {
              isBlocked: true,
              reason: `issue body: do not start until ${refRepo}#${refNum} (${state})`,
            };
          }
        } catch {
          // If fetch fails, treat as blocked with unverified state
          return {
            isBlocked: true,
            reason: `issue body: do not start until ${refRepo}#${refNum} (OPEN)`,
          };
        }
      }
    }

    // Unconditional / external marker check
    if (
      trimmed.includes("⛔") ||
      /BLOCKED\s*[-—:]\s*do not build yet/i.test(trimmed) ||
      /do not build yet/i.test(trimmed) ||
      /waiting on\s+/i.test(trimmed)
    ) {
      // Clean up marker line for concise reason
      let markerText = trimmed.replace(/^[-*]\s*/, "");
      if (!markerText.toLowerCase().startsWith("issue body:") && !markerText.includes("⛔")) {
        markerText = `issue body: ${markerText}`;
      }
      return {
        isBlocked: true,
        reason: markerText,
      };
    }
  }

  return { isBlocked: false };
}

const KNOWN_MODEL_TIERS = [
  "Haiku",
  "Sonnet",
  "Opus",
  "Fable",
  "Flash High",
  "Flash Med",
  "Flash Low",
  "Flash",
] as const;

export function findModelTier(labels: Array<{ name: string }>): string | null {
  for (const label of labels || []) {
    const match = KNOWN_MODEL_TIERS.find(
      (m) => m.toLowerCase() === label.name.trim().toLowerCase(),
    );
    if (match) return match;
  }
  return null;
}

export function isFlashTier(model: string | null): model is FlashTier {
  if (!model) return false;
  return ["Flash", "Flash Med", "Flash High", "Flash Low"].includes(model);
}

export type TriageDecision =
  | { action: "label"; model: string }
  | { action: "needs-review"; recommendation: string };

export function triageUnlabeledIssue(
  issue: GhIssue,
  repoLabels: string[],
): TriageDecision {
  const title = issue.title.trim();
  const body = (issue.body || "").trim();

  // Under-specified codework (empty or title-only body) -> Opus
  if (
    !body ||
    body.toLowerCase() === title.toLowerCase() ||
    body.replace(/[^a-zA-Z0-9]/g, "") === title.replace(/[^a-zA-Z0-9]/g, "")
  ) {
    return { action: "label", model: "Opus" };
  }

  const combinedText = `${title}\n${body}`.toLowerCase();

  // Non-codework / human task
  if (
    combinedText.includes("record and publish") ||
    combinedText.includes("get spotify to") ||
    combinedText.includes("confirm venue contact list") ||
    combinedText.includes("phone call") ||
    combinedText.includes("manual data entry") ||
    combinedText.includes("human task") ||
    combinedText.includes("contact venue")
  ) {
    return {
      action: "needs-review",
      recommendation: "recommend: keep open unlabeled — human task, not codework",
    };
  }

  // Parent epic / tracking issue check
  if (
    combinedText.includes("parent epic") ||
    combinedText.includes("closes when all child") ||
    combinedText.includes("closes when all sub-issues") ||
    title.toLowerCase().startsWith("epic:")
  ) {
    const subMatch = body.match(/#(\d+)/);
    const subHint = subMatch ? ` tracking sub-issues in #${subMatch[1]}` : "";
    return {
      action: "needs-review",
      recommendation: `recommend: keep open unlabeled — parent epic${subHint}`,
    };
  }

  // Duplicate check
  const dupMatch = body.match(/duplicate of\s+([A-Za-z0-9_/-]+#[0-9]+|#[0-9]+)/i);
  if (dupMatch) {
    return {
      action: "needs-review",
      recommendation: `recommend: close as duplicate of ${dupMatch[1]}`,
    };
  }

  // Already completed check
  if (
    combinedText.includes("already completed") ||
    combinedText.includes("already done")
  ) {
    return {
      action: "needs-review",
      recommendation: "recommend: close as already completed",
    };
  }

  // Codework triage: determine model tier
  // If repo has Flash Med / Flash High split:
  const hasFlashHigh = repoLabels.some((l) => l.toLowerCase() === "flash high");
  const hasFlashMed = repoLabels.some((l) => l.toLowerCase() === "flash med");

  // Check complexity
  const isHighComplexity = combinedText.includes("complex") ||
    combinedText.includes("multi-layer") ||
    combinedText.includes("refactor") ||
    combinedText.includes("architecture") ||
    combinedText.includes("oauth") ||
    combinedText.includes("state management");

  if (hasFlashHigh && isHighComplexity) {
    return { action: "label", model: "Flash High" };
  }
  if (hasFlashMed) {
    return { action: "label", model: "Flash Med" };
  }
  return { action: "label", model: "Flash" };
}

export function detectInFlightPr(
  candidate: FlashCandidate,
  prs: GhPullRequest[],
): InFlightCandidate | null {
  for (const pr of prs) {
    const body = pr.body || "";
    const issueNum = candidate.number;

    const closesMatches = Array.from(
      body.matchAll(/(?:closes|part of)\s+#(\d+)(?:[^0-9]|$)/gi),
    );
    const matchesBody = closesMatches.some((m) => Number(m[1]) === issueNum);

    const branchMatch = (pr.headRefName || "").match(
      /^(?:agy|gemini|claude)\/(\d+)(?:-[^/]+)?$/i,
    );
    const matchesBranch = branchMatch ? Number(branchMatch[1]) === issueNum : false;

    if (matchesBody || matchesBranch) {
      // Matching PR found!
      // 1. CI status check
      let ciFailing = false;
      for (const check of pr.statusCheckRollup || []) {
        const conclusion = (check.conclusion || "").toUpperCase();
        const state = (check.state || "").toUpperCase();
        if (
          [
            "FAILURE",
            "ERROR",
            "TIMED_OUT",
            "CANCELLED",
            "ACTION_REQUIRED",
          ].includes(conclusion) ||
          ["FAILURE", "ERROR"].includes(state)
        ) {
          ciFailing = true;
          break;
        }
      }

      // 2. Automated review check on head commit
      const lastCommit = pr.commits?.[pr.commits.length - 1];
      const headCommitSha = lastCommit?.oid;

      let reviewState: "approved" | "changes_requested" | "unreviewed" = "unreviewed";
      let mustFixCount = 0;
      let reviewUrl: string | undefined = pr.url;

      for (const review of pr.reviews || []) {
        const revBody = review.body || "";
        if (!/## PR Review Summary/i.test(revBody)) {
          continue;
        }

        // Match head commit if commit OID is present
        if (headCommitSha && review.commit?.oid && review.commit.oid !== headCommitSha) {
          continue;
        }

        // Count Must Fix items
        const mustFixSection = revBody.match(
          /### 🛑 Must Fix Items([\s\S]*?)(?:###|$)/i,
        );
        if (mustFixSection) {
          const sectionContent = mustFixSection[1];
          if (!/✅ None|None/i.test(sectionContent)) {
            const matches = sectionContent.match(/^\s*[-*]?\s*🛑/gm);
            mustFixCount = matches ? matches.length : 0;
          }
        }

        if (
          mustFixCount > 0 ||
          /\*\*🛑 Changes Requested\*\*/i.test(revBody) ||
          pr.reviewDecision === "CHANGES_REQUESTED" ||
          review.state === "CHANGES_REQUESTED"
        ) {
          reviewState = "changes_requested";
        } else if (
          /\*\*✅ Approved\*\*/i.test(revBody) ||
          review.state === "APPROVED"
        ) {
          reviewState = "approved";
        }

        reviewUrl = pr.url;
      }

      return {
        ...candidate,
        prNumber: pr.number,
        prUrl: pr.url,
        headRefName: pr.headRefName,
        ciFailing,
        reviewState,
        mustFixCount,
        reviewUrl,
      };
    }
  }

  return null;
}
