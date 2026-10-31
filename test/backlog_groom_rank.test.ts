import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { formatReport, runRankCli } from "../src/backlog-groom/cli.ts";
import { readRepository } from "../src/backlog-groom/github.ts";
import {
  type IssueFacts,
  type Judgment,
  type Priority,
  rankIssues,
  targetShares,
} from "../src/backlog-groom/rank.ts";
import { type CommandRunner } from "../src/shared/repos.ts";

function issue(number: number, changes: Partial<IssueFacts> = {}): IssueFacts {
  return {
    number,
    title: `Issue ${number}`,
    updatedAt: "2026-10-09T00:00:00Z",
    milestone: null,
    priority: "Medium",
    epic: false,
    labels: [],
    openWaiting: 0,
    blockedByOpen: false,
    children: [],
    ...changes,
  };
}

function issues(count: number): IssueFacts[] {
  return Array.from({ length: count }, (_, index) => issue(index + 1));
}

function judgments(
  rows: IssueFacts[],
  changes: Record<string, Partial<Judgment>> = {},
): Record<string, Judgment> {
  return Object.fromEntries(rows.map((row) => [
    String(row.number),
    {
      liveBroken: false,
      costlyDefect: false,
      reason: "Planned work",
      levelFromTests: "Medium",
      ...changes[String(row.number)],
    },
  ]));
}

function rank(rows: IssueFacts[], changes: Record<string, Partial<Judgment>> = {}) {
  return rankIssues("web-jam-tools", rows, judgments(rows, changes));
}

Deno.test("19 non-Epics use caller level tests without shares or focus-based promotion", () => {
  const rows = issues(19);
  const answers = judgments(rows, {
    1: { liveBroken: true, levelFromTests: "Urgent", reason: "Live data loss" },
    2: { costlyDefect: true, levelFromTests: "High" },
    3: { levelFromTests: "Low" },
  });
  const result = rankIssues("web-jam-tools", rows, answers, ["focus"], "focus");
  assertEquals(result.shares, null);
  assertEquals(result.ranking.slice(0, 3).map((row) => row.number), [1, 2, 3]);
  assertEquals(result.ranking.find((row) => row.number === 3)?.targetPriority, "Low");
  assertEquals(result.moves.map((move) => [move.number, move.kind, move.to]), [
    [1, "up", "Urgent"],
    [2, "up", "High"],
    [3, "down", "Low"],
  ]);
});

Deno.test("20 issues have shares of 2, 5, 8 and 5 and exactly those ranked levels", () => {
  const result = rank(issues(20));
  assertEquals(result.shares, { Urgent: 2, High: 5, Medium: 8, Low: 5 });
  const levels = result.ranking.map((row) => row.targetPriority);
  assertEquals(levels, [
    ...Array(2).fill("Urgent"),
    ...Array(5).fill("High"),
    ...Array(8).fill("Medium"),
    ...Array(5).fill("Low"),
  ]);
});

Deno.test("177 issues have independently rounded shares 18, 44, 71 and 44", () => {
  assertEquals(rank(issues(177)).shares, { Urgent: 18, High: 44, Medium: 71, Low: 44 });
  assertEquals(targetShares(21), { Urgent: 2, High: 5, Medium: 8, Low: 5 });
  assertEquals(targetShares(22), { Urgent: 2, High: 6, Medium: 9, Low: 6 });
  assertEquals(rank(issues(21)).ranking.at(-1)?.targetPriority, "Low");
  assertEquals(targetShares(0), null);
  assertThrows(() => targetShares(-1));
  assertThrows(() => targetShares(1.5));
});

Deno.test("live failure outranks focus, which outranks dependency counts and costly defects", () => {
  const rows = issues(20);
  rows[0].openWaiting = 15;
  rows[5].milestone = "gig-outreach";
  rows[6].milestone = "gig-outreach";
  rows[7].milestone = "gig-outreach";
  const result = rankIssues(
    "web-jam-tools",
    rows,
    judgments(rows, {
      20: { liveBroken: true, reason: "Live failure" },
      2: { costlyDefect: true },
    }),
    ["gig-outreach"],
    "gig-outreach",
  );
  assertEquals(result.ranking.slice(0, 6).map((row) => row.number), [20, 6, 7, 8, 1, 2]);
  assertEquals(result.ranking[0].targetPriority, "Urgent");
});

