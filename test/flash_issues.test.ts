// test/flash_issues.test.ts
// Unit tests for src/flash-issues/ (scanner, classifier, reconciler, formatter, and cli).

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  checkDoNotDispatchMarker,
  detectInFlightPr,
  extractMilestoneName,
  findModelTier,
  getParkedOrJosh,
  isFlashTier,
  normalizeRepoName,
  triageUnlabeledIssue,
} from "../src/flash-issues/classifier.ts";
import { expandHome, runCli } from "../src/flash-issues/cli.ts";
import { formatConsoleReport, formatMarkdown } from "../src/flash-issues/formatter.ts";
import {
  classifyAll,
  reconcileCounts,
  sortRunnableCandidates,
} from "../src/flash-issues/reconciler.ts";
import {
  applyIssueLabel,
  fetchIssueBlockedBy,
  fetchIssueRestPayload,
  fetchIssueState,
  fetchRepoIssues,
  fetchRepoLabels,
  fetchRepoPrs,
  runGh,
  scanAllRepos,
  scanRepo,
} from "../src/flash-issues/scanner.ts";
import type {
  ClassifiedResult,
  CommandResult,
  CommandRunner,
  FlashCandidate,
  FlashIssuesReconciliation,
  GhDependencyIssue,
  GhIssue,
  GhIssueRestPayload,
  GhPullRequest,
  RepoScanResult,
} from "../src/flash-issues/types.ts";

