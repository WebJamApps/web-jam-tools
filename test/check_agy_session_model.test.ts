// test/check_agy_session_model.test.ts — web-jam-tools#1018
//
// Automated unit tests for hooks/lib/check_agy_session_model.ts.
// Exercises checkSessionModel() and stdin runner across all 3 outcomes:
// - Outcome 1: condition holds (allowed Flash models, including -tiered at >= 3.7 floor)
// - Outcome 2: condition does not hold (below-floor, flash-low, non-Flash models denied with exit 2)
// - Outcome 3: cannot determine (missing, null, empty, or unparseable modelName fails open with exit 0)

import { assert, assertEquals } from "@std/assert";
import { checkSessionModel } from "../hooks/lib/check_agy_session_model.ts";

const SCRIPT_PATH = new URL("../hooks/lib/check_agy_session_model.ts", import.meta.url).pathname;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runSessionModelCli(input: string): Promise<RunResult> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--no-config", "--allow-read", "--allow-env", SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

// --- Outcome 1: condition holds (allowed Flash models) ---

Deno.test("checkSessionModel: Outcome 1 - gemini-3.8-flash-tiered and Flash models >= 3.7 are allowed", () => {
  assertEquals(checkSessionModel("gemini-3.8-flash-tiered"), { allowed: true });
  assertEquals(checkSessionModel("gemini-3.7-flash-tiered"), { allowed: true });
  assertEquals(checkSessionModel("gemini-3.8-flash-high"), { allowed: true });
  assertEquals(checkSessionModel("gemini-3.8-flash-medium"), { allowed: true });
  assertEquals(checkSessionModel("gemini-3.7-flash-high"), { allowed: true });
  assertEquals(checkSessionModel("gemini-3.7-flash-medium"), { allowed: true });
});

// --- Outcome 2: condition does not hold (denied models) ---

Deno.test("checkSessionModel: Outcome 2 - below-floor, flash-low, and non-Flash slugs are denied", () => {
  const belowFloor = checkSessionModel("gemini-3.6-flash-tiered");
  assertEquals(belowFloor.allowed, false);
  assert(belowFloor.reason?.includes("is not an allowed Flash slug"));
  assert(belowFloor.reason?.includes("gemini-3.8-flash-tiered"));

  const flashLow = checkSessionModel("gemini-3.8-flash-low");
  assertEquals(flashLow.allowed, false);
  assert(flashLow.reason?.includes("gemini-3.8-flash-tiered"));

  const pro = checkSessionModel("gemini-3.1-pro");
  assertEquals(pro.allowed, false);

  const sonnet = checkSessionModel("claude-sonnet-4-6");
  assertEquals(sonnet.allowed, false);
});

// --- Outcome 3: cannot determine (fails open) ---

Deno.test("checkSessionModel: Outcome 3 - missing, null, or empty modelName fails open", () => {
  assertEquals(checkSessionModel(undefined), { allowed: true });
  assertEquals(checkSessionModel(null), { allowed: true });
  assertEquals(checkSessionModel(""), { allowed: true });
});

// --- CLI stdin execution tests for all three outcomes ---

Deno.test("CLI stdin Outcome 1: gemini-3.8-flash-tiered exits 0 with no stderr", async () => {
  const res = await runSessionModelCli(JSON.stringify({ modelName: "gemini-3.8-flash-tiered" }));
  assertEquals(res.code, 0);
  assertEquals(res.stderr, "");
});

Deno.test("CLI stdin Outcome 1: gemini-3.7-flash-tiered exits 0 with no stderr", async () => {
  const res = await runSessionModelCli(JSON.stringify({ modelName: "gemini-3.7-flash-tiered" }));
  assertEquals(res.code, 0);
  assertEquals(res.stderr, "");
});

Deno.test("CLI stdin Outcome 2: below-floor gemini-3.6-flash-tiered exits 2 with BLOCKED message", async () => {
  const res = await runSessionModelCli(JSON.stringify({ modelName: "gemini-3.6-flash-tiered" }));
  assertEquals(res.code, 2);
  assert(res.stderr.includes("BLOCKED (agy-model guard)"));
  assert(res.stderr.includes("gemini-3.8-flash-tiered"));
});

Deno.test("CLI stdin Outcome 2: gemini-3.8-flash-low exits 2 with BLOCKED message", async () => {
  const res = await runSessionModelCli(JSON.stringify({ modelName: "gemini-3.8-flash-low" }));
  assertEquals(res.code, 2);
  assert(res.stderr.includes("BLOCKED (agy-model guard)"));
  assert(res.stderr.includes("gemini-3.8-flash-tiered"));
});

Deno.test("CLI stdin Outcome 3: empty modelName or unparseable input exits 0", async () => {
  const emptyRes = await runSessionModelCli(JSON.stringify({ modelName: "" }));
  assertEquals(emptyRes.code, 0);

  const missingRes = await runSessionModelCli(JSON.stringify({}));
  assertEquals(missingRes.code, 0);

  const unparseableRes = await runSessionModelCli("not-json");
  assertEquals(unparseableRes.code, 0);
});
