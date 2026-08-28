// create_draft_pr_script.test.ts — web-jam-tools#190
//
// Exercises scripts/create-draft-pr.sh's guards end-to-end by actually shelling
// out to it (Deno.Command) against a throwaway git fixture repo, using
// --dry-run so no push/PR is ever attempted. This is the only reliable way to
// test a bash script's behavior — re-implementing its regexes in TypeScript
// would test a copy, not the real guard.
//
// Fixture branch name deliberately has no "/<digits>" so the script never
// resolves an issue number and never calls `gh` — the guards under test here
// all fire before any gh call, so this keeps the suite network-free.

import { assertEquals, assertMatch, assertNotMatch } from "@std/assert";

const SCRIPT_PATH = new URL("../scripts/create-draft-pr.sh", import.meta.url).pathname;

const VALID_SUMMARY = "- Add X so Y works\n- Refactor Z to stop duplicating W";
const VALID_TEST_PLAN = "Run `deno task test`. Expect green.";
const VALID_EVIDENCE = "```\nok | 42 passed | 0 failed\n```";
const RUN_ON_SUMMARY =
  "First I updated the guard logic and then I updated the docs and finally I ran the tests.";
const PARAPHRASE_EVIDENCE = "All unit tests, lints, and typechecks passed successfully";
const OFF_ROSTER_AUTHOR = "Gemini 1.5 Pro";
const VALID_AUTHOR = "Claude Code — Sonnet 5";
// web-jam-back#918: this exact "How to test locally" section shipped — running
// the suite is not exercising the change (web-jam-tools#152).
const SUITE_ONLY_TEST_PLAN =
  "npm test        # eslint + jscpd + vitest run --coverage\nnpm run typecheck";
const SUITE_ONLY_FENCED_TEST_PLAN = "```sh\nnpm test\nnpm run typecheck\ndeno task check\n```";
const MIXED_TEST_PLAN =
  "```sh\nnpm test\nnpm run typecheck\n```\nThen hit the endpoint:\n```sh\ncurl -s http://localhost:3000/api/gigs | jq\n```\nExpect a 200 with the updated gig in the JSON array.";

async function makeFixtureRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "wjt190-fixture-" });
  const run = async (args: string[]) => {
    const cmd = new Deno.Command("git", { args, cwd: dir, stdout: "null", stderr: "piped" });
    const { code, stderr } = await cmd.output();
    if (code !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`);
    }
  };
  await run(["init", "-q"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Test"]);
  await run(["checkout", "-q", "-b", "dev"]);
  await Deno.writeTextFile(`${dir}/f.txt`, "hi\n");
  await run(["add", "f.txt"]);
  await run(["commit", "-q", "-m", "init"]);
  // No "/<digits>" in this name — the script resolves no issue, so it never
  // calls `gh` (keeps this suite offline and fast).
  await run(["checkout", "-q", "-b", "scratch-branch"]);
  return dir;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// web-jam-tools#272: the script now REFUSES an inline --summary/--test-plan/
// --test-evidence carrying markdown structure (backticks or a table pipe),
// because an inline value travels on the command line where the PreToolUse
// guards scan it. Rich fixtures therefore have to reach the script as files.
//
// This helper performs that swap so the existing cases keep testing what they
// were written to test (roster, placeholder, bullets, evidence, test-plan
// substance) rather than all collapsing onto the new rule. The refusal itself
// is covered by its own dedicated tests below.
const RICH = /[`|]|\n/;
const FILE_FLAG: Record<string, string> = {
  "--summary": "--summary-file",
  "--test-plan": "--test-plan-file",
  "--test-evidence": "--test-evidence-file",
};

async function toFileFlags(args: string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const fileFlag = FILE_FLAG[flag];
    const value = args[i + 1];
    if (fileFlag && value !== undefined && RICH.test(value)) {
      // Deliberately OUTSIDE the fixture repo: a file written into that working
      // tree shows up as untracked and trips the script's own dirty-tree guard.
      const path = await Deno.makeTempFile({ prefix: "wjt272-", suffix: ".md" });
      await Deno.writeTextFile(path, value);
      out.push(fileFlag, path);
      i++;
      continue;
    }
    out.push(flag);
  }
  return out;
}

