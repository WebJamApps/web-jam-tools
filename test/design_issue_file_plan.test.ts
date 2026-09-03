// test/design_issue_file_plan.test.ts
// Unit tests for `src/design-issue/file_plan.ts` and `deno task design:file-plan` (web-jam-tools#748).

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  filePlan,
  getIssueDatabaseId,
  linkIssueDependency,
  parsePlanFile,
  parsePlanJson,
  runFilePlanCli,
} from "../src/design-issue/file_plan.ts";
import type { ApprovalCheckResult, ExecDeps, IssueData } from "../src/create-issue/lib.ts";

const APPROVE_ALL: (repoFull: string, title: string) => ApprovalCheckResult = () => ({ ok: true });

Deno.test("parsePlanJson parses an object with epic and children", () => {
  const json = JSON.stringify({
    repo: "web-jam-tools",
    milestone: "token-savings",
    epic: {
      title: "Epic Title",
      type: "Epic",
      priority: "High",
      tier: "Opus",
    },
    children: [
      {
        id: 1,
        title: "Child 1",
        type: "Task",
        priority: "High",
        tier: "Flash High",
      },
      {
        id: 2,
        title: "Child 2",
        type: "Task",
        priority: "Medium",
        tier: "Flash High",
        blocked_by: [1],
      },
    ],
  });

  const parsed = parsePlanJson(json);
  assertEquals(parsed.defaultRepo, "web-jam-tools");
  assertEquals(parsed.defaultMilestone, "token-savings");
  assertEquals(parsed.epic?.title, "Epic Title");
  assertEquals(parsed.children.length, 2);
  assertEquals(parsed.children[0].title, "Child 1");
  assertEquals(parsed.children[1].blocked_by, [1]);
});

Deno.test("parsePlanJson parses a top-level array of issues", () => {
  const json = JSON.stringify([
    {
      title: "Epic Issue",
      type: "Epic",
      priority: "High",
    },
    {
      title: "Child Issue",
      type: "Task",
      priority: "Low",
    },
  ]);

  const parsed = parsePlanJson(json);
  assertEquals(parsed.epic?.title, "Epic Issue");
  assertEquals(parsed.children.length, 1);
  assertEquals(parsed.children[0].title, "Child Issue");
});

Deno.test("parsePlanJson throws on invalid JSON or empty structure", () => {
  assertThrows(() => parsePlanJson("not json"), Error, "Failed to parse plan JSON");
  assertThrows(
    () => parsePlanJson("[]"),
    Error,
    "Plan contains no issues to file (empty array)",
  );
  assertThrows(
    () => parsePlanJson("{}"),
    Error,
    "Plan contains no issues to file (missing epic and children/issues)",
  );
});

Deno.test("parsePlanFile parses fixture-plan.json from disk", async () => {
  const parsed = await parsePlanFile("test/fixtures/design-issue/fixture-plan.json");
  assertEquals(parsed.defaultRepo, "web-jam-tools");
  assertEquals(parsed.defaultMilestone, "token-savings");
  assertEquals(parsed.epic?.title, "Fix plan-table validation gaps");
  assertEquals(parsed.children.length, 2);
  assertEquals(parsed.children[0].title, "Add cell validators for design:lint-plan");
  assertEquals(parsed.children[1].title, "Add Tests-cell validation");
  assertEquals(parsed.children[1].blocked_by, [1]);
});

Deno.test("getIssueDatabaseId extracts numeric id from gh api response", async () => {
  const mockDeps: ExecDeps = {
    runCmd(cmd) {
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2].includes("/issues/515")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ id: 987654321, number: 515, title: "Test Issue" }),
          stderr: "",
        });
      }
      return Promise.resolve({ code: 1, stdout: "", stderr: "Not found" });
    },
    readFileText: () => Promise.resolve(""),
  };

  const id = await getIssueDatabaseId("WebJamApps/web-jam-tools", 515, mockDeps);
  assertEquals(id, 987654321);
});

