import { assert, assertStringIncludes } from "@std/assert";

const SKILL_MD_PATH = new URL("../skills/pr-review/SKILL.md", import.meta.url).pathname;

Deno.test("skills/pr-review/SKILL.md defines the Nits section for PR/issue-body prose findings", async () => {
  let content: string;
  try {
    content = await Deno.readTextFile(SKILL_MD_PATH);
  } catch (err) {
    throw new Error(`skills/pr-review/SKILL.md is missing or unreadable: ${err}`);
  }

  assert(content.length > 0, "skills/pr-review/SKILL.md is empty");

  // The section heading itself, defined in Step 3 item 2's list of post sections.
  assertStringIncludes(content, "**Nits** (`### 🔵 Nits`)");

  // Step 2 item 11's carve-out is redirected at Nits, not at Suggestions.
  assertStringIncludes(
    content,
    "Such a drift may still be raised, but only under `### 🔵 Nits`.",
  );

  // The empty-render convention matches the other sections: unadorned heading plus "✅ None".
  assertStringIncludes(content, "If none, render `### Nits` with `✅ None`.");

  // Nits sits directly beneath Suggestions in the posted body.
  assertStringIncludes(content, "**Placed directly beneath `### 🟡 Suggestions`**");

  // A Nit never blocks the merge on its own.
  assertStringIncludes(
    content,
    "a Nit never produces `**🛑 Changes Requested**` on its own",
  );

  // Suggestions explicitly excludes body prose, so the two scopes cannot be conflated.
  assertStringIncludes(content, "**Exclusion of PR/Issue-Body Prose**");

  // The ruling on Step 4 follow-ups is stated, not left to inference.
  assertStringIncludes(
    content,
    "**`### 🔵 Nits` never appears in a Step 4 follow-up post.**",
  );

  // Every closed enumeration of the taxonomy names all three levels.
  assertStringIncludes(content, "not a Must Fix, not a\n      Suggestion, not a Nit —");

  // The worked example for post #1 renders the section.
  assertStringIncludes(content, "\n   ### 🔵 Nits\n   - 🔵 ");
});
