// test/sweep_redundant_blocked_labels.test.ts
//
// Unit tests for scripts/sweep_redundant_blocked_labels.ts (web-jam-tools#730).
// Validates candidate detection, dry-run, apply behavior, error handling, and formatting.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  ACTIVE_REPOS,
  type CommandRunner,
  fetchBlockedByDependencies,
  fetchBlockedIssues,
  formatSummaryTable,
  main,
  parseCliArgs,
  removeBlockedLabel,
  sweepAll,
  sweepRepo,
  type SweepSummary,
} from "../scripts/sweep_redundant_blocked_labels.ts";

Deno.test("parseCliArgs parses default arguments (dry-run across all 8 repos)", () => {
  const opts = parseCliArgs([]);
  assertEquals(opts.apply, false);
  assertEquals(opts.help, false);
  assertEquals(opts.repos, [...ACTIVE_REPOS]);
});

Deno.test("parseCliArgs parses --apply flag", () => {
  const opts = parseCliArgs(["--apply"]);
  assertEquals(opts.apply, true);
  assertEquals(opts.repos, [...ACTIVE_REPOS]);
});

Deno.test("parseCliArgs parses --dry-run flag explicitly", () => {
  const opts = parseCliArgs(["--dry-run"]);
  assertEquals(opts.apply, false);
});

Deno.test("parseCliArgs parses --repo flag with space and equals format", () => {
  const opts1 = parseCliArgs(["--repo", "JaMmusic"]);
  assertEquals(opts1.repos, ["JaMmusic"]);

  const opts2 = parseCliArgs(["--repo=CollegeLutheran"]);
  assertEquals(opts2.repos, ["CollegeLutheran"]);

  const opts3 = parseCliArgs(["--repo", "WebJamApps/web-jam-tools"]);
  assertEquals(opts3.repos, ["web-jam-tools"]);
});

Deno.test("parseCliArgs parses --help / -h flag", () => {
  assertEquals(parseCliArgs(["--help"]).help, true);
  assertEquals(parseCliArgs(["-h"]).help, true);
});

Deno.test("fetchBlockedIssues parses issues list correctly", async () => {
  const fakeRunner: CommandRunner = (args) => {
    assertEquals(args[0], "issue");
    assertEquals(args[1], "list");
    assertEquals(args[3], "WebJamApps/JaMmusic");
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify([
        {
          number: 1323,
          title: "Upgrade jsdom",
          url: "https://github.com/WebJamApps/JaMmusic/issues/1323",
          labels: [{ name: "Blocked" }],
        },
      ]),
      stderr: "",
    });
  };

  const issues = await fetchBlockedIssues("JaMmusic", fakeRunner);
  assertEquals(issues.length, 1);
  assertEquals(issues[0].number, 1323);
  assertEquals(issues[0].title, "Upgrade jsdom");
});

Deno.test("fetchBlockedIssues handles empty output and non-zero exit", async () => {
  const emptyRunner: CommandRunner = () =>
    Promise.resolve({
      code: 0,
      stdout: "",
      stderr: "",
    });
  const issues = await fetchBlockedIssues("AppersonAuto", emptyRunner);
  assertEquals(issues, []);

  const failRunner: CommandRunner = () =>
    Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "API rate limit exceeded",
    });
  await assertRejects(
    () => fetchBlockedIssues("AppersonAuto", failRunner),
    Error,
    "Failed to list Blocked issues for AppersonAuto: API rate limit exceeded",
  );
});

Deno.test("fetchBlockedByDependencies parses native dependency issues", async () => {
  const fakeRunner: CommandRunner = (args) => {
    assertEquals(args[0], "api");
    assertEquals(args[1], "repos/WebJamApps/JaMmusic/issues/1323/dependencies/blocked_by");
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify([
        {
          number: 1322,
          state: "open",
          title: "Upgrade react-router",
        },
      ]),
      stderr: "",
    });
  };

  const deps = await fetchBlockedByDependencies("JaMmusic", 1323, fakeRunner);
  assertEquals(deps.length, 1);
  assertEquals(deps[0].number, 1322);
});

