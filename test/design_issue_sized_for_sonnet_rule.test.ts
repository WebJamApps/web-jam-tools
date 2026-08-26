// test/design_issue_sized_for_sonnet_rule.test.ts — web-jam-tools#793
//
// Tests that skills/design-issue/SKILL.md defines the Sized for Sonnet subsection
// immediately after Sized for Flash High, along with its matching refusal table entry.

import { assert, assertStringIncludes } from "@std/assert";

const SKILL_MD_PATH = new URL("../skills/design-issue/SKILL.md", import.meta.url).pathname;

Deno.test("skills/design-issue/SKILL.md defines the Sized for Sonnet rule immediately after Sized for Flash High", async () => {
  let content: string;
  try {
    content = await Deno.readTextFile(SKILL_MD_PATH);
  } catch (err) {
    throw new Error(`skills/design-issue/SKILL.md is missing or unreadable: ${err}`);
  }

  assert(content.length > 0, "skills/design-issue/SKILL.md is empty");

  // Verify section order: Sized for Flash High -> Sized for Sonnet -> Closeable, Always
  const flashHighIndex = content.indexOf("### Sized for Flash High");
  const sonnetIndex = content.indexOf("### Sized for Sonnet");
  const closeableIndex = content.indexOf("### Closeable, Always");

  assert(flashHighIndex !== -1, "Missing ### Sized for Flash High section");
  assert(sonnetIndex !== -1, "Missing ### Sized for Sonnet section");
  assert(closeableIndex !== -1, "Missing ### Closeable, Always section");
  assert(
    flashHighIndex < sonnetIndex && sonnetIndex < closeableIndex,
    "### Sized for Sonnet must appear immediately after ### Sized for Flash High and before ### Closeable, Always",
  );

  // Key requirement 1: Lead heading / principle
  assertStringIncludes(
    content,
    "**Trigger-list work is sized for Sonnet by its case list, not its diff.**",
  );

  // Key requirement 2: Citation and default tier
  assertStringIncludes(
    content,
    'Work matching the guard/hook/regex/matcher/filter/permission-pattern trigger list (`web-jam-tools#427 "Route guard/matcher work to Sonnet, make its review execute rather than read, prove it in CI, enforce citations on GitHub writes, and stop Opus designing other lanes\' fixes — A1 through A6"`) defaults to `Sonnet`.',
  );

  // Key requirement 3: Enumerated closed case list requirement
  assertStringIncludes(
    content,
    'It only counts as `Sonnet`-sized once its acceptance criteria enumerate every adversarial input case the fix has to handle — not the phrase "handle edge cases," the actual list.',
  );

  // Key requirement 4: Splitting along tested behaviors
  assertStringIncludes(
    content,
    "Where that list splits along tested behaviors, file one issue per behavior, each with its own closed case list.",
  );

  // Key requirement 5: Single non-decomposable change fallback to Opus
  assertStringIncludes(
    content,
    "Where the fix is a single, non-decomposable change whose case list cannot be pinned down at design time, file it `Opus`-labeled instead, and say why it could not be split.",
  );
});

Deno.test("skills/design-issue/SKILL.md contains matching refusal table entry for Sonnet trigger-list sizing", async () => {
  const content = await Deno.readTextFile(SKILL_MD_PATH);

  assertStringIncludes(
    content,
    "| file a `Sonnet`-labeled trigger-list issue without an enumerated closed case list of adversarial inputs |",
  );
  assertStringIncludes(
    content,
    'trigger-list work (guards, hooks, regex, matchers, filters, permission patterns) is sized for Sonnet by its case list, not its diff; vague criteria like "handle edge cases" fail in review; issues must enumerate every adversarial input case or be filed as `Opus` |',
  );
});
