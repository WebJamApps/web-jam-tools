// test/design_issue_file_plan.test.ts
// Unit tests for `src/design-issue/file_plan.ts` and `deno task design:file-plan` (web-jam-tools#748).

import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import * as path from "@std/path";
import { DESIGN_BODY_CASES } from "./support/design_body_cases.ts";

for (const row of DESIGN_BODY_CASES) {
  Deno.test(`file-plan one design: ${row.name}`, async () => {
    const dir = await Deno.makeTempDir();
    try {
      const fixture = JSON.parse(
        await Deno.readTextFile("test/fixtures/design-issue/fixture-plan.json"),
      );
      // A later child must be rejected before the epic can be filed.
      fixture.children[1].body += `\n${row.body}`;
      const planPath = path.join(dir, "plan.json");
      await Deno.writeTextFile(planPath, JSON.stringify(fixture));
      const calls: string[][] = [];
      const execute = () =>
        filePlan({
          planPath,
          dryRun: !row.refused,
          approvalCheck: APPROVE_ALL,
          deps: {
            readFileText: (p) => Deno.readTextFile(p),
            runCmd: (cmd) => {
              calls.push(cmd);
              throw new Error("Unexpected gh call");
            },
          },
        });
      if (row.refused) {
        const error = await assertRejects(execute, Error, "more than one design document");
        assertStringIncludes(error.message, "promote-gigs-design");
        assertStringIncludes(error.message, "nodejs-deno-upgrades-design");
      } else {
        await execute();
      }
      assertEquals(calls, []);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}
import { TEST_AUTHOR, withPassingProbe } from "./authored_by_test_helpers.ts";
import { STEP_AFTER_MERGE_CASES } from "./support/step_after_merge_cases.ts";
import {
  OUTCOME_WORDING_CASES,
  OUTCOME_WORDING_DESIGN_DOC,
} from "./support/outcome_wording_cases.ts";
import {
  extractDesignHeadings,
  findOutcomeWordingViolation,
} from "../src/design-issue/lint_plan.ts";
import { LUNA_SIGNATURE, withSigningFixture } from "./support/codex_signing_fixture.ts";
import { AGY_IDENTITIES, withAgySigningFixture } from "./support/agy_signing_fixture.ts";
import {
  filePlan as realFilePlan,
  type FilePlanOptions,
  getIssueDatabaseId,
  type IssuePlanDoc,
  linkIssueDependency,
  parsePlanFile,
  parsePlanJson,
  runFilePlanCli,
  validateIssueBodyCriteria,
} from "../src/design-issue/file_plan.ts";
import {
  type ApprovalCheckResult,
  defaultExecDeps,
  type ExecDeps,
  type IssueData,
  normalizeRepo,
} from "../src/create-issue/lib.ts";

const APPROVE_ALL: (repoFull: string, title: string) => ApprovalCheckResult = () => ({ ok: true });

for (const identity of AGY_IDENTITIES) {
  Deno.test(`agy plan signs each body as ${identity.conversationId}`, () =>
    withAgySigningFixture(async (signing) => {
      const output: string[] = [];
      const calls: string[][] = [];
      const log = console.log;
      console.log = (...values: unknown[]) => output.push(values.join("\n"));
      try {
        await realFilePlan({
          planPath: "test/fixtures/design-issue/fixture-plan.json",
          dryRun: true,
          author: "agy — Gemini Flash",
          approvalCheck: APPROVE_ALL,
          deps: {
            signing,
            readFileText: (path) => Deno.readTextFile(path),
            runCmd: (cmd) => {
              calls.push(cmd);
              return Promise.resolve({ code: 0, stdout: "", stderr: "" });
            },
          },
        });
      } finally {
        console.log = log;
      }
      const bodies = output.filter((body) => body.startsWith("## What this builds"));
      assertEquals(bodies.length, 3);
      for (const body of bodies) {
        assertEquals(body.trimEnd().endsWith(`🤖 Authored by ${identity.author}`), true);
      }
      assertEquals(calls.some((cmd) => cmd[0] === "gh"), false);
    }, identity));
}

Deno.test("agy plan refuses missing record before any subprocess call", () =>
  withAgySigningFixture(async (signing, _env, recordPath) => {
    await Deno.remove(recordPath);
    const calls: string[][] = [];
    await assertRejects(
      () =>
        realFilePlan({
          planPath: "test/fixtures/design-issue/fixture-plan.json",
          author: "agy — Gemini Flash",
          approvalCheck: APPROVE_ALL,
          deps: {
            signing,
            readFileText: (path) => Deno.readTextFile(path),
            runCmd: (cmd) => {
              calls.push(cmd);
              return Promise.resolve({ code: 0, stdout: "", stderr: "" });
            },
          },
        }),
      Error,
      "Cannot read",
    );
    assertEquals(calls, []);
  }));
Deno.test("file-plan: unreadable body file refuses before filing, naming file and issue", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const fixture = JSON.parse(
      await Deno.readTextFile("test/fixtures/design-issue/fixture-plan.json"),
    );
    fixture.children[0].bodyFile = "/nonexistent/missing-body.md";
    const planPath = path.join(dir, "plan.json");
    await Deno.writeTextFile(planPath, JSON.stringify(fixture));
    const execute = () =>
      realFilePlan({
        planPath,
        dryRun: true,
        approvalCheck: APPROVE_ALL,
        deps: {
          readFileText: (p) => Deno.readTextFile(p),
          runCmd: () => {
            throw new Error("Unexpected gh call");
          },
        },
      });
    const error = await assertRejects(
      execute,
      Error,
      "Refused to file plan — cannot read body file",
    );
    assertStringIncludes(error.message, "/nonexistent/missing-body.md");
    assertStringIncludes(error.message, fixture.children[0].title);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("signing plan m: every dry-run body has the looked-up Luna footer", () =>
  withSigningFixture(async (signing) => {
    const output: string[] = [];
    const calls: string[][] = [];
    const log = console.log;
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    try {
      const result = await realFilePlan({
        planPath: "test/fixtures/design-issue/fixture-plan.json",
        dryRun: true,
        author: "Codex — GPT-6.1 Sol",
        approvalCheck: APPROVE_ALL,
        deps: {
          signing,
          readFileText: (path) => Deno.readTextFile(path),
          runCmd: (cmd) => {
            calls.push(cmd);
            return Promise.resolve({ code: 0, stdout: "", stderr: "" });
          },
        },
      });
      assertEquals(result.totalIssuesFiled, 0);
    } finally {
      console.log = log;
    }
    const bodies = output.filter((line) => line.startsWith("## What this builds"));
    assertEquals(bodies.length, 3);
    for (const body of bodies) {
      assertEquals(body.trimEnd().endsWith(`🤖 Authored by ${LUNA_SIGNATURE}`), true);
      assertEquals(body.includes("🤖 Authored by Codex — GPT-6.1 Sol"), false);
    }
    assertEquals(calls.some((cmd) => cmd[0] === "gh"), false);
  }));

// Authored-by footer (web-jam-tools#1205): supply a valid author and a fake
// roster probe so the tests below stay about their own behavior.
const filePlan = (options: FilePlanOptions) =>
  realFilePlan({
    author: TEST_AUTHOR,
    ...options,
    deps: withPassingProbe(options.deps ?? defaultExecDeps),
  });

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
        tier: "Terra",
      },
      {
        id: 2,
        title: "Child 2",
        type: "Task",
        priority: "Medium",
        tier: "Terra",
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

/** Runs the real filer with a stubbed gh, recording native parent attachments. */
async function fileParentFixture(plan: IssuePlanDoc) {
  plan.designDoc ??= "test/fixtures/design-issue/fixture-design.md";
  const planPath = await Deno.makeTempFile({ suffix: ".json" });
  const items = [...(plan.epic ? [plan.epic] : []), ...(plan.children ?? [])];
  for (const item of items) {
    item.labels ??= ["Terra"];
    if (
      item.type?.toLowerCase() !== "epic" && !item.labels.includes("Josh") && item.tier !== "Josh"
    ) {
      item.body ??=
        `## What this builds\n\n${item.title}\n\n## Acceptance criteria\n\n- [ ] \`deno task test\` passes\n`;
    }
  }
  const created = new Map<number, IssueData>();
  const parents = new Map<number, number>();
  const queries: string[] = [];
  let nextNumber = 700;
  const deps: ExecDeps = {
    readFileText: (p) => Deno.readTextFile(p),
    runCmd(cmd) {
      const reply = (data: unknown) =>
        Promise.resolve({ code: 0, stdout: JSON.stringify(data), stderr: "" });
      if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "create") {
        const number = nextNumber++;
        const item = items[number - 700];
        assertEquals(cmd[cmd.indexOf("--title") + 1], item.title);
        created.set(number, {
          number,
          title: item.title,
          type: { name: item.type ?? (item === plan.epic ? "Epic" : "Task") },
          labels: (item.labels as string[]).map((name) => ({ name })),
        });
        const childRepo = normalizeRepo(item.repo || plan.repo);
        return Promise.resolve({
          code: 0,
          stdout: `https://github.com/${childRepo.full}/issues/${number}\n`,
          stderr: "",
        });
      }
      if (cmd[0] === "gh" && cmd[1] === "api") {
        if (cmd[2].includes("issues?state=open&") || cmd[2].includes("issues?state=open")) {
          return reply([]);
        }
        if (cmd[2] === "graphql") {
          const query = cmd.find((arg) => arg.startsWith("query=")) ?? "";
          queries.push(query);
          if (query.includes("ValidateParent") || query.includes("GetParentIssue")) {
            const num = query.match(/issue\(number: (\d+)\)/)?.[1];
            if (num === "999999") {
              return reply({ data: { repository: { issue: null } } });
            }
            return reply({ data: { repository: { issue: { id: `P${num}` } } } });
          }
          if (query.includes("GetChildAndTypes")) {
            return reply({
              data: {
                repository: {
                  issue: { id: "CREATED" },
                  issueTypes: {
                    nodes: [
                      { id: "TASK", name: "Task" },
                      { id: "EPIC", name: "Epic" },
                    ],
                  },
                },
              },
            });
          }
          if (query.includes("SetIssueType")) return reply({ data: { updateIssue: {} } });
          if (query.includes("GetIssueNodeIds")) {
            const numbers = [...query.matchAll(/issue\(number: (\d+)\)/g)];
            assertEquals(numbers.length, 2);
            return reply({
              data: {
                parent: { issue: { id: `P${numbers[0][1]}` } },
                child: { issue: { id: `C${numbers[1][1]}` } },
              },
            });
          }
          if (query.includes("AddSubIssue")) {
            const parent = query.match(/issueId: "P(\d+)"/);
            const child = query.match(/subIssueId: "C(\d+)"/);
            if (!parent || !child) throw new Error(`Invalid attachment mutation: ${query}`);
            parents.set(Number(child[1]), Number(parent[1]));
            return reply({ data: { addSubIssue: {} } });
          }
        } else {
          const match = cmd[2].match(/\/issues\/(\d+)$/);
          if (match) {
            const number = Number(match[1]);
            const issue = created.get(number);
            if (!issue) throw new Error(`Read uncreated issue ${number}`);
            return reply({
              ...issue,
              id: number * 10,
              ...(parents.has(number) ? { parent: { number: parents.get(number) } } : {}),
            });
          }
        }
      }
      throw new Error(`Unexpected gh call: ${cmd.join(" ")}`);
    },
  };
  try {
    await Deno.writeTextFile(planPath, JSON.stringify(plan));
    const result = await filePlan({ planPath, deps, approvalCheck: APPROVE_ALL });
    return { result, parents, queries };
  } finally {
    await Deno.remove(planPath);
  }
}

for (
  const parent of [1329, "1329", "#1329", "web-jam-tools#1329", "WebJamApps/web-jam-tools#1329"]
) {
  Deno.test(`filePlan parent: ${JSON.stringify(parent)} attaches to existing issue 1329`, async () => {
    const { result, parents } = await fileParentFixture({
      repo: "web-jam-tools",
      children: [{ title: "Calibration child", parent }],
    });
    assertEquals(result.totalIssuesFiled, 1);
    assertEquals([...parents], [[700, 1329]]);
  });
}

for (const parent of ["none", "null", "-", "", null]) {
  Deno.test(`filePlan parent: ${JSON.stringify(parent)} suppresses the default epic parent`, async () => {
    const { parents } = await fileParentFixture({
      repo: "web-jam-tools",
      epic: { title: "Fixture epic" },
      children: [{ title: "Calibration child", parent }],
    });
    assertEquals(parents.size, 0);
  });
}

for (const parent of ["epic", "parent", undefined]) {
  Deno.test(`filePlan parent: ${String(parent)} attaches to the filed epic`, async () => {
    const { parents } = await fileParentFixture({
      repo: "web-jam-tools",
      epic: { title: "Fixture epic" },
      children: [{ title: "Calibration child", parent }],
    });
    assertEquals([...parents], [[701, 700]]);
  });
}

for (const parent of [2, "2", "#2", "feature-b", "Fixture CHILD B"]) {
  Deno.test(`filePlan parent: ${JSON.stringify(parent)} resolves a preceding plan child`, async () => {
    const { parents } = await fileParentFixture({
      repo: "web-jam-tools",
      children: [
        { title: "Fixture child A" },
        { id: "feature-b", title: "Fixture child B" },
        { title: "Calibration child", parent },
      ],
    });
    assertEquals([...parents], [[702, 701]]);
  });
}

Deno.test("filePlan parent: repository citation names an existing issue rather than a plan position", async () => {
  const { parents } = await fileParentFixture({
    repo: "web-jam-tools",
    children: [
      { title: "Fixture child A" },
      { title: "Fixture child B" },
      { title: "Calibration child", parent: "web-jam-tools#2" },
    ],
  });
  assertEquals([...parents], [[702, 2]]);
});

for (const id of ["web-jam-tools#2", "JaMmusic#12"]) {
  Deno.test(`filePlan parent: explicit id ${id} precedes citation interpretation`, async () => {
    const { parents } = await fileParentFixture({
      repo: "web-jam-tools",
      children: [
        { title: "Fixture child A" },
        { id, title: "Fixture child B" },
        { title: "Calibration child", parent: id },
      ],
    });
    assertEquals([...parents], [[702, 701]]);
  });
}

Deno.test("epics case 09: design:file-plan parent 1, the first plan item in the same repository, is linked", async () => {
  const { parents } = await fileParentFixture({
    repo: "web-jam-tools",
    children: [
      { title: "First child" },
      { title: "Second child", parent: 1 },
    ],
  });
  assertEquals([...parents], [[701, 700]]);
});

Deno.test('epics case 10: design:file-plan parent "WebJamApps/web-jam-tools#1355" on a JaMmusic child is linked across repositories', async () => {
  const { parents } = await fileParentFixture({
    repo: "web-jam-tools",
    children: [
      { title: "JaMmusic child", repo: "JaMmusic", parent: "WebJamApps/web-jam-tools#1355" },
    ],
  });
  assertEquals([...parents], [[700, 1355]]);
});

Deno.test('epics case 11: design:file-plan parent "web-jam-tools#1355" is resolved to WebJamApps/web-jam-tools#1355 and linked', async () => {
  const { parents, queries } = await fileParentFixture({
    repo: "web-jam-tools",
    children: [
      { title: "JaMmusic child", repo: "JaMmusic", parent: "web-jam-tools#1355" },
    ],
  });
  assertEquals([...parents], [[700, 1355]]);
  // The bare citation was looked up and attached as WebJamApps/web-jam-tools#1355.
  const lookup = queries.find((q) => q.includes("ValidateParent")) ?? "";
  assertEquals(lookup.includes('repository(owner: "WebJamApps", name: "web-jam-tools")'), true);
  assertEquals(lookup.includes("issue(number: 1355)"), true);
});

Deno.test('epics case 12: design:file-plan parent "WebJamApps/web-jam-tools#999999", an issue that does not exist, is refused before anything is filed, naming the reference', async () => {
  const planPath = await Deno.makeTempFile({ suffix: ".json" });
  const calls: string[][] = [];
  try {
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "JaMmusic",
        designDoc: "test/fixtures/design-issue/fixture-design.md",
        children: [
          {
            title: "Child with missing parent",
            labels: ["Terra"],
            parent: "WebJamApps/web-jam-tools#999999",
            body:
              "## What this builds\n\nChild with missing parent\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes\n",
          },
        ],
      }),
    );
    const error = await assertRejects(
      () =>
        filePlan({
          planPath,
          dryRun: false,
          approvalCheck: APPROVE_ALL,
          deps: {
            readFileText: (p) => Deno.readTextFile(p),
            runCmd(cmd) {
              calls.push(cmd);
              const cmdStr = cmd.join(" ");
              if (cmdStr.includes("ValidateParent") || cmdStr.includes("GetParentIssue")) {
                return Promise.resolve({
                  code: 0,
                  stdout: JSON.stringify({ data: { repository: { issue: null } } }),
                  stderr: "",
                });
              }
              return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
            },
          },
        }),
      Error,
      "WebJamApps/web-jam-tools#999999",
    );
    assertEquals(error.message.includes("not found"), true);
    assertEquals(calls.some((cmd) => cmd[1] === "issue" && cmd[2] === "create"), false);
  } finally {
    await Deno.remove(planPath);
  }
});