Deno.test("fetchBlockedByDependencies handles empty dependencies and errors", async () => {
  const emptyRunner: CommandRunner = () =>
    Promise.resolve({
      code: 0,
      stdout: "[]",
      stderr: "",
    });
  const deps = await fetchBlockedByDependencies("web-jam-tools", 611, emptyRunner);
  assertEquals(deps, []);

  const failRunner: CommandRunner = () =>
    Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "Not Found",
    });
  await assertRejects(
    () => fetchBlockedByDependencies("web-jam-tools", 9999, failRunner),
    Error,
    "Failed to fetch blocked_by dependencies for web-jam-tools#9999: Not Found",
  );
});

Deno.test("removeBlockedLabel removes the label via gh issue edit", async () => {
  let executedArgs: string[] = [];
  const fakeRunner: CommandRunner = (args) => {
    executedArgs = args;
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };

  await removeBlockedLabel("JaMmusic", 1323, fakeRunner);
  assertEquals(executedArgs, [
    "issue",
    "edit",
    "1323",
    "--repo",
    "WebJamApps/JaMmusic",
    "--remove-label",
    "Blocked",
  ]);

  const failRunner: CommandRunner = () =>
    Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "could not edit issue",
    });
  await assertRejects(
    () => removeBlockedLabel("JaMmusic", 1323, failRunner),
    Error,
    "Failed to remove Blocked label from JaMmusic#1323: could not edit issue",
  );
});

Deno.test("sweepRepo detects redundant labels and respects --dry-run vs --apply", async () => {
  const executedCalls: string[][] = [];
  const fakeRunner: CommandRunner = (args) => {
    executedCalls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify([
          {
            number: 101,
            title: "Issue with native dependency",
            url: "https://github.com/WebJamApps/web-jam-tools/issues/101",
            labels: [{ name: "Blocked" }],
          },
          {
            number: 102,
            title: "Issue with external blocker only",
            url: "https://github.com/WebJamApps/web-jam-tools/issues/102",
            labels: [{ name: "Blocked" }],
          },
        ]),
        stderr: "",
      });
    }
    if (args[0] === "api" && args[1].includes("/issues/101/dependencies/blocked_by")) {
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify([{ number: 100 }]),
        stderr: "",
      });
    }
    if (args[0] === "api" && args[1].includes("/issues/102/dependencies/blocked_by")) {
      return Promise.resolve({
        code: 0,
        stdout: "[]",
        stderr: "",
      });
    }
    if (args[0] === "issue" && args[1] === "edit") {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };

  // Test dry-run
  const dryRunItems = await sweepRepo("web-jam-tools", { apply: false }, fakeRunner);
  assertEquals(dryRunItems.length, 2);

  assertEquals(dryRunItems[0].number, 101);
  assertEquals(dryRunItems[0].isRedundant, true);
  assertEquals(dryRunItems[0].nativeBlockers, [100]);
  assertEquals(dryRunItems[0].actionTaken, "would_remove");

  assertEquals(dryRunItems[1].number, 102);
  assertEquals(dryRunItems[1].isRedundant, false);
  assertEquals(dryRunItems[1].nativeBlockers, []);
  assertEquals(dryRunItems[1].actionTaken, "kept_external");

  // Verify issue edit was NOT called during dry-run
  const editCallsInDryRun = executedCalls.filter((c) => c[0] === "issue" && c[1] === "edit");
  assertEquals(editCallsInDryRun.length, 0);

  // Test apply
  const applyItems = await sweepRepo("web-jam-tools", { apply: true }, fakeRunner);
  assertEquals(applyItems.length, 2);
  assertEquals(applyItems[0].actionTaken, "removed");
  assertEquals(applyItems[1].actionTaken, "kept_external");

  const editCallsInApply = executedCalls.filter((c) => c[0] === "issue" && c[1] === "edit");
  assertEquals(editCallsInApply.length, 1);
  assertEquals(editCallsInApply[0][2], "101");
});

