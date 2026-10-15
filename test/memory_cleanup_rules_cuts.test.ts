import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  parseRulesCutsPlan,
  planRulesCuts,
  type RulesCutsPlan,
  type RulesPart,
  runCli,
  runRulesCuts,
} from "../src/memory-cleanup/rules_cuts.ts";
import { loadLimits } from "../src/session-load/report.ts";

const FIXTURES = new URL("./fixtures/rules-cuts/", import.meta.url).pathname;
const SKILLS = join(FIXTURES, "skills");

async function fixture() {
  const source = await Deno.readTextFile(join(FIXTURES, "AGENTS.md"));
  const plan = parseRulesCutsPlan(JSON.parse(await Deno.readTextFile(join(FIXTURES, "plan.json"))));
  return { source, plan };
}

Deno.test("rules cuts preserve rules, verify moved instructions, remove backstory and retain one repeat", async () => {
  const { source, plan } = await fixture();
  const result = await planRulesCuts(source, plan, SKILLS);
  assertEquals(result.after, "# Fixture rules\n\nAlways preserve the rule text.\n\n");
  assertEquals(result.rulesBefore, result.rulesAfter);
  assert(result.afterBytes < result.beforeBytes);
  assert(result.afterBytes <= (await loadLimits()).mainRules.lowMark!);
  assertStringIncludes(result.report, "Rules before:");
  assertStringIncludes(result.report, "Rules after:");
  assertStringIncludes(result.report, "Rules unchanged: yes");
});

Deno.test("the registered task previews the fixture without changing any fixture file", async () => {
  const paths = ["AGENTS.md", "plan.json", "skills/draft-pr/SKILL.md"].map((p) =>
    join(FIXTURES, p)
  );
  const before = await Promise.all(paths.map((p) => Deno.readFile(p)));
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "task",
      "memory-cleanup:rules-cuts",
      "--dry-run",
      "--plan",
      join(FIXTURES, "plan.json"),
      "--file",
      paths[0],
    ],
    cwd: new URL("../", import.meta.url),
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  assertStringIncludes(new TextDecoder().decode(result.stdout), "Dry run: nothing written");
  assertEquals(await Promise.all(paths.map((p) => Deno.readFile(p))), before);
});

Deno.test("removing backstory cannot concatenate adjacent rules into different words", async () => {
  const plan: RulesCutsPlan = {
    part: "mainRules",
    spans: [
      { id: "first", kind: "rule", text: "Never delete files." },
      { id: "story", kind: "backstory", text: "\nAn origin story.\n" },
      { id: "second", kind: "rule", text: "Always use drafts." },
    ],
  };
  const result = await planRulesCuts(plan.spans.map((s) => s.text).join(""), plan, SKILLS);
  assertEquals(result.after, "Never delete files.\n\nAlways use drafts.");
  assertEquals(result.rulesBefore, result.rulesAfter);
});

async function withPlan(
  test: (filePath: string, planPath: string, source: string, plan: RulesCutsPlan) => Promise<void>,
) {
  const dir = await Deno.makeTempDir({ prefix: "rules-cuts-" });
  try {
    const { source, plan } = await fixture();
    plan.skills_dir = SKILLS;
    const filePath = join(dir, "AGENTS.md");
    const planPath = join(dir, "plan.json");
    await Deno.writeTextFile(filePath, source);
    await Deno.writeTextFile(planPath, JSON.stringify(plan));
    await test(filePath, planPath, source, plan);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a plan that drops a rule exits nonzero and leaves the source untouched", async () => {
  await withPlan(async (filePath, planPath, source, plan) => {
    plan.spans[1].action = "drop";
    await Deno.writeTextFile(planPath, JSON.stringify(plan));
    assertEquals(await runCli(["--plan", planPath, "--file", filePath]), 1);
    assertEquals(await Deno.readTextFile(filePath), source);
  });
});

