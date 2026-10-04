/**
 * test/work_issue_codex_worklist.test.ts
 *
 * Unit tests verifying Codex surface integration, worklist handling,
 * and push commands across skills/work-issue and skills/draft-pr (web-jam-tools#1144).
 */

import { assert, assertFalse, assertStringIncludes } from "@std/assert";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const WORK_ISSUE_PATH = `${REPO_ROOT}skills/work-issue/SKILL.md`;
const DRAFT_PR_PATH = `${REPO_ROOT}skills/draft-pr/SKILL.md`;

Deno.test("work-issue: $work-issue on Codex with no issue named states no worklist and asks for named issue", async () => {
  const text = await Deno.readTextFile(WORK_ISSUE_PATH);

  // Must have a Codex branch in the No-argument mode section
  assertStringIncludes(text, "## No-argument mode — auto-pick worklist based on agent surface");

  // Literal case: states there is no Codex worklist and asks for named issue
  assertStringIncludes(text, "Codex ($work-issue session)");
  assertStringIncludes(text, "There is no Codex worklist");
  assertStringIncludes(text, "$work-issue <Repo>#<number>");

  // Literal case: does not attempt to read haiku-issues.md or flash-issues.md
  assertStringIncludes(
    text,
    "do not attempt to read `haiku-issues.md` or `flash-issues.md`",
  );

  // Resolution steps branch
  assertStringIncludes(
    text,
    "When running under **Codex**, there is no worklist: stop and answer that there is no Codex worklist file and ask Josh to name an issue directly (`$work-issue <Repo>#<number>`), per this Epic's design decision that Codex has no to-do file",
  );
});

Deno.test("skills/work-issue/SKILL.md names deno task push as the push step on every surface with raw git push absent", async () => {
  const text = await Deno.readTextFile(WORK_ISSUE_PATH);

  // Must name deno task push on every surface
  assertStringIncludes(
    text,
    "push the feature branch using `deno task push` on every surface (Claude Code, agy, and Codex alike)",
  );

  // Find Step 7 (the push step)
  const step7Match = text.match(
    /7\.\s+Do \*\*not\*\* switch branches[\s\S]*?(?=##|\n\n[0-9]+\.|$)/,
  );
  assert(step7Match, "Step 7 must exist in skills/work-issue/SKILL.md");
  const step7Text = step7Match[0];

  assertStringIncludes(step7Text, "deno task push");

  // Raw git push invocation must be absent from the push step
  assertFalse(
    /`git push/i.test(step7Text),
    "Step 7 push step must not invoke raw git push",
  );
  assertFalse(
    /\bgit push\b/.test(step7Text),
    "Step 7 push step must not contain raw git push command",
  );
});

Deno.test("skills/draft-pr/SKILL.md names deno task push as the push step on every surface with raw git push absent", async () => {
  const text = await Deno.readTextFile(DRAFT_PR_PATH);

  // Must name deno task push on every surface
  assertStringIncludes(
    text,
    "Push the branch through `deno task push` on every surface (Claude Code, agy, and Codex alike)",
  );

  // Find the "How to run it" section
  const howToRunMatch = text.match(/## How to run it[\s\S]*?(?=##|$)/);
  assert(howToRunMatch, "How to run it section must exist in skills/draft-pr/SKILL.md");
  const howToRunText = howToRunMatch[0];

  assertStringIncludes(howToRunText, "deno task push");

  // Raw git push invocation must be absent from the push step
  assertFalse(
    /`git push/i.test(howToRunText),
    "How to run it section must not invoke raw git push",
  );
  assertFalse(
    /\bgit push\b/.test(howToRunText),
    "How to run it section must not contain raw git push command",
  );
});

Deno.test("unattended Codex launch flags documented in both skills", async () => {
  const workIssueText = await Deno.readTextFile(WORK_ISSUE_PATH);
  const draftPrText = await Deno.readTextFile(DRAFT_PR_PATH);

  for (const [name, text] of [["work-issue", workIssueText], ["draft-pr", draftPrText]]) {
    assertStringIncludes(
      text,
      "--dangerously-bypass-hook-trust",
      `Expected ${name} to document --dangerously-bypass-hook-trust`,
    );
    assertStringIncludes(
      text,
      "WJT_UNATTENDED=1",
      `Expected ${name} to document WJT_UNATTENDED=1`,
    );
    assertStringIncludes(
      text,
      "Unattended Codex launches",
      `Expected ${name} to have an Unattended Codex launches section`,
    );
  }
});

Deno.test("surface roster and skill bodies include Codex", async () => {
  const workIssueText = await Deno.readTextFile(WORK_ISSUE_PATH);
  const draftPrText = await Deno.readTextFile(DRAFT_PR_PATH);

  // Both skills name Codex as a surface
  assertStringIncludes(workIssueText, "Codex");
  assertStringIncludes(draftPrText, "Codex");

  // Both skills mention Codex in their introduction
  assertStringIncludes(
    workIssueText,
    "# /work-issue — run a model-labeled coding task (Claude Code, Antigravity & Codex)",
  );
  assertStringIncludes(
    draftPrText,
    "Finish coding tasks across\nClaude Code, agy, and Codex by pushing through `deno task push`",
  );

  // Model tiers include Codex models
  assertStringIncludes(workIssueText, "Luna");
  assertStringIncludes(workIssueText, "Sol");
  assertStringIncludes(workIssueText, "Astra");
});
