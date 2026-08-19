/**
 * Unit tests for src/install-skills/lib.ts and scripts/install-skills.ts (web-jam-tools#668, web-jam-tools#669)
 */

import { assertEquals, assertFalse, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  DEFAULT_RETENTION_MS,
  defaultExecDeps,
  ExecDeps,
  getTimestamp,
  installSkills,
  installToDest,
  isUnsafeSourcePath,
  migrateLegacyBackups,
  parseArgs,
  parseBackupTimestamp,
  pruneFromDest,
  pruneOldBackups,
  resolveAndValidateRepoDir,
} from "../src/install-skills/lib.ts";

const REPO_DIR = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const SCRIPT_PATH = `${REPO_DIR}/scripts/install-skills.ts`;

Deno.test("parseArgs parses all supported CLI flags", () => {
  const args = [
    "--repo-dir",
    "/home/user/repo",
    "--claude-dest",
    "/home/user/.claude/skills",
    "--agy-dest",
    "/home/user/.gemini/skills",
    "--claude-backup-dest",
    "/home/user/.claude/skills-backups",
    "--agy-backup-dest",
    "/home/user/.gemini/skills-backups",
    "--retention-days",
    "30",
    "--force",
    "--dry-run",
    "-q",
    "--allow-unsafe-for-testing",
  ];

  const parsed = parseArgs(args);
  assertEquals(parsed.repoDir, "/home/user/repo");
  assertEquals(parsed.claudeDest, "/home/user/.claude/skills");
  assertEquals(parsed.agyDest, "/home/user/.gemini/skills");
  assertEquals(parsed.claudeBackupDest, "/home/user/.claude/skills-backups");
  assertEquals(parsed.agyBackupDest, "/home/user/.gemini/skills-backups");
  assertEquals(parsed.retentionMs, 30 * 24 * 60 * 60 * 1000);
  assertEquals(parsed.force, true);
  assertEquals(parsed.dryRun, true);
  assertEquals(parsed.quiet, true);
  assertEquals(parsed.allowUnsafeForTesting, true);
});

Deno.test("parseArgs handles equals format (--key=val)", () => {
  const args = [
    "--repo-dir=/tmp/repo",
    "--claude-dest=/tmp/claude",
    "--agy-dest=/tmp/agy",
    "--claude-backup-dest=/tmp/claude-bak",
    "--agy-backup-dest=/tmp/agy-bak",
    "--retention-days=7",
    "--quiet",
  ];

  const parsed = parseArgs(args);
  assertEquals(parsed.repoDir, "/tmp/repo");
  assertEquals(parsed.claudeDest, "/tmp/claude");
  assertEquals(parsed.agyDest, "/tmp/agy");
  assertEquals(parsed.claudeBackupDest, "/tmp/claude-bak");
  assertEquals(parsed.agyBackupDest, "/tmp/agy-bak");
  assertEquals(parsed.retentionMs, 7 * 24 * 60 * 60 * 1000);
  assertEquals(parsed.quiet, true);
});

Deno.test("getTimestamp formats YYYYMMDD-HHMMSS format correctly", () => {
  const date = new Date(2026, 7, 19, 14, 30, 45); // Aug 19, 2026 14:30:45
  const stamp = getTimestamp(date);
  assertEquals(stamp, "20260819-143045");
});

Deno.test("parseBackupTimestamp extracts Date from backup directory names", () => {
  const date = parseBackupTimestamp("work-issue.bak-20260819-083339");
  assertEquals(date?.getFullYear(), 2026);
  assertEquals(date?.getMonth(), 7); // Aug
  assertEquals(date?.getDate(), 19);
  assertEquals(date?.getHours(), 8);
  assertEquals(date?.getMinutes(), 33);
  assertEquals(date?.getSeconds(), 39);

  const invalid = parseBackupTimestamp("not-a-backup-folder");
  assertEquals(invalid, null);
});

