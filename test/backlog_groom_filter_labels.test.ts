import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dirname, join } from "@std/path";
import {
  type Finding,
  type FindingChange,
  type FindingsFile,
  readFindings,
  validateFindings,
  writeFindings,
} from "../src/backlog-groom/findings.ts";
import {
  filterLabelRules,
  FLASH_BATCH_HEADING,
  runFilterLabelsCli,
} from "../src/backlog-groom/filter_label_rules.ts";
import { type Priority } from "../src/backlog-groom/rank.ts";
import { type Snapshot } from "../src/backlog-groom/snapshot.ts";
import { EVERYDAY_MODEL_LABELS } from "../src/shared/model_label_rule.ts";
import { ACTIVE_REPOS } from "../src/shared/repos.ts";

function snapshot(labels = ["Flash"], priority: Priority | null = "Low"): Snapshot {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    owner: "WebJamApps",
    startedAt: now,
    completedAt: now,
    requests: 16,
    repositories: ACTIVE_REPOS.map((repo) => ({
      repo,
      milestones: [],
      issues: repo === "web-jam-tools"
        ? [{
          issue: {
            number: 1,
            title: "Fixture issue",
            body: "Fixture specification",
            state: "open",
            updated_at: now,
            labels: labels.map((name) => ({ name })),
            milestone: null,
            type: null,
            issue_field_values: priority
              ? [{ issue_field_name: "Priority", single_select_option: { name: priority } }]
              : [],
            repository_url: `https://api.github.com/repos/WebJamApps/${repo}`,
            html_url: `https://github.com/WebJamApps/${repo}/issues/1`,
          },
          blockers: [],
          blocking: [],
          children: [],
          parent: null,
        }]
        : [],
    })),
  };
}

function finding(number = 1, changes: FindingChange[] = [
  { kind: "labels", remove: ["Flash"], add: ["Sol"] },
]): Finding {
  return {
    number,
    repo: "web-jam-tools",
    issue: 1,
    category: "model-label",
    finding: "Model label differs from the proposed triage",
    reason: "Fixture reason for Josh to review",
    changes,
  };
}

function findings(items = [finding()]): FindingsFile {
  return { schemaVersion: 1, items, flashBatch: [] };
}

const cases: Array<{
  name: string;
  labels: string[];
  priority: Priority | null;
  remove: string[];
  add: string[];
  batch: boolean;
}> = [
  {
    name: "Flash Low to Sol",
    labels: ["Flash"],
    priority: "Low",
    remove: ["Flash"],
    add: ["Sol"],
    batch: true,
  },
  {
    name: "Flash Medium to Sol",
    labels: ["Flash"],
    priority: "Medium",
    remove: ["Flash"],
    add: ["Sol"],
    batch: true,
  },
  {
    name: "Terra Medium to Sonnet",
    labels: ["Terra"],
    priority: "Medium",
    remove: ["Terra"],
    add: ["Sonnet"],
    batch: true,
  },
  {
    name: "both everyday labels Low removing Flash",
    labels: ["Flash", "Terra"],
    priority: "Low",
    remove: ["Flash"],
    add: [],
    batch: true,
  },
  {
    name: "Flash High to Sol",
    labels: ["Flash"],
    priority: "High",
    remove: ["Flash"],
    add: ["Sol"],
    batch: false,
  },
  {
    name: "Flash Urgent to Sol",
    labels: ["Flash"],
    priority: "Urgent",
    remove: ["Flash"],
    add: ["Sol"],
    batch: false,
  },
  {
    name: "Flash with no Priority to Sol",
    labels: ["Flash"],
    priority: null,
    remove: ["Flash"],
    add: ["Sol"],
    batch: false,
  },
  {
    name: "Sol Low to Flash",
    labels: ["Sol"],
    priority: "Low",
    remove: ["Sol"],
    add: ["Flash"],
    batch: false,
  },
  {
    name: "Flash Low adding Needs Design",
    labels: ["Flash"],
    priority: "Low",
    remove: [],
    add: ["Needs Design"],
    batch: false,
  },
  {
    name: "Flash Low adding Terra",
    labels: ["Flash"],
    priority: "Low",
    remove: [],
    add: ["Terra"],
    batch: false,
  },
];

for (const row of cases) {
  Deno.test(`filter labels: ${row.name}`, () => {
    const input = findings([finding(7, [{ kind: "labels", remove: row.remove, add: row.add }])]);
    const original = structuredClone(input);
    const result = filterLabelRules(input, snapshot(row.labels, row.priority));
    assertEquals(result.flashBatch, row.batch ? input.items : []);
    assertEquals(result.items, row.batch ? [] : input.items);
    assertEquals(input, original);
    assertEquals(filterLabelRules(result, snapshot(row.labels, row.priority)), result);
  });
}

Deno.test("Needs Design and model relabel items stay independently numbered and keep their reasons", () => {
  const design = finding(9, [{ kind: "labels", remove: [], add: ["Needs Design"] }]);
  const relabel = finding(15, [{ kind: "labels", remove: ["Flash"], add: ["Opus"] }]);
  const result = filterLabelRules(findings([design, relabel]), snapshot());
  assertEquals(result.items, [design]);
  assertEquals(result.flashBatch, [relabel]);
  assertEquals(EVERYDAY_MODEL_LABELS, ["Flash", "Terra"]);
});

