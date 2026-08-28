/**
 * Unit tests for scripts/create-issue.ts and src/create-issue/lib.ts (web-jam-tools#514)
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  ApprovalCheckResult,
  checkApprovalToken,
  createIssueAndVerify,
  defaultExecDeps,
  ExecDeps,
  IssueData,
  normalizeRepo,
  parseArgs,
  verifyIssueAttributes,
} from "../src/create-issue/lib.ts";

// Most tests below exercise createIssueAndVerify's GraphQL/verification flow
// and are unrelated to the Gate 2 approval-token check (web-jam-tools#747) —
// they pass this always-approve stub as the third argument so they don't
// need a real token file on disk. The token check itself is exercised
// directly against checkApprovalToken() and, for the default (real-disk)
// path, against createIssueAndVerify() with the argument OMITTED, further
// down this file.
const APPROVE_ALL: (repoFull: string, title: string) => ApprovalCheckResult = () => ({ ok: true });

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
    "--escalation-reason",
    "complex multi-file refactoring",
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
  assertEquals(parsed.escalationReason, "complex multi-file refactoring");
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
    "--escalation-reason=arch design",
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
  assertEquals(parsed.escalationReason, "arch design");
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
      if (cmdStr.includes("graphql") && cmdStr.includes("GetChildAndTypes")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: { id: "CHILD_NODE_ID" },
                issueTypes: {
                  nodes: [
                    { id: "TYPE_TASK_ID", name: "Task" },
                    { id: "TYPE_BUG_ID", name: "Bug" },
                    { id: "TYPE_FEAT_ID", name: "Feature" },
                    { id: "TYPE_EPIC_ID", name: "Epic" },
                  ],
                },
              },
            },
          }),
          stderr: "",
        });
      }
      if (cmdStr.includes("graphql") && cmdStr.includes("SetIssueType")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ data: { updateIssue: { clientMutationId: null } } }),
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
    type: "Task",
    labels: ["Flash High"],
    milestone: "token-savings",
    priority: "High",
    parent: 437,
  };

  const result = await createIssueAndVerify(options, mockDeps, APPROVE_ALL);
  assertEquals(result, 'web-jam-tools#515 "My New Issue"');
});

Deno.test("createIssueAndVerify setting type to Epic succeeds with mocked GraphQL", async () => {
  const mockDeps: ExecDeps = {
    runCmd(cmd: string[]) {
      const cmdStr = cmd.join(" ");

      if (cmdStr.includes("gh issue create")) {
        return Promise.resolve({
          code: 0,
          stdout: "https://github.com/WebJamApps/web-jam-tools/issues/516\n",
          stderr: "",
        });
      }
      if (cmdStr.includes("graphql") && cmdStr.includes("GetChildAndTypes")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: { id: "CHILD_NODE_ID_516" },
                issueTypes: {
                  nodes: [
                    { id: "TYPE_TASK_ID", name: "Task" },
                    { id: "TYPE_EPIC_ID", name: "Epic" },
                  ],
                },
              },
            },
          }),
          stderr: "",
        });
      }
      if (cmdStr.includes("graphql") && cmdStr.includes("SetIssueType")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ data: { updateIssue: { clientMutationId: null } } }),
          stderr: "",
        });
      }
      if (cmdStr.includes("gh api repos/WebJamApps/web-jam-tools/issues/516")) {
        const mockIssue: IssueData = {
          number: 516,
          title: "My Epic Issue",
          type: { name: "Epic" },
        };
        return Promise.resolve({ code: 0, stdout: JSON.stringify(mockIssue), stderr: "" });
      }

      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    },
    readFileText() {
      return Promise.resolve("## What this builds\nEpic body text");
    },
  };

  const result = await createIssueAndVerify(
    {
      title: "My Epic Issue",
      bodyFile: "/tmp/body.md",
      type: "Epic",
    },
    mockDeps,
    APPROVE_ALL,
  );
  assertEquals(result, 'web-jam-tools#516 "My Epic Issue"');
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

  const result = await createIssueAndVerify(
    {
      title: "My New Issue",
      bodyFile: "/tmp/b.md",
      parent: 437,
    },
    mockDeps,
    APPROVE_ALL,
  );

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

  // Invalid issue type
  const failInvalidTypeDeps: ExecDeps = {
    runCmd: (cmd) => {
      const str = cmd.join(" ");
      if (str.includes("graphql") && str.includes("GetChildAndTypes")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: { id: "CID" },
                issueTypes: { nodes: [{ id: "T1", name: "Task" }] },
              },
            },
          }),
          stderr: "",
        });
      }
      return Promise.resolve({
        code: 0,
        stdout: "https://github.com/org/repo/issues/1\n",
        stderr: "",
      });
    },
    readFileText: () => Promise.resolve("b"),
  };
  await assertRejects(
    () =>
      createIssueAndVerify(
        { title: "T", bodyFile: "/b", type: "UnknownType" },
        failInvalidTypeDeps,
        APPROVE_ALL,
      ),
    Error,
    'Invalid issue type "UnknownType"',
  );

  // Type query failure
  const failTypeQueryDeps: ExecDeps = {
    runCmd: (cmd) => {
      const str = cmd.join(" ");
      if (str.includes("graphql") && str.includes("GetChildAndTypes")) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "type query error" });
      }
      return Promise.resolve({
        code: 0,
        stdout: "https://github.com/org/repo/issues/1\n",
        stderr: "",
      });
    },
    readFileText: () => Promise.resolve("b"),
  };
  await assertRejects(
    () =>
      createIssueAndVerify(
        { title: "T", bodyFile: "/b", type: "Task" },
        failTypeQueryDeps,
        APPROVE_ALL,
      ),
    Error,
    "Failed to resolve issue type info",
  );

  // Type mutation failure
  const failTypeMutDeps: ExecDeps = {
    runCmd: (cmd) => {
      const str = cmd.join(" ");
      if (str.includes("graphql") && str.includes("GetChildAndTypes")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: { id: "CID" },
                issueTypes: { nodes: [{ id: "T1", name: "Task" }] },
              },
            },
          }),
          stderr: "",
        });
      }
      if (str.includes("graphql") && str.includes("SetIssueType")) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "set type error" });
      }
      return Promise.resolve({
        code: 0,
        stdout: "https://github.com/org/repo/issues/1\n",
        stderr: "",
      });
    },
    readFileText: () => Promise.resolve("b"),
  };
  await assertRejects(
    () =>
      createIssueAndVerify(
        { title: "T", bodyFile: "/b", type: "Task" },
        failTypeMutDeps,
        APPROVE_ALL,
      ),
    Error,
    "Failed to set issue Type via GraphQL",
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
        APPROVE_ALL,
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
    () => createIssueAndVerify({ title: "T", bodyFile: "/b" }, failCreateDeps, APPROVE_ALL),
    Error,
    "Failed to create issue",
  );

  // Unparseable issue URL
  const badUrlDeps: ExecDeps = {
    runCmd: () => Promise.resolve({ code: 0, stdout: "bad output format", stderr: "" }),
    readFileText: () => Promise.resolve("body"),
  };
  await assertRejects(
    () => createIssueAndVerify({ title: "T", bodyFile: "/b" }, badUrlDeps, APPROVE_ALL),
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
        APPROVE_ALL,
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
    () =>
      createIssueAndVerify(
        { title: "T", bodyFile: "/b", priority: "High" },
        failPrioMutDeps,
        APPROVE_ALL,
      ),
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
    () =>
      createIssueAndVerify(
        { title: "T", bodyFile: "/b", parent: 100 },
        failNodeIdQueryDeps,
        APPROVE_ALL,
      ),
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
    () =>
      createIssueAndVerify(
        { title: "T", bodyFile: "/b", parent: 100 },
        missingNodeIdDeps,
        APPROVE_ALL,
      ),
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
    () =>
      createIssueAndVerify(
        { title: "T", bodyFile: "/b", parent: 100 },
        failSubIssueMutDeps,
        APPROVE_ALL,
      ),
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
    () => createIssueAndVerify({ title: "T", bodyFile: "/b" }, failReadDeps, APPROVE_ALL),
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

// --- Gate 2 approval-token check (web-jam-tools#747) ---
//
// checkApprovalToken() is the ONLY enforcement point on agy/Antigravity
// (acceptance criteria 1 & 2): it is exercised directly here with an
// explicit tokenPath, and separately through createIssueAndVerify() with
// its approvalCheck argument OMITTED — i.e. exactly how scripts/create-issue.ts
// calls it in production — using ISSUE_APPROVAL_TOKEN_PATH to point at a
// temp file (same pattern as test/require_approval_token_on_issue_write_hook.test.ts's
// withTokenFile helper), so this doesn't touch the real
// ~/.claude/state/issue-approval-token.json.

function futureIso(hoursFromNow = 4): string {
  return new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
}

function pastIso(hoursAgo = 1): string {
  return new Date(Date.now() - hoursAgo * 3600_000).toISOString();
}

async function withTokenFile(
  token: Record<string, unknown> | null,
  fn: (path: string) => Promise<void> | void,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/issue-approval-token.json`;
  try {
    if (token !== null) {
      await Deno.writeTextFile(path, JSON.stringify(token));
    }
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("checkApprovalToken: title covered by a live token for this repo is ok", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor", "Rename the widget"],
      expires_at: futureIso(),
    },
    (tokenPath) => {
      const res = checkApprovalToken(
        "WebJamApps/web-jam-tools",
        "Fix the flux capacitor",
        tokenPath,
      );
      assertEquals(res.ok, true);
      assertEquals(res.reason, undefined);
    },
  );
});

Deno.test("checkApprovalToken: title NOT covered by the token is refused", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    (tokenPath) => {
      const res = checkApprovalToken(
        "WebJamApps/web-jam-tools",
        "An issue nobody approved",
        tokenPath,
      );
      assertEquals(res.ok, false);
      assertStringIncludes(res.reason ?? "", "not among the titles approved");
    },
  );
});

Deno.test("checkApprovalToken: no token file at all is refused with a clear error", async () => {
  await withTokenFile(null, (tokenPath) => {
    const res = checkApprovalToken("WebJamApps/web-jam-tools", "Any title", tokenPath);
    assertEquals(res.ok, false);
    assertStringIncludes(res.reason ?? "", "No approval token found");
  });
});

Deno.test("checkApprovalToken: expired token is refused", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: pastIso(),
    },
    (tokenPath) => {
      const res = checkApprovalToken(
        "WebJamApps/web-jam-tools",
        "Fix the flux capacitor",
        tokenPath,
      );
      assertEquals(res.ok, false);
      assertStringIncludes(res.reason ?? "", "expired");
    },
  );
});

Deno.test("checkApprovalToken: token scoped to a different repo is refused", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/JaMmusic",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    (tokenPath) => {
      const res = checkApprovalToken(
        "WebJamApps/web-jam-tools",
        "Fix the flux capacitor",
        tokenPath,
      );
      assertEquals(res.ok, false);
      assertStringIncludes(res.reason ?? "", "scoped to WebJamApps/JaMmusic");
    },
  );
});

Deno.test("createIssueAndVerify (default approvalCheck, no third arg): refuses to file when no token covers the title", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const prevEnv = Deno.env.get("ISSUE_APPROVAL_TOKEN_PATH");
    Deno.env.set("ISSUE_APPROVAL_TOKEN_PATH", tokenPath);
    try {
      await assertRejects(
        () =>
          createIssueAndVerify(
            { title: "Untokenized test title", bodyFile: "/tmp/b.md" },
            {
              runCmd: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
              readFileText: () => Promise.resolve("body"),
            },
          ),
        Error,
        "Refused to file issue — Gate 2 approval required",
      );
    } finally {
      if (prevEnv === undefined) {
        Deno.env.delete("ISSUE_APPROVAL_TOKEN_PATH");
      } else {
        Deno.env.set("ISSUE_APPROVAL_TOKEN_PATH", prevEnv);
      }
    }
  });
});

Deno.test("createIssueAndVerify (default approvalCheck, no third arg): succeeds when a live token covers the repo and title", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["My Approved Issue"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const prevEnv = Deno.env.get("ISSUE_APPROVAL_TOKEN_PATH");
      Deno.env.set("ISSUE_APPROVAL_TOKEN_PATH", tokenPath);
      try {
        const mockDeps: ExecDeps = {
          runCmd(cmd: string[]) {
            const cmdStr = cmd.join(" ");
            if (cmdStr.includes("gh issue create")) {
              return Promise.resolve({
                code: 0,
                stdout: "https://github.com/WebJamApps/web-jam-tools/issues/999\n",
                stderr: "",
              });
            }
            if (cmdStr.includes("gh api repos/WebJamApps/web-jam-tools/issues/999")) {
              const mockIssue: IssueData = { number: 999, title: "My Approved Issue" };
              return Promise.resolve({ code: 0, stdout: JSON.stringify(mockIssue), stderr: "" });
            }
            return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
          },
          readFileText: () => Promise.resolve("body"),
        };
        const result = await createIssueAndVerify(
          { title: "My Approved Issue", bodyFile: "/tmp/b.md" },
          mockDeps,
        );
        assertEquals(result, 'web-jam-tools#999 "My Approved Issue"');
      } finally {
        if (prevEnv === undefined) {
          Deno.env.delete("ISSUE_APPROVAL_TOKEN_PATH");
        } else {
          Deno.env.set("ISSUE_APPROVAL_TOKEN_PATH", prevEnv);
        }
      }
    },
  );
});

Deno.test("parseArgs parses repeatable --blocked-by flags and formats", () => {
  const args = [
    "--title",
    "Test issue",
    "-F",
    "/tmp/body.md",
    "--parent",
    "737",
    "--blocked-by",
    "748",
    "--blocked-by",
    "#750",
    "--blocked-by=web-jam-back#990",
    "--blocked-by=OtherOrg/OtherRepo#10",
    "--dry-run",
  ];
  const parsed = parseArgs(args);
  assertEquals(parsed.parent, 737);
  assertEquals(parsed.blockedBy, [
    "748",
    "#750",
    "web-jam-back#990",
    "OtherOrg/OtherRepo#10",
  ]);
  assertEquals(parsed.dryRun, true);
});

Deno.test("verifyIssueAttributes verifies blocked-by dependencies", () => {
  const actual: IssueData = {
    number: 100,
    title: "Test",
    blocked_by: [
      { number: 748, repository: { name: "web-jam-tools" } },
      { number: 990, repository: { name: "web-jam-back" } },
    ],
  };

  // Case 1: Matching blockers stick
  const okResult = verifyIssueAttributes(actual, {
    title: "Test",
    bodyFile: "/tmp/b.md",
    blockedBy: ["748", "web-jam-back#990"],
  });
  assertEquals(okResult.ok, true);

  // Case 2: Missing blocker fails verification
  const failResult = verifyIssueAttributes(actual, {
    title: "Test",
    bodyFile: "/tmp/b.md",
    blockedBy: ["748", "750"],
  });
  assertEquals(failResult.ok, false);
  assertEquals(failResult.errors, ['Blocked-by dependency "750" did not stick']);
});

Deno.test("createIssueAndVerify: parent-equals-blocker is REFUSED before any create API call", async () => {
  let createCalled = false;
  const mockDeps: ExecDeps = {
    runCmd(cmd: string[]) {
      if (cmd.join(" ").includes("issue create")) {
        createCalled = true;
      }
      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    },
    readFileText: () => Promise.resolve("body"),
  };

  const err = await assertRejects(
    () =>
      createIssueAndVerify(
        {
          title: "Scratch Task",
          bodyFile: "/tmp/b.md",
          parent: 737,
          blockedBy: ["737"],
        },
        mockDeps,
        APPROVE_ALL,
      ),
    Error,
  );

  assertEquals(createCalled, false);
  assertStringIncludes(
    err.message,
    "Refused: requested blocker #737 is the parent #737 of this issue",
  );
});

Deno.test("createIssueAndVerify: ancestor blocker is REFUSED before any create API call", async () => {
  let createCalled = false;
  const mockDeps: ExecDeps = {
    runCmd(cmd: string[]) {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("issue create")) {
        createCalled = true;
      }
      // Parent 740 has grandparent 700
      if (cmdStr.includes("issue(number: 740)")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: {
                  parent: {
                    number: 700,
                    repository: { name: "web-jam-tools", owner: { login: "WebJamApps" } },
                  },
                },
              },
            },
          }),
          stderr: "",
        });
      }
      if (cmdStr.includes("issue(number: 700)")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: {
                  parent: null,
                },
              },
            },
          }),
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    },
    readFileText: () => Promise.resolve("body"),
  };

  const err = await assertRejects(
    () =>
      createIssueAndVerify(
        {
          title: "Child of 740",
          bodyFile: "/tmp/b.md",
          parent: 740,
          blockedBy: ["700"],
        },
        mockDeps,
        APPROVE_ALL,
      ),
    Error,
  );

  assertEquals(createCalled, false);
  assertStringIncludes(
    err.message,
    "Refused: requested blocker #700 is an ancestor of parent #740",
  );
});

Deno.test("createIssueAndVerify: accepted sibling dependency is registered and verified", async () => {
  const executedCommands: string[] = [];
  const mockDeps: ExecDeps = {
    runCmd(cmd: string[]) {
      const cmdStr = cmd.join(" ");
      executedCommands.push(cmdStr);

      // Create issue
      if (cmdStr.includes("gh issue create")) {
        return Promise.resolve({
          code: 0,
          stdout: "https://github.com/WebJamApps/web-jam-tools/issues/850\n",
          stderr: "",
        });
      }
      // Parent attach
      if (cmdStr.includes("GetIssueNodeIds")) {
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
      // Ancestor check for parent 737 -> no parent
      if (cmdStr.includes("GetParent") || cmdStr.includes("issue(number: 737)")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ data: { repository: { issue: { parent: null } } } }),
          stderr: "",
        });
      }
      if (cmdStr.includes("mutation AddSubIssue")) {
        return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
      }
      // Database ID lookup for blocker 748
      if (cmdStr.includes("GetBlockerId")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: { repository: { issue: { databaseId: 12345678, id: "BLOCKER_NODE_ID" } } },
          }),
          stderr: "",
        });
      }
      // POST dependencies/blocked_by
      if (
        cmdStr.includes("POST repos/WebJamApps/web-jam-tools/issues/850/dependencies/blocked_by")
      ) {
        return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
      }
      // Re-read issue
      if (
        cmdStr.includes("gh api repos/WebJamApps/web-jam-tools/issues/850") &&
        !cmdStr.includes("dependencies")
      ) {
        const issueData: IssueData = {
          number: 850,
          title: "Sibling child",
          parent: { number: 737 },
        };
        return Promise.resolve({ code: 0, stdout: JSON.stringify(issueData), stderr: "" });
      }
      // Re-read dependencies
      if (
        cmdStr.includes("GET repos/WebJamApps/web-jam-tools/issues/850/dependencies/blocked_by") ||
        cmdStr.includes("gh api repos/WebJamApps/web-jam-tools/issues/850/dependencies/blocked_by")
      ) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify([{
            id: 12345678,
            number: 748,
            repository: { name: "web-jam-tools" },
          }]),
          stderr: "",
        });
      }

      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    },
    readFileText: () => Promise.resolve("body text"),
  };

  const result = await createIssueAndVerify(
    {
      title: "Sibling child",
      bodyFile: "/tmp/b.md",
      parent: 737,
      blockedBy: ["748"],
    },
    mockDeps,
    APPROVE_ALL,
  );

  assertEquals(result, 'web-jam-tools#850 "Sibling child"');
  const hasPostDep = executedCommands.some(
    (c) =>
      c.includes("POST repos/WebJamApps/web-jam-tools/issues/850/dependencies/blocked_by") &&
      c.includes("-F issue_id=12345678"),
  );
  assertEquals(hasPostDep, true);
});

Deno.test("createIssueAndVerify: --dry-run returns description without creating issue", async () => {
  let createCalled = false;
  const mockDeps: ExecDeps = {
    runCmd(cmd: string[]) {
      if (cmd.join(" ").includes("issue create")) {
        createCalled = true;
      }
      if (cmd.join(" ").includes("issue(number: 737)")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ data: { repository: { issue: { parent: null } } } }),
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    },
    readFileText: () => Promise.resolve("body"),
  };

  const result = await createIssueAndVerify(
    {
      title: "Dry run task",
      bodyFile: "/tmp/b.md",
      parent: 737,
      blockedBy: ["748"],
      dryRun: true,
    },
    mockDeps,
    () => ({ ok: false, reason: "No token needed for dry-run" }),
  );

  assertEquals(createCalled, false);
  assertEquals(result, 'dry run: would create issue "Dry run task" in WebJamApps/web-jam-tools');
});
