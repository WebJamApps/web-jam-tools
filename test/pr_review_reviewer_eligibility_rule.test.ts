import { assert, assertStringIncludes } from "@std/assert";

const SKILL_MD_PATH = new URL("../skills/pr-review/SKILL.md", import.meta.url).pathname;

/** Slice of the skill between two headings, so a rule is pinned to the section it belongs to. */
function between(content: string, from: string, to: string): string {
  const start = content.indexOf(from);
  const end = content.indexOf(to, start + from.length);
  assert(start >= 0 && end > start, `could not locate "${from}" .. "${to}" in the skill`);
  return content.slice(start, end);
}

Deno.test("review eligibility permits model escalation in the same session and preserves Opus restriction", async () => {
  const pairing = between(
    await Deno.readTextFile(SKILL_MD_PATH),
    "## Purpose & Model Pairing",
    "## Trigger & Invocation",
  );

  assertStringIncludes(
    pairing,
    "**A session must not review its own work using the same or a lower model.**",
  );
  assertStringIncludes(
    pairing,
    "**Astra may review Sol-authored work, including a Sol fix in the same session.**",
  );
  assertStringIncludes(pairing, "Check all authors on the PR, not just its original footer.");
  assertStringIncludes(
    pairing,
    "**Use the active model's identity, not the earlier author's identity.**",
  );
  assertStringIncludes(pairing, "never infer the active model from conversation history");
  assertStringIncludes(pairing, "When the active model is eligible, perform the review directly.");
  assertStringIncludes(pairing, "propose or launch delegation unless Josh requests it");
  assertStringIncludes(pairing, "**Opus never reviews Opus work.**");
  assertStringIncludes(pairing, "a\n  different Opus session is not an independent reviewer");
  assert(!pairing.includes("**A session never reviews its own work.**"));
});

Deno.test("skills/pr-review/SKILL.md Step 1 checks reviewer eligibility before the diff is read", async () => {
  const step1 = between(await Deno.readTextFile(SKILL_MD_PATH), "### Step 1:", "### Step 2:");

  assertStringIncludes(step1, "**Reviewer eligibility is checked first.**");
  assertStringIncludes(step1, "before the diff is read");
  assertStringIncludes(step1, "Continue when Astra reviews a Sol fix, even in the same session.");
  assertStringIncludes(step1, "model restriction; session continuity alone never blocks review.");
  assertStringIncludes(step1, "names a Claude Opus author or co-author");
  assert(!step1.includes("Stop if this session wrote or pushed any commit on the PR."));
  assert(
    step1.indexOf("**Reviewer eligibility is checked first.**") <
      step1.indexOf("1. Fetch PR details"),
    "the eligibility check must sit ahead of Step 1's numbered items",
  );
});
