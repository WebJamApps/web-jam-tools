// detect_clear_communication_violations_lib.test.ts — web-jam-tools#531
//
// Unit tests for the pure decision logic in
// hooks/lib/detect_clear_communication_violations.ts, exercised directly
// (no shelling out) — same pattern as
// test/check_dangerous_git_deploy_lib.test.ts. End-to-end coverage of the
// shell wrapper (stdin JSON in, exit code + stderr out) lives in
// test/require_clear_communication_hook.test.ts.

import { assert, assertEquals } from "@std/assert";
import {
  buildReport,
  DEFAULT_CONFIG,
  findMultipleQuestionViolations,
  findQuestionPositions,
  findSafetyKeywordViolations,
  findSectionLeads,
  findSectionLeadViolations,
  findTrailingContentViolation,
  loadConfig,
  stripNonProse,
} from "../hooks/lib/detect_clear_communication_violations.ts";

// --- rule 1: more than one open question ---

Deno.test("a single trailing question produces no rule-1 violation", () => {
  assertEquals(findMultipleQuestionViolations("Do you want me to proceed?"), []);
});

Deno.test("no question at all produces no rule-1 violation", () => {
  assertEquals(findMultipleQuestionViolations("Everything is done."), []);
});

Deno.test("two side-by-side questions are both named", () => {
  const violations = findMultipleQuestionViolations("Should I do X? Should I do Y?");
  assertEquals(violations.length, 2);
  assert(violations[0].includes("Should I do X?"));
  assert(violations[1].includes("Should I do Y?"));
});

// Real-world shape reported by Josh: a second question tacked onto the
// close with several lines of prose in between, not two questions side by
// side. Josh answers once and the reply is ambiguous by construction — this
// must be caught the same as the adjacent case, and BOTH questions named.
Deno.test("a question followed by lines of prose then a second question are both named (real-world shape)", () => {
  const text = [
    "Should I dispatch the Sonnet agent now?",
    "",
    "Here is what it will do: read the issue, set up a worktree, write the",
    "hook and its tests, run the full suite locally, and open a draft PR",
    "against dev with the real test output pasted into the body.",
    "",
    "It should take about twenty minutes end to end and touches only the",
    "hooks/, scripts/, and test/ directories in web-jam-tools.",
    "",
    "Do you want me to go ahead and start it now?",
  ].join("\n");
  const violations = findMultipleQuestionViolations(text);
  assertEquals(violations.length, 2);
  assert(
    violations[0].includes("Should I dispatch the Sonnet agent now?"),
    `expected first question named, got: ${violations[0]}`,
  );
  assert(
    violations[1].includes("Do you want me to go ahead and start it now?"),
    `expected second question named, got: ${violations[1]}`,
  );
});

// --- false positives that must NOT trigger rule 1 (or rule 2) ---

Deno.test("a question mark inside a fenced code block does not count", () => {
  const text = [
    "Run this:",
    "```sh",
    "curl 'https://example.com/status?ok=1'",
    "```",
    "Then tell me if it worked.",
  ].join("\n");
  assertEquals(findQuestionPositions(text), []);
});

Deno.test("a question mark inside inline backticks does not count", () => {
  const text =
    "Run `gh issue view 531 --repo WebJamApps/web-jam-tools --json title?` and check it.";
  assertEquals(findQuestionPositions(text), []);
});

Deno.test("a question mark inside double-quoted text (a cited title) does not count", () => {
  const text = 'Closed web-jam-tools#299 "Is this still needed?" today, so it is done.';
  assertEquals(findQuestionPositions(text), []);
});

Deno.test("a question mark inside a URL query string does not count", () => {
  const text = "See https://example.com/search?q=is+this+ok for details.";
  assertEquals(findQuestionPositions(text), []);
});

Deno.test("a question mark on a blockquote line does not count", () => {
  const text = "> did you mean to do this?\nNo, that was a typo, it's fixed now.";
  assertEquals(findQuestionPositions(text), []);
});