Deno.test("isUnsafeSourcePath identifies temporary and unsafe directories", () => {
  assertEquals(isUnsafeSourcePath("/tmp"), true);
  assertEquals(isUnsafeSourcePath("/tmp/worktree-123"), true);
  assertEquals(isUnsafeSourcePath("/private/tmp/repo"), true);
  assertEquals(isUnsafeSourcePath("/var/tmp/repo"), true);
  assertEquals(isUnsafeSourcePath("/home/joshua/WebJamApps/web-jam-tools"), false);
  assertEquals(isUnsafeSourcePath("/opt/repos/project"), false);
});

Deno.test("resolveAndValidateRepoDir rejects /tmp directories unless allowUnsafeForTesting", async () => {
  await assertRejects(
    () => resolveAndValidateRepoDir({ repoDir: "/tmp/fake-repo" }),
    Error,
    "unsafe source directory (/tmp)",
  );

  const safe = await resolveAndValidateRepoDir({
    repoDir: "/tmp/fake-repo",
    allowUnsafeForTesting: true,
  });
  assertEquals(safe, "/tmp/fake-repo");
});

Deno.test("resolveAndValidateRepoDir rejects linked git worktrees without force", async () => {
  const mockDeps: ExecDeps = {
    runCmd(cmd: string[], _cwd?: string) {
      if (cmd.includes("--git-dir")) {
        return Promise.resolve({
          code: 0,
          stdout: "/home/joshua/WebJamApps/web-jam-tools/.git/worktrees/agent-123\n",
          stderr: "",
        });
      }
      if (cmd.includes("--git-common-dir")) {
        return Promise.resolve({
          code: 0,
          stdout: "/home/joshua/WebJamApps/web-jam-tools/.git\n",
          stderr: "",
        });
      }
      return Promise.resolve({ code: 1, stdout: "", stderr: "unknown" });
    },
  };

  await assertRejects(
    () =>
      resolveAndValidateRepoDir(
        { repoDir: "/home/joshua/WebJamApps/web-jam-tools-worktree" },
        mockDeps,
      ),
    Error,
    "is a git worktree, not the primary checkout",
  );

  // With force=true, it allows the worktree
  const resolved = await resolveAndValidateRepoDir(
    { repoDir: "/home/joshua/WebJamApps/web-jam-tools-worktree", force: true },
    mockDeps,
  );
  assertEquals(resolved, "/home/joshua/WebJamApps/web-jam-tools-worktree");
});

Deno.test("resolveAndValidateRepoDir accepts non-worktree repositories", async () => {
  const mockDeps: ExecDeps = {
    runCmd(cmd: string[], _cwd?: string) {
      if (cmd.includes("--git-dir") || cmd.includes("--git-common-dir")) {
        return Promise.resolve({
          code: 0,
          stdout: "/home/joshua/WebJamApps/web-jam-tools/.git\n",
          stderr: "",
        });
      }
      return Promise.resolve({ code: 1, stdout: "", stderr: "unknown" });
    },
  };

  const resolved = await resolveAndValidateRepoDir(
    { repoDir: "/home/joshua/WebJamApps/web-jam-tools" },
    mockDeps,
  );
  assertEquals(resolved, "/home/joshua/WebJamApps/web-jam-tools");
});

Deno.test("migrateLegacyBackups moves legacy *.bak-* entries out of skills directory", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "wjt-migrate-test-" });
  const skillsDir = join(tempDir, "skills");
  const backupDir = join(tempDir, "skills-backups");

  await Deno.mkdir(skillsDir, { recursive: true });

  // Create legacy backup directories inside skills directory
  const legacy1 = join(skillsDir, "design-issue.bak-20260819-082414");
  const legacy2 = join(skillsDir, "draft-pr.bak-20260702-204420");
  await Deno.mkdir(legacy1, { recursive: true });
  await Deno.writeTextFile(join(legacy1, "SKILL.md"), "# Old Design Issue");
  await Deno.mkdir(legacy2, { recursive: true });
  await Deno.writeTextFile(join(legacy2, "SKILL.md"), "# Old Draft PR");

  // Create a real active skill
  const realSkill = join(skillsDir, "active-skill");
  await Deno.mkdir(realSkill, { recursive: true });

  const messages = await migrateLegacyBackups(skillsDir, backupDir, "Claude");
  assertEquals(messages.length, 2);
  assertStringIncludes(messages[0], "migrated legacy backup design-issue.bak-20260819-082414");
  assertStringIncludes(messages[1], "migrated legacy backup draft-pr.bak-20260702-204420");

  // Check that legacy backups no longer exist in skillsDir
  let hasLegacy1 = false;
  try {
    await Deno.stat(legacy1);
    hasLegacy1 = true;
  } catch {
    hasLegacy1 = false;
  }
  assertFalse(hasLegacy1, "Legacy backup 1 must not exist in skills directory");

  // Check that backups were preserved in backupDir
  const migrated1 = await Deno.readTextFile(
    join(backupDir, "design-issue.bak-20260819-082414", "SKILL.md"),
  );
  assertEquals(migrated1, "# Old Design Issue");

  const migrated2 = await Deno.readTextFile(
    join(backupDir, "draft-pr.bak-20260702-204420", "SKILL.md"),
  );
  assertEquals(migrated2, "# Old Draft PR");

  // Active skill was untouched
  const realStat = await Deno.stat(realSkill);
  assertEquals(realStat.isDirectory, true);
});

