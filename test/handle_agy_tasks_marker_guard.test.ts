// handle_agy_tasks_marker_guard.test.ts — web-jam-tools#395
//
// Exercises scripts/handle-agy-tasks.sh's BLOCKED / DO NOT START guard
// end-to-end by actually shelling out to it (Deno.Command) — same pattern as
// test/create_draft_pr_script.test.ts and test/block_agy_non_flash_model_hook
// .test.ts (re-implementing the regex in TypeScript would test a copy, not
// the real guard).
//
// The guard runs early in the script, right after it fetches the issue via
// `gh issue view` and before any git/worktree work. This suite stubs `gh`
// (prepended onto PATH) so no real GitHub call happens, and points
// AGY_WEBJAM_ROOT at a fixture directory that deliberately has NO folder for
// the target repo — so once the guard passes, the script fails immediately
// at its "repo folder not found" check (scripts/handle-agy-tasks.sh, right
// after the guard), long before it would fetch dev, create a worktree, or
// launch agy. This lets every case here run fully offline and never invoke
// the agy CLI or create a worktree, per the task's constraint.
//
// A REFUSE case is distinguished from a DISPATCH-NORMALLY case purely by
// which error fires: the guard's own refusal message (REFUSE) vs. the
// downstream "repo folder not found" message (DISPATCH-NORMALLY — the guard
// let it through and the script moved on).

import { assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH = new URL("../scripts/handle-agy-tasks.sh", import.meta.url).pathname;

const REPO = "TestRepo";
const ISSUE_NUM = "1";
const TASK_ARG = `${REPO}#${ISSUE_NUM}`;

const GUARD_REFUSAL_SNIPPET = "still contains a BLOCKED";
const REPO_NOT_FOUND_SNIPPET = "repo folder not found";

const FAKE_GH_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "issue" ] && [ "\${2:-}" = "view" ]; then
  jq -n --arg title "Test issue" --arg body "\${TEST_ISSUE_BODY:-}" '{title: $title, body: $body, comments: []}'
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "list" ]; then
  echo "[]"
  exit 0