Deno.test("one real question plus a quoted/coded/URL question mark is still just one", () => {
  const text =
    'Closed web-jam-tools#299 "Is this still needed?" via https://example.com/x?y=1 — anything else?';
  const positions = findQuestionPositions(text);
  assertEquals(positions.length, 1);
});

// --- rule 2: trailing content after the LAST question ---

Deno.test("no trailing content after a single trailing question is not a violation", () => {
  const result = findTrailingContentViolation("Do you want me to proceed?", 80);
  assertEquals(result, null);
});

Deno.test("a short trailing clause under the threshold is not a violation", () => {
  const result = findTrailingContentViolation(
    "Does that work? Let me know.",
    80,
  );
  assertEquals(result, null);
});

Deno.test("a full paragraph after the question exceeds the threshold and is blocked", () => {
  const text = "Should I proceed with the merge? " +
    "Here is a long paragraph of additional status content that follows the " +
    "question and should never have been placed after it, since a question " +
    "must be the last thing in the message according to rule 2 of this hook.";
  const result = findTrailingContentViolation(text, 80);
  assert(result !== null);
  assert(result!.trailingChars > 80);
});

// Explicit "measure from the LAST question, not the first" case: a huge
// amount of prose sits BETWEEN an early question and the trailing one, but
// almost nothing follows the trailing one — must NOT be flagged, because
// rule 2 only measures content after the LAST surviving question mark.
Deno.test("threshold is measured from the LAST question, not the first, even with lots of content between them", () => {
  const text = [
    "Is the staging DB actually a copy of prod?",
    "",
    "Here is a long stretch of unrelated status prose that sits between the",
    "first question and the final one — several sentences describing what",
    "was checked, what changed, and what the plan is going forward, well",
    "over the eighty character threshold on its own, but this content comes",
    "BEFORE the last question mark, not after it, so it must not count",
    "against rule 2, which only looks at what follows the LAST question.",
    "",
    "Ready to proceed?",
  ].join("\n");
  // Sanity: this text does have 2 surviving questions (rule 1 territory);
  // rule 2 is tested here in isolation via the pure function.
  assertEquals(findQuestionPositions(text).length, 2);
  const result = findTrailingContentViolation(text, 80);
  assertEquals(result, null);
});

Deno.test("threshold is measured from the LAST question even when trailing content is added after it", () => {
  const text = [
    "Is the staging DB actually a copy of prod?",
    "",
    "Short filler.",
    "",
    "Ready to proceed?",
    "",
    "One more paragraph of status content was appended after the final",
    "question, which is exactly the shape rule 2 exists to catch, well",
    "past the configured eighty character threshold on its own.",
  ].join("\n");
  const result = findTrailingContentViolation(text, 80);
  assert(result !== null, "expected a violation when real content trails the last question");
});

Deno.test("a question mark inside a URL after the real question does not count as trailing content", () => {
  const text = "Ready to proceed? See https://example.com/status?ok=1 for context.";
  // The URL's '?' is stripped, so the LAST surviving question mark is the
  // real one; only "See ... for context." (stripped of the URL) trails it.
  const result = findTrailingContentViolation(text, 80);
  assertEquals(result, null);
});

// --- rule 3: safety keyword outside the final section ---

Deno.test("a single-paragraph message never triggers rule 3 (no 'outside' to be)", () => {
  const text = "The prod deploy is fine, no issues found.";
  assertEquals(findSafetyKeywordViolations(text, DEFAULT_CONFIG.safetyKeywords), []);
});

Deno.test("a safety keyword only in the final section is allowed", () => {
  const text = [
    "Ran the full test suite locally, all green.",
    "",
    "Also checked formatting and lint, both clean.",
    "",
    "One finding: the prod database connection string is still the old one.",
  ].join("\n");
  assertEquals(findSafetyKeywordViolations(text, DEFAULT_CONFIG.safetyKeywords), []);
});