Deno.test("five open dependents outrank two; a blocked issue's waiting count is unused", () => {
  const rows = [
    issue(1, { openWaiting: 2 }),
    issue(2, { openWaiting: 5 }),
    issue(3, { openWaiting: 30, blockedByOpen: true }),
  ];
  const result = rank(rows);
  assertEquals(result.ranking.map((row) => row.number), [2, 1, 3]);
  assertEquals(result.ranking[2].waiting, 0);
});

Deno.test("costly defect outranks recency; newer work wins equal-fact ties deterministically", () => {
  const rows = [
    issue(3, { updatedAt: "2026-08-01" }),
    issue(2, { updatedAt: "2026-10-09" }),
    issue(1, { updatedAt: "2026-08-01" }),
  ];
  assertEquals(rank(rows).ranking.map((row) => row.number), [2, 1, 3]);
  assertEquals(rank(rows, { 3: { costlyDefect: true } }).ranking[0].number, 3);
});

Deno.test("missing Priority is proposed from rank; Medium in Urgent share moves up", () => {
  const rows = issues(20);
  rows[1].priority = null;
  const result = rank(rows);
  assertEquals(result.moves.find((move) => move.number === 1)?.to, "Urgent");
  assertEquals(result.moves.find((move) => move.number === 2)?.kind, "missing");
  assertEquals(result.moves.find((move) => move.number === 2)?.to, "Urgent");
  assertEquals(result.counts.Medium, 19);
  assert(result.moves.every((move) => move.reason.includes("Planned work")));
});

function highOverflow(count: number) {
  const rows = issues(20);
  // Concentrate High at the bottom to exercise selection of the lowest current High issues.
  for (const row of rows.slice(-count)) row.priority = "High";
  return rank(rows);
}

Deno.test("High holds three above share: no High demotion", () => {
  assertEquals(
    highOverflow(8).moves.filter((move) => move.from === "High" && move.kind === "down"),
    [],
  );
});

Deno.test("High holds four above share: four lowest High move down one level", () => {
  const moves = highOverflow(9).moves.filter((move) =>
    move.from === "High" && move.kind === "down"
  );
  assertEquals(moves.map((move) => [move.number, move.to]), [
    [20, "Medium"],
    [19, "Medium"],
    [18, "Medium"],
    [17, "Medium"],
  ]);
});

Deno.test("overflow proposes the excess count even when some candidates rank inside their band", () => {
  const rows = issues(20);
  for (const row of rows.slice(0, 9)) row.priority = "High";
  const moves = rank(rows).moves.filter((move) => move.kind === "down" && move.from === "High");
  assertEquals(moves.map((move) => move.number), [9, 8, 7, 6]);
});

Deno.test("live broken issues are never demoted, even beyond the Urgent target share", () => {
  const rows = issues(20);
  for (const row of rows) row.priority = "Urgent";
  const changes = Object.fromEntries(
    rows.slice(10).map((row) => [row.number, { liveBroken: true }]),
  );
  const result = rank(rows, changes);
  assert(result.moves.filter((move) => move.kind === "down").every((move) => move.number <= 10));
  assertEquals(
    result.ranking.slice(0, 10).map((row) => row.targetPriority),
    Array(10).fill("Urgent"),
  );
  assertEquals(new Set(result.moves.map((move) => move.number)).size, result.moves.length);
});

Deno.test("overflow never demotes an issue proposed for promotion or cascades between counts", () => {
  const rows = issues(20);
  for (const row of rows) row.priority = "High";
  const result = rank(rows);
  assertEquals(result.moves.slice(0, 2).map((move) => move.kind), ["up", "up"]);
  assertEquals(result.moves.filter((move) => move.kind === "down").length, 15);
  assertEquals(result.counts, { Urgent: 0, High: 20, Medium: 0, Low: 0 });
});