async function runScript(
  cwd: string,
  rawArgs: string[],
  env: Record<string, string> = {},
  // raw: skip the file-flag swap above and pass the args through untouched.
  // Required by the tests that assert the inline-refusal itself — otherwise the
  // harness would helpfully convert away the very thing under test.
  opts: { raw?: boolean } = {},
): Promise<RunResult> {
  const args = opts.raw ? rawArgs : await toFileFlags(rawArgs);
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH, ...args, "--dry-run"],
    cwd,
    env,
    clearEnv: false,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

function baseArgs(
  overrides: Partial<Record<"author" | "summary" | "testPlan" | "evidence", string>> = {},
) {
  const author = overrides.author ?? VALID_AUTHOR;
  const summary = overrides.summary ?? VALID_SUMMARY;
  const testPlan = overrides.testPlan ?? VALID_TEST_PLAN;
  const evidence = overrides.evidence ?? VALID_EVIDENCE;
  return [
    "--author",
    author,
    "--summary",
    summary,
    "--test-plan",
    testPlan,
    "--test-evidence",
    evidence,
  ];
}

const repoDir = await makeFixtureRepo();

// --- JaMmusic#1212 defect replays ---

Deno.test("replay #1212 defect 1: off-roster author is refused", async () => {
  const res = await runScript(repoDir, baseArgs({ author: OFF_ROSTER_AUTHOR }));
  assertEquals(res.code, 1);
  assertMatch(res.stderr, /does not name a model on the roster/);
  assertMatch(res.stderr, /Gemini Flash \(Medium\)/); // valid list printed
});

Deno.test("paraphrased test-evidence passes without requiring test-runner output format", async () => {
  const res = await runScript(repoDir, baseArgs({ evidence: PARAPHRASE_EVIDENCE }));
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /=== DRY RUN/);
});

Deno.test("replay #1212 defect 3: run-on unbulleted summary is refused", async () => {
  const res = await runScript(repoDir, baseArgs({ summary: RUN_ON_SUMMARY }));
  assertEquals(res.code, 1);
  assertMatch(res.stderr, /no markdown bullet lines/);
});

// --- green path (unchanged & omitted evidence) ---

Deno.test("well-formed call (web-jam-back#967-shaped) passes validation unchanged", async () => {
  const res = await runScript(repoDir, baseArgs());
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /=== DRY RUN/);
  assertMatch(res.stdout, /🤖 Work by Claude Code — Sonnet 5/);
  assertMatch(res.stdout, /## Test evidence/);
});

Deno.test("creates/dry-runs a PR cleanly with only --author, --summary, and --test-plan (omitting --test-evidence)", async () => {
  const res = await runScript(repoDir, [
    "--author",
    VALID_AUTHOR,
    "--summary",
    VALID_SUMMARY,
    "--test-plan",
    VALID_TEST_PLAN,
  ]);
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /=== DRY RUN/);
  assertMatch(res.stdout, /🤖 Work by Claude Code — Sonnet 5/);
  assertNotMatch(res.stdout, /## Test evidence/);
});

// --- roster substring matching (not exact-string) ---

