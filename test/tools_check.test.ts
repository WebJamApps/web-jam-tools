import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { main, parseCliArgs } from "../src/tools-check/cli.ts";
import {
  classifyInstallAgyConfigOutput,
  classifyInstallCodexOutput,
  classifyInstallHooksOutput,
  classifyInstallSkillsOutput,
  formatToolsCheckReport,
  runToolsCheck,
  type ToolsCheckDeps,
} from "../src/tools-check/lib.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function makeStubDeps(
  responses: Record<
    string,
    { code: number; stdout?: string; stderr?: string; spawnError?: string }
  >,
  envMap: Record<string, string | undefined> = { HOME: "/home/tester", PATH: "/usr/bin:/bin" },
): { deps: ToolsCheckDeps; calls: string[][] } {
  const calls: string[][] = [];
  const deps: ToolsCheckDeps = {
    denoExecPath: "deno",
    getEnv(key: string) {
      return envMap[key];
    },
    runCmd(cmd: string[]) {
      calls.push(cmd);
      const joined = cmd.join(" ");
      for (const [pattern, reply] of Object.entries(responses)) {
        if (joined.includes(pattern)) {
          return Promise.resolve({
            code: reply.code,
            stdout: reply.stdout ?? "",
            stderr: reply.stderr ?? "",
            spawnError: reply.spawnError,
          });
        }
      }
      return Promise.resolve({
        code: 1,
        stdout: "",
        stderr: `unmatched command in test: ${joined}`,
      });
    },
  };
  return { deps, calls };
}

function allOkResponses(): Record<
  string,
  { code: number; stdout?: string; stderr?: string }
> {
  return {
    "install-hooks.sh --check": {
      code: 0,
      stdout: [
        "settings.json: SessionStart, SessionEnd, Stop, PreToolUse, PostToolUse hooks and permissions.deny / permissions.ask / permissions.allow already up to date (no-op)",
        "hooks.json: SessionStart, SessionEnd, Stop, PreToolUse, PostToolUse hooks and permissions.deny / permissions.ask / permissions.allow already up to date (no-op)",
        "agents-md-pointer: check passed (no drift) for /home/tester/.agents/AGENTS.md",
        "hooks.json: Codex REAPER startup hook already registered (no-op)",
        "install-hooks: check passed (no drift)",
      ].join("\n"),
    },
    "--tool claude": {
      code: 0,
      stdout: "Claude: skill links in /home/tester/.claude/skills: ok",
    },
    "install-agy-config.sh --check": {
      code: 0,
      stdout: "agy: mcp_config.json: ok (already linked)",
    },
    "--tool agy": {
      code: 0,
      stdout: "agy: skill links in /home/tester/.gemini/config/plugins/webjam-tasks/skills: ok",
    },
    "install-codex.ts --check": {
      code: 0,
      stdout: "Codex installation is current (no changes)",
    },
  };
}

Deno.test("parseCliArgs and main handle help, invalid args, --tool filter, and --json", async () => {
  assertEquals(parseCliArgs(["--help"]).help, true);
  assertEquals(parseCliArgs(["--json", "--tool=agy"]).tool, "agy");
  assertStringIncludes(parseCliArgs(["--tool", "bogus"]).error ?? "", "Invalid --tool value");
  assertStringIncludes(parseCliArgs(["--home"]).error ?? "", "Missing value for --home");
  assertStringIncludes(parseCliArgs(["--repo-dir"]).error ?? "", "Missing value for --repo-dir");
  assertStringIncludes(parseCliArgs(["--wat"]).error ?? "", "Unknown argument");

  const outLines: string[] = [];
  const errLines: string[] = [];
  const io = {
    out: (m: string) => outLines.push(m),
    err: (m: string) => errLines.push(m),
  };

  const { deps } = makeStubDeps(allOkResponses());
  assertEquals(await main(["--help"], deps, io), 0);
  assertStringIncludes(outLines.join("\n"), "Usage: deno task tools:check");

  outLines.length = 0;
  assertEquals(await main(["--bogus"], deps, io), 1);
  assertStringIncludes(errLines.join("\n"), "Unknown argument");

  outLines.length = 0;
  errLines.length = 0;
  assertEquals(await main(["--json"], deps, io), 0);
  const parsed = JSON.parse(outLines.join("\n"));
  assertEquals(parsed.ok, true);
  assertEquals(parsed.rows.length, 6);

  outLines.length = 0;
  assertEquals(await main(["--tool", "claude"], deps, io), 0);
  assertStringIncludes(outLines.join("\n"), "tools:check: OK (2/2 passed)");
});

