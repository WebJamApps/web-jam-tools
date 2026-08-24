// design_issue_gate2_needs_design_rule.test.ts — web-jam-tools#666
//
// Tests that skills/design-issue/SKILL.md specifies that Gate 2 approval authorizes
// Needs Design label removals listed in the approved plan, rather than requiring
// a separate round trip, and verifies that the superseded separate-ruling sentence is absent.

import { assert, assertFalse, assertStringIncludes } from "@std/assert";

const SKILL_MD_PATH = new URL("../skills/design-issue/SKILL.md", import.meta.url).pathname;

Deno.test("skills/design-issue/SKILL.md exists and can be read", async () => {
  const text = await Deno.readTextFile(SKILL_MD_PATH);
  assert(text.length > 0, "SKILL.md should not be empty");
});

Deno.test("skills/design-issue/SKILL.md specifies Gate 2 approval authorizes listed Needs Design removals", async () => {
  const text = await Deno.readTextFile(SKILL_MD_PATH);

  // Step 11: Gate 2 approval of the plan authorizes the `Needs Design` label removals listed in the plan
  assertStringIncludes(
    text,
    "Gate 2 approval of the plan authorizes the `Needs Design` label removals listed in the plan.",
  );

  // Two Approval Gates table: Gate 2 authorizes removing Needs Design labels listed in the approved plan
  assertStringIncludes(
    text,
    "authoriz",
  );
  assertStringIncludes(
    text,
    "removing the `Needs Design` labels listed in the approved plan",
  );

  // Removing subsection under The Needs Design Label: Gate 2 plan approval authorizes removals
  assertStringIncludes(
    text,
    "The plan presented at Gate 2 lists every `Needs Design` label to be removed, each with its 4 parts, every time:",
  );
  assertStringIncludes(
    text,
    "Gate 2 approval of the plan authorizes those removals, executed in the filing phase alongside the issues.",
  );
});

Deno.test("skills/design-issue/SKILL.md does NOT contain superseded separate-ruling sentence", async () => {
  const text = await Deno.readTextFile(SKILL_MD_PATH);

  // Superseded rule: "Approving the plan table does not approve label removals; each is ruled on separately."
  assertFalse(
    text.includes(
      "Approving the plan table does not approve label removals; each is ruled on separately",
    ),
    "SKILL.md must not contain the superseded separate-ruling sentence",
  );
});

Deno.test("skills/design-issue/SKILL.md retains 4-part removal structure and safety guardrails", async () => {
  const text = await Deno.readTextFile(SKILL_MD_PATH);

  // 4-part removal structure
  assertStringIncludes(text, '1. the issue, cited as `repo#number "title"`;');
  assertStringIncludes(
    text,
    "2. **why the design work that label asked for is now done** — naming the design document, the issues filed from it, and the specific stale body sections being rewritten (striking questions the design document answers, repointing design references, and reconciling scope);",
  );
  assertStringIncludes(text, "3. anything it did **not** resolve;");
  assertStringIncludes(text, "4. an actual question asking Josh to confirm.");

  // Unlisted labels and refusal guardrails
  assertStringIncludes(text, "An unlisted label is not approved and stays on.");
  assertStringIncludes(
    text,
    "The skill still never asserts a design is complete on its own",
  );
  assertStringIncludes(
    text,
    "still never removes a label that was not listed",
  );
  assertStringIncludes(
    text,
    "still never adds `Needs Design` to anything in the approved executable set",
  );
});
