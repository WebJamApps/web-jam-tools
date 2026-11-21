// subagent_lifecycle_tracker.test.ts — web-jam-tools#708
//
// The SubagentStart and SubagentStop hooks that keep the running-subagent list the cap counts: a
// started subagent is recorded (taking over the slot reserved when its launch was admitted), a
// stopped one leaves, and an entry whose transcript has been silent for 30 minutes without a Stop
// event is dropped so a helper that crashed never blocks a later launch. Requirements: "Subagents
// and the work queue" in ~/Dropbox/web-jam-llms/AI_Misbehaves/delegation-gate-design.md (revision
// 1.3.0).

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  decideLaunch,
  readRunning,
  recordSubagentStart,
  recordSubagentStop,
  runMode,
  SILENT_TRANSCRIPT_MS,
} from "../hooks/lib/check_agent_concurrency.ts";
import {
  launchPayload,
  lifecyclePayload,
  runningSummary,
  SESSION_ID,
  withSandbox,
  writeMainTranscript,
  writeSwitch,
} from "./support/subagent_cap_fixtures.ts";

const MINUTE = 60 * 1000;

Deno.test("tracker: a started subagent is recorded and a stopped one leaves", async () => {
  await withSandbox(async (box) => {
    assertEquals(
      (await recordSubagentStart(lifecyclePayload("SubagentStart", "a1"), box.deps)).ok,
      true,
    );
    assertEquals(
      (await recordSubagentStart(lifecyclePayload("SubagentStart", "a2"), box.deps)).ok,
      true,
    );
    assertEquals(runningSummary(box), ["a1:running", "a2:running"]);

    assertEquals(
      (await recordSubagentStop(lifecyclePayload("SubagentStop", "a1"), box.deps)).ok,
      true,
    );
    assertEquals(runningSummary(box), ["a2:running"]);
  });
});

Deno.test("tracker: stopping a subagent that was never recorded changes nothing", async () => {
  await withSandbox(async (box) => {
    await recordSubagentStart(lifecyclePayload("SubagentStart", "a1"), box.deps);
    assertEquals(
      (await recordSubagentStop(lifecyclePayload("SubagentStop", "ghost"), box.deps)).ok,
      true,
    );
    assertEquals(runningSummary(box), ["a1:running"]);
  });
});

Deno.test("tracker: a start takes over the slot reserved when its launch was admitted", async () => {
  await withSandbox(async (box) => {
    await decideLaunch(launchPayload({ model: "sonnet", subagent_type: "Explore" }), box.deps);
    await decideLaunch(launchPayload({ model: "opus", description: "second" }), box.deps);
    assertEquals(runningSummary(box), ["-:reserved", "-:reserved"]);

    await recordSubagentStart(
      lifecyclePayload("SubagentStart", "a1", { agent_type: "Explore" }),
      box.deps,
    );
    assertEquals(runningSummary(box), ["a1:running", "-:reserved"]);
    await recordSubagentStart(lifecyclePayload("SubagentStart", "a2"), box.deps);
    assertEquals(runningSummary(box), ["a1:running", "a2:running"]);
  });
});

Deno.test("tracker: a start repeated for the same agent does not take a second slot", async () => {
  await withSandbox(async (box) => {
    await recordSubagentStart(lifecyclePayload("SubagentStart", "a1"), box.deps);
    await recordSubagentStart(lifecyclePayload("SubagentStart", "a1"), box.deps);
    assertEquals(runningSummary(box), ["a1:running"]);
  });
});

Deno.test("tracker: a SubagentStop frees the slot for the next launch", async () => {
  await withSandbox(async (box) => {
    await recordSubagentStart(lifecyclePayload("SubagentStart", "a1"), box.deps);
    await recordSubagentStart(lifecyclePayload("SubagentStart", "a2"), box.deps);
    assertEquals(
      (await decideLaunch(launchPayload({ model: "haiku" }), box.deps)).decision,
      "deny",
    );
    await recordSubagentStop(lifecyclePayload("SubagentStop", "a1"), box.deps);
    assertEquals(
      (await decideLaunch(launchPayload({ model: "haiku" }), box.deps)).decision,
      "allow",
    );
  });
});

Deno.test("tracker: the entry names the subagent's own transcript, found from the main transcript path", async () => {
  await withSandbox(async (box) => {
    const main = await writeMainTranscript(box, "claude-opus-5-5");
    await recordSubagentStart(
      lifecyclePayload("SubagentStart", "a1", { transcript_path: main }),
      box.deps,
    );
    const entry = readRunning(SESSION_ID, box.deps)![0];
    assertEquals(entry.transcript_path, `${box.projectDir}/${SESSION_ID}/subagents/agent-a1.jsonl`);
  });
});

// --- the 30-minute silence rule ----------------------------------------------------------------

Deno.test("tracker: an entry silent for 30 minutes without a Stop event is dropped, and not before", async () => {
  await withSandbox(async (box) => {
    await recordSubagentStart(lifecyclePayload("SubagentStart", "a1"), box.deps);
    box.clock.now += SILENT_TRANSCRIPT_MS - MINUTE;
    assertEquals(runningSummary(box), ["a1:running"]);
    box.clock.now += 2 * MINUTE;
    assertEquals(runningSummary(box), []);
  });
});

