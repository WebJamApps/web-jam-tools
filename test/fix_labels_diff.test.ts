// fix_labels_diff.test.ts — web-jam-tools#263
//
// Unit tests for src/fix-labels/diff.ts. No network, no real `gh` binary —
// every `gh` shell-out is exercised through the injected `CommandRunner`
// with a fake implementation (web-jam-tools#263 follow-up: CI's coverage
// gate flagged main()/fetch*/scanRepo as untested since the original PR
// only covered the pure classify function).
//
// Three groups:
//   1. A small synthetic schema exercising each of the five drift kinds,
//      the `keep:` veto, repo scoping (front-end-only wrong-repo, and
//      gig-outreach wrong-repo on a client site), and `neverDelete`
//      (delete-protection only — missing/miscolored still propose
//      create/recolor; only remove/delete is suppressed).
//   2. The REAL skills/fix-labels/labels.yaml loaded via loadSchema(), run
//      against the four real defects from web-jam-tools#263's "What
//      happened" section — the fixtures that must never regress — plus
//      Fable's neverDelete behavior against the real schema.
//   3. The `gh`-shelling half: fetchActualLabels/fetchBlastRadius/
//      attachBlastRadius/scanRepo/main(), all driven by a fake
//      CommandRunner, including the error paths.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type ActualLabel,
  allRepos,
  attachBlastRadius,
  classifyRepoDrift,
  type CommandResult,
  type CommandRunner,
  type DriftItem,
  fetchActualLabels,
  fetchBlastRadius,
  formatReport,
  loadSchema,
  main,
  resolveRepos,
  scanRepo,
  type Schema,
} from "../src/fix-labels/diff.ts";

const LABELS_YAML_PATH = new URL("../skills/fix-labels/labels.yaml", import.meta.url).pathname;

function findByName(items: DriftItem[], name: string): DriftItem | undefined {
  return items.find((i) => i.name === name);
}

// --- Group 1: synthetic schema, one of each drift kind ---

const mockSchema: Schema = {
  repoClasses: {
    frontend: ["FrontA", "FrontB"],
    other: ["OtherA", "OtherB"],
    gigOutreach: ["FrontA", "OtherA"],
  },
  labels: [
    { name: "Alpha", hex: "111111", repos: "all" },
    { name: "Beta", hex: "222222", repos: "all", aliases: ["OLD BETA"] },
    { name: "FrontOnly", hex: "333333", repos: "frontend" },
    { name: "gig-outreach", hex: "444444", repos: "gigOutreach" },
    // Delete-protection only, scoped to frontend — proves neverDelete still
    // proposes create/recolor, and only suppresses remove/delete (tested
    // via presence in OtherA below, where it'd otherwise be wrong-repo).
    { name: "Ghost", hex: "555555", repos: "frontend", neverDelete: true },
  ],
  keep: {
    OtherA: ["special-keep"],
  },
  milestoneTopics: [],
};

Deno.test("resolveRepos: 'all' is frontend + other, in order", () => {
  assertEquals(resolveRepos(mockSchema, "all"), ["FrontA", "FrontB", "OtherA", "OtherB"]);
});

Deno.test("resolveRepos: unknown class throws", () => {
  let threw = false;
  try {
    resolveRepos(mockSchema, "nope");
  } catch {
    threw = true;
  }
  assert(threw, "expected resolveRepos to throw on an unknown repos class");
});

Deno.test("allRepos: every repo, frontend then other", () => {
  assertEquals(allRepos(mockSchema), ["FrontA", "FrontB", "OtherA", "OtherB"]);
});

Deno.test("classifyRepoDrift: a fully-compliant repo has zero drift", () => {
  // FrontA is also in gigOutreach (gig-outreach canonical) and frontend (Ghost canonical).
  const actual: ActualLabel[] = [
    { name: "Alpha", color: "111111" },
    { name: "Beta", color: "222222" },
    { name: "FrontOnly", color: "333333" },
    { name: "gig-outreach", color: "444444" },
    { name: "Ghost", color: "555555" },
  ];
  assertEquals(classifyRepoDrift(mockSchema, "FrontA", actual), []);
});