Deno.test("incomplete, stale, reordered, or overlapping source classifications refuse without writes", async () => {
  for (const mutation of ["omitted", "stale", "reordered", "overlapping"]) {
    await withPlan(async (filePath, planPath, source, plan) => {
      if (mutation === "omitted") plan.spans.splice(2, 1);
      if (mutation === "stale") await Deno.writeTextFile(filePath, source + "New rule.\n");
      if (mutation === "reordered") plan.spans.reverse();
      if (mutation === "overlapping") plan.spans.push({ id: "extra", kind: "rule", text: source });
      await Deno.writeTextFile(planPath, JSON.stringify(plan));
      const before = await Deno.readTextFile(filePath);
      await assertRejects(
        () => runRulesCuts({ filePath, planPath }),
        Error,
        "entire current file exactly",
      );
      assertEquals(await Deno.readTextFile(filePath), before);
    });
  }
});

Deno.test("missing and reworded target skills refuse the move and leave the rules file intact", async () => {
  for (const target of ["missing-skill", "draft-pr"]) {
    await withPlan(async (filePath, planPath, source, plan) => {
      plan.spans[2].target_skill = target;
      if (target === "draft-pr") {
        plan.spans[2].text = "Open changes through an approved pull request.\n\n";
        await Deno.writeTextFile(filePath, plan.spans.map((s) => s.text).join(""));
      }
      await Deno.writeTextFile(planPath, JSON.stringify(plan));
      const before = await Deno.readTextFile(filePath);
      await assertRejects(
        () => runRulesCuts({ filePath, planPath }),
        Error,
        target === "missing-skill" ? "SKILL.md" : "word for word",
      );
      assertEquals(await Deno.readTextFile(filePath), before);
      assert(target !== "missing-skill" || before === source);
    });
  }
});

Deno.test("moves allow whitespace wrapping but preserve every word and punctuation", async () => {
  const { plan } = await fixture();
  plan.spans[2].text = "Open changes\nthrough a draft pull request.\n\n";
  const source = plan.spans.map((span) => span.text).join("");
  const result = await planRulesCuts(source, plan, SKILLS);
  assertEquals(result.rulesBefore, result.rulesAfter);
});

Deno.test("repeats must match an actual retained rule; cycles and references to removed spans refuse", async () => {
  for (const repeatedId of ["absent", "repeat", "story", "move"]) {
    const { source, plan } = await fixture();
    plan.spans[4].repeats = repeatedId;
    await assertRejects(() => planRulesCuts(source, plan, SKILLS), Error, "retained rule span");
  }
  const { plan } = await fixture();
  plan.spans[4].text = "Always preserve a different rule.\n\n";
  await assertRejects(
    () => planRulesCuts(plan.spans.map((s) => s.text).join(""), plan, SKILLS),
    Error,
    "retained rule span",
  );
});

Deno.test("limits come from canonical limits.json for all three parts and count UTF-8 bytes", async () => {
  const limits = await loadLimits();
  for (const part of ["mainRules", "crossAiRules", "jammusicRules"] as const) {
    const { source, plan } = await fixture();
    plan.part = part;
    const result = await planRulesCuts(source, plan, SKILLS);
    assertEquals(result.lowMark, limits[part].lowMark);
    assertEquals(result.overMark, limits[part].overMark);
    const text = "é".repeat(Math.floor(limits[part].lowMark! / 2) + 1);
    assert(text.length < limits[part].lowMark!);
    const overResult = await planRulesCuts(
      text,
      { part, spans: [{ id: "keep", kind: "rule", text }] },
      SKILLS,
    );
    assertEquals(overResult.after, text);
    assert(overResult.afterBytes > limits[part].lowMark!);
    assertStringIncludes(
      overResult.report,
      `${overResult.afterBytes - limits[part].lowMark!} bytes over low mark`,
    );
  }
  await assertRejects(
    () =>
      planRulesCuts("Only story", {
        part: "mainRules",
        spans: [{ id: "story", kind: "backstory", text: "Only story" }],
      }, SKILLS),
    Error,
    "retain at least one rule",
  );
});

