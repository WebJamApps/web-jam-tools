import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  type AgyCommandExecutor,
  type CheckResult,
  defaultAgyCommandExecutor,
  formatCheckResult,
  loadStartCheckPrompts,
  matchAgyOutput,
  matchClaudeScreen,
  readSkillFirstHeading,
  runAgyCheck,
  runClaudeCheck,
  runSkillStartCheck,
  type TmuxCommander,
  withCandidateSkill,
} from "../src/skill-start-check/mod.ts";

const FIXTURES_DIR = join(import.meta.dirname ?? "", "fixtures", "skill-start-check");
const REPO_ROOT = join(import.meta.dirname ?? "", "..");
const SKILLS_DIR = join(REPO_ROOT, "skills");

Deno.test("matchClaudeScreen - matches started marker", async () => {
  const text = await Deno.readTextFile(join(FIXTURES_DIR, "claude-started.txt"));
  const res = matchClaudeScreen(text, "sheet-music");
  assertEquals(res.matched, true);
  assertEquals(res.status, "started");
  assertEquals(res.matchedString, "● Skill(sheet-music)");
});

Deno.test("matchClaudeScreen - matches prompt-on-screen waiting marker", async () => {
  const text = await Deno.readTextFile(join(FIXTURES_DIR, "claude-prompt-on-screen.txt"));
  const res = matchClaudeScreen(text, "sheet-music");
  assertEquals(res.matched, true);
  assertEquals(res.status, "started_and_waiting");
  assertEquals(res.matchedString, 'Use skill "sheet-music"?');
});

Deno.test("matchClaudeScreen - handles not-started screen", async () => {
  const text = await Deno.readTextFile(join(FIXTURES_DIR, "claude-not-started.txt"));
  const res = matchClaudeScreen(text, "sheet-music");
  assertEquals(res.matched, false);
  assertEquals(res.status, "not_started");
});

Deno.test("matchAgyOutput - matches heading when skill started", async () => {
  const text = await Deno.readTextFile(join(FIXTURES_DIR, "agy-started.txt"));
  const heading = "# sheet-music — Lead Sheet Transcription & Docx Reformatting";
  const res = matchAgyOutput(text, heading);
  assertEquals(res.matched, true);
  assertEquals(res.firstHeading, heading);
});

Deno.test("matchAgyOutput - handles not-started output", async () => {
  const text = await Deno.readTextFile(join(FIXTURES_DIR, "agy-not-started.txt"));
  const heading = "# sheet-music — Lead Sheet Transcription & Docx Reformatting";
  const res = matchAgyOutput(text, heading);
  assertEquals(res.matched, false);
});

Deno.test("runClaudeCheck - mock started outcome PASS", async () => {
  const startedText = await Deno.readTextFile(join(FIXTURES_DIR, "claude-started.txt"));
  const sentKeys: string[] = [];

  const mockCommander: TmuxCommander = {
    startSession: (_s, _sess, _w, _c) => Promise.resolve({ success: true }),
    capturePane: (_s, _sess) =>
      Promise.resolve({
        success: true,
        output: sentKeys.length > 0 ? startedText : "❯ Try something\n────────────────────",
      }),
    sendKeys: (_s, _sess, k, _lit) => {
      sentKeys.push(k);
      return Promise.resolve({ success: true });
    },
    killServer: (_s) => Promise.resolve(),
    sleep: (_ms) => Promise.resolve(),
  };

  const res = await runClaudeCheck("sheet-music", "by_name", "run /sheet-music", {
    commander: mockCommander,
    timeoutMs: 2000,
  });

  assertEquals(res.outcome, "PASS");
  assertEquals(res.tool, "claude");
  assertEquals(res.skillName, "sheet-music");
  assertEquals(res.mode, "by_name");
  assertEquals(res.detail, "● Skill(sheet-music)");
});