function createMockRunner(handlers: {
  labels?: Record<string, string[]>;
  issues?: Record<string, GhIssue[]>;
  prs?: Record<string, GhPullRequest[]>;
  issueStates?: Record<string, string>;
  restPayloads?: Record<string, GhIssueRestPayload>;
  blockedBy?: Record<string, GhDependencyIssue[]>;
}): CommandRunner {
  return (args: string[]): Promise<CommandResult> => {
    // gh label list --repo WebJamApps/<repo> ...
    if (args[0] === "label" && args[1] === "list") {
      const repoIdx = args.indexOf("--repo");
      const repo = args[repoIdx + 1].replace("WebJamApps/", "");
      const labelNames = handlers.labels?.[repo] || ["Flash Med", "Flash High"];
      const data = labelNames.map((n) => ({ name: n }));
      return Promise.resolve({ code: 0, stdout: JSON.stringify(data), stderr: "" });
    }

    // gh issue list --repo WebJamApps/<repo> ...
    if (args[0] === "issue" && args[1] === "list") {
      const repoIdx = args.indexOf("--repo");
      const repo = args[repoIdx + 1].replace("WebJamApps/", "");
      const issues = handlers.issues?.[repo] || [];
      return Promise.resolve({ code: 0, stdout: JSON.stringify(issues), stderr: "" });
    }

    // gh pr list --repo WebJamApps/<repo> ...
    if (args[0] === "pr" && args[1] === "list") {
      const repoIdx = args.indexOf("--repo");
      const repo = args[repoIdx + 1].replace("WebJamApps/", "");
      const prs = handlers.prs?.[repo] || [];
      return Promise.resolve({ code: 0, stdout: JSON.stringify(prs), stderr: "" });
    }

    // gh issue view <num> --repo WebJamApps/<repo> --json state -q .state
    if (args[0] === "issue" && args[1] === "view") {
      const num = args[2];
      const repoIdx = args.indexOf("--repo");
      const repo = args[repoIdx + 1].replace("WebJamApps/", "");
      const key = `${repo}#${num}`;
      const state = handlers.issueStates?.[key] || "OPEN";
      return Promise.resolve({ code: 0, stdout: state, stderr: "" });
    }

    // gh issue edit <num> --repo WebJamApps/<repo> --add-label <label>
    if (args[0] === "issue" && args[1] === "edit") {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }

    // gh api repos/WebJamApps/<repo>/issues/<num>/dependencies/blocked_by
    if (args[0] === "api" && args[1]?.includes("/dependencies/blocked_by")) {
      const match = args[1].match(
        /repos\/WebJamApps\/([^/]+)\/issues\/(\d+)\/dependencies\/blocked_by/,
      );
      if (match) {
        const key = `${match[1]}#${match[2]}`;
        const deps = handlers.blockedBy?.[key] || [];
        return Promise.resolve({ code: 0, stdout: JSON.stringify(deps), stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
    }

    // gh api repos/WebJamApps/<repo>/issues/<num>
    if (args[0] === "api" && args[1]?.includes("repos/WebJamApps/")) {
      const match = args[1].match(/repos\/WebJamApps\/([^/]+)\/issues\/(\d+)/);
      if (match) {
        const key = `${match[1]}#${match[2]}`;
        const payload = handlers.restPayloads?.[key] || {
          number: parseInt(match[2], 10),
          title: "Mock issue",
          issue_field_values: [{
            issue_field_name: "Priority",
            single_select_option: { name: "Medium" },
          }],
          type: { name: "Task" },
          issue_dependencies_summary: { total_blocked_by: 0 },
        };
        return Promise.resolve({ code: 0, stdout: JSON.stringify(payload), stderr: "" });
      }
    }

    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: `Unhandled mock command: gh ${args.join(" ")}`,
    });
  };
}

// -------------------------------------------------------------
// Classifier unit tests
// -------------------------------------------------------------

Deno.test("extractMilestoneName: handles string, object title/name, and null/undefined", () => {
  assertEquals(extractMilestoneName("gig-outreach"), "gig-outreach");
  assertEquals(extractMilestoneName({ title: "venue-mining" }), "venue-mining");
  assertEquals(extractMilestoneName({ name: "backup-restore" }), "backup-restore");
  assertEquals(extractMilestoneName(null), undefined);
  assertEquals(extractMilestoneName(undefined), undefined);
  assertEquals(extractMilestoneName("  "), undefined);
  assertEquals(extractMilestoneName({ title: "  " }), undefined);
});

Deno.test("getParkedOrJosh: detects parked or Josh labels case-insensitively", () => {
  assertEquals(
    getParkedOrJosh({ number: 1, title: "T", labels: [{ name: "parked" }], url: "" }),
    "parked",
  );
  assertEquals(
    getParkedOrJosh({ number: 1, title: "T", labels: [{ name: "PARKED" }], url: "" }),
    "parked",
  );
  assertEquals(
    getParkedOrJosh({ number: 1, title: "T", labels: [{ name: "Josh" }], url: "" }),
    "Josh",
  );
  assertEquals(
    getParkedOrJosh({ number: 1, title: "T", labels: [{ name: "JOSH" }], url: "" }),
    "Josh",
  );
  assertEquals(
    getParkedOrJosh({ number: 1, title: "T", labels: [{ name: "Flash Med" }], url: "" }),
    null,
  );
  assertEquals(getParkedOrJosh({ number: 1, title: "T", labels: [], url: "" }), null);
});

Deno.test("normalizeRepoName: resolves shorthands and mixed-case slugs", () => {
  assertEquals(normalizeRepoName("wjb", "web-jam-tools"), "web-jam-back");
  assertEquals(normalizeRepoName("wjt", "JaMmusic"), "web-jam-tools");
  assertEquals(normalizeRepoName("cl", "AppersonAuto"), "CollegeLutheran");
  assertEquals(normalizeRepoName("tsm", "web-jam-back"), "TimShermanMusic");
  assertEquals(normalizeRepoName("hfs", "web-jam-back"), "HenricksonForSalem");
  assertEquals(normalizeRepoName("wjsc", "web-jam-back"), "WebJamSocketCluster");
  assertEquals(normalizeRepoName("WebJamApps/JaMmusic", "JaMmusic"), "JaMmusic");
  assertEquals(normalizeRepoName("unknown", "default-repo"), "unknown");
});

Deno.test("checkDoNotDispatchMarker: ignores discussion and decision log references", async () => {
  const fetchState = () => Promise.resolve("OPEN");
  const res1 = await checkDoNotDispatchMarker(
    "decisions on web-jam-back#923",
    "JaMmusic",
    fetchState,
  );
  assertEquals(res1.isBlocked, false);

  const res2 = await checkDoNotDispatchMarker(
    "see the discussion on #200",
    "web-jam-tools",
    fetchState,
  );
  assertEquals(res2.isBlocked, false);

  const res3 = await checkDoNotDispatchMarker("", "web-jam-tools", fetchState);
  assertEquals(res3.isBlocked, false);
});

Deno.test("checkDoNotDispatchMarker: conditional marker blocked on OPEN issue, cleared on CLOSED issue", async () => {
  const fetchState = (_repo: string, num: number) =>
    Promise.resolve(num === 987 ? "OPEN" : "CLOSED");

  // Open condition -> blocked
  const resOpen = await checkDoNotDispatchMarker(
    "Do not start until wjb#987 is merged",
    "JaMmusic",
    fetchState,
  );
  assertEquals(resOpen.isBlocked, true);
  assert(resOpen.reason?.includes("web-jam-back#987 (OPEN)"));

  // Same repo relative #987 -> blocked
  const resSameRepo = await checkDoNotDispatchMarker(
    "Do not build until #987 is merged",
    "web-jam-back",
    fetchState,
  );
  assertEquals(resSameRepo.isBlocked, true);
  assert(resSameRepo.reason?.includes("#987 (OPEN)"));

  // Closed condition -> condition satisfied / unblocked
  const resClosed = await checkDoNotDispatchMarker(
    "Do not start until wjb#500 is merged",
    "JaMmusic",
    fetchState,
  );
  assertEquals(resClosed.isBlocked, false);

  // Fetch error -> fallback to blocked
  const fetchError = () => Promise.reject(new Error("network error"));
  const resError = await checkDoNotDispatchMarker(
    "Do not start until wjb#111 is merged",
    "JaMmusic",
    fetchError,
  );
  assertEquals(resError.isBlocked, true);
  assert(resError.reason?.includes("web-jam-back#111 (OPEN)"));
});

Deno.test("checkDoNotDispatchMarker: unconditional ⛔ or BLOCKED marker is always blocked", async () => {
  const fetchState = () => Promise.resolve("CLOSED");
  const res1 = await checkDoNotDispatchMarker(
    "⛔ waiting on final logo files from Josh",
    "JaMmusic",
    fetchState,
  );
  assertEquals(res1.isBlocked, true);
  assert(res1.reason?.includes("⛔ waiting on final logo files from Josh"));

  const res2 = await checkDoNotDispatchMarker(
    "BLOCKED — do not build yet, assets pending",
    "JaMmusic",
    fetchState,
  );
  assertEquals(res2.isBlocked, true);
  assert(res2.reason?.includes("BLOCKED — do not build yet, assets pending"));
});

Deno.test("findModelTier and isFlashTier: recognizes valid tiers", () => {
  assertEquals(findModelTier([{ name: "Flash High" }]), "Flash High");
  assertEquals(findModelTier([{ name: "sonnet" }]), "Sonnet");
  assertEquals(findModelTier([{ name: "opus" }]), "Opus");
  assertEquals(findModelTier([{ name: "random" }]), null);

  assert(isFlashTier("Flash"));
  assert(isFlashTier("Flash Med"));
  assert(isFlashTier("Flash High"));
  assert(isFlashTier("Flash Low"));
  assert(!isFlashTier("Sonnet"));
  assert(!isFlashTier(null));
});

Deno.test("triageUnlabeledIssue: categorizes under-specified, human tasks, duplicates, and codework", () => {
  const repoLabels = ["Flash Med", "Flash High", "Haiku", "Sonnet", "Opus"];

  // Under-specified body -> Opus
  const underSpecified = triageUnlabeledIssue(
    { number: 1, title: "Title only", body: "", labels: [], url: "" },
    repoLabels,
  );
  assertEquals(underSpecified, { action: "label", model: "Opus" });

  const titleEqualBody = triageUnlabeledIssue(
    { number: 1, title: "Fix header", body: "Fix header", labels: [], url: "" },
    repoLabels,
  );
  assertEquals(titleEqualBody, { action: "label", model: "Opus" });

  // Human / Non-codework
  const humanTask = triageUnlabeledIssue(
    {
      number: 1,
      title: "Record and publish these songs",
      body: "Record 4 new songs",
      labels: [],
      url: "",
    },
    repoLabels,
  );
  assertEquals(humanTask.action, "needs-review");
  assert(
    (humanTask as { recommendation: string }).recommendation.includes("human task, not codework"),
  );

  // Duplicate
  const duplicate = triageUnlabeledIssue(
    {
      number: 1,
      title: "Dup issue",
      body: "This is a duplicate of JaMmusic#45",
      labels: [],
      url: "",
    },
    repoLabels,
  );
  assertEquals(duplicate.action, "needs-review");
  assert(
    (duplicate as { recommendation: string }).recommendation.includes(
      "close as duplicate of JaMmusic#45",
    ),
  );

  // Already completed
  const done = triageUnlabeledIssue(
    { number: 1, title: "Old task", body: "This is already completed in dev", labels: [], url: "" },
    repoLabels,
  );
  assertEquals(done.action, "needs-review");
  assert(
    (done as { recommendation: string }).recommendation.includes("close as already completed"),
  );

  // High complexity codework -> Flash High
  const highComplex = triageUnlabeledIssue(
    {
      number: 1,
      title: "Complex refactor",
      body: "Multi-layer architecture and state management refactor",
      labels: [],
      url: "",
    },
    repoLabels,
  );
  assertEquals(highComplex, { action: "label", model: "Flash High" });

  // Normal codework -> Flash Med
  const normalMed = triageUnlabeledIssue(
    {
      number: 1,
      title: "Add mobile toggle",
      body: "Add toggle button for nav",
      labels: [],
      url: "",
    },
    repoLabels,
  );
  assertEquals(normalMed, { action: "label", model: "Flash Med" });

  // Single Flash repo -> Flash
  const singleFlash = triageUnlabeledIssue(
    {
      number: 1,
      title: "Add mobile toggle",
      body: "Add toggle button for nav",
      labels: [],
      url: "",
    },
    ["Flash", "Sonnet"],
  );
  assertEquals(singleFlash, { action: "label", model: "Flash" });
});

Deno.test("detectInFlightPr: matches body / branch and determines review status", () => {
  const candidate: FlashCandidate = {
    repo: "JaMmusic",
    number: 1215,
    title: "Gig list sorting",
    url: "https://github.com/WebJamApps/JaMmusic/issues/1215",
    tier: "Flash Med",
    body: "Implement sort",
    labels: ["Flash Med"],
  };

  // 1. Matches PR body with failing CI
  const prsCiFailing: GhPullRequest[] = [
    {
      number: 1218,
      headRefName: "agy/1215-gig-list-sorting",
      body: "Closes #1215",
      url: "https://github.com/WebJamApps/JaMmusic/pull/1218",
      title: "Sort gig list",
      statusCheckRollup: [{ conclusion: "FAILURE" }],
      commits: [{ oid: "sha1" }],
    },
  ];
  const inFlightCi = detectInFlightPr(candidate, prsCiFailing);
  assert(inFlightCi !== null);
  assertEquals(inFlightCi?.ciFailing, true);
  assertEquals(inFlightCi?.reviewState, "unreviewed");

  // 2. Matches automated review with Must Fix items
  const prsChangesRequested: GhPullRequest[] = [
    {
      number: 1218,
      headRefName: "agy/1215-gig-list-sorting",
      body: "Closes #1215",
      url: "https://github.com/WebJamApps/JaMmusic/pull/1218",
      title: "Sort gig list",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
      commits: [{ oid: "sha1" }],
      reviews: [
        {
          commit: { oid: "sha1" },
          body:
            "## PR Review Summary\n\n### 🛑 Must Fix Items\n- 🛑 Fix sorting on mobile\n- 🛑 Add test",
          state: "CHANGES_REQUESTED",
        },
      ],
    },
  ];
  const inFlightChanges = detectInFlightPr(candidate, prsChangesRequested);
  assert(inFlightChanges !== null);
  assertEquals(inFlightChanges?.reviewState, "changes_requested");
  assertEquals(inFlightChanges?.mustFixCount, 2);

  // 3. Approved review
  const prsApproved: GhPullRequest[] = [
    {
      number: 1218,
      headRefName: "agy/1215-gig-list-sorting",
      body: "Closes #1215",
      url: "https://github.com/WebJamApps/JaMmusic/pull/1218",
      title: "Sort gig list",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
      commits: [{ oid: "sha1" }],
      reviews: [
        {
          commit: { oid: "sha1" },
          body: "## PR Review Summary\n\n**✅ Approved**\n\n### 🛑 Must Fix Items\n✅ None",
          state: "APPROVED",
        },
      ],
    },
  ];
  const inFlightApproved = detectInFlightPr(candidate, prsApproved);
  assert(inFlightApproved !== null);
  assertEquals(inFlightApproved?.reviewState, "approved");
  assertEquals(inFlightApproved?.mustFixCount, 0);

  // 4. Non-matching PR
  const nonMatchingPrs: GhPullRequest[] = [
    {
      number: 999,
      headRefName: "agy/999-other",
      body: "Closes #999",
      url: "https://github.com/WebJamApps/JaMmusic/pull/999",
      title: "Other",
    },
  ];
  assertEquals(detectInFlightPr(candidate, nonMatchingPrs), null);
});

// -------------------------------------------------------------
// Reconciler & Sorting unit tests
// -------------------------------------------------------------

Deno.test("sortRunnableCandidates: orders by Priority, Type Bug, and respects dependency ordering", () => {
  const candidates: FlashCandidate[] = [
    {
      repo: "JaMmusic",
      number: 102,
      title: "Low priority bug",
      url: "",
      tier: "Flash Med",
      body: "",
      labels: [],
      priority: "Low",
      type: "Bug",
    },
    {
      repo: "JaMmusic",
      number: 101,
      title: "High priority feature",
      url: "",
      tier: "Flash Med",
      body: "",
      labels: [],
      priority: "High",
      type: "Feature",
    },
    {
      repo: "JaMmusic",
      number: 103,
      title: "Urgent dependent task",
      url: "",
      tier: "Flash High",
      body: "",
      labels: [],
      priority: "Urgent",
      type: "Task",
      dependencies: [
        {
          number: 101,
          state: "open",
          title: "High priority feature",
          repository: { name: "JaMmusic" },
        },
      ],
    },
  ];

  const sorted = sortRunnableCandidates(candidates);
  assertEquals(sorted.length, 3);
  // Even though #103 is Urgent, it depends on #101, so #101 must appear first!
  assertEquals(sorted[0].number, 101);
  assertEquals(sorted[1].number, 103);
  assertEquals(sorted[1].samePoolDependency, { repo: "JaMmusic", number: 101 });
  assertEquals(sorted[2].number, 102);
});

Deno.test("classifyAll and reconcileCounts: end-to-end multi-repo classification and reconciliation", async () => {
  const runner = createMockRunner({
    labels: {
      "web-jam-tools": ["Flash Med", "Flash High", "Haiku", "Sonnet", "Opus"],
      "JaMmusic": ["Flash Med", "Flash High", "Haiku", "Sonnet"],
    },
    issues: {
      "web-jam-tools": [
        { number: 1, title: "Parked issue", labels: [{ name: "parked" }], url: "url1", body: "" },
        { number: 2, title: "Josh manual", labels: [{ name: "Josh" }], url: "url2", body: "" },
        {
          number: 3,
          title: "Sonnet issue",
          labels: [{ name: "Sonnet" }],
          url: "url3",
          body: "Coding",
        },
        {
          number: 4,
          title: "Unlabeled human",
          labels: [],
          url: "url4",
          body: "phone call to venue",
        },
        {
          number: 5,
          title: "Runnable 1",
          labels: [{ name: "Flash Med" }],
          url: "url5",
          body: "Code",
          milestone: "topic-1",
        },
        {
          number: 6,
          title: "In flight PR issue",
          labels: [{ name: "Flash Med" }],
          url: "url6",
          body: "Code",
        },
      ],
      "JaMmusic": [
        {
          number: 10,
          title: "Blocked on external Sonnet",
          labels: [{ name: "Flash High" }],
          url: "url10",
          body: "Code",
        },
      ],
    },
    prs: {
      "web-jam-tools": [
        {
          number: 50,
          headRefName: "agy/6-feature",
          body: "Closes #6",
          url: "pr-url-50",
          title: "PR 50",
          statusCheckRollup: [{ conclusion: "SUCCESS" }],
        },
      ],
    },
    restPayloads: {
      "web-jam-tools#5": {
        number: 5,
        title: "Runnable 1",
        issue_field_values: [{
          issue_field_name: "Priority",
          single_select_option: { name: "High" },
        }],
        type: { name: "Bug" },
        issue_dependencies_summary: { total_blocked_by: 0 },
      },
      "JaMmusic#10": {
        number: 10,
        title: "Blocked on external Sonnet",
        issue_field_values: [{
          issue_field_name: "Priority",
          single_select_option: { name: "Medium" },
        }],
        type: { name: "Feature" },
        issue_dependencies_summary: { total_blocked_by: 1 },
      },
    },
    blockedBy: {
      "JaMmusic#10": [
        {
          number: 99,
          state: "open",
          title: "Backend API",
          repository: { name: "web-jam-back" },
          labels: [{ name: "Sonnet" }],
        },
      ],
    },
  });

  const scanResults: RepoScanResult[] = [
    {
      repo: "web-jam-tools",
      labels: ["Flash Med", "Flash High", "Haiku", "Sonnet", "Opus"],
      issues: [
        { number: 1, title: "Parked issue", labels: [{ name: "parked" }], url: "url1", body: "" },
        { number: 2, title: "Josh manual", labels: [{ name: "Josh" }], url: "url2", body: "" },
        {
          number: 3,
          title: "Sonnet issue",
          labels: [{ name: "Sonnet" }],
          url: "url3",
          body: "Coding",
        },
        {
          number: 4,
          title: "Unlabeled human",
          labels: [],
          url: "url4",
          body: "phone call to venue",
        },
        {
          number: 5,
          title: "Runnable 1",
          labels: [{ name: "Flash Med" }],
          url: "url5",
          body: "Code",
          milestone: "topic-1",
        },
        {
          number: 6,
          title: "In flight PR issue",
          labels: [{ name: "Flash Med" }],
          url: "url6",
          body: "Code",
        },
      ],
      prs: [
        {
          number: 50,
          headRefName: "agy/6-feature",
          body: "Closes #6",
          url: "pr-url-50",
          title: "PR 50",
          statusCheckRollup: [{ conclusion: "SUCCESS" }],
        },
      ],
    },
    {
      repo: "JaMmusic",
      labels: ["Flash Med", "Flash High", "Haiku", "Sonnet"],
      issues: [
        {
          number: 10,
          title: "Blocked on external Sonnet",
          labels: [{ name: "Flash High" }],
          url: "url10",
          body: "Code",
        },
      ],
      prs: [],
    },
  ];

  const classified = await classifyAll(scanResults, { runner });
  assertEquals(classified.skippedParkedJosh.length, 2);
  assertEquals(classified.skippedOtherModel.length, 1);
  assertEquals(classified.needsReview.length, 1);
  assertEquals(classified.runnable.length, 1);
  assertEquals(classified.inFlight.length, 1);
  assertEquals(classified.blocked.length, 1);
  assertEquals(classified.fixPrs.length, 0);

  const recon = reconcileCounts(scanResults, classified);
  assertEquals(recon.totalScanned, 7);
  assertEquals(recon.totalCategorized, 7);
  assertEquals(recon.reconciled, true);
});

// -------------------------------------------------------------
// Formatter unit tests
// -------------------------------------------------------------

Deno.test("formatMarkdown: generates correct markdown sections and snapshot structure", () => {
  const classified: ClassifiedResult = {
    fixPrs: [
      {
        repo: "JaMmusic",
        number: 1215,
        title: "Gig list sorting",
        url: "https://github.com/WebJamApps/JaMmusic/issues/1215",
        tier: "Flash Med",
        milestone: "gig-outreach",
        body: "",
        labels: [],
        prNumber: 1218,
        prUrl: "https://github.com/WebJamApps/JaMmusic/pull/1218",
        headRefName: "agy/1215-gig-list-sorting",
        ciFailing: false,
        reviewState: "changes_requested",
        mustFixCount: 2,
      },
      {
        repo: "AppersonAuto",
        number: 90,
        title: "Fix date picker",
        url: "https://github.com/WebJamApps/AppersonAuto/issues/90",
        tier: "Flash Med",
        body: "",
        labels: [],
        prNumber: 92,
        prUrl: "https://github.com/WebJamApps/AppersonAuto/pull/92",
        headRefName: "agy/90-fix-date-picker",
        ciFailing: true,
        reviewState: "unreviewed",
      },
    ],
    runnable: [
      {
        repo: "CollegeLutheran",
        number: 123,
        title: "Add mobile nav collapse toggle",
        url: "https://github.com/WebJamApps/CollegeLutheran/issues/123",
        tier: "Flash Med",
        body: "",
        labels: [],
      },
      {
        repo: "JaMmusic",
        number: 1221,
        title: "Venue picker: wire selection to gig form",
        url: "https://github.com/WebJamApps/JaMmusic/issues/1221",
        tier: "Flash High",
        milestone: "gig-outreach",
        body: "",
        labels: [],
        samePoolDependency: { repo: "JaMmusic", number: 1220 },
      },
    ],
    inFlight: [
      {
        repo: "WebJamSocketCluster",
        number: 45,
        title: "Reconnect backoff timer",
        url: "https://github.com/WebJamApps/WebJamSocketCluster/issues/45",
        tier: "Flash Med",
        body: "",
        labels: [],
        prNumber: 48,
        prUrl: "https://github.com/WebJamApps/WebJamSocketCluster/pull/48",
        headRefName: "agy/45-reconnect-backoff",
        ciFailing: false,
        reviewState: "unreviewed",
      },
      {
        repo: "TimShermanMusic",
        number: 66,
        title: "Slideshow transition",
        url: "https://github.com/WebJamApps/TimShermanMusic/issues/66",
        tier: "Flash Med",
        body: "",
        labels: [],
        prNumber: 67,
        prUrl: "https://github.com/WebJamApps/TimShermanMusic/pull/67",
        headRefName: "agy/66-slideshow-transition",
        ciFailing: false,
        reviewState: "approved",
      },
    ],
    blocked: [
      {
        repo: "AppersonAuto",
        number: 88,
        title: "Inventory filter UI",
        url: "https://github.com/WebJamApps/AppersonAuto/issues/88",
        tier: "Flash Med",
        body: "",
        labels: [],
        blockedReason: "depends on AppersonAuto#85 (Sonnet, backend endpoint not built)",
      },
    ],
    needsReview: [
      {
        repo: "TimShermanMusic",
        number: 57,
        title: "Update booking email",
        url: "https://github.com/WebJamApps/TimShermanMusic/issues/57",
        recommendation: "recommend: close as duplicate of TimShermanMusic#52",
      },
    ],
    skippedOtherModel: [],
    skippedParkedJosh: [],
    newlyLabeled: [],
  };

  const md = formatMarkdown(classified, new Date("2026-08-19T08:00:00.000Z"));
  assert(md.includes("# Flash-lane issues"));
  assert(md.includes("Last updated: 2026-08-19T08:00:00.000Z"));
  assert(md.includes("## Fix your open PRs first"));
  assert(
    md.includes(
      "- [JaMmusic#1215](https://github.com/WebJamApps/JaMmusic/issues/1215) — Gig list sorting (Flash Med, milestone: gig-outreach) — PR: [JaMmusic#1218](https://github.com/WebJamApps/JaMmusic/pull/1218) (`agy/1215-gig-list-sorting`) — changes requested: 2 must fix — [review](https://github.com/WebJamApps/JaMmusic/pull/1218)",
    ),
  );
  assert(
    md.includes(
      "- [AppersonAuto#90](https://github.com/WebJamApps/AppersonAuto/issues/90) — Fix date picker (Flash Med) — PR: [AppersonAuto#92](https://github.com/WebJamApps/AppersonAuto/pull/92) (`agy/90-fix-date-picker`) — CI failing — [review](https://github.com/WebJamApps/AppersonAuto/pull/92)",
    ),
  );
  assert(
    md.includes(
      "1. [CollegeLutheran#123](https://github.com/WebJamApps/CollegeLutheran/issues/123) — Add mobile nav collapse toggle (Flash Med)",
    ),
  );
  assert(
    md.includes(
      "2. [JaMmusic#1221](https://github.com/WebJamApps/JaMmusic/issues/1221) — Venue picker: wire selection to gig form (Flash High, milestone: gig-outreach, depends on JaMmusic#1220 above)",
    ),
  );
  assert(md.includes("## In Flight (Pending PR Review)"));
  assert(
    md.includes(
      "- [WebJamSocketCluster#45](https://github.com/WebJamApps/WebJamSocketCluster/issues/45) — Reconnect backoff timer (Flash Med) — PR: [WebJamSocketCluster#48](https://github.com/WebJamApps/WebJamSocketCluster/pull/48) (`agy/45-reconnect-backoff`)",
    ),
  );
  assert(
    md.includes(
      "- [TimShermanMusic#66](https://github.com/WebJamApps/TimShermanMusic/issues/66) — Slideshow transition (Flash Med) — PR: [TimShermanMusic#67](https://github.com/WebJamApps/TimShermanMusic/pull/67) (`agy/66-slideshow-transition`) — reviewed — approved",
    ),
  );
  assert(md.includes("## Blocked (not runnable by Flash)"));
  assert(
    md.includes(
      "- [AppersonAuto#88](https://github.com/WebJamApps/AppersonAuto/issues/88) — Inventory filter UI (Flash Med) — blocked: depends on AppersonAuto#85 (Sonnet, backend endpoint not built)",
    ),
  );
  assert(md.includes("## Needs Josh's review (no agent will touch these until you decide)"));
  assert(
    md.includes(
      "- [TimShermanMusic#57](https://github.com/WebJamApps/TimShermanMusic/issues/57) — Update booking email — recommend: close as duplicate of TimShermanMusic#52",
    ),
  );
});

Deno.test("formatConsoleReport: reports all summary lines and confirmations", () => {
  const recon: FlashIssuesReconciliation = {
    totalScanned: 10,
    totalCategorized: 10,
    bucketCounts: {
      fixPrs: { total: 1, changesRequested: 1, ciFailing: 0 },
      runnable: 3,
      inFlight: { total: 2, unreviewed: 1, approved: 1 },
      blocked: 1,
      needsReview: 1,
      skippedOtherModel: 1,
      skippedParkedJosh: 1,
    },
    reconciled: true,
  };

  const classified: ClassifiedResult = {
    fixPrs: [],
    runnable: [],
    inFlight: [],
    blocked: [],
    needsReview: [],
    skippedOtherModel: [],
    skippedParkedJosh: [],
    newlyLabeled: [{ repo: "JaMmusic", number: 100, label: "Flash Med" }],
  };

  const scanResults: RepoScanResult[] = [
    {
      repo: "web-jam-tools",
      labels: ["Flash Med"],
      issues: [{ number: 1, title: "A", labels: [], url: "" }],
      prs: [],
    },
  ];

  const report = formatConsoleReport(recon, classified, scanResults, "/tmp/flash-issues.md");
  assert(report.includes("## Flash-lane worklist regeneration complete"));
  assert(report.includes("**web-jam-tools**: 1 open issues"));
  assert(report.includes("JaMmusic#100 → `Flash Med`"));
  assert(report.includes("**Fix your open PRs first**: 1"));
  assert(report.includes("**Numbered runnable list**: 3"));
  assert(report.includes("Step 8 Reconciliation"));
  assert(report.includes("✅ Verified exact match"));
  assert(report.includes("Output snapshot written to: /tmp/flash-issues.md"));
});

// -------------------------------------------------------------
// Scanner unit tests
// -------------------------------------------------------------

Deno.test("scanner helpers: test all gh fetching functions with mock runner", async () => {
  const runner = createMockRunner({
    labels: { JaMmusic: ["Flash Med"] },
    issues: { JaMmusic: [{ number: 10, title: "Test", labels: [], url: "u" }] },
    prs: { JaMmusic: [{ number: 20, headRefName: "b", body: "", url: "p", title: "P" }] },
    issueStates: { "JaMmusic#10": "OPEN" },
    restPayloads: {
      "JaMmusic#10": {
        number: 10,
        title: "Test",
        issue_field_values: [{
          issue_field_name: "Priority",
          single_select_option: { name: "Urgent" },
        }],
        type: { name: "Bug" },
        issue_dependencies_summary: { total_blocked_by: 1 },
      },
    },
    blockedBy: {
      "JaMmusic#10": [{ number: 99, state: "open", title: "Dep" }],
    },
  });

  assertEquals(await fetchRepoLabels("JaMmusic", runner), ["Flash Med"]);
  assertEquals((await fetchRepoIssues("JaMmusic", runner)).length, 1);
  assertEquals((await fetchRepoPrs("JaMmusic", runner)).length, 1);
  assertEquals(await fetchIssueState("JaMmusic", 10, runner), "OPEN");

  const rest = await fetchIssueRestPayload("JaMmusic", 10, runner);
  assertEquals(rest.number, 10);
  assertEquals(rest.type?.name, "Bug");

  const deps = await fetchIssueBlockedBy("JaMmusic", 10, runner);
  assertEquals(deps.length, 1);

  await applyIssueLabel("JaMmusic", 10, "Flash Med", runner);

  const scanned = await scanRepo("JaMmusic", runner);
  assertEquals(scanned.repo, "JaMmusic");
  assertEquals(scanned.issues.length, 1);

  const allScanned = await scanAllRepos(["JaMmusic"], runner);
  assertEquals(allScanned.length, 1);
});

Deno.test("runGh throws on non-zero exit", async () => {
  const errorRunner: CommandRunner = () =>
    Promise.resolve({ code: 1, stdout: "", stderr: "command failed" });
  await assertRejects(() => runGh(["invalid"], errorRunner), Error, "command failed");
});

// -------------------------------------------------------------
// CLI unit tests
// -------------------------------------------------------------

Deno.test("expandHome: expands ~ to HOME environment variable", () => {
  const home = Deno.env.get("HOME") || "/home/joshua";
  assertEquals(expandHome("~/test/path"), `${home}/test/path`);
  assertEquals(expandHome("~"), `${home}/`);
  assertEquals(expandHome("/absolute/path"), "/absolute/path");
});

Deno.test("runCli: --help prints usage and exits 0", async () => {
  const code = await runCli(["--help"]);
  assertEquals(code, 0);
});

Deno.test("runCli: runs full pipeline with mock runner, dry-run, and json options", async () => {
  const runner = createMockRunner({
    labels: {
      "web-jam-tools": ["Flash Med"],
    },
    issues: {
      "web-jam-tools": [
        { number: 1, title: "Test issue", labels: [{ name: "Flash Med" }], url: "u", body: "b" },
      ],
    },
  });

  const tempDir = await Deno.makeTempDir();
  const outPath = `${tempDir}/flash-issues.md`;

  try {
    // 1. Dry run
    const codeDry = await runCli(["--dry-run", "--out", outPath], runner);
    assertEquals(codeDry, 0);

    // 2. Real write + json
    const codeJson = await runCli(["--json", "--out", outPath], runner);
    assertEquals(codeJson, 0);

    // Verify file was written
    const fileContent = await Deno.readTextFile(outPath);
    assert(fileContent.includes("# Flash-lane issues"));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("reconciler edge cases: dependency reasons, cycles, closed deps, and REST errors", async () => {
  // Test cycles in sortRunnableCandidates
  const cycleCandidates: FlashCandidate[] = [
    {
      repo: "JaMmusic",
      number: 1,
      title: "Cycle A",
      url: "",
      tier: "Flash Med",
      body: "",
      labels: [],
      dependencies: [{ number: 2, state: "open", title: "Cycle B" }],
    },
    {
      repo: "JaMmusic",
      number: 2,
      title: "Cycle B",
      url: "",
      tier: "Flash Med",
      body: "",
      labels: [],
      dependencies: [{ number: 1, state: "open", title: "Cycle A" }],
    },
  ];
  const sortedCycle = sortRunnableCandidates(cycleCandidates);
  assertEquals(sortedCycle.length, 2);

  // Test classifyAll with closed dependency, full_name repo dep, REST error, and Josh label on dep
  const runner = createMockRunner({
    labels: {
      "JaMmusic": ["Flash Med", "Flash High"],
    },
    issues: {
      "JaMmusic": [
        {
          number: 101,
          title: "Has closed dep and Josh dep",
          labels: [{ name: "Flash Med" }],
          url: "u1",
          body: "",
        },
        {
          number: 102,
          title: "REST error candidate",
          labels: [{ name: "Flash Med" }],
          url: "u2",
          body: "",
        },
        { number: 103, title: "Failing label edit", labels: [], url: "u3", body: "Coding task" },
        {
          number: 104,
          title: "Custom label dep",
          labels: [{ name: "Flash Med" }],
          url: "u4",
          body: "",
        },
        {
          number: 105,
          title: "Empty label dep",
          labels: [{ name: "Flash Med" }],
          url: "u5",
          body: "",
        },
      ],
    },
    prs: {
      "JaMmusic": [],
    },
    restPayloads: {
      "JaMmusic#101": {
        number: 101,
        title: "Has closed dep",
        issue_field_values: [{
          issue_field_name: "Priority",
          single_select_option: { name: "Low" },
        }],
        type: { name: "Task" },
        issue_dependencies_summary: { total_blocked_by: 2 },
      },
      "JaMmusic#104": {
        number: 104,
        title: "Custom label dep",
        issue_field_values: [{
          issue_field_name: "Priority",
          single_select_option: { name: "Urgent" },
        }],
        type: { name: "Task" },
        issue_dependencies_summary: { total_blocked_by: 1 },
      },
      "JaMmusic#105": {
        number: 105,
        title: "Empty label dep",
        issue_field_values: [{
          issue_field_name: "Priority",
          single_select_option: { name: "High" },
        }],
        type: { name: "Task" },
        issue_dependencies_summary: { total_blocked_by: 1 },
      },
    },
    blockedBy: {
      "JaMmusic#101": [
        { number: 50, state: "closed", title: "Closed dep" },
        {
          number: 60,
          state: "open",
          title: "Josh dep",
          repository: { full_name: "WebJamApps/web-jam-back" },
          labels: [{ name: "Sonnet" }, { name: "Josh" }],
        },
      ],
      "JaMmusic#104": [
        {
          number: 70,
          state: "open",
          title: "Custom label dep",
          repository: { name: "web-jam-back" },
          labels: [{ name: "vendor-api" }],
        },
      ],
      "JaMmusic#105": [
        {
          number: 80,
          state: "open",
          title: "Empty label dep",
          repository: { name: "web-jam-back" },
          labels: [],
        },
      ],
    },
  });

  const scanResults: RepoScanResult[] = [
    {
      repo: "JaMmusic",
      labels: ["Flash Med"],
      issues: [
        {
          number: 101,
          title: "Has closed dep and Josh dep",
          labels: [{ name: "Flash Med" }],
          url: "u1",
          body: "",
        },
        {
          number: 102,
          title: "REST error candidate",
          labels: [{ name: "Flash Med" }],
          url: "u2",
          body: "",
        },
        { number: 103, title: "Failing label edit", labels: [], url: "u3", body: "Coding task" },
        {
          number: 104,
          title: "Custom label dep",
          labels: [{ name: "Flash Med" }],
          url: "u4",
          body: "",
        },
        {
          number: 105,
          title: "Empty label dep",
          labels: [{ name: "Flash Med" }],
          url: "u5",
          body: "",
        },
      ],
      prs: [],
    },
  ];

  const classified = await classifyAll(scanResults, { runner });
  assertEquals(classified.blocked.length, 3);
  assert(classified.blocked[0].blockedReason.includes("web-jam-back#60 (Sonnet, Josh)"));
  assert(classified.blocked[1].blockedReason.includes("web-jam-back#70 (vendor-api)"));
  assert(classified.blocked[2].blockedReason.includes("web-jam-back#80 (unresolved dependency)"));
  assertEquals(classified.runnable.length, 2);
});

Deno.test("runCli: fails and exits 1 when reconciliation mismatch occurs", () => {
  const scanResults: RepoScanResult[] = [
    {
      repo: "web-jam-tools",
      labels: ["Flash Med"],
      issues: [{ number: 1, title: "Test", labels: [{ name: "Flash Med" }], url: "" }],
      prs: [],
    },
  ];
  const classified: ClassifiedResult = {
    fixPrs: [],
    runnable: [],
    inFlight: [],
    blocked: [],
    needsReview: [],
    skippedOtherModel: [],
    skippedParkedJosh: [],
    newlyLabeled: [],
  };
  const recon = reconcileCounts(scanResults, classified);
  assertEquals(recon.reconciled, false);
  assertEquals(recon.totalScanned, 1);
  assertEquals(recon.totalCategorized, 0);
});

Deno.test("runCli: handles --output flag and default target path writing", async () => {
  const runner = createMockRunner({
    labels: { "web-jam-tools": ["Flash Med"] },
    issues: { "web-jam-tools": [] },
  });
  const tempDir = await Deno.makeTempDir();
  const outPath = `${tempDir}/output.md`;
  try {
    const code = await runCli(["--output", outPath], runner);
    assertEquals(code, 0);
    const content = await Deno.readTextFile(outPath);
    assert(content.includes("# Flash-lane issues"));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runCli: returns 1 when scanner throws an error", async () => {
  const errorRunner: CommandRunner = () =>
    Promise.resolve({ code: 1, stdout: "", stderr: "gh error" });
  const code = await runCli([], errorRunner);
  assertEquals(code, 1);
});