Deno.test("acceptance: rule span kept unchanged is present in result, before and after rule lists match", async () => {
  const plan: RulesCutsPlan = {
    part: "mainRules",
    spans: [
      { id: "keep1", kind: "rule", text: "Rule number one.\n\n" },
      { id: "keep2", kind: "rule", text: "Rule number two.\n" },
    ],
  };
  const source = plan.spans.map((s) => s.text).join("");
  const result = await planRulesCuts(source, plan, SKILLS);
  assertEquals(result.after, "Rule number one.\n\nRule number two.\n");
  assertEquals(result.rulesBefore, result.rulesAfter);
  assertEquals(result.rulesBefore, ["Rule number one.\n\n", "Rule number two.\n"]);
  assertStringIncludes(result.report, "Rules unchanged: yes");
});

Deno.test("acceptance: skill-instruction word for word in SKILL.md is removed from rules file", async () => {
  const plan: RulesCutsPlan = {
    part: "mainRules",
    spans: [
      { id: "rule1", kind: "rule", text: "Keep this rule.\n\n" },
      {
        id: "instruct",
        kind: "skill-instruction",
        text: "Open changes through a draft pull request.\n\n",
        target_skill: "draft-pr",
      },
      { id: "rule2", kind: "rule", text: "Keep this rule too.\n" },
    ],
  };
  const source = plan.spans.map((s) => s.text).join("");
  const result = await planRulesCuts(source, plan, SKILLS);
  assertEquals(result.after, "Keep this rule.\n\nKeep this rule too.\n");
  assert(!result.after.includes("draft pull request"));
  assertEquals(result.rulesBefore, result.rulesAfter);
});

Deno.test("acceptance: skill-instruction absent or reworded in target skill refuses cut", async () => {
  const plan: RulesCutsPlan = {
    part: "mainRules",
    spans: [
      { id: "rule1", kind: "rule", text: "Keep this rule.\n\n" },
      {
        id: "instruct",
        kind: "skill-instruction",
        text: "This instruction is not in the draft-pr skill.\n\n",
        target_skill: "draft-pr",
      },
    ],
  };
  const source = plan.spans.map((s) => s.text).join("");
  await assertRejects(
    () => planRulesCuts(source, plan, SKILLS),
    Error,
    "does not appear word for word",
  );
});

Deno.test("acceptance: scoped-rule word for word in target skill is removed and after list names it as moved", async () => {
  const plan: RulesCutsPlan = {
    part: "mainRules",
    spans: [
      { id: "r1", kind: "rule", text: "Keep this rule.\n\n" },
      {
        id: "scoped1",
        kind: "scoped-rule",
        text: "Open changes through a draft pull request.\n\n",
        target_skill: "draft-pr",
      },
    ],
  };
  const source = plan.spans.map((s) => s.text).join("");
  const result = await planRulesCuts(source, plan, SKILLS);
  assertEquals(result.after, "Keep this rule.\n\n");
  assert(!result.after.includes("draft pull request"));
  assertEquals(result.rulesBefore, [
    "Keep this rule.\n\n",
    "Open changes through a draft pull request.\n\n",
  ]);
  assertEquals(result.rulesAfter, [
    "Keep this rule.\n\n",
    "[moved to draft-pr] Open changes through a draft pull request.\n\n",
  ]);
  assertStringIncludes(result.rulesAfter[1], "moved to draft-pr");
  assertStringIncludes(result.report, "moved to draft-pr");
  assertStringIncludes(result.report, "Rules unchanged: no");
});

