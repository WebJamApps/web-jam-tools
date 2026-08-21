// hook_issue_pr_no_close_rule.test.ts — web-jam-tools#662
//
// Asserts that docs/cross-ai-rules.md and skills/draft-pr/SKILL.md define the standing rule
// and carve-out that a PR for a hook issue never closes the issue on merge.

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

Deno.test("docs/cross-ai-rules.md defines the hook issue PR no-close hard rule", async () => {
  const rawContent = await Deno.readTextFile(CROSS_AI_RULES_PATH);
  const normalized = normalizeWhitespace(rawContent);

  // Rule heading
  assertStringIncludes(rawContent, "**A PR FOR A HOOK ISSUE NEVER CLOSES THE ISSUE.**");

  // Hook scope and prohibited closing keywords
  assertStringIncludes(
    normalized,
    "When an issue adds or changes a hook — a git hook, a Claude Code hook, any hook installed onto a machine — the PR body carries no closing keyword (`Closes`, `Fixes`, `Resolves`) for it.",
  );

  // Requirement to use Part of instead
  assertStringIncludes(rawContent, "Use `Part of <repo>#<number>` instead.");

  // Post-merge confirmation requirement before manual close
  assertStringIncludes(
    normalized,
    "After the PR merges, the hook is installed and confirmed to actually fire, and only then is the issue closed by hand.",
  );

  // Josh ruling reference
  assertStringIncludes(
    normalized,
    "whenever we create an issue involving hooks, the PR should never close on merge, it should always remain open so we can install the hook and/or confirm the hook is working, then the issue gets closed manually",
  );
});

Deno.test("skills/draft-pr/SKILL.md exists and can be read", async () => {
  const content = await Deno.readTextFile(DRAFT_PR_SKILL_PATH);
  assert(content.length > 0, "skills/draft-pr/SKILL.md is empty");
});

Deno.test("skills/draft-pr/SKILL.md defines hook issue carve-out in frontmatter and body", async () => {
  const rawContent = await Deno.readTextFile(DRAFT_PR_SKILL_PATH);
  const normalized = normalizeWhitespace(rawContent);

  // Frontmatter description mentions hook issues carve-out
  assertStringIncludes(
    rawContent,
    "hook issues that must be confirmed firing before closing",
  );

  // Intro section mentions hook issue carve-out with pointer to docs/cross-ai-rules.md
  assertStringIncludes(
    normalized,
    "hook issue that must remain open until installed and confirmed firing — see `docs/cross-ai-rules.md`",
  );

  // How to run it section mentions hook issue carve-out with pointer to docs/cross-ai-rules.md
  assertStringIncludes(
    normalized,
    "hook PRs never close on merge because the hook must be installed and confirmed firing first — see `docs/cross-ai-rules.md`",
  );
});