Deno.test("overfull Low cannot move below Low", () => {
  const rows = issues(20).map((row) => ({ ...row, priority: "Low" as const }));
  assertEquals(rank(rows).moves.filter((move) => move.kind === "down"), []);
});

Deno.test("focus is optional; a nonexistent focus is skipped with a notice", () => {
  const rows = [issue(1), issue(2, { milestone: "gig-outreach" })];
  assertEquals(rank(rows).focus, null);
  const result = rankIssues("web-jam-tools", rows, judgments(rows), [], "gig-outreach");
  assertEquals(result.ranking[0].number, 1);
  assertStringIncludes(result.notices[0], 'Milestone "gig-outreach" does not exist');
  const focused = rankIssues(
    "web-jam-tools",
    rows,
    judgments(rows),
    ["gig-outreach"],
    "gig-outreach",
  );
  assertEquals(focused.ranking[0].number, 2);
  assertEquals(focused.notices, []);
});

Deno.test("Epic inherits highest native open child Priority and is excluded from shares", () => {
  const rows = issues(20);
  rows.push(issue(21, {
    epic: true,
    priority: "Low",
    children: [
      { number: 1, priority: "Urgent" },
      { number: 2, priority: "Medium" },
      { number: 3, priority: "Low" },
    ],
  }));
  const result = rank(rows);
  assertEquals(result.count, 20);
  assertEquals(result.shares?.Urgent, 2);
  assertEquals(result.ranking.length, 20);
  assertEquals(result.moves.find((move) => move.number === 21)?.to, "Urgent");
  assertEquals(result.moves.find((move) => move.number === 21)?.kind, "epic");
});

Deno.test("Epic with no open child carrying a level takes Priority from levelFromTests", () => {
  for (const children of [[], [{ number: 2, priority: null }]]) {
    const rows = [issue(1, { epic: true, priority: null, children })];
    const answers = judgments(rows, { 1: { levelFromTests: "High" } });
    const result = rankIssues("web-jam-tools", rows, answers);
    assertEquals(result.moves, [{
      number: 1,
      title: "Issue 1",
      kind: "epic",
      from: null,
      to: "High",
      reason: "Caller level tests give High; Planned work",
    }]);
  }
  // When the Epic's priority already matches levelFromTests, no move is proposed.
  for (const children of [[], [{ number: 2, priority: null }]]) {
    const result = rank([issue(1, { epic: true, priority: "Medium", children })]);
    assertEquals(result.moves, []);
  }
  // When an open child carries a Priority, the Epic inherits the child's level rather than levelFromTests.
  const withChild = rank([
    issue(1, {
      epic: true,
      priority: "Low",
      children: [{ number: 2, priority: "Urgent" }],
    }),
  ], { 1: { levelFromTests: "Low" } });
  assertEquals(withChild.moves.find((m) => m.number === 1)?.to, "Urgent");

  // An Epic in a repository above the 20-issue floor still requires levelFromTests if it has no child with Priority.
  const repoRows = issues(20);
  repoRows.push(issue(21, { epic: true, priority: null, children: [] }));
  const repoAnswers = judgments(repoRows, { 21: { levelFromTests: "High" } });
  const repoResult = rankIssues("web-jam-tools", repoRows, repoAnswers);
  assertEquals(repoResult.moves.find((m) => m.number === 21)?.to, "High");
  assertEquals(repoResult.moves.find((m) => m.number === 21)?.kind, "epic");
  delete repoAnswers["21"].levelFromTests;
  assertThrows(() => rankIssues("web-jam-tools", repoRows, repoAnswers), Error, "levelFromTests");
});

Deno.test("legacy parked labels do not exclude issues from counts, ranking or judgments", () => {
  const rows = issues(20);
  rows[19].labels = ["parked"];
  const answers = judgments(rows);
  const result = rankIssues("web-jam-tools", rows, answers);
  assertEquals(result.count, 20);
  assert(result.shares !== null);
  assert(result.ranking.some((row) => row.number === 20));
});

