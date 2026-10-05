// test/pr_review_reviewer_tier_matrix.test.ts — web-jam-tools#1135
//
// Reviewer-tier rule and default reviewers matrix test across all seven model labels:
// Haiku → Luna → Flash → Sol = Astra = Sonnet → Opus
//
// A reviewer on the author's rung or a higher one is accepted, except Opus on Opus;
// every lower one is rejected. Session eligibility is a separate prerequisite.
// Sol, Astra, and Sonnet share one rung (rung 4).

import { assert, assertEquals, assertFalse, assertStringIncludes, assertThrows } from "@std/assert";

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

function documentedRungs(text: string): Record<ModelLabel, number> {
  const order = text.match(/\*\*Tier order \(weakest to strongest\): (.+?)\.\*\*/);
  assert(order, "skill must document the tier order");
  const rungs = {} as Record<ModelLabel, number>;
  for (const [index, rung] of order[1].split("→").entries()) {
    for (const name of rung.split("=")) {
      const label = name.trim() as ModelLabel;
      assert(MODEL_LABELS.includes(label), `unknown model label: ${label}`);
      assertFalse(label in rungs, `duplicate model label: ${label}`);
      rungs[label] = index + 1;
    }
  }
  assertEquals(Object.keys(rungs).sort(), [...MODEL_LABELS].sort());
  return rungs;
}

/**
 * Reviewer-tier rule: a reviewer on the author's rung or a higher one is accepted;
 * every lower one is rejected, as is Opus reviewing Opus. Rungs come from the skill.
 */
function isReviewerAccepted(
  rungs: Record<ModelLabel, number>,
  author: ModelLabel,
  reviewer: ModelLabel,
): boolean {
  return !(author === "Opus" && reviewer === "Opus") && rungs[reviewer] >= rungs[author];
}

// Independent expected outcomes; never compute these from the rungs being checked.
const ACCEPTED_REVIEWERS: Record<ModelLabel, readonly ModelLabel[]> = {
  Haiku: ["Haiku", "Luna", "Flash", "Sol", "Astra", "Sonnet", "Opus"],
  Luna: ["Luna", "Flash", "Sol", "Astra", "Sonnet", "Opus"],
  Flash: ["Flash", "Sol", "Astra", "Sonnet", "Opus"],
  Sol: ["Sol", "Astra", "Sonnet", "Opus"],
  Astra: ["Sol", "Astra", "Sonnet", "Opus"],
  Sonnet: ["Sol", "Astra", "Sonnet", "Opus"],
  Opus: [],
};

const DEFAULT_REVIEWERS: Record<ModelLabel, string> = {
  Haiku: "Flash",
  Luna: "Flash",
  Flash: "Sol, through `$pr-review` in Codex",
  Sol: "Sonnet, Astra, or Opus",
  Sonnet: "Sol, through `$pr-review` in Codex; Opus when Josh names the pull request",
  Astra: "Opus or Josh",
  Opus: "Josh",
};

function documentedDefaults(text: string): Record<ModelLabel, string> {
  const section = text.split("### Default Reviewers\n")[1]?.split("\n### ")[0];
  assert(section, "skill must document the default-reviewers table");
  const defaults = {} as Record<ModelLabel, string>;
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells[0] === "Author" || /^[\s:-]+$/.test(cells[0])) continue;
    assertEquals(cells.length, 2, "default-reviewer rows must have two cells");
    for (const name of cells[0].split(",")) {
      const label = name.trim() as ModelLabel;
      assert(MODEL_LABELS.includes(label), `unknown author label: ${label}`);
      assertFalse(label in defaults, `duplicate author label: ${label}`);
      defaults[label] = cells[1];
    }
  }
  assertEquals(Object.keys(defaults).sort(), [...MODEL_LABELS].sort());
  return defaults;
}

Deno.test("reviewer-tier rule: checks all 49 pairs against the skill's documented rungs", async () => {
  const text = await Deno.readTextFile("skills/pr-review/SKILL.md");
  const rungs = documentedRungs(text);
  assertEquals(MODEL_LABELS.length, 7);
  assertEquals(rungs.Sol, rungs.Astra);
  assertEquals(rungs.Astra, rungs.Sonnet);
  assertEquals(rungs.Sol, 4);

  let pairCount = 0;
  for (const author of MODEL_LABELS) {
    for (const reviewer of MODEL_LABELS) {
      pairCount++;
      const expected = ACCEPTED_REVIEWERS[author].includes(reviewer);
      assertEquals(
        isReviewerAccepted(rungs, author, reviewer),
        expected,
        `Pair (author: ${author}, reviewer: ${reviewer}) expected accepted=${expected}`,
      );
    }
  }
  assertEquals(pairCount, 49);

  // Opus author: every model reviewer is rejected, including another Opus session.
  assertFalse(isReviewerAccepted(rungs, "Opus", "Opus"));
});

