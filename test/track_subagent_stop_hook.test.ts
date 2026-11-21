// track_subagent_stop_hook.test.ts — web-jam-tools#708
//
// hooks/track-subagent-stop.sh through its stdin payload: a finished subagent leaves the
// running-subagent list, which frees its slot for the next launch the cap counts. The bookkeeping
// cases are in subagent_lifecycle_tracker.test.ts. Requirements: "Subagents and the work queue" in
// ~/Dropbox/web-jam-llms/AI_Misbehaves/delegation-gate-design.md (revision 1.3.0).

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  launchPayload,
  lifecyclePayload,
  queuedLaunches,
  runHookScript,
  runningSummary,
  withSandbox,
  writeSwitch,
} from "./support/subagent_cap_fixtures.ts";

const SCRIPT = "track-subagent-stop.sh";
const START = "track-subagent-start.sh";
const CAP = "cap-concurrent-subagents.sh";

Deno.test("track-subagent-stop: a SubagentStop payload removes the subagent and nothing is printed", async () => {
  await withSandbox(async (box) => {
    await runHookScript(box, START, JSON.stringify(lifecyclePayload("SubagentStart", "a1")));
    const res = await runHookScript(
      box,
      SCRIPT,
      JSON.stringify(lifecyclePayload("SubagentStop", "a1")),
    );
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stdout.trim(), "");
    assertEquals(runningSummary(box), []);
  });
});

Deno.test("track-subagent-stop: a subagent that was never recorded changes nothing", async () => {
  await withSandbox(async (box) => {
    await runHookScript(box, START, JSON.stringify(lifecyclePayload("SubagentStart", "a1")));
    const res = await runHookScript(
      box,
      SCRIPT,
      JSON.stringify(lifecyclePayload("SubagentStop", "ghost")),
    );
    assertEquals(res.code, 0, res.stderr);
    assertEquals(runningSummary(box), ["a1:running"]);
  });
});

Deno.test("track-subagent-stop: a stop frees the slot, so the next launch the cap saw full is admitted", async () => {
  await withSandbox(async (box) => {
    await runHookScript(box, START, JSON.stringify(lifecyclePayload("SubagentStart", "a1")));
    await runHookScript(box, START, JSON.stringify(lifecyclePayload("SubagentStart", "a2")));
    const launch = JSON.stringify(launchPayload({ model: "haiku", description: "waits" }));

    const full = await runHookScript(box, CAP, launch);
    assertEquals(JSON.parse(full.stdout).hookSpecificOutput.permissionDecision, "deny");
    assertEquals((await queuedLaunches(box)).length, 1);

    await runHookScript(box, SCRIPT, JSON.stringify(lifecyclePayload("SubagentStop", "a1")));
    const freed = await runHookScript(box, CAP, launch);
    assertEquals(freed.code, 0, freed.stderr);
    assertEquals(freed.stdout.trim(), "");
    assertEquals(await queuedLaunches(box), []);
  });
});

Deno.test("track-subagent-stop: a payload it cannot read is reported in a system message and exits 0", async () => {
  await withSandbox(async (box) => {
    const res = await runHookScript(box, SCRIPT, "this is not json");
    assertEquals(res.code, 0, res.stderr);
    assertStringIncludes(JSON.parse(res.stdout).systemMessage, "could not run");
  });
});

Deno.test("track-subagent-stop: the workflow switch skips recording", async () => {
  await withSandbox(async (box) => {
    await runHookScript(box, START, JSON.stringify(lifecyclePayload("SubagentStart", "a1")));
    await writeSwitch(box, "track-subagent-stop");
    const res = await runHookScript(
      box,
      SCRIPT,
      JSON.stringify(lifecyclePayload("SubagentStop", "a1")),
    );
    assertEquals(res.code, 0, res.stderr);
    assertStringIncludes(JSON.parse(res.stdout).systemMessage, "Released by workflow switch");
    assertEquals(runningSummary(box), ["a1:running"]);
  });
});