Deno.test("ranking does not mutate caller facts or judgments", () => {
  const rows = [issue(2), issue(1)];
  const answers = judgments(rows);
  const before = JSON.stringify({ rows, answers });
  rankIssues("web-jam-tools", rows, answers);
  assertEquals(JSON.stringify({ rows, answers }), before);
});

Deno.test("missing, non-boolean or malformed caller judgments refuse rather than guessing", () => {
  const rows = [issue(1)];
  for (
    const answer of [
      {},
      { 1: { liveBroken: "false", costlyDefect: false, reason: "Planned" } },
      { 1: { liveBroken: false, costlyDefect: null, reason: "Planned" } },
      { 1: { liveBroken: false, costlyDefect: false, reason: "" } },
      { 1: { liveBroken: false, costlyDefect: false, reason: "Two\nlines" } },
    ]
  ) {
    assertThrows(() => rankIssues("web-jam-tools", rows, answer as Record<string, Judgment>));
  }
  const answers = judgments(rows);
  delete answers["1"].levelFromTests;
  assertThrows(() => rankIssues("web-jam-tools", rows, answers), Error, "levelFromTests");
  assertThrows(() => rank(rows, { 1: { liveBroken: true } }), Error, "must have an Urgent");
});

Deno.test("malformed issue facts and duplicate IDs refuse", () => {
  for (
    const changes of [
      { updatedAt: "not a date" },
      { number: -1 },
      { openWaiting: -2 },
      { openWaiting: 0.5 },
      { priority: "Other" as Priority },
    ]
  ) assertThrows(() => rank([issue(1, changes)]));
  assertThrows(() => rank([issue(1), issue(1)]));
});

function rawIssue(number: number, changes: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    updated_at: "2026-10-09T00:00:00Z",
    labels: [],
    milestone: null,
    type: { name: "Task" },
    issue_field_values: [{
      issue_field_name: "Priority",
      single_select_option: { name: "Medium" },
    }],
    ...changes,
  };
}

function apiRunner(data: Record<string, unknown>, calls: string[][] = []): CommandRunner {
  return (args) => {
    calls.push(args);
    assertEquals(args[0], "api");
    assertEquals(args.slice(2), ["--method", "GET", "--paginate", "--slurp"]);
    assert(args[1] in data, `Unexpected API read ${args[1]}`);
    return Promise.resolve({ code: 0, stdout: JSON.stringify([data[args[1]]]), stderr: "" });
  };
}

const root = "repos/WebJamApps/web-jam-tools";
function apiData(rows: ReturnType<typeof rawIssue>[] = [rawIssue(1)]) {
  const data: Record<string, unknown> = {
    [`${root}/issues?state=open&per_page=100`]: rows,
    [`${root}/milestones?state=all&per_page=100`]: [{ title: "gig-outreach" }],
  };
  for (const row of rows) {
    data[`${root}/issues/${row.number}/dependencies/blocked_by?per_page=100`] = [];
    data[`${root}/issues/${row.number}/dependencies/blocking?per_page=100`] = [];
    data[`${root}/issues/${row.number}/sub_issues?per_page=100`] = [];
  }
  return data;
}

Deno.test("GitHub adapter uses paginated native fields and counts open dependents including legacy parked labels", async () => {
  const data = apiData([
    rawIssue(1, { milestone: { title: "gig-outreach" } }),
    rawIssue(2, { labels: [{ name: "parked" }] }),
    rawIssue(3, { pull_request: {} }),
    rawIssue(4, { state: "closed" }),
  ]);
  data[`${root}/issues/1/dependencies/blocking?per_page=100`] = [
    rawIssue(10),
    rawIssue(11, { state: "closed" }),
    rawIssue(12, { labels: ["parked"] }),
    rawIssue(13),
  ];
  data[`${root}/issues/1/dependencies/blocked_by?per_page=100`] = [
    rawIssue(20, { state: "closed" }),
    rawIssue(21),
  ];
  const calls: string[][] = [];
  const result = await readRepository("web-jam-tools", apiRunner(data, calls));
  assertEquals(result.issues.length, 2);
  assertEquals(result.issues[0].openWaiting, 3);
  assertEquals(result.issues[0].blockedByOpen, true);
  assertEquals(result.issues[0].priority, "Medium");
  assertEquals(result.issues[0].milestone, "gig-outreach");
  assertEquals(result.milestones, ["gig-outreach"]);
  assertEquals(calls.length, 6);
});