fi
echo "unstubbed gh invocation: $*" >&2
exit 1
`;

interface RunResult {
  code: number;
  stderr: string;
}

async function runGuard(issueBody: string): Promise<RunResult> {
  const binDir = await Deno.makeTempDir({ prefix: "wjt395-bin-" });
  const fakeGhPath = `${binDir}/gh`;
  await Deno.writeTextFile(fakeGhPath, FAKE_GH_SCRIPT);
  await Deno.chmod(fakeGhPath, 0o755);

  // Deliberately does NOT contain a "TestRepo" folder — if the guard passes,
  // the script's very next check ("ERROR: repo folder not found") fires
  // before any git fetch / worktree / agy call.
  const webjamRoot = await Deno.makeTempDir({ prefix: "wjt395-webjam-" });

  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH, TASK_ARG],
    env: {
      ...Deno.env.toObject(),
      PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
      AGY_WEBJAM_ROOT: webjamRoot,
      TEST_ISSUE_BODY: issueBody,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

function assertRefused(res: RunResult) {
  assertEquals(res.code, 1, res.stderr);
  assertStringIncludes(res.stderr, GUARD_REFUSAL_SNIPPET);
  // The refusal must still name the issue and tell the operator to update
  // the body — required by web-jam-tools#395's acceptance criteria.
  assertStringIncludes(res.stderr, TASK_ARG);
  assertStringIncludes(res.stderr, "Update the issue BODY first");
}

function assertDispatchedNormally(res: RunResult) {
  // The guard let it through — the script proceeds and fails downstream (no
  // "TestRepo" folder in the fixture), never on the guard's own message.
  assertStringIncludes(res.stderr, REPO_NOT_FOUND_SNIPPET);
  if (res.stderr.includes(GUARD_REFUSAL_SNIPPET)) {
    throw new Error(`expected no guard refusal, got: ${res.stderr}`);
  }
}

// --- must REFUSE: status declaration at line start ---

Deno.test("bold marker alone on a line is refused", async () => {
  const res = await runGuard("**BLOCKED**");
  assertRefused(res);
});

Deno.test("blockquote marker with explanation is refused", async () => {
  const res = await runGuard("> BLOCKED: waiting on Josh's call before this proceeds");
  assertRefused(res);
});

Deno.test("markdown heading whose text is the marker word is refused", async () => {
  const res = await runGuard("## BLOCKED");
  assertRefused(res);
});

Deno.test("marker followed by colon and reason is refused", async () => {
  const res = await runGuard("BLOCKED: waiting on external review");
  assertRefused(res);
});

Deno.test("red-circle emoji then marker word is refused", async () => {
  const res = await runGuard("🔴 BLOCKED");
  assertRefused(res);
});

Deno.test("DO NOT START, space-separated, is refused", async () => {
  const res = await runGuard("DO NOT START until Josh approves the design");
  assertRefused(res);
});

Deno.test("DO-NOT-START, hyphen-separated, is refused", async () => {
  const res = await runGuard("DO-NOT-START until Josh approves the design");
  assertRefused(res);
});

Deno.test("marker as the only line within a longer body is refused", async () => {
  const res = await runGuard(
    "Some spec text describing the feature.\n\n**BLOCKED**\n\nMore context below.",
  );
  assertRefused(res);
});

// --- must DISPATCH NORMALLY: prose, no status declaration ---

Deno.test("marker word mid-sentence describing a hook's behavior dispatches normally", async () => {
  const res = await runGuard(
    "The pre-push hook BLOCKED the force-push and printed a warning to the operator.",
  );
  assertDispatchedNormally(res);
});

Deno.test("marker word inside a table cell, not at line start, dispatches normally", async () => {
  const res = await runGuard("| Guard | Status |\n| --- | --- |\n| push guard | BLOCKED |");
  assertDispatchedNormally(res);
});

Deno.test("sentence containing UNBLOCKED dispatches normally", async () => {
  const res = await runGuard("This issue is now UNBLOCKED and ready to be picked up.");
  assertDispatchedNormally(res);
});

Deno.test("sentence containing unblocking dispatches normally", async () => {
  const res = await runGuard("We are unblocking the deploy pipeline as part of this change.");
  assertDispatchedNormally(res);
});

Deno.test(
  "sentence with do/not/start present but not as the contiguous phrase dispatches normally",
  async () => {
    const res = await runGuard(
      "Do this work first, but not that one yet — start with the tests once ready.",
    );
    assertDispatchedNormally(res);
  },
);

// --- "Blocked by <issue citation>" dependency-reference carve-out (found live
// on web-jam-tools#815, whose closed-dependency prose refused dispatch) ---

Deno.test(
  "bold 'Blocked by' with a closed issue citation dispatches normally",
  async () => {
    const res = await runGuard(
      '**Blocked by** `web-jam-tools#814 "Add the installer-scope, load-bearing-premises and target-issue-body rules to the design-issue skill body"`\n— the checker cannot enforce rules the skill body does not yet state.',
    );
    assertDispatchedNormally(res);
  },
);

Deno.test(
  "bare 'Blocked by #NNN' with no other decoration dispatches normally",
  async () => {
    const res = await runGuard("Blocked by #814 — see that issue for the dependency.");
    assertDispatchedNormally(res);
  },
);

Deno.test(
  "'Blocked by <cause>' with no issue citation is still refused",
  async () => {
    const res = await runGuard("**Blocked by** missing vendor API credentials — do not start.");
    assertRefused(res);
  },
);

Deno.test(
  "bare 'BLOCKED' status declaration is still refused even when a later line cites an issue",
  async () => {
    const res = await runGuard(
      "**BLOCKED**\n\nSee web-jam-tools#814 for background once it lands.",
    );
    assertRefused(res);
  },
);
