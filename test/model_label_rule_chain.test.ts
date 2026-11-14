import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type ExecDeps, type IssueData } from "../src/create-issue/lib.ts";
import { filePlan, type PlanIssueItem } from "../src/design-issue/file_plan.ts";
import { approveGate1Record, openGate1Record } from "../src/design-issue/gate1_record.ts";
import { runLintPlanCli } from "../src/design-issue/lint_plan.ts";
import { TEST_AUTHOR, withPassingProbe } from "./authored_by_test_helpers.ts";
import { ESCALATION_REASON } from "./support/model_label_cases.ts";

/** Real filing code, with every GitHub command answered locally and unexpected calls refused. */
function githubFixture() {
  const calls: string[][] = [];
  const creates: string[][] = [];
  let issue: IssueData & { id: number };
  const deps: ExecDeps = withPassingProbe({
    readFileText: (file: string) => Deno.readTextFile(file),
    runCmd(cmd: string[]) {
      calls.push(cmd);
      const reply = (data: unknown) =>
        Promise.resolve({ code: 0, stdout: JSON.stringify(data), stderr: "" });
      if (cmd[0] !== "gh") throw new Error(`Unexpected executable ${cmd[0]}`);
      if (cmd[1] === "issue" && cmd[2] === "create") {
        creates.push(cmd);
        issue = {
          number: 901,
          id: 9010,
          title: cmd[cmd.indexOf("--title") + 1],
          body: cmd[cmd.indexOf("--body") + 1],
          labels: cmd.flatMap((arg, i) => arg === "--label" ? [{ name: cmd[i + 1] }] : []),
          type: { name: "Task" },
          parent: { number: 900, repository: { name: "web-jam-tools" } },
        };
        return Promise.resolve({
          code: 0,
          stdout: "https://github.com/WebJamApps/web-jam-tools/issues/901",
          stderr: "",
        });
      }
      if (cmd[1] === "api" && cmd[2].includes("issues?state=open")) return reply([]);
      if (cmd[1] === "api" && cmd[2] === "repos/WebJamApps/web-jam-tools/issues/901") {
        return reply(issue);
      }
      if (cmd[1] === "api" && cmd[2] === "graphql") {
        const query = cmd.find((arg) => arg.startsWith("query=")) ?? "";
        if (query.includes("ValidateParent") || query.includes("GetParentIssue")) {
          return reply({ data: { repository: { issue: { id: "PARENT" } } } });
        }
        if (query.includes("GetChildAndTypes")) {
          return reply({
            data: {
              repository: {
                issue: { id: "CHILD" },
                issueTypes: { nodes: [{ id: "TASK", name: "Task" }] },
              },
            },
          });
        }
        if (query.includes("GetIssueNodeIds")) {
          return reply({
            data: { parent: { issue: { id: "PARENT" } }, child: { issue: { id: "CHILD" } } },
          });
        }
        if (query.includes("SetIssueType") || query.includes("AddSubIssue")) {
          return reply({ data: {} });
        }
      }
      throw new Error(`Unexpected GitHub command ${JSON.stringify(cmd)}`);
    },
  });
  return { deps, calls, creates };
}

const ALLOWED_NO_REASON_CELLS: Array<[string, string[]]> = [
  ["Sol", ["Sol"]],
  ["Sonnet", ["Sonnet"]],
  ["Argon", ["Argon"]],
  ["Hydrogen", ["Hydrogen"]],
  ["Terra / Sonnet", ["Terra", "Sonnet"]],
  ["Sonnet/Terra", ["Sonnet", "Terra"]],
  ["Terra  /  Sonnet", ["Terra", "Sonnet"]],
  ["**Terra / Sonnet**", ["Terra", "Sonnet"]],
  ["Sol / Argon", ["Sol", "Argon"]],
  ["Sol / Hydrogen", ["Sol", "Hydrogen"]],
  ["Argon / Hydrogen", ["Argon", "Hydrogen"]],
  ["Sol / Argon / Hydrogen", ["Sol", "Argon", "Hydrogen"]],
  ["Terra", ["Terra"]],
  ["Josh", ["Josh"]],
];

