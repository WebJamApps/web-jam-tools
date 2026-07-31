// fix_labels_milestone_diff.test.ts — web-jam-tools#300
//
// Unit tests for src/fix-labels/milestone-diff.ts. No network, no real `gh`
// binary — every `gh` shell-out is exercised through the injected
// CommandRunner with a fake implementation, mirroring
// test/fix_labels_diff.test.ts's structure for the label-drift half.
//
// Three groups:
//   1. A small synthetic topic schema exercising each of the three drift
//      kinds (missing / misspelled — both case-variant and typo — and
//      non-canonical, including the canonical-elsewhere-but-wrong-repo
//      case) plus report formatting.
//   2. The REAL skills/fix-labels/labels.yaml's `milestoneTopics:` loaded via
//      loadSchema(), proving the canonical topics documented on
//      web-jam-tools#300 ("gig-outreach": JaMmusic/web-jam-back/
//      web-jam-tools, "backup-restore": web-jam-tools) parse as expected.
//   3. The `gh`-shelling half: fetchActualMilestones/scanRepoMilestones/
//      main(), all driven by a fake CommandRunner, including error paths.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { loadSchema, type Schema } from "../src/fix-labels/diff.ts";
import {
  type ActualMilestone,
  classifyMilestoneDrift,
  type CommandResult,
  type CommandRunner,
  fetchActualMilestones,
  formatMilestoneReport,
  levenshtein,
  main,
  type MilestoneDriftItem,
  milestoneTopicRepos,
  scanRepoMilestones,
} from "../src/fix-labels/milestone-diff.ts";

const LABELS_YAML_PATH = new URL("../skills/fix-labels/labels.yaml", import.meta.url).pathname;

function findByName(items: MilestoneDriftItem[], name: string): MilestoneDriftItem | undefined {
  return items.find((i) => i.name === name);
}

// --- Group 1: synthetic topic schema, one of each drift kind ---

const mockSchema: Schema = {
  repoClasses: { frontend: [], other: [] },
  labels: [],
  keep: {},
  milestoneTopics: [
    { name: "gig-outreach", repos: ["RepoA", "RepoB"] },
    { name: "backup-restore", repos: ["RepoA"] },
  ],
};

Deno.test("levenshtein: identical strings are distance 0", () => {
  assertEquals(levenshtein("gig-outreach", "gig-outreach"), 0);
});

Deno.test("levenshtein: one-character substitution is distance 1", () => {
  assertEquals(levenshtein("cat", "bat"), 1);
});

Deno.test("levenshtein: a transposed pair of adjacent letters is distance 2", () => {
  assertEquals(levenshtein("gig-outreach", "gig-outraech"), 2);
});

Deno.test("levenshtein: empty-string edge cases", () => {
  assertEquals(levenshtein("", "abc"), 3);
  assertEquals(levenshtein("abc", ""), 3);
  assertEquals(levenshtein("", ""), 0);
});

Deno.test("milestoneTopicRepos: dedup'd, first-appearance order", () => {
  assertEquals(milestoneTopicRepos(mockSchema), ["RepoA", "RepoB"]);
});

Deno.test("classifyMilestoneDrift: a fully-compliant repo has zero drift", () => {
  const actual: ActualMilestone[] = [
    { title: "gig-outreach", number: 1, state: "open" },
    { title: "backup-restore", number: 2, state: "open" },
  ];
  assertEquals(classifyMilestoneDrift(mockSchema, "RepoA", actual), []);
});

Deno.test("classifyMilestoneDrift: MISSING — a required topic milestone absent from actual", () => {
  const drift = classifyMilestoneDrift(mockSchema, "RepoA", []);
  const gigOutreach = findByName(drift, "gig-outreach");
  assertEquals(gigOutreach?.kind, "missing");
  assertEquals(gigOutreach?.action, "create");
  const backupRestore = findByName(drift, "backup-restore");
  assertEquals(backupRestore?.kind, "missing");
  assertEquals(backupRestore?.action, "create");
});