Deno.test("linkIssueDependency calls gh api POST dependencies/blocked_by", async () => {
  const executed: string[][] = [];
  const mockDeps: ExecDeps = {
    runCmd(cmd) {
      executed.push(cmd);
      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    },
    readFileText: () => Promise.resolve(""),
  };

  await linkIssueDependency("WebJamApps/web-jam-tools", 802, 987654321, mockDeps);
  assertEquals(executed.length, 1);
  assertEquals(executed[0], [
    "gh",
    "api",
    "--method",
    "POST",
    "repos/WebJamApps/web-jam-tools/issues/802/dependencies/blocked_by",
    "-F",
    "issue_id=987654321",
  ]);
});

Deno.test("filePlan files epic first, then children attached to epic, then links dependencies", async () => {
  const executedCmds: string[][] = [];
  let nextIssueNum = 900;
  const issueDb: Record<number, IssueData & { id: number }> = {};

  const mockDeps: ExecDeps = {
    runCmd(cmd: string[]) {
      executedCmds.push(cmd);
      const cmdStr = cmd.join(" ");

      // web-jam-tools#901: duplicate search runs before each create call.
      if (cmdStr.includes("gh issue list")) {
        return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
      }

      // gh issue create
      if (cmdStr.includes("gh issue create")) {
        const titleIdx = cmd.indexOf("--title");
        const title = titleIdx !== -1 ? cmd[titleIdx + 1] : "Issue";
        const num = nextIssueNum++;
        const dbId = num * 1000 + 42;
        issueDb[num] = {
          id: dbId,
          number: num,
          title,
          labels: [],
        };
        return Promise.resolve({
          code: 0,
          stdout: `https://github.com/WebJamApps/web-jam-tools/issues/${num}\n`,
          stderr: "",
        });
      }

      // GraphQL GetChildAndTypes
      if (cmdStr.includes("graphql") && cmdStr.includes("GetChildAndTypes")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: { id: "NODE_CHILD" },
                issueTypes: {
                  nodes: [
                    { id: "T_TASK", name: "Task" },
                    { id: "T_EPIC", name: "Epic" },
                    { id: "T_BUG", name: "Bug" },
                  ],
                },
              },
            },
          }),
          stderr: "",
        });
      }

      // GraphQL SetIssueType
      if (cmdStr.includes("graphql") && cmdStr.includes("SetIssueType")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ data: { updateIssue: {} } }),
          stderr: "",
        });
      }

      // GraphQL GetChildNodeId
      if (cmdStr.includes("graphql") && cmdStr.includes("GetChildNodeId")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: { repository: { issue: { id: "NODE_CHILD" } } },
          }),
          stderr: "",
        });
      }

      // GraphQL SetPriority
      if (cmdStr.includes("graphql") && cmdStr.includes("SetPriority")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ data: { updateIssueFieldValue: {} } }),
          stderr: "",
        });
      }

      // GraphQL GetIssueNodeIds
      if (cmdStr.includes("graphql") && cmdStr.includes("GetIssueNodeIds")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: {
              parent: { issue: { id: "NODE_PARENT" } },
              child: { issue: { id: "NODE_CHILD" } },
            },
          }),
          stderr: "",
        });
      }

      // GraphQL AddSubIssue
      if (cmdStr.includes("graphql") && cmdStr.includes("AddSubIssue")) {
        return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
      }

      // gh api repos/WebJamApps/web-jam-tools/issues/<num>
      if (cmd[0] === "gh" && cmd[1] === "api" && !cmd.includes("--method")) {
        const url = cmd[2];
        const match = url.match(/\/issues\/(\d+)/);
        if (match) {
          const num = parseInt(match[1], 10);
          const issue = issueDb[num] || { id: num * 1000 + 42, number: num, title: `Issue ${num}` };
          // Fill attributes expected by createIssueAndVerify
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify({
              ...issue,
              labels: num === 900 ? [{ name: "Opus" }] : [{ name: "Flash High" }],
              type: { name: num === 900 ? "Epic" : "Task" },
              milestone: { title: "token-savings" },
              parent: num > 900 ? { number: 900 } : undefined,
              issue_field_values: [
                {
                  issue_field_id: 3909188,
                  single_select_option: { name: "High" },
                },
              ],
            }),
            stderr: "",
          });
        }
      }

      // POST dependencies/blocked_by
      if (cmdStr.includes("dependencies/blocked_by")) {
        return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
      }

      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    },
    readFileText(path) {
      return Deno.readTextFile(path);
    },
  };

  const result = await filePlan({
    planPath: "test/fixtures/design-issue/fixture-plan.json",
    deps: mockDeps,
    approvalCheck: APPROVE_ALL,
  });

  // Verify result object
  assertEquals(result.epic?.number, 900);
  assertEquals(result.epic?.title, "Fix plan-table validation gaps");
  assertEquals(result.children.length, 2);
  assertEquals(result.children[0].number, 901);
  assertEquals(result.children[0].title, "Add cell validators for design:lint-plan");
  assertEquals(result.children[1].number, 902);
  assertEquals(result.children[1].title, "Add Tests-cell validation");
  assertEquals(result.dependencyLinksCount, 1);
  assertEquals(result.totalIssuesFiled, 3);

  // Verify that dependency linking command was executed for Child 2 blocked by Child 1
  const depLinkCmd = executedCmds.find((c) =>
    c.join(" ").includes("issues/902/dependencies/blocked_by")
  );
  assertEquals(depLinkCmd !== undefined, true);
  // Child 1 is issue #901 with db id 901 * 1000 + 42 = 901042
  assertEquals(depLinkCmd?.includes("-F"), true);
  assertEquals(depLinkCmd?.includes("issue_id=901042"), true);
});

