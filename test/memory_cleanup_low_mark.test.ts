// test/memory_cleanup_low_mark.test.ts — web-jam-tools#1242
//
// Tests for src/memory-cleanup/low_mark.ts: merge keeps both texts, a move is accepted
// only word for word, a guard rule is never touched, an ask-first removal acts only on
// Josh's yes, removal is a move to the archive, and a dry run writes nothing.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  appearsWordForWord,
  type LowMarkPlan,
  markGuardRaw,
  runCli,
  runLowMark,
} from "../src/memory-cleanup/low_mark.ts";
import { loadLimits } from "../src/session-load/report.ts";
import { readLowMarkPlan, REMOVAL_REASONS } from "../src/memory-cleanup/plan.ts";

const FIXTURE = new URL("./fixtures/memory-cleanup-low-mark", import.meta.url).pathname;

function memory(slug: string, body: string, extra = ""): string {
  return `---\nname: ${slug}\ndescription: "${slug} description"\nmetadata:\n  type: feedback\n${extra}---\n\n${body}\n`;
}

async function sandbox(files: Record<string, string>): Promise<{ dir: string; home: string }> {
  const home = await Deno.makeTempDir({ prefix: "low-mark-home-" });
  const dir = join(home, "memory");
  await Deno.mkdir(join(dir, "skills", "demo-skill"), { recursive: true });
  for (const [name, text] of Object.entries(files)) await Deno.writeTextFile(join(dir, name), text);
  return { dir, home };
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      for (const [name, text] of Object.entries(await snapshot(path))) {
        out[`${entry.name}/${name}`] = text;
      }
    } else out[entry.name] = await Deno.readTextFile(path);
  }
  return out;
}

const run = (
  dir: string,
  home: string,
  plan: LowMarkPlan,
  more: { approved?: string[]; dryRun?: boolean } = {},
) =>
  runLowMark({
    dir,
    plan,
    skillsDir: join(dir, "skills"),
    report: { homeDir: home, webJamAppsDir: join(home, "apps") },
    ...more,
  });

Deno.test("appearsWordForWord: ignores whitespace, refuses a changed word", () => {
  assert(appearsWordForWord("a b   c\n d e", "b c d"));
  assert(!appearsWordForWord("a b c d", "b d"));
  assert(!appearsWordForWord("abc d", "bc d"));
  assert(!appearsWordForWord("anything", "   "));
});

Deno.test("markGuardRaw: adds guard under metadata, with or without a metadata block", () => {
  assertStringIncludes(
    markGuardRaw(memory("a", "body")),
    "metadata:\n  guard: true\n  type: feedback",
  );
  assertStringIncludes(
    markGuardRaw("---\nname: a\n---\nbody\n"),
    "name: a\nmetadata:\n  guard: true\n---\nbody",
  );
});

Deno.test("merge: the surviving file keeps the full text of both, the other goes to the archive", async () => {
  const { dir, home } = await sandbox({
    "keep.md": memory("keep", "First text of the keeper."),
    "dupe.md": memory("dupe", "Second text from the duplicate."),
  });
  const result = await run(dir, home, { merges: [{ keep: "keep", absorb: ["dupe"] }] });

  const merged = await Deno.readTextFile(join(dir, "keep.md"));
  assertStringIncludes(merged, "First text of the keeper.");
  assertStringIncludes(merged, "Second text from the duplicate.");
  assertStringIncludes(merged, "dupe description");
  assertStringIncludes(merged, "## Merged from dupe");
  assertEquals(result.rows.map((r) => r.status), ["merged"]);
  assertStringIncludes(await Deno.readTextFile(join(dir, "archive", "dupe.md")), "Second text");
  assert(!(await Deno.stat(join(dir, "dupe.md")).then(() => true, () => false)));
  assertStringIncludes(await Deno.readTextFile(join(dir, "MEMORY.md")), "keep");
});