for (
  const parent of [
    "web-jam-tools#",
    "no-such-id",
    "epic",
    "parent",
  ]
) {
  for (const dryRun of [false, true]) {
    Deno.test(`filePlan parent: refuses ${JSON.stringify(parent)} before any filing (dryRun=${dryRun})`, async () => {
      const planPath = await Deno.makeTempFile({ suffix: ".json" });
      const calls: string[][] = [];
      try {
        await Deno.writeTextFile(
          planPath,
          JSON.stringify({
            repo: "web-jam-tools",
            ...(["epic", "parent"].includes(parent)
              ? {}
              : { epic: { title: "Fixture epic", tier: "Terra" } }),
            children: [{ title: "Valid preceding child", tier: "Terra" }, {
              title: "Invalid parent child",
              tier: "Terra",
              parent,
            }],
          }),
        );
        const error = await assertRejects(
          () =>
            filePlan({
              planPath,
              dryRun,
              approvalCheck: APPROVE_ALL,
              deps: {
                readFileText: (p) => Deno.readTextFile(p),
                runCmd(cmd) {
                  calls.push(cmd);
                  return Promise.reject(
                    new Error("No gh call is allowed before parent validation"),
                  );
                },
              },
            }),
          Error,
          "Cannot resolve parent",
        );
        assertEquals(error.message.includes("Invalid parent child"), true);
        assertEquals(error.message.includes(JSON.stringify(parent)), true);
        assertEquals(calls, []);
      } finally {
        await Deno.remove(planPath);
      }
    });
  }
}

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
      if (cmdStr.includes("gh api repos/WebJamApps/web-jam-tools/issues?state=open&")) {
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

      // GraphQL GetIssueNodeIds / GetParentIssue / ValidateParent
      if (
        cmdStr.includes("graphql") &&
        (cmdStr.includes("GetIssueNodeIds") ||
          cmdStr.includes("GetParentIssue") ||
          cmdStr.includes("ValidateParent"))
      ) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: { issue: { id: "NODE_PARENT" } },
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
              labels: num === 900 ? [{ name: "Opus" }] : [{ name: "Terra" }],
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

  // Authored-by footer (web-jam-tools#1205): every filed body ends with the footer.
  const createCmds = executedCmds.filter((c) => c[1] === "issue" && c[2] === "create");
  assertEquals(createCmds.length, 3);
  for (const c of createCmds) {
    assertEquals(
      c[c.indexOf("--body") + 1].trimEnd().endsWith(`🤖 Authored by ${TEST_AUTHOR}`),
      true,
    );
  }
});