Deno.test("acceptance: scoped-rule marked as approval or safety rule refuses cut", async () => {
  for (
    const patch of [
      { guard: true },
      { safety: true },
      { approval: true },
      { reason: "approval" },
      { reason: "safety" },
      { reason: "approval-gate" },
      { reason: "deletion-guard" },
      { reason: "credential-rule" },
      { reason: "spending-rule" },
    ]
  ) {
    const plan: RulesCutsPlan = {
      part: "mainRules",
      spans: [
        { id: "r1", kind: "rule", text: "Keep this rule.\n\n" },
        {
          id: "scoped1",
          kind: "scoped-rule",
          text: "Open changes through a draft pull request.\n\n",
          target_skill: "draft-pr",
          ...patch,
        },
      ],
    };
    const source = plan.spans.map((s) => s.text).join("");
    await assertRejects(
      () => planRulesCuts(source, plan, SKILLS),
      Error,
      "Approval and safety rules cannot be moved into a skill",
    );
  }
});

Deno.test("acceptance: reworded span with replacement and approved: true replaces text and shows change in after list", async () => {
  const plan: RulesCutsPlan = {
    part: "mainRules",
    spans: [
      { id: "r1", kind: "rule", text: "Keep this rule.\n\n" },
      {
        id: "rew1",
        kind: "reworded",
        text:
          "This is a very long, verbose, complicated sentence stating a simple requirement.\n\n",
        replacement: "Short requirement.\n\n",
        approved: true,
      },
    ],
  };
  const source = plan.spans.map((s) => s.text).join("");
  const result = await planRulesCuts(source, plan, SKILLS);
  assertEquals(result.after, "Keep this rule.\n\nShort requirement.\n\n");
  assertStringIncludes(result.after, "Short requirement.");
  assert(!result.after.includes("verbose"));
  assertEquals(result.rulesBefore, [
    "Keep this rule.\n\n",
    "This is a very long, verbose, complicated sentence stating a simple requirement.\n\n",
  ]);
  assertEquals(result.rulesAfter, [
    "Keep this rule.\n\n",
    "[reworded] Short requirement.\n\n",
  ]);
  assertStringIncludes(result.report, "[reworded] Short requirement.");
});

Deno.test("acceptance: reworded span with approved: false or no approved keeps original rule", async () => {
  for (const approvedVal of [false, undefined]) {
    const plan: RulesCutsPlan = {
      part: "mainRules",
      spans: [
        { id: "r1", kind: "rule", text: "Keep this rule.\n\n" },
        {
          id: "rew1",
          kind: "reworded",
          text: "Original verbose rule text.\n\n",
          replacement: "Short.\n\n",
          approved: approvedVal,
        },
      ],
    };
    const source = plan.spans.map((s) => s.text).join("");
    const result = await planRulesCuts(source, plan, SKILLS);
    assertEquals(result.after, "Keep this rule.\n\nOriginal verbose rule text.\n\n");
    assertStringIncludes(result.after, "Original verbose rule text.");
    assert(!result.after.includes("Short."));
    assertEquals(result.rulesBefore, result.rulesAfter);
    assertEquals(result.rulesAfter, ["Keep this rule.\n\n", "Original verbose rule text.\n\n"]);
  }
});

Deno.test("acceptance: removed-rule span with approved: true and reason obsolete/hook-enforced is removed and named in after list", async () => {
  for (const reason of ["obsolete", "hook-enforced"]) {
    const plan: RulesCutsPlan = {
      part: "mainRules",
      spans: [
        { id: "r1", kind: "rule", text: "Keep this rule.\n\n" },
        {
          id: "rem1",
          kind: "removed-rule",
          text: "Old rule that is no longer needed.\n\n",
          reason,
          approved: true,
        },
      ],
    };
    const source = plan.spans.map((s) => s.text).join("");
    const result = await planRulesCuts(source, plan, SKILLS);
    assertEquals(result.after, "Keep this rule.\n\n");
    assert(!result.after.includes("Old rule"));
    assertEquals(result.rulesBefore, [
      "Keep this rule.\n\n",
      "Old rule that is no longer needed.\n\n",
    ]);
    assertEquals(result.rulesAfter, [
      "Keep this rule.\n\n",
      `[removed: ${reason}] Old rule that is no longer needed.\n\n`,
    ]);
    assertStringIncludes(result.rulesAfter[1], `removed: ${reason}`);
    assertStringIncludes(result.report, `[removed: ${reason}]`);
  }
});

