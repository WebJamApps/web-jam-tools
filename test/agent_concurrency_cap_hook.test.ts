// agent_concurrency_cap_hook.test.ts — web-jam-tools#708
//
// The PreToolUse cap on the `Agent` tool: at most two Anthropic-billed subagents run at once, an
// explicit or inherited Opus coding helper takes one slot like any other, and an explicit `fable`
// launch or a launch inheriting Fable is refused without queuing. Requirements: "Subagents and the
// work queue" and the helper-launch rows of "Opus coding and Josh’s choice of Fable" in
// ~/Dropbox/web-jam-llms/AI_Misbehaves/delegation-gate-design.md (revision 1.3.0).
//
// Every case runs against a sandbox state directory and a private workflow switch; nothing reads
// or writes ~/.claude.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CapDeps,
  decideLaunch,
  type LaunchDecision,
  MAX_RUNNING_SUBAGENTS,
  recordSubagentStart,
  recordSubagentStop,
  RESERVATION_TTL_MS,
  runMode,
} from "../hooks/lib/check_agent_concurrency.ts";
import {
  launchPayload,
  lifecyclePayload,
  queuedLaunches,
  runningSummary,
  type Sandbox,
  SESSION_ID,
  withSandbox,
  writeMainTranscript,
  writeSubagentMeta,
  writeSwitch,
} from "./support/subagent_cap_fixtures.ts";

const OPUS = "claude-opus-5-5";
const FABLE = "claude-fable-5-2";
const SONNET = "claude-sonnet-5-5";

/** Starts `count` subagents so that many slots are running. */
async function fillSlots(box: Sandbox, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    const res = await recordSubagentStart(lifecyclePayload("SubagentStart", `busy${i}`), box.deps);
    assert(res.ok);
  }
}

function assertAllowed(decision: LaunchDecision): void {
  assertEquals(decision, { decision: "allow", note: undefined });
}

function assertDenied(decision: LaunchDecision, text: string): void {
  assertEquals(decision.decision, "deny");
  if (decision.decision === "deny") assertStringIncludes(decision.reason, text);
}

// --- explicit helper models, with a slot free and with the queue full -------------------------

for (const model of ["opus", "sonnet", "haiku"]) {
  for (const running of [0, 1]) {
    Deno.test(`cap: an explicit ${model} helper is admitted with ${running} running`, async () => {
      await withSandbox(async (box) => {
        await fillSlots(box, running);
        assertAllowed(await decideLaunch(launchPayload({ model }), box.deps));
        assertEquals(runningSummary(box).length, running + 1);
        assertEquals(await queuedLaunches(box), []);
      });
    });
  }

  Deno.test(`cap: an explicit ${model} helper is refused and queued with 2 running`, async () => {
    await withSandbox(async (box) => {
      await fillSlots(box, MAX_RUNNING_SUBAGENTS);
      const decision = await decideLaunch(launchPayload({ model, description: "third" }), box.deps);
      assertDenied(decision, "2 subagents are already running");
      assertEquals((await queuedLaunches(box)).map((q) => q.description), ["third"]);
      assertEquals(runningSummary(box), ["busy1:running", "busy2:running"]);
    });
  });
}

Deno.test("cap: the refusal names the queue file and what to do next", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    const decision = await decideLaunch(launchPayload({ model: "opus" }), box.deps);
    assertDenied(decision, `${box.stateDir}/${SESSION_ID}.queue.jsonl`);
    assertDenied(decision, "launch the queued task");
  });
});

// --- Fable -------------------------------------------------------------------------------------

for (const running of [0, 1, 2]) {
  Deno.test(`cap: an explicit fable launch is refused with ${running} running and never queued`, async () => {
    await withSandbox(async (box) => {
      await fillSlots(box, running);
      const decision = await decideLaunch(launchPayload({ model: "fable" }), box.deps);
      assertDenied(decision, "Fable is kept for work Josh names");
      assertEquals(await queuedLaunches(box), []);
      assertEquals(runningSummary(box).length, running);
    });
  });
}

