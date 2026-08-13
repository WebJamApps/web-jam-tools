/**
 * Unit tests for scripts/create-issue.ts and src/create-issue/lib.ts (web-jam-tools#514)
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  createIssueAndVerify,
  defaultExecDeps,
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

Deno.test("verifyIssueAttributes handles parent_issue_url, milestone number, and field name priority", () => {
  const actual: IssueData = {
    number: 514,
    title: "Add create-issue script",
    milestone: { title: "v1.0", number: 13 },
    issue_field_values: [
      {
        issue_field_name: "Priority",
        single_select_option: { name: "Low" },
      },
    ],
    parent_issue_url: "https://api.github.com/repos/WebJamApps/web-jam-tools/issues/437",
  };

  const requested = {
    title: "Add create-issue script",
    bodyFile: "/tmp/b.md",
    milestone: "13",
    priority: "Low",
    parent: 437,
  };

  const res = verifyIssueAttributes(actual, requested);
  assertEquals(res.ok, true);
});

Deno.test("verifyIssueAttributes fails on type, milestone, priority, and parent missing/mismatch", () => {
  const actual: IssueData = {
    number: 10,
    title: "Test",
  };

  const res1 = verifyIssueAttributes(actual, { title: "Test", bodyFile: "/b", type: "Task" });
  assertEquals(res1.ok, false);
  assertStringIncludes(res1.errors[0], 'Type mismatch: expected "Task", got "none"');

  const res2 = verifyIssueAttributes(actual, { title: "Test", bodyFile: "/b", milestone: "v1.0" });
  assertEquals(res2.ok, false);
  assertStringIncludes(res2.errors[0], 'Milestone mismatch: expected "v1.0", got "none"');
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
      if (cmdStr.includes("graphql") && cmdStr.includes("GetChildNodeId")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: { repository: { issue: { id: "CHILD_NODE_ID" } } },
          }),
          stderr: "",
        });
      }
      if (cmdStr.includes("graphql") && cmdStr.includes("SetPriority")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ data: { updateIssueFieldValue: {} } }),
          stderr: "",
        });
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

Deno.test("createIssueAndVerify fallback GraphQL parent check when parent missing in REST", async () => {
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
      if (cmdStr.includes("graphql") && cmdStr.includes("GetIssueNodeIds")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: {
              parent: { issue: { id: "P_ID" } },
              child: { issue: { id: "C_ID" } },
            },
          }),
          stderr: "",
        });
      }
      if (cmdStr.includes("graphql") && cmdStr.includes("AddSubIssue")) {
        return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
      }
      if (cmdStr.includes("gh api repos/WebJamApps/web-jam-tools/issues/515")) {
        // Issue REST response without parent field
        const mockIssue: IssueData = {
          number: 515,
          title: "My New Issue",
        };
        return Promise.resolve({ code: 0, stdout: JSON.stringify(mockIssue), stderr: "" });
      }
      if (cmdStr.includes("graphql") && cmdStr.includes("CheckParent")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: {
                  parent: { number: 437 },
                },
              },
            },
          }),
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    },
    readFileText() {
      return Promise.resolve("Body");
    },
  };

  const result = await createIssueAndVerify({
    title: "My New Issue",
    bodyFile: "/tmp/b.md",
    parent: 437,
  }, mockDeps);

  assertEquals(result, 'web-jam-tools#515 "My New Issue"');
});

Deno.test("createIssueAndVerify error handling branches", async () => {
  await assertRejects(
    () => createIssueAndVerify({ title: "", bodyFile: "/tmp/b.md" }),
    Error,
    "Missing required argument --title",
  );

  await assertRejects(
    () => createIssueAndVerify({ title: "Test", bodyFile: "" }),
    Error,
    "Missing required argument --body-file",
  );

  // Invalid priority level
  await assertRejects(
    () =>
      createIssueAndVerify(
        { title: "T", bodyFile: "/b", priority: "SuperHigh" },
        {
          runCmd: () =>
            Promise.resolve({
              code: 0,
              stdout: "https://github.com/org/repo/issues/1\n",
              stderr: "",
            }),
          readFileText: () => Promise.resolve("b"),
        },
      ),
    Error,
    'Invalid priority level "SuperHigh"',
  );

  // gh issue create failure
  const failCreateDeps: ExecDeps = {
    runCmd: () => Promise.resolve({ code: 1, stdout: "", stderr: "gh create error" }),
    readFileText: () => Promise.resolve("body"),
  };
  await assertRejects(
    () => createIssueAndVerify({ title: "T", bodyFile: "/b" }, failCreateDeps),
    Error,
    "Failed to create issue",
  );

  // Unparseable issue URL
  const badUrlDeps: ExecDeps = {
    runCmd: () => Promise.resolve({ code: 0, stdout: "bad output format", stderr: "" }),
    readFileText: () => Promise.resolve("body"),
  };
  await assertRejects(
    () => createIssueAndVerify({ title: "T", bodyFile: "/b" }, badUrlDeps),
    Error,
    "Could not parse issue number",
  );

  // Priority child node ID query failure
  const failChildNodeQueryDeps: ExecDeps = {
    runCmd: (cmd) => {
      const str = cmd.join(" ");
      if (str.includes("GetChildNodeId")) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "node query error" });
      }
      return Promise.resolve({
        code: 0,
        stdout: "https://github.com/org/repo/issues/1\n",
        stderr: "",
      });
    },
    readFileText: () => Promise.resolve("body"),
  };
  await assertRejects(
    () =>
      createIssueAndVerify(
        { title: "T", bodyFile: "/b", priority: "High" },
        failChildNodeQueryDeps,
      ),
    Error,
    "Failed to resolve child issue node ID for Priority",
  );

  // Priority GraphQL mutation failure
  const failPrioMutDeps: ExecDeps = {
    runCmd: (cmd) => {
      const str = cmd.join(" ");
      if (str.includes("GetChildNodeId")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ data: { repository: { issue: { id: "CID" } } } }),
          stderr: "",
        });
      }
      if (str.includes("SetPriority")) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "prio mut error" });
      }
      return Promise.resolve({
        code: 0,
        stdout: "https://github.com/org/repo/issues/1\n",
        stderr: "",
      });
    },
    readFileText: () => Promise.resolve("body"),
  };
  await assertRejects(
    () => createIssueAndVerify({ title: "T", bodyFile: "/b", priority: "High" }, failPrioMutDeps),
    Error,
    "Failed to set Priority field via GraphQL",
  );

  // Parent node ID query failure
  const failNodeIdQueryDeps: ExecDeps = {
    runCmd: (cmd) => {
      const str = cmd.join(" ");
      if (str.includes("GetIssueNodeIds")) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "node query error" });
      }
      return Promise.resolve({
        code: 0,
        stdout: "https://github.com/org/repo/issues/1\n",
        stderr: "",
      });
    },
    readFileText: () => Promise.resolve("body"),
  };
  await assertRejects(
    () => createIssueAndVerify({ title: "T", bodyFile: "/b", parent: 100 }, failNodeIdQueryDeps),
    Error,
    "Failed to resolve node IDs",
  );

  // Parent node IDs missing in data
  const missingNodeIdDeps: ExecDeps = {
    runCmd: (cmd) => {
      const str = cmd.join(" ");
      if (str.includes("GetIssueNodeIds")) {
        return Promise.resolve({ code: 0, stdout: JSON.stringify({ data: {} }), stderr: "" });
      }
      return Promise.resolve({
        code: 0,
        stdout: "https://github.com/org/repo/issues/1\n",
        stderr: "",
      });
    },
    readFileText: () => Promise.resolve("body"),
  };
  await assertRejects(
    () => createIssueAndVerify({ title: "T", bodyFile: "/b", parent: 100 }, missingNodeIdDeps),
    Error,
    "Could not resolve GraphQL node IDs",
  );

  // AddSubIssue mutation failure
  const failSubIssueMutDeps: ExecDeps = {
    runCmd: (cmd) => {
      const str = cmd.join(" ");
      if (str.includes("GetIssueNodeIds")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: { parent: { issue: { id: "P" } }, child: { issue: { id: "C" } } },
          }),
          stderr: "",
        });
      }
      if (str.includes("AddSubIssue")) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "add sub issue error" });
      }
      return Promise.resolve({
        code: 0,
        stdout: "https://github.com/org/repo/issues/1\n",
        stderr: "",
      });
    },
    readFileText: () => Promise.resolve("body"),
  };
  await assertRejects(
    () => createIssueAndVerify({ title: "T", bodyFile: "/b", parent: 100 }, failSubIssueMutDeps),
    Error,
    "Failed to attach parent sub-issue",
  );

  // Re-read API failure
  const failReadDeps: ExecDeps = {
    runCmd: (cmd) => {
      const str = cmd.join(" ");
      if (str.includes("gh api repos/")) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "read api error" });
      }
      return Promise.resolve({
        code: 0,
        stdout: "https://github.com/org/repo/issues/1\n",
        stderr: "",
      });
    },
    readFileText: () => Promise.resolve("body"),
  };
  await assertRejects(
    () => createIssueAndVerify({ title: "T", bodyFile: "/b" }, failReadDeps),
    Error,
    "Failed to re-read created issue",
  );
});

Deno.test("defaultExecDeps executes real Deno reading and command execution", async () => {
  const tmpFile = await Deno.makeTempFile();
  await Deno.writeTextFile(tmpFile, "hello test");

  try {
    const text = await defaultExecDeps.readFileText(tmpFile);
    assertEquals(text, "hello test");

    const echoRes = await defaultExecDeps.runCmd(["echo", "hi"]);
    assertEquals(echoRes.code, 0);
    assertStringIncludes(echoRes.stdout, "hi");

    const catRes = await defaultExecDeps.runCmd(["cat"], "stdin content");
    assertEquals(catRes.code, 0);
    assertEquals(catRes.stdout, "stdin content");
  } finally {
    await Deno.remove(tmpFile);
  }
});