Deno.test("classifyMilestoneDrift: MISSPELLED — case-variant proposes a rename, not a fresh create", () => {
  const actual: ActualMilestone[] = [{ title: "Gig-Outreach", number: 5, state: "open" }];
  const drift = classifyMilestoneDrift(mockSchema, "RepoA", actual);
  const item = findByName(drift, "gig-outreach");
  assertEquals(item?.kind, "misspelled");
  assertEquals(item?.action, "rename");
  assertEquals(item?.fromName, "Gig-Outreach");
  assertEquals(item?.number, 5);
  // The case-variant must be consumed, not ALSO surfaced as its own
  // non-canonical line.
  assertEquals(
    drift.filter((d) => d.fromName === "Gig-Outreach" || d.name === "Gig-Outreach")
      .length,
    1,
  );
});

Deno.test("classifyMilestoneDrift: MISSPELLED — a close typo proposes a rename", () => {
  const actual: ActualMilestone[] = [{ title: "gig-outreah", number: 7, state: "open" }];
  const drift = classifyMilestoneDrift(mockSchema, "RepoA", actual);
  const item = findByName(drift, "gig-outreach");
  assertEquals(item?.kind, "misspelled");
  assertEquals(item?.fromName, "gig-outreah");
  assertEquals(item?.number, 7);
});

Deno.test("classifyMilestoneDrift: a typo too far away is NOT treated as misspelled — reported non-canonical instead", () => {
  const actual: ActualMilestone[] = [{
    title: "completely-different-name",
    number: 9,
    state: "open",
  }];
  const drift = classifyMilestoneDrift(mockSchema, "RepoA", actual);
  // The required topics are both still missing...
  assertEquals(findByName(drift, "gig-outreach")?.kind, "missing");
  assertEquals(findByName(drift, "backup-restore")?.kind, "missing");
  // ...and the unrelated milestone is flagged on its own, not silently renamed.
  const junk = findByName(drift, "completely-different-name");
  assertEquals(junk?.kind, "non-canonical");
  assertEquals(junk?.action, "review");
});

Deno.test("classifyMilestoneDrift: NON-CANONICAL — a canonical name present in a repo that isn't designated for it", () => {
  // backup-restore is canonical only for RepoA, not RepoB.
  const actual: ActualMilestone[] = [
    { title: "gig-outreach", number: 1, state: "open" },
    { title: "backup-restore", number: 2, state: "open" },
  ];
  const drift = classifyMilestoneDrift(mockSchema, "RepoB", actual);
  const item = findByName(drift, "backup-restore");
  assertEquals(item?.kind, "non-canonical");
  assertEquals(item?.action, "review");
  assert(item?.note?.includes("not designated for this repo"));
});

Deno.test("classifyMilestoneDrift: NON-CANONICAL — a milestone entirely off the topic list", () => {
  const actual: ActualMilestone[] = [
    { title: "gig-outreach", number: 1, state: "open" },
    { title: "backup-restore", number: 2, state: "open" },
    { title: "v2-release", number: 3, state: "closed" },
  ];
  const drift = classifyMilestoneDrift(mockSchema, "RepoA", actual);
  const item = findByName(drift, "v2-release");
  assertEquals(item?.kind, "non-canonical");
  assertEquals(item?.action, "review");
  assertEquals(item?.note, undefined);
});

// --- Group 2: the real labels.yaml's milestoneTopics ---