Deno.test("runClaudeCheck - mock prompt-on-screen outcome PASS", async () => {
  const promptText = await Deno.readTextFile(join(FIXTURES_DIR, "claude-prompt-on-screen.txt"));
  const sentKeys: string[] = [];

  const mockCommander: TmuxCommander = {
    startSession: (_s, _sess, _w, _c) => Promise.resolve({ success: true }),
    capturePane: (_s, _sess) =>
      Promise.resolve({
        success: true,
        output: sentKeys.length > 0 ? promptText : "❯ Try something\n────────────────────",
      }),
    sendKeys: (_s, _sess, k, _lit) => {
      sentKeys.push(k);
      return Promise.resolve({ success: true });
    },
    killServer: (_s) => Promise.resolve(),
    sleep: (_ms) => Promise.resolve(),
  };

  const res = await runClaudeCheck("sheet-music", "on_its_own", "transcribe lead sheet", {
    commander: mockCommander,
    timeoutMs: 2000,
  });

  assertEquals(res.outcome, "PASS");
  assertEquals(res.tool, "claude");
  assertEquals(res.detail, 'Use skill "sheet-music"?');
});

Deno.test("runClaudeCheck - mock not-started outcome FAIL on timeout", async () => {
  const notStartedText = await Deno.readTextFile(join(FIXTURES_DIR, "claude-not-started.txt"));

  const mockCommander: TmuxCommander = {
    startSession: (_s, _sess, _w, _c) => Promise.resolve({ success: true }),
    capturePane: (_s, _sess) =>
      Promise.resolve({
        success: true,
        output: notStartedText,
      }),
    sendKeys: (_s, _sess, _k, _lit) => Promise.resolve({ success: true }),
    killServer: (_s) => Promise.resolve(),
    sleep: (_ms) => Promise.resolve(),
  };

  const res = await runClaudeCheck("sheet-music", "by_name", "run /sheet-music", {
    commander: mockCommander,
    timeoutMs: 50,
  });

  assertEquals(res.outcome, "FAIL");
  assertStringIncludes(res.reason ?? "", "Neither '● Skill(sheet-music)'");
});

Deno.test("runClaudeCheck - mock cannot-tell when tmux fails to start", async () => {
  const mockCommander: TmuxCommander = {
    startSession: (_s, _sess, _w, _c) =>
      Promise.resolve({ success: false, stderr: "tmux: command not found" }),
    capturePane: (_s, _sess) => Promise.resolve({ success: false, output: "" }),
    sendKeys: (_s, _sess, _k, _lit) => Promise.resolve({ success: false }),
    killServer: (_s) => Promise.resolve(),
    sleep: (_ms) => Promise.resolve(),
  };

  const res = await runClaudeCheck("sheet-music", "by_name", "run /sheet-music", {
    commander: mockCommander,
  });

  assertEquals(res.outcome, "FAIL");
  assertStringIncludes(res.reason ?? "", "tmux failed to start claude session");
});

Deno.test("runClaudeCheck - mock cannot-tell on rate limit screen", async () => {
  const limitText = await Deno.readTextFile(join(FIXTURES_DIR, "claude-cannot-tell.txt"));

  const mockCommander: TmuxCommander = {
    startSession: (_s, _sess, _w, _c) => Promise.resolve({ success: true }),
    capturePane: (_s, _sess) =>
      Promise.resolve({
        success: true,
        output: limitText,
      }),
    sendKeys: (_s, _sess, _k, _lit) => Promise.resolve({ success: true }),
    killServer: (_s) => Promise.resolve(),
    sleep: (_ms) => Promise.resolve(),
  };

  const res = await runClaudeCheck("sheet-music", "by_name", "run /sheet-music", {
    commander: mockCommander,
    timeoutMs: 100,
  });

  assertEquals(res.outcome, "FAIL");
  assertStringIncludes(res.reason ?? "", "Claude Code usage/rate limit reached");
});

