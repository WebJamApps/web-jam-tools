// manifest.test.ts — web-jam-tools#233
//
// test/skills_validation.test.ts iterates skills/*/ dynamically and only
// asserts `length > 0`, so deleting a skill directory passes CI silently;
// hooks/ has no set-guard at all, so deleting or silently adding an
// unlisted hook script also passes CI silently. This test pins the exact
// expected set of both skill directories and hook scripts, and fails on
// ANY drift in either direction: a MISSING entry (accidental deletion) or
// an UNLISTED EXTRA (silent addition).
//
// The pinned lists below are the source of truth. If you deliberately add,
// rename, or remove a skill directory or hook script, update the matching
// list in THIS file as part of that change — that is the point of the
// guard, not an oversight to work around.

import { assert } from "@std/assert";

const SKILLS_DIR = new URL("../skills/", import.meta.url).pathname;
const HOOKS_DIR = new URL("../hooks/", import.meta.url).pathname;

// Pinned set of skills/*/ directory names. Update deliberately.
const EXPECTED_SKILL_DIRS = [
  "backlog-groom",
  "delegate",
  "draft-issue",
  "draft-pr",
  "drive-cleanup",
  "fix-labels",
  "flash-issues",
  "handle-gmails",
  "issue-design",
  "memory-cleanup",
  "pr-review",
  "venue-mining",
  "work-issue",
];

// Pinned set of hooks/*.sh filenames. Update deliberately.
const EXPECTED_HOOK_SCRIPTS = [
  "backlog-groom-reminder.sh",
  "backup-refusal-reminder.sh",
  "block-agy-non-flash-model.sh",
  "block-dangerous-git-deploy.sh",
  "block-human-only-credentials.sh",
  "block-irreversible-operations.sh",
  "block-secret-dumps.sh",
  // PreToolUse guard (web-jam-tools#304) — blocks a Bash command that
  // carries a credential-shaped LITERAL, before it can be approved and
  // persisted verbatim into permissions.allow.
  "block-secret-literals.sh",
  "feature-branch-guard.sh",
  "flash-issues-reminder.sh",
  "fmt-push-guard.sh",
  "gh-api-guard.sh",
  "haiku-only-gmail-gate.sh",
  "memory-cleanup-reminder.sh",
  "notes-sync-reminder.sh",
  // Stop hook (web-jam-tools#290) — detective-only warning when an Opus
  // turn racks up edits with zero subagent spawns.
  "opus-no-delegation-warning.sh",
  // Stop hook (web-jam-tools#311) — BLOCKING: rejects a message that cites
  // an issue/PR without its title (repo#number "title").
  "require-issue-citation-titles.sh",
  "require-model-label-on-issue-create.sh",
  // PostToolUse output scanner (web-jam-tools#272) — the first non-PreToolUse
  // guard here, and the only one that inspects output rather than commands.
  "scan-output-for-secrets.sh",
  "semver-push-reminder.sh",
];

function listSkillDirs(): string[] {
  const dirs: string[] = [];
  for (const entry of Deno.readDirSync(SKILLS_DIR)) {
    if (entry.isDirectory) dirs.push(entry.name);
  }
  return dirs;
}

function listHookScripts(): string[] {
  const files: string[] = [];
  for (const entry of Deno.readDirSync(HOOKS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sh")) files.push(entry.name);
  }
  return files;
}

/**
 * Assert that `actual` and `expected` contain exactly the same names
 * (order-independent). On mismatch, reports missing (present in expected,
 * absent in actual — i.e. accidentally deleted) and unexpected (present in
 * actual, absent in expected — i.e. silently added but not pinned) names
 * separately, plus a reminder to update the manifest deliberately.
 */
function assertExactSet(actual: string[], expected: string[], label: string) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);

  const missing = expected.filter((name) => !actualSet.has(name));
  const unexpected = actual.filter((name) => !expectedSet.has(name));

  assert(
    missing.length === 0 && unexpected.length === 0,
    `${label} drifted from the pinned manifest in test/manifest.test.ts.\n` +
      `  missing (expected but not found — check for accidental deletion): ${
        missing.length ? missing.join(", ") : "(none)"
      }\n` +
      `  unexpected (found but not pinned — check for silent/unlisted addition): ${
        unexpected.length ? unexpected.join(", ") : "(none)"
      }\n` +
      `  If this change is intentional, update the pinned list in test/manifest.test.ts DELIBERATELY.`,
  );
}

Deno.test("skills/ directory set exactly matches the pinned manifest", () => {
  assertExactSet(listSkillDirs(), EXPECTED_SKILL_DIRS, "skills/*/ directories");
});

Deno.test("hooks/*.sh file set exactly matches the pinned manifest", () => {
  assertExactSet(listHookScripts(), EXPECTED_HOOK_SCRIPTS, "hooks/*.sh files");
});

// web-jam-tools#285 — a hook could ship with no behaviour test and the gate
// stayed green (hooks/block-dangerous-git-deploy.sh ran unguarded for six
// weeks with zero tests). This asserts every hooks/*.sh has a corresponding
// test/<hook_name_underscored>_hook.test.ts, the convention the five hooks
// tested before #285 already follow. Hooks are enumerated dynamically via
// listHookScripts() (not a hardcoded list) so this assertion needs no edit
// when a hook is added/removed elsewhere — it only cares that whatever is on
// disk right now has a matching test file.

function expectedTestFileFor(hookScript: string): string {
  const base = hookScript.replace(/\.sh$/, "").replace(/-/g, "_");
  return `${base}_hook.test.ts`;
}

function testFileExists(name: string): boolean {
  try {
    Deno.statSync(new URL(`./${name}`, import.meta.url));
    return true;
  } catch {
    return false;
  }
}

Deno.test("every hooks/*.sh has a corresponding behaviour test", () => {
  const missing = listHookScripts()
    .map((hook) => ({ hook, testFile: expectedTestFileFor(hook) }))
    .filter(({ testFile }) => !testFileExists(testFile))
    .map(({ hook, testFile }) => `  hooks/${hook} -> expected test/${testFile} (missing)`);

  assert(
    missing.length === 0,
    "Every hooks/*.sh needs a behaviour test named test/<hook_name_underscored>_hook.test.ts " +
      "(web-jam-tools#285 — a hook shipped with no test and the gate stayed green).\n" +
      missing.join("\n") +
      "\n  See test/block_agy_non_flash_model_hook.test.ts for the established pattern.",
  );
});