Deno.test("pruneOldBackups prunes backups older than retention window", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "wjt-retention-test-" });
  const backupDir = join(tempDir, "skills-backups");
  await Deno.mkdir(backupDir, { recursive: true });

  // 1. Stale backup (30 days old)
  const stale1 = join(backupDir, "draft-pr.bak-20260702-120000");
  await Deno.mkdir(stale1, { recursive: true });

  // 2. Fresh backup (2 days old relative to Aug 19, 2026)
  const fresh1 = join(backupDir, "draft-pr.bak-20260817-120000");
  await Deno.mkdir(fresh1, { recursive: true });

  // 3. File without timestamp format, use mtime (old mtime)
  const nonFormat = join(backupDir, "unformatted.bak");
  await Deno.writeTextFile(nonFormat, "test");
  const oldTime = new Date(2026, 5, 1); // June 1, 2026
  await Deno.utime(nonFormat, oldTime, oldTime);

  const now = new Date(2026, 7, 19, 12, 0, 0); // Aug 19, 2026
  const retentionMs = DEFAULT_RETENTION_MS; // 14 days

  const messages = await pruneOldBackups(backupDir, "Claude", retentionMs, now);
  assertEquals(messages.length, 2);
  assertStringIncludes(messages[0], "pruned expired backup draft-pr.bak-20260702-120000");
  assertStringIncludes(messages[1], "pruned expired backup unformatted.bak");

  // Verify fresh backup remains
  const freshStat = await Deno.stat(fresh1);
  assertEquals(freshStat.isDirectory, true);

  // Verify stale backups were removed
  let staleExists = false;
  try {
    await Deno.stat(stale1);
    staleExists = true;
  } catch {
    staleExists = false;
  }
  assertFalse(staleExists);
});

Deno.test("pruneFromDest removes dangling symlinks to inside-repo and outside-repo targets", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "wjt-prune-test-" });
  const claudeSkills = join(tempDir, "claude-skills");
  await Deno.mkdir(claudeSkills, { recursive: true });

  // 1. Dangling symlink pointing inside repo
  const danglingInside = join(claudeSkills, "dangling-inside");
  await Deno.symlink("/nonexistent/repo/skills/dangling-inside", danglingInside);

  // 2. Dangling symlink pointing outside repo (e.g. deleted /tmp worktree)
  const danglingOutside = join(claudeSkills, "dangling-outside");
  await Deno.symlink("/tmp/deleted-worktree/skills/dangling-outside", danglingOutside);

  // 3. Valid symlink to a real target
  const realTargetDir = join(tempDir, "real-skill");
  await Deno.mkdir(realTargetDir, { recursive: true });
  const validLink = join(claudeSkills, "valid-skill");
  await Deno.symlink(realTargetDir, validLink);

  // Run prune
  const messages = await pruneFromDest(claudeSkills, "Claude");

  assertEquals(messages.length, 2);
  assertStringIncludes(messages[0], "dangling-inside: pruned stale symlink");
  assertStringIncludes(messages[1], "dangling-outside: pruned stale symlink");

  // Check filesystem
  let insideExists = false;
  try {
    await Deno.lstat(danglingInside);
    insideExists = true;
  } catch {
    insideExists = false;
  }
  assertEquals(insideExists, false);

  let outsideExists = false;
  try {
    await Deno.lstat(danglingOutside);
    outsideExists = true;
  } catch {
    outsideExists = false;
  }
  assertEquals(outsideExists, false);

  const validStat = await Deno.lstat(validLink);
  assertEquals(validStat.isSymlink, true);
});