Deno.test("runAgyCheck - mock started outcome PASS", async () => {
  const startedText = await Deno.readTextFile(join(FIXTURES_DIR, "agy-started.txt"));
  const heading = "# sheet-music — Lead Sheet Transcription & Docx Reformatting";

  const mockExecutor: AgyCommandExecutor = {
    run: (_p, _t) =>
      Promise.resolve({
        success: true,
        code: 0,
        stdout: startedText,
        stderr: "",
      }),
  };

  const res = await runAgyCheck("sheet-music", "by_name", "run /sheet-music", heading, {
    executor: mockExecutor,
  });

  assertEquals(res.outcome, "PASS");
  assertEquals(res.tool, "agy");
  assertEquals(res.skillName, "sheet-music");
  assertEquals(res.detail, heading);
});

Deno.test("runAgyCheck - mock not-started outcome FAIL", async () => {
  const notStartedText = await Deno.readTextFile(join(FIXTURES_DIR, "agy-not-started.txt"));
  const heading = "# sheet-music — Lead Sheet Transcription & Docx Reformatting";

  const mockExecutor: AgyCommandExecutor = {
    run: (_p, _t) =>
      Promise.resolve({
        success: true,
        code: 0,
        stdout: notStartedText,
        stderr: "",
      }),
  };

  const res = await runAgyCheck("sheet-music", "by_name", "run /sheet-music", heading, {
    executor: mockExecutor,
  });

  assertEquals(res.outcome, "FAIL");
  assertStringIncludes(res.reason ?? "", "absent from agy output");
});

Deno.test("runAgyCheck - mock cannot-tell when agy exits non-zero", async () => {
  const heading = "# sheet-music — Lead Sheet Transcription & Docx Reformatting";

  const mockExecutor: AgyCommandExecutor = {
    run: (_p, _t) =>
      Promise.resolve({
        success: false,
        code: 127,
        stdout: "",
        stderr: "agy: command not found",
      }),
  };

  const res = await runAgyCheck("sheet-music", "by_name", "run /sheet-music", heading, {
    executor: mockExecutor,
  });

  assertEquals(res.outcome, "FAIL");
  assertStringIncludes(res.reason ?? "", "agy exited with code 127");
});

Deno.test("runAgyCheck - mock cannot-tell on timeout", async () => {
  const heading = "# sheet-music — Lead Sheet Transcription & Docx Reformatting";

  const mockExecutor: AgyCommandExecutor = {
    run: (_p, _t) =>
      Promise.resolve({
        success: false,
        code: -1,
        stdout: "",
        stderr: "",
        timedOut: true,
      }),
  };

  const res = await runAgyCheck("sheet-music", "by_name", "run /sheet-music", heading, {
    executor: mockExecutor,
  });

  assertEquals(res.outcome, "FAIL");
  assertStringIncludes(res.reason ?? "", "Timed out waiting for agy response");
});

Deno.test("formatCheckResult - formats pass and fail output lines", () => {
  const passRes: CheckResult = {
    tool: "claude",
    skillName: "sheet-music",
    mode: "by_name",
    outcome: "PASS",
  };
  assertEquals(formatCheckResult(passRes), "claude: sheet-music (by name): PASS");

  const failRes: CheckResult = {
    tool: "agy",
    skillName: "sheet-music",
    mode: "on_its_own",
    outcome: "FAIL",
    reason: "heading absent",
  };
  assertEquals(formatCheckResult(failRes), "agy: sheet-music (on its own): FAIL — heading absent");
});

Deno.test("loadStartCheckPrompts - loads valid file and fails on missing", async () => {
  const prompts = await loadStartCheckPrompts(SKILLS_DIR, "sheet-music");
  assertStringIncludes(prompts.by_name, "sheet-music");
  assertStringIncludes(prompts.on_its_own, "sheet");

  await assertRejects(() => loadStartCheckPrompts(SKILLS_DIR, "non-existent-skill"));
});