Deno.test("acceptance: removed-rule span without approved: true keeps original rule", async () => {
  for (const approvedVal of [false, undefined]) {
    const plan: RulesCutsPlan = {
      part: "mainRules",
      spans: [
        { id: "r1", kind: "rule", text: "Keep this rule.\n\n" },
        {
          id: "rem1",
          kind: "removed-rule",
          text: "Rule proposed for removal.\n\n",
          reason: "obsolete",
          approved: approvedVal,
        },
      ],
    };
    const source = plan.spans.map((s) => s.text).join("");
    const result = await planRulesCuts(source, plan, SKILLS);
    assertEquals(result.after, "Keep this rule.\n\nRule proposed for removal.\n\n");
    assertStringIncludes(result.after, "Rule proposed for removal.");
    assertEquals(result.rulesBefore, result.rulesAfter);
  }
});

Deno.test("acceptance: result above low mark makes cut and names remaining bytes over low mark without refusal", async () => {
  const limits = await loadLimits();
  const part = "mainRules";
  const lowMark = limits[part].lowMark!;
  const filler = "Rule text that exceeds the low mark. ".repeat(Math.ceil(lowMark / 30));
  const plan: RulesCutsPlan = {
    part,
    spans: [{ id: "bigRule", kind: "rule", text: filler }],
  };
  const result = await planRulesCuts(filler, plan, SKILLS);
  assertEquals(result.after, filler);
  assert(result.afterBytes > lowMark);
  const remaining = result.afterBytes - lowMark;
  assertStringIncludes(result.report, `${remaining} bytes over low mark`);
});

Deno.test("check 3: fixture plan holding one span of each kind lists before and after, names moved, reworded, and removed rows, and names bytes over low mark", async () => {
  const limits = await loadLimits();
  const lowMark = limits.mainRules.lowMark!;
  const bigRuleText = "A".repeat(lowMark + 50);
  const plan: RulesCutsPlan = {
    part: "mainRules",
    skills_dir: SKILLS,
    spans: [
      { id: "r1", kind: "rule", text: "First rule.\n\n" },
      { id: "story", kind: "backstory", text: "A backstory paragraph.\n\n" },
      {
        id: "inst",
        kind: "skill-instruction",
        text: "Open changes through a draft pull request.\n\n",
        target_skill: "draft-pr",
      },
      { id: "rep", kind: "repeat", text: "First rule.\n\n", repeats: "r1" },
      {
        id: "scoped",
        kind: "scoped-rule",
        text: "Open changes through a draft pull request.\n\n",
        target_skill: "draft-pr",
      },
      {
        id: "rew",
        kind: "reworded",
        text: "Verbose rule text.\n\n",
        replacement: "Concise rule.\n\n",
        approved: true,
      },
      {
        id: "rem",
        kind: "removed-rule",
        text: "Obsolete rule.\n\n",
        reason: "obsolete",
        approved: true,
      },
      { id: "big", kind: "rule", text: bigRuleText },
    ],
  };
  const source = plan.spans.map((s) => s.text).join("");
  const result = await planRulesCuts(source, plan, SKILLS);
  assert(result.afterBytes > lowMark);
  assertStringIncludes(result.report, "Rules before:");
  assertStringIncludes(result.report, "Rules after:");
  assertStringIncludes(result.report, "[moved to draft-pr]");
  assertStringIncludes(result.report, "[reworded] Concise rule.");
  assertStringIncludes(result.report, "[removed: obsolete]");
  assertStringIncludes(result.report, "bytes over low mark");
});

