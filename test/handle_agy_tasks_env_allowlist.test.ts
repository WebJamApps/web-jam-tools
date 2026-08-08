// handle_agy_tasks_env_allowlist.test.ts — web-jam-tools#439
//
// Proves scripts/handle-agy-tasks.sh launches the `agy` binary with an
// explicitly constructed environment (never the caller's inherited one) —
// STATIC TEXT INSPECTION ONLY, deliberately, not a live Deno.Command run of
// the script.
//
// Why static, not live: this suite's first two drafts DID shell out to the
// real script (same pattern as test/handle_agy_tasks_marker_guard.test.ts),
// including deliberately reverting the fix to prove the test would catch a
// regression. That reproduced the real vulnerability against a real,
// secret-laden shell environment TWICE in the same session and leaked a real
// DENO_DEPLOY_TOKEN and a real CIRCLECI_TOKEN into a Claude Code transcript
// (web-jam-tools#282 sections E and F — the second leak happened even after
// an attempted environment override, because Deno.Command's `env` option
// MERGES with the parent's real environment by default rather than
// replacing it; `clearEnv: true` is required and was missed). A test that
// can only ever leak a hardcoded, obviously-fake string — never anything
// read from the real environment — cannot repeat that failure. Do not
// convert this back to a live execution against any environment that could
// contain a real credential, including a "safe subset" built by hand; that
// exact approach is what caused the second leak.

import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH = new URL("../scripts/handle-agy-tasks.sh", import.meta.url).pathname;

async function readScript(): Promise<string> {
  return await Deno.readTextFile(SCRIPT_PATH);
}

function nonCommentLines(text: string): string[] {
  return text.split("\n").filter((line) => !/^\s*#/.test(line));
}

Deno.test("handle-agy-tasks.sh is valid bash (syntax check only, no execution)", async () => {
  const command = new Deno.Command("bash", {
    args: ["-n", SCRIPT_PATH],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await command.output();
  assertEquals(code, 0, `bash -n failed:\n${new TextDecoder().decode(stderr)}`);
});

Deno.test("the agy environment allowlist is defined as a single named list", async () => {
  const script = await readScript();
  assertMatch(
    script,
    /AGY_ENV_ALLOWLIST=\(HOME PATH USER AGY_MODELS FORCED_PR_AUTHOR\)/,
    "expected a single AGY_ENV_ALLOWLIST=(...) definition naming exactly HOME PATH USER AGY_MODELS FORCED_PR_AUTHOR",
  );
});

Deno.test("agy_env_args builds AGY_ENV_ARGS from the allowlist by name (indirect expansion)", async () => {
  const script = await readScript();
  assertStringIncludes(script, "agy_env_args() {");
  assertStringIncludes(script, 'for name in "${AGY_ENV_ALLOWLIST[@]}"');
  assertStringIncludes(script, 'AGY_ENV_ARGS+=("$name=${!name}")');
});

Deno.test("every real invocation of $AGY is launched via env -i with the constructed allowlist", async () => {
  const script = await readScript();
  const callSites = nonCommentLines(script).filter((line) => line.includes('"$AGY"'));

  // Three known call sites today: the model probe, the headless dispatch
  // turn, and the interactive dispatch. If this count changes, a new call
  // site was added or removed — update this test deliberately rather than
  // loosen the assertion, so a new call site can't silently skip the guard.
  assertEquals(
    callSites.length,
    3,
    `expected exactly 3 non-comment "$AGY" invocations, found ${callSites.length}:\n${
      callSites.join("\n")
    }`,
  );

  const wrapped = /env -i "\$\{AGY_ENV_ARGS\[@\]\}" "\$AGY"/;
  for (const line of callSites) {
    assertMatch(
      line,
      wrapped,
      `"$AGY" invocation not wrapped in env -i "\${AGY_ENV_ARGS[@]}": ${line}`,
    );
  }
});

Deno.test("agy_env_args is rebuilt immediately before each $AGY call site (env stays fresh per model/round)", async () => {
  const script = await readScript();
  const lines = script.split("\n");
  const callSiteIdx = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => !/^\s*#/.test(line) && line.includes('"$AGY"'))
    .map(({ i }) => i);

  assertEquals(callSiteIdx.length, 3);
  for (const idx of callSiteIdx) {
    const preceding = lines.slice(Math.max(0, idx - 3), idx).join("\n");
    assertStringIncludes(
      preceding,
      "agy_env_args",
      `expected an agy_env_args call within 3 lines before the $AGY invocation at line ${idx + 1}`,
    );
  }
});