Deno.test("roster match is by substring: agy's full model name passes", async () => {
  const res = await runScript(
    repoDir,
    baseArgs({ author: "agy — Gemini Flash (Medium)" }),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("roster match is by substring: 'Claude Code — Haiku 4.5' passes", async () => {
  const res = await runScript(repoDir, baseArgs({ author: "Claude Code — Haiku 4.5" }));
  assertEquals(res.code, 0, res.stderr);
});

// --- FORCED_PR_AUTHOR override (handle-agy-tasks.sh mechanism) ---

Deno.test("FORCED_PR_AUTHOR overrides a bad --author and wins", async () => {
  const res = await runScript(
    repoDir,
    baseArgs({ author: OFF_ROSTER_AUTHOR }),
    { FORCED_PR_AUTHOR: "agy — Gemini Flash (High)" },
  );
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /🤖 Work by agy — Gemini Flash \(High\)/);
});

Deno.test("FORCED_PR_AUTHOR is still roster-checked, not a bypass", async () => {
  const res = await runScript(
    repoDir,
    baseArgs({ author: VALID_AUTHOR }),
    { FORCED_PR_AUTHOR: OFF_ROSTER_AUTHOR },
  );
  assertEquals(res.code, 1);
  assertMatch(res.stderr, /does not name a model on the roster/);
});

// --- evidence check also applies to --test-evidence-file (web-jam-tools#145 path) ---

Deno.test("paraphrased evidence via --test-evidence-file is accepted", async () => {
  const evidenceFile = await Deno.makeTempFile({ suffix: ".md" });
  await Deno.writeTextFile(evidenceFile, PARAPHRASE_EVIDENCE);
  const args = [
    "--author",
    VALID_AUTHOR,
    "--summary",
    VALID_SUMMARY,
    "--test-plan",
    VALID_TEST_PLAN,
    "--test-evidence-file",
    evidenceFile,
  ];
  const res = await runScript(repoDir, args);
  await Deno.remove(evidenceFile);
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /=== DRY RUN/);
});

// --- test-plan substance (web-jam-tools#152) ---

Deno.test("web-jam-back#918 replay: a suite-only test-plan is refused", async () => {
  const res = await runScript(repoDir, baseArgs({ testPlan: SUITE_ONLY_TEST_PLAN }));
  assertEquals(res.code, 1);
  assertMatch(res.stderr, /only test-suite invocations/);
});

Deno.test("a fenced suite-only test-plan (npm test + npm run typecheck + deno task check) is refused", async () => {
  const res = await runScript(repoDir, baseArgs({ testPlan: SUITE_ONLY_FENCED_TEST_PLAN }));
  assertEquals(res.code, 1);
  assertMatch(res.stderr, /only test-suite invocations/);
});

Deno.test("a test-plan with suite commands PLUS a curl request passes", async () => {
  const res = await runScript(repoDir, baseArgs({ testPlan: MIXED_TEST_PLAN }));
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /=== DRY RUN/);
});

