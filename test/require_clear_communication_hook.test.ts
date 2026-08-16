// require_clear_communication_hook.test.ts — web-jam-tools#531
//
// Exercises hooks/require-clear-communication.sh end-to-end by actually
// shelling out to it (Deno.Command) with a mocked Stop-hook payload on
// stdin (a transcript_path pointing at a fixture JSONL file we write per
// test) — same pattern as test/require_issue_citation_titles_hook.test.ts.
//
// This hook is BLOCKING: it exits 2 (not 0) and writes to stderr when it
// finds a violation, so these tests assert on exit code + stderr content.

import { assert, assertEquals } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/require-clear-communication.sh",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runHook(transcriptPath: string): Promise<RunResult> {
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

// deno-lint-ignore no-explicit-any
type TranscriptEntry = Record<string, any>;

function userTurn(text: string): TranscriptEntry {
  return { type: "user", message: { role: "user", content: text } };
}

function assistantText(
  text: string,
  opts: { isSidechain?: boolean; isApiErrorMessage?: boolean } = {},
): TranscriptEntry {
  return {
    type: "assistant",
    isSidechain: opts.isSidechain ?? false,
    ...(opts.isApiErrorMessage ? { isApiErrorMessage: true } : {}),
    message: {
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text }],
    },
  };
}

async function withFixtureTranscript(
  entries: TranscriptEntry[],
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/transcript.jsonl`;
  try {
    const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await Deno.writeTextFile(path, body);
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function assertBlocked(stderr: string) {
  assert(
    stderr.includes("BLOCKED (clear-communication guard)"),
    `expected BLOCKED message in stderr, got: ${stderr}`,
  );
}

// --- required case: two open questions → blocked, both named ---

Deno.test("a reply with two open questions is blocked and the denial names both", async () => {
  const entries = [
    userTurn("what should I do"),
    assistantText("Should I dispatch the Sonnet agent now? Should I also open the issue?"),
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 2);
    assertBlocked(res.stderr);
    assert(res.stderr.includes("Rule 1"));
    assert(res.stderr.includes("Should I dispatch the Sonnet agent now?"));
    assert(res.stderr.includes("Should I also open the issue?"));
  });
});

// Real-world shape: a second question tacked onto the close, with several
// lines of prose in between — not two questions side by side. Both must
// still be named so the rewrite is unambiguous.
Deno.test("a question followed by several lines of prose then a second question is blocked, both named", async () => {
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
  const entries = [userTurn("what should I do"), assistantText(text)];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 2);
    assertBlocked(res.stderr);
    assert(res.stderr.includes("Rule 1"));
    assert(res.stderr.includes("Should I dispatch the Sonnet agent now?"));
    assert(res.stderr.includes("Do you want me to go ahead and start it now?"));
  });
});

// --- required case: question followed by too much content → blocked ---

Deno.test("a question followed by more than the threshold of content is blocked", async () => {
  const text = "Should I proceed with the merge? " +
    "Here is a long paragraph of additional status content that follows the " +
    "question and should never have been placed after it, since a question " +
    "must be the last thing in the message according to rule 2 of this hook.";
  const entries = [userTurn("status?"), assistantText(text)];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 2);
    assertBlocked(res.stderr);
    assert(res.stderr.includes("Rule 2"));
  });
});

// --- required case: safety keyword outside the final section → blocked ---

Deno.test("a safety keyword buried outside the final section is blocked", async () => {
  const text = [
    "Noticed the prod credentials file was committed by mistake earlier today.",
    "",
    "Ran the full test suite locally, all green.",
    "",
    "Everything else looks fine and the PR is ready for review.",
  ].join("\n");
  const entries = [userTurn("status?"), assistantText(text)];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 2);
    assertBlocked(res.stderr);
    assert(res.stderr.includes("Rule 3"));
  });
});

// --- required case: more than one topic (section leads) in a long reply → blocked ---

function longFiller(sentences: number): string {
  return Array(sentences)
    .fill(
      "This is a filler sentence long enough to push the overall message past the length threshold.",
    )
    .join(" ");
}

Deno.test("a long reply with more than the threshold of section leads is blocked, all named", async () => {
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
  const entries = [userTurn("status?"), assistantText(text)];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 2);
    assertBlocked(res.stderr);
    assert(res.stderr.includes("Rule 4"));
    assert(res.stderr.includes("## Subagent result"));
    assert(res.stderr.includes("## Background dispatch"));
    assert(res.stderr.includes("## Decision needed"));
  });
});

Deno.test("a long reply with exactly two section leads (the boundary) is allowed", async () => {
  const text = [
    "## First section",
    longFiller(3),
    "",
    "## Second section",
    longFiller(3),
  ].join("\n");
  const entries = [userTurn("status?"), assistantText(text)];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
  });
});

Deno.test("a long bulleted queue of six items is one topic and is allowed", async () => {
  const text = [
    "- First queue item to check on Monday.",
    "- Second queue item, also worth checking.",
    "- Third queue item with a bit more detail than the others.",
    "- Fourth queue item.",
    "- Fifth queue item, last one before the sixth.",
    "- Sixth and final queue item, wrapping up the list nicely.",
    longFiller(3),
  ].join("\n");
  const entries = [userTurn("status?"), assistantText(text)];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
  });
});

Deno.test("a single long explanation with no section leads is allowed regardless of length", async () => {
  const text = longFiller(20);
  const entries = [userTurn("status?"), assistantText(text)];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
  });
});

Deno.test("a heading inside a fenced code block does not count toward section leads", async () => {
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
  const entries = [userTurn("status?"), assistantText(text)];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
  });
});

Deno.test("bold used mid-sentence for emphasis does not count toward section leads", async () => {
  const text = [
    "## Real section one",
    longFiller(3),
    "",
    "## Real section two",
    "This sentence uses **emphasis** in the middle, not as a label. " + longFiller(3),
  ].join("\n");
  const entries = [userTurn("status?"), assistantText(text)];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
  });
});

Deno.test("a markdown table's rows do not count toward section leads", async () => {
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
  const entries = [userTurn("status?"), assistantText(text)];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
  });
});

// --- required case: one trailing question is allowed ---

Deno.test("a reply with one trailing question is allowed", async () => {
  const entries = [userTurn("what should I do"), assistantText("Do you want me to proceed?")];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stderr.trim(), "");
  });
});

// --- required case: no question is allowed ---

Deno.test("a reply with no question is allowed", async () => {
  const entries = [userTurn("what happened"), assistantText("Everything is done, all green.")];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stderr.trim(), "");
  });
});

// --- false-positive cases: one test per case, per the issue ---

Deno.test("a fenced code block containing question marks does not trigger a block", async () => {
  const text = [
    "Run this:",
    "```sh",
    "curl 'https://example.com/status?ok=1'",
    "```",
    "Then tell me if it worked.",
  ].join("\n");
  const entries = [userTurn("how do I check"), assistantText(text)];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
  });
});