Deno.test("filePlan enforces Gate 2 approval tokens on epic and child titles", async () => {
  const mockApprovalCheck = (_repoFull: string, title: string) => {
    if (title.includes("cell validators")) {
      return { ok: false, reason: "Title not in approval token" };
    }
    return { ok: true };
  };

  await assertRejects(
    () =>
      filePlan({
        planPath: "test/fixtures/design-issue/fixture-plan.json",
        approvalCheck: mockApprovalCheck,
      }),
    Error,
    'Refused to file issue "Add cell validators for design:lint-plan" — Gate 2 approval required',
  );
});

Deno.test("filePlan supports dry-run mode without creating issues", async () => {
  const result = await filePlan({
    planPath: "test/fixtures/design-issue/fixture-plan.json",
    dryRun: true,
    approvalCheck: APPROVE_ALL,
  });

  assertEquals(result.epic?.title, "Fix plan-table validation gaps");
  assertEquals(result.children.length, 2);
  assertEquals(result.totalIssuesFiled, 0);
  assertEquals(result.dependencyLinksCount, 0);
});

Deno.test("filePlan links external dependency citations (e.g. web-jam-tools#747)", async () => {
  const executedCmds: string[][] = [];
  const tempPlan = await Deno.makeTempFile({ prefix: "plan-ext-", suffix: ".json" });
  await Deno.writeTextFile(
    tempPlan,
    JSON.stringify({
      repo: "web-jam-tools",
      children: [
        {
          title: "Dependent Issue",
          type: "Task",
          blocked_by: ["web-jam-tools#747"],
        },
      ],
    }),
  );

  const mockDeps: ExecDeps = {
    runCmd(cmd: string[]) {
      executedCmds.push(cmd);
      const cmdStr = cmd.join(" ");

      if (cmdStr.includes("gh issue create")) {
        return Promise.resolve({
          code: 0,
          stdout: "https://github.com/WebJamApps/web-jam-tools/issues/850\n",
          stderr: "",
        });
      }
      if (cmdStr.includes("graphql")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: { id: "NODE_850" },
                issueTypes: { nodes: [{ id: "T_TASK", name: "Task" }] },
              },
            },
          }),
          stderr: "",
        });
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2].includes("/issues/747")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ id: 747000, number: 747, title: "External blocker" }),
          stderr: "",
        });
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2].includes("/issues/850")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            id: 850000,
            number: 850,
            title: "Dependent Issue",
            type: { name: "Task" },
          }),
          stderr: "",
        });
      }
      if (cmdStr.includes("dependencies/blocked_by")) {
        return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    },
    readFileText(path) {
      return Deno.readTextFile(path);
    },
  };

  try {
    const result = await filePlan({
      planPath: tempPlan,
      deps: mockDeps,
      approvalCheck: APPROVE_ALL,
    });

    assertEquals(result.children.length, 1);
    assertEquals(result.dependencyLinksCount, 1);

    const depCmd = executedCmds.find((c) =>
      c.join(" ").includes("issues/850/dependencies/blocked_by")
    );
    assertEquals(depCmd !== undefined, true);
    assertEquals(depCmd?.includes("issue_id=747000"), true);
  } finally {
    await Deno.remove(tempPlan);
  }
});

