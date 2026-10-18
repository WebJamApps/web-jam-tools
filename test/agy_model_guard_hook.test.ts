// agy_model_guard_hook.test.ts — web-jam-tools#432 scope item 7
//
// Two layers: pure-logic unit tests on checkSessionModel(), and end-to-end
// tests driving REAL agy PreToolUse payloads (carrying `modelName`, per
// finding 7) through hooks/agy-hook-shim.sh + hooks/agy-model-guard.sh,
// asserting the shim's emitted verdict is agy's `decision:"deny"` form for
// a non-Flash model, and `decision:"allow"` for an allowed high model.

import { assert, assertEquals } from "@std/assert";
import { checkSessionModel } from "../hooks/lib/check_agy_session_model.ts";
import { matcherMatches } from "../hooks/lib/agy_hook_shim.ts";

const SHIM_PATH = new URL("../hooks/agy-hook-shim.sh", import.meta.url).pathname;
const GUARD_PATH = new URL("../hooks/agy-model-guard.sh", import.meta.url).pathname;
const DIRECT_HOOK_PATH = GUARD_PATH;

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function runDirect(payload: unknown): Promise<Result> {
  const cmd = new Deno.Command("bash", {
    args: [DIRECT_HOOK_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

async function runViaShim(payload: unknown): Promise<{ decision: string; reason?: string }> {
  const matcherB64 = btoa(".*");
  const cmd = new Deno.Command("bash", {
    args: [SHIM_PATH, "PreToolUse", matcherB64, GUARD_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: {
      ...Deno.env.toObject(),
      AGY_HOOK_RECORD_PATH: "off",
    },
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
  await writer.close();
  const { stdout } = await child.output();
  return JSON.parse(new TextDecoder().decode(stdout).trim());
}

// --- Unit tests: checkSessionModel() ---

Deno.test("checkSessionModel: allowed Flash slugs pass", () => {
  assert(checkSessionModel("gemini-3.8-flash-high").allowed);
  assert(checkSessionModel("gemini-3.8-flash-tiered").allowed);
  assert(checkSessionModel("gemini-3.7-flash-high").allowed); // 3.7 floor
  assert(!checkSessionModel("gemini-3.8-flash-medium").allowed); // retired, web-jam-tools#1202
  assert(!checkSessionModel("gemini-3.7-flash-medium").allowed);
  assert(checkSessionModel("gemini-3.7-flash-tiered").allowed); // 3.7 floor
});

Deno.test("checkSessionModel: Argon at high passes, Argon at medium or low is denied", () => {
  assert(checkSessionModel("gemini-4-argon-high").allowed);
  assert(!checkSessionModel("gemini-4-argon-medium").allowed);
  assert(!checkSessionModel("gemini-4-argon-low").allowed);
});

Deno.test("checkSessionModel: below-floor and non-Flash slugs are denied", () => {
  assert(!checkSessionModel("gemini-3.6-flash-low").allowed);
  assert(!checkSessionModel("gemini-3.6-flash-tiered").allowed);
  assert(!checkSessionModel("claude-opus-4-6-thinking").allowed);
  assert(!checkSessionModel("gpt-oss-120b-medium").allowed);
});

Deno.test("checkSessionModel: missing/empty modelName fails OPEN (cost guard, not a leak guard)", () => {
  assert(checkSessionModel(undefined).allowed);
  assert(checkSessionModel(null).allowed);
  assert(checkSessionModel("").allowed);
});

// --- Direct hook invocation (Claude/shim-normalized shape: top-level modelName) ---

Deno.test("agy-model-guard.sh denies a non-Flash modelName with exit 2", async () => {
  const res = await runDirect({ modelName: "gemini-3.6-flash-low" });
  assertEquals(res.code, 2);
  assert(res.stderr.includes("BLOCKED (agy-model guard)"), res.stderr);
});

Deno.test("agy-model-guard.sh allows an allowed high modelName", async () => {
  const res = await runDirect({ modelName: "gemini-3.8-flash-high" });
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("agy-model-guard.sh allows gemini-4-argon-high and denies Argon at medium or low", async () => {
  const ok = await runDirect({ modelName: "gemini-4-argon-high" });
  assertEquals(ok.code, 0, ok.stderr);
  for (const modelName of ["gemini-4-argon-medium", "gemini-4-argon-low"]) {
    const res = await runDirect({ modelName });
    assertEquals(res.code, 2, modelName);
    assert(res.stderr.includes("BLOCKED (agy-model guard)"), res.stderr);
  }
});

Deno.test("agy-model-guard.sh allows gemini-3.8-flash-tiered", async () => {
  const res = await runDirect({ modelName: "gemini-3.8-flash-tiered" });
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("agy-model-guard.sh allows with additionalContext when modelName is absent", async () => {
  const res = await runDirect({});
  assertEquals(res.code, 0, res.stderr);
  const output = JSON.parse(res.stdout).hookSpecificOutput;
  assertEquals(output.hookEventName, "PreToolUse");
  assertEquals(output.permissionDecision, undefined);
  assert(output.additionalContext.includes("could not determine modelName"));
  assert(output.additionalContext.includes("allowed high model"));
});

// --- End-to-end via the shim, real agy payload shape ---

Deno.test(
  "agy-native model guard: a non-Flash modelName driven through the shim yields agy's decision:deny form",
  async () => {
    const verdict = await runViaShim({
      toolCall: { name: "run_command", args: { CommandLine: "ls" } },
      modelName: "claude-opus-4-6-thinking",
    });
    assertEquals(verdict.decision, "deny");
    assert(verdict.reason && verdict.reason.length > 0);
  },
);

Deno.test(
  "agy-native model guard: an allowed high modelName driven through the shim yields decision:allow",
  async () => {
    const verdict = await runViaShim({
      toolCall: { name: "run_command", args: { CommandLine: "ls" } },
      modelName: "gemini-3.8-flash-high",
    });
    assertEquals(verdict.decision, "allow");
  },
);

Deno.test(
  "agy-native model guard: gemini-3.8-flash-tiered driven through the shim yields decision:allow",
  async () => {
    const verdict = await runViaShim({
      toolCall: { name: "run_command", args: { CommandLine: "ls" } },
      modelName: "gemini-3.8-flash-tiered",
    });
    assertEquals(verdict.decision, "allow");
  },
);

Deno.test(
  "agy-native model guard: fires on a non-Bash tool too (matcher is .*)",
  async () => {
    const verdict = await runViaShim({
      toolCall: { name: "send_email", args: {} },
      modelName: "gemini-3.6-flash-low",
    });
    assertEquals(verdict.decision, "deny");
  },
);

// Gmail matcher coverage only: model choice/cost dialogue belongs to handle-gmails,
// while this session guard permits Flash, Argon and Sonnet high.

Deno.test(
  "haiku-only-gmail-gate.sh's matcher never matches agy's raw (unprefixed) Gmail tool names",
  () => {
    const matcher = "mcp__(gmail|claude_ai_Gmail)__.*";
    for (const raw of ["send_email", "delete_email", "search_emails", "read_email"]) {
      assert(!matcherMatches(matcher, raw), `expected "${raw}" not to match "${matcher}"`);
    }
  },
);

Deno.test("Sonnet high is allowed through the direct hook and agy shim; low/medium are denied", async () => {
  for (
    const [modelName, decision, code] of [
      ["claude-sonnet-5-5-high", "allow", 0],
      ["claude-sonnet-5-5-medium", "deny", 2],
      ["claude-sonnet-5-5-low", "deny", 2],
    ] as const
  ) {
    assertEquals((await runDirect({ modelName })).code, code, modelName);
    assertEquals(
      (await runViaShim({ toolCall: { name: "run_command", args: {} }, modelName })).decision,
      decision,
      modelName,
    );
  }
});
