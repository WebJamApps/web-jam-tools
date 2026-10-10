// test/memory_cleanup_low_mark.test.ts — web-jam-tools#1242
//
// Tests for src/memory-cleanup/low_mark.ts: merge keeps both texts, a move is accepted
// only word for word, a guard rule is never touched, an ask-first removal acts only on
// Josh's yes, removal is a move to the archive, and a dry run writes nothing.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  appearsWordForWord,
  type LowMarkPlan,
  markGuardRaw,
  runCli,
  runLowMark,
} from "../src/memory-cleanup/low_mark.ts";
import { loadLimits } from "../src/session-load/report.ts";

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

Deno.test("index regeneration: a guarded done checkpoint stays, an unguarded one is reported", async () => {
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
  assertStringIncludes(await Deno.readTextFile(join(dir, "MEMORY.md")), "session-checkpoint-guard");
  assert(await exists(join(dir, "archive", "session-checkpoint-plain.md")));
  assert(
    result.rows.some((r) =>
      r.status === "archived" && r.slug === "session-checkpoint-plain" &&
      /memory index run/.test(r.detail)
    ),
  );
  assert(!result.rows.some((r) => r.slug === "session-checkpoint-guard"));
});

Deno.test("part sizes: every surface's skill descriptions and the bundled skills are listed, below and above their limits", async () => {
  const limits = await loadLimits();
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
  await skill(agy, "long", limits.skillDescription.overMark + 5);

  const text = (await run(dir, home, {})).partLines.join("\n");
  const line = (name: string) => text.split("\n").find((l) => l.includes(name)) ?? "";
  assertStringIncludes(line("Claude Code skills"), "20");
  assertStringIncludes(line("Claude Code skills"), "ok");
  assertStringIncludes(line("agy skills"), "OVER");
  assertStringIncludes(line("Codex skills"), "ok");
  assertStringIncludes(line("Claude Code bundled"), "OVER");
  assertStringIncludes(line("Claude Code bundled"), String(limits.bundledSkills.totalCount));
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