Deno.test("tracker: a crashed helper stops blocking launches after 30 silent minutes", async () => {
  await withSandbox(async (box) => {
    const main = await writeMainTranscript(box, "claude-opus-5-5");
    await recordSubagentStart(lifecyclePayload("SubagentStart", "crashed"), box.deps);
    await recordSubagentStart(
      lifecyclePayload("SubagentStart", "alive", { transcript_path: main }),
      box.deps,
    );
    assertEquals(
      (await decideLaunch(launchPayload({ model: "sonnet" }), box.deps)).decision,
      "deny",
    );

    // 31 minutes on, the crashed helper has said nothing since it started; the live one wrote a minute ago.
    box.clock.now += 31 * MINUTE;
    box.mtimes.set(
      `${box.projectDir}/${SESSION_ID}/subagents/agent-alive.jsonl`,
      box.clock.now - MINUTE,
    );

    assertEquals(
      (await decideLaunch(launchPayload({ model: "sonnet" }), box.deps)).decision,
      "allow",
    );
    assertEquals(runningSummary(box), ["alive:running", "-:reserved"]);
  });
});

Deno.test("tracker: a transcript written recently keeps a long-running entry", async () => {
  await withSandbox(async (box) => {
    const main = await writeMainTranscript(box, "claude-opus-5-5");
    await recordSubagentStart(
      lifecyclePayload("SubagentStart", "a1", { transcript_path: main }),
      box.deps,
    );
    const transcript = readRunning(SESSION_ID, box.deps)![0].transcript_path!;

    box.clock.now += 3 * 60 * MINUTE;
    box.mtimes.set(transcript, box.clock.now - 5 * MINUTE);
    assertEquals(runningSummary(box), ["a1:running"]);

    box.mtimes.set(transcript, box.clock.now - 31 * MINUTE);
    assertEquals(runningSummary(box), []);
  });
});

Deno.test("tracker: a transcript that cannot be read falls back to the start time", async () => {
  await withSandbox(async (box) => {
    const main = await writeMainTranscript(box, "claude-opus-5-5");
    await recordSubagentStart(
      lifecyclePayload("SubagentStart", "a1", { transcript_path: main }),
      box.deps,
    );
    box.clock.now += 29 * MINUTE;
    assertEquals(runningSummary(box), ["a1:running"]);
    box.clock.now += 2 * MINUTE;
    assertEquals(runningSummary(box), []);
  });
});

// --- unreadable state and the workflow-guard default ------------------------------------------

Deno.test("tracker: an unreadable list is reported, not silently overwritten", async () => {
  await withSandbox(async (box) => {
    await Deno.mkdir(box.stateDir, { recursive: true });
    const path = `${box.stateDir}/${SESSION_ID}.running.json`;
    await Deno.writeTextFile(path, "{ not json");
    const res = await recordSubagentStart(lifecyclePayload("SubagentStart", "a1"), box.deps);
    assertEquals(res.ok, false);
    assertEquals(await Deno.readTextFile(path), "{ not json");
  });
});

Deno.test("tracker: a payload with no usable session or agent id is reported", async () => {
  await withSandbox(async (box) => {
    for (
      const payload of [
        { ...lifecyclePayload("SubagentStart", "a1"), session_id: undefined },
        { ...lifecyclePayload("SubagentStart", "a1"), session_id: "a/b" },
        { ...lifecyclePayload("SubagentStart", ""), agent_id: undefined },
      ]
    ) {
      assertEquals((await recordSubagentStart(payload, box.deps)).ok, false);
      assertEquals((await recordSubagentStop(payload, box.deps)).ok, false);
    }
    assertEquals(readRunning(SESSION_ID, box.deps), []);
  });
});

Deno.test("tracker: runMode says nothing when it records, and names the problem when it cannot", async () => {
  await withSandbox(async (box) => {
    assertEquals(await runMode("start", lifecyclePayload("SubagentStart", "a1"), box.deps), "");
    const out = JSON.parse(
      await runMode(
        "start",
        { ...lifecyclePayload("SubagentStart", "a1"), session_id: "" },
        box.deps,
      ),
    );
    assertStringIncludes(out.systemMessage, "track-subagent-start");
    assertStringIncludes(out.systemMessage, "could not be updated");
    assertEquals(await runMode("stop", lifecyclePayload("SubagentStop", "a1"), box.deps), "");
  });
});

for (
  const [mode, guard, event] of [
    ["start", "track-subagent-start", "SubagentStart"],
    ["stop", "track-subagent-stop", "SubagentStop"],
  ] as const
) {
  for (const named of [guard, `${guard}.sh`, "all"]) {
    Deno.test(`tracker: a workflow switch naming "${named}" skips recording on ${event}`, async () => {
      await withSandbox(async (box) => {
        await recordSubagentStart(lifecyclePayload("SubagentStart", "keep"), box.deps);
        await writeSwitch(box, named);
        const out = JSON.parse(await runMode(mode, lifecyclePayload(event, "keep"), box.deps));
        assertStringIncludes(out.systemMessage, "Released by workflow switch");
        assertEquals(runningSummary(box), ["keep:running"]);
      });
    });
  }
}

Deno.test("tracker: a switch naming the cap does not skip the trackers", async () => {
  await withSandbox(async (box) => {
    await writeSwitch(box, "cap-concurrent-subagents");
    assertEquals(await runMode("start", lifecyclePayload("SubagentStart", "a1"), box.deps), "");
    assertEquals(runningSummary(box), ["a1:running"]);
  });
});

Deno.test("tracker: an unknown mode is an error", async () => {
  await withSandbox(async (box) => {
    let message = "";
    try {
      await runMode("bogus", {}, box.deps);
    } catch (err) {
      message = (err as Error).message;
    }
    assertStringIncludes(message, 'unknown mode "bogus"');
  });
});
