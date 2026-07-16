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

import { assertEquals, assertMatch } from "@std/assert";

const SCRIPT_PATH = new URL("../scripts/create-draft-pr.sh", import.meta.url).pathname;

const VALID_SUMMARY = "- Add X so Y works\n- Refactor Z to stop duplicating W";
const VALID_TEST_PLAN = "Run `deno task test`. Expect green.";
const VALID_EVIDENCE = "```\nok | 42 passed | 0 failed\n```";
const RUN_ON_SUMMARY =
  "First I updated the guard logic and then I updated the docs and finally I ran the tests.";
const PARAPHRASE_EVIDENCE = "All unit tests, lints, and typechecks passed successfully";
const OFF_ROSTER_AUTHOR = "Gemini 1.5 Pro";
const VALID_AUTHOR = "Claude Code — Sonnet 5";

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

async function runScript(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
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
  assertMatch(res.stderr, /Gemini 3\.5 Flash \(Medium\)/); // valid list printed
});

Deno.test("replay #1212 defect 2: paraphrased test-evidence is refused", async () => {
  const res = await runScript(repoDir, baseArgs({ evidence: PARAPHRASE_EVIDENCE }));
  assertEquals(res.code, 1);
  assertMatch(res.stderr, /no recognizable test-runner output/);
});

Deno.test("replay #1212 defect 3: run-on unbulleted summary is refused", async () => {
  const res = await runScript(repoDir, baseArgs({ summary: RUN_ON_SUMMARY }));
  assertEquals(res.code, 1);
  assertMatch(res.stderr, /no markdown bullet lines/);
});

// --- green path (unchanged) ---

Deno.test("well-formed call (web-jam-back#967-shaped) passes validation unchanged", async () => {
  const res = await runScript(repoDir, baseArgs());
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /=== DRY RUN/);
  assertMatch(res.stdout, /🤖 Work by Claude Code — Sonnet 5/);
});

// --- roster substring matching (not exact-string) ---

Deno.test("roster match is by substring: agy's full model name passes", async () => {
  const res = await runScript(
    repoDir,
    baseArgs({ author: "agy — Gemini 3.5 Flash (Medium)" }),
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
    { FORCED_PR_AUTHOR: "agy — Gemini 3.5 Flash (High)" },
  );
  assertEquals(res.code, 0, res.stderr);
  assertMatch(res.stdout, /🤖 Work by agy — Gemini 3\.5 Flash \(High\)/);
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

Deno.test("paraphrased evidence via --test-evidence-file is also refused", async () => {
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
  assertEquals(res.code, 1);
  assertMatch(res.stderr, /no recognizable test-runner output/);
});
