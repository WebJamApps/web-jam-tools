// handle_agy_tasks_footer_check.test.ts — web-jam-tools#912
//
// Regression coverage for the confirmed root cause of the "inconsistent"
// BYPASS DETECTED alarm in scripts/handle-agy-tasks.sh.
//
// Root cause: the script forced the PR author to the RAW `--model` display
// name ("agy — <versioned model name>"), but scripts/create-draft-pr.sh's
// ROSTER is deliberately unversioned and author_roster_check() SUBSTRING-
// matches against it. A version token between the vendor word and the tier
// word breaks that substring, so create-draft-pr.sh REFUSED the forced author
// outright — meaning a dispatch on the default model chain could never open a
// PR through that script at all. Dispatches launched with the unversioned
// AGY_MODELS override spelling cleared the roster and looked clean; both
// spellings are in circulation, which is what made the alarm look random.
//
// These tests exercise the REAL bash functions, extracted verbatim from
// scripts/handle-agy-tasks.sh and run under a stubbed `gh` (same
// shell-out-to-the-real-thing philosophy as
// test/handle_agy_tasks_marker_guard.test.ts — re-implementing the logic in
// TypeScript would test a copy, not the shipped guard). The roster half is
// checked against scripts/create-draft-pr.sh's own --check-author probe, so
// the roster is read from its single source of truth and never copied here.
//
// The `gh pr view` network call is the only part still not exercised — that
// remains impractical against real GitHub, exactly as the script's own
// comment says. It is also not where the defect lived.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { ALLOWED_AGY_MODELS } from "../hooks/lib/check_agy_model.ts";

const SCRIPT_PATH = new URL("../scripts/handle-agy-tasks.sh", import.meta.url).pathname;
const CREATE_PR_PATH = new URL("../scripts/create-draft-pr.sh", import.meta.url).pathname;

const VERSIONED_HIGH = "Gemini 3.8 Flash (High)";
const VERSIONED_MEDIUM = "Gemini 3.8 Flash (Medium)";
const ROSTER_HIGH_AUTHOR = "agy — Gemini Flash (High)";
const ROSTER_HIGH_FOOTER = `🤖 Work by ${ROSTER_HIGH_AUTHOR}`;

// `gh pr view <n> -R <repo> --json body -q .body` -> the body under test.
const FAKE_GH_SCRIPT = `#!/usr/bin/env bash
set -uo pipefail
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "view" ]; then
  printf '%s' "\${TEST_PR_BODY:-}"
  exit 0
fi
echo "unstubbed gh invocation: $*" >&2
exit 1
`;

/**
 * Pull a shell function out of the real script by name, brace-matching on the
 * indentation of its own `name() {` line. Keeps the test bound to the shipped
 * source instead of a transcription of it.
 */
