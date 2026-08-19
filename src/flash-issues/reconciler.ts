// src/flash-issues/reconciler.ts
// Coordinates classification, REST metadata fetching, dependency resolution,
// topological sorting of runnable issues, and 7-bucket reconciliation.

import {
  checkDoNotDispatchMarker,
  detectInFlightPr,
  extractMilestoneName,
  findModelTier,
  getParkedOrJosh,
  isFlashTier,
  normalizeRepoName,
  triageUnlabeledIssue,
} from "./classifier.ts";
import {
  applyIssueLabel,
  fetchIssueBlockedBy,
  fetchIssueRestPayload,
  fetchIssueState,
  runGhCommand,
} from "./scanner.ts";
import type {
  BlockedCandidate,
  ClassifiedResult,
  CommandRunner,
  FlashCandidate,
  FlashIssuesReconciliation,
  FlashTier,
  GhDependencyIssue,
  InFlightCandidate,
  NeedsReviewItem,
  Priority,
  RepoScanResult,
  RunnableCandidate,
} from "./types.ts";

const PRIORITY_ORDER: Record<Priority, number> = {
  Urgent: 0,
  High: 1,
  Medium: 2,
  Low: 3,
};

function getDependencyReason(dep: GhDependencyIssue): string {
  const labels = (dep.labels || []).map((l) => l.name);
  const model = labels.find((l) =>
    ["Sonnet", "Opus", "Haiku", "Fable", "Flash High", "Flash Med", "Flash"].includes(l)
  );
  const isJosh = labels.includes("Josh");
  if (model && isJosh) return `${model}, Josh`;
  if (model) {
    if (
      labels.some((l) =>
        l.toLowerCase().includes("backend") || l.toLowerCase().includes("endpoint")
      )
    ) {
      return `${model}, backend endpoint not built`;
    }
    return model;
  }
  if (labels.length > 0) return labels.join(", ");
  return "unresolved dependency";
}

/**
 * Topologically sorts runnable candidates so dependencies always precede dependents,
 * using Priority > Type > Number as the sorting criteria for ready nodes.
 */
export function sortRunnableCandidates(
  candidates: FlashCandidate[],
): RunnableCandidate[] {
  const result: RunnableCandidate[] = [];
  const candidateMap = new Map<string, FlashCandidate>();
  for (const c of candidates) {
    candidateMap.set(`${c.repo}#${c.number}`, c);
  }

  // Build dependency graph
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // A -> list of B that depend on A
  const samePoolDeps = new Map<string, { repo: string; number: number }>();

  for (const c of candidates) {
    const key = `${c.repo}#${c.number}`;
    inDegree.set(key, 0);
    dependents.set(key, []);
  }

  for (const c of candidates) {
    const key = `${c.repo}#${c.number}`;
    for (const dep of c.dependencies || []) {
      if (dep.state === "open") {
        const depRepo = normalizeRepoName(
          dep.repository?.name || dep.repository?.full_name || c.repo,
          c.repo,
        );
        const depKey = `${depRepo}#${dep.number}`;
        if (candidateMap.has(depKey)) {
          // c depends on dep
          inDegree.set(key, (inDegree.get(key) || 0) + 1);
          dependents.get(depKey)?.push(key);
          samePoolDeps.set(key, { repo: depRepo, number: dep.number });
        }
      }
    }
  }

  const compareCandidates = (a: FlashCandidate, b: FlashCandidate): number => {
    const pA = PRIORITY_ORDER[a.priority || "Medium"];
    const pB = PRIORITY_ORDER[b.priority || "Medium"];
    if (pA !== pB) return pA - pB;

    const isBugA = (a.type || "").toLowerCase() === "bug" ? 0 : 1;
    const isBugB = (b.type || "").toLowerCase() === "bug" ? 0 : 1;
    if (isBugA !== isBugB) return isBugA - isBugB;

    if (a.repo !== b.repo) return a.repo.localeCompare(b.repo);
    return a.number - b.number;
  };

  // Ready queue contains keys with inDegree === 0
  const readyKeys: string[] = [];
  for (const [key, deg] of inDegree.entries()) {
    if (deg === 0) readyKeys.push(key);
  }

  while (readyKeys.length > 0) {
    // Sort readyKeys by candidate comparison
    readyKeys.sort((kA, kB) => {
      const cA = candidateMap.get(kA)!;
      const cB = candidateMap.get(kB)!;
      return compareCandidates(cA, cB);
    });

    const currentKey = readyKeys.shift()!;
    const currentCandidate = candidateMap.get(currentKey)!;

    const samePoolDep = samePoolDeps.get(currentKey);
    result.push({
      ...currentCandidate,
      samePoolDependency: samePoolDep,
    });

    for (const depKey of dependents.get(currentKey) || []) {
      const newDeg = (inDegree.get(depKey) || 1) - 1;
      inDegree.set(depKey, newDeg);
      if (newDeg === 0) {
        readyKeys.push(depKey);
      }
    }
  }

  // In case of cycles or unreachable nodes, append remaining candidates
  if (result.length < candidates.length) {
    const placed = new Set(result.map((r) => `${r.repo}#${r.number}`));
    const remaining = candidates
      .filter((c) => !placed.has(`${c.repo}#${c.number}`))
      .sort(compareCandidates);
    for (const rem of remaining) {
      result.push({
        ...rem,
        samePoolDependency: samePoolDeps.get(`${rem.repo}#${rem.number}`),
      });
    }
  }

  return result;
}

