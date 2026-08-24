// test/prune_local_permission_allows.test.ts — web-jam-tools#341

import { assertEquals, assertMatch, assertThrows } from "@std/assert";
import {
  CANONICAL_CREATE_DRAFT_PR_RULES,
  checkSettingsBackup,
  getDefaultTargetFiles,
  processTargetFile,
  R11_MCP_ALLOWS,
  R5_BLANKET_WILDCARDS,
  shouldPruneRule,
  TASK_RUNNER_BLANKET_WILDCARDS,
} from "../src/prune-local-permission-allows/prune.ts";
import { runCli } from "../src/prune-local-permission-allows/cli.ts";

Deno.test("shouldPruneRule - R-5 blanket wildcards", () => {
  for (const wildcard of R5_BLANKET_WILDCARDS) {
    const res = shouldPruneRule(wildcard);
    assertEquals(res.prune, true, `Expected ${wildcard} to be pruned`);
    assertEquals(res.reason, "R-5");
  }
});

Deno.test("shouldPruneRule - task-runner blanket wildcards (web-jam-tools#685, §3a)", () => {
  for (const wildcard of TASK_RUNNER_BLANKET_WILDCARDS) {
    const res = shouldPruneRule(wildcard);
    assertEquals(res.prune, true, `Expected ${wildcard} to be pruned`);
    assertEquals(res.reason, "TASK-RUNNER-BLANKET");
  }
});

Deno.test("shouldPruneRule - a narrow deno task allow rule (e.g. the new post-pr-review ALLOW_RULES entry) survives", () => {
  const res = shouldPruneRule("Bash(deno task post-pr-review *)");
  assertEquals(res.prune, false);
});

Deno.test("shouldPruneRule - R-11 MCP write allows", () => {
  for (const mcpRule of R11_MCP_ALLOWS) {
    const res = shouldPruneRule(mcpRule);
    assertEquals(res.prune, true, `Expected ${mcpRule} to be pruned`);
    assertEquals(res.reason, "R-11");
  }
});

Deno.test("shouldPruneRule - R-20 canonical create-draft-pr.sh spellings survive", () => {
  for (const canonical of CANONICAL_CREATE_DRAFT_PR_RULES) {
    const res = shouldPruneRule(canonical);
    assertEquals(
      res.prune,
      false,
      `Expected canonical rule ${canonical} to survive`,
    );
  }
});

Deno.test("shouldPruneRule - R-20 frozen strings and worktree wildcards are pruned", () => {
  const worktreeRule =
    "Bash(/home/joshua/WebJamApps/web-jam-tools/.claude/worktrees/agent-afd895f9f8b87c513/scripts/create-draft-pr.sh *)";
  const resWorktree = shouldPruneRule(worktreeRule);
  assertEquals(resWorktree.prune, true);
  assertEquals(resWorktree.reason, "R-20");

  const frozenString =
    "Bash(./scripts/create-draft-pr.sh --author 'Claude Code — Sonnet 5' --summary 'Test summary' --test-plan 'npm test' --test-evidence 'green')";
  const resFrozen = shouldPruneRule(frozenString);
  assertEquals(resFrozen.prune, true);
  assertEquals(resFrozen.reason, "R-20");

  const syntaxCheck = "Bash(shellcheck scripts/create-draft-pr.sh)";
  const resSyntax = shouldPruneRule(syntaxCheck);
  assertEquals(resSyntax.prune, true);
  assertEquals(resSyntax.reason, "R-20");
});

Deno.test("shouldPruneRule - unrelated allow rules survive", () => {
  const unrelatedRules = [
    'Bash(curl -s "https://circleci.com/api/v1.1/project/gh/WebJamApps/CollegeLutheran/1662")',
    "Bash(git status)",
    "WebFetch(domain:app.circleci.com)",
    "Bash(node *)",
    "Bash(printenv CIRCLECI_TOKEN)",
  ];

  for (const rule of unrelatedRules) {
    const res = shouldPruneRule(rule);
    assertEquals(res.prune, false, `Expected ${rule} to survive`);
  }
});

Deno.test("checkSettingsBackup - handles missing and existing backup paths", () => {
  const tempDir = Deno.makeTempDirSync();
  try {
    const missingRes = checkSettingsBackup(tempDir);
    assertEquals(missingRes.present, false);
    assertEquals(missingRes.path, `${tempDir}/claude-config/settings.json`);

    const configDir = `${tempDir}/claude-config`;
    Deno.mkdirSync(configDir, { recursive: true });
    const backupFile = `${configDir}/settings.json`;
    Deno.writeTextFileSync(backupFile, '{"permissions":{}}');

    const existingRes = checkSettingsBackup(tempDir);
    assertEquals(existingRes.present, true);
    assertEquals(existingRes.path, backupFile);
    assertEquals(typeof existingRes.timestamp, "string");
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
  }
});

