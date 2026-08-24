// test/design_issue_stale_bodies.test.ts — web-jam-tools#746
//
// Unit tests for stale bodies scanner and staleness rules.

import { assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import {
  analyzeIssueStaleness,
  checkDesignReference,
  checkOpenQuestionsAndTbd,
  checkScopeContradictions,
  extractOutOfScopeItems,
  formatStaleBodiesReport,
  type IssueData,
  parseIssueList,
  parseIssueTarget,
  runStaleBodiesCli,
  scanStaleBodies,
} from "../src/design-issue/stale_bodies.ts";
import { runCli } from "../src/design-issue/cli.ts";
import type { CommandRunner } from "../src/flash-issues/types.ts";

const FIXTURES_DIR = new URL("./fixtures/design-issue", import.meta.url).pathname;
const FIXTURE_DESIGN_DOC = path.join(FIXTURES_DIR, "fixture-design.md");

Deno.test("parseIssueTarget parses various issue citation formats", () => {
  assertEquals(parseIssueTarget("101"), {
    repo: "WebJamApps/web-jam-tools",
    number: 101,
  });

  assertEquals(parseIssueTarget("#101"), {
    repo: "WebJamApps/web-jam-tools",
    number: 101,
  });

  assertEquals(parseIssueTarget("web-jam-tools#724"), {
    repo: "WebJamApps/web-jam-tools",
    number: 724,
  });

  assertEquals(parseIssueTarget("WebJamApps/JaMmusic#45"), {
    repo: "WebJamApps/JaMmusic",
    number: 45,
  });

  assertEquals(parseIssueTarget("CollegeLutheran#12"), {
    repo: "WebJamApps/CollegeLutheran",
    number: 12,
  });

  assertEquals(parseIssueTarget("invalid"), null);
  assertEquals(parseIssueTarget(""), null);
  assertEquals(parseIssueTarget("#-5"), null);
});

Deno.test("parseIssueList parses comma and space delimited citations and deduplicates", () => {
  const parsed = parseIssueList([
    "101, 102",
    "web-jam-tools#101",
    "JaMmusic#50",
  ]);

  assertEquals(parsed.length, 3);
  assertEquals(parsed[0], { repo: "WebJamApps/web-jam-tools", number: 101 });
  assertEquals(parsed[1], { repo: "WebJamApps/web-jam-tools", number: 102 });
  assertEquals(parsed[2], { repo: "WebJamApps/JaMmusic", number: 50 });
});

Deno.test("extractOutOfScopeItems extracts topics from ## What stays out of scope section", async () => {
  const content = await Deno.readTextFile(FIXTURE_DESIGN_DOC);
  const items = extractOutOfScopeItems(content);

  assertEquals(items.length, 3);
  assertEquals(items[0].topic, "Automated database schema migration");
  assertEquals(
    items[1].topic,
    "Third-party payment gateway webhook integration",
  );
  assertEquals(
    items[2].topic,
    "Native mobile push notification dispatch (FCM/APNS)",
  );
});

Deno.test("checkDesignReference passes when valid design doc is cited and exists", async () => {
  const body = `## What this builds
1. Build something.

## Design reference
- Document: \`${FIXTURE_DESIGN_DOC}\`
- Section: \`## Architecture\`
`;

  const reasons = await checkDesignReference(body, FIXTURE_DESIGN_DOC);
  assertEquals(reasons.length, 0);
});

Deno.test("checkDesignReference flags missing ## Design reference section", async () => {
  const body = `## What this builds
1. Build something.
`;

  const reasons = await checkDesignReference(body, FIXTURE_DESIGN_DOC);
  assertEquals(reasons.length, 1);
  assertEquals(reasons[0].type, "design-reference");
  assertStringIncludes(reasons[0].message, "Missing required '## Design reference'");
});

Deno.test("checkDesignReference flags citation of a different document", async () => {
  const body = `## What this builds
1. Build something.

## Design reference
- Document: \`/path/to/different-design-doc.md\`
`;

  const reasons = await checkDesignReference(body, FIXTURE_DESIGN_DOC);
  assertEquals(reasons.length, 1);
  assertEquals(reasons[0].type, "design-reference");
  assertStringIncludes(reasons[0].message, "points to a different document");
});

Deno.test("checkDesignReference flags non-existent design document on disk", async () => {
  const nonExistentDoc = "/tmp/non-existent-design-2026-99-99.md";
  const body = `## What this builds
1. Build something.

## Design reference
- Document: \`${nonExistentDoc}\`
`;

  const reasons = await checkDesignReference(
    body,
    nonExistentDoc,
    () => Promise.resolve(false), // mock fileExists returning false
  );
  assertEquals(reasons.length, 1);
  assertEquals(reasons[0].type, "design-reference");
  assertStringIncludes(reasons[0].message, "does not exist on disk");
});

Deno.test("checkOpenQuestionsAndTbd flags questions, TBD markers, and forks", () => {
  const body = `## What this builds
1. Build client.

## Open Questions
- What should the reconnect backoff interval be?
- Should we use Redis or in-memory pubsub?

## Acceptance criteria
- [TBD] Finalize caching strategy.
- Option 1: memory vs Option 2: disk
`;

  const reasons = checkOpenQuestionsAndTbd(body);
  assertEquals(reasons.length >= 3, true);
  const types = reasons.map((r) => r.type);
  assertEquals(types.every((t) => t === "open-questions"), true);

  const messages = reasons.map((r) => r.message).join(" ");
  assertStringIncludes(messages, "unresolved question section");
  assertStringIncludes(messages, "open question");
  assertStringIncludes(messages, "unresolved marker");
  assertStringIncludes(messages, "unresolved design fork");
});

Deno.test("checkScopeContradictions flags issue requiring non-goals", () => {
  const outOfScope = [
    {
      topic: "Automated database schema migration",
      fullText: "Automated database schema migration. Migrations remain manual.",
    },
  ];

  const body = `## What this builds
1. Automated database schema migration for notification event store.
2. WebSocket gateway listener.
`;

  const reasons = checkScopeContradictions(
    body,
    outOfScope,
    "fixture-design.md",
  );
  assertEquals(reasons.length, 1);
  assertEquals(reasons[0].type, "scope-contradiction");
  assertStringIncludes(
    reasons[0].message,
    "contradicts design document non-goals",
  );
  assertStringIncludes(reasons[0].message, "Automated database schema migration");
});

Deno.test("analyzeIssueStaleness reports IN SYNC for clean issue fixture", async () => {
  const docContent = await Deno.readTextFile(FIXTURE_DESIGN_DOC);
  const issueBody = await Deno.readTextFile(
    path.join(FIXTURES_DIR, "issue-in-sync.md"),
  );

  const issue: IssueData = {
    number: 724,
    title: "Implement WebSocket client dispatcher",
    body: issueBody,
  };

  const report = await analyzeIssueStaleness(
    issue,
    "WebJamApps/web-jam-tools",
    FIXTURE_DESIGN_DOC,
    docContent,
    { fileExists: () => true },
  );

  assertEquals(report.status, "IN SYNC");
  assertEquals(report.reasons.length, 0);
});

Deno.test("analyzeIssueStaleness reports STALE for issue with questions and TBD", async () => {
  const docContent = await Deno.readTextFile(FIXTURE_DESIGN_DOC);
  const issueBody = await Deno.readTextFile(
    path.join(FIXTURES_DIR, "issue-stale-questions.md"),
  );

  const issue: IssueData = {
    number: 724,
    title: "Unreconciled questions issue",
    body: issueBody,
  };

  const report = await analyzeIssueStaleness(
    issue,
    "WebJamApps/web-jam-tools",
    FIXTURE_DESIGN_DOC,
    docContent,
    { fileExists: () => true },
  );

  assertEquals(report.status, "STALE");
  assertEquals(
    report.reasons.some((r) => r.type === "open-questions"),
    true,
  );
});

Deno.test("scanStaleBodies scans multiple issues and aggregates summary", async () => {
  const docContent = await Deno.readTextFile(FIXTURE_DESIGN_DOC);
  const inSyncBody = await Deno.readTextFile(
    path.join(FIXTURES_DIR, "issue-in-sync.md"),
  );
  const staleQuestionsBody = await Deno.readTextFile(
    path.join(FIXTURES_DIR, "issue-stale-questions.md"),
  );

  const mockIssues: Record<number, IssueData> = {
    101: {
      number: 101,
      title: "In Sync Issue",
      body: inSyncBody,
    },
    102: {
      number: 102,
      title: "Stale Issue",
      body: staleQuestionsBody,
    },
  };

  const result = await scanStaleBodies({
    docPath: FIXTURE_DESIGN_DOC,
    issues: ["101", "102"],
    readFile: () => Promise.resolve(docContent),
    fileExists: () => Promise.resolve(true),
    fetchIssue: (_repo, num) => {
      const issue = mockIssues[num];
      if (!issue) throw new Error(`Issue ${num} not found`);
      return Promise.resolve(issue);
    },
  });

  assertEquals(result.summary.total, 2);
  assertEquals(result.summary.inSync, 1);
  assertEquals(result.summary.stale, 1);
  assertEquals(result.issues[0].status, "IN SYNC");
  assertEquals(result.issues[1].status, "STALE");

  const formatted = formatStaleBodiesReport(result);
  assertStringIncludes(formatted, "Summary: 1 issue(s) in sync, 1 issue(s) stale.");
});

Deno.test("scanStaleBodies handles fetchIssue failure gracefully", async () => {
  const docContent = await Deno.readTextFile(FIXTURE_DESIGN_DOC);

  const result = await scanStaleBodies({
    docPath: FIXTURE_DESIGN_DOC,
    issues: ["999"],
    readFile: () => Promise.resolve(docContent),
    fetchIssue: () => Promise.reject(new Error("GraphQL rate limit exceeded")),
  });

  assertEquals(result.summary.total, 1);
  assertEquals(result.summary.stale, 1);
  assertEquals(result.issues[0].status, "STALE");
  assertEquals(result.issues[0].reasons[0].type, "fetch-error");
  assertStringIncludes(
    result.issues[0].reasons[0].message,
    "GraphQL rate limit exceeded",
  );
});

Deno.test("runStaleBodiesCli handles --help flag", async () => {
  const logs: string[] = [];
  const exitCode = await runStaleBodiesCli(["--help"], {
    log: (msg) => logs.push(msg),
  });

  assertEquals(exitCode, 0);
  assertStringIncludes(logs[0], "Usage: deno task design:stale-bodies");
});

Deno.test("runStaleBodiesCli handles --json output flag", async () => {
  const docContent = await Deno.readTextFile(FIXTURE_DESIGN_DOC);
  const inSyncBody = await Deno.readTextFile(
    path.join(FIXTURES_DIR, "issue-in-sync.md"),
  );

  const logs: string[] = [];
  const exitCode = await runStaleBodiesCli(
    [FIXTURE_DESIGN_DOC, "--issues", "101", "--json"],
    {
      readFile: () => Promise.resolve(docContent),
      fileExists: () => Promise.resolve(true),
      fetchIssue: () =>
        Promise.resolve({
          number: 101,
          title: "In sync",
          body: inSyncBody,
        }),
      log: (msg) => logs.push(msg),
    },
  );

  assertEquals(exitCode, 0);
  const parsed = JSON.parse(logs[0]);
  assertEquals(parsed.summary.total, 1);
  assertEquals(parsed.summary.inSync, 1);
  assertEquals(parsed.issues[0].status, "IN SYNC");
});

Deno.test("runStaleBodiesCli returns 1 on missing doc path", async () => {
  const errors: string[] = [];
  const exitCode = await runStaleBodiesCli([], {
    errorLog: (msg) => errors.push(msg),
  });

  assertEquals(exitCode, 1);
  assertStringIncludes(errors[0], "Missing required design document path");
});

Deno.test("runStaleBodiesCli returns 1 on missing issues list", async () => {
  const errors: string[] = [];
  const exitCode = await runStaleBodiesCli([FIXTURE_DESIGN_DOC], {
    errorLog: (msg) => errors.push(msg),
  });

  assertEquals(exitCode, 1);
  assertStringIncludes(errors[0], "No issues specified to scan");
});

Deno.test("runStaleBodiesCli returns 1 on unreadable design doc", async () => {
  const errors: string[] = [];
  const exitCode = await runStaleBodiesCli(
    ["/tmp/missing-doc-12345.md", "--issues", "101"],
    {
      readFile: () => Promise.reject(new Error("File not found")),
      errorLog: (msg) => errors.push(msg),
    },
  );

  assertEquals(exitCode, 1);
  assertStringIncludes(errors[0], "Design document not found or cannot be read");
});

Deno.test("cli.ts routes 'stale-bodies' and 'stale_bodies' subcommands", async () => {
  const exitCode1 = await runCli(["stale-bodies", "--help"]);
  assertEquals(exitCode1, 0);

  const exitCode2 = await runCli(["stale_bodies", "--help"]);
  assertEquals(exitCode2, 0);
});

Deno.test("deno.json defines design:stale-bodies task", async () => {
  const denoJsonContent = await Deno.readTextFile(
    new URL("../deno.json", import.meta.url).pathname,
  );
  const config = JSON.parse(denoJsonContent);

  assertEquals(typeof config.tasks["design:stale-bodies"], "string");
  assertStringIncludes(
    config.tasks["design:stale-bodies"],
    "src/design-issue/cli.ts stale-bodies",
  );
});

Deno.test("defaultFetchIssue fetches and parses issue details via CommandRunner", async () => {
  const mockRunner: CommandRunner = (args: string[]) => {
    assertEquals(args[0], "issue");
    assertEquals(args[1], "view");
    assertEquals(args[2], "724");
    assertEquals(args[4], "WebJamApps/web-jam-tools");

    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({
        number: 724,
        title: "Fetched issue title",
        body: "Fetched issue body",
        state: "OPEN",
        url: "https://github.com/WebJamApps/web-jam-tools/issues/724",
      }),
      stderr: "",
    });
  };

  const { defaultFetchIssue } = await import("../src/design-issue/stale_bodies.ts");
  const issue = await defaultFetchIssue("WebJamApps/web-jam-tools", 724, mockRunner);
  assertEquals(issue.number, 724);
  assertEquals(issue.title, "Fetched issue title");
  assertEquals(issue.body, "Fetched issue body");
});

