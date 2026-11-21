// cap_concurrent_subagents_hook.test.ts — web-jam-tools#708
//
// hooks/cap-concurrent-subagents.sh through its stdin payload: the PreToolUse decision JSON a
// launch on the `Agent` tool gets, and the workflow-guard defaults. The launch-by-launch matrix is
// in agent_concurrency_cap_hook.test.ts. Requirements: "Subagents and the work queue" in
// ~/Dropbox/web-jam-llms/AI_Misbehaves/delegation-gate-design.md (revision 1.3.0).

import { assertEquals, assertStringIncludes } from "@std/assert";
import { recordSubagentStart } from "../hooks/lib/check_agent_concurrency.ts";
import {
  launchPayload,
  lifecyclePayload,
  queuedLaunches,
  runHookScript,
  runningSummary,
  type Sandbox,
  withSandbox,
  writeSwitch,
} from "./support/subagent_cap_fixtures.ts";

const SCRIPT = "cap-concurrent-subagents.sh";

async function fillSlots(box: Sandbox, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await recordSubagentStart(lifecyclePayload("SubagentStart", `busy${i}`), box.deps);
  }
}

Deno.test("cap script: an admitted launch prints nothing and exits 0", async () => {
  await withSandbox(async (box) => {
    const res = await runHookScript(box, SCRIPT, JSON.stringify(launchPayload({ model: "opus" })));
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stdout.trim(), "");
    assertEquals(runningSummary(box), ["-:reserved"]);
  });
});

Deno.test("cap script: an explicit fable launch is denied with the PreToolUse decision JSON", async () => {
  await withSandbox(async (box) => {
    const res = await runHookScript(box, SCRIPT, JSON.stringify(launchPayload({ model: "fable" })));
    assertEquals(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assertEquals(out.hookSpecificOutput.hookEventName, "PreToolUse");
    assertEquals(out.hookSpecificOutput.permissionDecision, "deny");
    assertStringIncludes(out.hookSpecificOutput.permissionDecisionReason, "Fable");
    assertEquals(await queuedLaunches(box), []);
  });
});

Deno.test("cap script: a third launch is denied and written to the session queue", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    const res = await runHookScript(
      box,
      SCRIPT,
      JSON.stringify(launchPayload({ model: "sonnet", description: "queued by script" })),
    );
    assertEquals(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, "deny");
    assertEquals((await queuedLaunches(box)).map((q) => q.description), ["queued by script"]);
  });
});

Deno.test("cap script: three launches started at the same moment admit exactly two", async () => {
  await withSandbox(async (box) => {
    const results = await Promise.all(
      ["one", "two", "three"].map((description) =>
        runHookScript(box, SCRIPT, JSON.stringify(launchPayload({ model: "sonnet", description })))
      ),
    );
    for (const res of results) assertEquals(res.code, 0, res.stderr);
    const denied = results.filter((r) => r.stdout.includes('"permissionDecision":"deny"'));
    assertEquals(denied.length, 1);
    assertEquals(runningSummary(box), ["-:reserved", "-:reserved"]);
    assertEquals((await queuedLaunches(box)).length, 1);
  });
});

Deno.test("cap script: a checker that cannot run allows the launch with a note", async () => {
  await withSandbox(async (box) => {
    const res = await runHookScript(box, SCRIPT, "this is not json");
    assertEquals(res.code, 0);
    const out = JSON.parse(res.stdout);
    assertStringIncludes(out.hookSpecificOutput.additionalContext, "could not run");
  });
});

Deno.test("cap script: the workflow switch releases it", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    await writeSwitch(box, "cap-concurrent-subagents");
    const res = await runHookScript(box, SCRIPT, JSON.stringify(launchPayload({ model: "opus" })));
    assertEquals(res.code, 0, res.stderr);
    assertStringIncludes(
      JSON.parse(res.stdout).hookSpecificOutput.additionalContext,
      "Released by workflow switch",
    );
  });
});