Deno.test("processTargetFile - dry run does not modify target file", () => {
  const tempDir = Deno.makeTempDirSync();
  const filePath = `${tempDir}/settings.local.json`;
  const initialContent = JSON.stringify(
    {
      permissions: {
        allow: [
          "Bash(git status)",
          "Bash(gh pr *)",
          "mcp__claude_ai_GitHub_MCP__issue_write",
          "Bash(scripts/create-draft-pr.sh *)",
          "Bash(./scripts/create-draft-pr.sh --author 'Test')",
        ],
      },
    },
    null,
    2,
  );

  Deno.writeTextFileSync(filePath, initialContent);

  try {
    const res = processTargetFile(filePath, false, "20260806-120000");
    assertEquals(res.exists, true);
    assertEquals(res.beforeCount, 5);
    assertEquals(res.afterCount, 2);
    assertEquals(res.removedEntries.length, 3);
    assertEquals(res.backedUpTo, undefined);

    // Verify file content on disk is untouched
    const afterContent = Deno.readTextFileSync(filePath);
    assertEquals(afterContent, initialContent);
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
  }
});

Deno.test("processTargetFile - apply mode backs up and modifies target file cleanly", () => {
  const tempDir = Deno.makeTempDirSync();
  const filePath = `${tempDir}/settings.local.json`;
  const initialContent = JSON.stringify(
    {
      permissions: {
        allow: [
          "Bash(git status)",
          "Bash(gh pr *)",
          "mcp__claude_ai_GitHub_MCP__issue_write",
          "Bash(scripts/create-draft-pr.sh *)",
          "Bash(./scripts/create-draft-pr.sh --author 'Test')",
        ],
      },
    },
    null,
    2,
  );

  Deno.writeTextFileSync(filePath, initialContent);

  try {
    const stamp = "20260806-120000";
    const res = processTargetFile(filePath, true, stamp);
    assertEquals(res.exists, true);
    assertEquals(res.beforeCount, 5);
    assertEquals(res.afterCount, 2);
    assertEquals(res.removedEntries.length, 3);
    assertEquals(res.backedUpTo, `${filePath}.bak-${stamp}`);

    // Verify backup file exists and matches initial content
    const backupContent = Deno.readTextFileSync(`${filePath}.bak-${stamp}`);
    assertEquals(backupContent, initialContent);

    // Verify target file was updated and parses as valid JSON
    const updatedContent = Deno.readTextFileSync(filePath);
    const parsed = JSON.parse(updatedContent);
    assertEquals(parsed.permissions.allow, [
      "Bash(git status)",
      "Bash(scripts/create-draft-pr.sh *)",
    ]);
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
  }
});

Deno.test("processTargetFile - skips non-existent file cleanly", () => {
  const tempDir = Deno.makeTempDirSync();
  const filePath = `${tempDir}/does_not_exist.json`;

  try {
    const res = processTargetFile(filePath, false, "20260806-120000");
    assertEquals(res.exists, false);
    assertEquals(res.beforeCount, 0);
    assertEquals(res.afterCount, 0);
    assertEquals(res.removedEntries.length, 0);
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
  }
});

Deno.test("processTargetFile - throws error on invalid JSON", () => {
  const tempDir = Deno.makeTempDirSync();
  const filePath = `${tempDir}/invalid.json`;
  Deno.writeTextFileSync(filePath, "{ invalid json }");

  try {
    assertThrows(
      () => {
        processTargetFile(filePath, false, "20260806-120000");
      },
      Error,
      "contains invalid JSON",
    );
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
  }
});

Deno.test("runCli - integrates dry run and apply against fixture files", () => {
  const tempDir = Deno.makeTempDirSync();
  const file1 = `${tempDir}/settings1.local.json`;
  const file2 = `${tempDir}/settings2.local.json`;

  const content1 = JSON.stringify({
    permissions: {
      allow: ["Bash(git status)", "Bash(gh pr *)"],
    },
  });
  const content2 = JSON.stringify({
    permissions: {
      allow: ["Bash(scripts/create-draft-pr.sh *)"],
    },
  });

  Deno.writeTextFileSync(file1, content1);
  Deno.writeTextFileSync(file2, content2);

  try {
    const codeDry = runCli([
      "--target-file",
      file1,
      "--target-file",
      file2,
      "--backup-dst-dir",
      tempDir,
    ]);
    assertEquals(codeDry, 0);
    assertEquals(Deno.readTextFileSync(file1), content1);

    const codeApply = runCli([
      "--apply",
      "--target-file",
      file1,
      "--target-file",
      file2,
      "--backup-dst-dir",
      tempDir,
    ]);
    assertEquals(codeApply, 0);
    const parsed1 = JSON.parse(Deno.readTextFileSync(file1));
    assertEquals(parsed1.permissions.allow, ["Bash(git status)"]);
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
  }
});

Deno.test("runCli - returns 1 when processing invalid JSON file", () => {
  const tempDir = Deno.makeTempDirSync();
  const badFile = `${tempDir}/bad.json`;
  Deno.writeTextFileSync(badFile, "BAD JSON");

  try {
    const code = runCli(["--target-file", badFile]);
    assertEquals(code, 1);
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
  }
});

Deno.test("getDefaultTargetFiles - returns array of 4 target file paths", () => {
  const defaultFiles = getDefaultTargetFiles();
  assertEquals(defaultFiles.length, 4);
  assertMatch(defaultFiles[0], /\.claude\/settings\.local\.json$/);
  assertMatch(defaultFiles[1], /JaMmusic\/\.claude\/settings\.local\.json$/);
  assertMatch(
    defaultFiles[2],
    /WebJamSocketCluster\/\.claude\/settings\.local\.json$/,
  );
  assertMatch(defaultFiles[3], /web-jam-back\/\.claude\/settings\.local\.json$/);
});