Deno.test("pruneFromDest returns empty when destination is missing or not a directory", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "wjt-prune-missing-" });
  const missing = join(tempDir, "missing");
  const msgs1 = await pruneFromDest(missing, "Claude");
  assertEquals(msgs1, []);

  const regularFile = join(tempDir, "file.txt");
  await Deno.writeTextFile(regularFile, "content");
  const msgs2 = await pruneFromDest(regularFile, "Claude");
  assertEquals(msgs2, []);
});

Deno.test("installToDest creates links, preserves local files, and writes backups OUTSIDE destination directory", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "wjt-install-test-" });
  const repoSkills = join(tempDir, "repo", "skills");
  const destDir = join(tempDir, "dest", "skills");
  const backupDir = join(tempDir, "dest", "skills-backups");

  await Deno.mkdir(join(repoSkills, "skill-a"), { recursive: true });
  await Deno.writeTextFile(join(repoSkills, "skill-a", "SKILL.md"), "# Skill A");
  await Deno.writeTextFile(join(repoSkills, "skill-a", "existing.txt"), "repo version");

  await Deno.mkdir(join(repoSkills, "skill-b"), { recursive: true });
  await Deno.writeTextFile(join(repoSkills, "skill-b", "SKILL.md"), "# Skill B");

  await Deno.mkdir(join(repoSkills, "skill-c"), { recursive: true });
  await Deno.writeTextFile(join(repoSkills, "skill-c", "SKILL.md"), "# Skill C");

  // In destDir, pre-populate:
  // - skill-a as a real directory containing a local-only file (rules.yaml), existing file, and subfolder
  const existingRealDir = join(destDir, "skill-a");
  await Deno.mkdir(join(existingRealDir, "sub"), { recursive: true });
  await Deno.writeTextFile(join(existingRealDir, "rules.yaml"), "local: true");
  await Deno.writeTextFile(join(existingRealDir, "existing.txt"), "dest version");
  await Deno.writeTextFile(join(existingRealDir, "sub", "log.txt"), "run 1");

  // - skill-c as a regular file (edge case)
  await Deno.mkdir(destDir, { recursive: true });
  await Deno.writeTextFile(join(destDir, "skill-c"), "not a directory");

  // 1. Run install
  const stamp = "20260819-150000";
  const msgs1 = await installToDest(repoSkills, destDir, backupDir, "Claude", stamp);

  assertEquals(msgs1.length, 3);
  assertStringIncludes(
    msgs1[0],
    "skill-a: linked (previous version backed up to skill-a.bak-20260819-150000)",
  );
  assertStringIncludes(msgs1[1], "skill-b: linked (new)");
  assertStringIncludes(
    msgs1[2],
    "skill-c: linked (previous version backed up to skill-c.bak-20260819-150000)",
  );

  // Verify NO .bak-* entries were created inside destDir
  for await (const entry of Deno.readDir(destDir)) {
    assertFalse(
      entry.name.includes(".bak-"),
      `destDir must not contain .bak- entry, found: ${entry.name}`,
    );
  }

  // Verify local files were preserved into repo source dir
  const preservedRules = await Deno.readTextFile(join(repoSkills, "skill-a", "rules.yaml"));
  assertEquals(preservedRules, "local: true");
  const preservedLog = await Deno.readTextFile(join(repoSkills, "skill-a", "sub", "log.txt"));
  assertEquals(preservedLog, "run 1");

  // Existing file in repo was not overwritten by dest
  const preservedExisting = await Deno.readTextFile(join(repoSkills, "skill-a", "existing.txt"));
  assertEquals(preservedExisting, "repo version");

  // Verify backup exists OUTSIDE in backupDir
  const bakDir = join(backupDir, `skill-a.bak-${stamp}`);
  const bakStat = await Deno.stat(bakDir);
  assertEquals(bakStat.isDirectory, true);

  // Verify symlinks exist and resolve
  const linkA = await Deno.readLink(join(destDir, "skill-a"));
  assertEquals(linkA, join(repoSkills, "skill-a"));
  const linkB = await Deno.readLink(join(destDir, "skill-b"));
  assertEquals(linkB, join(repoSkills, "skill-b"));
  const linkC = await Deno.readLink(join(destDir, "skill-c"));
  assertEquals(linkC, join(repoSkills, "skill-c"));

  // 2. Second run: already linked skills are reported as ok
  const msgs2 = await installToDest(repoSkills, destDir, backupDir, "Claude", "20260819-160000");
  assertEquals(msgs2.length, 3);
  assertStringIncludes(msgs2[0], "skill-a: ok (already linked)");
  assertStringIncludes(msgs2[1], "skill-b: ok (already linked)");
  assertStringIncludes(msgs2[2], "skill-c: ok (already linked)");
});