export async function classifyAll(
  scanResults: RepoScanResult[],
  options: {
    dryRun?: boolean;
    runner?: CommandRunner;
  } = {},
): Promise<ClassifiedResult> {
  const runner = options.runner || runGhCommand;
  const fixPrs: InFlightCandidate[] = [];
  const inFlight: InFlightCandidate[] = [];
  const blocked: BlockedCandidate[] = [];
  const needsReview: NeedsReviewItem[] = [];
  const skippedOtherModel: Array<{ repo: string; number: number; model: string }> = [];
  const skippedParkedJosh: Array<{ repo: string; number: number; reason: string }> = [];
  const newlyLabeled: Array<{ repo: string; number: number; label: string }> = [];

  const rawFlashCandidates: FlashCandidate[] = [];
  const prsByRepo = new Map<string, RepoScanResult["prs"]>();

  for (const scan of scanResults) {
    prsByRepo.set(scan.repo, scan.prs);

    for (const issue of scan.issues) {
      // Step 3: Check parked or Josh label
      const parkedOrJosh = getParkedOrJosh(issue);
      if (parkedOrJosh) {
        skippedParkedJosh.push({
          repo: scan.repo,
          number: issue.number,
          reason: parkedOrJosh,
        });
        continue;
      }

      // Check explicit do-not-dispatch markers in body
      const markerResult = await checkDoNotDispatchMarker(
        issue.body,
        scan.repo,
        (r, n) => fetchIssueState(r, n, runner),
      );

      if (markerResult.isBlocked) {
        const modelTier = findModelTier(issue.labels);
        const tier = (isFlashTier(modelTier) ? modelTier : "Flash Med") as FlashTier;
        blocked.push({
          repo: scan.repo,
          number: issue.number,
          title: issue.title,
          url: issue.url,
          milestone: extractMilestoneName(issue.milestone),
          tier,
          body: issue.body || "",
          labels: (issue.labels || []).map((l) => l.name),
          blockedReason: markerResult.reason || "blocked by marker",
        });
        continue;
      }

      // Check model label
      const existingModel = findModelTier(issue.labels);
      if (existingModel) {
        if (isFlashTier(existingModel)) {
          rawFlashCandidates.push({
            repo: scan.repo,
            number: issue.number,
            title: issue.title,
            url: issue.url,
            milestone: extractMilestoneName(issue.milestone),
            tier: existingModel,
            body: issue.body || "",
            labels: (issue.labels || []).map((l) => l.name),
          });
        } else {
          skippedOtherModel.push({
            repo: scan.repo,
            number: issue.number,
            model: existingModel,
          });
        }
      } else {
        // Unlabeled: triage
        const decision = triageUnlabeledIssue(issue, scan.labels);
        if (decision.action === "needs-review") {
          needsReview.push({
            repo: scan.repo,
            number: issue.number,
            title: issue.title,
            url: issue.url,
            recommendation: decision.recommendation,
          });
        } else {
          // Labeling decision
          if (!options.dryRun) {
            try {
              await applyIssueLabel(scan.repo, issue.number, decision.model, runner);
            } catch (err) {
              console.error(
                `Failed to apply label "${decision.model}" to ${scan.repo}#${issue.number}: ${err}`,
              );
            }
          }
          newlyLabeled.push({
            repo: scan.repo,
            number: issue.number,
            label: decision.model,
          });

          if (isFlashTier(decision.model)) {
            rawFlashCandidates.push({
              repo: scan.repo,
              number: issue.number,
              title: issue.title,
              url: issue.url,
              milestone: extractMilestoneName(issue.milestone),
              tier: decision.model,
              body: issue.body || "",
              labels: [...(issue.labels || []).map((l) => l.name), decision.model],
            });
          } else {
            skippedOtherModel.push({
              repo: scan.repo,
              number: issue.number,
              model: decision.model,
            });
          }
        }
      }
    }
  }

  // Step 4: Detect in-flight candidates
  const runnableCandidatesPool: FlashCandidate[] = [];
  const candidateKeys = new Set(rawFlashCandidates.map((c) => `${c.repo}#${c.number}`));

  for (const candidate of rawFlashCandidates) {
    const repoPrs = prsByRepo.get(candidate.repo) || [];
    const inFlightCandidate = detectInFlightPr(candidate, repoPrs);

    if (inFlightCandidate) {
      if (
        inFlightCandidate.reviewState === "changes_requested" ||
        inFlightCandidate.ciFailing
      ) {
        fixPrs.push(inFlightCandidate);
      } else {
        inFlight.push(inFlightCandidate);
      }
    } else {
      runnableCandidatesPool.push(candidate);
    }
  }

  // Step 5: Read Priority, Type, and dependencies for non-in-flight candidates
  const unblockedRunnableCandidates: FlashCandidate[] = [];

  for (const candidate of runnableCandidatesPool) {
    try {
      const rest = await fetchIssueRestPayload(candidate.repo, candidate.number, runner);

      // Priority extraction
      const priorityField = (rest.issue_field_values || []).find(
        (f) => f.issue_field_name === "Priority",
      );
      const priorityName = (priorityField?.single_select_option?.name ||
        "Medium") as Priority;
      candidate.priority = priorityName;

      // Type extraction
      candidate.type = rest.type?.name || null;

      // Dependency resolution
      const totalBlockedBy = rest.issue_dependencies_summary?.total_blocked_by || 0;
      candidate.blockedByCount = totalBlockedBy;

      if (totalBlockedBy > 0) {
        const deps = await fetchIssueBlockedBy(candidate.repo, candidate.number, runner);
        candidate.dependencies = deps;

        let blockedByExternal = false;
        let externalBlockerReason = "";

        for (const dep of deps) {
          if (dep.state === "open") {
            const depRepo = normalizeRepoName(
              dep.repository?.name || dep.repository?.full_name || candidate.repo,
              candidate.repo,
            );
            const depKey = `${depRepo}#${dep.number}`;

            if (!candidateKeys.has(depKey)) {
              // Not in Flash candidate pool -> this candidate is BLOCKED!
              blockedByExternal = true;
              const reasonText = getDependencyReason(dep);
              externalBlockerReason = `depends on ${depRepo}#${dep.number} (${reasonText})`;
              break;
            }
          }
        }

        if (blockedByExternal) {
          blocked.push({
            ...candidate,
            blockedReason: externalBlockerReason,
          });
        } else {
          unblockedRunnableCandidates.push(candidate);
        }
      } else {
        unblockedRunnableCandidates.push(candidate);
      }
    } catch {
      // Fallback if REST call fails
      candidate.priority = "Medium";
      unblockedRunnableCandidates.push(candidate);
    }
  }

  // Step 6: Topological ordering of runnable list
  const runnable = sortRunnableCandidates(unblockedRunnableCandidates);

  return {
    fixPrs,
    runnable,
    inFlight,
    blocked,
    needsReview,
    skippedOtherModel,
    skippedParkedJosh,
    newlyLabeled,
  };
}