Deno.test("a safety keyword buried in an earlier section (not the final one) is blocked", () => {
  const text = [
    "Noticed the prod credentials file was committed by mistake earlier today.",
    "",
    "Ran the full test suite locally, all green.",
    "",
    "Everything else looks fine and the PR is ready for review.",
  ].join("\n");
  const violations = findSafetyKeywordViolations(text, DEFAULT_CONFIG.safetyKeywords);
  assert(violations.length > 0);
  assert(violations.some((v) => v.keyword === "prod" || v.keyword === "credential"));
  assert(violations.every((v) => v.sectionIndex < v.totalSections));
});

Deno.test("a keyword inside a fenced code block in an earlier section is not blocked", () => {
  const text = [
    "```sh",
    "heroku config:get DATABASE_URL -a prod\n",
    "```",
    "",
    "That is the command I would run, but did not.",
  ].join("\n");
  assertEquals(findSafetyKeywordViolations(text, DEFAULT_CONFIG.safetyKeywords), []);
});

Deno.test("trailing blank lines do not create a bogus empty 'final section'", () => {
  const text = [
    "Found a credential leaked in the logs earlier in the session.",
    "",
    "That is now rotated and the PR is up.",
    "",
    "",
  ].join("\n");
  const violations = findSafetyKeywordViolations(text, DEFAULT_CONFIG.safetyKeywords);
  // The real final section is "That is now rotated and the PR is up." — the
  // earlier "credential" mention must still be flagged as not-final.
  assert(violations.length > 0);
  assert(violations.every((v) => v.totalSections === 2));
});

// --- rule 4: one topic per message (section leads) ---
//
// Default config: sectionLeadCountThreshold = 2 (must exceed 2, i.e. 3+
// leads to block), sectionLeadLengthThresholdChars = 400 (message must also
// be longer than this). Both conditions are required.

const COUNT_T = DEFAULT_CONFIG.sectionLeadCountThreshold;
const LEN_T = DEFAULT_CONFIG.sectionLeadLengthThresholdChars;

function longFiller(sentences: number): string {
  return Array(sentences)
    .fill(
      "This is a filler sentence long enough to push the overall message past the length threshold.",
    )
    .join(" ");
}

Deno.test("exactly the threshold count of headings (2) in a long reply is allowed (boundary)", () => {
  const text = [
    "## First section",
    longFiller(3),
    "",
    "## Second section",
    longFiller(3),
  ].join("\n");
  assert(text.length > LEN_T);
  assertEquals(findSectionLeadViolations(text, COUNT_T, LEN_T), []);
});

Deno.test("more than the threshold count of headings (3) in a long reply is blocked, all named", () => {
  const text = [
    "## First section",
    longFiller(3),
    "",
    "## Second section",
    longFiller(3),
    "",
    "## Third section",
    longFiller(3),
  ].join("\n");
  assert(text.length > LEN_T);
  const violations = findSectionLeadViolations(text, COUNT_T, LEN_T);
  assertEquals(violations.length, 3);
  assertEquals(violations, ["## First section", "## Second section", "## Third section"]);
});

Deno.test("bold-run labels that start a line count as section leads just like headings", () => {
  const text = [
    "**Subagent result:**",
    longFiller(3),
    "",
    "**Background dispatch:**",
    longFiller(3),
    "",
    "**Decision needed:**",
    longFiller(3),
  ].join("\n");
  assert(text.length > LEN_T);
  const violations = findSectionLeadViolations(text, COUNT_T, LEN_T);
  assertEquals(violations.length, 3);
});

Deno.test("three headings in a SHORT reply (under the length threshold) is allowed", () => {
  const text = "## A\nx\n\n## B\nx\n\n## C\nx";
  assert(text.length <= LEN_T);
  assertEquals(findSectionLeadViolations(text, COUNT_T, LEN_T), []);
});