Deno.test("malformed plans, unsupported parts, unsafe skills and contradictory actions fail closed", async () => {
  const { plan } = await fixture();
  for (
    const input of [null, [], {}, { ...plan, part: "otherRepoRules" }, { ...plan, spans: [] }, {
      ...plan,
      extra: true,
    }, { ...plan, skills_dir: 1 }]
  ) {
    assertThrows(() => parseRulesCutsPlan(input));
  }
  for (
    const patch of [
      { id: "" },
      { id: "heading" },
      { text: "" },
      { text: 1 },
      { kind: "unknown" },
      { kind: "rule", target_skill: "draft-pr" },
      { kind: "rule", repeats: "heading" },
      { target_skill: "../escape" },
      { action: "keep" },
      { extra: "ignored?" },
    ]
  ) {
    const modified = structuredClone(plan);
    Object.assign(modified.spans[2], patch);
    assertThrows(() => parseRulesCutsPlan(modified));
  }
  assertThrows(() => parseRulesCutsPlan({ ...plan, spans: [null] }));
  assertThrows(() =>
    parseRulesCutsPlan({ ...plan, spans: [{ id: "r", kind: "repeat", text: "x" }] })
  );
  assertThrows(() =>
    parseRulesCutsPlan({ ...plan, spans: [{ id: "r", kind: "rule", text: " " }] })
  );
  assertThrows(() =>
    parseRulesCutsPlan({
      ...plan,
      spans: [{ id: "r", kind: "removed-rule", text: "x", approved: true, reason: "invalid" }],
    })
  );
  assertThrows(() =>
    parseRulesCutsPlan({
      ...plan,
      spans: [{ id: "r", kind: "reworded", text: "x", approved: true, replacement: " " }],
    })
  );
  assertThrows(() =>
    parseRulesCutsPlan({
      ...plan,
      spans: [{ id: "r", kind: "scoped-rule", text: "x", target_skill: "INVALID_SLUG" }],
    })
  );
  assertThrows(() =>
    parseRulesCutsPlan({
      ...plan,
      spans: [{ id: "r", kind: "scoped-rule", text: "x", target_skill: "draft-pr", guard: true }],
    })
  );
});