Deno.test("cap: a full model id naming Fable is refused too", async () => {
  await withSandbox(async (box) => {
    assertDenied(
      await decideLaunch(launchPayload({ model: FABLE }), box.deps),
      "names the Fable model",
    );
  });
});

for (const running of [0, 2]) {
  Deno.test(`cap: a fork inheriting Fable is refused with ${running} running and never queued`, async () => {
    await withSandbox(async (box) => {
      await fillSlots(box, running);
      const transcript = await writeMainTranscript(box, FABLE);
      const decision = await decideLaunch(
        launchPayload({ subagent_type: "fork", transcript_path: transcript }),
        box.deps,
      );
      assertDenied(decision, "would inherit Fable from this session");
      assertEquals(await queuedLaunches(box), []);
    });
  });
}

Deno.test("cap: an unqualified launch inheriting Fable from a Fable session is refused", async () => {
  await withSandbox(async (box) => {
    const transcript = await writeMainTranscript(box, FABLE);
    assertDenied(
      await decideLaunch(launchPayload({ transcript_path: transcript }), box.deps),
      "inherit Fable",
    );
    assertEquals(runningSummary(box), []);
  });
});

Deno.test("cap: a subagent on Fable launching a fork is refused", async () => {
  await withSandbox(async (box) => {
    const transcript = await writeMainTranscript(box, OPUS);
    await writeSubagentMeta(box, "sub1", FABLE);
    assertDenied(
      await decideLaunch(
        launchPayload({ subagent_type: "fork", agent_id: "sub1", transcript_path: transcript }),
        box.deps,
      ),
      "from the subagent starting it",
    );
  });
});

for (const running of [0, 1]) {
  Deno.test(`cap: a Sonnet helper a Fable session starts follows the ordinary cap with ${running} running`, async () => {
    await withSandbox(async (box) => {
      await fillSlots(box, running);
      const transcript = await writeMainTranscript(box, FABLE);
      assertAllowed(
        await decideLaunch(
          launchPayload({ model: "sonnet", transcript_path: transcript }),
          box.deps,
        ),
      );
      assertEquals(runningSummary(box).length, running + 1);
    });
  });
}

Deno.test("cap: a Sonnet helper a Fable session starts is queued with 2 running", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    const transcript = await writeMainTranscript(box, FABLE);
    assertDenied(
      await decideLaunch(
        launchPayload({
          model: "sonnet",
          description: "fable-sonnet",
          transcript_path: transcript,
        }),
        box.deps,
      ),
      "already running",
    );
    assertEquals((await queuedLaunches(box)).map((q) => q.description), ["fable-sonnet"]);
  });
});

// --- inheriting Opus or Sonnet -----------------------------------------------------------------

const INHERITING_LAUNCHES: Array<[string, { subagent_type?: string }]> = [
  ["a fork", { subagent_type: "fork" }],
  ["an unqualified launch", {}],
];

for (const [label, input] of INHERITING_LAUNCHES) {
  for (const [session, model] of [["Opus", OPUS], ["Sonnet", SONNET]]) {
    Deno.test(`cap: ${label} inheriting ${session} takes a slot`, async () => {
      await withSandbox(async (box) => {
        const transcript = await writeMainTranscript(box, model);
        assertAllowed(
          await decideLaunch(launchPayload({ ...input, transcript_path: transcript }), box.deps),
        );
        assertEquals(runningSummary(box), ["-:reserved"]);
      });
    });
  }

  Deno.test(`cap: ${label} inheriting Opus is queued with 2 running`, async () => {
    await withSandbox(async (box) => {
      await fillSlots(box, 2);
      const transcript = await writeMainTranscript(box, OPUS);
      assertDenied(
        await decideLaunch(launchPayload({ ...input, transcript_path: transcript }), box.deps),
        "already running",
      );
      assertEquals((await queuedLaunches(box)).length, 1);
    });
  });
}

// --- the queue and the slots -------------------------------------------------------------------