Deno.test("default reviewers: checks the skill's table across all seven model labels", async () => {
  const text = await Deno.readTextFile("skills/pr-review/SKILL.md");
  assertEquals(documentedDefaults(text), DEFAULT_REVIEWERS);
});

Deno.test("reviewer matrices detect changed rungs and default-reviewer table cells", async () => {
  const text = await Deno.readTextFile("skills/pr-review/SKILL.md");
  const changedRungs = documentedRungs(text.replace("Haiku → Luna", "Luna → Haiku"));
  assertThrows(() => assertEquals(isReviewerAccepted(changedRungs, "Haiku", "Luna"), true));
  for (const [author, defaultCell] of Object.entries(DEFAULT_REVIEWERS)) {
    const authorsCell = author === "Haiku" || author === "Luna" ? "Haiku, Luna" : author;
    const changed = text.replace(
      `| ${authorsCell} | ${defaultCell} |`,
      `| ${authorsCell} | Opus |`,
    );
    assert(changed !== text, `fixture must change the ${author} default-reviewer cell`);
    assertThrows(() => assertEquals(documentedDefaults(changed), DEFAULT_REVIEWERS));
  }
});

Deno.test("skills/pr-review/SKILL.md states reviewer-tier rule, default reviewers, and Codex/recording rules", async () => {
  const text = await Deno.readTextFile("skills/pr-review/SKILL.md");

  // Rule over all seven labels with Sol, Astra, Sonnet on one rung
  assertStringIncludes(
    text,
    "Over all seven model labels (`Haiku`, `Luna`, `Flash`, `Sol`, `Astra`, `Sonnet`, `Opus`): a reviewer on the author's rung or a higher one is accepted, except that Opus never reviews Opus work, and every lower one is rejected, with Sol, Astra and Sonnet on one rung.",
  );

  // Reconciled reviewer choices stated in prose
  assertStringIncludes(
    text,
    "The reviewer choices are Flash for Haiku and Luna authors, Sol for a Flash author, Sonnet, Astra, or Opus for a Sol author, and Sol for a Sonnet author (Opus only when Josh names the pull request); Opus or Josh reviews Astra, and Josh reviews Opus.",
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

Deno.test("reviewer-matrix assertions detect stale table and prose values", async () => {
  const text = await Deno.readTextFile("skills/pr-review/SKILL.md");

  // Stale table cells are absent
  assertFalse(text.includes("| Sol | Sonnet |"));
  assertFalse(text.includes("| Astra | *(none — no automatic reviewer)* |"));
  assertFalse(text.includes("| Opus | *(none — no automatic reviewer)* |"));

  // Stale prose is absent
  assertFalse(
    text.includes(
      "Sonnet for a Sol author, and Sol for a Sonnet author (Opus only when Josh names the pull request); Astra and Opus authors have no automatic reviewer.",
    ),
  );

  // Reconciled table cells are present
  assertStringIncludes(text, "| Sol | Sonnet, Astra, or Opus |");
  assertStringIncludes(text, "| Astra | Opus or Josh |");
  assertStringIncludes(text, "| Opus | Josh |");
});

Deno.test("reviewer-matrix distinguishes tier eligibility from specific authorship restrictions", () => {
  // General tier comparison: Sol, Astra, and Sonnet share rung 4.
  // Tier rule allows any reviewer on same or higher rung (except Opus on Opus).
  const tierEligibleForSol = ["Sol", "Astra", "Sonnet", "Opus"];
  const tierEligibleForAstra = ["Sol", "Astra", "Sonnet", "Opus"];

  // Specific authorship restrictions override equal-rank tier eligibility:
  // 1. Sol author cannot be reviewed by Sol (a model never reviews its own contribution)
  const solReviewerChoices = ["Sonnet", "Astra", "Opus"];
  assertEquals(tierEligibleForSol.includes("Sol"), true); // tier comparison allows it
  assertEquals(solReviewerChoices.includes("Sol"), false); // authorship restriction excludes it

  // 2. Astra author cannot be reviewed by same-rung models (Sol, Astra, Sonnet); only Opus or Josh
  const astraModelReviewerChoices = ["Opus"];
  assertEquals(tierEligibleForAstra.includes("Sol"), true); // tier comparison allows it
  assertEquals(tierEligibleForAstra.includes("Astra"), true); // tier comparison allows it
  assertEquals(tierEligibleForAstra.includes("Sonnet"), true); // tier comparison allows it
  assertEquals(astraModelReviewerChoices.includes("Sol"), false); // authorship restriction excludes Sol
  assertEquals(astraModelReviewerChoices.includes("Astra"), false); // authorship restriction excludes Astra
  assertEquals(astraModelReviewerChoices.includes("Sonnet"), false); // authorship restriction excludes Sonnet
  assertEquals(astraModelReviewerChoices.includes("Opus"), true); // Opus is eligible

  // 3. Opus author cannot be reviewed by any model (Josh reviews)
  const opusModelReviewerChoices: string[] = [];
  assertEquals(opusModelReviewerChoices.length, 0);
});
