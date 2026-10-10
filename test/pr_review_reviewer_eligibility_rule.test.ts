import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";

const SKILL_MD_PATH = new URL("../skills/pr-review/SKILL.md", import.meta.url).pathname;

/** Slice of the skill between two headings, so a rule is pinned to the section it belongs to. */
function between(content: string, from: string, to: string): string {
  const start = content.indexOf(from);
  const end = content.indexOf(to, start + from.length);
  assert(start >= 0 && end > start, `could not locate "${from}" .. "${to}" in the skill`);
  return content.slice(start, end);
}

export type EligibilityOutcome = "eligible" | "ineligible" | "undetermined";

export interface WorkedSequence {
  sequence: string;
  expectedResult: string;
  outcome: EligibilityOutcome;
}

export const WORKED_CONVERSATION_SEQUENCES: readonly WorkedSequence[] = [
  {
    sequence: "Sol writes → Josh selects Astra → review requested",
    expectedResult:
      "Astra reviews directly in the conversation if it has not contributed implementation",
    outcome: "eligible",
  },
  {
    sequence: "Sol writes → Josh selects Sonnet or Opus → review requested",
    expectedResult: "The selected eligible model reviews Sol's work",
    outcome: "eligible",
  },
  {
    sequence: "Sol writes → Sol review requested",
    expectedResult: "The writing model does not review its own contribution",
    outcome: "ineligible",
  },
  {
    sequence: "Sol writes → another Sol version selected",
    expectedResult: "No different-model exception",
    outcome: "ineligible",
  },
  {
    sequence: "Sol writes → Sol reasoning effort changed",
    expectedResult: "No different-model exception",
    outcome: "ineligible",
  },
  {
    sequence: "Flash writes → another Flash session selected in that conversation",
    expectedResult: "No different-model exception",
    outcome: "ineligible",
  },
  {
    sequence: "Sol writes → Astra reviews without fixing → Astra reviews a new eligible head",
    expectedResult: "Reviewing alone does not disqualify Astra",
    outcome: "eligible",
  },
  {
    sequence: "Sol writes → Astra fixes → Sol, Sonnet, or another Astra session selected",
    expectedResult: "Josh or Opus must review Astra's changes",
    outcome: "ineligible",
  },
  {
    sequence: "Sol writes → Astra fixes → Josh names Opus for review",
    expectedResult: "An eligible Opus reviewer reviews the PR",
    outcome: "eligible",
  },
  {
    sequence: "Astra writes the original implementation → reviewer selected",
    expectedResult: "Opus or Josh reviews it",
    outcome: "ineligible",
  },
  {
    sequence: "Opus writes or fixes → another Opus session selected",
    expectedResult: "No model reviewer; Josh reviews",
    outcome: "ineligible",
  },
  {
    sequence: "Sonnet writes → Flash selected",
    expectedResult: "Refuse because the reviewer tier is lower",
    outcome: "ineligible",
  },
  {
    sequence: "Sol writes → Astra selected → same head already reviewed",
    expectedResult: "Apply the existing duplicate-review rule",
    outcome: "ineligible",
  },
  {
    sequence: "Contributor identity cannot be established",
    expectedResult:
      "Explain the missing information and ask Josh; do not guess or delegate automatically",
    outcome: "undetermined",
  },
] as const;

