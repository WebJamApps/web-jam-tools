// statusline_script.test.ts — web-jam-tools#688
//
// scripts/statusline.sh reads the Claude Code status-line JSON payload
// from stdin (NOT the hook payload), extracts `.model.display_name`, and
// prints a color-coded Opus/Sonnet/Haiku badge in front of it before
// passing the SAME payload through unmodified to a downstream status-line
// command (the real one is `npx -y ccusage statusline`; tests override it
// via STATUSLINE_DOWNSTREAM_CMD to a fast, offline stand-in — `cat` — so
// the real network-hitting command is never invoked from an automated test).

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH = new URL("../scripts/statusline.sh", import.meta.url).pathname;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// STATUSLINE_DOWNSTREAM_CMD=cat is a fast, offline stand-in for the real
// `npx -y ccusage statusline` — it echoes stdin back out verbatim, which is
// exactly what's needed to assert the payload reaches the downstream
// command unmodified without hitting the network in a test.
async function runStatusline(
  stdinPayload: string,
  downstreamCmd = "cat",
): Promise<RunResult> {
  const env = { ...Deno.env.toObject(), STATUSLINE_DOWNSTREAM_CMD: downstreamCmd };
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env,
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(stdinPayload));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

const OPUS_CODE = "\x1b[1;35m";
const SONNET_CODE = "\x1b[1;36m";
const HAIKU_CODE = "\x1b[1;32m";

// --- exists & executable ---

Deno.test("scripts/statusline.sh exists and is executable", async () => {
  const stat = await Deno.stat(new URL("../scripts/statusline.sh", import.meta.url));
  assert(stat.isFile, "statusline.sh should be a regular file");
  assert(
    ((stat.mode ?? 0) & 0o111) !== 0,
    `statusline.sh should have an executable bit set, got mode ${stat.mode}`,
  );
});

// --- per-tier badges: distinct ANSI colors ---

Deno.test("an Opus payload produces a magenta badge containing 'Opus'", async () => {
  const res = await runStatusline(
    '{"model":{"id":"claude-opus-5","display_name":"Opus 5"}}',
  );
  assertEquals(res.code, 0, res.stderr);
  assertStringIncludes(res.stdout, OPUS_CODE);
  assertStringIncludes(res.stdout, "Opus");
});

Deno.test("a Sonnet payload produces a cyan badge containing 'Sonnet'", async () => {
  const res = await runStatusline(
    '{"model":{"id":"claude-sonnet-5","display_name":"Sonnet 5"}}',
  );
  assertEquals(res.code, 0, res.stderr);
  assertStringIncludes(res.stdout, SONNET_CODE);
  assertStringIncludes(res.stdout, "Sonnet");
});

Deno.test("a Haiku payload produces a green badge containing 'Haiku'", async () => {
  const res = await runStatusline(
    '{"model":{"id":"claude-haiku-4-5-20251001","display_name":"Haiku 4.5"}}',
  );
  assertEquals(res.code, 0, res.stderr);
  assertStringIncludes(res.stdout, HAIKU_CODE);
  assertStringIncludes(res.stdout, "Haiku");
});

Deno.test("Opus, Sonnet, and Haiku badges use three distinct ANSI color codes", async () => {
  const [opus, sonnet, haiku] = await Promise.all([
    runStatusline('{"model":{"id":"claude-opus-5","display_name":"Opus 5"}}'),
    runStatusline('{"model":{"id":"claude-sonnet-5","display_name":"Sonnet 5"}}'),
    runStatusline('{"model":{"id":"claude-haiku-4-5-20251001","display_name":"Haiku 4.5"}}'),
  ]);
  assertNotEquals(OPUS_CODE, SONNET_CODE);
  assertNotEquals(SONNET_CODE, HAIKU_CODE);
  assertNotEquals(OPUS_CODE, HAIKU_CODE);
  // Cross-check: each output contains ONLY its own tier's color code, not
  // either of the other two.
  assert(
    opus.stdout.includes(OPUS_CODE) && !opus.stdout.includes(SONNET_CODE) &&
      !opus.stdout.includes(HAIKU_CODE),
  );
  assert(
    sonnet.stdout.includes(SONNET_CODE) && !sonnet.stdout.includes(OPUS_CODE) &&
      !sonnet.stdout.includes(HAIKU_CODE),
  );
  assert(
    haiku.stdout.includes(HAIKU_CODE) && !haiku.stdout.includes(OPUS_CODE) &&
      !haiku.stdout.includes(SONNET_CODE),
  );
});

// --- fallback cases: unrecognized model, malformed JSON, missing model key ---

Deno.test("an unrecognized display_name prints uncolored, containing the raw name", async () => {
  const res = await runStatusline('{"model":{"id":"gpt-4","display_name":"GPT-4"}}');
  assertEquals(res.code, 0, res.stderr);
  assertStringIncludes(res.stdout, "GPT-4");
  assert(
    !res.stdout.includes(OPUS_CODE) && !res.stdout.includes(SONNET_CODE) &&
      !res.stdout.includes(HAIKU_CODE),
    `expected no tier color code in fallback output, got: ${JSON.stringify(res.stdout)}`,
  );
});

Deno.test("malformed JSON on stdin produces usable, non-empty output rather than an error", async () => {
  const res = await runStatusline("{not valid json");
  assertEquals(res.code, 0, res.stderr);
  assert(res.stdout.trim().length > 0, "expected non-empty stdout for malformed JSON");
});

Deno.test("a payload with no .model key produces usable, non-empty output rather than an error", async () => {
  const res = await runStatusline('{"workspace":{"current_dir":"/tmp"}}');
  assertEquals(res.code, 0, res.stderr);
  assert(res.stdout.trim().length > 0, "expected non-empty stdout for a missing .model key");
});

// --- pass-through: original payload reaches the downstream command unmodified ---

Deno.test("the original stdin payload reaches the downstream command unmodified, after the badge", async () => {
  const payload = '{"model":{"id":"claude-sonnet-5","display_name":"Sonnet 5"},' +
    '"workspace":{"current_dir":"/home/joshua"},"cost":{"total_cost_usd":1.23}}';
  const res = await runStatusline(payload, "cat");
  assertEquals(res.code, 0, res.stderr);
  // With STATUSLINE_DOWNSTREAM_CMD=cat, the downstream command echoes
  // exactly what it received on stdin — so the tail of our stdout must be
  // the exact same payload string, unmodified.
  assert(
    res.stdout.endsWith(payload),
    `expected stdout to end with the unmodified payload.\ngot: ${JSON.stringify(res.stdout)}`,
  );
  // The badge must appear before the payload text, not after.
  const badgeIdx = res.stdout.indexOf(SONNET_CODE);
  const payloadIdx = res.stdout.indexOf(payload);
  assert(badgeIdx !== -1 && payloadIdx !== -1 && badgeIdx < payloadIdx);
});

// --- exit status: never inherits the downstream command's exit status ---

Deno.test("the script exits 0 and still prints the badge even when the downstream command fails", async () => {
  const res = await runStatusline(
    '{"model":{"id":"claude-opus-5","display_name":"Opus 5"}}',
    "false",
  );
  assertEquals(res.code, 0, res.stderr);
  assertStringIncludes(res.stdout, OPUS_CODE);
  assertStringIncludes(res.stdout, "Opus");
});
