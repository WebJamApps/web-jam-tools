// test/pr_review_reviewer_tier_matrix.test.ts — web-jam-tools#1135
//
// Reviewer-tier rule and default reviewers matrix test across all seven model labels:
// Haiku → Luna → Flash → Sol = Astra = Sonnet → Opus
//
// A reviewer on the author's rung or a higher one is accepted; every lower one is rejected.
// Sol, Astra, and Sonnet share one rung (rung 4).

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";

export const MODEL_LABELS = [
  "Haiku",
  "Luna",
  "Flash",
  "Sol",
  "Astra",
  "Sonnet",
  "Opus",
] as const;

export type ModelLabel = (typeof MODEL_LABELS)[number];

export const MODEL_RUNGS: Record<ModelLabel, number> = {
  Haiku: 1,
  Luna: 2,
  Flash: 3,
  Sol: 4,
  Astra: 4,
  Sonnet: 4,
  Opus: 5,
};

/**
 * Reviewer-tier rule: a reviewer on the author's rung or a higher one is accepted;
 * every lower one is rejected. Sol, Astra, and Sonnet share one rung.
 */
export function isReviewerAccepted(author: ModelLabel, reviewer: ModelLabel): boolean {
  return MODEL_RUNGS[reviewer] >= MODEL_RUNGS[author];
}

export const DEFAULT_REVIEWERS: Record<ModelLabel, string | null> = {
  Haiku: "Flash",
  Luna: "Flash",
  Flash: "Sol",
  Sol: "Sonnet",
  Sonnet: "Sol",
  Astra: null,
  Opus: null,
};

export function getDefaultReviewer(author: ModelLabel): string | null {
  return DEFAULT_REVIEWERS[author];
}

Deno.test("reviewer-tier rule: asserts all 49 author/reviewer pairs across the seven labels", () => {
  assertEquals(MODEL_LABELS.length, 7);
  assertEquals(MODEL_RUNGS.Sol, MODEL_RUNGS.Astra);
  assertEquals(MODEL_RUNGS.Astra, MODEL_RUNGS.Sonnet);
  assertEquals(MODEL_RUNGS.Sol, 4);

  let pairCount = 0;
  for (const author of MODEL_LABELS) {
    for (const reviewer of MODEL_LABELS) {
      pairCount++;
      const expected = MODEL_RUNGS[reviewer] >= MODEL_RUNGS[author];
      assertEquals(
        isReviewerAccepted(author, reviewer),
        expected,
        `Pair (author: ${author}, reviewer: ${reviewer}) expected accepted=${expected}`,
      );
    }
  }
  assertEquals(pairCount, 49);

  // Explicit verification per author rung
  // 1. Haiku author (rung 1): all 7 reviewers accepted
  for (const reviewer of MODEL_LABELS) {
    assert(
      isReviewerAccepted("Haiku", reviewer),
      `Haiku author should accept reviewer ${reviewer}`,
    );
  }

  // 2. Luna author (rung 2): Haiku rejected; Luna, Flash, Sol, Astra, Sonnet, Opus accepted
  assertFalse(isReviewerAccepted("Luna", "Haiku"));
  for (const reviewer of ["Luna", "Flash", "Sol", "Astra", "Sonnet", "Opus"] as const) {
    assert(
      isReviewerAccepted("Luna", reviewer),
      `Luna author should accept reviewer ${reviewer}`,
    );
  }

  // 3. Flash author (rung 3): Haiku, Luna rejected; Flash, Sol, Astra, Sonnet, Opus accepted
  assertFalse(isReviewerAccepted("Flash", "Haiku"));
  assertFalse(isReviewerAccepted("Flash", "Luna"));
  for (const reviewer of ["Flash", "Sol", "Astra", "Sonnet", "Opus"] as const) {
    assert(
      isReviewerAccepted("Flash", reviewer),
      `Flash author should accept reviewer ${reviewer}`,
    );
  }

  // 4. Shared rung authors (Sol, Astra, Sonnet - rung 4):
  // Haiku, Luna, Flash rejected; Sol, Astra, Sonnet, Opus accepted
  for (const sharedAuthor of ["Sol", "Astra", "Sonnet"] as const) {
    assertFalse(isReviewerAccepted(sharedAuthor, "Haiku"));
    assertFalse(isReviewerAccepted(sharedAuthor, "Luna"));
    assertFalse(isReviewerAccepted(sharedAuthor, "Flash"));
    assert(isReviewerAccepted(sharedAuthor, "Sol"));
    assert(isReviewerAccepted(sharedAuthor, "Astra"));
    assert(isReviewerAccepted(sharedAuthor, "Sonnet"));
    assert(isReviewerAccepted(sharedAuthor, "Opus"));
  }

  // 5. Opus author (rung 5): only Opus accepted, all others rejected
  for (const lowerReviewer of ["Haiku", "Luna", "Flash", "Sol", "Astra", "Sonnet"] as const) {
    assertFalse(
      isReviewerAccepted("Opus", lowerReviewer),
      `Opus author must reject lower reviewer ${lowerReviewer}`,
    );
  }
  assert(isReviewerAccepted("Opus", "Opus"));
});

Deno.test("default reviewers: asserts defaults across all seven model labels", () => {
  assertEquals(getDefaultReviewer("Haiku"), "Flash");
  assertEquals(getDefaultReviewer("Luna"), "Flash");
  assertEquals(getDefaultReviewer("Flash"), "Sol");
  assertEquals(getDefaultReviewer("Sol"), "Sonnet");
  assertEquals(getDefaultReviewer("Sonnet"), "Sol");
  assertEquals(getDefaultReviewer("Astra"), null);
  assertEquals(getDefaultReviewer("Opus"), null);
});

Deno.test("skills/pr-review/SKILL.md states reviewer-tier rule, default reviewers, and Codex/recording rules", async () => {
  const text = await Deno.readTextFile("skills/pr-review/SKILL.md");

  // Rule over all seven labels with Sol, Astra, Sonnet on one rung
  assertStringIncludes(
    text,
    "Over all seven model labels (`Haiku`, `Luna`, `Flash`, `Sol`, `Astra`, `Sonnet`, `Opus`): a reviewer on the author's rung or a higher one is accepted, and every lower one is rejected, with Sol, Astra and Sonnet on one rung.",
  );

  // Default reviewers stated in prose and table
  assertStringIncludes(
    text,
    "The default reviewers are Flash for Haiku and Luna authors, Sol for a Flash author, Sonnet for a Sol author, and Sol for a Sonnet author (Opus only when Josh names the pull request); Astra and Opus authors have no automatic reviewer.",
  );

  // Sol reviews on Codex & recording-day rules
  assertStringIncludes(
    text,
    "Sol reviews of Flash and Sonnet pull requests run through `/pr-review` (typed `$pr-review` in Codex).",
  );
  assertStringIncludes(
    text,
    "On a recording day or for any pull request Josh names, Sonnet reviews a Flash pull request instead, and a Sonnet pull request waits for Sol or goes to Opus when Josh names it.",
  );
  assertStringIncludes(
    text,
    "Astra is never picked as a reviewer unless Josh names it.",
  );
  assertStringIncludes(
    text,
    "An unattended Sol review launch passes `--dangerously-bypass-hook-trust` and sets `WJT_UNATTENDED=1`.",
  );
});