Deno.test("classifyRepoDrift: MISSING — a canonical label absent from actual", () => {
  const drift = classifyRepoDrift(mockSchema, "FrontA", []);
  const alpha = findByName(drift, "Alpha");
  assertEquals(alpha?.kind, "missing");
  assertEquals(alpha?.action, "create");
  assertEquals(alpha?.hex, "111111");
});

Deno.test("classifyRepoDrift: MISNAMED — a known alias is renamed, not deleted+created", () => {
  const actual: ActualLabel[] = [{ name: "OLD BETA", color: "222222" }];
  const drift = classifyRepoDrift(mockSchema, "FrontA", actual);
  const beta = findByName(drift, "Beta");
  assertEquals(beta?.kind, "misnamed");
  assertEquals(beta?.action, "rename");
  assertEquals(beta?.fromName, "OLD BETA");
  // The alias must not ALSO surface as its own non-canonical delete line.
  assertEquals(findByName(drift, "OLD BETA"), undefined);
});

Deno.test("classifyRepoDrift: MISCOLORED — right name, wrong color", () => {
  const actual: ActualLabel[] = [{ name: "Alpha", color: "999999" }];
  const drift = classifyRepoDrift(mockSchema, "FrontA", actual);
  const alpha = findByName(drift, "Alpha");
  assertEquals(alpha?.kind, "miscolored");
  assertEquals(alpha?.action, "recolor");
  assertEquals(alpha?.fromHex, "999999");
  assertEquals(alpha?.hex, "111111");
});

Deno.test("classifyRepoDrift: WRONG-REPO — front-end-only label present in an 'other' repo", () => {
  const actual: ActualLabel[] = [{ name: "FrontOnly", color: "333333" }];
  const drift = classifyRepoDrift(mockSchema, "OtherA", actual);
  const item = findByName(drift, "FrontOnly");
  assertEquals(item?.kind, "wrong-repo");
  assertEquals(item?.action, "remove");
});

Deno.test("classifyRepoDrift: WRONG-REPO — gig-outreach on a repo outside the booking epic", () => {
  // FrontB is a front-end repo but NOT in gigOutreach's repo list (a "client site").
  const actual: ActualLabel[] = [{ name: "gig-outreach", color: "444444" }];
  const drift = classifyRepoDrift(mockSchema, "FrontB", actual);
  const item = findByName(drift, "gig-outreach");
  assertEquals(item?.kind, "wrong-repo");
  assertEquals(item?.action, "remove");
});

Deno.test("classifyRepoDrift: NON-CANONICAL — a label off the master list entirely", () => {
  const actual: ActualLabel[] = [{ name: "random-label", color: "abcabc" }];
  const drift = classifyRepoDrift(mockSchema, "FrontA", actual);
  const item = findByName(drift, "random-label");
  assertEquals(item?.kind, "non-canonical");
  assertEquals(item?.action, "delete");
});

Deno.test("classifyRepoDrift: keep: list suppresses a non-canonical delete proposal", () => {
  const actual: ActualLabel[] = [{ name: "special-keep", color: "abcabc" }];
  const drift = classifyRepoDrift(mockSchema, "OtherA", actual);
  assertEquals(findByName(drift, "special-keep"), undefined);
});

Deno.test("classifyRepoDrift: neverDelete — missing still proposes CREATE", () => {
  const drift = classifyRepoDrift(mockSchema, "FrontA", []);
  const ghost = findByName(drift, "Ghost");
  assertEquals(ghost?.kind, "missing");
  assertEquals(ghost?.action, "create");
});

