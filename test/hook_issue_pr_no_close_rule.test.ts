// hook_issue_pr_no_close_rule.test.ts — web-jam-tools#662, web-jam-tools#1614
//
// Asserts that docs/cross-ai-rules.md and skills/draft-pr/SKILL.md point to the canonical
// design document for hook issue PR closing behavior and local-step requirements.

import { assert, assertStringIncludes } from "@std/assert";

const CROSS_AI_RULES_PATH = new URL("../docs/cross-ai-rules.md", import.meta.url).pathname;
const DRAFT_PR_SKILL_PATH = new URL("../skills/draft-pr/SKILL.md", import.meta.url).pathname;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

Deno.test("docs/cross-ai-rules.md exists and can be read", async () => {
  const content = await Deno.readTextFile(CROSS_AI_RULES_PATH);
  assert(content.length > 0, "docs/cross-ai-rules.md is empty");
});

Deno.test("docs/cross-ai-rules.md points to canonical design for hook issue PR closing behavior", async () => {
  const rawContent = await Deno.readTextFile(CROSS_AI_RULES_PATH);
  const normalized = normalizeWhitespace(rawContent);

  // Rule heading
  assertStringIncludes(rawContent, "**A PR FOR A HOOK ISSUE NEVER CLOSES THE ISSUE.**");

  // Pointer to design document and sections
  assertStringIncludes(
    normalized,
    "Replaced by the canonical design document `/home/joshua/Dropbox/web-jam-llms/Token_Savings/design-issue-file-issue-design-2026-08-23.md`",
  );
  assertStringIncludes(
    normalized,
    '"Manual Steps & Runbooks" and "How a pull request names its issue"',
  );
  assertStringIncludes(normalized, "--local-step");
  assertStringIncludes(normalized, "Part of #N (local step after merge)");
});

Deno.test("skills/draft-pr/SKILL.md exists and can be read", async () => {
  const content = await Deno.readTextFile(DRAFT_PR_SKILL_PATH);
  assert(content.length > 0, "skills/draft-pr/SKILL.md is empty");
});

Deno.test("skills/draft-pr/SKILL.md defines issue line cases and --local-step", async () => {
  const rawContent = await Deno.readTextFile(DRAFT_PR_SKILL_PATH);
  const normalized = normalizeWhitespace(rawContent);

  assertStringIncludes(rawContent, "--local-step");
  assertStringIncludes(normalized, "Part of #N (local step after merge)");
  assertStringIncludes(normalized, "Manual Steps & Runbooks");
});