Deno.test("a test-plan with suite commands PLUS manual UI steps passes", async () => {
  const uiPlan =
    "Run:\n```sh\nnpm test\n```\nThen: start the app (`npm run dev`), open /settings, click Save, and confirm the new field persists after reload.";
  const res = await runScript(repoDir, baseArgs({ testPlan: uiPlan }));
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("the default VALID_TEST_PLAN fixture (prose + backticked suite command) still passes", async () => {
  const res = await runScript(repoDir, baseArgs());
  assertEquals(res.code, 0, res.stderr);
});

// --- --update mode (web-jam-tools#236) ---
//
// --update runs through the exact same guard pipeline as create mode, only
// diverging at the final push+open/edit step — which --dry-run always skips
// (no gh call either way). So these replay the SAME guard-failure fixtures as
// above with --update added, proving the guards fire identically in update
// mode instead of being silently bypassed (the defect this mode fixes: a
// hand-written `gh pr edit` at "finalize" time used to skip every guard here).

Deno.test("--update: off-roster author is refused, same as create mode", async () => {
  const res = await runScript(
    repoDir,
    [...baseArgs({ author: OFF_ROSTER_AUTHOR }), "--update"],
  );
  assertEquals(res.code, 1);
  assertMatch(res.stderr, /does not name a model on the roster/);
});

Deno.test("--update: paraphrased test-evidence is accepted, same as create mode", async () => {
  const res = await runScript(repoDir, [
    ...baseArgs({ evidence: PARAPHRASE_EVIDENCE }),
    "--update",
  ]);
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /=== DRY RUN \(UPDATE/);
});

Deno.test("--update: a suite-only test-plan is refused, same as create mode (web-jam-tools#152)", async () => {
  const res = await runScript(repoDir, [
    ...baseArgs({ testPlan: SUITE_ONLY_TEST_PLAN }),
    "--update",
  ]);
  assertEquals(res.code, 1);
  assertMatch(res.stderr, /only test-suite invocations/);
});

Deno.test("--update: a well-formed call passes validation and dry-run labels it UPDATE", async () => {
  const res = await runScript(repoDir, [...baseArgs(), "--update"]);
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /=== DRY RUN \(UPDATE/);
  assertMatch(res.stdout, /🤖 Work by Claude Code — Sonnet 5/);
});

Deno.test("create mode (no --update) still labels dry-run CREATE", async () => {
  const res = await runScript(repoDir, baseArgs());
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /=== DRY RUN \(CREATE/);
});

// --- web-jam-tools#272: rich prose must arrive as a file, not inline ---
//
// An inline value travels on the command line, where the PreToolUse Bash guards
// read it. Their prose-flag exemption is skipped whenever the value contains a
// shell metacharacter, and real markdown always does — so a PR body naming a
// credential file or quoting a blocked command gets refused by the guard rather
// than by this script. A *-file flag puts only a PATH on the command line.

Deno.test("an inline --summary containing backticks is refused, pointing at --summary-file", async () => {
  const res = await runScript(
    repoDir,
    [
      "--author",
      VALID_AUTHOR,
      "--summary",
      "- see `deno task test` for details",
      "--test-plan",
      "plain plan exercising the change by hitting the route",
      "--test-evidence",
      "ok 42 passed 0 failed",
    ],
    {},
    { raw: true },
  );
  assertEquals(res.code, 1);
  assertMatch(res.stderr, /pass --summary-file PATH instead/);
});

Deno.test("an inline --test-plan containing a table pipe is refused", async () => {
  const res = await runScript(
    repoDir,
    [
      "--author",
      VALID_AUTHOR,
      "--summary",
      "- a bullet",
      "--test-plan",
      "| step | expected |",
      "--test-evidence",
      "ok 42 passed 0 failed",
    ],
    {},
    { raw: true },
  );
  assertEquals(res.code, 1);
  assertMatch(res.stderr, /pass --test-plan-file PATH instead/);
});

Deno.test("a multi-line inline --test-evidence is refused", async () => {
  const res = await runScript(
    repoDir,
    [
      "--author",
      VALID_AUTHOR,
      "--summary",
      "- a bullet",
      "--test-plan",
      "plain plan exercising the change by hitting the route",
      "--test-evidence",
      "ok 42 passed\nsecond line",
    ],
    {},
    { raw: true },
  );
  assertEquals(res.code, 1);
  assertMatch(res.stderr, /pass --test-evidence-file PATH instead/);
});

Deno.test("the refusal explains WHY, naming the guard interaction", async () => {
  const res = await runScript(
    repoDir,
    [
      "--author",
      VALID_AUTHOR,
      "--summary",
      "- see `x`",
      "--test-plan",
      "plain plan exercising the change by hitting the route",
      "--test-evidence",
      "ok 42 passed 0 failed",
    ],
    {},
    { raw: true },
  );
  assertMatch(res.stderr, /guards scan them/);
});

Deno.test("a short plain inline value is still accepted (no needless friction)", async () => {
  const res = await runScript(
    repoDir,
    [
      "--author",
      VALID_AUTHOR,
      "--summary",
      "- one plain bullet with no markup",
      "--test-plan",
      "plain plan exercising the change by hitting the route",
      "--test-evidence",
      "ok 42 passed 0 failed",
    ],
    {},
    { raw: true },
  );
  assertEquals(res.code, 0, res.stderr);
});

// --- cross-repo vs same-repo --issue formatting tests (web-jam-tools#302) ---

async function makeMockGh(
  options: {
    ownerRepo?: string;
    issueState?: string;
    issueTitle?: string;
    issueLabels?: string[];
    failLabelsFetch?: boolean;
  } = {},
) {
  const dir = await Deno.makeTempDir({ prefix: "mock-gh-" });
  const labelsOutput = (options.issueLabels ?? []).join("\n");
  const scriptContent = `#!/usr/bin/env bash
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  echo "${options.ownerRepo ?? "WebJamApps/web-jam-tools"}"
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  for arg in "$@"; do
    if [ "$arg" = "state" ]; then
      echo "${options.issueState ?? "OPEN"}"
      exit 0
    elif [ "$arg" = "title" ]; then
      echo "${options.issueTitle ?? "Test Issue Title"}"
      exit 0
    elif [ "$arg" = "labels" ]; then
      ${
    options.failLabelsFetch ? 'echo "API rate limit exceeded" >&2; exit 1' : `cat <<'LABELS_EOF'
${labelsOutput}
LABELS_EOF
      exit 0`
  }
    fi
  done
fi
exit 0
`;
  const ghPath = `${dir}/gh`;
  await Deno.writeTextFile(ghPath, scriptContent);
  await Deno.chmod(ghPath, 0o755);
  return dir;
}

Deno.test("cross-repo --issue with full URL produces Closes OWNER/REPO#N", async () => {
  const mockGhDir = await makeMockGh({ ownerRepo: "WebJamApps/web-jam-tools" });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "https://github.com/WebJamApps/JaMmusic/issues/1250",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /Closes WebJamApps\/JaMmusic#1250/);
});

Deno.test("same-repo --issue with full URL still produces Closes #N", async () => {
  const mockGhDir = await makeMockGh({ ownerRepo: "WebJamApps/web-jam-tools" });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "https://github.com/WebJamApps/web-jam-tools/issues/302",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /Closes #302/);
});

Deno.test("cross-repo --issue with owner/repo#N produces Closes OWNER/REPO#N", async () => {
  const mockGhDir = await makeMockGh({ ownerRepo: "WebJamApps/web-jam-tools" });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "WebJamApps/JaMmusic#1250",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /Closes WebJamApps\/JaMmusic#1250/);
});

Deno.test("same-repo --issue with owner/repo#N produces Closes #N", async () => {
  const mockGhDir = await makeMockGh({ ownerRepo: "WebJamApps/web-jam-tools" });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "WebJamApps/web-jam-tools#302",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /Closes #302/);
});

Deno.test("--issue with bare #N produces Closes #N", async () => {
  const mockGhDir = await makeMockGh({ ownerRepo: "WebJamApps/web-jam-tools" });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "#1250",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /Closes #1250/);
});

Deno.test("--issue with bare N produces Closes #N", async () => {
  const mockGhDir = await makeMockGh({ ownerRepo: "WebJamApps/web-jam-tools" });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "1250",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /Closes #1250/);
});

Deno.test("cross-repo --issue with --part-of produces Part of OWNER/REPO#N", async () => {
  const mockGhDir = await makeMockGh({ ownerRepo: "WebJamApps/web-jam-tools" });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "https://github.com/WebJamApps/JaMmusic/issues/1250",
      "--part-of",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /Part of WebJamApps\/JaMmusic#1250/);
});

Deno.test("invalid --issue format is refused with error message", async () => {
  const mockGhDir = await makeMockGh({ ownerRepo: "WebJamApps/web-jam-tools" });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "invalid-issue-string",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 1);
  assertMatch(res.stderr, /invalid issue format/);
});

Deno.test("--closes with issue argument resolves issue correctly", async () => {
  const mockGhDir = await makeMockGh({ ownerRepo: "WebJamApps/web-jam-tools" });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--closes",
      "WebJamApps/web-jam-tools#342",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /Closes #342/);
});

Deno.test("bare --closes flag without value does not throw unknown argument error", async () => {
  const mockGhDir = await makeMockGh({ ownerRepo: "WebJamApps/web-jam-tools" });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--closes",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 0, res.stderr);
});

// --- web-jam-tools#459 --no-close tests ---

Deno.test("--no-close produces Refs #N with default reason and no Closes #N", async () => {
  const mockGhDir = await makeMockGh({ ownerRepo: "WebJamApps/web-jam-tools" });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "WebJamApps/web-jam-tools#459",
      "--no-close",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 0, res.stderr);
  assertMatch(
    res.stdout,
    /Refs #459 — post-merge acceptance criteria must be verified after merge\./,
  );
  assertNotMatch(res.stdout, /Closes #459/);
});

Deno.test("--no-close with --no-close-reason includes custom reason text", async () => {
  const mockGhDir = await makeMockGh({ ownerRepo: "WebJamApps/web-jam-tools" });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "WebJamApps/web-jam-tools#459",
      "--no-close",
      "--no-close-reason",
      "manual installer run required",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /Refs #459 — manual installer run required/);
  assertNotMatch(res.stdout, /Closes #459/);
});

Deno.test("--no-close with --no-close-reason-file includes reason from file", async () => {
  const mockGhDir = await makeMockGh({ ownerRepo: "WebJamApps/web-jam-tools" });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const reasonFile = await Deno.makeTempFile({ prefix: "wjt459-reason-", suffix: ".md" });
  await Deno.writeTextFile(reasonFile, "cron cycle logging verification required");

  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "WebJamApps/web-jam-tools#459",
      "--no-close",
      "--no-close-reason-file",
      reasonFile,
    ],
    env,
  );
  await Deno.remove(reasonFile);
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /Refs #459 — cron cycle logging verification required/);
  assertNotMatch(res.stdout, /Closes #459/);
});

Deno.test("--update --no-close produces Refs #N and does not re-arm Closes #N", async () => {
  const mockGhDir = await makeMockGh({ ownerRepo: "WebJamApps/web-jam-tools" });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "WebJamApps/web-jam-tools#459",
      "--update",
      "--no-close",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /=== DRY RUN \(UPDATE/);
  assertMatch(res.stdout, /Refs #459 — post-merge acceptance criteria/);
  assertNotMatch(res.stdout, /Closes #459/);
});

Deno.test("without --no-close, output is byte-identical and produces Closes #N", async () => {
  const mockGhDir = await makeMockGh({ ownerRepo: "WebJamApps/web-jam-tools" });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "WebJamApps/web-jam-tools#459",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /Closes #459/);
  assertNotMatch(res.stdout, /Refs #459/);
});

Deno.test("--no-close and --part-of together is refused with error", async () => {
  const mockGhDir = await makeMockGh({ ownerRepo: "WebJamApps/web-jam-tools" });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "WebJamApps/web-jam-tools#459",
      "--no-close",
      "--part-of",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 1);
  assertMatch(res.stderr, /pass --no-close or --part-of, not both/);
});

Deno.test("--no-close-reason without --no-close is refused with error", async () => {
  const mockGhDir = await makeMockGh({ ownerRepo: "WebJamApps/web-jam-tools" });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "WebJamApps/web-jam-tools#459",
      "--no-close-reason",
      "some reason",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 1);
  assertMatch(res.stderr, /--no-close-reason \/ --no-close-reason-file requires --no-close/);
});

Deno.test("--no-close without issue is refused with error", async () => {
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--no-close",
    ],
  );
  assertEquals(res.code, 1);
  assertMatch(res.stderr, /--no-close needs an issue/);
});