Deno.test("installSkills installs all skills, migrates legacy backups, and prunes old backups end-to-end", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "wjt-e2e-test-" });
  const claudeDest = join(tempDir, ".claude", "skills");
  const agyDest = join(tempDir, ".gemini", "config", "plugins", "webjam-tasks", "skills");
  const claudeBackupDest = join(tempDir, ".claude", "skills-backups");
  const agyBackupDest = join(
    tempDir,
    ".gemini",
    "config",
    "plugins",
    "webjam-tasks",
    "skills-backups",
  );

  // Create pre-existing legacy backups in claudeDest to test migration
  await Deno.mkdir(claudeDest, { recursive: true });
  const legacyInClaude = join(claudeDest, "old-skill.bak-20260815-100000"); // 4 days old (retained)
  await Deno.mkdir(legacyInClaude, { recursive: true });
  await Deno.writeTextFile(join(legacyInClaude, "SKILL.md"), "# Legacy Skill");

  const ancientInClaude = join(claudeDest, "ancient-skill.bak-20260701-100000"); // 49 days old (pruned)
  await Deno.mkdir(ancientInClaude, { recursive: true });
  await Deno.writeTextFile(join(ancientInClaude, "SKILL.md"), "# Ancient Skill");

  // Create expired backup in agyBackupDest to test retention pruning
  await Deno.mkdir(agyBackupDest, { recursive: true });
  const expiredInAgy = join(agyBackupDest, "ancient.bak-20260701-100000");
  await Deno.mkdir(expiredInAgy, { recursive: true });

  const now = new Date(2026, 7, 19, 12, 0, 0); // Aug 19, 2026

  const result = await installSkills({
    repoDir: REPO_DIR,
    claudeDest,
    agyDest,
    claudeBackupDest,
    agyBackupDest,
    now,
    allowUnsafeForTesting: true,
  });

  assertEquals(result.success, true);
  assertEquals(result.skillsCount, 14);

  // Check legacy backups were migrated OUT of claudeDest
  let legacyExistsInClaude = false;
  try {
    await Deno.stat(legacyInClaude);
    legacyExistsInClaude = true;
  } catch {
    legacyExistsInClaude = false;
  }
  assertFalse(legacyExistsInClaude, "Legacy backup must be migrated out of claudeDest");

  let ancientExistsInClaude = false;
  try {
    await Deno.stat(ancientInClaude);
    ancientExistsInClaude = true;
  } catch {
    ancientExistsInClaude = false;
  }
  assertFalse(ancientExistsInClaude, "Ancient backup must be migrated out of claudeDest");

  // Retained migrated backup exists in claudeBackupDest
  const migratedStat = await Deno.stat(join(claudeBackupDest, "old-skill.bak-20260815-100000"));
  assertEquals(migratedStat.isDirectory, true);

  // Ancient migrated backup was pruned from claudeBackupDest
  let ancientInBackup = false;
  try {
    await Deno.stat(join(claudeBackupDest, "ancient-skill.bak-20260701-100000"));
    ancientInBackup = true;
  } catch {
    ancientInBackup = false;
  }
  assertFalse(ancientInBackup, "Ancient backup must be pruned from claudeBackupDest");

  // Check expired backup in agyBackupDest was pruned
  let expiredExists = false;
  try {
    await Deno.stat(expiredInAgy);
    expiredExists = true;
  } catch {
    expiredExists = false;
  }
  assertFalse(expiredExists, "Expired backup must be pruned");

  // Verify all 14 skills are symlinked in both destinations
  const expectedSkills = [
    "backlog-groom",
    "book-gig",
    "delegate",
    "design-issue",
    "draft-pr",
    "drive-cleanup",
    "file-issue",
    "fix-labels",
    "flash-issues",
    "handle-gmails",
    "memory-cleanup",
    "pr-review",
    "venue-mining",
    "work-issue",
  ];

  for (const skill of expectedSkills) {
    const claudeLink = join(claudeDest, skill);
    const claudeStat = await Deno.lstat(claudeLink);
    assertEquals(claudeStat.isSymlink, true, `Claude skill ${skill} must be a symlink`);
    const claudeSkillMd = await Deno.stat(join(claudeLink, "SKILL.md"));
    assertEquals(claudeSkillMd.isFile, true);

    const agyLink = join(agyDest, skill);
    const agyStat = await Deno.lstat(agyLink);
    assertEquals(agyStat.isSymlink, true, `agy skill ${skill} must be a symlink`);
    const agySkillMd = await Deno.stat(join(agyLink, "SKILL.md"));
    assertEquals(agySkillMd.isFile, true);
  }

  // Verify NO *.bak-* exists inside claudeDest or agyDest
  for await (const entry of Deno.readDir(claudeDest)) {
    assertFalse(entry.name.includes(".bak-"));
  }
  for await (const entry of Deno.readDir(agyDest)) {
    assertFalse(entry.name.includes(".bak-"));
  }
});