Deno.test("GitHub adapter uses native open children including legacy parked labels for Epics", async () => {
  const data = apiData([rawIssue(1, { type: { name: "Epic" }, issue_field_values: [] })]);
  data[`${root}/issues/1/sub_issues?per_page=100`] = [
    rawIssue(2),
    rawIssue(3, { state: "closed" }),
    rawIssue(4, { labels: ["parked"] }),
    rawIssue(5, { issue_field_values: [] }),
  ];
  const result = await readRepository("web-jam-tools", apiRunner(data));
  assertEquals(result.issues[0].children, [
    { number: 2, priority: "Medium" },
    { number: 4, priority: "Medium" },
    { number: 5, priority: null },
  ]);
  assertEquals(result.issues[0].priority, null);
});

Deno.test("GitHub adapter distinguishes explicit unset Priority from an unreadable field", async () => {
  const data = apiData([rawIssue(1, {
    issue_field_values: [{
      issue_field_name: "Priority",
      value: null,
      single_select_option: null,
    }],
  })]);
  assertEquals((await readRepository("web-jam-tools", apiRunner(data))).issues[0].priority, null);
  await assertRejects(
    () =>
      readRepository(
        "web-jam-tools",
        apiRunner(apiData([rawIssue(1, {
          issue_field_values: [{ issue_field_name: "Priority", value: 42 }],
        })])),
      ),
    Error,
    "could not be read",
  );
  await assertRejects(
    () =>
      readRepository(
        "web-jam-tools",
        apiRunner(apiData([rawIssue(1, {
          issue_field_values: undefined,
        })])),
      ),
    Error,
    "Expected a GitHub array",
  );
});

Deno.test("GitHub read failures, malformed responses and unknown native values fail closed", async () => {
  const failed: CommandRunner = () => Promise.resolve({ code: 1, stdout: "", stderr: "Denied" });
  const malformed: CommandRunner = () => Promise.resolve({ code: 0, stdout: "[", stderr: "" });
  await assertRejects(() => readRepository("web-jam-tools", failed), Error, "GitHub read failed");
  await assertRejects(
    () => readRepository("web-jam-tools", malformed),
    Error,
    "Invalid GitHub response",
  );
  await assertRejects(() => readRepository("../other", failed), Error, "active WebJamApps");
  for (
    const changes of [
      { labels: null },
      { state: null },
      { title: 5 },
      { number: 0 },
      { milestone: {} },
      { type: "Epic" },
      { issue_field_values: {} },
      {
        issue_field_values: [{
          issue_field_name: "Priority",
          single_select_option: { name: "Unknown" },
        }],
      },
    ]
  ) {
    await assertRejects(() =>
      readRepository("web-jam-tools", apiRunner(apiData([rawIssue(1, changes)])))
    );
  }
  await assertRejects(
    () =>
      readRepository(
        "web-jam-tools",
        apiRunner({
          [`${root}/issues?state=open&per_page=100`]: { message: "Unauthorized" },
        }),
      ),
    Error,
    "Invalid GitHub response",
  );
});

function cliOptions(data = apiData(), input: unknown = judgments([issue(1)])) {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    runner: apiRunner(data),
    readTextFile: (_path: string) => Promise.resolve(JSON.stringify(input)),
    log: (line: string) => output.push(line),
    errorLog: (line: string) => errors.push(line),
  };
}

