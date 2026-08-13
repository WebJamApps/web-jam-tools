/**
 * Unit tests for scripts/create-issue.ts and src/create-issue/lib.ts (web-jam-tools#514)
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  createIssueAndVerify,
  ExecDeps,
  IssueData,
  normalizeRepo,
  parseArgs,
  verifyIssueAttributes,
} from "../src/create-issue/lib.ts";

Deno.test("parseArgs parses all supported CLI flags and formats", () => {
  const args = [
    "--repo",
    "WebJamApps/web-jam-tools",
    "--title",
    "Fix everything",
    "-F",
    "/tmp/body.md",
    "-t",
    "Bug",
    "-l",
    "Flash High, Blocked",
    "-m",
    "v1.2",
    "--priority",
    "High",
    "--parent",
    "437",
  ];

  const parsed = parseArgs(args);
  assertEquals(parsed.repo, "WebJamApps/web-jam-tools");
  assertEquals(parsed.title, "Fix everything");
  assertEquals(parsed.bodyFile, "/tmp/body.md");
  assertEquals(parsed.type, "Bug");
  assertEquals(parsed.labels, ["Flash High", "Blocked"]);
  assertEquals(parsed.milestone, "v1.2");
  assertEquals(parsed.priority, "High");
  assertEquals(parsed.parent, 437);
});

Deno.test("parseArgs handles equals format (--key=val)", () => {
  const args = [
    "--repo=JaMmusic",
    "--title=New feature",
    "--body-file=/tmp/desc.md",
    "--type=Feature",
    "--labels=Sonnet,Needs Design",
    "--milestone=v2.0",
    "--priority=Urgent",
    "--parent=100",
  ];

  const parsed = parseArgs(args);
  assertEquals(parsed.repo, "JaMmusic");
  assertEquals(parsed.title, "New feature");
  assertEquals(parsed.bodyFile, "/tmp/desc.md");
  assertEquals(parsed.type, "Feature");
  assertEquals(parsed.labels, ["Sonnet", "Needs Design"]);
  assertEquals(parsed.milestone, "v2.0");
  assertEquals(parsed.priority, "Urgent");
  assertEquals(parsed.parent, 100);
});

Deno.test("normalizeRepo normalizes repo inputs correctly", () => {
  assertEquals(normalizeRepo(), {
    owner: "WebJamApps",
    name: "web-jam-tools",
    full: "WebJamApps/web-jam-tools",
  });
  assertEquals(normalizeRepo("JaMmusic"), {
    owner: "WebJamApps",
    name: "JaMmusic",
    full: "WebJamApps/JaMmusic",
  });
  assertEquals(normalizeRepo("OtherOrg/MyRepo"), {
    owner: "OtherOrg",
    name: "MyRepo",
    full: "OtherOrg/MyRepo",
  });
});

Deno.test("verifyIssueAttributes passes when all requested attributes match", () => {
  const actual: IssueData = {
    number: 514,
    title: "Add create-issue script",
    labels: [{ name: "Flash High" }, { name: "Task" }],
    type: { name: "Task" },
    milestone: { title: "token-savings", number: 13 },
    issue_field_values: [
      {
        issue_field_id: 3909188,
        single_select_option: { id: 6835641, name: "High" },
      },
    ],
    parent: { number: 437 },
  };

  const requested = {
    title: "Add create-issue script",
    bodyFile: "/tmp/b.md",
    type: "Task",
    labels: ["Flash High"],
    milestone: "token-savings",
    priority: "High",
    parent: 437,
  };

  const res = verifyIssueAttributes(actual, requested);
  assertEquals(res.ok, true);
  assertEquals(res.errors.length, 0);
});

Deno.test("verifyIssueAttributes fails on title mismatch", () => {
  const actual: IssueData = {
    number: 10,
    title: "Old Title",
  };
  const requested = { title: "New Title", bodyFile: "/tmp/b.md" };

  const res = verifyIssueAttributes(actual, requested);
  assertEquals(res.ok, false);
  assertStringIncludes(res.errors[0], "Title mismatch");
});

Deno.test("verifyIssueAttributes fails when requested label is missing", () => {
  const actual: IssueData = {
    number: 10,
    title: "Test",
    labels: [{ name: "Flash High" }],
  };
  const requested = {
    title: "Test",
    bodyFile: "/tmp/b.md",
    labels: ["Flash High", "Needs Design"],
  };

  const res = verifyIssueAttributes(actual, requested);
  assertEquals(res.ok, false);
  assertStringIncludes(res.errors[0], 'Label "Needs Design" did not stick');
});

Deno.test("verifyIssueAttributes fails when Priority did not stick", () => {
  const actual: IssueData = {
    number: 10,
    title: "Test",
    issue_field_values: [
      {
        issue_field_id: 3909188,
        single_select_option: { id: 6835642, name: "Medium" },
      },
    ],
  };
  const requested = { title: "Test", bodyFile: "/tmp/b.md", priority: "High" };

  const res = verifyIssueAttributes(actual, requested);
  assertEquals(res.ok, false);
  assertStringIncludes(res.errors[0], 'Priority mismatch: expected "High", got "Medium"');
});

Deno.test("verifyIssueAttributes fails when Parent issue did not stick", () => {
  const actual: IssueData = {
    number: 10,
    title: "Test",
    parent: { number: 100 },
  };
  const requested = { title: "Test", bodyFile: "/tmp/b.md", parent: 437 };

  const res = verifyIssueAttributes(actual, requested);
  assertEquals(res.ok, false);
  assertStringIncludes(res.errors[0], "Parent issue mismatch: expected #437, got #100");
});

Deno.test("createIssueAndVerify succeeds and returns formatted issue string with mocked deps", async () => {
  const executedCmds: string[][] = [];

  const mockDeps: ExecDeps = {
    runCmd(cmd: string[], _stdin?: string) {
      executedCmds.push(cmd);
      const cmdStr = cmd.join(" ");

      if (cmdStr.includes("gh issue create")) {
        return Promise.resolve({
          code: 0,
          stdout: "https://github.com/WebJamApps/web-jam-tools/issues/515\n",
          stderr: "",
        });
      }
      if (cmdStr.includes("gh api -X PATCH")) {
        return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
      }
      if (cmdStr.includes("graphql") && cmdStr.includes("GetIssueNodeIds")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: {
              parent: { issue: { id: "PARENT_ID" } },
              child: { issue: { id: "CHILD_ID" } },
            },
          }),
          stderr: "",
        });
      }
      if (cmdStr.includes("graphql") && cmdStr.includes("AddSubIssue")) {
        return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
      }
      if (cmdStr.includes("gh api repos/WebJamApps/web-jam-tools/issues/515")) {
        const mockIssue: IssueData = {
          number: 515,
          title: "My New Issue",
          labels: [{ name: "Flash High" }],
          type: { name: "Task" },
          milestone: { title: "token-savings" },
          parent: { number: 437 },
          issue_field_values: [
            {
              issue_field_id: 3909188,
              single_select_option: { id: 6835641, name: "High" },
            },
          ],
        };
        return Promise.resolve({ code: 0, stdout: JSON.stringify(mockIssue), stderr: "" });
      }

      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    },
    readFileText() {
      return Promise.resolve("## What this builds\nTest body text");
    },
  };

  const options = {
    repo: "web-jam-tools",
    title: "My New Issue",
    bodyFile: "/tmp/body.md",
    labels: ["Flash High"],
    milestone: "token-savings",
    priority: "High",
    parent: 437,
  };

  const result = await createIssueAndVerify(options, mockDeps);
  assertEquals(result, 'web-jam-tools#515 "My New Issue"');
});

Deno.test("createIssueAndVerify throws error if Priority verification fails", async () => {
  const mockDeps: ExecDeps = {
    runCmd(cmd: string[]) {
      const cmdStr = cmd.join(" ");

      if (cmdStr.includes("gh issue create")) {
        return Promise.resolve({
          code: 0,
          stdout: "https://github.com/WebJamApps/web-jam-tools/issues/515\n",
          stderr: "",
        });
      }
      if (cmdStr.includes("gh api repos/WebJamApps/web-jam-tools/issues/515")) {
        // Issue created without Priority field sticking
        const mockIssue: IssueData = {
          number: 515,
          title: "My New Issue",
          labels: [{ name: "Flash High" }],
          issue_field_values: [],
        };
        return Promise.resolve({ code: 0, stdout: JSON.stringify(mockIssue), stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    },
    readFileText() {
      return Promise.resolve("Body");
    },
  };

  const options = {
    title: "My New Issue",
    bodyFile: "/tmp/b.md",
    priority: "High",
  };

  await assertRejects(
    async () => {
      await createIssueAndVerify(options, mockDeps);
    },
    Error,
    "Issue verification failed",
  );
});