Deno.test("installSkills throws when skills directory is missing", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "wjt-missing-skills-" });
  await assertRejects(
    () =>
      installSkills({
        repoDir: tempDir,
        claudeDest: join(tempDir, "claude"),
        agyDest: join(tempDir, "agy"),
        allowUnsafeForTesting: true,
      }),
    Error,
    "Skills source directory not found",
  );
});

Deno.test("defaultExecDeps runs commands", async () => {
  const res = await defaultExecDeps.runCmd(["echo", "hello world"]);
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "hello world");
});

Deno.test("CLI scripts/install-skills.ts refuses /tmp repo source", async () => {
  const fakeTmpRepo = await Deno.makeTempDir({ prefix: "fake-tmp-repo-" });
  await Deno.mkdir(join(fakeTmpRepo, "skills"), { recursive: true });

  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-env",
      "--allow-run",
      "--allow-read",
      "--allow-write",
      SCRIPT_PATH,
      "--repo-dir",
      fakeTmpRepo,
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stderr } = await cmd.output();
  const stderrStr = new TextDecoder().decode(stderr);
  assertEquals(code, 1);
  assertStringIncludes(stderrStr, "unsafe source directory (/tmp)");
  assertStringIncludes(stderrStr, fakeTmpRepo);
});

Deno.test("CLI scripts/install-skills.ts runs successfully in dry-run/quiet mode", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "cli-success-" });
  const fakeRepo = join(tempDir, "repo");
  const skillsDir = join(fakeRepo, "skills", "sample-skill");
  await Deno.mkdir(skillsDir, { recursive: true });
  await Deno.writeTextFile(join(skillsDir, "SKILL.md"), "test");

  const claudeDest = join(tempDir, "claude");
  const agyDest = join(tempDir, "agy");

  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-env",
      "--allow-run",
      "--allow-read",
      "--allow-write",
      SCRIPT_PATH,
      "--repo-dir",
      fakeRepo,
      "--claude-dest",
      claudeDest,
      "--agy-dest",
      agyDest,
      "--allow-unsafe-for-testing",
      "--quiet",
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout } = await cmd.output();
  const stdoutStr = new TextDecoder().decode(stdout);
  assertEquals(code, 0);
  assertEquals(stdoutStr, ""); // Quiet mode suppresses output
});
