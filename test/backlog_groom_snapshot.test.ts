import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { runCollectCli } from "../src/backlog-groom/collect_cli.ts";
import { runRankCli } from "../src/backlog-groom/cli.ts";
import { readArray, readRepository } from "../src/backlog-groom/github.ts";
import { rankIssues } from "../src/backlog-groom/rank.ts";
import {
  collectSnapshot,
  limitRunner,
  readSnapshot,
  repositoryFacts,
  snapshotPath,
  validateSnapshot,
} from "../src/backlog-groom/snapshot.ts";
import { ACTIVE_REPOS, type CommandRunner } from "../src/shared/repos.ts";

const now = new Date("2026-10-19T16:00:00.000Z");
function raw(repo: string, number = 1) {
  return {
    number,
    title: `Issue ${number}`,
    body: "Executable specification",
    state: "open",
    updated_at: now.toISOString(),
    milestone: null,
    type: null,
    labels: ["parked"],
    issue_field_values: [],
    repository_url: `https://api.github.com/repos/WebJamApps/${repo}`,
    html_url: `https://github.com/WebJamApps/${repo}/issues/${number}`,
    issue_dependencies_summary: { blocked_by: 0, blocking: 0 },
    sub_issues_summary: { total: 0 },
  };
}
function fixture(mutate: (issue: Record<string, unknown>) => void = () => {}) {
  const calls: string[][] = [];
  let active = 0;
  let peak = 0;
  const runner: CommandRunner = async (args) => {
    calls.push(args);
    assertEquals(args[0], "api");
    assertEquals(args.slice(2, 4), ["--method", "GET"]);
    assert(!args.includes("--jq"));
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    const repo = args[1].split("/")[2];
    const issue = raw(repo);
    mutate(issue);
    if (args[1].endsWith("/parent")) {
      return { code: 1, stdout: '{"status":"404"}', stderr: "HTTP 404" };
    }
    const data = args[1].includes("issues?state=")
      ? [issue]
      : args[1].includes("milestones?")
      ? [{ title: "health-wellness", state: "open" }]
      : [];
    return { code: 0, stdout: JSON.stringify([data]), stderr: "" };
  };
  return { runner, calls, peak: () => peak };
}

Deno.test("collector shares a global concurrency limit and skips explicitly empty relationships", async () => {
  const f = fixture();
  const snapshot = await collectSnapshot(f.runner, 3, () => now);
  assertEquals(snapshot.repositories.map((repo) => repo.repo), [...ACTIVE_REPOS]);
  assertEquals(snapshot.requests, 24); // Eight issue lists, milestone lists and parents.
  assertEquals(f.calls.length, 24);
  assertEquals(f.peak(), 3);
  assertEquals(snapshot.repositories[0].issues[0].issue.labels, ["parked"]);
  assertEquals(snapshot.repositories[0].issues[0].parent, null);
});

Deno.test("missing summaries trigger reads for every relationship, including non-Epic children", async () => {
  const f = fixture((issue) => {
    delete issue.issue_dependencies_summary;
    delete issue.sub_issues_summary;
  });
  const snapshot = await collectSnapshot(f.runner, 6, () => now);
  assertEquals(snapshot.requests, 48);
  assertEquals(f.calls.filter((args) => args[1].includes("/sub_issues?")).length, 8);
  assertEquals(f.peak(), 6);
});

Deno.test("slurp page arrays are flattened without gh jq and malformed pages refuse", async () => {
  const runner: CommandRunner = () =>
    Promise.resolve({ code: 0, stdout: '[[{"number":1}],[{"number":2}]]', stderr: "" });
  assertEquals(await readArray("test", runner), [{ number: 1 }, { number: 2 }]);
  for (const stdout of ['[{"number":1}]', '[[],{"message":"denied"}]', "null", "{"]) {
    await assertRejects(() =>
      readArray("test", () => Promise.resolve({ code: 0, stdout, stderr: "" }))
    );
  }
});

