// test/design_issue_epic_no_markdown_sub_issue_checklist.test.ts — web-jam-tools#734
//
// Tests that skills/design-issue/SKILL.md and docs/cross-ai-rules.md stop requiring
// redundant markdown sub-issues checklists in parent Epic bodies.

import { assert, assertFalse, assertStringIncludes } from "@std/assert";

const SKILL_MD_PATH = new URL("../skills/design-issue/SKILL.md", import.meta.url).pathname;
const CROSS_AI_RULES_PATH = new URL("../docs/cross-ai-rules.md", import.meta.url).pathname;

Deno.test("skills/design-issue/SKILL.md does not require redundant markdown sub-issues checklist in parent Epic bodies", async () => {
  const content = await Deno.readTextFile(SKILL_MD_PATH);
  assert(content.length > 0, "skills/design-issue/SKILL.md is empty");

  // Step 4 under Designed Issues with Paired Manual Steps Become Parent Epics
  assertStringIncludes(
    content,
    '4. **Author the parent Epic body with `## What this builds`, milestone, design document pointer, and `## Acceptance criteria` ("Closes when all child sub-issues close")** without duplicating a manual markdown list or checkboxes of sub-issues',
  );

  // Must not require carrying the sub-issue list
  assertFalse(
    content.includes("Author the parent Epic body with the sub-issue list and closing criteria"),
    "SKILL.md must not contain superseded instruction requiring sub-issue list in epic body",
  );
});

Deno.test("docs/cross-ai-rules.md does not require redundant markdown sub-issues checklist in parent Epic bodies", async () => {
  const content = await Deno.readTextFile(CROSS_AI_RULES_PATH);
  assert(content.length > 0, "docs/cross-ai-rules.md is empty");

  assertStringIncludes(
    content,
    'The parent Epic body specifies\n    `## What this builds`, milestone, design document pointer, and `## Acceptance criteria` ("Closes\n    when all child sub-issues close") without duplicating a manual markdown checklist of sub-issues.',
  );

  assertFalse(
    content.includes(
      "The parent Epic body carries the\n    sub-issue list and closes when all sub-issues close.",
    ),
    "cross-ai-rules.md must not contain superseded sentence requiring sub-issue list in epic body",
  );
});