// --- web-jam-tools#527 PR title determination tests ---

Deno.test("--title flag sets PR title verbatim and overrides issue title and commit subject", async () => {
  const mockGhDir = await makeMockGh({
    ownerRepo: "WebJamApps/web-jam-tools",
    issueTitle: "Issue Title From GH",
  });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "WebJamApps/web-jam-tools#437",
      "--part-of",
      "--title",
      "Explicit Title Passed Via Flag",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /TITLE: Explicit Title Passed Via Flag/);
  assertNotMatch(res.stdout, /TITLE: Issue Title From GH/);
});

Deno.test("with --part-of and no --title, PR title comes from last commit subject", async () => {
  const mockGhDir = await makeMockGh({
    ownerRepo: "WebJamApps/web-jam-tools",
    issueTitle: "Epic Container Issue Title",
  });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "WebJamApps/web-jam-tools#437",
      "--part-of",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /TITLE: init/);
  assertNotMatch(res.stdout, /TITLE: Epic Container Issue Title/);
});

Deno.test("with --closes and no --title, PR title comes from issue title", async () => {
  const mockGhDir = await makeMockGh({
    ownerRepo: "WebJamApps/web-jam-tools",
    issueTitle: "Single Task Issue Title",
  });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "WebJamApps/web-jam-tools#500",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /TITLE: Single Task Issue Title/);
});