Deno.test("runToolsCheck fails closed with could-not-tell on all rows when HOME is unset", async () => {
  const { deps, calls } = makeStubDeps(allOkResponses(), {});
  const report = await runToolsCheck({}, deps);
  assertEquals(report.ok, false);
  assertEquals(report.status, "could-not-tell");
  assertEquals(report.rows.length, 6);
  assert(report.rows.every((r) => r.outcome === "could-not-tell"));
  assert(report.rows.every((r) => r.details.some((d) => d.includes("HOME is unset"))));
  assertEquals(calls.length, 0);
});

Deno.test("each table row reports ok, drifted (with diff + installer command), and could-not-tell", async () => {
  // 1. All 6 rows OK
  {
    const { deps, calls } = makeStubDeps(allOkResponses());
    const report = await runToolsCheck({}, deps);
    assertEquals(report.ok, true);
    assertEquals(report.status, "ok");
    assertEquals(report.rows.map((r) => `${r.tool} | ${r.item}`), [
      "Claude Code | hook links and ~/.claude/settings.json",
      "Claude Code | skill links in ~/.claude/skills/",
      "agy | registrations in ~/.gemini/config/hooks.json",
      "agy | ~/.gemini/config/mcp_config.json symlink",
      "agy | skill links in ~/.gemini/config/plugins/webjam-tasks/skills/",
      "Codex | hook registrations, rules file, skill links and sandbox setting",
    ]);
    assert(report.rows.every((r) => r.outcome === "ok"));
    assert(calls.every((cmd) => !cmd.some((a) => a === "--allow-write")));
  }

  // 2. Row-by-row drifted assertions (exact diff + exact installer command, other rows still ok)
  {
    const hooksClaudeDrift = allOkResponses();
    hooksClaudeDrift["install-hooks.sh --check"] = {
      code: 1,
      stdout:
        "hooks.json: SessionStart, SessionEnd, Stop, PreToolUse, PostToolUse hooks and permissions.deny / permissions.ask / permissions.allow already up to date (no-op)",
      stderr: [
        "drift: hook script semver-push-reminder.sh is not linked at /home/tester/.claude/hooks/semver-push-reminder.sh",
        "settings.json: missing permissions.deny rule Bash(git push --force *)",
        "error: drift detected",
      ].join("\n"),
    };
    const r1 = await runToolsCheck({}, makeStubDeps(hooksClaudeDrift).deps);
    assertEquals(r1.ok, false);
    assertEquals(r1.status, "drifted");
    assertEquals(r1.rows[0].outcome, "drifted");
    assertStringIncludes(r1.rows[0].details.join("\n"), "semver-push-reminder.sh");
    assertStringIncludes(r1.rows[0].remediation ?? "", "scripts/install-hooks.sh");
    assertEquals(r1.rows[2].outcome, "ok");
  }

  {
    const claudeSkillsDrift = allOkResponses();
    claudeSkillsDrift["--tool claude"] = {
      code: 1,
      stderr:
        "drift: Claude: skill work-issue is missing at /home/tester/.claude/skills/work-issue; run deno task install-skills to fix",
    };
    const r2 = await runToolsCheck({}, makeStubDeps(claudeSkillsDrift).deps);
    assertEquals(r2.ok, false);
    assertEquals(r2.rows[1].outcome, "drifted");
    assertStringIncludes(r2.rows[1].details[0], "work-issue is missing");
    assertStringIncludes(r2.rows[1].remediation ?? "", "install-skills");
    assertEquals(r2.rows[0].outcome, "ok");
  }

  {
    const hooksAgyDrift = allOkResponses();
    hooksAgyDrift["install-hooks.sh --check"] = {
      code: 1,
      stdout:
        "settings.json: SessionStart, SessionEnd, Stop, PreToolUse, PostToolUse hooks and permissions.deny / permissions.ask / permissions.allow already up to date (no-op)",
      stderr: [
        "hooks.json: missing PreToolUse hook (Bash) $HOME/.claude/hooks/gh-api-guard.sh",
        "drift: agy allow-list entry command(/home/joshua/.claude/hooks/agy-skill-run.sh) is missing",
        "error: drift detected",
      ].join("\n"),
    };
    const r3 = await runToolsCheck({}, makeStubDeps(hooksAgyDrift).deps);
    assertEquals(r3.ok, false);
    assertEquals(r3.rows[0].outcome, "ok");
    assertEquals(r3.rows[2].outcome, "drifted");
    assertStringIncludes(r3.rows[2].details.join("\n"), "gh-api-guard.sh");
    assertStringIncludes(r3.rows[2].remediation ?? "", "scripts/install-hooks.sh");
  }

  {
    const mcpDrift = allOkResponses();
    mcpDrift["install-agy-config.sh --check"] = {
      code: 1,
      stderr:
        "drift: agy mcp_config.json at /home/tester/.gemini/config/mcp_config.json is not a symlink; run scripts/install-agy-config.sh to fix",
    };
    const r4 = await runToolsCheck({}, makeStubDeps(mcpDrift).deps);
    assertEquals(r4.ok, false);
    assertEquals(r4.rows[3].outcome, "drifted");
    assertStringIncludes(r4.rows[3].details[0], "not a symlink");
    assertStringIncludes(r4.rows[3].remediation ?? "", "scripts/install-agy-config.sh");
  }

  {
    const agySkillsDrift = allOkResponses();
    agySkillsDrift["--tool agy"] = {
      code: 1,
      stderr:
        "drift: agy: skill pr-review at /home/tester/.gemini/config/plugins/webjam-tasks/skills/pr-review points to /other, not /home/tester/WebJamApps/web-jam-tools/skills/pr-review; run deno task install-skills to fix",
    };
    const r5 = await runToolsCheck({}, makeStubDeps(agySkillsDrift).deps);
    assertEquals(r5.ok, false);
    assertEquals(r5.rows[4].outcome, "drifted");
    assertStringIncludes(r5.rows[4].details[0], "points to /other");
    assertStringIncludes(r5.rows[4].remediation ?? "", "install-skills");
  }

  {
    const codexDrift = allOkResponses();
    codexDrift["install-codex.ts --check"] = {
      code: 1,
      stderr: [
        "REFUSED: missing hook /home/tester/.claude/hooks/gh-api-guard.sh; run scripts/install-hooks.sh first",
        "DRIFT: rules file /home/tester/.codex/rules/web-jam-tools.rules",
      ].join("\n"),
    };
    const r6 = await runToolsCheck({}, makeStubDeps(codexDrift).deps);
    assertEquals(r6.ok, false);
    assertEquals(r6.rows[5].outcome, "drifted");
    assertStringIncludes(r6.rows[5].details.join("\n"), "rules file");
    assertStringIncludes(r6.rows[5].remediation ?? "", "scripts/install-hooks.sh");
    assertStringIncludes(r6.rows[5].remediation ?? "", "install-codex");
  }
});