Deno.test("filePlan refuses without --author before filing anything", async () => {
  const executedCmds: string[][] = [];
  const deps: ExecDeps = {
    signing: { env: () => undefined },
    runCmd(cmd: string[]) {
      executedCmds.push(cmd);
      return Promise.resolve(
        cmd[1] === "--check-author"
          ? {
            code: 1,
            stdout: "",
            stderr: "ERROR: --author '' does not name a model on the roster",
          }
          : { code: 0, stdout: "{}", stderr: "" },
      );
    },
    readFileText: (path) => Deno.readTextFile(path),
  };
  await assertRejects(
    () =>
      realFilePlan({
        planPath: "test/fixtures/design-issue/fixture-plan.json",
        deps,
        approvalCheck: APPROVE_ALL,
      }),
    Error,
    "--author is required",
  );
  assertEquals(executedCmds.filter((c) => c[0] === "gh").length, 0);
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
      designDoc: "test/fixtures/design-issue/fixture-design.md",
      children: [
        {
          title: "Dependent Issue",
          type: "Task",
          tier: "Terra",
          body:
            "## What this builds\n\nDependent Issue\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes\n",
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
            labels: [{ name: "Terra" }],
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
      designDoc: "test/fixtures/design-issue/fixture-design.md",
      children: [
        {
          id: "A",
          title: "Standalone Task 1",
          type: "Task",
          priority: "Low",
          tier: "Haiku",
          body:
            "## What this builds\n\nStandalone Task 1\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes\n",
        },
        {
          id: "B",
          title: "Standalone Task 2",
          type: "Task",
          priority: "Low",
          tier: "Haiku",
          blocked_by: ["A"],
          parent: "none",
          body:
            "## What this builds\n\nStandalone Task 2\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes\n",
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
      designDoc: "test/fixtures/design-issue/fixture-design.md",
      children: [
        {
          id: 1,
          title: "Task 1",
          type: "Task",
          tier: "Terra",
          body:
            "## What this builds\n\nTask 1\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes\n",
        },
        {
          id: 2,
          title: "Task 2",
          type: "Task",
          tier: "Terra",
          blocked_by: [1],
          body:
            "## What this builds\n\nTask 2\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes\n",
        },
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
            labels: [{ name: "Terra" }],
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
        { title: "Add rate limiting", tier: "Terra" },
        { title: "add RATE limiting", tier: "Terra" },
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
      designDoc: "test/fixtures/design-issue/fixture-design.md",
      children: [
        {
          title: "Child A (Position 1)",
          tier: "Terra",
          body:
            "## What this builds\n\nChild A\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes\n",
        },
        {
          id: "feat-b",
          title: "Child B (Position 2, explicit id feat-b)",
          tier: "Terra",
          body:
            "## What this builds\n\nChild B\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes\n",
        },
        {
          title: "Child C (Position 3)",
          tier: "Terra",
          blocked_by: [1, "feat-b"],
          body:
            "## What this builds\n\nChild C\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes\n",
        },
      ],
    }),
  );

  const linkedDependencies: Array<{ dependentNum: number; blockingId: number }> = [];
  let nextNum = 700;
  const titlesByNum700: Record<number, string> = {};

  const mockDeps: ExecDeps = {
    runCmd(cmd) {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("gh api repos/WebJamApps/web-jam-tools/issues?state=open&")) {
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
            labels: [{ name: "Terra" }],
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

// --- Appendix D — Case Lists: Issues filed from a design point at it (Cases 7–15) ---
// In every case the design document has a heading `### The model-label rule` and no heading `Nope`.
const APPENDIX_D_DESIGN_CONTENT = `
# Fixture Design Document

### The model-label rule

Section requirements.
`;

Deno.test('Appendix D Case 7: Body criterion `- [ ] builds "The model-label rule" as written` passes', async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const designPath = path.join(tmpDir, "design.md");
    const planPath = path.join(tmpDir, "plan.json");
    await Deno.writeTextFile(designPath, APPENDIX_D_DESIGN_CONTENT);
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        designDoc: designPath,
        children: [
          {
            title: "Task with valid heading criterion",
            tier: "Terra",
            body:
              '## What this builds\n\nSomething\n\n## Acceptance criteria\n\n- [ ] builds "The model-label rule" as written',
          },
        ],
      }),
    );
    const result = await filePlan({ planPath, dryRun: true, approvalCheck: APPROVE_ALL });
    assertEquals(result.children.length, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("Appendix D Case 8: Body criterion ``- [ ] `deno task test` passes`` passes", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const designPath = path.join(tmpDir, "design.md");
    const planPath = path.join(tmpDir, "plan.json");
    await Deno.writeTextFile(designPath, APPENDIX_D_DESIGN_CONTENT);
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        designDoc: designPath,
        children: [
          {
            title: "Task with command criterion",
            tier: "Terra",
            body:
              "## What this builds\n\nSomething\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes",
          },
        ],
      }),
    );
    const result = await filePlan({ planPath, dryRun: true, approvalCheck: APPROVE_ALL });
    assertEquals(result.children.length, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test('Appendix D Case 9: Body criterion `- [ ] builds "Nope" as written` is refused before the first issue is filed, naming the item and the line', async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const designPath = path.join(tmpDir, "design.md");
    const planPath = path.join(tmpDir, "plan.json");
    await Deno.writeTextFile(designPath, APPENDIX_D_DESIGN_CONTENT);
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        designDoc: designPath,
        children: [
          {
            title: "Task with Nope heading",
            tier: "Terra",
            body:
              '## What this builds\n\nSomething\n\n## Acceptance criteria\n\n- [ ] builds "Nope" as written',
          },
        ],
      }),
    );
    const error = await assertRejects(
      () => filePlan({ planPath, dryRun: false, approvalCheck: APPROVE_ALL }),
      Error,
      "Refused to file plan",
    );
    assertStringIncludes(error.message, 'issue "Task with Nope heading"');
    assertStringIncludes(error.message, '- [ ] builds "Nope" as written');
    assertStringIncludes(error.message, "Nope");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("Appendix D Case 10: Body criterion `- [ ] The pull request merges` is refused the same way: neither a heading nor a command", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const designPath = path.join(tmpDir, "design.md");
    const planPath = path.join(tmpDir, "plan.json");
    await Deno.writeTextFile(designPath, APPENDIX_D_DESIGN_CONTENT);
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        designDoc: designPath,
        children: [
          {
            title: "Task with neither heading nor command",
            tier: "Terra",
            body:
              "## What this builds\n\nSomething\n\n## Acceptance criteria\n\n- [ ] The pull request merges",
          },
        ],
      }),
    );
    const error = await assertRejects(
      () => filePlan({ planPath, dryRun: false, approvalCheck: APPROVE_ALL }),
      Error,
      "neither a heading nor a command",
    );
    assertStringIncludes(error.message, 'issue "Task with neither heading nor command"');
    assertStringIncludes(error.message, "- [ ] The pull request merges");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("Appendix D Case 11: A body with no `## Acceptance criteria` section is refused the same way", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const designPath = path.join(tmpDir, "design.md");
    const planPath = path.join(tmpDir, "plan.json");
    await Deno.writeTextFile(designPath, APPENDIX_D_DESIGN_CONTENT);
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        designDoc: designPath,
        children: [
          {
            title: "Task without criteria section",
            tier: "Terra",
            body: "## What this builds\n\nOnly description here.",
          },
        ],
      }),
    );
    const error = await assertRejects(
      () => filePlan({ planPath, dryRun: false, approvalCheck: APPROVE_ALL }),
      Error,
      'has no "## Acceptance criteria" section',
    );
    assertStringIncludes(error.message, 'issue "Task without criteria section"');
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("Appendix D Case 12: The epic item's body with criterion `- [ ] Closes when all child sub-issues close` passes — the epic is not checked", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const designPath = path.join(tmpDir, "design.md");
    const planPath = path.join(tmpDir, "plan.json");
    await Deno.writeTextFile(designPath, APPENDIX_D_DESIGN_CONTENT);
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        designDoc: designPath,
        epic: {
          title: "Epic container",
          tier: "Opus",
          escalationReason: "Container epic",
          body:
            "## What this builds\n\nEpic\n\n## Acceptance criteria\n\n- [ ] Closes when all child sub-issues close",
        },
        children: [
          {
            title: "Child task",
            tier: "Terra",
            body:
              "## What this builds\n\nChild\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes",
          },
        ],
      }),
    );
    const result = await filePlan({ planPath, dryRun: true, approvalCheck: APPROVE_ALL });
    assertEquals(result.epic?.title, "Epic container");
    assertEquals(result.children.length, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("Appendix D Case 13: A `Josh`-labeled item's criterion `- [ ] Josh confirms he ran it` passes — the manual step is not checked", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const designPath = path.join(tmpDir, "design.md");
    const planPath = path.join(tmpDir, "plan.json");
    await Deno.writeTextFile(designPath, APPENDIX_D_DESIGN_CONTENT);
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        designDoc: designPath,
        children: [
          {
            title: "Manual walkthrough step",
            tier: "Josh",
            labels: ["Josh"],
            body:
              "## What this builds\n\nManual walkthrough\n\n## Acceptance criteria\n\n- [ ] Josh confirms he ran it",
          },
        ],
      }),
    );
    const result = await filePlan({ planPath, dryRun: true, approvalCheck: APPROVE_ALL });
    assertEquals(result.children.length, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("Appendix D Case 14: A plan with no `designDoc` field is refused before the first issue is filed: the design document is not named", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const planPath = path.join(tmpDir, "plan.json");
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        children: [
          {
            title: "Task with no designDoc in plan",
            tier: "Terra",
            body:
              "## What this builds\n\nTask\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes",
          },
        ],
      }),
    );
    const error = await assertRejects(
      () => filePlan({ planPath, dryRun: false, approvalCheck: APPROVE_ALL }),
      Error,
      "the design document is not named",
    );
    assertStringIncludes(error.message, 'missing "designDoc" field in plan');
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("Appendix D Case 15: A plan whose `designDoc` cannot be read is refused before the first issue is filed, naming the path", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const planPath = path.join(tmpDir, "plan.json");
    const nonExistentDesignDoc = path.join(tmpDir, "non-existent-design.md");
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        designDoc: nonExistentDesignDoc,
        children: [
          {
            title: "Task with missing design doc file",
            tier: "Terra",
            body:
              "## What this builds\n\nTask\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes",
          },
        ],
      }),
    );
    const error = await assertRejects(
      () => filePlan({ planPath, dryRun: false, approvalCheck: APPROVE_ALL }),
      Error,
      "cannot be read",
    );
    assertStringIncludes(error.message, nonExistentDesignDoc);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("validateIssueBodyCriteria: throws when no acceptance criteria section exists", () => {
  const headings = new Set(["the model-label rule"]);
  assertThrows(
    () => validateIssueBodyCriteria("Task", "## What this builds\n\nNo criteria", headings),
    Error,
    'has no "## Acceptance criteria" section',
  );
});

