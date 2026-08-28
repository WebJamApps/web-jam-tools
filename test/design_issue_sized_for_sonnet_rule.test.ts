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
    '| file a `Sonnet`-labeled trigger-list issue without an enumerated closed case list of literal input strings — including a list that enumerates categories (e.g. "piped to an interpreter") instead of the strings a matcher will see |',
  );
  assertStringIncludes(
    content,
    'trigger-list work (guards, hooks, regex, matchers, filters, permission patterns) is sized for Sonnet by its case list, not its diff; a case list counts as closed only when every entry is a literal input string, never a category; vague criteria like "handle edge cases" and category-named criteria both fail in review — a category is an unclosed list wearing the shape of a closed one; issues must enumerate every adversarial input case as a literal string, or, where a category cannot be reduced to such a finite set at design time, be filed as `Opus`, naming the category that resisted enumeration |',
  );
});

Deno.test("skills/design-issue/SKILL.md contains the case-list-closedness rule (web-jam-tools#827)", async () => {
  const content = await Deno.readTextFile(SKILL_MD_PATH);

  // The closedness rule sits immediately after the Sized for Sonnet paragraph it extends.
  const sonnetRuleIndex = content.indexOf(
    "**Trigger-list work is sized for Sonnet by its case list, not its diff.**",
  );
  const closednessIndex = content.indexOf(
    "**A case list counts as closed only when it enumerates input strings, never categories.**",
  );
  const closeableIndex = content.indexOf("### Closeable, Always");

  assert(sonnetRuleIndex !== -1, "Missing Sized for Sonnet rule paragraph");
  assert(closednessIndex !== -1, "Missing case-list-closedness rule paragraph");
  assert(closeableIndex !== -1, "Missing ### Closeable, Always section");
  assert(
    sonnetRuleIndex < closednessIndex && closednessIndex < closeableIndex,
    "case-list-closedness rule must appear immediately after the Sized for Sonnet rule and before ### Closeable, Always",
  );

  // The rule ties an unenumerable category to the existing rule's escape hatch, requiring
  // an Opus label naming the category that resisted enumeration.
  assertStringIncludes(
    content,
    'a category cannot be reduced to a finite set of such strings at design time, that is the "cannot be pinned down" condition in the rule above: the issue is filed `Opus`-labeled, naming the category that could not be enumerated.',
  );

  // A category may still head a group of enumerated strings, but is never itself a case.
  assertStringIncludes(
    content,
    "A category may still be stated, but only as the heading over its enumerated strings — never as a case in its own right.",
  );
});