Deno.test("move: accepted only when the text appears word for word; otherwise REFUSES", async () => {
  const { dir, home } = await sandbox({
    "in-skill.md": memory("in-skill", "Run the   demo skill\nbefore release."),
    "not-in-skill.md": memory("not-in-skill", "A sentence the skill does not hold."),
  });
  await Deno.writeTextFile(
    join(dir, "skills", "demo-skill", "SKILL.md"),
    "# demo\n\nRun the demo skill before release.\n",
  );
  const before = await Deno.readTextFile(join(dir, "not-in-skill.md"));
  const result = await run(dir, home, {
    moves: [
      { slug: "in-skill", target_skill: "demo-skill" },
      { slug: "not-in-skill", target_skill: "demo-skill" },
    ],
  });

  assertEquals(result.rows.map((r) => [r.slug, r.status]), [
    ["in-skill", "moved"],
    ["not-in-skill", "refused"],
  ]);
  assertEquals(await Deno.readTextFile(join(dir, "not-in-skill.md")), before);
  assert(await Deno.stat(join(dir, "archive", "in-skill.md")).then(() => true, () => false));
});

Deno.test("guard rule: never offered, merged, moved or removed, and byte-identical after a run", async () => {
  const guard = memory("guard", "Never delete a remote branch.", "  guard: true\n");
  const { dir, home } = await sandbox({
    "guard.md": guard,
    "other.md": memory("other", "Other text."),
  });
  await Deno.writeTextFile(
    join(dir, "skills", "demo-skill", "SKILL.md"),
    "Never delete a remote branch.",
  );
  const result = await run(dir, home, {
    merges: [{ keep: "other", absorb: ["guard"] }],
    moves: [{ slug: "guard", target_skill: "demo-skill" }],
    removals: [{ slug: "guard", reason: "already-said", evidence: "CLAUDE.md" }],
  }, { approved: ["guard"] });

  assertEquals(result.rows.filter((r) => r.slug === "guard").length, 3);
  assert(result.rows.every((r) => r.status === "refused"));
  assertEquals(await Deno.readTextFile(join(dir, "guard.md")), guard);
  assertEquals(await Deno.readTextFile(join(dir, "other.md")), memory("other", "Other text."));
});

Deno.test("guard marking: names each newly marked slug and protects it from other rows", async () => {
  const { dir, home } = await sandbox({ "gate.md": memory("gate", "Ask before pushing.") });
  const result = await run(dir, home, {
    guards: [{ slug: "gate", kind: "approval-gate" }],
    removals: [{ slug: "gate", reason: "hook-enforced", evidence: "a hook" }],
  }, { approved: ["gate"] });

  assertEquals(result.rows.map((r) => [r.slug, r.status]), [["gate", "marked"], [
    "gate",
    "refused",
  ]]);
  assertStringIncludes(await Deno.readTextFile(join(dir, "gate.md")), "  guard: true");
  assertStringIncludes(result.text, "Newly marked as guard rules: 1");
});

Deno.test("ask-first removal: untouched without Josh's yes, archived (never deleted) with it", async () => {
  const text = memory("hooked", "A hook enforces this.");
  const plan: LowMarkPlan = {
    removals: [{ slug: "hooked", reason: "hook-enforced", evidence: "a hook" }],
  };
  const { dir, home } = await sandbox({ "hooked.md": text });

  const waiting = await run(dir, home, plan);
  assertEquals(waiting.rows.map((r) => r.status), ["waiting"]);
  assertEquals(await Deno.readTextFile(join(dir, "hooked.md")), text);

  const approved = await run(dir, home, plan, { approved: ["hooked"] });
  assertEquals(approved.rows.map((r) => r.status), ["archived"]);
  assertEquals(await Deno.readTextFile(join(dir, "archive", "hooked.md")), text);
});

Deno.test("dry run on the fixture: prints the after-run list and writes nothing", async () => {
  const before = await snapshot(FIXTURE);
  const home = await Deno.makeTempDir({ prefix: "low-mark-home-" });
  const result = await runLowMark({
    dir: FIXTURE,
    plan: JSON.parse(await Deno.readTextFile(join(FIXTURE, "low-mark-plan.json"))),
    skillsDir: join(FIXTURE, "skills"),
    dryRun: true,
    report: { homeDir: home, webJamAppsDir: join(home, "apps") },
  });

  assertEquals(await snapshot(FIXTURE), before);
  assertEquals(result.rows.map((r) => r.status).sort(), ["merged", "moved", "refused", "waiting"]);
  assertStringIncludes(result.text, "dry run, nothing written");
  assertStringIncludes(result.text, "Part sizes against their limits:");
});

