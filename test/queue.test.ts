import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  append,
  checkInvariants,
  dedupe,
  editDistanceLe1,
  isTaskHeader,
  matchHeader,
  parseQueue,
  renumber,
  serialize,
} from "../src/task-queue/queue.ts";

// A fixture mirroring the real claude-opus-tasks.txt shape: a preamble, a
// multi-line Task 0, then the typo'd `talk 5` header that was eating tasks.
const FIXTURE = `Tasks for claude opus to run

Pause after each task and wait for me to approve.


Task 0: Pastor David CL Firefox signup issue.
some detail line for task 0
talk 5: strategy for gig promotions feature
task 6: song list managment feature
task 10: copyright automations
Task 15 (added 2026-05-16): Research best Mac. [[task-spec-mac]]
`;

Deno.test("editDistanceLe1", () => {
  assertEquals(editDistanceLe1("task", "task"), true);
  assertEquals(editDistanceLe1("talk", "task"), true); // substitution
  assertEquals(editDistanceLe1("tak", "task"), true); // deletion
  assertEquals(editDistanceLe1("taslk", "task"), true); // insertion
  assertEquals(editDistanceLe1("songs", "task"), false);
});

Deno.test("matchHeader recognizes exact and typo'd headers", () => {
  assertEquals(matchHeader("Task 0: hello")?.num, 0);
  assertEquals(matchHeader("task 10: hi")?.num, 10);
  assertEquals(matchHeader("talk 5: gig promo")?.num, 5); // the loss-causing typo
  assertEquals(matchHeader("  Task 15 (added): x")?.num, 15);
});

Deno.test("matchHeader rejects non-headers", () => {
  assertEquals(matchHeader("- Phone: 540-555"), null);
  assertEquals(matchHeader("this references task 1 mid-line"), null);
  assertEquals(matchHeader("just prose here"), null);
  assertEquals(isTaskHeader("nope"), false);
});

Deno.test("parseQueue does NOT fold talk-5 into Task 0 (no silent loss)", () => {
  const q = parseQueue(FIXTURE);
  assertEquals(q.tasks.length, 5);
  const gig = q.tasks.find((t) => t.lines[0].includes("gig promotions"));
  assert(gig, "gig-promotions task must be parsed as a distinct task");
  assertEquals(gig!.num, 5);
  assertEquals(q.tasks[0].lines.includes("talk 5: strategy for gig promotions feature"), false);
});

Deno.test("round-trip serialize is byte-identical for an unchanged parse", () => {
  assertEquals(serialize(parseQueue(FIXTURE)), FIXTURE);
});

Deno.test("renumber preserves count, normalizes typo, produces unique step-5", () => {
  const count = parseQueue(FIXTURE).tasks.length;
  const q = renumber(parseQueue(FIXTURE), 5, 0);
  assertEquals(q.tasks.map((t) => t.num), [0, 5, 10, 15, 20]);
  assertMatch(q.tasks[1].lines[0], /^Task 5: strategy for gig promotions feature$/);
  const inv = checkInvariants(parseQueue(serialize(q)), count);
  assertEquals(inv.ok, true, inv.errors.join("; "));
});

Deno.test("dedupe bumps a duplicate number to the next free one (two 5s -> 6)", () => {
  const dup = `pre
task 5: alpha
task 5: beta
task 8: gamma
`;
  assertEquals(dedupe(parseQueue(dup)).tasks.map((t) => t.num), [5, 6, 8]);
});

Deno.test("dedupe skips an occupied slot when bumping", () => {
  const dup = `task 5: a
task 5: b
task 6: c
`;
  // second '5' can't be 6 (taken) -> next free is 7
  assertEquals(dedupe(parseQueue(dup)).tasks.map((t) => t.num), [5, 7, 6]);
});

Deno.test("append lands at the bottom with max+step", () => {
  const q = append(parseQueue(FIXTURE), "venue update for Connie", 5, 0);
  assertEquals(q.tasks.length, 6);
  const last = q.tasks[q.tasks.length - 1];
  assertEquals(last.num, 20); // max was 15 -> 20
  assertMatch(last.lines[0], /^Task 20: venue update for Connie$/);
});

Deno.test("append strips a caller-supplied Task prefix and renumbers cleanly", () => {
  const q = append(parseQueue(FIXTURE), "Task: do the thing", 5, 0);
  assertMatch(q.tasks[q.tasks.length - 1].lines[0], /^Task 20: do the thing$/);
});

Deno.test("checkInvariants flags loss and duplicates", () => {
  const lost = checkInvariants(parseQueue(FIXTURE), 99);
  assertEquals(lost.ok, false);
  assertMatch(lost.errors.join(" "), /TASK LOSS/);

  const dupes = checkInvariants(parseQueue("task 5: a\ntask 5: b\n"));
  assertEquals(dupes.ok, false);
  assertEquals(dupes.duplicates, [5]);
});
