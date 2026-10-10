// test/design_issue_lint_doc_captured_rule.test.ts — web-jam-tools#1317
//
// A captured memory rule block (written byte for byte by consume_memory_rules.ts) is not the
// document's own prose, so lintDesignDoc must not apply any rule to it. A block the checker cannot
// parse is reported as captured-rule-block-malformed and exempts nothing (fail closed).

import { assertEquals } from "@std/assert";
import { lintDesignDoc } from "../src/design-issue/lint_doc.ts";
import {
  captureAndVerifyRulesInDesignDoc,
  capturedRuleEndMarker,
  capturedRuleStartMarker,
  parseCapturedRuleMarker,
} from "../scripts/consume_memory_rules.ts";

const START = "<!-- START_CAPTURED_RULE:my-rule -->";
const END = "<!-- END_CAPTURED_RULE:my-rule -->";
const CITE = "See web-jam-tools#1304 for details.";

// Text that would violate several rules if linted as the document's own prose.
const BAD_BODY = [
  CITE,
  "Status: Approved",
  "Gate 1: Approved",
  "## Revision History",
  "```",
  "unclosed fence",
].join("\n");

function doc(middle: string, tail = ""): string {
  return `# Title\n\n## What it is\nplain\n\n${middle}\n\n${tail}\n## Both surfaces\nParity across Claude Code, agy, and Codex`;
}

function rules(content: string): string[] {
  return lintDesignDoc(content, "t.md").violations.map((v) => v.rule);
}

function count(content: string, rule: string): number {
  return rules(content).filter((r) => r === rule).length;
}

const CITATION_RULE = "no-issue-citation-outside-exempt-locations";
const MALFORMED = "captured-rule-block-malformed";

Deno.test("well-formed block with banned content produces zero violations", () => {
  const withBlock = doc(`${START}\n${BAD_BODY}\n${END}`);
  const withoutBlock = doc("");
  assertEquals(rules(withBlock), rules(withoutBlock));
});

Deno.test("violation after the END marker keeps its correct line number", () => {
  const content = doc(`${START}\n${BAD_BODY}\n${END}`, "Gate 1: Approved\n");
  const lines = content.split("\n");
  const expected = lines.findLastIndex((l) => l === "Gate 1: Approved") + 1;
  const v = lintDesignDoc(content, "t.md").violations.filter((x) =>
    x.rule === "no-gate-or-approval-state"
  );
  assertEquals(v.length, 1);
  assertEquals(v[0].line, expected);
});

Deno.test("same text without the marker lines is linted as today", () => {
  const content = doc(BAD_BODY);
  assertEquals(count(content, CITATION_RULE) >= 1, true);
  assertEquals(count(content, "no-status-line") >= 1, true);
  assertEquals(count(content, "no-gate-or-approval-state") >= 1, true);
});

Deno.test("trailing whitespace on marker lines is ignored", () => {
  const content = doc(`${START}  \n${CITE}\n${END}\t`);
  assertEquals(count(content, CITATION_RULE), 0);
  assertEquals(count(content, MALFORMED), 0);
});

Deno.test("START with no END is malformed and the following text is linted", () => {
  const content = doc(`${START}\n${CITE}`);
  assertEquals(count(content, MALFORMED), 1);
  assertEquals(count(content, CITATION_RULE), 1);
});

Deno.test("START whose END has a different slug is malformed", () => {
  const content = doc(`${START}\n${CITE}\n<!-- END_CAPTURED_RULE:other -->`);
  // the unmatched START and the END with no open block are each reported
  assertEquals(count(content, MALFORMED), 2);
  assertEquals(count(content, CITATION_RULE), 1);
});

Deno.test("END with no open block is malformed", () => {
  const content = doc(`${CITE}\n${END}`);
  assertEquals(count(content, MALFORMED), 1);
  assertEquals(count(content, CITATION_RULE), 1);
});

