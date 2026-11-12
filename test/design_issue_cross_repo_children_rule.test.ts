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

  // Key requirement 1: Children in any repo attached natively and not restated in epic body
  assertStringIncludes(
    content,
    "Attach every child, in any repository, natively as a sub-issue and do NOT restate it inside the epic body",
  );

  // Key requirement 2: Every plan row belongs to an epic
  assertStringIncludes(
    content,
    "**Every plan row belongs to an epic**: Every non-epic row in the plan table must name an epic or a plan row in its `Epic / child of` cell (never empty or `none`)",
  );

  // Key requirement 3: Cross-repository work lives in web-jam-tools
  assertStringIncludes(
    content,
    "**Cross-repository work lives in web-jam-tools**: An epic whose children sit in more than one repository, and a non-epic issue whose work spans repositories, must have its Repo cell set to `web-jam-tools`",
  );
});