Deno.test("defaultFetchIssue throws on non-zero exit code from runner", async () => {
  const mockRunner: CommandRunner = () => {
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "issue not found",
    });
  };

  const { defaultFetchIssue } = await import("../src/design-issue/stale_bodies.ts");
  let errorCaught = false;
  try {
    await defaultFetchIssue("WebJamApps/web-jam-tools", 9999, mockRunner);
  } catch (err) {
    errorCaught = true;
    assertStringIncludes((err as Error).message, "Failed to fetch issue");
    assertStringIncludes((err as Error).message, "issue not found");
  }
  assertEquals(errorCaught, true);
});

Deno.test("extractOutOfScopeItems handles ## Non-goals and ## Out of scope headings", () => {
  const doc = `
# Sample doc

## Non-goals
- First non goal.
- Second non goal, owned by web-jam-tools#10.

## Both surfaces
- Claude Code and agy
`;

  const items = extractOutOfScopeItems(doc);
  assertEquals(items.length, 2);
  assertEquals(items[0].topic, "First non goal");
  assertEquals(items[1].topic, "Second non goal");
});

Deno.test("runStaleBodiesCli works with positional arguments and custom repo", async () => {
  const docContent = await Deno.readTextFile(FIXTURE_DESIGN_DOC);
  const inSyncBody = await Deno.readTextFile(
    path.join(FIXTURES_DIR, "issue-in-sync.md"),
  );

  const logs: string[] = [];
  const exitCode = await runStaleBodiesCli(
    [FIXTURE_DESIGN_DOC, "JaMmusic#50"],
    {
      readFile: () => Promise.resolve(docContent),
      fileExists: () => Promise.resolve(true),
      fetchIssue: (repo, num) => {
        assertEquals(repo, "WebJamApps/JaMmusic");
        assertEquals(num, 50);
        return Promise.resolve({
          number: 50,
          title: "JaMmusic task",
          body: inSyncBody,
        });
      },
      log: (msg) => logs.push(msg),
    },
  );

  assertEquals(exitCode, 0);
  assertStringIncludes(logs[0], "Scanned 1 issue(s)");
  assertStringIncludes(logs[0], 'Issue WebJamApps/JaMmusic#50 "JaMmusic task": IN SYNC');
});