Deno.test("classifyRepoDrift: neverDelete — wrong color still proposes RECOLOR", () => {
  const actual: ActualLabel[] = [{ name: "Ghost", color: "999999" }];
  const drift = classifyRepoDrift(mockSchema, "FrontA", actual);
  const ghost = findByName(drift, "Ghost");
  assertEquals(ghost?.kind, "miscolored");
  assertEquals(ghost?.action, "recolor");
});

Deno.test("classifyRepoDrift: neverDelete — NEVER proposed for wrong-repo removal", () => {
  // Ghost is canonical only for "frontend"; OtherA would otherwise flag it
  // wrong-repo (canonical elsewhere) — neverDelete must suppress that.
  const actual: ActualLabel[] = [{ name: "Ghost", color: "555555" }];
  const drift = classifyRepoDrift(mockSchema, "OtherA", actual);
  assertEquals(findByName(drift, "Ghost"), undefined);
});

// --- Group 2: the real labels.yaml + the four live web-jam-tools#263 defects ---

Deno.test("loadSchema: parses the real labels.yaml with the expected shape", async () => {
  const schema = await loadSchema(LABELS_YAML_PATH);
  assertEquals(schema.repoClasses.frontend, [
    "JaMmusic",
    "CollegeLutheran",
    "AppersonAuto",
    "TimShermanMusic",
    "HenricksonForSalem",
  ]);
  assertEquals(schema.repoClasses.other, [
    "web-jam-back",
    "WebJamSocketCluster",
    "web-jam-tools",
  ]);
  // web-jam-tools#300 + follow-up decision: both `backup-restore`
  // (web-jam-tools) and `timshermanmusic` (web-jam-back) were removed from
  // `keep:` — both are topic labels with working milestone replacements now
  // (Josh confirmed `timshermanmusic` IS a canonical topic, resolving the
  // earlier ambiguity flag), so neither is delete-protected anymore.
  assertEquals(schema.keep, {});

  const byName = new Map(schema.labels.map((l) => [l.name, l]));
  assertEquals(byName.get("Haiku")?.hex, "0E8A16");
  assertEquals(byName.get("Haiku")?.modelTier, true);
  assertEquals(byName.get("Sonnet")?.hex, "1D76DB");
  assertEquals(byName.get("Sonnet")?.modelTier, true);
  assertEquals(byName.get("Opus")?.hex, "B392F0");
  assertEquals(byName.get("Opus")?.modelTier, true);
  assertEquals(byName.get("Fable")?.hex, "D93F0B");
  assertEquals(byName.get("Fable")?.neverDelete, true);
  assertEquals(byName.get("Fable")?.modelTier, true);
  assertEquals(byName.get("Flash Med")?.hex, "FBCA04");
  assertEquals(byName.get("Flash Med")?.modelTier, true);
  // Josh's call, 2026-07-31: Flash High and Flash Med are routable in all
  // 8 active repos, not just the 5 front-end ones — see the comment above
  // the `labels:` entries in skills/fix-labels/labels.yaml. Flash Low stays
  // frontend-only pending Josh's open decision on its use case. Assert this
  // explicitly so a future agent can't quietly re-narrow Flash High/Med
  // back to `frontend`.
  assertEquals(byName.get("Flash Med")?.repos, "all");
  assertEquals(byName.get("Flash High")?.hex, "E67E22");
  assertEquals(byName.get("Flash High")?.modelTier, true);
  assertEquals(byName.get("Flash High")?.repos, "all");
  const modelTierNames = schema.labels.filter((l) => l.modelTier).map((l) => l.name).sort();
  assertEquals(modelTierNames, [
    "Fable",
    "Flash High",
    "Flash Med",
    "Haiku",
    "Opus",
    "Sonnet",
  ]);
  assertEquals(byName.get("parked")?.hex, "C2C2C2");
  assertEquals(byName.get("Josh")?.hex, "795548");

  // web-jam-tools#329 "Restore the Blocked label as canonical in
  // labels.yaml — it was pruned in a batch Josh never ratified, and he
  // wants it alongside native dependencies": `Blocked` (capital B) is
  // canonical again, scoped to every repo, matching the label already
  // live in web-jam-tools.
  assertEquals(byName.get("Blocked")?.hex, "B60205");
  assertEquals(byName.get("Blocked")?.repos, "all");
  assertEquals(resolveRepos(schema, byName.get("Blocked")!.repos), allRepos(schema));

  // web-jam-tools#300: pruned labels (native-field/milestone/type
  // replacements now exist) must be gone from the canonical schema
  // entirely. Lowercase `blocked` stays pruned — web-jam-tools#329 restored
  // it as `Blocked` (capital B), a distinct canonical name; the old
  // lowercase spelling is not resurrected and is still a non-canonical
  // delete candidate if it ever turns up live (see the dedicated test
  // below).
  for (
    const pruned of [
      "Top Priority",
      "High Priority",
      "Low Priority",
      "blocked",
      "gig-outreach",
      "bug",
      "enhancement",
    ]
  ) {
    assertEquals(byName.get(pruned), undefined, `expected "${pruned}" to be pruned`);
  }

  // web-jam-tools#300: canonical topic milestones, replacing the pruned
  // `gig-outreach` label, the pruned `backup-restore` keep-list entry, and
  // (follow-up decision) the pruned `timshermanmusic` keep-list entry.
  // web-jam-tools#315 added "Access Controls" across all 8 active repos.
  // The seven `song-recordings`.."politics" topics are from Josh's list on
  // web-jam-tools#287 "fix-labels skill expanded / corrected" — created live
  // as milestones on 2026-07-31 and registered here the same day.
  assertEquals(schema.milestoneTopics.map((t) => t.name), [
    "gig-outreach",
    "backup-restore",
    "timshermanmusic",
    "Access Controls",
    "AI Misbehaves",
    "song-recordings",
    "set-lists",
    "promote-gigs",
    "venue-mining",
    "financial",
    "health-wellness",
    "politics",
  ]);
  const accessControlsTopic = schema.milestoneTopics.find(
    (t) => t.name === "Access Controls",
  );
  assertEquals(accessControlsTopic?.repos.length, 8);
  const gigOutreachTopic = schema.milestoneTopics.find((t) => t.name === "gig-outreach");
  assertEquals(gigOutreachTopic?.repos, [
    "JaMmusic",
    "web-jam-back",
    "web-jam-tools",
    "WebJamSocketCluster",
  ]);
  const backupRestoreTopic = schema.milestoneTopics.find((t) => t.name === "backup-restore");
  assertEquals(backupRestoreTopic?.repos, ["web-jam-tools"]);
  const timShermanMusicTopic = schema.milestoneTopics.find((t) => t.name === "timshermanmusic");
  assertEquals(timShermanMusicTopic?.repos, ["web-jam-back", "JaMmusic", "WebJamSocketCluster"]);
  const aiMisbehavesTopic = schema.milestoneTopics.find(
    (t) => t.name === "AI Misbehaves",
  );
  assertEquals(aiMisbehavesTopic?.repos, ["web-jam-tools"]);

  // web-jam-tools#287: the seven new topics each carry exactly the same four
  // repos (not `all`) — JaMmusic, web-jam-back, WebJamSocketCluster, and
  // web-jam-tools — matching the convention already used for
  // `Access Controls` and `AI Misbehaves` (each asserted its own repo
  // scope above).
  const fourRepoTopicNames = [
    "song-recordings",
    "set-lists",
    "promote-gigs",
    "venue-mining",
    "financial",
    "health-wellness",
    "politics",
  ];
  for (const name of fourRepoTopicNames) {
    const topic = schema.milestoneTopics.find((t) => t.name === name);
    assertEquals(
      topic?.repos,
      ["JaMmusic", "web-jam-back", "WebJamSocketCluster", "web-jam-tools"],
      `expected "${name}" to be scoped to exactly the 4 booking-epic repos`,
    );
  }
});