Deno.test("collection refuses incomplete, malformed and failed responses instead of a snapshot", async () => {
  for (const field of ["body", "type", "issue_field_values", "updated_at", "repository_url"]) {
    const f = fixture((issue) => {
      delete issue[field];
    });
    await assertRejects(() => collectSnapshot(f.runner, 2, () => now));
  }
  for (const status of ["401", "403", "500"]) {
    const f = fixture();
    const runner: CommandRunner = (args) =>
      args[1].endsWith("/parent")
        ? Promise.resolve({ code: 1, stdout: JSON.stringify({ status }), stderr: "failed" })
        : f.runner(args);
    await assertRejects(() => collectSnapshot(runner, 2, () => now), Error, "parent read failed");
  }
  const f = fixture((issue) => {
    issue.issue_dependencies_summary = { blocking: -1 };
  });
  await assertRejects(() => collectSnapshot(f.runner, 2, () => now), Error, "Malformed");
});

Deno.test("snapshot identity, completeness and one-hour freshness are mandatory", async () => {
  const snapshot = await collectSnapshot(fixture().runner, 4, () => now);
  const invalid = [
    { ...snapshot, schemaVersion: 2 },
    { ...snapshot, owner: "other" },
    { ...snapshot, repositories: snapshot.repositories.slice(1) },
    { ...snapshot, repositories: snapshot.repositories.map(() => snapshot.repositories[0]) },
    { ...snapshot, completedAt: "invalid" },
    { ...snapshot, startedAt: "2026-10-19T16:00:00Z" },
    { ...snapshot, completedAt: "2026-10-19T16:00:00+00:00" },
    { ...snapshot, startedAt: "2020-01-01" },
    { ...snapshot, startedAt: "2026-10-20", completedAt: "2026-10-20" },
  ];
  for (const value of invalid) assertThrows(() => validateSnapshot(value, now));
  const wrongIssue = structuredClone(snapshot);
  wrongIssue.repositories[0].issues[0].issue.repository_url =
    "https://api.github.com/repos/WebJamApps/JaMmusic";
  assertThrows(() => validateSnapshot(wrongIssue, now), Error, "identity");
  const absentRelation = structuredClone(snapshot);
  delete (absentRelation.repositories[0].issues[0] as unknown as Record<string, unknown>).parent;
  assertThrows(() => validateSnapshot(absentRelation, now));
  assertThrows(() => repositoryFacts(snapshot, "../other"), Error, "absent");
});

Deno.test("snapshot and live ranking agree and snapshot CLI makes zero GitHub reads", async () => {
  const current = new Date();
  const f = fixture((issue) => {
    issue.updated_at = current.toISOString();
  });
  const snapshot = await collectSnapshot(f.runner);
  const answers = {
    1: {
      liveBroken: false,
      costlyDefect: false,
      reason: "Planned work",
      levelFromTests: "Low" as const,
    },
  };
  const live = await readRepository("web-jam-tools", f.runner);
  const saved = repositoryFacts(snapshot, "web-jam-tools");
  assertEquals(
    rankIssues("web-jam-tools", saved.issues, answers, saved.milestones),
    rankIssues("web-jam-tools", live.issues, answers, live.milestones),
  );
  const lines: string[] = [];
  assertEquals(
    await runRankCli([
      "--repo",
      "web-jam-tools",
      "--judgments",
      "judgments.json",
      "--snapshot",
      "/tmp/backlog-groom/test.json",
      "--json",
    ], {
      runner: () => {
        throw new Error("Must not read GitHub");
      },
      readTextFile: (path) =>
        Promise.resolve(JSON.stringify(path.endsWith("test.json") ? snapshot : answers)),
      log: (line) => lines.push(line),
    }),
    0,
  );
  assertEquals(JSON.parse(lines[0]).moves[0].to, "Low");
});

