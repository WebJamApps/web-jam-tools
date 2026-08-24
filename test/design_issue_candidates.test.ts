// test/design_issue_candidates.test.ts — web-jam-tools#745
//
// Unit tests for Needs Design candidates scanner (scanNeedsDesignCandidates, formatCandidateCitation, runCandidatesCli).

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  formatCandidateCitation,
  type NeedsDesignIssue,
  runCandidatesCli,
  scanNeedsDesignCandidates,
} from "../src/design-issue/candidates.ts";
import { runCli } from "../src/design-issue/cli.ts";
import type { CommandResult, CommandRunner } from "../src/flash-issues/types.ts";

function createMockRunner(
  handlers: Record<string, { code?: number; stdout?: string; stderr?: string; error?: Error }>,
): CommandRunner {
  return (args: string[]): Promise<CommandResult> => {
    // args: ["issue", "list", "--repo", "WebJamApps/<repo>", "--state", "open", "--label", "Needs Design", "--json", "number,title,labels,url"]
    const repoArgIndex = args.indexOf("--repo");
    const repoTarget = repoArgIndex !== -1 ? args[repoArgIndex + 1] : "";
    const repoName = repoTarget.replace("WebJamApps/", "");

    const config = handlers[repoName];
    if (config?.error) {
      return Promise.reject(config.error);
    }

    if (config) {
      return Promise.resolve({
        code: config.code ?? 0,
        stdout: config.stdout ?? "[]",
        stderr: config.stderr ?? "",
      });
    }

    return Promise.resolve({
      code: 0,
      stdout: "[]",
      stderr: "",
    });
  };
}

Deno.test("formatCandidateCitation formats issue citation with repo, number, and title", () => {
  const issue: NeedsDesignIssue = {
    repo: "web-jam-tools",
    number: 745,
    title:
      "Add a deno task design:candidates to scan the active repos for open Needs Design issues",
  };
  const citation = formatCandidateCitation(issue);
  assertEquals(
    citation,
    'web-jam-tools#745 "Add a deno task design:candidates to scan the active repos for open Needs Design issues"',
  );
});

Deno.test("scanNeedsDesignCandidates returns issues for matching repos and handles empty repos", async () => {
  const runner = createMockRunner({
    "web-jam-tools": {
      stdout: JSON.stringify([
        {
          number: 724,
          title: "design-issue skill never reconciles a pre-existing issue's stale body",
          labels: [{ name: "Needs Design" }, { name: "Sonnet" }],
          url: "https://github.com/WebJamApps/web-jam-tools/issues/724",
        },
      ]),
    },
    "JaMmusic": {
      stdout: "[]",
    },
    "CollegeLutheran": {
      stdout: JSON.stringify([
        {
          number: 105,
          title: "Redesign bulletin archive browser",
          labels: [{ name: "Needs Design" }],
          url: "https://github.com/WebJamApps/CollegeLutheran/issues/105",
        },
      ]),
    },
  });

  const warnings: string[] = [];
  const result = await scanNeedsDesignCandidates({
    runner,
    repos: ["web-jam-tools", "JaMmusic", "CollegeLutheran"],
    errorLog: (msg) => warnings.push(msg),
  });

  assertEquals(result.errors.length, 0);
  assertEquals(result.issues.length, 2);
  assertEquals(result.issues[0].repo, "web-jam-tools");
  assertEquals(result.issues[0].number, 724);
  assertEquals(
    result.issues[0].title,
    "design-issue skill never reconciles a pre-existing issue's stale body",
  );
  assertEquals(result.issues[1].repo, "CollegeLutheran");
  assertEquals(result.issues[1].number, 105);
  assertEquals(result.issues[1].title, "Redesign bulletin archive browser");
});

Deno.test("scanNeedsDesignCandidates handles command errors and runner rejections gracefully", async () => {
  const runner = createMockRunner({
    "web-jam-tools": {
      code: 1,
      stderr: "GraphQL error: rate limit exceeded",
    },
    "JaMmusic": {
      error: new Error("Network timeout connecting to api.github.com"),
    },
    "AppersonAuto": {
      stdout: JSON.stringify([
        {
          number: 42,
          title: "Appointment booking flow design",
          labels: [{ name: "Needs Design" }],
          url: "https://github.com/WebJamApps/AppersonAuto/issues/42",
        },
      ]),
    },
  });

  const warnings: string[] = [];
  const result = await scanNeedsDesignCandidates({
    runner,
    repos: ["web-jam-tools", "JaMmusic", "AppersonAuto"],
    errorLog: (msg) => warnings.push(msg),
  });

  assertEquals(result.errors.length, 2);
  assertEquals(result.errors[0].repo, "web-jam-tools");
  assertStringIncludes(result.errors[0].error, "rate limit exceeded");
  assertEquals(result.errors[1].repo, "JaMmusic");
  assertStringIncludes(result.errors[1].error, "Network timeout");

  assertEquals(warnings.length, 2);
  assertStringIncludes(warnings[0], "Failed to query web-jam-tools");
  assertStringIncludes(warnings[1], "Error querying JaMmusic");

  assertEquals(result.issues.length, 1);
  assertEquals(result.issues[0].repo, "AppersonAuto");
  assertEquals(result.issues[0].number, 42);
});

Deno.test("runCandidatesCli prints formatted candidate list when matches exist", async () => {
  const runner = createMockRunner({
    "web-jam-tools": {
      stdout: JSON.stringify([
        {
          number: 724,
          title: "design-issue skill never reconciles a pre-existing issue's stale body",
          labels: [{ name: "Needs Design" }],
          url: "https://github.com/WebJamApps/web-jam-tools/issues/724",
        },
      ]),
    },
  });

  const logs: string[] = [];
  const exitCode = await runCandidatesCli([], {
    runner,
    repos: ["web-jam-tools", "JaMmusic"],
    log: (msg) => logs.push(msg),
  });

  assertEquals(exitCode, 0);
  assertEquals(logs.length, 2);
  assertStringIncludes(logs[0], "Found 1 open 'Needs Design' candidate issue");
  assertEquals(
    logs[1],
    'web-jam-tools#724 "design-issue skill never reconciles a pre-existing issue\'s stale body"',
  );
});

Deno.test("runCandidatesCli prints clear 0 candidates message when no issues found", async () => {
  const runner = createMockRunner({
    "web-jam-tools": { stdout: "[]" },
    "JaMmusic": { stdout: "[]" },
  });

  const logs: string[] = [];
  const exitCode = await runCandidatesCli([], {
    runner,
    repos: ["web-jam-tools", "JaMmusic"],
    log: (msg) => logs.push(msg),
  });

  assertEquals(exitCode, 0);
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0], "0 candidates found");
});

Deno.test("runCandidatesCli handles --help flag", async () => {
  const logs: string[] = [];
  const exitCode = await runCandidatesCli(["--help"], {
    log: (msg) => logs.push(msg),
  });

  assertEquals(exitCode, 0);
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0], "Usage: deno task design:candidates");
});

Deno.test("cli.ts routes 'candidates' subcommand to runCandidatesCli", async () => {
  const exitCode = await runCli(["candidates", "--help"]);
  assertEquals(exitCode, 0);
});

Deno.test("deno.json defines design:candidates task", async () => {
  const denoJsonContent = await Deno.readTextFile(
    new URL("../deno.json", import.meta.url).pathname,
  );
  const config = JSON.parse(denoJsonContent);

  assertEquals(typeof config.tasks["design:candidates"], "string");
  assertStringIncludes(config.tasks["design:candidates"], "src/design-issue/cli.ts candidates");
});
