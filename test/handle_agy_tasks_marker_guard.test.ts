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
  if [ -n "\${TEST_VIEW_EXIT:-}" ] && [ "\${TEST_VIEW_EXIT}" != "0" ]; then
    exit "\${TEST_VIEW_EXIT}"
  fi
  if [ "\${TEST_BODY_NULL:-}" = "1" ]; then
    jq -n --arg title "Test issue" '{title: $title, body: null, comments: []}'
  else
    jq -n --arg title "Test issue" --arg body "\${TEST_ISSUE_BODY:-}" '{title: $title, body: $body, comments: []}'
  fi
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "list" ]; then
  echo "[]"
  exit 0
fi
if [ "\${1:-}" = "api" ]; then
  if [ -n "\${TEST_DEP_EXIT:-}" ] && [ "\${TEST_DEP_EXIT}" != "0" ]; then
    exit "\${TEST_DEP_EXIT}"
  fi
  printf '%s' "\${TEST_DEP_JSON-[]}"
  exit 0
fi
echo "unstubbed gh invocation: $*" >&2
exit 1
`;

interface RunResult {
  code: number;
  stderr: string;
}

interface GuardOptions {
  // Verbatim stdout for the stubbed `gh api .../dependencies/blocked_by`
  // call. Omitted -> the stub's own default ("[]"), which is what all 20
  // pre-existing tests rely on implicitly. An explicitly empty string is
  // preserved (not coerced to "[]") so the "empty response" failure mode is
  // reachable too.
  depJson?: string;
  // Non-zero exit code for the stubbed `gh api` call, simulating a failed
  // dependency query (network/auth/API error). Omitted -> the stub exits 0.
  depExit?: string;
  // Non-zero exit code for the stubbed `gh issue view` call itself, simulating
  // a failed issue fetch (network/auth/API error). Omitted -> the stub exits 0.
  viewExit?: string;
  // When true, the stubbed `gh issue view` returns a literal JSON `null` body
  // (distinct from an empty string) — jq -r renders that as the text "null".
  bodyNull?: boolean;
}

async function runGuard(issueBody: string, opts: GuardOptions = {}): Promise<RunResult> {
  const binDir = await Deno.makeTempDir({ prefix: "wjt395-bin-" });
  const fakeGhPath = `${binDir}/gh`;
  await Deno.writeTextFile(fakeGhPath, FAKE_GH_SCRIPT);
  await Deno.chmod(fakeGhPath, 0o755);

  // Deliberately does NOT contain a "TestRepo" folder — if the guard passes,
  // the script's very next check ("ERROR: repo folder not found") fires
  // before any git fetch / worktree / agy call.
  const webjamRoot = await Deno.makeTempDir({ prefix: "wjt395-webjam-" });

  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
    AGY_WEBJAM_ROOT: webjamRoot,
    TEST_ISSUE_BODY: issueBody,
  };
  if (opts.depJson !== undefined) env.TEST_DEP_JSON = opts.depJson;
  if (opts.depExit !== undefined) env.TEST_DEP_EXIT = opts.depExit;
  if (opts.viewExit !== undefined) env.TEST_VIEW_EXIT = opts.viewExit;
  if (opts.bodyNull) env.TEST_BODY_NULL = "1";

  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH, TASK_ARG],
    env,
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

// A REFUSE case from the native blocked_by dependency guard (web-jam-tools#847)
// is distinguished from the body-text guard's refusal by wording: both
// mention the dependency query/blocker explicitly (the word "dependency"),
// while the body-text guard's message never does — it only ever says "still
// contains a BLOCKED / DO NOT START marker".
function assertRefusedByDependency(res: RunResult) {
  assertEquals(res.code, 1, res.stderr);
  assertStringIncludes(res.stderr, "dependency");
  if (res.stderr.includes(GUARD_REFUSAL_SNIPPET)) {
    throw new Error(
      `expected a dependency-guard refusal, not the body-text guard's: ${res.stderr}`,
    );
  }
}