Deno.test("cap: two identical requests refused while full are two queue entries", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    for (const tool_use_id of ["toolu_first", "toolu_second"]) {
      const launch = launchPayload({
        model: "opus",
        description: "again",
        prompt: "same prompt",
        tool_use_id,
      });
      assertDenied(await decideLaunch(launch, box.deps), "already running");
    }
    const queued = await queuedLaunches(box);
    assertEquals(queued.map((q) => q.id), ["toolu_first", "toolu_second"]);
    assertEquals(queued[0].key, queued[1].key);
  });
});

Deno.test("cap: identical requests that carry no tool call id are each retained with their own id", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    const launch = launchPayload({ model: "opus", description: "again", prompt: "same prompt" });
    assertDenied(await decideLaunch(launch, box.deps), "already running");
    assertDenied(await decideLaunch(launch, box.deps), "already running");
    const queued = await queuedLaunches(box);
    assertEquals(queued.length, 2);
    assert(queued[0].id && queued[1].id && queued[0].id !== queued[1].id);
  });
});

Deno.test("cap: the same tool call reaching the hook again keeps one queue entry", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    const launch = launchPayload({
      model: "opus",
      description: "retry",
      tool_use_id: "toolu_same",
    });
    assertDenied(await decideLaunch(launch, box.deps), "already running");
    assertDenied(await decideLaunch(launch, box.deps), "already running");
    assertEquals((await queuedLaunches(box)).map((q) => q.id), ["toolu_same"]);
  });
});

Deno.test("cap: an admitted launch removes one queued entry, so an identical second request stays", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    for (const tool_use_id of ["toolu_first", "toolu_second"]) {
      await decideLaunch(
        launchPayload({ model: "opus", description: "again", prompt: "same prompt", tool_use_id }),
        box.deps,
      );
    }
    await recordSubagentStop(lifecyclePayload("SubagentStop", "busy1"), box.deps);
    assertAllowed(
      await decideLaunch(
        launchPayload({
          model: "opus",
          description: "again",
          prompt: "same prompt",
          tool_use_id: "toolu_relaunch",
        }),
        box.deps,
      ),
    );
    assertEquals((await queuedLaunches(box)).map((q) => q.id), ["toolu_second"]);
  });
});

Deno.test("cap: an admitted launch removes the entry carrying its own tool call id first", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    await decideLaunch(
      launchPayload({ model: "haiku", description: "older", tool_use_id: "toolu_old" }),
      box.deps,
    );
    await decideLaunch(
      launchPayload({ model: "haiku", description: "newer", tool_use_id: "toolu_new" }),
      box.deps,
    );
    await recordSubagentStop(lifecyclePayload("SubagentStop", "busy1"), box.deps);
    assertAllowed(
      await decideLaunch(
        launchPayload({ model: "haiku", description: "newer", tool_use_id: "toolu_new" }),
        box.deps,
      ),
    );
    assertEquals((await queuedLaunches(box)).map((q) => q.id), ["toolu_old"]);
  });
});

Deno.test("cap: a tool call id that is not a safe token is replaced by a fresh id", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    await decideLaunch(launchPayload({ model: "haiku", tool_use_id: "not a safe id!" }), box.deps);
    const [queued] = await queuedLaunches(box);
    assert(queued.id && queued.id !== "not a safe id!");
  });
});

Deno.test("cap: a refused launch is queued, then leaves the queue when it is admitted", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    const launch = launchPayload({ model: "opus", description: "again", prompt: "same prompt" });
    assertDenied(await decideLaunch(launch, box.deps), "already running");
    assertEquals((await queuedLaunches(box)).length, 1);

    await recordSubagentStop(lifecyclePayload("SubagentStop", "busy1"), box.deps);
    assertAllowed(await decideLaunch(launch, box.deps));
    assertEquals(await queuedLaunches(box), []);
  });
});