Deno.test("other changes and proposed closes remain visible in the main list", () => {
  const mixed = finding(1, [
    { kind: "labels", remove: ["Flash"], add: ["Sol", "Needs Design"] },
  ]);
  const milestone = finding(2, [
    { kind: "labels", remove: ["Flash"], add: ["Sol"] },
    { kind: "milestone", before: null, after: "token-savings" },
  ]);
  const close = { ...finding(3, []), proposedClose: true };
  assertEquals(filterLabelRules(findings([mixed, milestone, close]), snapshot()).items, [
    mixed,
    milestone,
    close,
  ]);
  const priorBatch = { schemaVersion: 1 as const, items: [], flashBatch: [finding()] };
  assertEquals(filterLabelRules(priorBatch, snapshot(["Flash"], "High")).flashBatch, []);
  assertEquals(filterLabelRules(priorBatch, snapshot(["Flash"], "High")).items, [finding()]);
});

const validChanges: FindingChange[] = [
  { kind: "labels", remove: ["Flash"], add: ["Sol"] },
  { kind: "milestone", before: null, after: "token-savings" },
  { kind: "type", before: null, after: "Task" },
  { kind: "priority", before: "High", after: "Medium" },
  { kind: "parent", before: null, after: { repo: "WebJamApps/JaMmusic", number: 2 } },
  {
    kind: "blocked-by",
    issue: { repo: "WebJamApps/web-jam-tools", number: 3 },
    before: false,
    after: true,
  },
  {
    kind: "blocked-by",
    issue: { repo: "WebJamApps/JaMmusic", number: 4 },
    before: true,
    after: false,
  },
  { kind: "body", beforeSha256: "a".repeat(64), bodyFile: "/tmp/backlog-groom/run/body.md" },
];

Deno.test("findings define every change's read precondition and proposed value", () => {
  const input = findings([finding(1, validChanges)]);
  assertEquals(validateFindings(input), input);
  const optionalBatch = { schemaVersion: 1, items: input.items };
  assertEquals(validateFindings(optionalBatch), input);
  for (
    const change of [
      { kind: "milestone", before: "old", after: "new" },
      { kind: "type", before: "Bug", after: "Feature" },
      { kind: "priority", before: null, after: "Low" },
      {
        kind: "parent",
        before: { repo: "WebJamApps/JaMmusic", number: 1 },
        after: { repo: "WebJamApps/JaMmusic", number: 2 },
      },
    ]
  ) {
    assertEquals(
      validateFindings(findings([finding(1, [change as FindingChange])])).items.length,
      1,
    );
  }
});

Deno.test("malformed changes and ambiguous finding numbers refuse instead of losing proposals", () => {
  const invalidChanges: unknown[] = [
    null,
    [],
    { kind: "close" },
    { kind: "labels", remove: [], add: [] },
    { kind: "labels", remove: ["Flash"], add: ["Flash"] },
    { kind: "labels", remove: ["Flash", "Flash"], add: [] },
    { kind: "labels", remove: "Flash", add: [] },
    { kind: "labels", remove: [], add: [" "] },
    { kind: "milestone", after: "new" },
    { kind: "type", before: null, after: "Unknown" },
    { kind: "priority", before: "Invalid", after: "Low" },
    { kind: "parent", before: null, after: { repo: "JaMmusic", number: 1 } },
    {
      kind: "blocked-by",
      issue: { repo: "WebJamApps/JaMmusic", number: 1 },
      before: false,
      after: false,
    },
    { kind: "body", beforeSha256: "no hash", bodyFile: "/tmp/body.md" },
    { kind: "body", beforeSha256: "a".repeat(64), bodyFile: "" },
    { kind: "labels", remove: ["Flash"], add: [], extra: true },
  ];
  for (const change of invalidChanges) {
    assertThrows(() =>
      validateFindings({ schemaVersion: 1, items: [{ ...finding(), changes: [change] }] })
    );
  }
  for (
    const patch of [
      { issue: 0 },
      { number: -1 },
      { repo: "other" },
      { category: "" },
      { finding: null },
      { reason: "two\nlines" },
      { changes: [] },
      { proposedClose: "true" },
      { proposedClose: true },
      { extra: true },
    ]
  ) assertThrows(() => validateFindings({ schemaVersion: 1, items: [{ ...finding(), ...patch }] }));
  for (
    const value of [null, [], {}, { schemaVersion: 2, items: [] }, {
      schemaVersion: 1,
      items: [],
      flashBatch: null,
    }]
  ) {
    assertThrows(() => validateFindings(value));
  }
  assertThrows(
    () => validateFindings({ ...findings(), flashBatch: [finding()] }),
    Error,
    "duplicate",
  );
});