Deno.test("loadSchema: the real labels.yaml's milestoneTopics match web-jam-tools#300's canonical topics", async () => {
  const schema = await loadSchema(LABELS_YAML_PATH);
  assertEquals(schema.milestoneTopics.map((t) => t.name), [
    "gig-outreach",
    "backup-restore",
    "timshermanmusic",
    "Access Controls",
    "Claude Misbehaves",
  ]);
  assertEquals(
    schema.milestoneTopics.find((t) => t.name === "gig-outreach")?.repos,
    ["JaMmusic", "web-jam-back", "web-jam-tools", "WebJamSocketCluster"],
  );
  // web-jam-tools#315: created live in all 8 active repos on 2026-07-30.
  assertEquals(
    schema.milestoneTopics.find((t) => t.name === "Access Controls")?.repos,
    [
      "JaMmusic",
      "CollegeLutheran",
      "AppersonAuto",
      "TimShermanMusic",
      "HenricksonForSalem",
      "web-jam-back",
      "WebJamSocketCluster",
      "web-jam-tools",
    ],
  );
  assertEquals(
    schema.milestoneTopics.find((t) => t.name === "backup-restore")?.repos,
    ["web-jam-tools"],
  );
  // web-jam-tools#300 follow-up decision: `timshermanmusic` IS canonical,
  // scoped to the exact 3 repos where Josh created the milestone live.
  assertEquals(
    schema.milestoneTopics.find((t) => t.name === "timshermanmusic")?.repos,
    ["web-jam-back", "JaMmusic", "WebJamSocketCluster"],
  );
  // Josh's call, created live in web-jam-tools on 2026-07-31 (milestone #5).
  // web-jam-tools only for now.
  assertEquals(
    schema.milestoneTopics.find((t) => t.name === "Claude Misbehaves")?.repos,
    ["web-jam-tools"],
  );
  // web-jam-tools#315 widened this union to all 8 active repos, since
  // "Access Controls" is scoped to every one of them; "Claude Misbehaves"
  // adds no new repos since web-jam-tools is already in the union.
  assertEquals(milestoneTopicRepos(schema), [
    "JaMmusic",
    "web-jam-back",
    "web-jam-tools",
    "WebJamSocketCluster",
    "CollegeLutheran",
    "AppersonAuto",
    "TimShermanMusic",
    "HenricksonForSalem",
  ]);
});

// --- Report formatting ---

Deno.test("formatMilestoneReport: no-drift repo prints 'no changes'", () => {
  const report = formatMilestoneReport({ "web-jam-tools": [] }, new Date("2026-07-29T12:00:00Z"));
  assert(report.includes("### web-jam-tools"));
  assert(report.includes("no changes"));
});

Deno.test("formatMilestoneReport: renders all three drift line shapes", () => {
  const perRepo: Record<string, MilestoneDriftItem[]> = {
    JaMmusic: [
      { kind: "missing", action: "create", name: "gig-outreach" },
      {
        kind: "misspelled",
        action: "rename",
        name: "gig-outreach",
        fromName: "Gig-Outreach",
        number: 3,
      },
      { kind: "non-canonical", action: "review", name: "v2-release" },
    ],
  };
  const report = formatMilestoneReport(perRepo, new Date("2026-07-29T12:00:00Z"));
  assert(report.includes("- CREATE milestone `gig-outreach` — missing"));
  assert(report.includes("- RENAME milestone `Gig-Outreach` → `gig-outreach` — misspelled"));
  assert(report.includes("- REVIEW milestone `v2-release` — non-canonical, not on the topic list"));
});

// --- Group 3: the `gh`-shelling half, via a fake CommandRunner ---

function makeFakeRunner(milestonesByRepo: Record<string, ActualMilestone[]>): CommandRunner {
  return (args: string[]): Promise<CommandResult> => {
    if (args[0] === "api" && String(args[1]).includes("/milestones")) {
      const match = String(args[1]).match(/repos\/WebJamApps\/([^/]+)\/milestones/);
      const repo = match ? match[1] : "";
      const list = milestonesByRepo[repo] ?? [];
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify(
          list.map((m) => ({ title: m.title, number: m.number, state: m.state })),
        ),
        stderr: "",
      });
    }
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: `fake runner: unrecognized: ${args.join(" ")}`,
    });
  };
}