Deno.test("part sizes: limits come from limits.json and low_mark.ts restates none", async () => {
  const { dir, home } = await sandbox({ "a.md": memory("a", "text") });
  const limits = await loadLimits();
  const result = await run(dir, home, {});
  assertStringIncludes(
    result.partLines.join("\n"),
    limits.memoryIndex.overMark.toLocaleString("en-US"),
  );

  const source = await Deno.readTextFile(
    new URL("../src/memory-cleanup/low_mark.ts", import.meta.url),
  );
  for (const n of [6500, 7500, 14300, 18900, 20000, 24000, 9700, 14000, 10000]) {
    assert(
      !new RegExp(`\\b${n}\\b|\\b${n.toLocaleString("en-US")}\\b`).test(source),
      `restates ${n}`,
    );
  }
});

Deno.test("runCli: a missing plan file fails with exit 1; --help exits 0", async () => {
  const { dir } = await sandbox({});
  assertEquals(await runCli(["--dir", dir]), 1);
  assertEquals(await runCli(["--help"]), 0);
});

Deno.test("guard marking: existing false or inline metadata gets one guard key, survives a second run", async () => {
  const falseGuard = memory("flagged", "Ask first.", "  guard: false\n");
  const inline = `---\nname: inl\ndescription: d\nmetadata: { type: feedback }\n---\n\nInline.\n`;
  const { dir, home } = await sandbox({ "flagged.md": falseGuard, "inl.md": inline });
  const plan: LowMarkPlan = {
    guards: [{ slug: "flagged", kind: "approval-gate" }, { slug: "inl", kind: "deletion-guard" }],
    removals: [
      { slug: "flagged", reason: "already-said", evidence: "x" },
      { slug: "inl", reason: "already-said", evidence: "x" },
    ],
  };
  const first = await run(dir, home, plan);
  assertEquals(first.rows.filter((r) => r.status === "marked").length, 2);
  for (const slug of ["flagged", "inl"]) {
    const text = await Deno.readTextFile(join(dir, `${slug}.md`));
    assertEquals(text.match(/guard:/g)?.length, 1);
    assertStringIncludes(text, "guard: true");
  }

  const second = await run(dir, home, {
    removals: plan.removals,
  }, { approved: ["flagged", "inl"] });
  assert(second.rows.every((r) => r.status === "refused"));
  assert(!(await exists(join(dir, "archive", "flagged.md"))));
  assertStringIncludes(await Deno.readTextFile(join(dir, "MEMORY.md")), "flagged");
});

Deno.test("unparseable frontmatter fails closed: never marked, merged, moved or removed", async () => {
  const broken = `---\nname: bad\nmetadata:\n  guard: true\n  guard: false\n---\n\nBroken.\n`;
  const { dir, home } = await sandbox({ "bad.md": broken });
  const result = await run(dir, home, {
    guards: [{ slug: "bad", kind: "approval-gate" }],
    removals: [{ slug: "bad", reason: "already-said", evidence: "x" }],
  }, { approved: ["bad"] });
  assert(result.rows.every((r) => r.status === "refused"));
  assertEquals(result.rows.length, 2);
  assertEquals(await Deno.readTextFile(join(dir, "bad.md")), broken);
});

Deno.test("cleanup moves done checkpoints to resume records and keeps guarded checkpoints immutable", async () => {
  const checkpoint = (slug: string, extra: string) =>
    `---\nname: ${slug}\ndescription: d\nmetadata:\n  type: project\n  status: done\n${extra}---\n\nBody.\n`;
  const { dir, home } = await sandbox({
    "keeper.md": memory("keeper", "Keeper."),
    "dupe.md": memory("dupe", "Dupe."),
    "session-checkpoint-guard.md": checkpoint("session-checkpoint-guard", "  guard: true\n"),
    "session-checkpoint-plain.md": checkpoint("session-checkpoint-plain", ""),
  });
  const result = await run(dir, home, { merges: [{ keep: "keeper", absorb: ["dupe"] }] });

  assert(await exists(join(dir, "session-checkpoint-guard.md")));
  assert(!await exists(join(dir, "session-checkpoint-plain.md")));
  assertEquals(
    await Deno.readTextFile(
      join(home, "Dropbox/web-jam-llms/resume-records/done/session-checkpoint-plain.md"),
    ),
    checkpoint("session-checkpoint-plain", ""),
  );
  const memoryMd = await Deno.readTextFile(join(dir, "MEMORY.md"));
  assertStringIncludes(memoryMd, "session-checkpoint-guard");
  assert(!memoryMd.includes("session-checkpoint-plain"));
  assert(result.rows.some((r) => r.slug === "session-checkpoint-guard" && r.status === "refused"));
  assert(
    result.rows.some((r) => r.slug === "session-checkpoint-plain" && r.status === "checkpoint"),
  );
});