Deno.test("START while another block is open is malformed and exempts nothing", () => {
  const content = doc(`${START}\n<!-- START_CAPTURED_RULE:inner -->\n${CITE}\n${END}`);
  assertEquals(count(content, MALFORMED), 1);
  assertEquals(count(content, CITATION_RULE), 1);
});

Deno.test("invalid-slug START inside an open block is reported and the block stays linted", () => {
  const content = doc(`${START}\n<!-- START_CAPTURED_RULE:../bad -->\n${CITE}\n${END}`);
  assertEquals(count(content, MALFORMED), 1);
  assertEquals(count(content, CITATION_RULE), 1);
});

Deno.test("invalid-slug END inside an open block is reported and the block stays linted", () => {
  const content = doc(`${START}\n${CITE}\n<!-- END_CAPTURED_RULE:../bad -->\n${END}`);
  assertEquals(count(content, MALFORMED), 1);
  assertEquals(count(content, CITATION_RULE), 1);
});

Deno.test("two nested START markers report one violation each", () => {
  const content = doc(
    `${START}\n<!-- START_CAPTURED_RULE:a -->\n<!-- START_CAPTURED_RULE:b -->\n${CITE}\n${END}`,
  );
  assertEquals(count(content, MALFORMED), 2);
  assertEquals(count(content, CITATION_RULE), 1);
});

Deno.test("a fenced START example inside a block is text, not a nested marker", () => {
  const content = doc(
    `${START}\n\`\`\`\n<!-- START_CAPTURED_RULE:example -->\n\`\`\`\n${CITE}\n${END}`,
  );
  assertEquals(count(content, MALFORMED), 0);
  assertEquals(count(content, CITATION_RULE), 0);
});

Deno.test("a fenced invalid-slug marker inside a block is text, not a marker", () => {
  const content = doc(
    `${START}\n~~~\n<!-- END_CAPTURED_RULE:../bad -->\n~~~\n${CITE}\n${END}`,
  );
  assertEquals(count(content, MALFORMED), 0);
  assertEquals(count(content, CITATION_RULE), 0);
});

Deno.test("parseCapturedRuleMarker recognises exactly what the writer's builders produce", () => {
  assertEquals(parseCapturedRuleMarker(capturedRuleStartMarker("my-rule")), {
    kind: "START",
    slug: "my-rule",
  });
  assertEquals(parseCapturedRuleMarker(`${capturedRuleEndMarker("my-rule")}  `), {
    kind: "END",
    slug: "my-rule",
  });
  assertEquals(parseCapturedRuleMarker(`x ${capturedRuleStartMarker("my-rule")}`), null);
  assertEquals(parseCapturedRuleMarker("plain text"), null);
});

Deno.test("whole-line marker with an invalid slug is malformed", () => {
  const content = doc(
    `<!-- START_CAPTURED_RULE:../bad -->\n${CITE}\n<!-- END_CAPTURED_RULE:../bad -->`,
  );
  assertEquals(count(content, MALFORMED) >= 1, true);
  assertEquals(count(content, CITATION_RULE), 1);
});

Deno.test("a marker that is not the whole line is not a marker", () => {
  const content = doc(`text ${START}\n${CITE}\ntext ${END}`);
  assertEquals(count(content, MALFORMED), 0);
  assertEquals(count(content, CITATION_RULE), 1);
});

Deno.test("START inside a fenced code block opens nothing", () => {
  const content = doc("```\n" + START + "\n```\n" + CITE);
  assertEquals(count(content, MALFORMED), 0);
  assertEquals(count(content, CITATION_RULE), 1);
});

Deno.test("round trip: captureAndVerifyRulesInDesignDoc output passes the citation rule", () => {
  const base = doc("");
  const { updatedContent, verifiedCount } = captureAndVerifyRulesInDesignDoc(base, [
    {
      slug: "venue-rule",
      sourceContent: `Rule text.\n\n${CITE}\n\nAlso web-jam-tools#1317 applies.\n`,
    },
  ]);
  assertEquals(verifiedCount, 1);
  assertEquals(count(updatedContent, CITATION_RULE), 0);
  assertEquals(count(updatedContent, MALFORMED), 0);
});