Deno.test("readSkillFirstHeading - reads first # heading line", async () => {
  const heading = await readSkillFirstHeading(SKILLS_DIR, "sheet-music");
  assertEquals(heading, "# sheet-music — Lead Sheet Transcription & Docx Reformatting");

  await assertRejects(() => readSkillFirstHeading(SKILLS_DIR, "non-existent-skill"));
});

Deno.test("All 14 skills under skills/ carry a start-check.json with both prompts", async () => {
  const expectedSkills = [
    "backlog-groom",
    "book-gig",
    "delegate",
    "design-issue",
    "draft-pr",
    "drive-cleanup",
    "file-issue",
    "fix-labels",
    "handle-gmails",
    "memory-cleanup",
    "pr-review",
    "sheet-music",
    "venue-mining",
    "work-issue",
  ];

  for (const skill of expectedSkills) {
    const prompts = await loadStartCheckPrompts(SKILLS_DIR, skill);
    assertEquals(
      typeof prompts.by_name === "string" && prompts.by_name.length > 0,
      true,
      `Skill ${skill} must have non-empty by_name`,
    );
    assertEquals(
      typeof prompts.on_its_own === "string" && prompts.on_its_own.length > 0,
      true,
      `Skill ${skill} must have non-empty on_its_own`,
    );

    const heading = await readSkillFirstHeading(SKILLS_DIR, skill);
    assertEquals(
      heading.startsWith("# "),
      true,
      `Skill ${skill} heading must start with '# '`,
    );
  }
});

Deno.test("runSkillStartCheck - orchestrator with mock runners", async () => {
  const startedClaude = await Deno.readTextFile(join(FIXTURES_DIR, "claude-started.txt"));
  const startedAgy = await Deno.readTextFile(join(FIXTURES_DIR, "agy-started.txt"));

  const mockCommander: TmuxCommander = {
    startSession: (_s, _sess, _w, _c) => Promise.resolve({ success: true }),
    capturePane: (_s, _sess) =>
      Promise.resolve({
        success: true,
        output: startedClaude,
      }),
    sendKeys: (_s, _sess, _k, _lit) => Promise.resolve({ success: true }),
    killServer: (_s) => Promise.resolve(),
    sleep: (_ms) => Promise.resolve(),
  };

  const mockExecutor: AgyCommandExecutor = {
    run: (_p, _t) =>
      Promise.resolve({
        success: true,
        code: 0,
        stdout: startedAgy,
        stderr: "",
      }),
  };

  const { results, allPassed, formattedLines } = await runSkillStartCheck("sheet-music", {
    skillsDir: SKILLS_DIR,
    tool: "all",
    claudeOptions: { commander: mockCommander, timeoutMs: 500, claudeSkillsDir: SKILLS_DIR },
    agyOptions: { executor: mockExecutor, timeoutMs: 500, agySkillsDir: SKILLS_DIR },
  });

  assertEquals(results.length, 4);
  assertEquals(allPassed, true);
  assertEquals(formattedLines, [
    "claude: sheet-music (by name): PASS",
    "claude: sheet-music (on its own): PASS",
    "agy: sheet-music (by name): PASS",
    "agy: sheet-music (on its own): PASS",
  ]);
});

