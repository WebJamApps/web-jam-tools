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

  // The run performs the measurement itself, inside the run, before proposing anything
  assertStringIncludes(
    content,
    "The run carries out the measurement itself, inside the same run, before proposing anything.",
  );

  // No issues or plan table while the measurement is outstanding
  assertStringIncludes(
    content,
    "The run proposes no issues and presents no plan table while the measurement is outstanding",
  );

  // Gate 1 fires against the revised document once the measurement reports
  assertStringIncludes(
    content,
    "presents that revised document at **GATE 1** exactly as any other design does",
  );

  // Gate 1 does not fire until the measurement has reported
  assertStringIncludes(
    content,
    "Gate 1 does not fire until the measurement has reported and the document has been revised from its findings",
  );

  // The measurement is filed as an issue only when Josh asks for it
  assertStringIncludes(
    content,
    "Only then is the measurement filed as an issue, and only when Josh asks for it to be",
  );

  // The never-dispatches rule is reconciled, not silently in tension
  assertStringIncludes(
    content,
    "**This is not dispatching build work.**",
  );
  assertStringIncludes(
    content,
    "the measure-first run only ever hands off *finding out* what is true",
  );

  // Decision-Readiness Rule cross-reference
  assertStringIncludes(
    content,
    "it converts the run to a measure-first run (below).",
  );

  // Refusal table rows
  assertStringIncludes(
    content,
    "present a design at Gate 1 whose mechanism rests on measurement that has not been performed",
  );
  assertStringIncludes(
    content,
    "present an issue plan, or ask for issue-plan approval, in a measure-first run before the measurement has reported",
  );

  // The old shape must not survive anywhere in the file
  assert(
    !content.includes("filed as an issue, and nothing else"),
    "SKILL.md still describes the old measure-first shape (measurement filed as an issue, nothing else)",
  );
  assert(
    !content.includes("Gate 2 does, unchanged"),
    "SKILL.md still describes Gate 2 firing unchanged on a measurement-as-issue plan",
  );
  assert(
    !content.includes("does not fire in a measure-first run"),
    "SKILL.md still asserts Gate 1 never fires in a measure-first run",
  );
});
