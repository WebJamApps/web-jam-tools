// track_subagent_start_hook.test.ts — web-jam-tools#708
//
// hooks/track-subagent-start.sh through its stdin payload: a started subagent is recorded in the
// running-subagent list the cap counts, taking over the slot the cap reserved for its launch. The
// bookkeeping cases are in subagent_lifecycle_tracker.test.ts. Requirements: "Subagents and the
// work queue" in ~/Dropbox/web-jam-llms/AI_Misbehaves/delegation-gate-design.md (revision 1.3.0).

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  launchPayload,
  lifecyclePayload,
  runHookScript,
  runningSummary,
  withSandbox,
  writeSwitch,
} from "./support/subagent_cap_fixtures.ts";

const SCRIPT = "track-subagent-start.sh";

Deno.test("track-subagent-start: a SubagentStart payload is recorded and nothing is printed", async () => {
  await withSandbox(async (box) => {
    const res = await runHookScript(
      box,
      SCRIPT,
      JSON.stringify(lifecyclePayload("SubagentStart", "a1")),
    );
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stdout.trim(), "");
    assertEquals(runningSummary(box), ["a1:running"]);
  });
});

Deno.test("track-subagent-start: the start takes over the slot the cap reserved for the launch", async () => {
  await withSandbox(async (box) => {
    const cap = await runHookScript(
      box,
      "cap-concurrent-subagents.sh",
      JSON.stringify(launchPayload({ model: "opus" })),
    );
    assertEquals(cap.code, 0, cap.stderr);
    assertEquals(runningSummary(box), ["-:reserved"]);

    await runHookScript(box, SCRIPT, JSON.stringify(lifecyclePayload("SubagentStart", "a1")));
    assertEquals(runningSummary(box), ["a1:running"]);
  });
});

Deno.test("track-subagent-start: a payload it cannot read is reported in a system message and exits 0", async () => {
  await withSandbox(async (box) => {
    const res = await runHookScript(box, SCRIPT, "this is not json");
    assertEquals(res.code, 0, res.stderr);
    assertStringIncludes(JSON.parse(res.stdout).systemMessage, "could not run");
  });
});

Deno.test("track-subagent-start: a payload with no session id is reported and records nothing", async () => {
  await withSandbox(async (box) => {
    const payload = { ...lifecyclePayload("SubagentStart", "a1"), session_id: undefined };
    const res = await runHookScript(box, SCRIPT, JSON.stringify(payload));
    assertEquals(res.code, 0, res.stderr);
    assertStringIncludes(JSON.parse(res.stdout).systemMessage, "could not be updated");
    assertEquals(runningSummary(box), []);
  });
});

Deno.test("track-subagent-start: the workflow switch skips recording", async () => {
  await withSandbox(async (box) => {
    await writeSwitch(box, "track-subagent-start");
    const res = await runHookScript(
      box,
      SCRIPT,
      JSON.stringify(lifecyclePayload("SubagentStart", "a1")),
    );
    assertEquals(res.code, 0, res.stderr);
    assertStringIncludes(JSON.parse(res.stdout).systemMessage, "Released by workflow switch");
    assertEquals(runningSummary(box), []);
  });
});