Deno.test("web-jam-tools#300: a pruned priority label still present on GitHub is now a non-canonical delete candidate", async () => {
  const schema = await loadSchema(LABELS_YAML_PATH);
  const actual: ActualLabel[] = [
    { name: "High Priority", color: "0d13bf" },
    { name: "Low Priority", color: "21ddbc" },
  ];
  const drift = classifyRepoDrift(schema, "JaMmusic", actual);

  const high = findByName(drift, "High Priority");
  assertEquals(high?.kind, "non-canonical");
  assertEquals(high?.action, "delete");

  const low = findByName(drift, "Low Priority");
  assertEquals(low?.kind, "non-canonical");
  assertEquals(low?.action, "delete");
});

Deno.test("web-jam-tools#300: a pruned lowercase `blocked` label still present on GitHub is now a non-canonical delete candidate", async () => {
  // Distinct from the capitalized `Blocked`, which web-jam-tools#329
  // restored as canonical below — this only proves the OLD lowercase
  // spelling stays retired, not that `blocked` in general is non-canonical.
  const schema = await loadSchema(LABELS_YAML_PATH);
  const actual: ActualLabel[] = [{ name: "blocked", color: "0206d8" }];
  const drift = classifyRepoDrift(schema, "CollegeLutheran", actual);

  const blocked = findByName(drift, "blocked");
  assertEquals(blocked?.kind, "non-canonical");
  assertEquals(blocked?.action, "delete");
});