Deno.test("filePlan files flat plan without epic and links dependencies", async () => {
  const tempPlan = await Deno.makeTempFile({ prefix: "plan-flat-", suffix: ".json" });
  await Deno.writeTextFile(
    tempPlan,
    JSON.stringify({
      repo: "web-jam-tools",
      children: [
        {
          id: "A",
          title: "Standalone Task 1",
          type: "Task",
          priority: "Low",
          tier: "Haiku",
        },
        {
          id: "B",
          title: "Standalone Task 2",
          type: "Task",
          priority: "Low",
          tier: "Haiku",
          blocked_by: ["A"],
          parent: "none",
        },
      ],
    }),
  );

  let nextNum = 700;
  const titlesByNum: Record<number, string> = {};
  const mockDeps: ExecDeps = {
    runCmd(cmd: string[]) {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("gh issue create")) {
        const titleIdx = cmd.indexOf("--title");
        const title = titleIdx !== -1 ? cmd[titleIdx + 1] : "Task";
        const num = nextNum++;
        titlesByNum[num] = title;
        return Promise.resolve({
          code: 0,
          stdout: `https://github.com/WebJamApps/web-jam-tools/issues/${num}\n`,
          stderr: "",
        });
      }
      if (cmdStr.includes("graphql")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: { id: "N" },
                issueTypes: { nodes: [{ id: "T", name: "Task" }] },
              },
            },
          }),
          stderr: "",
        });
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && !cmd.includes("--method")) {
        const match = cmd[2].match(/\/issues\/(\d+)/);
        const num = match ? parseInt(match[1], 10) : 700;
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            id: num * 100,
            number: num,
            title: titlesByNum[num] || `Task ${num}`,
            type: { name: "Task" },
            labels: [{ name: "Haiku" }],
            issue_field_values: [{
              issue_field_id: 3909188,
              single_select_option: { name: "Low" },
            }],
          }),
          stderr: "",
        });
      }
      if (cmdStr.includes("dependencies/blocked_by")) {
        return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    },
    readFileText(p) {
      return Deno.readTextFile(p);
    },
  };

  try {
    const result = await filePlan({
      planPath: tempPlan,
      deps: mockDeps,
      approvalCheck: APPROVE_ALL,
    });
    assertEquals(result.epic, undefined);
    assertEquals(result.children.length, 2);
    assertEquals(result.dependencyLinksCount, 1);
    assertEquals(result.totalIssuesFiled, 2);
  } finally {
    await Deno.remove(tempPlan);
  }
});