Deno.test("validateIssueBodyCriteria: nested subsections (e.g. ### Behavior) are scanned and pass when all criteria are valid", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const designPath = path.join(tmpDir, "design.md");
    const planPath = path.join(tmpDir, "plan.json");
    await Deno.writeTextFile(designPath, APPENDIX_D_DESIGN_CONTENT);
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        designDoc: designPath,
        children: [
          {
            title: "Task with grouped criteria in subsections",
            tier: "Terra",
            body:
              '## What this builds\n\nTask\n\n## Acceptance criteria\n\n### Commands\n\n- [ ] `deno task test` passes\n\n### Behavior\n\n- [ ] builds "The model-label rule" as written\n\n## Files changed\n\n- src/index.ts',
          },
        ],
      }),
    );
    const result = await filePlan({ planPath, dryRun: true, approvalCheck: APPROVE_ALL });
    assertEquals(result.children.length, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("validateIssueBodyCriteria: nested subsections (e.g. ### Behavior) are scanned and refuse invalid criteria before filing", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const designPath = path.join(tmpDir, "design.md");
    const planPath = path.join(tmpDir, "plan.json");
    await Deno.writeTextFile(designPath, APPENDIX_D_DESIGN_CONTENT);
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        designDoc: designPath,
        children: [
          {
            title: "Task with invalid criterion in subsection",
            tier: "Terra",
            body:
              '## What this builds\n\nTask\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes\n\n### Behavior\n\n- [ ] builds "Nope" as written\n\n## Files changed\n\n- src/index.ts',
          },
        ],
      }),
    );
    const error = await assertRejects(
      () => filePlan({ planPath, dryRun: false, approvalCheck: APPROVE_ALL }),
      Error,
      "Refused to file plan",
    );
    assertStringIncludes(error.message, 'issue "Task with invalid criterion in subsection"');
    assertStringIncludes(error.message, '- [ ] builds "Nope" as written');
    assertStringIncludes(error.message, "Nope");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("validateIssueBodyCriteria: wrapped criteria across continuation lines assemble into one criterion and pass", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const designPath = path.join(tmpDir, "design.md");
    const planPath = path.join(tmpDir, "plan.json");
    await Deno.writeTextFile(designPath, APPENDIX_D_DESIGN_CONTENT);
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        designDoc: designPath,
        children: [
          {
            title: "Task with wrapped criterion",
            tier: "Terra",
            body:
              '## What this builds\n\nTask\n\n## Acceptance criteria\n\n- [ ] builds "The model-label rule"\n  as written\n\n## Files changed\n\n- src/index.ts',
          },
        ],
      }),
    );
    const result = await filePlan({ planPath, dryRun: true, approvalCheck: APPROVE_ALL });
    assertEquals(result.children.length, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("validateIssueBodyCriteria: wrapped criteria across continuation lines assemble into one criterion and refuse invalid heading", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const designPath = path.join(tmpDir, "design.md");
    const planPath = path.join(tmpDir, "plan.json");
    await Deno.writeTextFile(designPath, APPENDIX_D_DESIGN_CONTENT);
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        designDoc: designPath,
        children: [
          {
            title: "Task with wrapped invalid criterion",
            tier: "Terra",
            body:
              '## What this builds\n\nTask\n\n## Acceptance criteria\n\n- [ ] builds "Nope"\n  as written\n\n## Files changed\n\n- src/index.ts',
          },
        ],
      }),
    );
    const error = await assertRejects(
      () => filePlan({ planPath, dryRun: false, approvalCheck: APPROVE_ALL }),
      Error,
      "Refused to file plan",
    );
    assertStringIncludes(error.message, 'issue "Task with wrapped invalid criterion"');
    assertStringIncludes(error.message, '- [ ] builds "Nope" as written');
    assertStringIncludes(error.message, "Nope");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("validateIssueBodyCriteria: indented acceptance criteria heading (e.g. '  ## Acceptance criteria') is recognized", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const designPath = path.join(tmpDir, "design.md");
    const planPath = path.join(tmpDir, "plan.json");
    await Deno.writeTextFile(designPath, APPENDIX_D_DESIGN_CONTENT);
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        designDoc: designPath,
        children: [
          {
            title: "Task with indented criteria heading",
            tier: "Terra",
            body:
              '## What this builds\n\nTask\n\n  ## Acceptance criteria\n\n- [ ] builds "The model-label rule" as written\n\n## Files changed\n\n- src/index.ts',
          },
        ],
      }),
    );
    const result = await filePlan({ planPath, dryRun: true, approvalCheck: APPROVE_ALL });
    assertEquals(result.children.length, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("validateIssueBodyCriteria: indented subsequent heading (e.g. '  ## Files changed') terminates the criteria section", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const designPath = path.join(tmpDir, "design.md");
    const planPath = path.join(tmpDir, "plan.json");
    await Deno.writeTextFile(designPath, APPENDIX_D_DESIGN_CONTENT);
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        designDoc: designPath,
        children: [
          {
            title: "Task with indented next section",
            tier: "Terra",
            body:
              '## What this builds\n\nTask\n\n## Acceptance criteria\n\n- [ ] builds "The model-label rule" as written\n\n  ## Files changed\n\n- src/index.ts\nUnrelated text that is neither a heading nor command',
          },
        ],
      }),
    );
    const result = await filePlan({ planPath, dryRun: true, approvalCheck: APPROVE_ALL });
    assertEquals(result.children.length, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// --- Appendix D — "A step after the merge and its commands" (web-jam-tools#1724) ---

const STEP_AFTER_MERGE_DESIGN_DOC = `
# Step After Merge Design Fixture

### Manual Steps & Runbooks

Requirements text here.
`;

for (const c of STEP_AFTER_MERGE_CASES) {
  Deno.test(`Appendix D step-after-merge (file-plan) ${c.name}`, async () => {
    const tmpDir = await Deno.makeTempDir();
    try {
      const designPath = path.join(tmpDir, "design.md");
      const planPath = path.join(tmpDir, "plan.json");
      await Deno.writeTextFile(designPath, STEP_AFTER_MERGE_DESIGN_DOC);
      const body =
        `## What this builds\n\nTask\n\n## Acceptance criteria\n\n- [ ] ${c.criterion}\n`;
      const planPayload = c.isEpic
        ? {
          repo: "web-jam-tools",
          designDoc: designPath,
          epic: {
            title: "Epic container",
            tier: "Opus",
            escalationReason: "Container epic",
            body,
          },
          children: [
            {
              title: "Child task",
              tier: "Terra",
              body:
                "## What this builds\n\nChild\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes\n",
            },
          ],
        }
        : {
          repo: "web-jam-tools",
          designDoc: designPath,
          children: [
            {
              title: "Step after merge test task",
              labels: c.labels,
              body,
            },
          ],
        };
      await Deno.writeTextFile(planPath, JSON.stringify(planPayload));
      const noGhDeps: ExecDeps = {
        signing: { env: () => undefined },
        readFileText: (p) => Deno.readTextFile(p),
        runCmd: () => {
          throw new Error("Unexpected gh call");
        },
      };
      if (c.expectedError) {
        const error = await assertRejects(
          () => filePlan({ planPath, dryRun: false, approvalCheck: APPROVE_ALL, deps: noGhDeps }),
          Error,
          "Refused to file plan",
        );
        assertStringIncludes(error.message, c.expectedError);
        assertStringIncludes(error.message, c.criterion);
      } else if (!c.isEpic && findOutcomeWordingViolation(c.criterion, { labels: c.labels })) {
        // Under web-jam-tools#1775, design-filed criteria containing `"refused"` outside
        // backticks are refused for outcome wording by filePlan; step-after-merge still passes.
        const error = await assertRejects(
          () => filePlan({ planPath, dryRun: false, approvalCheck: APPROVE_ALL, deps: noGhDeps }),
          Error,
          "contains outcome wording",
        );
        assertStringIncludes(error.message, c.criterion);
        validateIssueBodyCriteria(
          "Step after merge test task",
          body,
          extractDesignHeadings(STEP_AFTER_MERGE_DESIGN_DOC),
          { labels: c.labels, checkOutcomeWording: false },
        );
      } else {
        const result = await filePlan({
          planPath,
          dryRun: true,
          approvalCheck: APPROVE_ALL,
          deps: noGhDeps,
        });
        assertEquals(result.children.length, 1);
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  });
}

Deno.test("Appendix D step-after-merge (file-plan) case 24: unreadable body file is refused naming the file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const designPath = path.join(tmpDir, "design.md");
    const planPath = path.join(tmpDir, "plan.json");
    const missingBodyPath = path.join(tmpDir, "missing-body.md");
    await Deno.writeTextFile(designPath, STEP_AFTER_MERGE_DESIGN_DOC);
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        designDoc: designPath,
        children: [
          {
            title: "Task with missing body file",
            labels: ["Terra"],
            bodyFile: missingBodyPath,
          },
        ],
      }),
    );
    const error = await assertRejects(
      () => filePlan({ planPath, dryRun: false, approvalCheck: APPROVE_ALL }),
      Error,
      "cannot read body file",
    );
    assertStringIncludes(error.message, missingBodyPath);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// --- Appendix D — "Outcome wording in a criterion" (web-jam-tools#1775) ---

for (const c of OUTCOME_WORDING_CASES) {
  Deno.test(`Appendix D "Outcome wording in a criterion" (file-plan) ${c.name}`, async () => {
    const tmpDir = await Deno.makeTempDir();
    try {
      const designPath = c.unreadableDesign
        ? path.join(tmpDir, "missing-design.md")
        : path.join(tmpDir, "design.md");
      const planPath = path.join(tmpDir, "plan.json");
      if (!c.unreadableDesign) {
        await Deno.writeTextFile(designPath, OUTCOME_WORDING_DESIGN_DOC);
      }
      const noGhDeps: ExecDeps = {
        signing: { env: () => undefined },
        readFileText: (p) => Deno.readTextFile(p),
        runCmd: () => {
          throw new Error("Unexpected gh call");
        },
      };
      if (c.namesDesign === false) {
        // Without a named design (outcome check disabled), the body passes this check.
        const body =
          `## What this builds\n\nStandalone task\n\n## Acceptance criteria\n\n${c.criterion}\n`;
        validateIssueBodyCriteria(
          "Outcome wording standalone task",
          body,
          new Set(),
          { labels: c.labels, checkHeadingAndCommand: false, checkOutcomeWording: false },
        );
        return;
      }

      const body = `## What this builds\n\nTask\n\n## Acceptance criteria\n\n${c.criterion}\n`;
      const planPayload = c.isEpic
        ? {
          repo: "web-jam-tools",
          designDoc: designPath,
          epic: {
            title: "Outcome wording epic",
            tier: "Opus",
            escalationReason: "Container epic",
            body,
          },
          children: [
            {
              title: "Child task",
              tier: "Terra",
              body:
                "## What this builds\n\nChild\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes\n",
            },
          ],
        }
        : {
          repo: "web-jam-tools",
          designDoc: designPath,
          children: [
            {
              title: "Outcome wording task",
              labels: c.labels,
              body,
            },
          ],
        };
      await Deno.writeTextFile(planPath, JSON.stringify(planPayload));

      if (c.unreadableDesign) {
        const error = await assertRejects(
          () => filePlan({ planPath, dryRun: false, approvalCheck: APPROVE_ALL, deps: noGhDeps }),
          Error,
          "cannot be read",
        );
        assertStringIncludes(error.message, designPath);
      } else if (c.expectedOutcomeWord) {
        const error = await assertRejects(
          () => filePlan({ planPath, dryRun: false, approvalCheck: APPROVE_ALL, deps: noGhDeps }),
          Error,
          "Refused to file plan",
        );
        assertStringIncludes(error.message, 'issue "Outcome wording task"');
        assertStringIncludes(error.message, c.criterion);
        assertStringIncludes(error.message, c.expectedOutcomeWord);
      } else {
        const result = await filePlan({
          planPath,
          dryRun: true,
          approvalCheck: APPROVE_ALL,
          deps: noGhDeps,
        });
        assertEquals(result.children.length, 1);
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  });
}

// --- Appendix D — "The plan's steps after the merge" (web-jam-tools#1801, Cases 8–9) ---

const FIRST_PASSING_PLAN_MD = `# Gate 2 Plan

## Phase 2

| # | Proposed title | Epic / child of | Model tier | Priority | Repo | Design | Tests | Closes when |
|---|---|---|---|---|---|---|---|---|
| 1 | Coordinate skill updates | Epic | Opus | High | web-jam-tools | design.md | Unit tests cover validator rules | all children close |
| 2 | Update skill installers | row 1 | Hydrogen / Josh | High | web-jam-tools | design.md | Unit tests verify the installers | \`deno task install-skills\` and \`deno task install-codex\` pass |
| 3 | Add unit tests for plan check | row 1 | Terra | High | web-jam-tools | design.md | Unit tests cover every case | \`deno task test\` passes |

## Steps after the merge

- row 2: \`deno task install-skills\` and \`deno task install-codex\`
`;

Deno.test("Appendix D plan steps after merge case 8: row 2 holding install-skills in a criterion and no install-codex -> design:file-plan refuses before filing, naming row 2 and deno task install-codex", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const designPath = path.join(tmpDir, "design.md");
    const planDocPath = path.join(tmpDir, "plan.md");
    const planPath = path.join(tmpDir, "plan.json");
    await Deno.writeTextFile(designPath, STEP_AFTER_MERGE_DESIGN_DOC);
    await Deno.writeTextFile(planDocPath, FIRST_PASSING_PLAN_MD);
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        designDoc: designPath,
        planDoc: planDocPath,
        epic: {
          title: "Coordinate skill updates",
          type: "Epic",
          tier: "Opus",
          escalationReason: "Container epic",
          body:
            "## What this builds\n\nEpic\n\n## Acceptance criteria\n\n- [ ] Closes when all children close\n",
        },
        children: [
          {
            title: "Update skill installers",
            labels: ["Hydrogen", "Josh"],
            body:
              "## What this builds\n\nRun installers after merge.\n\n## Acceptance criteria\n\n- [ ] After the merge, `deno task install-skills` runs on the laptop.\n",
          },
          {
            title: "Add unit tests for plan check",
            tier: "Terra",
            body:
              "## What this builds\n\nTests\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes\n",
          },
        ],
      }),
    );

    const calls: string[][] = [];
    const noGhDeps: ExecDeps = {
      readFileText: (p) => Deno.readTextFile(p),
      runCmd: (cmd) => {
        calls.push(cmd);
        throw new Error("Unexpected gh call");
      },
    };
    const error = await assertRejects(
      () => filePlan({ planPath, dryRun: false, approvalCheck: APPROVE_ALL, deps: noGhDeps }),
      Error,
      "Refused to file plan",
    );
    assertStringIncludes(error.message, "row 2");
    assertStringIncludes(error.message, "deno task install-codex");
    assertEquals(calls, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("Appendix D plan steps after merge case 9: row 2 holding both commands in criteria -> design:file-plan files it", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const designPath = path.join(tmpDir, "design.md");
    const planDocPath = path.join(tmpDir, "plan.md");
    await Deno.writeTextFile(designPath, STEP_AFTER_MERGE_DESIGN_DOC);
    await Deno.writeTextFile(planDocPath, FIRST_PASSING_PLAN_MD);

    const { result } = await fileParentFixture({
      repo: "web-jam-tools",
      designDoc: designPath,
      planDoc: planDocPath,
      epic: {
        title: "Coordinate skill updates",
        type: "Epic",
        labels: ["Opus"],
        escalationReason: "Container epic",
        body:
          "## What this builds\n\nEpic\n\n## Acceptance criteria\n\n- [ ] Closes when all children close\n",
      },
      children: [
        {
          title: "Update skill installers",
          labels: ["Hydrogen", "Josh"],
          body:
            "## What this builds\n\nRun installers after merge.\n\n## Acceptance criteria\n\n- [ ] After the merge, `deno task install-skills` and `deno task install-codex` run on the laptop.\n",
        },
        {
          title: "Add unit tests for plan check",
          labels: ["Terra"],
          body:
            "## What this builds\n\nTests\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes\n",
        },
      ],
    });
    assertEquals(result.totalIssuesFiled, 3);
    assertEquals(result.epic?.title, "Coordinate skill updates");
    assertEquals(result.children.length, 2);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// --- Appendix D — "A plan built from several designs" (web-jam-tools#1683, Cases 15–18) ---

Deno.test("Appendix D multi-design Case 15: plan.json items pointing to two designs file when each points at a heading in its own design", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const docA = path.join(tmpDir, "a-design.md");
    const docB = path.join(tmpDir, "b-design.md");
    await Deno.writeTextFile(docA, "# Design A\n\n## Alpha Behavior\n\nDetails A.\n");
    await Deno.writeTextFile(docB, "# Design B\n\n## Beta Behavior\n\nDetails B.\n");

    const { result } = await fileParentFixture({
      repo: "web-jam-tools",
      designDoc: docA,
      epic: {
        title: "Coordinate multi-design work",
        type: "Epic",
        labels: ["Opus"],
        escalationReason: "Container epic",
        body:
          `## What this builds\n\nEpic (${docA})\n\n## Acceptance criteria\n\n- [ ] Closes when all children close\n`,
      },
      children: [
        {
          title: "Implement alpha behavior",
          designDoc: docA,
          labels: ["Terra"],
          body:
            `## What this builds\n\nSee ${docA}.\n\n## Acceptance criteria\n\n- [ ] Builds "Alpha Behavior"\n`,
        },
        {
          title: "Implement beta behavior",
          design_doc: docB,
          labels: ["Terra"],
          body:
            `## What this builds\n\nSee ${docB}.\n\n## Acceptance criteria\n\n- [ ] Builds "Beta Behavior"\n`,
        },
      ],
    });
    assertEquals(result.totalIssuesFiled, 3);
    assertEquals(result.children.length, 2);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("Appendix D multi-design Case 16: plan.json item missing designDoc with no top-level fallback is refused before filing, naming the item", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const docA = path.join(tmpDir, "a-design.md");
    await Deno.writeTextFile(docA, "# Design A\n\n## Alpha Behavior\n");
    const planPath = path.join(tmpDir, "plan.json");
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        repo: "web-jam-tools",
        children: [
          {
            title: "First item with designDoc",
            parent: 1,
            tier: "Terra",
            designDoc: docA,
            body:
              `## What this builds\n\nAlpha\n\n## Acceptance criteria\n\n- [ ] Builds "Alpha Behavior"\n`,
          },
          {
            title: "Second item missing designDoc",
            parent: 1,
            tier: "Terra",
            body:
              "## What this builds\n\nBeta\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes\n",
          },
        ],
      }),
    );

    const err = await assertRejects(
      () =>
        filePlan({
          planPath,
          dryRun: true,
          author: TEST_AUTHOR,
          approvalCheck: () => ({ ok: true }),
        }),
      Error,
      "the design document is not named",
    );
    assertStringIncludes(err.message, "Second item missing designDoc");
    assertStringIncludes(err.message, 'missing "designDoc" field in plan');
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("Appendix D multi-design Case 17: plan.json item with designDoc B whose body points at A or criterion names heading only in A is refused", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const docA = path.join(tmpDir, "a-design.md");
    const docB = path.join(tmpDir, "b-design.md");
    await Deno.writeTextFile(docA, "# Design A\n\n## Alpha Heading\n");
    await Deno.writeTextFile(docB, "# Design B\n\n## Beta Heading\n");

    // 17a: body names docA while item.designDoc is docB
    await assertRejects(
      () =>
        fileParentFixture({
          repo: "web-jam-tools",
          children: [
            {
              title: "Mismatched pointer item",
              parent: 1,
              designDoc: docB,
              labels: ["Terra"],
              body:
                `## What this builds\n\nDesign: ${docA}\n\n## Acceptance criteria\n\n- [ ] Builds "Beta Heading"\n`,
            },
          ],
        }),
      Error,
      "differs from its designDoc",
    );

    // 17b: criterion names heading only in docA while item.designDoc is docB
    const err17b = await assertRejects(
      () =>
        fileParentFixture({
          repo: "web-jam-tools",
          children: [
            {
              title: "Wrong heading item",
              parent: 1,
              designDoc: docB,
              labels: ["Terra"],
              body:
                `## What this builds\n\nDesign: ${docB}\n\n## Acceptance criteria\n\n- [ ] Builds "Alpha Heading"\n`,
            },
          ],
        }),
      Error,
      "Alpha Heading",
    );
    assertStringIncludes(err17b.message, "Wrong heading item");
    assertStringIncludes(err17b.message, "b-design.md");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("Appendix D multi-design Case 18: unreadable item.designDoc refuses before filing and names the unreadable path", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const docA = path.join(tmpDir, "a-design.md");
    const missingDoc = path.join(tmpDir, "does-not-exist-design.md");
    await Deno.writeTextFile(docA, "# Design A\n\n## Alpha Heading\n");

    const err = await assertRejects(
      () =>
        fileParentFixture({
          repo: "web-jam-tools",
          designDoc: docA,
          epic: {
            title: "Coordinate multi-design epic",
            type: "Epic",
            labels: ["Opus"],
            escalationReason: "Container epic",
            body:
              "## What this builds\n\nEpic\n\n## Acceptance criteria\n\n- [ ] Closes when children close\n",
          },
          children: [
            {
              title: "Item with unreadable design",
              designDoc: missingDoc,
              labels: ["Terra"],
              body:
                "## What this builds\n\nWork\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes\n",
            },
          ],
        }),
      Error,
      "cannot be read",
    );
    assertStringIncludes(err.message, "Item with unreadable design");
    assertStringIncludes(err.message, missingDoc);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// --- Appendix D "A plan built from several designs": refusals happen before the first issue is filed ---

async function refusedBeforeFiling(plan: Record<string, unknown>): Promise<{
  error: Error;
  createCalls: number;
}> {
  const planPath = await Deno.makeTempFile({ suffix: ".json" });
  let createCalls = 0;
  const deps: ExecDeps = {
    readFileText: (p) => Deno.readTextFile(p),
    runCmd(cmd) {
      if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "create") createCalls++;
      return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
    },
  };
  try {
    await Deno.writeTextFile(planPath, JSON.stringify(plan));
    const error = await assertRejects(() =>
      filePlan({ planPath, deps, approvalCheck: APPROVE_ALL })
    );
    return { error: error as Error, createCalls };
  } finally {
    await Deno.remove(planPath);
  }
}

async function multiDesignFiles(): Promise<{ root: string; docA: string; docB: string }> {
  const root = await Deno.makeTempDir();
  const docA = path.join(root, "a-design.md");
  const docB = path.join(root, "b-design.md");
  await Deno.writeTextFile(docA, "# A\n\n### The command\n\n## Both surfaces\n");
  await Deno.writeTextFile(docB, "# B\n\n### The private-folder guard\n\n## Both surfaces\n");
  return { root, docA, docB };
}

const criteria = (c: string) =>
  `## What this builds\n\nWork.\n\n## Acceptance criteria\n\n- [ ] ${c}\n`;

Deno.test("Appendix D several designs, file-plan row 16: an item on b-design.md whose criterion names a heading only a-design.md has is refused before any issue is filed, naming the item, the line and the path", async () => {
  const { root, docA, docB } = await multiDesignFiles();
  try {
    const { error, createCalls } = await refusedBeforeFiling({
      repo: "web-jam-tools",
      designDoc: docA,
      children: [{
        title: "Guard the private folder",
        parent: 1,
        tier: "Terra",
        designDoc: docB,
        body: `${criteria('builds "The command" as written').replace("Work.", `See ${docB}.`)}`,
      }],
    });
    assertEquals(createCalls, 0);
    assertStringIncludes(error.message, "Guard the private folder");
    assertStringIncludes(error.message, "criterion line");
    assertStringIncludes(error.message, "The command");
    assertStringIncludes(error.message, docB);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Appendix D several designs, file-plan row 17: an item with no designDoc is read against the plan's designDoc", async () => {
  const { root, docA } = await multiDesignFiles();
  try {
    const { result } = await fileParentFixture({
      repo: "web-jam-tools",
      designDoc: docA,
      epic: {
        title: "Coordinate the shared work",
        type: "Epic",
        labels: ["Opus"],
        escalationReason: "Container epic",
        body:
          `## What this builds\n\nEpic (${docA})\n\n## Acceptance criteria\n\n- [ ] All children close\n`,
      },
      children: [{
        title: "Add the command parser",
        labels: ["Terra"],
        body: criteria('builds "The command" as written').replace("Work.", `See ${docA}.`),
      }],
    });
    assertEquals(result.totalIssuesFiled, 2);

    // The same item read against the top-level design: a heading only b-design.md has is refused.
    const { error, createCalls } = await refusedBeforeFiling({
      repo: "web-jam-tools",
      designDoc: docA,
      children: [{
        title: "Add the command parser",
        parent: 1,
        tier: "Terra",
        body: criteria('builds "The private-folder guard" as written').replace(
          "Work.",
          `See ${docA}.`,
        ),
      }],
    });
    assertEquals(createCalls, 0);
    assertStringIncludes(error.message, "The private-folder guard");
    assertStringIncludes(error.message, "a-design.md");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Appendix D several designs, file-plan row 18: an item on b-design.md whose body names a-design.md is refused before any issue is filed, naming the item and both paths", async () => {
  const { root, docA, docB } = await multiDesignFiles();
  try {
    const { error, createCalls } = await refusedBeforeFiling({
      repo: "web-jam-tools",
      designDoc: docA,
      children: [{
        title: "Guard the private folder",
        parent: 1,
        tier: "Terra",
        designDoc: docB,
        body: criteria('builds "The private-folder guard" as written').replace(
          "Work.",
          `See ${docA}.`,
        ),
      }],
    });
    assertEquals(createCalls, 0);
    assertStringIncludes(error.message, "Guard the private folder");
    assertStringIncludes(error.message, docA);
    assertStringIncludes(error.message, docB);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Appendix D several designs, file-plan row 19: an item whose designDoc cannot be read is refused before any issue is filed, naming the path", async () => {
  const { root, docA } = await multiDesignFiles();
  const gone = path.join(root, "gone-design.md");
  try {
    const { error, createCalls } = await refusedBeforeFiling({
      repo: "web-jam-tools",
      designDoc: docA,
      children: [{
        title: "Guard the private folder",
        parent: 1,
        tier: "Terra",
        designDoc: gone,
        body: criteria("`deno task test` passes"),
      }],
    });
    assertEquals(createCalls, 0);
    assertStringIncludes(error.message, "cannot be read");
    assertStringIncludes(error.message, gone);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