Deno.test("inline backticks containing a question mark do not trigger a block", async () => {
  const text = "Run `gh issue view 531 --repo WebJamApps/web-jam-tools --json title?` to check it.";
  const entries = [userTurn("how do I check"), assistantText(text)];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
  });
});

Deno.test("quoted text (a cited title) containing a question mark does not trigger a block", async () => {
  const text = 'Closed web-jam-tools#299 "Is this still needed?" today, so it is done.';
  const entries = [userTurn("status?"), assistantText(text)];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
  });
});

Deno.test("a URL query string containing a question mark does not trigger a block", async () => {
  const text = "See https://example.com/search?q=is+this+ok for details.";
  const entries = [userTurn("where"), assistantText(text)];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
  });
});

// --- transcript entry selection: must judge the CURRENT turn's real final message ---

Deno.test("an earlier violating assistant entry is ignored when the last entry is clean", async () => {
  const entries = [
    userTurn("do the thing"),
    assistantText("Should I do X? Should I do Y? Should I do Z?"), // would block if selected
    userTurn("just do X"),
    assistantText("Done."), // the actual last reply — clean
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stderr.trim(), "");
  });
});

Deno.test("a sidechain (subagent) assistant entry after the real reply is not judged", async () => {
  const entries = [
    userTurn("do the thing"),
    assistantText("Done."), // the real final reply to Josh — clean
    assistantText("Should I do X? Should I do Y? Should I do Z?", { isSidechain: true }), // subagent chatter
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stderr.trim(), "");
  });
});

Deno.test("an isApiErrorMessage entry after the real reply is not judged", async () => {
  const entries = [
    userTurn("do the thing"),
    assistantText("Done."), // the real final reply to Josh — clean
    assistantText("You've hit your session limit · resets 4:10pm (America/New_York)", {
      isApiErrorMessage: true,
    }),
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stderr.trim(), "");
  });
});

Deno.test("a sidechain entry is skipped even when it is the only assistant entry present", async () => {
  const entries = [
    userTurn("do the thing"),
    assistantText("Should I do X? Should I do Y?", { isSidechain: true }),
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
  });
});

// --- fail-open: unreadable/absent transcript stays silent, exit 0 ---

Deno.test("nonexistent transcript path stays silent, exit 0 (fail-open)", async () => {
  const res = await runHook("/nonexistent/path/does-not-exist.jsonl");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("invalid JSON on stdin stays silent, exit 0 (fail-open)", async () => {
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode("not valid json{{{"));
  await writer.close();
  const { code, stderr } = await child.output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
});

// --- turn boundary tests (web-jam-tools#596) ---

Deno.test("reproduces issue #596: previous turn contains clear-communication violation, current turn contains only tool-use -> allowed (exit 0)", async () => {
  const entries = [
    userTurn("first request"),
    assistantText("Should I do X? Should I do Y? Should I do Z?"), // violating text in previous turn
    userTurn("second request — current turn"),
    {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "tool_use", id: "t1", name: "Edit", input: {} }],
      },
    },
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stderr.trim(), "");
  });
});

Deno.test("current turn contains clear-communication violation followed by trailing tool-use -> blocked (exit 2)", async () => {
  const entries = [
    userTurn("first request"),
    assistantText("Clean first reply."),
    userTurn("second request — current turn"),
    assistantText("Should I dispatch the Sonnet agent now? Should I also open the issue?"),
    {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      },
    },
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 2);
    assertBlocked(res.stderr);
    assert(res.stderr.includes("Rule 1"));
    assert(res.stderr.includes("Should I dispatch the Sonnet agent now?"));
    assert(res.stderr.includes("Should I also open the issue?"));
  });
});

Deno.test("current turn contains entry with text block and trailing tool_use block -> blocked (exit 2)", async () => {
  const entries = [
    userTurn("second request — current turn"),
    {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "text",
            text: "Should I dispatch the Sonnet agent now? Should I also open the issue?",
          },
          { type: "tool_use", id: "t1", name: "Bash", input: {} },
        ],
      },
    },
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 2);
    assertBlocked(res.stderr);
    assert(res.stderr.includes("Rule 1"));
  });
});