Deno.test("web-jam-tools#329: `Blocked` (capital B) is canonical in every active repo — missing yields CREATE at #B60205", async () => {
  const schema = await loadSchema(LABELS_YAML_PATH);
  for (const repo of allRepos(schema)) {
    const drift = classifyRepoDrift(schema, repo, []); // Blocked absent from actual
    const blocked = findByName(drift, "Blocked");
    assertEquals(blocked?.kind, "missing", `expected Blocked missing/create in ${repo}`);
    assertEquals(blocked?.action, "create");
    assertEquals(blocked?.hex, "B60205");
  }
});

Deno.test("web-jam-tools#329: `Blocked` already live at the right color is fully compliant (no drift) — matches the ad hoc web-jam-tools label", async () => {
  const schema = await loadSchema(LABELS_YAML_PATH);
  const drift = classifyRepoDrift(schema, "web-jam-tools", [
    { name: "Blocked", color: "B60205" },
  ]);
  assertEquals(findByName(drift, "Blocked"), undefined);
});

Deno.test("web-jam-tools#329: `Blocked` present but wrong color is MISCOLORED, not delete+create", async () => {
  const schema = await loadSchema(LABELS_YAML_PATH);
  const drift = classifyRepoDrift(schema, "JaMmusic", [{ name: "Blocked", color: "cccccc" }]);
  const blocked = findByName(drift, "Blocked");
  assertEquals(blocked?.kind, "miscolored");
  assertEquals(blocked?.action, "recolor");
  assertEquals(blocked?.fromHex, "cccccc");
  assertEquals(blocked?.hex, "B60205");
});

Deno.test("web-jam-tools#329: `Blocked` is scoped `repos: all`, so it is never a wrong-repo removal candidate in any active repo", async () => {
  const schema = await loadSchema(LABELS_YAML_PATH);
  for (const repo of allRepos(schema)) {
    const drift = classifyRepoDrift(schema, repo, [{ name: "Blocked", color: "B60205" }]);
    const blocked = findByName(drift, "Blocked");
    assertEquals(blocked, undefined, `expected no Blocked drift (esp. no wrong-repo) in ${repo}`);
  }
});