for (const [cell, expectedLabels] of ALLOWED_NO_REASON_CELLS) {
  Deno.test(`model-label chain: allowed no-reason cell ${JSON.stringify(cell)} passes lint-plan, dry-run and filing`, async () => {
    const directory = await Deno.makeTempDir();
    const { deps, calls, creates } = githubFixture();
    const planPath = `${directory}/filing.json`;
    const designPath = `${directory}/design.md`;
    const tablePath = `${directory}/plan.md`;
    try {
      const content = "# Fixture design\n\n## Load-bearing premises\n\nNone.\n";
      await Deno.writeTextFile(designPath, content);
      await openGate1Record(designPath, content, { stateDir: directory });
      await approveGate1Record(designPath, "fixture approval", { stateDir: directory });
      const closesWhen = cell === "Josh" ? "Josh confirms" : "`deno task test` passes";
      const testsCell = cell === "Josh" ? "none — manual step" : "Unit tests cover every case";
      const rows = cell === "Josh"
        ? [
          '| 1 | Author doc for manual check | web-jam-tools#900 "Fixture epic" | Terra | High | web-jam-tools | Unit tests cover doc | `deno task test` passes |',
          `| 2 | Manual verification: Share the model-label reader | web-jam-tools#900 "Fixture epic" | ${cell} | High | web-jam-tools | ${testsCell} | ${closesWhen} |`,
        ]
        : [
          `| 1 | Share the model-label reader | web-jam-tools#900 "Fixture epic" | ${cell} | High | web-jam-tools | ${testsCell} | ${closesWhen} |`,
        ];
      await Deno.writeTextFile(
        tablePath,
        [
          "# Plan",
          "",
          "| # | Proposed title | Epic / child of | Model tier | Priority | Repo | Tests | Closes when |",
          "|---|---|---|---|---|---|---|---|",
          ...rows,
        ].join("\n"),
      );
      const logs: string[] = [];
      const exitCode = await runLintPlanCli([tablePath, "--design-doc", designPath, "--no-open"], {
        stateDir: directory,
        runGh: (args) => deps.runCmd(["gh", ...args]),
        log: (line) => logs.push(line),
        errorLog: (line) => logs.push(line),
      });
      assertEquals(exitCode, 0, logs.join("\n"));
      const child: PlanIssueItem = {
        title: "Share the model-label reader",
        parent: 900,
        tier: cell,
        body:
          "## What this builds\n\nBuild the shared model-label reader.\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes",
      };
      await Deno.writeTextFile(
        planPath,
        JSON.stringify({ designDoc: designPath, children: [child] }),
      );
      const options = { planPath, deps, author: TEST_AUTHOR, approvalCheck: () => ({ ok: true }) };
      const callsBeforeDryRun = calls.length;
      const dry = await filePlan({ ...options, dryRun: true });
      assertEquals(dry.totalIssuesFiled, 0);
      assertEquals(calls.length, callsBeforeDryRun);
      const filed = await filePlan(options);
      assertEquals(filed.totalIssuesFiled, 1);
      assertEquals(creates.length, 1);
      const command = creates[0];
      assertEquals(
        command.flatMap((arg, i) => arg === "--label" ? [command[i + 1]] : []),
        expectedLabels,
      );
      if (cell.includes("/")) {
        assertEquals(command.includes(cell), false);
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
}

Deno.test("model-label chain: Opus / Fable top lane preserves both labels and escalation reason", async () => {
  const directory = await Deno.makeTempDir();
  const { deps, calls, creates } = githubFixture();
  const planPath = `${directory}/filing.json`;
  const designPath = `${directory}/design.md`;
  const tablePath = `${directory}/plan.md`;
  try {
    const content = "# Fixture design\n\n## Load-bearing premises\n\nNone.\n";
    await Deno.writeTextFile(designPath, content);
    await openGate1Record(designPath, content, { stateDir: directory });
    await approveGate1Record(designPath, "fixture approval", { stateDir: directory });
    await Deno.writeTextFile(
      tablePath,
      [
        "# Plan",
        "",
        "| # | Proposed title | Epic / child of | Model tier | Priority | Repo | Tests | Closes when |",
        "|---|---|---|---|---|---|---|---|",
        '| 1 | Share the model-label reader | web-jam-tools#900 "Fixture epic" | Opus / Fable | High | web-jam-tools | Unit tests cover every literal case | `deno task test` passes |',
      ].join("\n"),
    );
    const logs: string[] = [];
    const exitCode = await runLintPlanCli([tablePath, "--design-doc", designPath, "--no-open"], {
      stateDir: directory,
      runGh: (args) => deps.runCmd(["gh", ...args]),
      log: (line) => logs.push(line),
      errorLog: (line) => logs.push(line),
    });
    assertEquals(exitCode, 0, logs.join("\n"));
    const child: PlanIssueItem = {
      title: "Share the model-label reader",
      parent: 900,
      tier: "Opus / Fable",
      labels: ["Needs Design"],
      escalationReason: ESCALATION_REASON,
      body:
        "## What this builds\n\nBuild the shared model-label reader.\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes",
    };
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({ designDoc: designPath, children: [child] }),
    );
    const options = { planPath, deps, author: TEST_AUTHOR, approvalCheck: () => ({ ok: true }) };
    const callsBeforeDryRun = calls.length;
    const dry = await filePlan({ ...options, dryRun: true });
    assertEquals(dry.totalIssuesFiled, 0);
    assertEquals(calls.length, callsBeforeDryRun);
    const filed = await filePlan(options);
    assertEquals(filed.totalIssuesFiled, 1);
    assertEquals(creates.length, 1);
    const command = creates[0];
    assertEquals(command.flatMap((arg, i) => arg === "--label" ? [command[i + 1]] : []), [
      "Opus",
      "Fable",
      "Needs Design",
    ]);
    assertStringIncludes(command[command.indexOf("--body") + 1], ESCALATION_REASON);
    assertEquals(command.includes("Opus / Fable"), false);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('model-label chain: row merging ["Argon"] with Sol / Hydrogen passes as the permitted triple', async () => {
  const directory = await Deno.makeTempDir();
  const { deps, creates } = githubFixture();
  const planPath = `${directory}/filing.json`;
  const designPath = `${directory}/design.md`;
  try {
    await Deno.writeTextFile(designPath, "# Fixture design\n");
    const child: PlanIssueItem = {
      title: "Shared triple child",
      parent: 900,
      tier: "Sol / Hydrogen",
      labels: ["Argon"],
      body:
        "## What this builds\n\nBuild the shared model-label reader.\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes",
    };
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({ designDoc: designPath, children: [child] }),
    );
    const options = { planPath, deps, author: TEST_AUTHOR, approvalCheck: () => ({ ok: true }) };
    const dry = await filePlan({ ...options, dryRun: true });
    assertEquals(dry.totalIssuesFiled, 0);
    const filed = await filePlan(options);
    assertEquals(filed.totalIssuesFiled, 1);
    assertEquals(creates.length, 1);
    const command = creates[0];
    assertEquals(command.flatMap((arg, i) => arg === "--label" ? [command[i + 1]] : []), [
      "Sol",
      "Hydrogen",
      "Argon",
    ]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

for (const dryRun of [true, false]) {
  for (const invalidEpic of [false, true]) {
    Deno.test(`model-label chain: missing reason on Opus refuses ${invalidEpic ? "epic" : "child"} before any create (dryRun=${dryRun})`, async () => {
      const directory = await Deno.makeTempDir();
      const planPath = `${directory}/filing.json`;
      const { deps, calls, creates } = githubFixture();
      try {
        await Deno.writeTextFile(
          planPath,
          JSON.stringify({
            epic: { title: "Fixture epic", tier: invalidEpic ? "Opus" : "Sol" },
            children: [
              {
                title: "Valid child first",
                tier: "Terra / Sonnet",
                body:
                  "## What this builds\n\nFirst.\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes",
              },
              {
                title: "Top child",
                tier: "Opus",
                body:
                  "## What this builds\n\nSecond.\n\n## Acceptance criteria\n\n- [ ] `deno task test` passes",
              },
            ],
          }),
        );
        await assertRejects(
          () =>
            filePlan({
              planPath,
              deps,
              dryRun,
              author: TEST_AUTHOR,
              approvalCheck: () => ({ ok: true }),
            }),
          Error,
          invalidEpic
            ? 'Epic "Fixture epic": Opus needs an escalation reason'
            : 'issue "Top child": Opus needs an escalation reason',
        );
        assertEquals(creates, []);
        assertEquals(calls, []);
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });
  }
}

Deno.test("model-label chain: extra row labels cannot smuggle in a forbidden combination", async () => {
  const directory = await Deno.makeTempDir();
  const planPath = `${directory}/filing.json`;
  const { deps, calls } = githubFixture();
  try {
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        children: [{
          title: "Invalid merged labels",
          tier: "Sol",
          labels: ["Opus"],
          escalationReason: "x",
        }],
      }),
    );
    await assertRejects(
      () => filePlan({ planPath, deps, author: TEST_AUTHOR, approvalCheck: () => ({ ok: true }) }),
      Error,
      "forbidden model-label combination",
    );
    assertEquals(calls, []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("model-label chain: failed vocabulary read refuses before the first create", async () => {
  const directory = await Deno.makeTempDir();
  const planPath = `${directory}/filing.json`;
  const { deps, calls, creates } = githubFixture();
  const origReadTextFileSync = Deno.readTextFileSync;
  try {
    await Deno.writeTextFile(
      planPath,
      JSON.stringify({
        children: [{
          title: "Valid child",
          tier: "Terra",
        }],
      }),
    );
    Deno.readTextFileSync = (path: string | URL) => {
      if (String(path).endsWith("model-labels.json")) {
        throw new Deno.errors.NotFound("missing model-labels.json");
      }
      return origReadTextFileSync(path);
    };
    await assertRejects(
      () => filePlan({ planPath, deps, author: TEST_AUTHOR, approvalCheck: () => ({ ok: true }) }),
      Error,
      "Cannot read model labels from",
    );
    assertEquals(creates, []);
    assertEquals(calls, []);
  } finally {
    Deno.readTextFileSync = origReadTextFileSync;
    await Deno.remove(directory, { recursive: true });
  }
});
