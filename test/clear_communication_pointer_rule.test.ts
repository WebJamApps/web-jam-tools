// clear_communication_pointer_rule.test.ts — web-jam-tools#1825
// Exercises Rule 5 (pointing back at a pending decision) from
// hooks-design-2026-09-15.md ("Pointing back at a pending decision") through
// both the TypeScript detector and the Stop-hook shell entry point.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildReport,
  DEFAULT_CONFIG,
  findDecisionPointerViolations,
} from "../hooks/lib/detect_clear_communication_violations.ts";

const SCRIPT_PATH = new URL(
  "../hooks/require-clear-communication.sh",
  import.meta.url,
).pathname;

interface HookResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runStopHook(transcriptPath: string): Promise<HookResult> {
  const input = JSON.stringify({ transcript_path: transcriptPath });
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

async function withTranscript(replyText: string, fn: (path: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "cc-pointer-rule-" });
  const transcriptPath = `${dir}/transcript.jsonl`;
  try {
    const entries = [
      { type: "user", message: { role: "user", content: "what is the status?" } },
      {
        type: "assistant",
        isSidechain: false,
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: replyText }],
        },
      },
    ];
    await Deno.writeTextFile(
      transcriptPath,
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    await fn(transcriptPath);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

interface CaseRow {
  label: string;
  reply: string;
  expected: "refused" | "allowed";
  namedPhrase?: string;
}

const CASE_TABLE: CaseRow[] = [
  {
    label: "row 1: previous message + still needs your answer",
    reply: "Decision 7, my previous message, still needs your answer.",
    expected: "refused",
    namedPhrase: "previous message",
  },
  {
    label: "row 2: my last message",
    reply: "See my last message for the options.",
    expected: "refused",
    namedPhrase: "my last message",
  },
  {
    label: "row 3: earlier message",
    reply: "As in my earlier message, I recommend A.",
    expected: "refused",
    namedPhrase: "earlier message",
  },
  {
    label: "row 4: message above",
    reply: "The options are in the message above.",
    expected: "refused",
    namedPhrase: "message above",
  },
  {
    label: "row 5: see above",
    reply: "Details: see above.",
    expected: "refused",
    namedPhrase: "see above",
  },
  {
    label: "row 6: decision N still open within three words",
    reply: "Decision 3 is still open.",
    expected: "refused",
  },
  {
    label: "row 7: decision N still pending within three words",
    reply: "Decision 12 remains still pending.",
    expected: "refused",
  },
  {
    label: "row 8: still awaiting your answer",
    reply: "The plan still awaiting your answer is the Gate 2 plan.",
    expected: "refused",
    namedPhrase: "still awaiting your answer",
  },
  {
    label: "row 9: table above is allowed",
    reply: "The table above lists every row.",
    expected: "allowed",
  },
  {
    label: "row 10: above all is allowed",
    reply: "Above all, the clone stays on dev.",
    expected: "allowed",
  },
  {
    label: "row 11: decision laid out in full is allowed",
    reply:
      "Decision 7: where a consumed memory rule goes.\n\nBackground: every file stays in one place.\nOptions: keep in AGENTS.md or move to docs/rules/.\nRecommendation: move area-specific rules to docs/rules/.",
    expected: "allowed",
  },
  {
    label: "row 12: double-quoted phrase is exempt",
    reply: 'You wrote "see my previous message" yesterday.',
    expected: "allowed",
  },
  {
    label: "row 13: inline code phrase is exempt",
    reply: "Use `previous message` in the fixture only.",
    expected: "allowed",
  },
];

for (const row of CASE_TABLE) {
  Deno.test(`detector — ${row.label}`, () => {
    const violations = findDecisionPointerViolations(row.reply);
    const report = buildReport(row.reply, DEFAULT_CONFIG);
    if (row.expected === "refused") {
      assert(violations.length > 0, `expected Rule 5 violation for: ${row.reply}`);
      assertStringIncludes(report, "Rule 5");
      assertStringIncludes(report, "lay the decision out in full in this reply");
      if (row.namedPhrase) {
        assertStringIncludes(report.toLowerCase(), row.namedPhrase.toLowerCase());
      }
    } else {
      assertEquals(violations, []);
      assertEquals(report, "");
    }
  });

  Deno.test(`Stop hook — ${row.label}`, async () => {
    await withTranscript(row.reply, async (transcriptPath) => {
      const res = await runStopHook(transcriptPath);
      if (row.expected === "refused") {
        assertEquals(res.code, 2, `expected exit 2, got stdout=${res.stdout} stderr=${res.stderr}`);
        assertStringIncludes(res.stderr, "BLOCKED (clear-communication guard)");
        assertStringIncludes(res.stderr, "Rule 5");
        assertStringIncludes(res.stderr, "lay the decision out in full in this reply");
        if (row.namedPhrase) {
          assertStringIncludes(res.stderr.toLowerCase(), row.namedPhrase.toLowerCase());
        }
      } else {
        assertEquals(res.code, 0, `expected exit 0, got stderr=${res.stderr}`);
      }
    });
  });
}

Deno.test("row 14: unreadable transcript allows turn as existing rules do", async () => {
  const res = await runStopHook("/tmp/does-not-exist-cc-pointer-rule-1825.jsonl");
  assertEquals(res.code, 0, res.stderr);
  const body = JSON.parse(res.stdout.trim());
  assert(typeof body.systemMessage === "string" && body.systemMessage.length > 0);
});

Deno.test("exemptions and capitalisation: mixed case refused; blockquote, fenced code, and URL allowed; >3 words skipped", () => {
  const upperReport = buildReport("Details: SEE ABOVE.", DEFAULT_CONFIG);
  assertStringIncludes(upperReport, "Rule 5");
  assertStringIncludes(upperReport, "SEE ABOVE");

  assertEquals(
    findDecisionPointerViolations("> Quote from earlier: my previous message was wrong."),
    [],
  );
  assertEquals(
    findDecisionPointerViolations("```md\nsee above for details\n```"),
    [],
  );
  assertEquals(
    findDecisionPointerViolations("See https://example.com/previous-message for background."),
    [],
  );
  assertEquals(
    findDecisionPointerViolations(
      "Decision 4 was resolved two weeks ago while that PR is still open.",
    ),
    [],
  );
});

Deno.test("Codex Stop payload shape (last_assistant_message) enforces Rule 5 too", async () => {
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(
      JSON.stringify({ last_assistant_message: "See my last message for the options." }),
    ),
  );
  await writer.close();
  const { code, stderr } = await child.output();
  const errText = new TextDecoder().decode(stderr);
  assertEquals(code, 2, errText);
  assertStringIncludes(errText, "my last message");
  assertStringIncludes(errText, "lay the decision out in full in this reply");
});