Deno.test("with no issue and no --title, PR title comes from last commit subject", async () => {
  const res = await runScript(
    repoDir,
    baseArgs(),
  );
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /TITLE: init/);
});

Deno.test("with no issue and --title provided, PR title comes from --title flag", async () => {
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--title",
      "Standalone Fix Without Issue",
    ],
  );
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /TITLE: Standalone Fix Without Issue/);
});

// --- web-jam-tools#848 Josh-labeled issue tests ---

Deno.test("refuses Closes #N when issue is labeled Josh without --part-of or --no-close (web-jam-tools#848)", async () => {
  const mockGhDir = await makeMockGh({
    ownerRepo: "WebJamApps/web-jam-tools",
    issueTitle: "Manual verification: run book-gig live pilot",
    issueLabels: ["Josh", "Flash High"],
  });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "WebJamApps/web-jam-tools#634",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 1);
  assertMatch(
    res.stderr,
    /carries the 'Josh' label \(manual human task\) and cannot be closed by an agent PR/,
  );
  assertMatch(res.stderr, /Pass --part-of to link your work/);
});

Deno.test("accepts --part-of when issue is labeled Josh and emits Part of #N (web-jam-tools#848)", async () => {
  const mockGhDir = await makeMockGh({
    ownerRepo: "WebJamApps/web-jam-tools",
    issueTitle: "Manual verification: run book-gig live pilot",
    issueLabels: ["Josh", "Flash High"],
  });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "WebJamApps/web-jam-tools#634",
      "--part-of",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /Part of #634/);
  assertNotMatch(res.stdout, /Closes #634/);
});

Deno.test("accepts --no-close when issue is labeled Josh and emits Refs #N (web-jam-tools#848)", async () => {
  const mockGhDir = await makeMockGh({
    ownerRepo: "WebJamApps/web-jam-tools",
    issueTitle: "Manual verification: run book-gig live pilot",
    issueLabels: ["Josh", "Flash High"],
  });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "WebJamApps/web-jam-tools#634",
      "--no-close",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /Refs #634/);
  assertNotMatch(res.stdout, /Closes #634/);
});

Deno.test("refuses and fails closed when fetching issue labels fails (via gh error)", async () => {
  const mockGhDir = await makeMockGh({
    ownerRepo: "WebJamApps/web-jam-tools",
    issueTitle: "Manual verification: run book-gig live pilot",
    failLabelsFetch: true,
  });
  const env = { PATH: `${mockGhDir}:${Deno.env.get("PATH")}` };
  const res = await runScript(
    repoDir,
    [
      ...baseArgs(),
      "--issue",
      "WebJamApps/web-jam-tools#634",
    ],
    env,
  );
  await Deno.remove(mockGhDir, { recursive: true });
  assertEquals(res.code, 1);
  assertMatch(
    res.stderr,
    /ERROR: failed to fetch labels for issue #634 \(via gh\): API rate limit exceeded/,
  );
});