export function reconcileCounts(
  scanResults: RepoScanResult[],
  classified: ClassifiedResult,
): FlashIssuesReconciliation {
  const totalScanned = scanResults.reduce((acc, r) => acc + r.issues.length, 0);

  const fixPrsChanges = classified.fixPrs.filter(
    (p) => p.reviewState === "changes_requested",
  ).length;
  const fixPrsCi = classified.fixPrs.filter(
    (p) => p.reviewState !== "changes_requested" && p.ciFailing,
  ).length;

  const inFlightUnreviewed = classified.inFlight.filter(
    (p) => p.reviewState === "unreviewed",
  ).length;
  const inFlightApproved = classified.inFlight.filter(
    (p) => p.reviewState === "approved",
  ).length;

  const totalCategorized = classified.fixPrs.length +
    classified.runnable.length +
    classified.inFlight.length +
    classified.blocked.length +
    classified.needsReview.length +
    classified.skippedOtherModel.length +
    classified.skippedParkedJosh.length;

  return {
    totalScanned,
    totalCategorized,
    bucketCounts: {
      fixPrs: {
        total: classified.fixPrs.length,
        changesRequested: fixPrsChanges,
        ciFailing: fixPrsCi,
      },
      runnable: classified.runnable.length,
      inFlight: {
        total: classified.inFlight.length,
        unreviewed: inFlightUnreviewed,
        approved: inFlightApproved,
      },
      blocked: classified.blocked.length,
      needsReview: classified.needsReview.length,
      skippedOtherModel: classified.skippedOtherModel.length,
      skippedParkedJosh: classified.skippedParkedJosh.length,
    },
    reconciled: totalScanned === totalCategorized,
  };
}