async function extractShellFunction(path: string, name: string): Promise<string> {
  const lines = (await Deno.readTextFile(path)).split("\n");
  const openRe = new RegExp(`^(\\s*)${name}\\(\\)\\s*\\{\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(openRe);
    if (!match) continue;
    const close = `${match[1]}}`;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === close) return lines.slice(i, j + 1).join("\n");
    }
    throw new Error(`unterminated function '${name}' in ${path}`);
  }
  throw new Error(`function '${name}' not found in ${path}`);
}

interface HarnessResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `footer_present_for_model <pr> <model>` (plus pr_author_for_model, which
 * it calls) against a stubbed `gh` returning `body`.
 */
async function runFooterCheck(
  body: string,
  model: string,
  forcedAuthor?: string,
): Promise<HarnessResult> {
  const binDir = await Deno.makeTempDir({ prefix: "wjt912-bin-" });
  await Deno.writeTextFile(`${binDir}/gh`, FAKE_GH_SCRIPT);
  await Deno.chmod(`${binDir}/gh`, 0o755);

  const harness = [
    "#!/usr/bin/env bash",
    "set -uo pipefail",
    'TARGET_REPO="TestRepo"',
    await extractShellFunction(SCRIPT_PATH, "pr_author_for_model"),
    await extractShellFunction(SCRIPT_PATH, "footer_present_for_model"),
    'footer_present_for_model "$1" "$2"',
    "exit $?",
    "",
  ].join("\n");
  const harnessPath = `${binDir}/harness.sh`;
  await Deno.writeTextFile(harnessPath, harness);

  const env: Record<string, string> = {
    PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
    HOME: Deno.env.get("HOME") ?? "/tmp",
    TEST_PR_BODY: body,
  };
  if (forcedAuthor !== undefined) env.FORCED_PR_AUTHOR = forcedAuthor;

  const cmd = new Deno.Command("bash", {
    args: [harnessPath, "42", model],
    env,
    clearEnv: true,
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

/** Run `pr_author_for_model <model>` and return the derived author string. */
async function derivedAuthor(model: string): Promise<string> {
  const harness = [
    "#!/usr/bin/env bash",
    "set -uo pipefail",
    await extractShellFunction(SCRIPT_PATH, "pr_author_for_model"),
    'pr_author_for_model "$1"',
    "",
  ].join("\n");
  const dir = await Deno.makeTempDir({ prefix: "wjt912-author-" });
  const path = `${dir}/author.sh`;
  await Deno.writeTextFile(path, harness);
  const { code, stdout, stderr } = await new Deno.Command("bash", {
    args: [path, model],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
  return new TextDecoder().decode(stdout);
}

/** Ask the REAL create-draft-pr.sh whether it would accept this author. */
async function rosterAccepts(author: string): Promise<boolean> {
  const { code } = await new Deno.Command("bash", {
    args: [CREATE_PR_PATH, "--check-author", author],
    stdout: "null",
    stderr: "null",
  }).output();
  return code === 0;
}

// --- the root cause itself -------------------------------------------------

Deno.test("the raw versioned model name is exactly what create-draft-pr.sh refuses", async () => {
  // Pins the defect: this is the author string the script used to force, and
  // the roster's substring match can never clear it. If this ever starts
  // passing, the roster or the model naming changed and the fix below should
  // be re-examined rather than silently kept.
  assertEquals(await rosterAccepts(`agy — ${VERSIONED_HIGH}`), false);
});

Deno.test("pr_author_for_model strips the version token from the model display name", async () => {
  assertEquals(await derivedAuthor(VERSIONED_HIGH), ROSTER_HIGH_AUTHOR);
  assertEquals(await derivedAuthor(VERSIONED_MEDIUM), "agy — Gemini Flash (Medium)");
});

Deno.test("pr_author_for_model is idempotent on an already-unversioned name", async () => {
  // Dispatches that pass AGY_MODELS with the unversioned spelling — the ones
  // that never alarmed — must keep behaving identically.
  assertEquals(await derivedAuthor("Gemini Flash (High)"), ROSTER_HIGH_AUTHOR);
});

Deno.test("every model in the default chain yields an author the roster accepts", async () => {
  // The structural impossibility that caused web-jam-tools#912 was that the
  // default chain and the roster disagreed and nothing checked. This is that
  // check, run against both real sources.
  for (const spec of ALLOWED_AGY_MODELS) {
    const author = await derivedAuthor(spec.displayName);
    assertEquals(
      await rosterAccepts(author),
      true,
      `create-draft-pr.sh's roster refuses '${author}', derived from '${spec.displayName}' — ` +
        "a dispatch on this model could not open a PR through that script at all",
    );
  }
});

// --- the footer check ------------------------------------------------------