Deno.test("classifiers fail closed with could-not-tell and never mark uninspected checks as ok", () => {
  const repo = "/home/tester/WebJamApps/web-jam-tools";

  // Spawn failures across every checker
  const hooksSpawnFail = classifyInstallHooksOutput(
    { code: 1, stdout: "", stderr: "", spawnError: "ENOENT" },
    repo,
  );
  assertEquals(hooksSpawnFail.claude.outcome, "could-not-tell");
  assertEquals(hooksSpawnFail.agyHooks.outcome, "could-not-tell");

  // Early abort in install-hooks.sh before checks run: neither Claude nor agy was confirmed
  const hooksAborted = classifyInstallHooksOutput(
    { code: 1, stdout: "", stderr: "error: /missing/hooks not found" },
    repo,
  );
  assertEquals(hooksAborted.claude.outcome, "could-not-tell");
  assertEquals(hooksAborted.agyHooks.outcome, "could-not-tell");

  // agy permissions failure only: Claude still passes if settings.json was confirmed; agy is could-not-tell
  const hooksAgyUnreadable = classifyInstallHooksOutput(
    {
      code: 1,
      stdout:
        "settings.json: SessionStart, SessionEnd, Stop, PreToolUse, PostToolUse hooks and permissions.deny / permissions.ask / permissions.allow already up to date (no-op)",
      stderr: [
        'error: cannot read agy permissions (cannot tell: agy -p "/permissions" failed or unreadable)',
        "error: drift detected",
      ].join("\n"),
    },
    repo,
  );
  assertEquals(hooksAgyUnreadable.claude.outcome, "ok");
  assertEquals(hooksAgyUnreadable.agyHooks.outcome, "could-not-tell");
  assertStringIncludes(hooksAgyUnreadable.agyHooks.details[0], "cannot read agy permissions");

  // Invalid Claude settings.json fails Claude check without marking Claude ok
  const claudeInvalidJson = classifyInstallHooksOutput(
    {
      code: 1,
      stdout: "",
      stderr: "error: /home/tester/.claude/settings.json is not valid JSON, refusing to touch it",
    },
    repo,
  );
  assertEquals(claudeInvalidJson.claude.outcome, "could-not-tell");
  assertEquals(claudeInvalidJson.agyHooks.outcome, "could-not-tell");

  // Codex REAPER line in hooks.json is attributed to Codex, NOT agy
  const codexReaperOnly = classifyInstallHooksOutput(
    {
      code: 1,
      stdout: [
        "settings.json: SessionStart, SessionEnd, Stop, PreToolUse, PostToolUse hooks and permissions.deny / permissions.ask / permissions.allow already up to date (no-op)",
        "hooks.json: SessionStart, SessionEnd, Stop, PreToolUse, PostToolUse hooks and permissions.deny / permissions.ask / permissions.allow already up to date (no-op)",
      ].join("\n"),
      stderr: [
        "hooks.json: missing Codex REAPER SessionStart hook WJT_SURFACE=codex '/home/tester/.claude/hooks/codex-reaper-startup-check.sh'",
        "error: drift detected",
      ].join("\n"),
    },
    repo,
  );
  assertEquals(codexReaperOnly.claude.outcome, "ok");
  assertEquals(codexReaperOnly.agyHooks.outcome, "ok");
  assertEquals(codexReaperOnly.codexDetails.drifts.length, 1);

  assertEquals(
    classifyInstallSkillsOutput(
      { code: 1, stdout: "", stderr: "error: cannot inspect Claude skills directory: EACCES" },
      "claude",
      repo,
    ).outcome,
    "could-not-tell",
  );
  assertEquals(
    classifyInstallSkillsOutput(
      { code: 0, stdout: "", stderr: "" },
      "agy",
      repo,
    ).outcome,
    "could-not-tell",
  );
  assertEquals(
    classifyInstallAgyConfigOutput(
      { code: 1, stdout: "", stderr: "error: master config not found" },
      repo,
    ).outcome,
    "could-not-tell",
  );
  assertEquals(
    classifyInstallCodexOutput(
      { code: 1, stdout: "", stderr: "REFUSED: cannot read /home/tester/.codex/config.toml" },
      repo,
    ).outcome,
    "could-not-tell",
  );

  const formattedFail = formatToolsCheckReport({
    ok: false,
    status: "drifted",
    repoDir: repo,
    homeDir: "/home/tester",
    rows: [
      hooksAgyUnreadable.claude,
      hooksAgyUnreadable.agyHooks,
      classifyInstallAgyConfigOutput(
        { code: 1, stdout: "", stderr: "drift: agy mcp_config.json is missing" },
        repo,
      ),
    ],
  });
  assertStringIncludes(formattedFail, "[OK] Claude Code");
  assertStringIncludes(formattedFail, "[COULD NOT TELL] agy");
  assertStringIncludes(formattedFail, "[DRIFTED] agy");
  assertStringIncludes(
    formattedFail,
    "-> Fix: bash /home/tester/WebJamApps/web-jam-tools/scripts/install-agy-config.sh",
  );
  assertStringIncludes(formattedFail, "tools:check: FAILED (1 ok, 1 drifted, 1 could not tell)");
});

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory) {
      await copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile) {
      await Deno.copyFile(srcPath, destPath);
      const info = await Deno.lstat(srcPath);
      if (info.mode !== null) await Deno.chmod(destPath, info.mode);
    }
  }
}