const cliArgs = ["--repo", "web-jam-tools", "--judgments", "judgments.json"];

Deno.test("registered task reads its scoped input and executes the CLI with a local gh fixture", async () => {
  await Deno.mkdir("/tmp/backlog-groom", { recursive: true });
  const directory = await Deno.makeTempDir({ dir: "/tmp/backlog-groom", prefix: "rank-test-" });
  try {
    const rows = JSON.stringify([[rawIssue(1, { issue_field_values: [] })]]);
    const script = [
      "#!/bin/sh",
      '[ "$1" = api ] || exit 99',
      'case "$2" in',
      `  *issues?*) printf '%s' '${rows}' ;;`,
      '  *milestones?*) printf "%s" "[]" ;;',
      '  *dependencies/*|*sub_issues*) printf "%s" "[]" ;;',
      "  *) exit 98 ;;",
      "esac",
    ].join("\n");
    await Deno.writeTextFile(`${directory}/gh`, script);
    await Deno.chmod(`${directory}/gh`, 0o755);
    const input = `${directory}/judgments.json`;
    await Deno.writeTextFile(input, JSON.stringify(judgments([issue(1)])));
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "task",
        "backlog-groom:rank",
        "--repo",
        "web-jam-tools",
        "--judgments",
        input,
        "--json",
      ],
      cwd: new URL("../", import.meta.url).pathname,
      env: { PATH: `${directory}:${Deno.env.get("PATH")}` },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    assertEquals(JSON.parse(new TextDecoder().decode(result.stdout)).moves[0].to, "Medium");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CLI proposes JSON and human-readable batches without a write call", async () => {
  const data = apiData([rawIssue(1, { issue_field_values: [] })]);
  const json = cliOptions(data);
  assertEquals(await runRankCli([...cliArgs, "--json", "--focus", "missing"], json), 0);
  const result = JSON.parse(json.output[0]);
  assertEquals(result.moves[0].to, "Medium");
  assertEquals(result.focus, null);
  assertStringIncludes(result.notices[0], "does not exist");
  const report = cliOptions(data);
  assertEquals(await runRankCli(cliArgs, report), 0);
  assertStringIncludes(report.output[0], 'web-jam-tools#1 "Issue 1" | unset | Medium');
  assertStringIncludes(formatReport(rank([])), "No Priority moves proposed.");
});

Deno.test("CLI help has no filesystem or GitHub side effects", async () => {
  const options = cliOptions();
  options.runner = () => {
    throw new Error("Must not call gh");
  };
  options.readTextFile = () => {
    throw new Error("Must not read");
  };
  assertEquals(await runRankCli(["--help"], options), 0);
  assertStringIncludes(options.output[0], "deno task backlog-groom:rank");
});

Deno.test("CLI refuses invalid input, unreadable judgment file, and failed reads without proposals", async () => {
  for (const args of [[], ["--apply"], ["--repo", "web-jam-tools"], [...cliArgs, "extra"]]) {
    const options = cliOptions();
    assertEquals(await runRankCli(args, options), 1);
    assertEquals(options.output, []);
  }
  for (const input of [null, [], {}, { 1: { liveBroken: "false" } }]) {
    const options = cliOptions(apiData(), input);
    assertEquals(await runRankCli(cliArgs, options), 1);
    assertEquals(options.output, []);
    assertStringIncludes(options.errors[0], "refused");
  }
  const unreadable = cliOptions();
  unreadable.readTextFile = () => Promise.reject(new Error("File missing"));
  assertEquals(await runRankCli(cliArgs, unreadable), 1);
  assertStringIncludes(unreadable.errors[0], "File missing");
  const invalidJson = cliOptions();
  invalidJson.readTextFile = () => Promise.resolve("{");
  assertEquals(await runRankCli(cliArgs, invalidJson), 1);
  const failure = cliOptions();
  failure.runner = () => Promise.reject(new Error("Network unavailable"));
  assertEquals(await runRankCli(cliArgs, failure), 1);
  assertEquals(failure.output, []);
});