Deno.test("cap: a queue that cannot be read leaves no reservation and the queued entry in place", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    const launch = launchPayload({ model: "opus", description: "queued", tool_use_id: "toolu_q" });
    assertDenied(await decideLaunch(launch, box.deps), "already running");
    await recordSubagentStop(lifecyclePayload("SubagentStop", "busy1"), box.deps);

    const unreadable: CapDeps = {
      ...box.deps,
      readState: (path) => {
        if (path.endsWith(".queue.jsonl")) throw new Error("queue unreadable");
        return box.deps.readState(path);
      },
    };
    const decision = await decideLaunch(launch, unreadable);
    assertEquals(decision.decision, "allow");
    assertStringIncludes((decision as { note?: string }).note ?? "", "queue unreadable");
    assertEquals(runningSummary(box), ["busy2:running"]);
    assertEquals((await queuedLaunches(box)).map((q) => q.id), ["toolu_q"]);
  });
});

Deno.test("cap: a reservation that cannot be saved leaves the admitted launch off the queue", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    const launch = launchPayload({ model: "opus", description: "queued", tool_use_id: "toolu_q" });
    assertDenied(await decideLaunch(launch, box.deps), "already running");
    await recordSubagentStop(lifecyclePayload("SubagentStop", "busy1"), box.deps);

    // The list is readable but cannot be replaced: a directory now stands where the file was.
    const listPath = `${box.stateDir}/${SESSION_ID}.running.json`;
    const listText = Deno.readTextFileSync(listPath);
    Deno.removeSync(listPath);
    Deno.mkdirSync(listPath);
    const unsavable: CapDeps = {
      ...box.deps,
      readState: (path) => path === listPath ? listText : box.deps.readState(path),
    };

    const decision = await decideLaunch(launch, unsavable);
    assertEquals(decision.decision, "allow");
    assertStringIncludes((decision as { note?: string }).note ?? "", "could not be used");
    assertEquals(await queuedLaunches(box), []);
    const leftovers = [...Deno.readDirSync(box.stateDir)].map((e) => e.name).filter((n) =>
      n.endsWith(".tmp")
    );
    assertEquals(leftovers, []);
  });
});

Deno.test("cap: a full-cap refusal stands when the pruned list cannot be saved", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    // The list is readable but cannot be replaced: a directory now stands where the file was.
    const listPath = `${box.stateDir}/${SESSION_ID}.running.json`;
    const listText = Deno.readTextFileSync(listPath);
    Deno.removeSync(listPath);
    Deno.mkdirSync(listPath);
    const unsavable: CapDeps = {
      ...box.deps,
      readState: (path) => path === listPath ? listText : box.deps.readState(path),
    };

    const launch = launchPayload({ model: "opus", description: "queued", tool_use_id: "toolu_f" });
    assertDenied(await decideLaunch(launch, unsavable), "already running");
    assertEquals((await queuedLaunches(box)).map((q) => q.id), ["toolu_f"]);
    const leftovers = [...Deno.readDirSync(box.stateDir)].map((e) => e.name).filter((n) =>
      n.endsWith(".tmp")
    );
    assertEquals(leftovers, []);

    // The same call evaluated again is still one entry and still refused.
    assertDenied(await decideLaunch(launch, unsavable), "already running");
    assertEquals((await queuedLaunches(box)).length, 1);
  });
});

Deno.test("cap: a queue that cannot be written at full cap queues nothing and allows with a note", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    const queuePath = `${box.stateDir}/${SESSION_ID}.queue.jsonl`;
    Deno.mkdirSync(queuePath);
    const decision = await decideLaunch(launchPayload({ model: "opus" }), box.deps);
    assertEquals(decision.decision, "allow");
    assertStringIncludes((decision as { note?: string }).note ?? "", "could not be used");
    assertEquals(runningSummary(box), ["busy1:running", "busy2:running"]);
  });
});

Deno.test("cap: a different launch stays queued when another one is admitted", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    await decideLaunch(launchPayload({ model: "haiku", description: "waits" }), box.deps);
    await recordSubagentStop(lifecyclePayload("SubagentStop", "busy1"), box.deps);
    assertAllowed(
      await decideLaunch(launchPayload({ model: "sonnet", description: "other" }), box.deps),
    );
    assertEquals((await queuedLaunches(box)).map((q) => q.description), ["waits"]);
  });
});

