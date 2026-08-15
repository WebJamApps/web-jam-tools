// agy_model_guard_hook.test.ts — web-jam-tools#432 scope item 7
//
// Two layers: pure-logic unit tests on checkSessionModel(), and end-to-end
// tests driving REAL agy PreToolUse payloads (carrying `modelName`, per
// finding 7) through hooks/agy-hook-shim.sh + hooks/agy-model-guard.sh,
// asserting the shim's emitted verdict is agy's `decision:"deny"` form for
// a non-Flash model, and `decision:"allow"` for an allowed Flash model.

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
  assert(checkSessionModel("gemini-3.7-flash-high").allowed);
  assert(checkSessionModel("gemini-3.7-flash-medium").allowed);
  assert(checkSessionModel("gemini-3.8-flash-high").allowed);
});

Deno.test("checkSessionModel: below-floor and non-Flash slugs are denied", () => {
  assert(!checkSessionModel("gemini-3.6-flash-low").allowed);
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

Deno.test("agy-model-guard.sh allows an allowed Flash modelName", async () => {
  const res = await runDirect({ modelName: "gemini-3.7-flash-high" });
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("agy-model-guard.sh fails open when modelName is absent", async () => {
  const res = await runDirect({});
  assertEquals(res.code, 0, res.stderr);
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
  "agy-native model guard: an allowed Flash modelName driven through the shim yields decision:allow",
  async () => {
    const verdict = await runViaShim({
      toolCall: { name: "run_command", args: { CommandLine: "ls" } },
      modelName: "gemini-3.7-flash-medium",
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

// --- Haiku cost gate surface-awareness (scope item 4) ---
//
// hooks/haiku-only-gmail-gate.sh is NOT edited and stays wired on Claude
// Code with its existing matcher (mcp__(gmail|claude_ai_Gmail)__.*), gating
// it to Haiku exactly as before (unchanged, covered by
// test/haiku_only_gmail_gate_hook.test.ts). It also stays in the shared
// PRE_TOOL_USE_HOOKS list wrapped for agy, but that matcher is Claude
// Code-specific (the mcp__ prefix convention) and never matches agy's raw,
// unprefixed Gmail tool names, so on agy it naturally never fires — instead,
// this session-wide Flash gate (matcher ".*") is what permits/denies Gmail
// calls there. Together: Claude Code stays gated to Haiku, Antigravity is
// gated to Flash, neither hook needed to change.

Deno.test(
  "haiku-only-gmail-gate.sh's matcher never matches agy's raw (unprefixed) Gmail tool names",
  () => {
    const matcher = "mcp__(gmail|claude_ai_Gmail)__.*";
    for (const raw of ["send_email", "delete_email", "search_emails", "read_email"]) {
      assert(!matcherMatches(matcher, raw), `expected "${raw}" not to match "${matcher}"`);
    }
  },
);