Deno.test("footer check PASSES on a body create-draft-pr.sh composed for a versioned model", async () => {
  // The exact case that alarmed: model is the versioned display name, the PR
  // body carries the unversioned footer create-draft-pr.sh is able to write.
  const res = await runFooterCheck(
    `## Summary\n- did the thing\n\n${ROSTER_HIGH_FOOTER}`,
    VERSIONED_HIGH,
    ROSTER_HIGH_AUTHOR,
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("footer check tolerates trailing whitespace and newlines", async () => {
  const res = await runFooterCheck(
    `## Summary\n- did the thing\n\n${ROSTER_HIGH_FOOTER}   \n\n`,
    VERSIONED_HIGH,
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("footer check still FAILS when the body has no attribution footer", async () => {
  // A `gh pr create` bypass — the whole reason the check exists. The fix must
  // not turn this into a no-op.
  const res = await runFooterCheck("## Summary\n- opened by hand\n", VERSIONED_HIGH);
  assertEquals(res.code, 1, res.stderr);
});

Deno.test("footer check still FAILS on a plausible but hand-typed footer", async () => {
  const res = await runFooterCheck(
    "## Summary\n- opened by hand\n\n🤖 Work by agy\n",
    VERSIONED_HIGH,
  );
  assertEquals(res.code, 1, res.stderr);
});

Deno.test("footer check still FAILS when the footer names a different model tier", async () => {
  // Per-model discrimination is preserved: stripping the version must not
  // collapse High and Medium into the same expected footer.
  const res = await runFooterCheck(
    "## Summary\n- did the thing\n\n🤖 Work by agy — Gemini Flash (Medium)",
    VERSIONED_HIGH,
  );
  assertEquals(res.code, 1, res.stderr);
});

Deno.test("footer check still FAILS when the footer is not the last line", async () => {
  const res = await runFooterCheck(
    `## Summary\n- did the thing\n\n${ROSTER_HIGH_FOOTER}\n\n## Extra section added later`,
    VERSIONED_HIGH,
  );
  assertEquals(res.code, 1, res.stderr);
});

// --- diagnostic logging (acceptance criterion 1) ---------------------------

Deno.test("every footer check logs the model, expected footer and actual suffix — on PASS", async () => {
  const res = await runFooterCheck(
    `## Summary\n- did the thing\n\n${ROSTER_HIGH_FOOTER}`,
    VERSIONED_HIGH,
    ROSTER_HIGH_AUTHOR,
  );
  assertStringIncludes(res.stderr, `model='${VERSIONED_HIGH}'`);
  assertStringIncludes(res.stderr, `forced_author='${ROSTER_HIGH_AUTHOR}'`);
  assertStringIncludes(res.stderr, `expected='${ROSTER_HIGH_FOOTER}'`);
  assertStringIncludes(res.stderr, `actual_last_line='${ROSTER_HIGH_FOOTER}'`);
  assertStringIncludes(res.stderr, "footer check: PASS");
});

Deno.test("every footer check logs the model, expected footer and actual suffix — on FAIL", async () => {
  const res = await runFooterCheck("## Summary\n- opened by hand", VERSIONED_HIGH);
  assertStringIncludes(res.stderr, `model='${VERSIONED_HIGH}'`);
  assertStringIncludes(res.stderr, "forced_author='<unset>'");
  assertStringIncludes(res.stderr, `expected='${ROSTER_HIGH_FOOTER}'`);
  assertStringIncludes(res.stderr, "actual_last_line='- opened by hand'");
  assertStringIncludes(res.stderr, "footer check: FAIL");
});

// --- the forced author and the expected footer share one derivation --------

Deno.test("FORCED_PR_AUTHOR is derived, never the raw --model string", async () => {
  // The two must come from the same function; a regression that re-introduced
  // `export FORCED_PR_AUTHOR="agy — $m"` would put them back out of sync.
  const script = await Deno.readTextFile(SCRIPT_PATH);
  assertStringIncludes(script, 'export FORCED_PR_AUTHOR="$(pr_author_for_model "$m")"');
  assertStringIncludes(script, 'expected="🤖 Work by $(pr_author_for_model "$model")"');
  if (/export FORCED_PR_AUTHOR="agy — \$m"/.test(script)) {
    throw new Error("FORCED_PR_AUTHOR is being set from the raw model string again");
  }
});

Deno.test("create-draft-pr.sh --check-author is a read-only probe of the real roster", async () => {
  assertEquals(await rosterAccepts("Claude Code — Claude Opus"), true);
  assertEquals(await rosterAccepts("Claude Code — Some Model That Does Not Exist"), false);
});