function snapshotTree(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    const names = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    for (const name of names) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      let info: Deno.FileInfo;
      try {
        info = Deno.lstatSync(full);
      } catch (e) {
        entries[rel] = `unreadable:${e instanceof Error ? e.name : String(e)}`;
        continue;
      }
      if (info.isSymlink) {
        try {
          entries[rel] = `link:${Deno.readLinkSync(full)}`;
        } catch (e) {
          entries[rel] = `link-unreadable:${e instanceof Error ? e.name : String(e)}`;
        }
      } else if (info.isDirectory) {
        try {
          entries[rel] = "dir";
          walk(full, rel);
        } catch (e) {
          entries[rel] = `dir-unreadable:${e instanceof Error ? e.name : String(e)}`;
        }
      } else {
        try {
          entries[rel] = `file:${Deno.readTextFileSync(full)}`;
        } catch (e) {
          entries[rel] = `file-unreadable:${e instanceof Error ? e.name : String(e)}`;
        }
      }
    }
  };
  walk(root, "");
  return entries;
}

async function runInstaller(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  const res = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (res.code !== 0) {
    throw new Error(
      `Fixture setup failed (${cmd.join(" ")}), code ${res.code}:\n${
        new TextDecoder().decode(res.stdout)
      }\n${new TextDecoder().decode(res.stderr)}`,
    );
  }
}

