import { assert, assertStringIncludes } from "@std/assert";

const SKILL_MD_PATH = new URL("../skills/design-issue/SKILL.md", import.meta.url).pathname;

Deno.test("skills/design-issue/SKILL.md defines the runbook command verification rule", async () => {
  let content: string;
  try {
    content = await Deno.readTextFile(SKILL_MD_PATH);
  } catch (err) {
    throw new Error(`skills/design-issue/SKILL.md is missing or unreadable: ${err}`);
  }

  assert(content.length > 0, "skills/design-issue/SKILL.md is empty");

  // Rule heading / marker
  assertStringIncludes(
    content,
    "**Every literal command is proven runnable before the runbook ships:**",
  );

  // Key requirement 1: invocation form is verified against the tool's own --help output
  assertStringIncludes(content, "verified against");
  assertStringIncludes(content, "--help");

  // Key requirement 2: which verification was done, and for which commands, is recorded in the
  // authoring issue
  assertStringIncludes(
    content,
    "Which of the two was done, and for which commands, is recorded in the authoring issue.",
  );

  // Key requirement 3: does not license adding a verification step to the human walkthrough itself
  assertStringIncludes(
    content,
    "it never licenses adding a verification step to the walkthrough itself",
  );
});
