import { assert, assertStringIncludes } from "@std/assert";

const SKILL_MD_PATH = new URL("../skills/pr-review/SKILL.md", import.meta.url).pathname;

/** Slice of the skill between two headings, so a rule is pinned to the section it belongs to. */
function between(content: string, from: string, to: string): string {
  const start = content.indexOf(from);
  const end = content.indexOf(to, start + from.length);
  assert(start >= 0 && end > start, `could not locate "${from}" .. "${to}" in the skill`);
  return content.slice(start, end);
}

Deno.test("skills/pr-review/SKILL.md says a session never reviews its own work and Opus never reviews Opus", async () => {
  const pairing = between(
    await Deno.readTextFile(SKILL_MD_PATH),
    "## Purpose & Model Pairing",
    "## Trigger & Invocation",
  );

  assertStringIncludes(pairing, "**Who may never review a PR (Josh, 2026-10-03):**");
  assertStringIncludes(pairing, "**A session never reviews its own work.**");
  assertStringIncludes(pairing, "never runs this skill on that PR and never offers to");
  assertStringIncludes(pairing, "**Opus never reviews Opus work.**");
  assertStringIncludes(pairing, "a\n  different Opus session is not an independent reviewer");
  assertStringIncludes(pairing, "asks him directly how he wants it checked");
});

Deno.test("skills/pr-review/SKILL.md Step 1 checks reviewer eligibility before the diff is read", async () => {
  const step1 = between(await Deno.readTextFile(SKILL_MD_PATH), "### Step 1:", "### Step 2:");

  assertStringIncludes(step1, "**Reviewer eligibility is checked first.**");
  assertStringIncludes(step1, "before the diff is read");
  assertStringIncludes(step1, "Stop if this session wrote or pushed any commit on the PR.");
  assertStringIncludes(step1, "names a Claude Opus author or co-author");
  assert(
    step1.indexOf("**Reviewer eligibility is checked first.**") <
      step1.indexOf("1. Fetch PR details"),
    "the eligibility check must sit ahead of Step 1's numbered items",
  );
});