Deno.test("part sizes: each installed skill description is listed with its own size, below and above its limit", async () => {
  const limits = await loadLimits();
  const over = limits.skillDescription.overMark + 5;
  const { dir, home } = await sandbox({ "a.md": memory("a", "text") });
  const skill = (root: string, name: string, length: number) =>
    Deno.mkdir(join(root, name), { recursive: true }).then(() =>
      Deno.writeTextFile(
        join(root, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${"x".repeat(length)}\n---\nbody\n`,
      )
    );
  const claude = join(home, ".claude/skills");
  const agy = join(home, ".gemini/config/plugins/webjam-tasks/skills");
  await skill(claude, "short", 20);
  await skill(claude, "medium", 150);
  await skill(agy, "long", over);

  const text = (await run(dir, home, {})).partLines.join("\n");
  const line = (name: string) => text.split("\n").find((l) => l.includes(name)) ?? "";
  const short = line("Claude Code skills: short");
  const medium = line("Claude Code skills: medium");
  assertStringIncludes(short, " 20 ");
  assertStringIncludes(short, "ok");
  assertStringIncludes(medium, " 150 ");
  assertStringIncludes(medium, "ok");
  assertStringIncludes(line("agy skills: long"), String(over));
  assertStringIncludes(line("agy skills: long"), "OVER");
  assertStringIncludes(line("Codex skills"), "no skills installed");
  assertStringIncludes(line("Claude Code bundled"), "OVER");
  assertStringIncludes(line("Claude Code bundled"), String(limits.bundledSkills.totalCount));
});

Deno.test("a guard whose marking fails stays protected from merge, move and approved removal", async () => {
  const scalar = `---\nname: odd\ndescription: d\nmetadata: invalid-scalar\n---\n\nOdd.\n`;
  const { dir, home } = await sandbox({
    "odd.md": scalar,
    "keeper.md": memory("keeper", "Keeper."),
  });
  await Deno.writeTextFile(join(dir, "skills", "demo-skill", "SKILL.md"), "Odd.");
  const result = await run(dir, home, {
    guards: [{ slug: "odd", kind: "approval-gate" }],
    merges: [{ keep: "keeper", absorb: ["odd"] }],
    moves: [{ slug: "odd", target_skill: "demo-skill" }],
    removals: [{ slug: "odd", reason: "already-said", evidence: "x" }],
  }, { approved: ["odd"] });

  assert(result.rows.every((r) => r.status === "refused"));
  assertEquals(result.rows.filter((r) => r.slug === "odd").length, 4);
  assertEquals(await Deno.readTextFile(join(dir, "odd.md")), scalar);
  assert(!(await exists(join(dir, "archive", "odd.md"))));
});

Deno.test("unterminated frontmatter is unreadable: never marked, merged, moved or removed", async () => {
  const open = `---\nname: open\nmetadata:\n  guard: true\n\nNo closing delimiter.\n`;
  const { dir, home } = await sandbox({ "open.md": open, "keeper.md": memory("keeper", "K.") });
  const plain = await run(dir, home, {
    merges: [{ keep: "keeper", absorb: ["open"] }],
    removals: [{ slug: "open", reason: "already-said", evidence: "x" }],
  }, { approved: ["open"] });
  assert(plain.rows.every((r) => r.status === "refused"));
  assertEquals(await Deno.readTextFile(join(dir, "open.md")), open);

  const marked = await run(dir, home, { guards: [{ slug: "open", kind: "deletion-guard" }] });
  assert(marked.rows.every((r) => r.status === "refused"));
  assertEquals(await Deno.readTextFile(join(dir, "open.md")), open);
  assertEquals(markGuardRaw("body only\n").startsWith("---\nmetadata:\n  guard: true"), true);
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("a classified guard on a done checkpoint stays put when its mark cannot be written and an unrelated merge regenerates the index", async () => {
  const checkpoint =
    `---\nname: gate\ndescription: d\nmetadata:\n  type: project\n  status: done\n  guard: false\n---\n\nBody.\n`;
  const { dir, home } = await sandbox({
    "session-checkpoint-gate.md": checkpoint,
    "keeper.md": memory("keeper", "Keeper."),
    "dupe.md": memory("dupe", "Dupe."),
  });
  const gatePath = join(dir, "session-checkpoint-gate.md");
  await Deno.chmod(gatePath, 0o444);
  try {
    const result = await run(dir, home, {
      guards: [{ slug: "session-checkpoint-gate", kind: "approval-gate" }],
      merges: [{ keep: "keeper", absorb: ["dupe"] }],
    });
    assert(result.rows.some((r) => r.status === "merged"));
    assert(
      result.rows.some((r) =>
        r.slug === "session-checkpoint-gate" && r.status === "refused" &&
        /not marked/.test(r.detail)
      ),
    );
    assert(await exists(gatePath));
    assert(!(await exists(join(dir, "archive", "session-checkpoint-gate.md"))));
    assert(!result.rows.some((r) => r.status === "archived"));
    assertStringIncludes(
      await Deno.readTextFile(join(dir, "MEMORY.md")),
      "session-checkpoint-gate",
    );
  } finally {
    await Deno.chmod(gatePath, 0o644);
  }
});

Deno.test("all removal reasons wait for their own approval and archive exact original bytes", async () => {
  const files = Object.fromEntries(
    REMOVAL_REASONS.map((reason) => [`${reason}.md`, memory(reason, `Evidence for ${reason}.`)]),
  );
  const { dir, home } = await sandbox(files);
  const plan: LowMarkPlan = {
    removals: REMOVAL_REASONS.map((reason) => ({
      slug: reason,
      reason,
      evidence: `source for ${reason}`,
    })),
  };
  const waiting = await run(dir, home, plan);
  assertEquals(
    waiting.rows.filter((row) => row.status === "waiting").length,
    REMOVAL_REASONS.length,
  );
  for (const reason of REMOVAL_REASONS) {
    assertEquals(await Deno.readTextFile(join(dir, `${reason}.md`)), files[`${reason}.md`]);
  }
  const approved = await run(dir, home, plan, { approved: [...REMOVAL_REASONS] });
  assertEquals(
    approved.rows.filter((row) => row.status === "archived").length,
    REMOVAL_REASONS.length,
  );
  for (const reason of REMOVAL_REASONS) {
    assertEquals(
      await Deno.readTextFile(join(dir, "archive", `${reason}.md`)),
      files[`${reason}.md`],
    );
  }
});

Deno.test("plan reader rejects malformed, unknown, traversal and unsupported removal rows before any write", async () => {
  for (
    const plan of [
      null,
      [],
      { moves: "bad" },
      { removals: [{ slug: "a", reason: "anything", evidence: "source" }] },
      { removals: [{ slug: "../outside", reason: "obsolete", evidence: "source" }] },
      { removals: [{ slug: "a", reason: "obsolete", evidence: " " }] },
      { approvals: ["a"] },
      { merges: [{ keep: "a", absorb: [] }] },
    ]
  ) {
    assertThrows(() => readLowMarkPlan(plan));
  }
  const { dir, home } = await sandbox({ "a.md": memory("a", "A.") });
  const before = await snapshot(dir);
  const planPath = join(home, "invalid.json");
  await Deno.writeTextFile(
    planPath,
    JSON.stringify({ removals: [{ slug: "a", reason: "unknown", evidence: "x" }] }),
  );
  assertEquals(await runCli(["--dir", dir, "--plan", planPath]), 1);
  await assertRejects(() => run(dir, home, {}, { approved: ["a"] }));
  assertEquals(await snapshot(dir), before);
});

Deno.test("active checkpoints move without approval; dry runs and destination collisions preserve both files", async () => {
  const text = memory("session-checkpoint-active", "Full resume text with [[links]].");
  const { dir, home } = await sandbox({ "session-checkpoint-active.md": text });
  const before = await snapshot(dir);
  const preview = await run(dir, home, {}, { dryRun: true });
  assert(preview.rows.some((row) => row.status === "checkpoint"));
  assertEquals(await snapshot(dir), before);
  const resume = join(home, "Dropbox/web-jam-llms/resume-records");
  assert(!await exists(resume));
  await Deno.mkdir(resume, { recursive: true });
  await Deno.writeTextFile(join(resume, "session-checkpoint-active.md"), "Older record");
  const collision = await run(dir, home, {});
  assert(
    collision.rows.some((row) => row.status === "refused" && row.detail.includes("already exists")),
  );
  assertEquals(await Deno.readTextFile(join(dir, "session-checkpoint-active.md")), text);
  assertEquals(
    await Deno.readTextFile(join(resume, "session-checkpoint-active.md")),
    "Older record",
  );
  const destination = join(home, "separate-resume");
  await runLowMark({
    dir,
    skillsDir: join(dir, "skills"),
    plan: {},
    resumeDir: destination,
    report: { homeDir: home },
  });
  assertEquals(await Deno.readTextFile(join(destination, "session-checkpoint-active.md")), text);
  assert(!await exists(join(dir, "session-checkpoint-active.md")));
});

Deno.test("merges and skill moves repoint exact links and aliases, list guard references and preserve archive links", async () => {
  const guard = memory("guard", "Keep [[dupe]] and [[move#Details|label]].", "  guard: true\n");
  const { dir, home } = await sandbox({
    "keeper.md": memory("keeper", "Keeper."),
    "dupe.md": memory("dupe", "Full duplicate."),
    "move.md": memory("move", "Skill words."),
    "remove.md": memory("remove", "Old."),
    "guard.md": guard,
    "links.md": memory(
      "links",
      "[[dupe]] [[dupe#Details|label]] [[move]] [[move|alias]] [[dupe-other]] [[remove]] [[dupe.md|file]] [[move.md#Details]]",
    ),
  });
  await Deno.writeTextFile(join(dir, "skills/demo-skill/SKILL.md"), "Skill words.");
  const plan: LowMarkPlan = {
    merges: [{ keep: "keeper", absorb: ["dupe"] }],
    moves: [{ slug: "move", target_skill: "demo-skill" }],
    removals: [{ slug: "remove", reason: "obsolete", evidence: "retired" }],
  };
  const before = await snapshot(dir);
  const preview = await run(dir, home, plan, { dryRun: true, approved: ["remove"] });
  assert(preview.rows.some((row) => row.status === "guard-link" && row.slug === "guard"));
  assertEquals(await snapshot(dir), before);
  const result = await run(dir, home, plan, { approved: ["remove"] });
  const links = await Deno.readTextFile(join(dir, "links.md"));
  assertStringIncludes(
    links,
    "[[keeper]] [[keeper#Details|label]] [[demo-skill]] [[demo-skill|alias]] [[dupe-other]] [[remove]] [[keeper|file]] [[demo-skill#Details]]",
  );
  assertEquals(await Deno.readTextFile(join(dir, "guard.md")), guard);
  assert(result.rows.some((row) => row.status === "guard-link" && row.slug === "guard"));
  assertStringIncludes(await Deno.readTextFile(join(dir, "archive/dupe.md")), "Full duplicate.");
});

Deno.test("low mark projection names sufficient pending rows and matches the generator after approval", async () => {
  const files: Record<string, string> = {};
  const slugs = Array.from(
    { length: 110 },
    (_, i) => `memory-${i.toString().padStart(3, "0")}-${"x".repeat(56)}`,
  );
  for (const slug of slugs) files[`${slug}.md`] = memory(slug, "Ordinary memory.");
  const { dir, home } = await sandbox(files);
  const plan: LowMarkPlan = {
    removals: slugs.slice(0, 50).map((slug) => ({
      slug,
      reason: "work-state",
      evidence: "finished issue",
    })),
  };
  const preview = await run(dir, home, plan, { dryRun: true });
  const projection = preview.indexReport;
  assert(projection.bytes > projection.lowMark);
  assert(projection.approvalRows.length > 0 && projection.approvalRows.length < 50);
  assert(projection.reachable);
  assert(projection.projectedBytes <= projection.lowMark);
  for (const slug of projection.approvalRows) assertStringIncludes(preview.text, slug);
  const actual = await run(dir, home, plan, { approved: projection.approvalRows });
  const indexBytes =
    new TextEncoder().encode(await Deno.readTextFile(join(dir, "MEMORY.md"))).length;
  assertEquals(indexBytes, projection.projectedBytes);
  assertEquals(actual.indexReport.bytes, indexBytes);
  assertEquals(actual.indexReport.approvalRows, []);
});

Deno.test("insufficient approval rows or unparseable files never claim the low mark is reachable", async () => {
  const long = "x".repeat(90);
  const files: Record<string, string> = {};
  for (let i = 0; i < 80; i++) {
    files[`memory-${i}-${long}.md`] = memory(`memory-${i}-${long}`, "Text.");
  }
  const { dir, home } = await sandbox(files);
  const result = await run(dir, home, {});
  assert(!result.indexReport.reachable);
  assertStringIncludes(result.text, "Cannot confirm the low mark");
  const bad = await sandbox({ "bad.md": "---\ninvalid: [\n---\nBody." });
  assert(!(await run(bad.dir, bad.home, {})).indexReport.reachable);
});

Deno.test("a merge whose survivor is a guard is refused without archiving either memory", async () => {
  const guard = memory("guard", "Approval gate.", "  guard: true\n");
  const other = memory("other", "Ordinary rule.");
  const { dir, home } = await sandbox({ "guard.md": guard, "other.md": other });
  const result = await run(dir, home, { merges: [{ keep: "guard", absorb: ["other"] }] });
  assert(result.rows.some((row) => row.slug === "guard" && row.status === "refused"));
  assertEquals(await Deno.readTextFile(join(dir, "guard.md")), guard);
  assertEquals(await Deno.readTextFile(join(dir, "other.md")), other);
  assert(!await exists(join(dir, "archive")));
});

Deno.test("runCli resolves plan-relative resume paths and requires approval for obsolete memories", async () => {
  const { dir, home } = await sandbox({
    "session-checkpoint-live.md": memory("checkpoint", "Continue here."),
    "old.md": memory("old", "Obsolete rule."),
  });
  const planPath = join(home, "plan.json");
  await Deno.writeTextFile(
    planPath,
    JSON.stringify({
      resume_dir: "resume",
      removals: [{ slug: "old", reason: "obsolete", evidence: "retired design" }],
    }),
  );
  const previousHome = Deno.env.get("HOME");
  Deno.env.set("HOME", home);
  try {
    assertEquals(await runCli(["--dir", dir, "--plan", planPath, "--dry-run"]), 0);
    assert(!await exists(join(home, "resume")));
    assertEquals(await runCli(["--dir", dir, "--plan", planPath, "--approve", "old"]), 0);
    assert(await exists(join(home, "resume/session-checkpoint-live.md")));
    assert(await exists(join(dir, "archive/old.md")));
  } finally {
    if (previousHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", previousHome);
  }
});

Deno.test("invalid resume locations, including symlink aliases, refuse before marking guards", async () => {
  const original = memory("gate", "Ask first.");
  const { dir, home } = await sandbox({ "gate.md": original });
  const alias = join(home, "alias");
  await Deno.symlink(dir, alias);
  for (const resumeDir of [dir, join(dir, "nested"), join(alias, "nested")]) {
    await assertRejects(
      () =>
        runLowMark({
          dir,
          resumeDir,
          skillsDir: join(dir, "skills"),
          plan: { guards: [{ slug: "gate", kind: "approval-gate" }] },
          report: { homeDir: home },
        }),
      Error,
      "outside the memory folder",
    );
    assertEquals(await Deno.readTextFile(join(dir, "gate.md")), original);
  }
});

Deno.test("an archive collision is refused rather than offered as a pending approval row", async () => {
  const text = memory("old", "Keep both versions.");
  const { dir, home } = await sandbox({ "old.md": text });
  await Deno.mkdir(join(dir, "archive"));
  await Deno.writeTextFile(join(dir, "archive/old.md"), "Older archive");
  const result = await run(dir, home, {
    removals: [{ slug: "old", reason: "work-state", evidence: "finished issue" }],
  });
  assert(result.rows.some((row) => row.slug === "old" && row.status === "refused"));
  assert(!result.rows.some((row) => row.status === "waiting"));
  assertEquals(await Deno.readTextFile(join(dir, "old.md")), text);
  assertEquals(await Deno.readTextFile(join(dir, "archive/old.md")), "Older archive");
});
