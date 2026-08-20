// direct_hook_commands.test.ts — web-jam-tools#683
//
// Tests that extractDirectCommandHookScripts and getGitTrackedModes accurately
// extract all hook scripts registered as direct commands from scripts/install-hooks.sh
// across both Claude Code and agy surfaces, while excluding bash-invoked targets
// (agy-model-guard.sh, block-agy-gmail-send-delete.sh), TypeScript modules, and YAML data.

import { assert, assertEquals, assertExists } from "@std/assert";
import {
  extractDirectCommandHookScripts,
  getGitTrackedModes,
} from "../hooks/lib/direct_hook_commands.ts";

const INSTALL_HOOKS_PATH = new URL(
  "../scripts/install-hooks.sh",
  import.meta.url,
).pathname;
const REPO_DIR = new URL("../", import.meta.url).pathname;

Deno.test("extractDirectCommandHookScripts extracts Claude and agy direct commands from install-hooks.sh", () => {
  const installerContent = Deno.readTextFileSync(INSTALL_HOOKS_PATH);
  const direct = extractDirectCommandHookScripts(installerContent);

  // Must include Claude Code SessionStart hooks
  assert(direct.has("notes-sync-reminder.sh"));
  assert(direct.has("memory-cleanup-reminder.sh"));
  assert(direct.has("flash-issues-reminder.sh"));
  assert(direct.has("backlog-groom-reminder.sh"));
  assert(direct.has("backup-refusal-reminder.sh"));
  assert(direct.has("hook-install-drift-reminder.sh"));

  // Must include Claude Code Stop hooks
  assert(direct.has("require-issue-citation-titles.sh"));
  assert(direct.has("require-clear-communication.sh"));

  // Must include Claude Code PreToolUse and PostToolUse hooks
  assert(direct.has("semver-push-reminder.sh"));
  assert(direct.has("block-secret-dumps.sh"));
  assert(direct.has("block-secret-literals.sh"));
  assert(direct.has("block-dangerous-git-deploy.sh"));
  assert(direct.has("gh-api-guard.sh"));
  assert(direct.has("block-irreversible-operations.sh"));
  assert(direct.has("fmt-push-guard.sh"));
  assert(direct.has("block-agy-non-flash-model.sh"));
  assert(direct.has("block-human-only-credentials.sh"));
  assert(direct.has("feature-branch-guard.sh"));
  assert(direct.has("haiku-only-gmail-gate.sh"));
  assert(direct.has("require-model-label-on-issue-create.sh"));
  assert(direct.has("block-out-of-tree-write.sh"));
  assert(direct.has("opus-delegation-gate.sh"));
  assert(direct.has("require-approval-token-on-issue-write.sh"));
  assert(direct.has("scan-output-for-secrets.sh"));

  // Must include agy direct command wrapper
  assert(direct.has("agy-hook-shim.sh"));

  // Deliberately must NOT include bash-invoked targets or non-direct scripts
  assert(!direct.has("agy-model-guard.sh"));
  assert(!direct.has("block-agy-gmail-send-delete.sh"));
});

Deno.test("getGitTrackedModes reads tracked modes from git index", async () => {
  const modes = await getGitTrackedModes(REPO_DIR);

  // Check known files in hooks/
  assertExists(modes.get("agy-hook-shim.sh"));
  assertExists(modes.get("agy-model-guard.sh"));
  assertExists(modes.get("block-agy-gmail-send-delete.sh"));
  assertExists(modes.get("opus-delegation-gate.sh"));

  // agy-model-guard and block-agy-gmail-send-delete are tracked as 100644 (bash-invoked)
  assertEquals(modes.get("agy-model-guard.sh"), "100644");
  assertEquals(modes.get("block-agy-gmail-send-delete.sh"), "100644");
});