Deno.test("web-jam-tools 2026-07-31: `Flash High` and `Flash Med` are scoped `repos: all`, so they are never wrong-repo removal candidates in web-jam-back or WebJamSocketCluster", async () => {
  // Regression test for the standing trap described on the dispatch that
  // widened these two labels: `Flash High` had been `repos: frontend`,
  // so `deno task fix-labels:diff` kept proposing REMOVE for it in
  // web-jam-back and WebJamSocketCluster, where web-jam-back#991 "Remove
  // PUT /venue/:id once all callers use PATCH" legitimately carries it.
  const schema = await loadSchema(LABELS_YAML_PATH);
  for (const repo of ["web-jam-back", "WebJamSocketCluster"]) {
    const actual: ActualLabel[] = [
      { name: "Flash High", color: "E67E22" },
      { name: "Flash Med", color: "FBCA04" },
    ];
    const drift = classifyRepoDrift(schema, repo, actual);
    assertEquals(
      findByName(drift, "Flash High"),
      undefined,
      `expected no Flash High drift (esp. no wrong-repo) in ${repo}`,
    );
    assertEquals(
      findByName(drift, "Flash Med"),
      undefined,
      `expected no Flash Med drift (esp. no wrong-repo) in ${repo}`,
    );
  }
});

Deno.test("real defect 3: TimShermanMusic single 'Flash' — split proposes BOTH Flash Med and Flash High, deletes old Flash", async () => {
  const schema = await loadSchema(LABELS_YAML_PATH);
  const actual: ActualLabel[] = [{ name: "Flash", color: "cccccc" }];
  const drift = classifyRepoDrift(schema, "TimShermanMusic", actual);

  const flashMed = findByName(drift, "Flash Med");
  assertEquals(flashMed?.kind, "missing");
  assertEquals(flashMed?.action, "create");

  const flashHigh = findByName(drift, "Flash High");
  assertEquals(flashHigh?.kind, "missing");
  assertEquals(flashHigh?.action, "create");

  const flash = findByName(drift, "Flash");
  assertEquals(flash?.kind, "non-canonical");
  assertEquals(flash?.action, "delete");
});

Deno.test("real defect 4: 'Flash High' at #D93F0B (the Fable color) is flagged MISCOLORED in every front-end repo", async () => {
  const schema = await loadSchema(LABELS_YAML_PATH);
  for (const repo of schema.repoClasses.frontend) {
    const actual: ActualLabel[] = [{ name: "Flash High", color: "D93F0B" }];
    const drift = classifyRepoDrift(schema, repo, actual);
    const item = findByName(drift, "Flash High");
    assertEquals(item?.kind, "miscolored", `expected Flash High miscolored in ${repo}`);
    assertEquals(item?.fromHex, "D93F0B");
    assertEquals(item?.hex, "E67E22");
  }
});

Deno.test("Fable (delete-protection only): missing from a repo yields a CREATE line", async () => {
  const schema = await loadSchema(LABELS_YAML_PATH);
  const drift = classifyRepoDrift(schema, "JaMmusic", []); // Fable absent from actual
  const fable = findByName(drift, "Fable");
  assertEquals(fable?.kind, "missing");
  assertEquals(fable?.action, "create");
  assertEquals(fable?.hex, "D93F0B");
});

Deno.test("Fable (delete-protection only): wrong hex yields a RECOLOR line", async () => {
  const schema = await loadSchema(LABELS_YAML_PATH);
  const actual: ActualLabel[] = [{ name: "Fable", color: "abcdef" }];
  const drift = classifyRepoDrift(schema, "JaMmusic", actual);
  const fable = findByName(drift, "Fable");
  assertEquals(fable?.kind, "miscolored");
  assertEquals(fable?.action, "recolor");
  assertEquals(fable?.fromHex, "abcdef");
  assertEquals(fable?.hex, "D93F0B");
});