Deno.test("filePlan throws when dependency linking fails", async () => {
  const tempPlan = await Deno.makeTempFile({ prefix: "plan-fail-", suffix: ".json" });
  await Deno.writeTextFile(
    tempPlan,
    JSON.stringify({
      repo: "web-jam-tools",
      children: [
        { id: 1, title: "Task 1", type: "Task" },
        { id: 2, title: "Task 2", type: "Task", blocked_by: [1] },
      ],
    }),
  );

  let nextNum = 600;
  const titlesByNum600: Record<number, string> = {};
  const mockDeps: ExecDeps = {
    runCmd(cmd: string[]) {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("gh issue create")) {
        const titleIdx = cmd.indexOf("--title");
        const title = titleIdx !== -1 ? cmd[titleIdx + 1] : "Task";
        const num = nextNum++;
        titlesByNum600[num] = title;
        return Promise.resolve({
          code: 0,
          stdout: `https://github.com/WebJamApps/web-jam-tools/issues/${num}\n`,
          stderr: "",
        });
      }
      if (cmdStr.includes("graphql")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: { id: "N" },
                issueTypes: { nodes: [{ id: "T", name: "Task" }] },
              },
            },
          }),
          stderr: "",
        });
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && !cmd.includes("--method")) {
        const match = cmd[2].match(/\/issues\/(\d+)/);
        const num = match ? parseInt(match[1], 10) : 600;
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            id: num * 100,
            number: num,
            title: titlesByNum600[num] || `Task ${num}`,
            type: { name: "Task" },
          }),
          stderr: "",
        });
      }
      if (cmdStr.includes("dependencies/blocked_by")) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "API permission denied" });
      }
      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    },
    readFileText(p) {
      return Deno.readTextFile(p);
    },
  };

  try {
    await assertRejects(
      () =>
        filePlan({
          planPath: tempPlan,
          deps: mockDeps,
          approvalCheck: APPROVE_ALL,
        }),
      Error,
      "Failed to link dependency",
    );
  } finally {
    await Deno.remove(tempPlan);
  }
});

Deno.test("runFilePlanCli handles --help, missing path, and dry-run", async () => {
  // Help flag
  const codeHelp = await runFilePlanCli(["--help"]);
  assertEquals(codeHelp, 0);

  // Missing path
  const codeMissing = await runFilePlanCli([]);
  assertEquals(codeMissing, 1);

  // Dry run with non-existent file
  const codeBadFile = await runFilePlanCli(["--plan", "non-existent.json"]);
  assertEquals(codeBadFile, 1);
});

Deno.test("filePlan: pre-validation rejects plan with explicit id colliding with another item position index", async () => {
  const tempPlan = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(
    tempPlan,
    JSON.stringify({
      repo: "web-jam-tools",
      children: [
        { title: "Child A" },
        { id: 1, title: "Child B" },
        { title: "Child C", blocked_by: [1] },
      ],
    }),
  );

  try {
    await assertRejects(
      () =>
        filePlan({
          planPath: tempPlan,
          approvalCheck: APPROVE_ALL,
        }),
      Error,
      "collides with 1-based position index of child 1",
    );
  } finally {
    await Deno.remove(tempPlan);
  }
});

Deno.test("filePlan: pre-validation rejects plan when Epic explicit id collides with child position index", async () => {
  const tempPlan = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(
    tempPlan,
    JSON.stringify({
      repo: "web-jam-tools",
      epic: {
        id: 1,
        title: "Epic With Colliding Id",
      },
      children: [
        { title: "Child A (Position 1)" },
        { title: "Child B (Position 2)", blocked_by: [1] },
      ],
    }),
  );

  try {
    await assertRejects(
      () =>
        filePlan({
          planPath: tempPlan,
          approvalCheck: APPROVE_ALL,
        }),
      Error,
      "collides with 1-based position index of child 1",
    );
  } finally {
    await Deno.remove(tempPlan);
  }
});

Deno.test("filePlan: pre-validation rejects plan with duplicate explicit ids", async () => {
  const tempPlan = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(
    tempPlan,
    JSON.stringify({
      repo: "web-jam-tools",
      children: [
        { id: "step-1", title: "Child A" },
        { id: "step-1", title: "Child B" },
      ],
    }),
  );

  try {
    await assertRejects(
      () =>
        filePlan({
          planPath: tempPlan,
          approvalCheck: APPROVE_ALL,
        }),
      Error,
      'Plan contains duplicate explicit id: "step-1"',
    );
  } finally {
    await Deno.remove(tempPlan);
  }
});

