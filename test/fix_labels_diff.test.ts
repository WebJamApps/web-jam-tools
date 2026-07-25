// fix_labels_diff.test.ts — web-jam-tools#263
//
// Unit tests for src/fix-labels/diff.ts's pure classify function. No
// network, no `gh` — every test here hand-builds a schema/actual-labels
// fixture and asserts the computed drift, the thing the old prose-eyeballing
// skill could get wrong silently.
//
// Two groups:
//   1. A small synthetic schema exercising each of the five drift kinds,
//      the `keep:` veto, and repo scoping (front-end-only wrong-repo, and
//      gig-outreach wrong-repo on a client site).
//   2. The REAL skills/fix-labels/labels.yaml loaded via loadSchema(), run
//      against the four real defects from web-jam-tools#263's "What
//      happened" section — the fixtures that must never regress.

import { assert, assertEquals } from "@std/assert";
import {
  type ActualLabel,
  allRepos,
  classifyRepoDrift,
  type DriftItem,
  formatReport,
  loadSchema,
  resolveRepos,
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
    { name: "Ghost", hex: "555555", repos: "all", neverTouch: true },
  ],
  keep: {
    OtherA: ["special-keep"],
  },
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
  // FrontA is also in gigOutreach, so gig-outreach is canonical here too.
  const actual: ActualLabel[] = [
    { name: "Alpha", color: "111111" },
    { name: "Beta", color: "222222" },
    { name: "FrontOnly", color: "333333" },
    { name: "gig-outreach", color: "444444" },
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

Deno.test("classifyRepoDrift: neverTouch — no proposal at all, even miscolored", () => {
  const actual: ActualLabel[] = [{ name: "Ghost", color: "000000" }];
  const drift = classifyRepoDrift(mockSchema, "FrontA", actual);
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
  assertEquals(schema.repoClasses.gigOutreach, [
    "JaMmusic",
    "web-jam-back",
    "WebJamSocketCluster",
    "web-jam-tools",
  ]);
  assertEquals(schema.keep["web-jam-back"], ["timshermanmusic"]);
  assertEquals(schema.keep["web-jam-tools"], ["backup-restore"]);

  const byName = new Map(schema.labels.map((l) => [l.name, l]));
  assertEquals(byName.get("Haiku")?.hex, "0E8A16");
  assertEquals(byName.get("Sonnet")?.hex, "1D76DB");
  assertEquals(byName.get("Opus")?.hex, "B392F0");
  assertEquals(byName.get("Fable")?.hex, "D93F0B");
  assertEquals(byName.get("Fable")?.neverTouch, true);
  assertEquals(byName.get("Flash Med")?.hex, "FBCA04");
  assertEquals(byName.get("Flash High")?.hex, "E67E22");
  assertEquals(byName.get("Top Priority")?.hex, "000000");
  assertEquals(byName.get("Top Priority")?.aliases, ["TOP PRIORITY"]);
  assertEquals(byName.get("High Priority")?.hex, "E8590C");
  assertEquals(byName.get("High Priority")?.aliases, ["High"]);
  assertEquals(byName.get("Low Priority")?.hex, "FFEC99");
  assertEquals(byName.get("Low Priority")?.aliases, ["Low"]);
  assertEquals(byName.get("blocked")?.hex, "E11D21");
  assertEquals(byName.get("parked")?.hex, "C2C2C2");
  assertEquals(byName.get("gig-outreach")?.hex, "006B75");
  assertEquals(byName.get("bug")?.hex, "D73A4A");
  assertEquals(byName.get("enhancement")?.hex, "A2EEEF");
});

Deno.test("real defect 1: JaMmusic High/Low Priority miscolored — must classify MISCOLORED, not missing", async () => {
  const schema = await loadSchema(LABELS_YAML_PATH);
  const actual: ActualLabel[] = [
    { name: "High Priority", color: "0d13bf" },
    { name: "Low Priority", color: "21ddbc" },
  ];
  const drift = classifyRepoDrift(schema, "JaMmusic", actual);

  const high = findByName(drift, "High Priority");
  assertEquals(high?.kind, "miscolored");
  assertEquals(high?.fromHex, "0d13bf");
  assertEquals(high?.hex, "E8590C");

  const low = findByName(drift, "Low Priority");
  assertEquals(low?.kind, "miscolored");
  assertEquals(low?.fromHex, "21ddbc");
  assertEquals(low?.hex, "FFEC99");
});

Deno.test("real defect 2: CollegeLutheran `blocked` exists miscolored — must classify MISCOLORED, never MISSING", async () => {
  const schema = await loadSchema(LABELS_YAML_PATH);
  const actual: ActualLabel[] = [{ name: "blocked", color: "0206d8" }];
  const drift = classifyRepoDrift(schema, "CollegeLutheran", actual);

  const blocked = findByName(drift, "blocked");
  assertEquals(blocked?.kind, "miscolored");
  assertEquals(blocked?.action, "recolor");
  assertEquals(blocked?.fromHex, "0206d8");
  assertEquals(blocked?.hex, "E11D21");
  // The original run's bug: this must never be "missing" / "create" — that's
  // what produced the swallowed "label already exists" create failure.
  assert(blocked?.kind !== "missing");
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

// --- Report formatting ---

Deno.test("formatReport: no-drift repo prints 'no changes'", () => {
  const report = formatReport({ CollegeLutheran: [] }, new Date("2026-07-25T12:00:00Z"));
  assert(report.includes("### CollegeLutheran"));
  assert(report.includes("no changes"));
});

Deno.test("formatReport: matches the SKILL.md report-format line shapes", () => {
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
      { kind: "non-canonical", action: "delete", name: "codex", blastRadius: 2 },
    ],
  };
  const report = formatReport(perRepo, new Date("2026-07-25T12:00:00Z"));
  assert(report.includes("- CREATE `blocked` (#E11D21) — missing"));
  assert(
    report.includes("- RENAME `TOP PRIORITY` → `Top Priority` (color also updates to #000000)"),
  );
  assert(report.includes("- DELETE `codex` — non-canonical — 2 open issues carry this label"));
});