Deno.test("candidate mismatch refuses before either agent starts and preserves installed links", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const candidate = join(temp, "candidate", "fixture-skill");
    const installed = join(temp, "installed", "fixture-skill");
    const links = join(temp, "links");
    await Deno.mkdir(candidate, { recursive: true });
    await Deno.mkdir(installed, { recursive: true });
    await Deno.mkdir(links);
    await Deno.writeTextFile(join(candidate, "SKILL.md"), "# NEW_CANDIDATE_DESC");
    await Deno.writeTextFile(join(installed, "SKILL.md"), "# OLD_INSTALLED_DESC");
    await Deno.symlink(installed, join(links, "fixture-skill"));
    const claude = await runClaudeCheck("fixture-skill", "by_name", "prompt", {
      skillsDir: join(temp, "candidate"),
      claudeSkillsDir: links,
      commander: {
        startSession: () => {
          throw new Error("Must not start");
        },
        capturePane: () => Promise.resolve({ success: false, output: "" }),
        sendKeys: () => Promise.resolve({ success: false }),
        killServer: () => Promise.resolve(),
        sleep: () => Promise.resolve(),
      },
    });
    const agy = await runAgyCheck("fixture-skill", "by_name", "prompt", "# NEW_CANDIDATE_DESC", {
      skillsDir: join(temp, "candidate"),
      agySkillsDir: links,
      executor: {
        run: () => {
          throw new Error("Must not start");
        },
      },
    });
    for (const res of [claude, agy]) {
      assertEquals(res.outcome, "FAIL");
      assertStringIncludes(res.reason ?? "", "differs from the candidate");
    }
    assertEquals(await Deno.readLink(join(links, "fixture-skill")), installed);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("overlapping read-only checks preserve links and propagate execution failures", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const skill = join(temp, "candidate", "fixture-skill");
    const links = join(temp, "links");
    await Deno.mkdir(skill, { recursive: true });
    await Deno.mkdir(links);
    await Deno.writeTextFile(join(skill, "SKILL.md"), "# fixture-skill");
    await Deno.symlink(skill, join(links, "fixture-skill"));
    const options = {
      skillName: "fixture-skill",
      candidateSkillsDir: join(temp, "candidate"),
      installedSkillsDir: links,
    };
    const aStarted = Promise.withResolvers<void>();
    const bStarted = Promise.withResolvers<void>();
    const finishA = Promise.withResolvers<void>();
    const finishB = Promise.withResolvers<void>();
    const a = withCandidateSkill(options, async () => {
      aStarted.resolve();
      await finishA.promise;
    });
    await aStarted.promise;
    const b = withCandidateSkill(options, async () => {
      bStarted.resolve();
      await finishB.promise;
    });
    await bStarted.promise;
    assertEquals(await Deno.readLink(join(links, "fixture-skill")), skill);
    finishA.resolve();
    await a;
    assertEquals(await Deno.readLink(join(links, "fixture-skill")), skill);
    finishB.resolve();
    await b;
    await assertRejects(
      () => withCandidateSkill(options, () => Promise.reject(new Error("execution failed"))),
      Error,
      "execution failed",
    );
    assertEquals(await Deno.readLink(join(links, "fixture-skill")), skill);
    await Deno.writeTextFile(join(skill, "resource.txt"), "candidate resource");
    const installedCopy = join(temp, "installed", "fixture-skill");
    await Deno.mkdir(installedCopy, { recursive: true });
    await Deno.writeTextFile(join(installedCopy, "SKILL.md"), "# fixture-skill");
    await assertRejects(
      () =>
        withCandidateSkill(
          { ...options, installedSkillsDir: join(temp, "installed") },
          () => Promise.resolve(),
        ),
      Error,
      "differs from the candidate",
    );
    await assertRejects(
      () =>
        withCandidateSkill({ ...options, skillName: "../fixture-skill" }, () => Promise.resolve()),
      Error,
      "Invalid skill name",
    );
    await assertRejects(
      () =>
        withCandidateSkill({ ...options, installedSkillsDir: undefined }, () => Promise.resolve()),
      Error,
      "Cannot verify",
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("agy timeout closes readers, exits promptly and terminates retained-pipe descendants", async () => {
  const temp = await Deno.makeTempDir();
  try {
    for (const leaderExit of [false, true]) {
      const marker = join(temp, "descendant-survived");
      const script = join(temp, "agy");
      await Deno.writeTextFile(
        script,
        `#!/bin/sh
trap '' TERM
(sleep 1; echo survived > '${marker}') &
${leaderExit ? "exit 0" : "wait"}
`,
      );
      await Deno.chmod(script, 0o755);
      const helper = join(temp, "helper.ts");
      await Deno.writeTextFile(
        helper,
        `import { defaultAgyCommandExecutor } from ${
          JSON.stringify(join(REPO_ROOT, "src/skill-start-check/agy_runner.ts"))
        };
const result = await defaultAgyCommandExecutor.run("fixture", 100, { agyPath: ${
          JSON.stringify(script)
        } });
console.log(JSON.stringify(result));`,
      );
      const start = performance.now();
      const result = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", join(REPO_ROOT, "deno.json"), helper],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
      assertEquals(JSON.parse(new TextDecoder().decode(result.stdout)).timedOut, true);
      assert(
        performance.now() - start < 900,
        "Deno must exit before the retained pipe closes naturally",
      );
      await new Promise((resolve) => setTimeout(resolve, 1050));
      await assertRejects(() => Deno.stat(marker), Deno.errors.NotFound);
    }
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("agy executor returns normal output and handles missing commands", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const script = join(temp, "agy");
    await Deno.writeTextFile(script, "#!/bin/sh\nprintf '# fixture-skill\\n'\n");
    await Deno.chmod(script, 0o755);
    const res = await defaultAgyCommandExecutor.run("prompt", 1000, { agyPath: script });
    assertEquals(res.success, true);
    assertEquals(res.stdout, "# fixture-skill\n");
    const missing = await defaultAgyCommandExecutor.run("prompt", 1000, {
      agyPath: join(temp, "missing"),
    });
    assertEquals(missing.success, false);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("registered CLI runs both tools with scoped permissions and leaves installed skills untouched", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const home = join(temp, "home");
    const skills = join(temp, "candidate");
    const skill = join(skills, "fixture-skill");
    const bin = join(temp, "bin");
    await Deno.mkdir(skill, { recursive: true });
    await Deno.mkdir(bin);
    await Deno.writeTextFile(join(skill, "SKILL.md"), "# fixture-skill\n");
    await Deno.writeTextFile(
      join(skill, "start-check.json"),
      JSON.stringify({ by_name: "/fixture-skill", on_its_own: "fixture work" }),
    );
    const claudeSkills = join(home, ".claude", "skills");
    const agySkills = join(home, ".gemini", "config", "plugins", "webjam-tasks", "skills");
    for (const dir of [claudeSkills, agySkills]) {
      await Deno.mkdir(dir, { recursive: true });
      await Deno.symlink(skill, join(dir, "fixture-skill"));
    }
    await Deno.writeTextFile(join(bin, "agy"), "#!/bin/sh\nprintf '# fixture-skill\\n'\n");
    await Deno.writeTextFile(
      join(bin, "tmux"),
      `#!/bin/sh
case "$3" in
  capture-pane) printf '❯\\n● Skill(fixture-skill)\\n';;
esac
`,
    );
    await Deno.chmod(join(bin, "agy"), 0o755);
    await Deno.chmod(join(bin, "tmux"), 0o755);
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "task",
        "skill-start-check",
        "fixture-skill",
        "--tool",
        "all",
        "--skills-dir",
        skills,
        "--work-dir",
        temp,
        "--timeout",
        "2000",
      ],
      cwd: REPO_ROOT,
      env: { HOME: home, PATH: `${bin}:${Deno.env.get("PATH") ?? ""}` },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    const lines = new TextDecoder().decode(result.stdout).trim().split("\n");
    assertEquals(lines.length, 4);
    assert(lines.every((line) => line.endsWith("PASS")));
    for (const dir of [claudeSkills, agySkills]) {
      assertEquals(await Deno.readLink(join(dir, "fixture-skill")), skill);
    }
    const refused = await new Deno.Command(Deno.execPath(), {
      args: ["task", "skill-start-check", "fixture-skill", "--tool", "agy", "--skills-dir", skills],
      cwd: REPO_ROOT,
      env: { HOME: join(temp, "missing-home") },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(refused.code, 1);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});