Deno.test("Fable (delete-protection only): never appears as a DELETE/REMOVE line", async () => {
  const schema = await loadSchema(LABELS_YAML_PATH);
  // Fable is canonical ("all") in every repo, so it can only ever be
  // consumed (matched/miscolored) or missing — assert that holds across
  // every repo, for every drift item that happens to be named "Fable".
  for (const repo of allRepos(schema)) {
    const actual: ActualLabel[] = [{ name: "Fable", color: "D93F0B" }];
    const drift = classifyRepoDrift(schema, repo, actual);
    const fable = findByName(drift, "Fable");
    // Compliant everywhere: no drift item at all.
    assertEquals(fable, undefined, `expected no Fable drift in ${repo}`);
  }
  // The general neverDelete mechanism proven directly (mockSchema, Group 1)
  // is what guarantees this holds even if Fable's scope ever narrows.
});

// --- Report formatting ---

Deno.test("formatReport: no-drift repo prints 'no changes'", () => {
  const report = formatReport({ CollegeLutheran: [] }, new Date("2026-07-25T12:00:00Z"));
  assert(report.includes("### CollegeLutheran"));
  assert(report.includes("no changes"));
});

Deno.test("formatReport: matches the SKILL.md report-format line shapes (all 5 actions)", () => {
  const perRepo: Record<string, DriftItem[]> = {
    JaMmusic: [
      { kind: "missing", action: "create", name: "blocked", hex: "E11D21" },
      {
        kind: "misnamed",
        action: "rename",
        name: "Top Priority",
        hex: "000000",
        fromName: "TOP PRIORITY",
        fromHex: "000000",
      },
      {
        kind: "miscolored",
        action: "recolor",
        name: "Flash High",
        hex: "E67E22",
        fromHex: "D93F0B",
      },
      { kind: "wrong-repo", action: "remove", name: "Flash Med", blastRadius: 5 },
      { kind: "non-canonical", action: "delete", name: "codex", blastRadius: 2 },
    ],
  };
  const report = formatReport(perRepo, new Date("2026-07-25T12:00:00Z"));
  assert(report.includes("- CREATE `blocked` (#E11D21) — missing"));
  assert(
    report.includes("- RENAME `TOP PRIORITY` → `Top Priority` (color also updates to #000000)"),
  );
  assert(report.includes("- RECOLOR `Flash High` #D93F0B → #E67E22 — miscolored"));
  assert(
    report.includes(
      "- REMOVE `Flash Med` — wrong-repo (not canonical for this repo) — 5 open issues carry this label",
    ),
  );
  assert(report.includes("- DELETE `codex` — non-canonical — 2 open issues carry this label"));
});

// --- Group 3: the `gh`-shelling half, via a fake CommandRunner ---

/** Minimal fake `gh` runner: serves `label list` and `issue list` from fixtures. */
function makeFakeRunner(
  labelsByRepo: Record<string, ActualLabel[]>,
  blastRadiusByKey: Record<string, number> = {},
): CommandRunner {
  return (args: string[]): Promise<CommandResult> => {
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx >= 0 ? args[repoIdx + 1].split("/")[1] : "";
    if (args[0] === "label" && args[1] === "list") {
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify(labelsByRepo[repo] ?? []),
        stderr: "",
      });
    }
    if (args[0] === "issue" && args[1] === "list") {
      const labelIdx = args.indexOf("--label");
      const label = args[labelIdx + 1];
      const n = blastRadiusByKey[`${repo}::${label}`] ?? 0;
      return Promise.resolve({ code: 0, stdout: String(n), stderr: "" });
    }
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: `fake runner: unrecognized gh args: ${args.join(" ")}`,
    });
  };
}

/** Temporarily swap console.log/console.error and capture what they were called with. */
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

