import { assert, assertStringIncludes } from "@std/assert";

const SKILL_MD_PATH = new URL("../skills/design-issue/SKILL.md", import.meta.url).pathname;

Deno.test("skills/design-issue/SKILL.md defines the cross-repo children rule in Phase 3 filing", async () => {
  let content: string;
  try {
    content = await Deno.readTextFile(SKILL_MD_PATH);
  } catch (err) {
    throw new Error(`skills/design-issue/SKILL.md is missing or unreadable: ${err}`);
  }

  assert(content.length > 0, "skills/design-issue/SKILL.md is empty");

  // Rule heading / marker
  assertStringIncludes(content, "**Cross-repo children.**");

  // Key requirement 1: Sub-issues are same-repo only
  assertStringIncludes(
    content,
    "GitHub sub-issues exist only within a single repository",
  );

  // Key requirement 2: Same-repo children attached natively and not restated in epic body
  assertStringIncludes(
    content,
    "Attach every same-repo child natively and do NOT restate it in the epic body",
  );

  // Key requirement 3: Cross-repo children named in epic body under own heading and cited as repo#number "title"
  assertStringIncludes(
    content,
    'Name ONLY the cross-repo children in the epic body, under their own heading, and cite each as `repo#number "title"`',
  );

  // Key requirement 4: Non-duplication rule
  assertStringIncludes(
    content,
    "Never both: each child appears in exactly one place, or the epic drifts from its own child list",
  );
});