// --- false positives that must NOT trigger rule 4 ---

Deno.test("a long bulleted list (6 items) is ONE topic, however long", () => {
  const text = [
    "- First queue item to check on Monday.",
    "- Second queue item, also worth checking.",
    "- Third queue item with a bit more detail than the others.",
    "- Fourth queue item.",
    "- Fifth queue item, last one before the sixth.",
    "- Sixth and final queue item, wrapping up the list nicely.",
  ].join("\n");
  assertEquals(findSectionLeads(text), []);
});

Deno.test("a long numbered list is ONE topic, however long", () => {
  const items = Array.from(
    { length: 6 },
    (_, i) => `${i + 1}. Numbered queue item number ${i + 1}, with enough text to add up.`,
  );
  const text = items.join("\n");
  assertEquals(findSectionLeads(text), []);
});

Deno.test("a single long explanation with no section leads is allowed regardless of length", () => {
  const text = longFiller(20);
  assert(text.length > LEN_T);
  assertEquals(findSectionLeadViolations(text, COUNT_T, LEN_T), []);
});

Deno.test("a heading-shaped line inside a fenced code block does not count as a section lead", () => {
  const text = [
    "## Real section one",
    longFiller(3),
    "",
    "## Real section two",
    longFiller(3),
    "",
    "```md",
    "### This looks like a heading but is inside a fenced code block",
    "```",
    longFiller(2),
  ].join("\n");
  assert(text.length > LEN_T);
  // If the fenced heading were miscounted, this would be 3 leads and block.
  assertEquals(findSectionLeadViolations(text, COUNT_T, LEN_T), []);
});

Deno.test("a heading/bold label quoted inside a blockquote does not count as a section lead", () => {
  const text = [
    "## Real section one",
    longFiller(3),
    "",
    "## Real section two",
    longFiller(3),
    "",
    "> ### Quoted heading from someone else's message",
    "> **Quoted bold label:** also not ours",
    longFiller(2),
  ].join("\n");
  assert(text.length > LEN_T);
  assertEquals(findSectionLeadViolations(text, COUNT_T, LEN_T), []);
});

Deno.test("bold used mid-sentence for emphasis is not a section lead", () => {
  const text = [
    "## Real section one",
    longFiller(3),
    "",
    "## Real section two",
    "This sentence uses **emphasis** in the middle, not as a label. " + longFiller(3),
  ].join("\n");
  assert(text.length > LEN_T);
  // If mid-sentence bold were miscounted as a lead, this would be 3 and block.
  assertEquals(findSectionLeadViolations(text, COUNT_T, LEN_T), []);
});

Deno.test("a markdown table's rows (and header) are not section leads", () => {
  const text = [
    "## Real section one",
    longFiller(3),
    "",
    "## Real section two",
    "| Name | Status |",
    "| --- | --- |",
    "| **Bold cell** | done |",
    "| Other | pending |",
    longFiller(3),
  ].join("\n");
  assert(text.length > LEN_T);
  assertEquals(findSectionLeadViolations(text, COUNT_T, LEN_T), []);
});

Deno.test("a bold-labeled list item never counts as a section lead", () => {
  const text = [
    "## Real section one",
    longFiller(3),
    "",
    "## Real section two",
    "- **Todo:** buy milk",
    "- **Todo:** rotate the leaked credential",
    "* **Also bold:** another item",
    longFiller(3),
  ].join("\n");
  assert(text.length > LEN_T);
  assertEquals(findSectionLeadViolations(text, COUNT_T, LEN_T), []);
});

Deno.test("findSectionLeads reports the exact trimmed lead text for headings and bold labels", () => {
  const text = "#Not a heading (no space)\n## Real Heading\n**Bold Label:** rest of line";
  assertEquals(findSectionLeads(text), ["## Real Heading", "**Bold Label:** rest of line"]);
});

// --- stripNonProse sanity (used by rules 1 and 2) ---