Deno.test("filePlan: pre-validation rejects plan with duplicate titles (case-insensitive)", async () => {
  const tempPlan = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(
    tempPlan,
    JSON.stringify({
      repo: "web-jam-tools",
      children: [
        { title: "Add rate limiting" },
        { title: "add RATE limiting" },
      ],
    }),
  );

  try {
    await assertRejects(
      () =>
        filePlan({
          planPath: tempPlan,
          approvalCheck: APPROVE_ALL,
        }),
      Error,
      'Plan contains duplicate title: "add RATE limiting"',
    );
  } finally {
    await Deno.remove(tempPlan);
  }
});

Deno.test("filePlan: resolves position and explicit id dependencies accurately without collision", async () => {
  const tempPlan = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(
    tempPlan,
    JSON.stringify({
      repo: "web-jam-tools",
      children: [
        { title: "Child A (Position 1)" },
        { id: "feat-b", title: "Child B (Position 2, explicit id feat-b)" },
        { title: "Child C (Position 3)", blocked_by: [1, "feat-b"] },
      ],
    }),
  );

  const linkedDependencies: Array<{ dependentNum: number; blockingId: number }> = [];
  let nextNum = 700;
  const titlesByNum700: Record<number, string> = {};

  const mockDeps: ExecDeps = {
    runCmd(cmd) {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("gh issue list")) {
        return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
      }
      if (cmdStr.includes("gh issue create")) {
        const titleIdx = cmd.indexOf("--title");
        const title = titleIdx !== -1 ? cmd[titleIdx + 1] : "Task";
        const num = nextNum++;
        titlesByNum700[num] = title;
        return Promise.resolve({
          code: 0,
          stdout: `https://github.com/WebJamApps/web-jam-tools/issues/${num}\n`,
          stderr: "",
        });
      }
      if (cmdStr.includes("graphql")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: { id: "N" },
                issueTypes: { nodes: [{ id: "T", name: "Task" }] },
              },
            },
          }),
          stderr: "",
        });
      }
      if (cmd[0] === "gh" && cmd[1] === "api" && !cmd.includes("--method")) {
        const match = cmd[2].match(/\/issues\/(\d+)/);
        const num = match ? parseInt(match[1], 10) : 700;
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            id: num * 10,
            number: num,
            title: titlesByNum700[num] || `Task ${num}`,
            type: { name: "Task" },
          }),
          stderr: "",
        });
      }
      if (cmdStr.includes("dependencies/blocked_by")) {
        const depMatch = cmdStr.match(/\/issues\/(\d+)\/dependencies\/blocked_by/);
        const idMatch = cmdStr.match(/issue_id=(\d+)/);
        if (depMatch && idMatch) {
          linkedDependencies.push({
            dependentNum: parseInt(depMatch[1], 10),
            blockingId: parseInt(idMatch[1], 10),
          });
        }
        return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    },
    readFileText(p) {
      return Deno.readTextFile(p);
    },
  };

  try {
    const result = await filePlan({
      planPath: tempPlan,
      deps: mockDeps,
      approvalCheck: APPROVE_ALL,
    });

    assertEquals(result.children.length, 3);
    assertEquals(result.children[0].number, 700); // Child A
    assertEquals(result.children[1].number, 701); // Child B
    assertEquals(result.children[2].number, 702); // Child C

    // Child C should have 2 dependency links:
    // 1. blocked_by: [1] -> points to Child A (number 700, db id 7000)
    // 2. blocked_by: ["feat-b"] -> points to Child B (number 701, db id 7010)
    assertEquals(linkedDependencies.length, 2);
    assertEquals(linkedDependencies[0], { dependentNum: 702, blockingId: 7000 });
    assertEquals(linkedDependencies[1], { dependentNum: 702, blockingId: 7010 });
  } finally {
    await Deno.remove(tempPlan);
  }
});
