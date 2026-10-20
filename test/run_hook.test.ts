// run_hook.test.ts — web-jam-tools#717 (decision D-32)
//
// Comprehensive tests for the shared hook runner hooks/lib/run_hook.sh:
// - Safety guard group default on missing Deno, crash, or timeout -> refuses (exit 2)
// - Workflow guard group default on missing Deno, crash, or timeout -> allows with note (exit 0)
// - Automatic group classification inference from hook name
// - Event-specific JSON envelope generation (PreToolUse, SessionStart, Stop, agy-native)
// - Normal execution pass-through of stdout, stderr, and exit codes 0 and 2

import { assert, assertEquals } from "@std/assert";

const RUNNER_PATH = new URL("../hooks/lib/run_hook.sh", import.meta.url).pathname;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runRunner(
  args: string[],
  stdinText = "",
  env?: Record<string, string>,
): Promise<RunResult> {
  const cmd = new Deno.Command("bash", {
    args: [RUNNER_PATH, ...args],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: env ? { ...Deno.env.toObject(), ...env } : undefined,
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(stdinText));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

Deno.test("run_hook.sh: missing Deno on safety guard refuses with exit 2 and standard message", async () => {
  const res = await runRunner(
    ["--group", "safety", "--name", "test-safety-guard", "deno", "eval", "Deno.exit(0)"],
    "",
    { PATH: "/usr/bin:/bin" },
  );

  assertEquals(res.code, 2);
  assert(
    res.stderr.includes(
      "BLOCKED (test-safety-guard): safety guard could not run (Deno is unavailable on PATH). Refusing action (safety default: fail closed).",
    ),
  );
  assert(
    res.stderr.includes(
      "Stop and report this refusal to Josh; do not retry the action through another route.",
    ),
  );
  assertEquals(res.stdout, "");
});

Deno.test("run_hook.sh: missing Deno on workflow guard proceeds with exit 0 and additionalContext", async () => {
  const res = await runRunner(
    [
      "--group",
      "workflow",
      "--name",
      "test-workflow-guard",
      "--event",
      "PreToolUse",
      "deno",
      "eval",
      "Deno.exit(0)",
    ],
    "",
    { PATH: "/usr/bin:/bin" },
  );

  assertEquals(res.code, 0);
  assertEquals(res.stderr, "");
  const parsed = JSON.parse(res.stdout);
  assertEquals(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert(
    parsed.hookSpecificOutput.additionalContext.includes(
      "test-workflow-guard: Deno is unavailable on PATH; proceeding via workflow default.",
    ),
  );
});

Deno.test("run_hook.sh: missing Deno on SessionStart workflow guard proceeds with systemMessage", async () => {
  const res = await runRunner(
    [
      "--group",
      "workflow",
      "--name",
      "test-reminder",
      "--event",
      "SessionStart",
      "deno",
      "eval",
      "Deno.exit(0)",
    ],
    "",
    { PATH: "/usr/bin:/bin" },
  );

  assertEquals(res.code, 0);
  assertEquals(res.stderr, "");
  const parsed = JSON.parse(res.stdout);
  assert(
    parsed.systemMessage.includes(
      "test-reminder: Deno is unavailable on PATH; proceeding via workflow default.",
    ),
  );
});

Deno.test("run_hook.sh: missing Deno on Stop workflow guard proceeds with systemMessage", async () => {
  const res = await runRunner(
    [
      "--group",
      "workflow",
      "--name",
      "test-stop",
      "--event",
      "Stop",
      "deno",
      "eval",
      "Deno.exit(0)",
    ],
    "",
    { PATH: "/usr/bin:/bin" },
  );

  assertEquals(res.code, 0);
  assertEquals(res.stderr, "");
  const parsed = JSON.parse(res.stdout);
  assert(
    parsed.systemMessage.includes(
      "test-stop: Deno is unavailable on PATH; proceeding via workflow default.",
    ),
  );
});

Deno.test("run_hook.sh: missing Deno on agy-skill-run-hook proceeds with decision: allow JSON", async () => {
  const res = await runRunner(
    ["--name", "agy-skill-run-hook", "deno", "eval", "Deno.exit(0)"],
    "",
    { PATH: "/usr/bin:/bin" },
  );

  assertEquals(res.code, 0);
  assertEquals(res.stderr, "");
  const parsed = JSON.parse(res.stdout);
  assertEquals(parsed.decision, "allow");
  assert(
    parsed.hookSpecificOutput.additionalContext.includes(
      "agy-skill-run-hook: Deno is unavailable on PATH",
    ),
  );
});

Deno.test("run_hook.sh: checker crash on safety guard refuses with exit 2", async () => {
  const res = await runRunner(
    [
      "--group",
      "safety",
      "--name",
      "test-safety",
      "deno",
      "eval",
      "console.error('fatal error'); Deno.exit(1)",
    ],
  );

  assertEquals(res.code, 2);
  assert(
    res.stderr.includes(
      "BLOCKED (test-safety): safety guard could not run (checker failed with exit code 1)",
    ),
  );
  assert(
    res.stderr.includes(
      "Stop and report this refusal to Josh; do not retry the action through another route.",
    ),
  );
});

Deno.test("run_hook.sh: checker crash on workflow guard proceeds with exit 0 and note", async () => {
  const res = await runRunner(
    [
      "--group",
      "workflow",
      "--name",
      "test-workflow",
      "--event",
      "PreToolUse",
      "deno",
      "eval",
      "Deno.exit(1)",
    ],
  );

  assertEquals(res.code, 0);
  const parsed = JSON.parse(res.stdout);
  assertEquals(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert(
    parsed.hookSpecificOutput.additionalContext.includes(
      "test-workflow: checker failed (exit 1); proceeding via workflow default.",
    ),
  );
});

Deno.test("run_hook.sh: successful checker (exit 0) passes stdout byte-identically", async () => {
  const expectedOutput = "CHECK_PASSED_OK\n";
  const res = await runRunner(
    ["--group", "safety", "--name", "test-guard", "deno", "eval", "console.log('CHECK_PASSED_OK')"],
  );

  assertEquals(res.code, 0);
  assertEquals(res.stdout, expectedOutput);
  assertEquals(res.stderr, "");
});

Deno.test("run_hook.sh: checker refusal (exit 2) passes stderr byte-identically", async () => {
  const res = await runRunner(
    [
      "--group",
      "safety",
      "--name",
      "test-guard",
      "deno",
      "eval",
      "console.error('DENIED_BY_CHECKER'); Deno.exit(2)",
    ],
  );

  assertEquals(res.code, 2);
  assertEquals(res.stderr.trim(), "DENIED_BY_CHECKER");
});

Deno.test("run_hook.sh: infers group automatically from safety guard name", async () => {
  const res = await runRunner(
    ["--name", "block-secret-literals", "deno", "eval", "Deno.exit(0)"],
    "",
    { PATH: "/usr/bin:/bin" },
  );

  assertEquals(res.code, 2);
  assert(res.stderr.includes("safety guard could not run"));
});

Deno.test("run_hook.sh: infers group automatically from workflow guard name", async () => {
  const res = await runRunner(
    ["--name", "fmt-push-guard", "deno", "eval", "Deno.exit(0)"],
    "",
    { PATH: "/usr/bin:/bin" },
  );

  assertEquals(res.code, 0);
  const parsed = JSON.parse(res.stdout);
  assert(
    parsed.hookSpecificOutput.additionalContext.includes(
      "fmt-push-guard: Deno is unavailable on PATH",
    ),
  );
});
