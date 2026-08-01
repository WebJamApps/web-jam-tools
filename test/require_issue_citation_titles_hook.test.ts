// require_issue_citation_titles_hook.test.ts — web-jam-tools#311
//
// Exercises hooks/require-issue-citation-titles.sh end-to-end by actually
// shelling out to it (Deno.Command) with a mocked Stop-hook payload on
// stdin (a transcript_path pointing at a fixture JSONL file we write per
// test), the same shape Claude Code's hook runner feeds it — same pattern
// as test/opus_no_delegation_warning_hook.test.ts (re-implementing the
// shell/jq/python logic in TypeScript would test a copy, not the real
// hook).
//
// UNLIKE opus-no-delegation-warning.sh, this hook is BLOCKING: it exits 2
// (not 0) and writes to stderr when it finds a bare issue/PR citation, so
// these tests assert on exit code + stderr content, not stdout.

import { assert, assertEquals } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/require-issue-citation-titles.sh",
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

function assistantText(text: string): TranscriptEntry {
  return {
    type: "assistant",
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

function assertBlocked(stderr: string, ...tokens: string[]) {
  assert(
    stderr.includes("BLOCKED (issue-citation guard)"),
    `expected BLOCKED message in stderr, got: ${stderr}`,
  );
  assert(
    stderr.includes('repo#number "title"'),
    `expected the required format restated in stderr, got: ${stderr}`,
  );
  for (const tok of tokens) {
    assert(
      stderr.includes(tok),
      `expected offending token "${tok}" named in stderr, got: ${stderr}`,
    );
  }
}

// --- required case: bare #299 → blocked ---

Deno.test("a bare #299 is blocked and named in stderr", async () => {
  const entries = [userTurn("do the thing"), assistantText("See #299 for details.")];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 2);
    assertBlocked(res.stderr, "#299");
  });
});

// --- required case: full repo#299 "title" citation → allowed ---

Deno.test('a full web-jam-tools#299 "title" citation is allowed', async () => {
  const entries = [
    userTurn("do the thing"),
    assistantText(
      'Closed web-jam-tools#299 "Delete replaced labels org-wide, after migration" today.',
    ),
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stderr.trim(), "");
  });
});

// --- must-not-fire cases ---

Deno.test("a hex colour (#FEF2C0) is allowed", async () => {
  const entries = [userTurn("do the thing"), assistantText("Use #FEF2C0 for the background.")];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
  });
});

Deno.test("a digit-leading hex colour (#2563eb) is allowed", async () => {
  const entries = [userTurn("do the thing"), assistantText("Use #2563eb for the link color.")];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
  });
});

Deno.test("markdown headings (#, ##, ###) are allowed", async () => {
  const entries = [
    userTurn("do the thing"),
    assistantText("# Title\n## Subtitle\n### Sub-subtitle\nNo citations here."),
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
  });
});

Deno.test("a fenced code block containing #123 is allowed", async () => {
  const entries = [
    userTurn("do the thing"),
    assistantText(
      "Here's the command:\n```\n# shell comment #123 --limit 100\necho hi\n```\nDone.",
    ),
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
  });
});

Deno.test("an inline code span containing #123 is allowed", async () => {
  const entries = [
    userTurn("do the thing"),
    assistantText("Run `gh issue view #123 --json title` to check it."),
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
  });
});

// --- decision: milestone/ordinal parentheticals ARE flagged ---

Deno.test("a milestone/ordinal parenthetical (#2) is blocked (decision: not exempted)", async () => {
  const entries = [
    userTurn("do the thing"),
    assistantText("See milestone (#2) for the roadmap."),
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 2);
    assertBlocked(res.stderr, "#2");
  });
});

// --- required case: multiple violations in one message → ALL reported ---

Deno.test("multiple distinct violations in one message are ALL reported, not just the first", async () => {
  const entries = [
    userTurn("do the thing"),
    assistantText(
      "First #100 then web-jam-tools#200 bare (no title) and finally #300 to close.",
    ),
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 2);
    assertBlocked(res.stderr, "#100", "web-jam-tools#200", "#300");
  });
});

// --- required case: violation in the FINAL sentence (observed real-world pattern) ---

Deno.test("a violation in the closing sentence of an otherwise-clean message is blocked", async () => {
  const entries = [
    userTurn("do the thing"),
    assistantText(
      'Everything is fixed and web-jam-tools#299 "Delete replaced labels org-wide, after migration" ' +
        "is closed. Want me to dispatch #312?",
    ),
  ];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 2);
    assertBlocked(res.stderr, "#312");
  });
});

// --- fail-open: unreadable/absent transcript stays silent, exit 0 ---

Deno.test("nonexistent transcript path stays silent, exit 0 (fail-open)", async () => {
  const res = await runHook("/nonexistent/path/does-not-exist.jsonl");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("empty transcript_path stays silent, exit 0 (fail-open)", async () => {
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify({})));
  await writer.close();
  const { code, stderr } = await child.output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
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

Deno.test("a message with no assistant text blocks (e.g. only tool_use) stays silent, exit 0", async () => {
  const entries = [
    userTurn("do the thing"),
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
    assertEquals(res.code, 0, res.stderr);
  });
});

Deno.test("a clean message with no # tokens at all is allowed", async () => {
  const entries = [userTurn("do the thing"), assistantText("Nothing to see here, all done.")];
  await withFixtureTranscript(entries, async (path) => {
    const res = await runHook(path);
    assertEquals(res.code, 0, res.stderr);
  });
});
