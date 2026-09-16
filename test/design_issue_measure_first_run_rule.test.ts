import { assert, assertStringIncludes } from "@std/assert";

const SKILL_MD_PATH = new URL("../skills/design-issue/SKILL.md", import.meta.url).pathname;

Deno.test("skills/design-issue/SKILL.md defines the measure-first run rule", async () => {
  let content: string;
  try {
    content = await Deno.readTextFile(SKILL_MD_PATH);
  } catch (err) {
    throw new Error(`skills/design-issue/SKILL.md is missing or unreadable: ${err}`);
  }

  assert(content.length > 0, "skills/design-issue/SKILL.md is empty");

  // Section heading
  assertStringIncludes(content, "### The Measure-First Run");

  // The run's deliverable is the measurement, not a design
  assertStringIncludes(
    content,
    "its deliverable is the measurement, not a design",
  );

  // The design is an output of the measurement, never an input to it
  assertStringIncludes(
    content,
    "the design is an output of the measurement, never an input to it",
  );

  // A measure-first run presents nothing at Gate 1
  assertStringIncludes(
    content,
    "A measure-first run presents nothing at Gate 1 and never asks Josh to approve a design",
  );

  // Gate 1 does not fire in a measure-first run
  assertStringIncludes(content, "Gate 1 does not fire in a measure-first run");

  // Decision-Readiness Rule cross-reference
  assertStringIncludes(
    content,
    "it converts the run to a measure-first run (below).",
  );

  // Refusal table row
  assertStringIncludes(
    content,
    "present a design at Gate 1 whose mechanism rests on measurement that has not been performed",
  );
});
