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
    claudeOptions: { commander: mockCommander, timeoutMs: 500 },
    agyOptions: { executor: mockExecutor, timeoutMs: 500 },
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

Deno.test("regression: differing installed and candidate descriptions prove candidate is exercised and installed links preserved", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "candidate-scope-test-" });
  try {
    const installedClaudeDir = join(tempDir, "installed-claude", "fixture-skill");
    const installedAgyDir = join(tempDir, "installed-agy", "fixture-skill");
    const candidateSkillsDir = join(tempDir, "candidate-skills");
    const candidateSkillDir = join(candidateSkillsDir, "fixture-skill");
    const claudeLinksDir = join(tempDir, "claude-links");
    const agyLinksDir = join(tempDir, "agy-links");

    await Deno.mkdir(installedClaudeDir, { recursive: true });
    await Deno.mkdir(installedAgyDir, { recursive: true });
    await Deno.mkdir(candidateSkillDir, { recursive: true });
    await Deno.mkdir(claudeLinksDir, { recursive: true });
    await Deno.mkdir(agyLinksDir, { recursive: true });

    await Deno.writeTextFile(
      join(installedClaudeDir, "SKILL.md"),
      "---\nname: fixture-skill\ndescription: OLD_INSTALLED_CLAUDE_DESC\n---\n# fixture-skill\n",
    );
    await Deno.writeTextFile(
      join(installedAgyDir, "SKILL.md"),
      "---\nname: fixture-skill\ndescription: OLD_INSTALLED_AGY_DESC\n---\n# fixture-skill\n",
    );
    await Deno.writeTextFile(
      join(candidateSkillDir, "SKILL.md"),
      "---\nname: fixture-skill\ndescription: NEW_CANDIDATE_DESC\n---\n# fixture-skill\n",
    );
    await Deno.writeTextFile(
      join(candidateSkillDir, "start-check.json"),
      JSON.stringify({ by_name: "/fixture-skill", on_its_own: "do new candidate thing" }),
    );

    const claudeLink = join(claudeLinksDir, "fixture-skill");
    const agyLink = join(agyLinksDir, "fixture-skill");
    await Deno.symlink(installedClaudeDir, claudeLink);
    await Deno.symlink(installedAgyDir, agyLink);

    // Verify initial installed links point to old installed copies
    assertEquals(await Deno.readLink(claudeLink), installedClaudeDir);
    assertEquals(await Deno.readLink(agyLink), installedAgyDir);

    let claudeReadDuringRun = "";
    const mockClaudeCommander: TmuxCommander = {
      startSession: (_s, _sess, _w, _c) => {
        // Inspect the skill loaded in claudeLinksDir during session execution
        claudeReadDuringRun = Deno.readTextFileSync(join(claudeLink, "SKILL.md"));
        return Promise.resolve({ success: true });
      },
      capturePane: (_s, _sess) =>
        Promise.resolve({
          success: true,
          output: "● Skill(fixture-skill)\n────────────────────",
        }),
      sendKeys: (_s, _sess, _k, _lit) => Promise.resolve({ success: true }),
      killServer: (_s) => Promise.resolve(),
      sleep: (_ms) => Promise.resolve(),
    };

    const claudeRes = await runClaudeCheck("fixture-skill", "on_its_own", "prompt", {
      skillsDir: candidateSkillsDir,
      claudeSkillsDir: claudeLinksDir,
      commander: mockClaudeCommander,
      timeoutMs: 500,
    });

    assertEquals(claudeRes.outcome, "PASS");
    // Proves candidate skill was exercised
    assertStringIncludes(claudeReadDuringRun, "NEW_CANDIDATE_DESC");
    // Proves user's installed link was restored
    assertEquals(await Deno.readLink(claudeLink), installedClaudeDir);

    let agyReadDuringRun = "";
    const mockAgyExecutor: AgyCommandExecutor = {
      run: (_p, _t, _opts) => {
        // Inspect the skill loaded in agyLinksDir during executor run
        agyReadDuringRun = Deno.readTextFileSync(join(agyLink, "SKILL.md"));
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: "# fixture-skill\noutput",
          stderr: "",
        });
      },
    };

    const agyRes = await runAgyCheck(
      "fixture-skill",
      "on_its_own",
      "prompt",
      "# fixture-skill",
      {
        skillsDir: candidateSkillsDir,
        agySkillsDir: agyLinksDir,
        executor: mockAgyExecutor,
        timeoutMs: 500,
      },
    );

    assertEquals(agyRes.outcome, "PASS");
    // Proves candidate skill was exercised
    assertStringIncludes(agyReadDuringRun, "NEW_CANDIDATE_DESC");
    // Proves user's installed link was restored
    assertEquals(await Deno.readLink(agyLink), installedAgyDir);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("regression: refuses when installed skill path is a non-symlink directory (loaded version differs)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "candidate-scope-refuse-" });
  try {
    const candidateSkillsDir = join(tempDir, "candidate-skills");
    const candidateSkillDir = join(candidateSkillsDir, "fixture-skill");
    const fakeSkillsDir = join(tempDir, "installed-skills");
    const nonSymlinkSkill = join(fakeSkillsDir, "fixture-skill");

    await Deno.mkdir(candidateSkillDir, { recursive: true });
    await Deno.mkdir(nonSymlinkSkill, { recursive: true });

    await Deno.writeTextFile(
      join(candidateSkillDir, "SKILL.md"),
      "---\nname: fixture-skill\ndescription: CANDIDATE\n---\n# fixture-skill\n",
    );
    await Deno.writeTextFile(
      join(nonSymlinkSkill, "SKILL.md"),
      "---\nname: fixture-skill\ndescription: INSTALLED_NON_SYMLINK\n---\n# fixture-skill\n",
    );

    const claudeRes = await runClaudeCheck("fixture-skill", "by_name", "prompt", {
      skillsDir: candidateSkillsDir,
      claudeSkillsDir: fakeSkillsDir,
      timeoutMs: 500,
    });
    assertEquals(claudeRes.outcome, "FAIL");
    assertStringIncludes(claudeRes.reason ?? "", "not a symlink");

    const agyRes = await runAgyCheck(
      "fixture-skill",
      "by_name",
      "prompt",
      "# fixture-skill",
      {
        skillsDir: candidateSkillsDir,
        agySkillsDir: fakeSkillsDir,
        timeoutMs: 500,
      },
    );
    assertEquals(agyRes.outcome, "FAIL");
    assertStringIncludes(agyRes.reason ?? "", "not a symlink");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("regression: agy subprocess timeout terminates ignored SIGTERM and cleans up retained output pipes", async () => {
  const fakeAgyScript = await Deno.makeTempFile({
    prefix: "fake-agy-timeout-",
    suffix: ".sh",
  });
  await Deno.writeTextFile(
    fakeAgyScript,
    `#!/usr/bin/env bash
trap '' TERM
(sleep 10 >/dev/null 2>&1 &)
sleep 5
`,
  );
  await Deno.chmod(fakeAgyScript, 0o755);

  try {
    const start = Date.now();
    const res = await defaultAgyCommandExecutor.run("fixture prompt", 100, {
      agyPath: fakeAgyScript,
    });
    const elapsed = Date.now() - start;

    assertEquals(res.timedOut, true);
    assertEquals(res.success, false);
    assertEquals(res.code, -1);
    assertStringIncludes(res.stderr, "Timed out after 100ms");
    // Verify bounded escalation: must return in < 1500ms, not after sleep 5 (5000ms) or sleep 10 (10000ms)
    assert(
      elapsed < 1500,
      `Expected timeout escalation < 1500ms, took ${elapsed}ms`,
    );
    assert(
      elapsed >= 100,
      `Expected elapsed >= 100ms, took ${elapsed}ms`,
    );
  } finally {
    await Deno.remove(fakeAgyScript).catch(() => {});
  }
});