// A refusal from the dependency guard's SEARCH-FAILURE path (the query
// itself failed or returned something unparseable) is wordier and distinct
// from a BLOCKER-FOUND refusal ("has an OPEN native blocked_by dependency").
// A bug that misreported a failed query as a found blocker (or vice versa)
// would still pass assertRefusedByDependency's loose "dependency" substring
// check, so cases 7 and 8 — which are specifically about the search-failure
// path — assert this more specific wording instead.
function assertRefusedBySearchFailure(res: RunResult) {
  assertEquals(res.code, 1, res.stderr);
  assertStringIncludes(res.stderr, "cannot confirm");
  assertStringIncludes(res.stderr, "is unblocked");
  if (res.stderr.includes("OPEN native blocked_by dependency")) {
    throw new Error(
      `expected a search-failure refusal, not a blocker-found refusal: ${res.stderr}`,
    );
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

Deno.test(
  "a carve-out dependency reference alongside a separate real DO NOT START line is still refused",
  async () => {
    const res = await runGuard(
      '**Blocked by** `web-jam-tools#814 "..."`\n\nDO NOT START until Josh approves the design.',
    );
    assertRefused(res);
  },
);

Deno.test(
  "two 'Blocked by' dependency-reference lines together dispatch normally",
  async () => {
    const res = await runGuard(
      "Blocked by #814 — see that issue for the dependency.\nBlocked by #820 — and this one too.",
    );
    assertDispatchedNormally(res);
  },
);

Deno.test(
  "'BLOCKED BY <vague cause>' that happens to cite an issue further along the line is still refused",
  async () => {
    const res = await runGuard(
      "BLOCKED BY the vendor's SSO rollout — context in #12",
    );
    assertRefused(res);
  },
);

// --- native blocked_by dependency guard (web-jam-tools#847) ---
//
// The guard runs BEFORE the body-text guard and asks GitHub's own dependency
// graph, not prose, whether the issue is blocked. Cases 1-8 below are the
// dependency-API enumerated cases from the issue body; the ordinary issue
// body text used throughout carries no marker, so a refusal always comes
// from the dependency guard, never the text guard.

Deno.test(
  "dependency API case 1: empty array dispatches normally",
  async () => {
    const res = await runGuard("An ordinary issue body with no markers.", { depJson: "[]" });
    assertDispatchedNormally(res);
  },
);

Deno.test(
  "dependency API case 2: single closed blocker dispatches normally",
  async () => {
    const depJson = JSON.stringify([
      {
        number: 814,
        state: "closed",
        title: "A now-closed blocker",
        repository: { name: "web-jam-tools" },
      },
    ]);
    const res = await runGuard("An ordinary issue body with no markers.", { depJson });
    assertDispatchedNormally(res);
  },
);

Deno.test(
  "dependency API case 3: single open blocker refuses and names it by repo, number and title",
  async () => {
    const depJson = JSON.stringify([
      {
        number: 814,
        state: "open",
        title: "Add the installer-scope rule",
        repository: { name: "web-jam-tools" },
      },
    ]);
    const res = await runGuard("An ordinary issue body with no markers.", { depJson });
    assertRefusedByDependency(res);
    assertStringIncludes(res.stderr, "web-jam-tools#814");
    assertStringIncludes(res.stderr, "Add the installer-scope rule");
  },
);

Deno.test(
  "dependency API case 4: mixed open+closed blockers names only the open one",
  async () => {
    const depJson = JSON.stringify([
      { number: 814, state: "open", title: "Open blocker", repository: { name: "web-jam-tools" } },
      {
        number: 820,
        state: "closed",
        title: "Closed blocker",
        repository: { name: "web-jam-tools" },
      },
    ]);
    const res = await runGuard("An ordinary issue body with no markers.", { depJson });
    assertRefusedByDependency(res);
    assertStringIncludes(res.stderr, "web-jam-tools#814");
    if (res.stderr.includes("#820")) {
      throw new Error(`expected the closed blocker #820 not to be named: ${res.stderr}`);
    }
  },
);

Deno.test(
  "dependency API case 5: two open blockers names both",
  async () => {
    const depJson = JSON.stringify([
      {
        number: 814,
        state: "open",
        title: "First open blocker",
        repository: { name: "web-jam-tools" },
      },
      {
        number: 820,
        state: "open",
        title: "Second open blocker",
        repository: { name: "web-jam-tools" },
      },
    ]);
    const res = await runGuard("An ordinary issue body with no markers.", { depJson });
    assertRefusedByDependency(res);
    assertStringIncludes(res.stderr, "web-jam-tools#814");
    assertStringIncludes(res.stderr, "web-jam-tools#820");
  },
);

Deno.test(
  "dependency API case 6: cross-repo open blocker names its own repository, not this one",
  async () => {
    const depJson = JSON.stringify([
      { number: 99, state: "open", title: "Cross-repo blocker", repository: { name: "JaMmusic" } },
    ]);
    const res = await runGuard("An ordinary issue body with no markers.", { depJson });
    assertRefusedByDependency(res);
    assertStringIncludes(res.stderr, "JaMmusic#99");
    if (res.stderr.includes("web-jam-tools#99")) {
      throw new Error(
        `expected the cross-repo blocker not to be mislabeled with this repo: ${res.stderr}`,
      );
    }
  },
);

Deno.test(
  "dependency API case 7: a failed dependency query (non-zero exit, empty stdout) refuses via the search-failure path, not a blocker-found refusal",
  async () => {
    const res = await runGuard("An ordinary issue body with no markers.", { depExit: "1" });
    assertRefusedBySearchFailure(res);
    assertStringIncludes(res.stderr, "the dependency query failed");
  },
);

Deno.test(
  "dependency API case 8: a 'null' payload refuses via the search-failure path, not a blocker-found refusal",
  async () => {
    const res = await runGuard("An ordinary issue body with no markers.", { depJson: "null" });
    assertRefusedBySearchFailure(res);
    assertStringIncludes(res.stderr, "not a JSON array");
  },
);

Deno.test(
  "dependency API case 8b: an unrecognized-case state ('OPEN') is still treated as blocking",
  async () => {
    const depJson = JSON.stringify([
      {
        number: 814,
        state: "OPEN",
        title: "Uppercase-state blocker",
        repository: { name: "web-jam-tools" },
      },
    ]);
    const res = await runGuard("An ordinary issue body with no markers.", { depJson });
    assertRefusedByDependency(res);
    assertStringIncludes(res.stderr, "web-jam-tools#814");
  },
);

Deno.test(
  "dependency API case 8c: a blocker with a missing/null state fails closed (treated as blocking)",
  async () => {
    const depJson = JSON.stringify([
      {
        number: 814,
        title: "Blocker with no state field at all",
        repository: { name: "web-jam-tools" },
      },
    ]);
    const res = await runGuard("An ordinary issue body with no markers.", { depJson });
    assertRefusedByDependency(res);
    assertStringIncludes(res.stderr, "web-jam-tools#814");
  },
);

// --- body text case 13 (the one genuinely missing from the pre-existing 20:
// a body with no marker at all, dependency API returning [] explicitly to
// prove the two checks are independent) ---

Deno.test(
  "body text case 13: no marker at all dispatches normally with the dependency API returning []",
  async () => {
    const res = await runGuard(
      "Implement the feature as described here. Nothing here is blocking anything.",
      { depJson: "[]" },
    );
    assertDispatchedNormally(res);
  },
);

// --- combination cases 14-15: proving the dependency guard and the body-text
// guard are ANDed and neither masks the other ---

Deno.test(
  "combination case 14: text carve-out plus an open API blocker refuses with the dependency reason",
  async () => {
    const depJson = JSON.stringify([
      {
        number: 814,
        state: "open",
        title: "Still-open dependency",
        repository: { name: "web-jam-tools" },
      },
    ]);
    const res = await runGuard(
      '**Blocked by** `web-jam-tools#814 "..."`',
      { depJson },
    );
    // Refuses via the dependency guard (which runs first) — not the
    // body-text guard, even though the body's carve-out line would have let
    // the text guard dispatch on its own.
    assertRefusedByDependency(res);
  },
);

Deno.test(
  "combination case 15: bare BLOCKED text guard still fires when the dependency API returns no blockers",
  async () => {
    const res = await runGuard("**BLOCKED**", { depJson: "[]" });
    assertRefused(res);
  },
);

// --- mention vs. use: a quoted marker (inline code / fenced code) is not a
// status declaration (web-jam-tools#903, enumerated cases 7-12) ---

function assertRefusedByUnreadableBody(res: RunResult) {
  assertEquals(res.code, 1, res.stderr);
  assertStringIncludes(res.stderr, "body could not be read");
}

Deno.test(
  "body text case 7: a backtick-quoted marker followed by ordinary prose dispatches normally",
  async () => {
    const res = await runGuard(
      "`DO NOT START` status declaration, which is how a non-GitHub prerequisite is expressed",
    );
    assertDispatchedNormally(res);
  },
);

Deno.test(
  "body text case 8: a line consisting only of a backtick-quoted marker dispatches normally",
  async () => {
    const res = await runGuard("`BLOCKED`");
    assertDispatchedNormally(res);
  },
);

Deno.test(
  "body text case 9: a bare marker line inside a closed ``` fence dispatches normally",
  async () => {
    const res = await runGuard("```\nBLOCKED\n```");
    assertDispatchedNormally(res);
  },
);

Deno.test(
  "body text case 10: a bare marker line inside a closed ~~~ fence dispatches normally",
  async () => {
    const res = await runGuard("~~~\nBLOCKED\n~~~");
    assertDispatchedNormally(res);
  },
);

Deno.test(
  "body text case 11: an opening ``` fence with no closing fence does not suppress a bare marker's refusal",
  async () => {
    const res = await runGuard("```\nBLOCKED");
    assertRefused(res);
  },
);

Deno.test(
  "body text case 12: a bare marker line appearing after a properly closed fence is still refused",
  async () => {
    const res = await runGuard("```\nsome quoted example text\n```\nBLOCKED");
    assertRefused(res);
  },
);

Deno.test(
  "a backtick-quoted marker inside a longer document with unrelated fenced examples still dispatches normally",
  async () => {
    const res = await runGuard(
      "Some spec text.\n\n`BLOCKED` is the marker this guard looks for.\n\n```\nexample: BLOCKED\n```\n\nMore prose.",
    );
    assertDispatchedNormally(res);
  },
);

// --- body-read failure: "cannot determine" refuses rather than proceeds
// (web-jam-tools#903, enumerated cases 16-17) ---

Deno.test(
  "body text case 16: a failed gh issue view exits non-zero rather than dispatching",
  async () => {
    const res = await runGuard("irrelevant — gh issue view never returns", { viewExit: "1" });
    assertEquals(res.code, 1, res.stderr);
  },
);

Deno.test(
  "body text case 17a: an empty issue body refuses rather than dispatching",
  async () => {
    const res = await runGuard("");
    assertRefusedByUnreadableBody(res);
  },
);

Deno.test(
  "body text case 17b: a literal null issue body refuses rather than dispatching",
  async () => {
    const res = await runGuard("", { bodyNull: true });
    assertRefusedByUnreadableBody(res);
  },
);