Deno.test("stripNonProse preserves text length (positions stay valid)", () => {
  const text =
    'See "is this ok?" at https://example.com/x?y=1 in `code?` and\n```\nfoo?\n```\ndone.';
  assertEquals(stripNonProse(text).length, text.length);
});

// --- config loading ---

Deno.test("loadConfig falls back to DEFAULT_CONFIG when the file does not exist", () => {
  const config = loadConfig("/nonexistent/path/clear-communication.yaml");
  assertEquals(config, DEFAULT_CONFIG);
});

Deno.test("loadConfig reads a real YAML file's threshold and keyword list", async () => {
  const dir = await Deno.makeTempDir();
  const yamlPath = `${dir}/clear-communication.yaml`;
  try {
    await Deno.writeTextFile(
      yamlPath,
      "trailing_content_threshold_chars: 5\nsafety_keywords:\n  - widget\n  - gadget\n",
    );
    const config = loadConfig(yamlPath);
    assertEquals(config.trailingContentThresholdChars, 5);
    assertEquals(config.safetyKeywords, ["widget", "gadget"]);
    // Rule 4 keys are absent from this YAML — must fall back to defaults,
    // not become undefined/NaN.
    assertEquals(config.sectionLeadCountThreshold, DEFAULT_CONFIG.sectionLeadCountThreshold);
    assertEquals(
      config.sectionLeadLengthThresholdChars,
      DEFAULT_CONFIG.sectionLeadLengthThresholdChars,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadConfig reads rule 4's section-lead count and length thresholds", async () => {
  const dir = await Deno.makeTempDir();
  const yamlPath = `${dir}/clear-communication.yaml`;
  try {
    await Deno.writeTextFile(
      yamlPath,
      "section_lead_count_threshold: 1\nsection_lead_length_threshold_chars: 10\n",
    );
    const config = loadConfig(yamlPath);
    assertEquals(config.sectionLeadCountThreshold, 1);
    assertEquals(config.sectionLeadLengthThresholdChars, 10);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadConfig falls back to defaults on malformed YAML", async () => {
  const dir = await Deno.makeTempDir();
  const yamlPath = `${dir}/clear-communication.yaml`;
  try {
    await Deno.writeTextFile(yamlPath, "not: [valid: yaml: at all");
    const config = loadConfig(yamlPath);
    assertEquals(config, DEFAULT_CONFIG);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- buildReport ---

Deno.test("buildReport is empty for a clean message", () => {
  assertEquals(buildReport("Everything is done, no issues found.", DEFAULT_CONFIG), "");
});

Deno.test("buildReport names all three rules when all three fire", () => {
  const text = [
    "There's a prod credential leaked in the logs — should I rotate it now?",
    "",
    "Also, separately, do you want me to open the PR too?",
    "",
    "Here is a closing paragraph of extra content after that second question,",
    "well past the configured trailing-content threshold on its own merits.",
  ].join("\n");
  const report = buildReport(text, DEFAULT_CONFIG);
  assert(report.includes("Rule 1"));
  assert(report.includes("Rule 2"));
  assert(report.includes("Rule 3"));
  assert(report.includes("at-most-one-open-question"));
  assert(report.includes("question-must-be-last"));
  assert(report.includes("safety-finding-must-be-final"));
});

Deno.test("buildReport names rule 4 and quotes every section lead when it fires", () => {
  const text = [
    "## Subagent result",
    longFiller(3),
    "",
    "## Background dispatch",
    longFiller(3),
    "",
    "## Decision needed",
    longFiller(3),
  ].join("\n");
  const report = buildReport(text, DEFAULT_CONFIG);
  assert(report.includes("Rule 4"));
  assert(report.includes("one-topic-per-message"));
  assert(report.includes('"## Subagent result"'));
  assert(report.includes('"## Background dispatch"'));
  assert(report.includes('"## Decision needed"'));
});