Deno.test("skills/pr-review/SKILL.md states named-model eligibility and replaces unconditional session bans", async () => {
  const pairing = between(
    await Deno.readTextFile(SKILL_MD_PATH),
    "## Purpose & Model Pairing",
    "## Trigger & Invocation",
  );

  // Old unconditional session-wide bans are replaced and absent
  assertFalse(pairing.includes("**A session never reviews its own work.**"));
  assertFalse(pairing.includes("Stop if this session wrote or pushed any commit on the PR."));
  assertFalse(pairing.includes("**Who may never review a PR (Josh, 2026-10-03):**"));

  // Named-model eligibility principles
  assertStringIncludes(
    pairing,
    "Switching to an eligible different model allows the review to run in that conversation without requiring delegation.",
  );
  assertStringIncludes(pairing, "**A model never reviews its own contribution.**");
  assertStringIncludes(
    pairing,
    "The restriction follows the named model that wrote or pushed the implementation or fix, rather than disqualifying every model that uses the conversation.",
  );
  assertStringIncludes(
    pairing,
    "Astra may review Sol-authored work, including a Sol fix in the same session.",
  );
  assertStringIncludes(
    pairing,
    "A Sol attribution on an earlier commit does not mean the current reviewer is Sol",
  );
  assertStringIncludes(pairing, "never infer active identity from the earlier author");
  assertStringIncludes(
    pairing,
    "without requiring a fresh session, redundant permission, or delegation",
  );
  assertStringIncludes(
    pairing,
    "**Opus or Josh reviews Astra's work, including Astra's fixes to Sol's code.**",
  );
  assertStringIncludes(pairing, "**Opus never reviews Opus work.**");

  // Three outcomes stated in Purpose & Model Pairing
  assertStringIncludes(pairing, "**Three eligibility outcomes:**");
  assertStringIncludes(pairing, "1. **Proceeding when eligible**");
  assertStringIncludes(pairing, "2. **Refusing when ineligible**");
  assertStringIncludes(pairing, "3. **Refusing (failing closed) when undetermined**");
});

Deno.test("skills/pr-review/SKILL.md Step 1 checks reviewer eligibility before the diff is read", async () => {
  const step1 = between(await Deno.readTextFile(SKILL_MD_PATH), "### Step 1:", "### Step 2:");

  assertStringIncludes(step1, "**Reviewer eligibility is checked first.**");
  assertStringIncludes(step1, "before the diff is read");
  assertStringIncludes(
    step1,
    'apply the named-model eligibility rules under "Purpose & Model Pairing" above',
  );
  assertStringIncludes(
    step1,
    "Stop if the active model contributed implementation or pushed any fix to the PR",
  );
  assertStringIncludes(
    step1,
    "Permit Astra to review Sol-authored work, including a Sol fix from this same conversation",
  );
  assertStringIncludes(step1, "Never infer the active reviewer model from the PR author's footer");
  assertStringIncludes(
    step1,
    "Stop if the PR carries Astra contributions (implementation or fixes) and the active model is not Opus",
  );
  assertStringIncludes(step1, "Stop if any commit names an Opus author or co-author");
  assertStringIncludes(step1, "Stop if the active model ranks below any contributor's tier");
  assertStringIncludes(
    step1,
    "Stop and ask Josh if contributor or active model identity cannot be established",
  );

  // Old unconditional session ban is absent from Step 1
  assertFalse(step1.includes("Stop if this session wrote or pushed any commit on the PR."));
  assertStringIncludes(step1, "Session continuity alone never blocks review.");

  assert(
    step1.indexOf("**Reviewer eligibility is checked first.**") <
      step1.indexOf("1. Fetch PR details"),
    "the eligibility check must sit ahead of Step 1's numbered items",
  );
});

Deno.test("skills/pr-review/SKILL.md covers all 14 worked sequences and three eligibility outcomes", async () => {
  const skillText = await Deno.readTextFile(SKILL_MD_PATH);
  assertEquals(WORKED_CONVERSATION_SEQUENCES.length, 14);

  const eligibleCount = WORKED_CONVERSATION_SEQUENCES.filter((s) => s.outcome === "eligible")
    .length;
  const ineligibleCount = WORKED_CONVERSATION_SEQUENCES.filter((s) => s.outcome === "ineligible")
    .length;
  const undeterminedCount =
    WORKED_CONVERSATION_SEQUENCES.filter((s) => s.outcome === "undetermined")
      .length;

  assertEquals(eligibleCount, 4);
  assertEquals(ineligibleCount, 9);
  assertEquals(undeterminedCount, 1);

  for (const { sequence, expectedResult, outcome } of WORKED_CONVERSATION_SEQUENCES) {
    assertStringIncludes(
      skillText,
      `| ${sequence} | ${expectedResult} |`,
      `SKILL.md must document worked sequence: ${sequence}`,
    );
    assert(
      outcome === "eligible" || outcome === "ineligible" || outcome === "undetermined",
      `valid outcome for sequence: ${sequence}`,
    );
  }
});