async function git(dir: string, args: string[]) {
  const result = await new Deno.Command("git", {
    args: [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=Rules fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgsign=false",
      "-C",
      dir,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
}

async function withWorktree(
  part: RulesPart,
  test: (
    options: {
      dir: string;
      root: string;
      worktree: string;
      filePath: string;
      planPath: string;
      source: string;
    },
  ) => Promise<void>,
) {
  const dir = await Deno.makeTempDir({ prefix: "rules-feature-" });
  try {
    const root = join(dir, "repo");
    const worktree = join(dir, "feature");
    await Deno.mkdir(join(root, "docs"), { recursive: true });
    const { source, plan } = await fixture();
    const relative = part === "crossAiRules" ? "docs/cross-ai-rules.md" : "AGENTS.md";
    await Deno.writeTextFile(join(root, relative), source);
    await git(root, ["init", "-b", "dev"]);
    await git(root, [
      "remote",
      "add",
      "origin",
      `https://github.com/WebJamApps/${
        part === "jammusicRules" ? "JaMmusic" : "web-jam-tools"
      }.git`,
    ]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "fixture"]);
    await git(root, ["worktree", "add", "-b", "fixture/cuts", worktree, "dev"]);
    plan.part = part;
    plan.skills_dir = SKILLS;
    const planPath = join(dir, "plan.json");
    await Deno.writeTextFile(planPath, JSON.stringify(plan));
    await test({ dir, root, worktree, filePath: join(worktree, relative), planPath, source });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

for (const part of ["mainRules", "crossAiRules", "jammusicRules"] as const) {
  Deno.test(`apply prepares ${part} only in the correct feature worktree`, async () => {
    await withWorktree(part, async ({ filePath, planPath }) => {
      const result = await runRulesCuts({ filePath, planPath });
      assertEquals(await Deno.readTextFile(filePath), result.after);
      assertEquals(result.rulesBefore, result.rulesAfter);
    });
  });
}

Deno.test("GitHub SSH URLs and Git insteadOf rewrites retain the repository identity", async () => {
  await withWorktree("mainRules", async ({ root, filePath, planPath, source }) => {
    await git(root, ["config", "url.ssh://git@github.com/.insteadOf", "https://github.com/"]);
    for (
      const origin of [
        "https://github.com/WebJamApps/web-jam-tools.git",
        "ssh://git@github.com/WebJamApps/web-jam-tools.git",
        "git@github.com:WebJamApps/web-jam-tools.git",
      ]
    ) {
      await git(root, ["remote", "set-url", "origin", origin]);
      await Deno.writeTextFile(filePath, source);
      const result = await runRulesCuts({ filePath, planPath });
      assertEquals(await Deno.readTextFile(filePath), result.after);
    }
    await git(root, [
      "config",
      "url.ssh://git@github.com/.insteadOf",
      "https://untrusted.invalid/",
    ]);
    await git(root, [
      "remote",
      "set-url",
      "origin",
      "ssh://git@untrusted.invalid/WebJamApps/web-jam-tools.git",
    ]);
    await Deno.writeTextFile(filePath, source);
    await assertRejects(
      () => runRulesCuts({ filePath, planPath }),
      Error,
      "requires the web-jam-tools repository",
    );
    assertEquals(await Deno.readTextFile(filePath), source);
  });
});

Deno.test("shared clones, protected or detached branches, wrong repos and escaped paths are untouched", async () => {
  const scenarios = {
    shared: "isolated git worktree",
    protected: "feature branch",
    detached: "feature worktree with a dev base",
    unbased: "feature worktree with a dev base",
    "other-repo": "requires the web-jam-tools repository",
    symlink: "Expected AGENTS.md at the worktree root",
    nested: "Expected AGENTS.md at the worktree root",
  };
  for (const [scenario, error] of Object.entries(scenarios)) {
    await withWorktree("mainRules", async ({ dir, root, worktree, filePath, planPath, source }) => {
      if (scenario === "shared") {
        await git(root, ["switch", "-c", "fixture/main-clone"]);
        filePath = join(root, "AGENTS.md");
      }
      if (scenario === "protected") await git(worktree, ["switch", "-c", "main"]);
      if (scenario === "detached") await git(worktree, ["switch", "--detach"]);
      if (scenario === "unbased") {
        await git(worktree, ["switch", "--orphan", "fixture/unrelated"]);
        await Deno.writeTextFile(filePath, source);
        await git(worktree, ["add", "."]);
        await git(worktree, ["commit", "-m", "unrelated fixture"]);
      }
      if (scenario === "other-repo") {
        await git(worktree, [
          "remote",
          "set-url",
          "origin",
          "https://github.com/WebJamApps/CollegeLutheran.git",
        ]);
      }
      if (scenario === "symlink") {
        const outside = join(dir, "outside.md");
        await Deno.writeTextFile(outside, source);
        await Deno.remove(filePath);
        await Deno.symlink(outside, filePath);
      }
      if (scenario === "nested") {
        filePath = join(worktree, "nested.md");
        await Deno.writeTextFile(filePath, source);
      }
      await assertRejects(() => runRulesCuts({ filePath, planPath }), Error, error);
      assertEquals(await Deno.readTextFile(filePath), source, scenario);
    });
  }
});

Deno.test("CLI help and refusal paths never write", async () => {
  assertEquals(await runCli(["--help"]), 0);
  for (
    const args of [[], ["--unknown"], ["--dry-run=false"], ["--dry-run=bad"], ["--no-dry-run"]]
  ) {
    assertEquals(await runCli(args), 1);
  }
  await withPlan(async (filePath, planPath, source, plan) => {
    await Deno.writeTextFile(planPath, "{");
    assertEquals(await runCli(["--plan", planPath, "--file", filePath]), 1);
    assertEquals(await Deno.readTextFile(filePath), source);
    await Deno.writeTextFile(planPath, JSON.stringify(plan));
    assertEquals(await runCli(["--plan", planPath, "--file", join(filePath, "missing")]), 1);
  });
});
