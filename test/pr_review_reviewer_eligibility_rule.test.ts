import { assert, assertEquals, assertFalse, assertStringIncludes, assertThrows } from "@std/assert";

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
    sequence: "Sol writes → another model reviews → Luna fixes → Josh asks Sol to review",
    expectedResult:
      "Sol reviews the commits since that review and says its review covers only them",
    outcome: "eligible",
  },
  {
    sequence: "Sol writes → another model reviews → Sol and Luna both fix → Sol review requested",
    expectedResult: "Sol does not review; one commit in the range is its own",
    outcome: "ineligible",
  },
  {
    sequence: "Sol writes → no review yet → Luna fixes → Sol review requested",
    expectedResult: "Sol does not review; a first review covers every commit, Sol's included",
    outcome: "ineligible",
  },
  {
    sequence: "Sonnet writes → another model reviews → Sol fixes → Flash selected",
    expectedResult: "Refuse because the reviewer ranks below the author of a commit in the range",
    outcome: "ineligible",
  },
  {
    sequence: "Reviewed → branch rebased → review requested",
    expectedResult:
      "The reviewer reviews the whole pull request and says the rebase is why; eligibility covers every commit on it",
    outcome: "eligible",
  },
  {
    sequence:
      "Sol writes → another model reviews → Luna fixes → branch rebased → Sol review requested",
    expectedResult:
      "Sol does not review; the whole-PR review covers Sol's own commits, so Sol names the eligible reviewer choices",
    outcome: "ineligible",
  },
  {
    sequence: "A commit since the last review has no author the reviewer can establish",
    expectedResult: "Name the commit and ask Josh; do not guess",
    outcome: "undetermined",
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
    "Stop if the active model contributed implementation or pushed any fix in the review range",
  );
  assertStringIncludes(
    step1,
    "Permit Astra to review Sol-authored work, including a Sol fix from this same conversation",
  );
  assertStringIncludes(step1, "Never infer the active reviewer model from the PR author's footer");
  assertStringIncludes(
    step1,
    "Stop if the review range carries Astra contributions (implementation or fixes) and the active model is not Opus",
  );
  assertStringIncludes(
    step1,
    "Stop if any commit in the review range names an Opus author or co-author",
  );
  assertStringIncludes(
    step1,
    "Stop if the active model ranks below any contributor's tier in the review range",
  );
  assertStringIncludes(
    step1,
    "Stop and ask Josh if contributor or active model identity cannot be established",
  );

  // Old unconditional session ban is absent from Step 1
  assertFalse(step1.includes("Stop if this session wrote or pushed any commit on the PR."));
  assertFalse(
    step1.includes(
      "Stop if the active model contributed implementation or pushed any fix to the PR",
    ),
  );
  assertFalse(step1.includes("Stop if the PR carries Astra contributions"));
  assertStringIncludes(step1, "Session continuity alone never blocks review.");

  assert(
    step1.indexOf("**Reviewer eligibility is checked first.**") <
      step1.indexOf("1. Fetch PR details"),
    "the eligibility check must sit ahead of Step 1's numbered items",
  );
});

function assertWorkedSequences(skillText: string): void {
  for (const { sequence, expectedResult } of WORKED_CONVERSATION_SEQUENCES) {
    assertStringIncludes(
      skillText,
      `| ${sequence} | ${expectedResult} |`,
      `SKILL.md must document worked sequence: ${sequence}`,
    );
  }
}

Deno.test("skills/pr-review/SKILL.md covers all 21 worked sequences and three eligibility outcomes", async () => {
  const skillText = await Deno.readTextFile(SKILL_MD_PATH);
  assertEquals(WORKED_CONVERSATION_SEQUENCES.length, 21);

  const eligibleCount = WORKED_CONVERSATION_SEQUENCES.filter((s) => s.outcome === "eligible")
    .length;
  const ineligibleCount = WORKED_CONVERSATION_SEQUENCES.filter((s) => s.outcome === "ineligible")
    .length;
  const undeterminedCount =
    WORKED_CONVERSATION_SEQUENCES.filter((s) => s.outcome === "undetermined")
      .length;

  assertEquals(eligibleCount, 6);
  assertEquals(ineligibleCount, 13);
  assertEquals(undeterminedCount, 2);

  assertWorkedSequences(skillText);
  for (const { sequence, outcome } of WORKED_CONVERSATION_SEQUENCES) {
    assert(
      outcome === "eligible" || outcome === "ineligible" || outcome === "undetermined",
      `valid outcome for sequence: ${sequence}`,
    );
  }
});