Deno.test("snapshot paths refuse traversal and symlinks and semaphore rejects invalid caps", async () => {
  for (
    const path of [
      "/tmp/backlog-groom/../secret.json",
      "/home/joshua/input.json",
      "/tmp/backlog-groom/x/../../x.json",
      "/tmp/backlog-groom/snapshot.txt",
    ]
  ) {
    assertThrows(() => snapshotPath(path));
  }
  for (const cap of [0, 17, 1.2, NaN]) assertThrows(() => limitRunner(fixture().runner, cap));
  await Deno.mkdir("/tmp/backlog-groom", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: "/tmp/backlog-groom", prefix: "snapshot-test-" });
  try {
    await Deno.writeTextFile(`${dir}/actual.json`, "{}");
    await Deno.symlink(`${dir}/actual.json`, `${dir}/link.json`);
    await assertRejects(() => readSnapshot(`${dir}/link.json`), Error, "symlinks");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("collector CLI publishes only complete snapshots, refuses overwrite and leaves no partial file", async () => {
  await Deno.mkdir("/tmp/backlog-groom", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: "/tmp/backlog-groom", prefix: "collect-test-" });
  const lines: string[] = [];
  const errors: string[] = [];
  const options = {
    runner: fixture().runner,
    log: (line: string) => lines.push(line),
    errorLog: (line: string) => errors.push(line),
  };
  try {
    const output = `${dir}/nested/snapshot.json`;
    assertEquals(await runCollectCli(["--output", output, "--concurrency", "2"], options), 0);
    const saved = await readSnapshot(output);
    assertEquals(saved.repositories.length, 8);
    assertEquals(saved.requests, 24);
    assertEquals(await runCollectCli(["--output", output], options), 1);
    assertEquals(JSON.parse(await Deno.readTextFile(output)).requests, 24);
    const failed = `${dir}/failed.json`;
    assertEquals(
      await runCollectCli(["--output", failed], {
        ...options,
        runner: () => Promise.resolve({ code: 1, stdout: "", stderr: "denied" }),
      }),
      1,
    );
    await assertRejects(() => Deno.stat(failed), Deno.errors.NotFound);
    await Deno.mkdir(`${dir}/actual`);
    await Deno.symlink(`${dir}/actual`, `${dir}/linked`);
    assertEquals(
      await runCollectCli(["--output", `${dir}/linked/nested/snapshot.json`], options),
      1,
    );
    await assertRejects(() => Deno.stat(`${dir}/actual/nested`), Deno.errors.NotFound);
    await Deno.remove(`${dir}/linked`);
    await Deno.remove(`${dir}/actual`);
    const entries = [];
    for await (const item of Deno.readDir(dir)) entries.push(item.name);
    assertEquals(entries, ["nested"]);
    const noRead = {
      ...options,
      runner: () => {
        throw new Error("unexpected read");
      },
    };
    for (
      const args of [[], ["--output", "/home/joshua/x.json"], [
        "--output",
        `${dir}/x.json`,
        "--concurrency",
        "17",
      ], ["--bad"]]
    ) assertEquals(await runCollectCli(args, noRead), 1);
    assertEquals(await runCollectCli(["--help"], noRead), 0);
    assert(lines.some((line) => line.includes("[--concurrency 12]")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("collector CLI defaults concurrency to 12 when omitted", async () => {
  await Deno.mkdir("/tmp/backlog-groom", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: "/tmp/backlog-groom", prefix: "collect-concurrency-" });
  const f = fixture();
  const lines: string[] = [];
  try {
    const output = `${dir}/snapshot.json`;
    assertEquals(
      await runCollectCli(["--output", output], {
        runner: f.runner,
        log: (line) => lines.push(line),
      }),
      0,
    );
    assertEquals(f.peak(), 12);
    const saved = await readSnapshot(output);
    assertEquals(saved.repositories.length, 8);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("collector preserves explicit empty bodies and cross-repository native relationships", async () => {
  const f = fixture((issue) => {
    issue.type = { name: "Epic" };
    issue.body = null;
    issue.issue_dependencies_summary = { blocked_by: 1, blocking: 1 };
    issue.sub_issues_summary = { total: 1 };
  });
  const related = {
    ...raw("JaMmusic", 2),
    type: { name: "Task" },
    issue_field_values: [{ issue_field_name: "Priority", single_select_option: { name: "High" } }],
  };
  const runner: CommandRunner = (args) => {
    if (args[1].endsWith("/parent")) {
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ ...related, state: "closed" }),
        stderr: "",
      });
    }
    if (/\/(dependencies|sub_issues)/.test(args[1])) {
      return Promise.resolve({ code: 0, stdout: JSON.stringify([[related]]), stderr: "" });
    }
    return f.runner(args);
  };
  const snapshot = await collectSnapshot(runner, 3, () => now);
  const row = snapshot.repositories[0].issues[0];
  assertEquals(row.issue.body, null);
  assertEquals(row.parent?.state, "closed");
  const facts = repositoryFacts(snapshot, "web-jam-tools").issues[0];
  assertEquals(facts.children, [{ number: 2, priority: "High" }]);
  assertEquals(facts.blockedByOpen, true);
  assertEquals(facts.openWaiting, 1);
});