Deno.test("sweepAll aggregates across repositories", async () => {
  const fakeRunner: CommandRunner = (args) => {
    if (args[0] === "issue" && args[1] === "list") {
      const repoArg = args[3];
      if (repoArg === "WebJamApps/JaMmusic") {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify([
            {
              number: 1323,
              title: "Upgrade jsdom",
              url: "https://github.com/WebJamApps/JaMmusic/issues/1323",
              labels: [{ name: "Blocked" }],
            },
          ]),
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
    }
    if (args[0] === "api") {
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify([{ number: 1322 }]),
        stderr: "",
      });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };

  const summary = await sweepAll(["JaMmusic", "CollegeLutheran"], { apply: false }, fakeRunner);
  assertEquals(summary.totalExamined, 1);
  assertEquals(summary.totalRedundant, 1);
  assertEquals(summary.totalModified, 0);
  assertEquals(summary.totalKept, 0);
  assertEquals(summary.applied, false);
});

Deno.test("formatSummaryTable renders markdown table correctly", () => {
  const mockSummary: SweepSummary = {
    items: [
      {
        repo: "JaMmusic",
        number: 1323,
        title: "Upgrade jsdom",
        url: "https://github.com/WebJamApps/JaMmusic/issues/1323",
        nativeBlockers: [1322],
        isRedundant: true,
        actionTaken: "would_remove",
      },
      {
        repo: "CollegeLutheran",
        number: 506,
        title: "Create history page",
        url: "https://github.com/WebJamApps/CollegeLutheran/issues/506",
        nativeBlockers: [],
        isRedundant: false,
        actionTaken: "kept_external",
      },
    ],
    totalExamined: 2,
    totalRedundant: 1,
    totalModified: 0,
    totalKept: 1,
    applied: false,
  };

  const table = formatSummaryTable(mockSummary);
  assertStringIncludes(table, "Mode: **DRY RUN**");
  assertStringIncludes(
    table,
    "| `JaMmusic` | #1323 | Upgrade jsdom | #1322 | ⚠️ **WOULD REMOVE (Dry Run)** |",
  );
  assertStringIncludes(
    table,
    "| `CollegeLutheran` | #506 | Create history page | *(none — external)* | 🔒 **KEPT (External Blocker)** |",
  );
  assertStringIncludes(table, "- **Total Blocked issues examined**: 2");
  assertStringIncludes(table, "- **Redundant Blocked labels identified**: 1");
  assertStringIncludes(table, "- **Blocked labels to remove on --apply**: 1");
  assertStringIncludes(table, "- **External blockers preserved**: 1");
});

Deno.test("formatSummaryTable renders applied summary correctly", () => {
  const mockSummary: SweepSummary = {
    items: [
      {
        repo: "JaMmusic",
        number: 1323,
        title: "Upgrade jsdom",
        url: "https://github.com/WebJamApps/JaMmusic/issues/1323",
        nativeBlockers: [1322],
        isRedundant: true,
        actionTaken: "removed",
      },
    ],
    totalExamined: 1,
    totalRedundant: 1,
    totalModified: 1,
    totalKept: 0,
    applied: true,
  };

  const table = formatSummaryTable(mockSummary);
  assertStringIncludes(table, "Mode: **APPLY**");
  assertStringIncludes(table, "✅ **REMOVED**");
  assertStringIncludes(table, "- **Blocked labels removed**: 1");
});

Deno.test("formatSummaryTable handles empty summary", () => {
  const mockSummary: SweepSummary = {
    items: [],
    totalExamined: 0,
    totalRedundant: 0,
    totalModified: 0,
    totalKept: 0,
    applied: false,
  };

  const table = formatSummaryTable(mockSummary);
  assertStringIncludes(table, "No open issues with `Blocked` label found.");
});

Deno.test("main CLI executes cleanly with options and runner", async () => {
  const fakeRunner: CommandRunner = () =>
    Promise.resolve({
      code: 0,
      stdout: "[]",
      stderr: "",
    });

  // Test --help
  await main(["--help"], fakeRunner);

  // Test dry-run
  await main(["--dry-run", "--repo", "JaMmusic"], fakeRunner);
});