Deno.test("cap: the cap is per session", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    assertAllowed(
      await decideLaunch(launchPayload({ model: "opus", session_id: "another-session" }), box.deps),
    );
  });
});

Deno.test("cap: reserved slots count, so three launches in a row admit only two", async () => {
  await withSandbox(async (box) => {
    const results = [];
    for (const description of ["one", "two", "three"]) {
      results.push(await decideLaunch(launchPayload({ model: "sonnet", description }), box.deps));
    }
    assertEquals(results.map((r) => r.decision), ["allow", "allow", "deny"]);
  });
});

Deno.test("cap: a reservation no SubagentStart claims frees its slot after the reservation time", async () => {
  await withSandbox(async (box) => {
    await decideLaunch(launchPayload({ model: "sonnet" }), box.deps);
    await decideLaunch(launchPayload({ model: "sonnet", description: "two" }), box.deps);
    assertDenied(
      await decideLaunch(launchPayload({ model: "sonnet", description: "three" }), box.deps),
      "already running",
    );
    box.clock.now += RESERVATION_TTL_MS + 1000;
    assertAllowed(
      await decideLaunch(launchPayload({ model: "sonnet", description: "three" }), box.deps),
    );
  });
});

Deno.test("cap: a tool other than Agent is allowed untouched", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    assertAllowed(
      await decideLaunch({ ...launchPayload({ model: "fable" }), tool_name: "Bash" }, box.deps),
    );
  });
});

// --- workflow-guard defaults and the off-switch ------------------------------------------------

Deno.test("cap: an unreadable running list allows the launch with a note", async () => {
  await withSandbox(async (box) => {
    await Deno.mkdir(box.stateDir, { recursive: true });
    await Deno.writeTextFile(`${box.stateDir}/${SESSION_ID}.running.json`, "{ not json");
    const decision = await decideLaunch(launchPayload({ model: "opus" }), box.deps);
    assertEquals(decision.decision, "allow");
    assertStringIncludes((decision as { note?: string }).note ?? "", "could not be used");
  });
});

Deno.test("cap: an indeterminate session model allows the launch with a note", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    const decision = await decideLaunch(launchPayload({}), box.deps);
    assertEquals(decision.decision, "allow");
    assertStringIncludes((decision as { note?: string }).note ?? "", "could not be determined");
  });
});

Deno.test("cap: an unreadable session id allows the launch with a note", async () => {
  await withSandbox(async (box) => {
    const decision = await decideLaunch(
      launchPayload({ model: "opus", session_id: "../escape" }),
      box.deps,
    );
    assertEquals(decision.decision, "allow");
    assertStringIncludes((decision as { note?: string }).note ?? "", "session id");
  });
});

Deno.test("cap: a missing state directory location allows the launch with a note", async () => {
  await withSandbox(async (box) => {
    const deps: CapDeps = { ...box.deps, stateDir: "" };
    const decision = await decideLaunch(launchPayload({ model: "opus" }), deps);
    assertEquals(decision.decision, "allow");
    assertStringIncludes((decision as { note?: string }).note ?? "", "state directory");
  });
});

for (const guard of ["cap-concurrent-subagents", "cap-concurrent-subagents.sh", "all"]) {
  Deno.test(`cap: a workflow switch naming "${guard}" releases the guard even with 2 running`, async () => {
    await withSandbox(async (box) => {
      await fillSlots(box, 2);
      await writeSwitch(box, guard);
      const out = JSON.parse(await runMode("check", launchPayload({ model: "fable" }), box.deps));
      assertStringIncludes(out.hookSpecificOutput.additionalContext, "Released by workflow switch");
      assertEquals(out.hookSpecificOutput.permissionDecision, undefined);
    });
  });
}

Deno.test("cap: a switch naming another guard does not release it", async () => {
  await withSandbox(async (box) => {
    await fillSlots(box, 2);
    await writeSwitch(box, "opus-delegation-gate");
    const out = JSON.parse(await runMode("check", launchPayload({ model: "opus" }), box.deps));
    assertEquals(out.hookSpecificOutput.permissionDecision, "deny");
  });
});