Deno.test("skills/pr-review/SKILL.md scopes eligibility, attribution and diff to the review range", async () => {
  const skillText = await Deno.readTextFile(SKILL_MD_PATH);
  const pairing = between(skillText, "## Purpose & Model Pairing", "## Trigger & Invocation");
  const step1 = between(skillText, "### Step 1:", "### Step 2:");
  for (
    const rule of [
      "Eligibility is judged against the commits a review covers.",
      "A re-review covers the commits that arrived since the newest automated review",
      "A model that wrote earlier commits may review this later range when it wrote or pushed none of the contributions in it.",
      "A first review covers every commit, so the model that wrote the pull request is never its first reviewer.",
      "The review states the commit range it covers and that the earlier commits are outside it",
      "If a commit in the range is the reviewer's own, it does not review.",
      "If it cannot establish who wrote a commit in the range, it names that commit and asks Josh",
      "use that signed comment to establish the author of those fix commits",
      "A rebase replays a pull request's commits onto a newer base",
      "The reviewer does not stop or ask about the range.",
      "It reviews the whole pull request as it stands against its base",
      "Eligibility is then judged as for a first review, over the authors of every commit on the pull request.",
    ]
  ) assertStringIncludes(pairing, rule);
  assertStringIncludes(step1, "only automated reviews carrying");
  assertStringIncludes(step1, "the `## PR Review Summary` header set its start");
  assertStringIncludes(step1, "With no earlier automated review, the range is every PR commit.");
  assertStringIncludes(step1, "If the start cannot be established as an ancestor");
  assertStringIncludes(step1, "the reviewer does not stop or ask about the range");
  assertStringIncludes(step1, "reviews the whole pull request as it stands against its base");
  assertFalse(
    step1.includes("name the missing range evidence and ask Josh"),
    "Step 1 must not tell the reviewer to ask Josh about the range after a rebase",
  );
  assertFalse(
    skillText.includes("name the missing range evidence and ask Josh"),
    "skill must not tell the reviewer to ask Josh about the range after a rebase",
  );
  assertStringIncludes(step1, "For an unknown author, name the commit in the review range.");
  assertStringIncludes(
    step1,
    "state the exclusive start SHA and inclusive head SHA and that earlier commits are outside the review",
  );
  assertStringIncludes(
    step1,
    "For an incremental re-review (where `last_review_sha` is an ancestor of `head_sha`), fetch the diff",
  );
  assertStringIncludes(step1, "compare/<last_review_sha>...<head_sha>");
  assertStringIncludes(step1, "Limit findings and the review verdict to this range.");
  assertStringIncludes(
    step1,
    "For a re-review after a rebase (where `last_review_sha` is not an ancestor of `head_sha`), do not\n   fetch the `compare` diff; use the whole-PR diff (`gh pr diff <pr-num>`)",
  );
  assertStringIncludes(
    step1,
    "evaluate findings and the review",
  );
  assertStringIncludes(
    step1,
    "verdict across the whole pull request",
  );
  assert(
    step1.indexOf("Establish the review range") <
      step1.indexOf("Stop if the active model contributed"),
    "the range must be determined before the contributor restrictions are applied",
  );
});

Deno.test("skills/pr-review/SKILL.md routes rebased PRs through whole-PR diff and review output instead of incremental range", async () => {
  const skillText = await Deno.readTextFile(SKILL_MD_PATH);
  const step1 = between(skillText, "### Step 1:", "### Step 2:");
  const step3 = between(skillText, "### Step 3:", "### Step 4:");

  // Step 1 item 2: Already-reviewed check restricts incremental range to ancestor case
  assertStringIncludes(
    step1,
    "If new commits exist after the newest review and `last_review_sha` is an ancestor of `head_sha`",
  );
  assertStringIncludes(
    step1,
    "If `last_review_sha` is not an ancestor of `head_sha` (for example after a rebase), proceed with a whole-PR review against the base branch",
  );

  // Step 1 item 4: Diff fetching routes rebase to whole-PR diff
  assertStringIncludes(
    step1,
    "For an incremental re-review (where `last_review_sha` is an ancestor of `head_sha`), fetch the diff",
  );
  assertStringIncludes(
    step1,
    "For a re-review after a rebase (where `last_review_sha` is not an ancestor of `head_sha`), do not\n   fetch the `compare` diff; use the whole-PR diff (`gh pr diff <pr-num>`)",
  );
  assertStringIncludes(
    step1,
    "evaluate findings and the review",
  );
  assertStringIncludes(
    step1,
    "verdict across the whole pull request",
  );

  // Step 3: Changes Since Last Review separates incremental ancestor from rebased case
  assertStringIncludes(step3, "Incremental re-review (ancestor case)");
  assertStringIncludes(
    step3,
    "State `last_review_sha..head_sha` (exclusive start, inclusive end) and that earlier commits are outside this review and retain their previous review.",
  );
  assertStringIncludes(step3, "Rebased PR (non-ancestor case)");
  assertStringIncludes(
    step3,
    "State in one line that the branch was rebased after the review at `<last_review_sha>` and that this review therefore covers the whole pull request against its base (rather than stating an incremental range or excluding earlier commits).",
  );
});

Deno.test("removing any of the seven range cases from a scratch skill copy fails validation", async () => {
  const skillText = await Deno.readTextFile(SKILL_MD_PATH);
  const scratch = await Deno.makeTempFile({ suffix: ".md" });
  try {
    for (const { sequence, expectedResult } of WORKED_CONVERSATION_SEQUENCES.slice(13, 20)) {
      const row = `| ${sequence} | ${expectedResult} |`;
      assertStringIncludes(skillText, row);
      await Deno.writeTextFile(scratch, skillText.replace(row, ""));
      const damagedCopy = await Deno.readTextFile(scratch);
      assertThrows(() => assertWorkedSequences(damagedCopy), Error, sequence);
    }
  } finally {
    await Deno.remove(scratch);
  }
});

Deno.test("skills/pr-review/SKILL.md fails if the skill tells a reviewer to ask Josh about the range after a rebase", async () => {
  const skillText = await Deno.readTextFile(SKILL_MD_PATH);
  const step1 = between(skillText, "### Step 1:", "### Step 2:");

  assertFalse(
    step1.includes("name the missing range evidence and ask Josh"),
    "skill must not tell reviewer to ask Josh about the range after a rebase",
  );
  assertFalse(
    skillText.includes("name the missing range evidence and ask Josh"),
    "skill must not tell reviewer to ask Josh about the range after a rebase",
  );
  assertStringIncludes(
    step1,
    "the reviewer does not stop or ask about the range",
  );
});