async function withConsole(
  fn: () => Promise<void>,
): Promise<{ logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { logs, errors };
}

async function withTempSchema(yaml: string, fn: (path: string) => Promise<void>): Promise<void> {
  const path = await Deno.makeTempFile({ suffix: ".yaml" });
  try {
    await Deno.writeTextFile(path, yaml);
    await fn(path);
  } finally {
    await Deno.remove(path);
  }
}

const MINIMAL_SCHEMA_YAML = `
repoClasses:
  frontend:
    - RepoA
  other:
    - RepoB
labels:
  - name: Widget
    hex: "111111"
    repos: all
keep: {}
milestoneTopics:
  - name: some-topic
    repos:
      - RepoA
`;

Deno.test("fetchActualMilestones: parses gh api JSON via the injected runner", async () => {
  const runner = makeFakeRunner({ RepoA: [{ title: "some-topic", number: 1, state: "open" }] });
  const milestones = await fetchActualMilestones("RepoA", runner);
  assertEquals(milestones, [{ title: "some-topic", number: 1, state: "open" }]);
});

Deno.test("fetchActualMilestones: throws a formatted error when gh exits non-zero", async () => {
  const runner: CommandRunner = () =>
    Promise.resolve({ code: 1, stdout: "", stderr: "repo not found" });
  await assertRejects(() => fetchActualMilestones("Nope", runner), Error, "gh api");
});

Deno.test("scanRepoMilestones: fetches actual milestones and classifies end-to-end", async () => {
  const runner = makeFakeRunner({ RepoA: [] });
  const drift = await scanRepoMilestones(mockSchema, "RepoA", runner);
  assertEquals(findByName(drift, "gig-outreach")?.kind, "missing");
  assertEquals(findByName(drift, "backup-restore")?.kind, "missing");
});

Deno.test("main: prints the milestone report format and returns 0 on a clean scan", async () => {
  await withTempSchema(MINIMAL_SCHEMA_YAML, async (schemaPath) => {
    const runner = makeFakeRunner({ RepoA: [{ title: "some-topic", number: 1, state: "open" }] });
    const { logs, errors } = await withConsole(async () => {
      const code = await main([], runner, schemaPath);
      assertEquals(code, 0);
    });
    assertEquals(errors, []);
    assertEquals(logs.length, 1);
    assert(logs[0].includes("## fix-labels milestone report"));
    assert(logs[0].includes("### RepoA"));
    assert(logs[0].includes("no changes"));
  });
});

Deno.test("main: --json prints the raw per-repo drift list", async () => {
  await withTempSchema(MINIMAL_SCHEMA_YAML, async (schemaPath) => {
    const runner = makeFakeRunner({ RepoA: [] });
    const { logs } = await withConsole(async () => {
      const code = await main(["--json"], runner, schemaPath);
      assertEquals(code, 0);
    });
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.RepoA[0].kind, "missing");
    assertEquals(parsed.RepoA[0].name, "some-topic");
  });
});

Deno.test("main: returns 1 and reports a schema-load failure, without printing a report", async () => {
  const { logs, errors } = await withConsole(async () => {
    const code = await main([], makeFakeRunner({}), "/nonexistent/path/labels.yaml");
    assertEquals(code, 1);
  });
  assertEquals(logs, []);
  assert(errors[0].includes("failed to load schema"));
});

Deno.test("main: returns 1 and reports a scan failure loudly, never swallowing it", async () => {
  await withTempSchema(MINIMAL_SCHEMA_YAML, async (schemaPath) => {
    const runner: CommandRunner = () =>
      Promise.resolve({ code: 1, stdout: "", stderr: "gh: rate limited" });
    const { logs, errors } = await withConsole(async () => {
      const code = await main([], runner, schemaPath);
      assertEquals(code, 1);
    });
    assertEquals(logs, []);
    assert(errors[0].includes("scan failed"));
  });
});