/** Write `yaml` to a temp file, run `fn(path)`, and always clean up. */
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
`;

Deno.test("fetchActualLabels: parses gh label list JSON via the injected runner", async () => {
  const runner = makeFakeRunner({ RepoA: [{ name: "Widget", color: "111111" }] });
  const labels = await fetchActualLabels("RepoA", runner);
  assertEquals(labels, [{ name: "Widget", color: "111111" }]);
});

Deno.test("fetchActualLabels: throws a formatted error when gh exits non-zero", async () => {
  const runner: CommandRunner = () =>
    Promise.resolve({ code: 1, stdout: "", stderr: "repo not found" });
  await assertRejects(() => fetchActualLabels("Nope", runner), Error, "gh label list");
});

Deno.test("fetchBlastRadius: parses the numeric jq output", async () => {
  const runner: CommandRunner = () => Promise.resolve({ code: 0, stdout: "3\n", stderr: "" });
  assertEquals(await fetchBlastRadius("RepoA", "junk", runner), 3);
});

Deno.test("fetchBlastRadius: throws when gh output isn't numeric", async () => {
  const runner: CommandRunner = () =>
    Promise.resolve({ code: 0, stdout: "not-a-number", stderr: "" });
  await assertRejects(
    () => fetchBlastRadius("RepoA", "junk", runner),
    Error,
    "unexpected gh output",
  );
});

Deno.test("attachBlastRadius: attaches counts only to remove/delete items", async () => {
  const runner = makeFakeRunner({}, { "RepoA::junk": 5 });
  const items: DriftItem[] = [
    { kind: "missing", action: "create", name: "Widget", hex: "111111" },
    { kind: "non-canonical", action: "delete", name: "junk" },
  ];
  const out = await attachBlastRadius("RepoA", items, runner);
  assertEquals(out[0].blastRadius, undefined);
  assertEquals(out[1].blastRadius, 5);
});

Deno.test("scanRepo: fetches actual labels, classifies, and attaches blast radius end-to-end", async () => {
  const runner = makeFakeRunner(
    { FrontA: [{ name: "random-label", color: "zzzzzz" }] },
    { "FrontA::random-label": 4 },
  );
  const drift = await scanRepo(mockSchema, "FrontA", runner);
  const junk = findByName(drift, "random-label");
  assertEquals(junk?.kind, "non-canonical");
  assertEquals(junk?.blastRadius, 4);
});

Deno.test("main: prints the report format and returns 0 on a clean scan", async () => {
  await withTempSchema(MINIMAL_SCHEMA_YAML, async (schemaPath) => {
    const runner = makeFakeRunner({
      RepoA: [{ name: "Widget", color: "111111" }],
      RepoB: [{ name: "Widget", color: "111111" }],
    });
    const { logs, errors } = await withConsole(async () => {
      const code = await main([], runner, schemaPath);
      assertEquals(code, 0);
    });
    assertEquals(errors, []);
    assertEquals(logs.length, 1);
    assert(logs[0].includes("## fix-labels report"));
    assert(logs[0].includes("### RepoA"));
    assert(logs[0].includes("no changes"));
  });
});

Deno.test("main: --json prints the raw per-repo drift list", async () => {
  await withTempSchema(MINIMAL_SCHEMA_YAML, async (schemaPath) => {
    const runner = makeFakeRunner({
      RepoA: [],
      RepoB: [{ name: "Widget", color: "111111" }],
    });
    const { logs } = await withConsole(async () => {
      const code = await main(["--json"], runner, schemaPath);
      assertEquals(code, 0);
    });
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.RepoA[0].kind, "missing");
    assertEquals(parsed.RepoA[0].name, "Widget");
    assertEquals(parsed.RepoB, []);
  });
});

Deno.test("main: a delete/remove line's blast radius comes from the injected runner", async () => {
  await withTempSchema(MINIMAL_SCHEMA_YAML, async (schemaPath) => {
    const runner = makeFakeRunner(
      {
        RepoA: [{ name: "Widget", color: "111111" }, { name: "junk", color: "abcabc" }],
        RepoB: [],
      },
      { "RepoA::junk": 7 },
    );
    const { logs } = await withConsole(async () => {
      await main(["--json"], runner, schemaPath);
    });
    const parsed = JSON.parse(logs[0]);
    // deno-lint-ignore no-explicit-any
    const junk = (parsed.RepoA as any[]).find((i) => i.name === "junk");
    assertEquals(junk.blastRadius, 7);
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