async function fixture(
  run: (directory: string, file: string, snapshotFile: string) => Promise<void>,
) {
  await Deno.mkdir("/tmp/backlog-groom", { recursive: true });
  const directory = await Deno.makeTempDir({ dir: "/tmp/backlog-groom", prefix: "filter-test-" });
  const file = join(directory, "findings.json");
  const snapshotFile = join(directory, "snapshot.json");
  try {
    await Deno.writeTextFile(file, JSON.stringify(findings()));
    await Deno.writeTextFile(snapshotFile, JSON.stringify(snapshot()));
    await run(directory, file, snapshotFile);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("filter CLI publishes the batch atomically, prints its heading and is idempotent", () =>
  fixture(async (_directory, file, snapshotFile) => {
    const output: string[] = [];
    const options = { log: (line: string) => output.push(line) };
    const args = ["--findings", file, "--snapshot", snapshotFile];
    assertEquals(await runFilterLabelsCli(args, options), 0);
    assertEquals((await readFindings(file)).flashBatch, [finding()]);
    assertStringIncludes(output.join("\n"), FLASH_BATCH_HEADING);
    assertStringIncludes(output.join("\n"), "1: Fixture reason for Josh to review");
    const first = await Deno.readTextFile(file);
    assertEquals(await runFilterLabelsCli(args, options), 0);
    assertEquals(await Deno.readTextFile(file), first);
  }));

for (const invalid of ["unknown issue", "invalid JSON", "invalid snapshot"]) {
  Deno.test(`${invalid} refuses and leaves every findings byte unchanged`, () =>
    fixture(async (_directory, file, snapshotFile) => {
      if (invalid === "unknown issue") {
        await Deno.writeTextFile(
          file,
          JSON.stringify(findings([finding(), { ...finding(2), issue: 999 }])),
        );
      } else if (invalid === "invalid JSON") {
        await Deno.writeTextFile(file, "{broken");
      } else {
        await Deno.writeTextFile(snapshotFile, "{}");
      }
      const before = await Deno.readTextFile(file);
      const errors: string[] = [];
      assertEquals(
        await runFilterLabelsCli(["--findings", file, "--snapshot", snapshotFile], {
          errorLog: (line) => errors.push(line),
        }),
        1,
      );
      assertStringIncludes(errors.join("\n"), "refused");
      assertEquals(await Deno.readTextFile(file), before);
    }));
}

Deno.test("findings writer round-trips changes and refuses paths, symlinks, and invalid data unchanged", () =>
  fixture(async (directory, file) => {
    const input = findings([finding(1, validChanges)]);
    await writeFindings(file, input);
    assertEquals(await readFindings(file), input);
    const before = await Deno.readTextFile(file);
    await assertRejects(() => writeFindings(file, findings([finding(1, [])])));
    assertEquals(await Deno.readTextFile(file), before);
    const link = join(directory, "linked.json");
    await Deno.symlink(file, link);
    await assertRejects(() => readFindings(link), Error, "symlinks");
    await assertRejects(() => writeFindings(link, input), Error, "symlink");
    await Deno.symlink(directory, join(directory, "linked-dir"));
    await assertRejects(
      () => writeFindings(join(directory, "linked-dir/new.json"), input),
      Error,
      "symlinks",
    );
    for (const invalidPath of ["/tmp/elsewhere.json", `${directory}/../escape.json`]) {
      await assertRejects(() => readFindings(invalidPath));
      await assertRejects(() => writeFindings(invalidPath, input));
    }
    const created = join(directory, "new.json");
    await writeFindings(created, input);
    assertEquals(await readFindings(created), input);
    assertEquals(await Deno.readTextFile(file), before);
    const entries = [...Deno.readDirSync(directory)].map((entry) => entry.name);
    assert(!entries.some((name) => name.startsWith(".findings-")));
  }));

Deno.test("CLI rejects missing, unknown and unsafe input paths without writing", () =>
  fixture(async (_directory, file, snapshotFile) => {
    const before = await Deno.readTextFile(file);
    const silent = { log: (_line: string) => {}, errorLog: (_line: string) => {} };
    assertEquals(await runFilterLabelsCli(["--help"], silent), 0);
    for (
      const args of [
        [],
        ["--unknown"],
        ["--findings", file],
        ["--findings", file, "--snapshot", file],
        ["--findings", file, "--snapshot", join(dirname(file), "other", "snapshot.json")],
        ["--findings", file, "--snapshot", snapshotFile, "unexpected"],
        ["--findings", join(dirname(file), "missing.json"), "--snapshot", snapshotFile],
      ]
    ) assertEquals(await runFilterLabelsCli(args, silent), 1);
    assertEquals(await Deno.readTextFile(file), before);
  }));

Deno.test("the actual filter task runs with filesystem-only permissions and no GitHub tool", () =>
  fixture(async (_directory, file, snapshotFile) => {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["task", "backlog-groom:filter-labels", "--findings", file, "--snapshot", snapshotFile],
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    assertStringIncludes(new TextDecoder().decode(result.stdout), FLASH_BATCH_HEADING);
    assertEquals((await readFindings(file)).flashBatch[0].number, 1);
  }));