Deno.test("end-to-end real fixture: OK, Drifted, and Could not tell per row, writing nothing", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "wjt-1559-e2e-" });
  const repo = join(tmp, "repo");
  const home = join(tmp, "home");
  const restrictedDirs: string[] = [];

  try {
    await copyDirRecursive(join(REPO_ROOT, "hooks"), join(repo, "hooks"));
    await copyDirRecursive(join(REPO_ROOT, "scripts"), join(repo, "scripts"));
    await copyDirRecursive(join(REPO_ROOT, "src/install-skills"), join(repo, "src/install-skills"));
    await copyDirRecursive(join(REPO_ROOT, "src/install-codex"), join(repo, "src/install-codex"));
    await copyDirRecursive(join(REPO_ROOT, "src/session-load"), join(repo, "src/session-load"));
    await copyDirRecursive(join(REPO_ROOT, "codex"), join(repo, "codex"));
    await copyDirRecursive(join(REPO_ROOT, "git-hooks"), join(repo, "git-hooks"));
    await Deno.mkdir(join(repo, "docs"), { recursive: true });
    await Deno.copyFile(
      join(REPO_ROOT, "docs/safety-rules.md"),
      join(repo, "docs/safety-rules.md"),
    );
    await Deno.copyFile(join(REPO_ROOT, "deno.json"), join(repo, "deno.json"));
    await Deno.mkdir(join(repo, "agy/config"), { recursive: true });
    await Deno.writeTextFile(join(repo, "agy/config/mcp_config.json"), '{"mcpServers":{}}\n');
    await Deno.mkdir(join(repo, "skills/sample-skill"), { recursive: true });
    await Deno.writeTextFile(join(repo, "skills/sample-skill/SKILL.md"), "# Sample\n");
    await Deno.mkdir(home, { recursive: true });

    const cleanPath = `${dirname(Deno.execPath())}:/usr/bin:/bin`;
    const hostDenoDir = Deno.env.get("DENO_DIR") ??
      join(Deno.env.get("HOME") ?? tmp, ".cache", "deno");
    const env = {
      HOME: home,
      PATH: cleanPath,
      DENO_DIR: hostDenoDir,
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    };

    // Seed clean installation using all four real installers in temporary home
    await runInstaller(["bash", join(repo, "scripts/install-hooks.sh")], repo, env);
    await runInstaller(
      [
        Deno.execPath(),
        "run",
        "--allow-env",
        "--allow-run",
        "--allow-read",
        "--allow-write",
        "--config",
        join(repo, "deno.json"),
        join(repo, "scripts/install-skills.ts"),
        "--repo-dir",
        repo,
        "--claude-dest",
        join(home, ".claude/skills"),
        "--agy-dest",
        join(home, ".gemini/config/plugins/webjam-tasks/skills"),
        "--allow-unsafe-for-testing",
      ],
      repo,
      env,
    );
    await runInstaller(
      [
        "bash",
        join(repo, "scripts/install-agy-config.sh"),
        "--mcp-src-path",
        join(repo, "agy/config/mcp_config.json"),
        "--mcp-config-path",
        join(home, ".gemini/config/mcp_config.json"),
      ],
      repo,
      env,
    );
    await runInstaller(
      [
        Deno.execPath(),
        "run",
        "--allow-env",
        "--allow-read",
        "--allow-write",
        "--config",
        join(repo, "deno.json"),
        join(repo, "scripts/install-codex.ts"),
        "--home",
        home,
      ],
      repo,
      env,
    );

    const checkOpts = {
      homeDir: home,
      repoDir: repo,
      env: { PATH: cleanPath, DENO_DIR: hostDenoDir, GIT_CONFIG_GLOBAL: join(home, ".gitconfig") },
    };

    // 1. All 6 rows OK and filesystem completely untouched
    const cleanSnapshotBefore = snapshotTree(home);
    const repoSnapshotBefore = snapshotTree(repo);
    const okReport = await runToolsCheck(checkOpts);
    assertEquals(okReport.ok, true, formatToolsCheckReport(okReport));
    assertEquals(okReport.rows.length, 6);
    assert(okReport.rows.every((r) => r.outcome === "ok"));
    assertEquals(snapshotTree(home), cleanSnapshotBefore);
    assertEquals(snapshotTree(repo), repoSnapshotBefore);

    // 2. Drifted Row 1: missing Claude hook symlink
    const claudeHookLink = join(home, ".claude/hooks/semver-push-reminder.sh");
    const origHookTarget = await Deno.readLink(claudeHookLink);
    await Deno.remove(claudeHookLink);
    // Recreate missing Codex prerequisite? Notice Codex checks .claude/hooks/* too, so also test a Claude-only settings drift
    await Deno.symlink(origHookTarget, claudeHookLink);
    const claudeSettingsPath = join(home, ".claude/settings.json");
    const origClaudeSettings = await Deno.readTextFile(claudeSettingsPath);
    const parsedClaudeSettings = JSON.parse(origClaudeSettings);
    parsedClaudeSettings.permissions.deny = [];
    await Deno.writeTextFile(claudeSettingsPath, JSON.stringify(parsedClaudeSettings, null, 2));
    const snapBeforeR1 = snapshotTree(home);
    const driftR1 = await runToolsCheck(checkOpts);
    assertEquals(driftR1.ok, false);
    assertEquals(driftR1.rows[0].outcome, "drifted");
    assertStringIncludes(driftR1.rows[0].remediation ?? "", "scripts/install-hooks.sh");
    assertEquals(driftR1.rows[2].outcome, "ok");
    assertEquals(snapshotTree(home), snapBeforeR1);
    await Deno.writeTextFile(claudeSettingsPath, origClaudeSettings);

    // 3. Drifted Row 2: missing Claude skill symlink
    const claudeSkillLink = join(home, ".claude/skills/sample-skill");
    const origSkillTarget = await Deno.readLink(claudeSkillLink);
    await Deno.remove(claudeSkillLink);
    const driftR2 = await runToolsCheck(checkOpts);
    assertEquals(driftR2.ok, false);
    assertEquals(driftR2.rows[1].outcome, "drifted");
    assertStringIncludes(driftR2.rows[1].remediation ?? "", "install-skills");
    assertEquals(driftR2.rows[4].outcome, "ok");
    await Deno.symlink(origSkillTarget, claudeSkillLink);

    // 4. Drifted Row 3: drifted agy hooks.json
    const agyHooksPath = join(home, ".gemini/config/hooks.json");
    const origAgyHooks = await Deno.readTextFile(agyHooksPath);
    await Deno.writeTextFile(agyHooksPath, JSON.stringify({ hooks: {} }));
    const driftR3 = await runToolsCheck(checkOpts);
    assertEquals(driftR3.ok, false);
    assertEquals(driftR3.rows[0].outcome, "ok");
    assertEquals(driftR3.rows[2].outcome, "drifted");
    assertStringIncludes(driftR3.rows[2].remediation ?? "", "scripts/install-hooks.sh");
    await Deno.writeTextFile(agyHooksPath, origAgyHooks);

    // 5. Drifted Row 4: broken/missing mcp_config.json symlink
    const mcpLink = join(home, ".gemini/config/mcp_config.json");
    const origMcpTarget = await Deno.readLink(mcpLink);
    await Deno.remove(mcpLink);
    const driftR4 = await runToolsCheck(checkOpts);
    assertEquals(driftR4.ok, false);
    assertEquals(driftR4.rows[3].outcome, "drifted");
    assertStringIncludes(driftR4.rows[3].remediation ?? "", "scripts/install-agy-config.sh");
    await Deno.symlink(origMcpTarget, mcpLink);

    // 6. Drifted Row 5: missing agy skill symlink
    const agySkillLink = join(home, ".gemini/config/plugins/webjam-tasks/skills/sample-skill");
    const origAgySkillTarget = await Deno.readLink(agySkillLink);
    await Deno.remove(agySkillLink);
    const driftR5 = await runToolsCheck(checkOpts);
    assertEquals(driftR5.ok, false);
    assertEquals(driftR5.rows[4].outcome, "drifted");
    assertStringIncludes(driftR5.rows[4].remediation ?? "", "install-skills");
    await Deno.symlink(origAgySkillTarget, agySkillLink);

    // 7. Drifted Row 6: outdated Codex rules file
    const codexRulesPath = join(home, ".codex/rules/web-jam-tools.rules");
    const origCodexRules = await Deno.readTextFile(codexRulesPath);
    await Deno.writeTextFile(codexRulesPath, "# stale\n");
    const driftR6 = await runToolsCheck(checkOpts);
    assertEquals(driftR6.ok, false);
    assertEquals(driftR6.rows[5].outcome, "drifted");
    assertStringIncludes(driftR6.rows[5].remediation ?? "", "install-codex");
    await Deno.writeTextFile(codexRulesPath, origCodexRules);

    // 8. Could-not-tell: malformed/unreadable targets on Claude, agy skills, agy hooks, mcp_config, and Codex
    await Deno.writeTextFile(claudeSettingsPath, "{broken");
    await Deno.chmod(join(home, ".claude/skills"), 0o000);
    restrictedDirs.push(join(home, ".claude/skills"));
    await Deno.writeTextFile(agyHooksPath, "{broken");
    await Deno.chmod(join(home, ".gemini/config/plugins/webjam-tasks/skills"), 0o000);
    restrictedDirs.push(join(home, ".gemini/config/plugins/webjam-tasks/skills"));
    await Deno.chmod(join(repo, "agy/config"), 0o000);
    restrictedDirs.push(join(repo, "agy/config"));
    const codexConfigPath = join(home, ".codex/config.toml");
    await Deno.chmod(codexConfigPath, 0o000);
    restrictedDirs.push(codexConfigPath);

    const unreadableReport = await runToolsCheck(checkOpts);
    assertEquals(unreadableReport.ok, false);
    assertEquals(unreadableReport.status, "could-not-tell");
    assertEquals(unreadableReport.rows[0].outcome, "could-not-tell");
    assertEquals(unreadableReport.rows[1].outcome, "could-not-tell");
    assertEquals(unreadableReport.rows[2].outcome, "could-not-tell");
    assertEquals(unreadableReport.rows[3].outcome, "could-not-tell");
    assertEquals(unreadableReport.rows[4].outcome, "could-not-tell");
    assertEquals(unreadableReport.rows[5].outcome, "could-not-tell");
  } finally {
    for (const p of restrictedDirs) {
      try {
        await Deno.chmod(p, 0o755);
      } catch {
        // ignore cleanup
      }
    }
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("deno.json registers read-only tools:check without --allow-write or blanket permissions (Rule 12, Rule 21)", async () => {
  const denoJson = JSON.parse(await Deno.readTextFile(join(REPO_ROOT, "deno.json")));
  const task: unknown = denoJson.tasks?.["tools:check"];
  assert(typeof task === "string", "deno.json must register 'tools:check'");
  assertStringIncludes(task, "src/tools-check/cli.ts");
  assert(!task.includes("--allow-write"), "tools:check must remain strictly read-only");
  assert(!task.includes("-A") && !task.includes("--allow-all"), "tools:check must not use -A");
  assertStringIncludes(task, "--allow-read=");
  assertStringIncludes(task, "--allow-env=");
  assertStringIncludes(task, "--allow-run=bash,deno");
});
