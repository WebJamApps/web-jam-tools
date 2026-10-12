import { assert, assertEquals, assertRejects } from "@std/assert";
import { codexSkillCall, readCodexTypedSession } from "../hooks/lib/codex_session_reader.ts";
import { loadToken } from "../hooks/lib/check_issue_approval_token.ts";

const threadId = "12345678-1234-5678-abcd-123456789abc";
const writer = new URL("../scripts/write_issue_approval_token.ts", import.meta.url).pathname;
const meta = {
  id: threadId,
  source: "cli",
  originator: "codex-tui",
  thread_source: "user",
  parent_thread_id: null,
};

const sources = ["cli", "vscode"] as const;
const disallowedMetadata = [
  { source: "exec", originator: "codex_exec" },
  { source: "unknown" },
  { source: ["cli", "vscode"] },
  { source: undefined },
  { source: null },
  { source: 1 },
  { originator: "unknown" },
  { originator: undefined },
  { thread_source: "subagent", parent_thread_id: "parent" },
  { thread_source: { subagent: { parent_thread_id: "parent" } } },
  { thread_source: null },
  { parent_thread_id: "parent" },
  { parent_thread_id: false },
  { id: "other-thread" },
  { id: undefined },
];
const damages = [
  "missing",
  "duplicate",
  "malformed",
  "torn",
  "no metadata",
  "two metadata",
  "array metadata",
  "null metadata",
  "unreadable",
  "unknown user content",
  "damaged user text",
  "empty user content",
] as const;
type Damage = typeof damages[number];

function message(text: string, role = "user") {
  return {
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] },
  };
}

async function fixture(
  messages: unknown[],
  metadata: Record<string, unknown> = meta,
) {
  const home = await Deno.makeTempDir();
  const directory = `${home}/sessions/2026/10/11`;
  await Deno.mkdir(directory, { recursive: true });
  const path = `${directory}/rollout-test-${threadId}.jsonl`;
  await Deno.writeTextFile(
    path,
    [{ type: "session_meta", payload: metadata }, ...messages].map((record) =>
      JSON.stringify(record)
    ).join("\n") +
      "\n",
  );
  const env = (name: string) =>
    ({ CODEX_THREAD_ID: threadId, CODEX_HOME: home } as Record<string, string>)[name];
  return { home, path, env };
}

async function damageSession(f: Awaited<ReturnType<typeof fixture>>, damage: Damage) {
  switch (damage) {
    case "missing":
      await Deno.remove(f.path);
      break;
    case "duplicate":
      await Deno.copyFile(f.path, `${f.home}/sessions/another-${threadId}.jsonl`);
      break;
    case "malformed":
      await Deno.writeTextFile(f.path, "not json\n", { append: true });
      break;
    case "torn":
      await Deno.writeTextFile(f.path, '{"type":"response_item"', { append: true });
      break;
    case "no metadata":
      await Deno.writeTextFile(f.path, JSON.stringify(message("$file-issue")));
      break;
    case "two metadata":
      await Deno.writeTextFile(
        f.path,
        JSON.stringify({ type: "session_meta", payload: meta }),
        { append: true },
      );
      break;
    case "array metadata":
    case "null metadata":
      await Deno.writeTextFile(
        f.path,
        JSON.stringify({
          type: "session_meta",
          payload: damage === "array metadata" ? [meta] : null,
        }),
      );
      break;
    case "unreadable":
      await Deno.chmod(f.path, 0);
      break;
    case "unknown user content":
    case "damaged user text":
    case "empty user content":
      await Deno.writeTextFile(
        f.path,
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: damage === "empty user content" ? [] : [
              damage === "damaged user text"
                ? { type: "input_text", text: null }
                : { type: "mystery" },
            ],
          },
        }),
        { append: true },
      );
  }
}

async function cleanupFixture(f: Awaited<ReturnType<typeof fixture>>, damage?: Damage) {
  if (damage === "unreadable") await Deno.chmod(f.path, 0o600);
  await Deno.remove(f.home, { recursive: true });
}

Deno.test("Codex: only a leading typed skill is returned, with its full arguments", () => {
  assertEquals(codexSkillCall("  $design-issue plan\nmore "), {
    name: "design-issue",
    arguments: "plan\nmore",
    text: "  $design-issue plan\nmore ",
  });
  assertEquals(codexSkillCall("/webjam:FILE-ISSUE")?.name, "webjam:file-issue");
  assertEquals(codexSkillCall("$pr-review, please")?.name, "pr-review");
  assertEquals(codexSkillCall("please file it"), null);
  assertEquals(codexSkillCall("I quoted $file-issue"), null);
});

for (const source of sources) {
  Deno.test(`Codex ${source}: plain approval retains the latest skill; assistant/tool/event text is ignored`, async () => {
    const f = await fixture([
      message("$design-issue file the approved guards plan"),
      message("yes"),
      message("$pr-review", "assistant"),
      message("$pr-review", "tool"),
      { type: "event_msg", payload: { type: "user_message", message: "$pr-review" } },
    ], { ...meta, source });
    try {
      const read = await readCodexTypedSession({ env: f.env });
      assertEquals(read.threadId, threadId);
      assertEquals(read.path, f.path);
      assertEquals(read.latestSkillCall?.name, "design-issue");
      assertEquals(read.latestSkillCall?.arguments, "file the approved guards plan");
      await Deno.writeTextFile(f.path, JSON.stringify(message("$pr-review")) + "\n", {
        append: true,
      });
      assertEquals(
        (await readCodexTypedSession({ env: f.env })).latestSkillCall?.name,
        "pr-review",
      );
    } finally {
      await Deno.remove(f.home, { recursive: true });
    }
  });

  for (const change of disallowedMetadata) {
    Deno.test(`Codex ${source}: refuses untrusted ${Object.keys(change)} metadata ${JSON.stringify(change)}`, async () => {
      const f = await fixture([message("$file-issue")], { ...meta, source, ...change });
      try {
        await assertRejects(
          () => readCodexTypedSession({ env: f.env }),
          Error,
          "Not a supported human-started Codex session",
        );
      } finally {
        await Deno.remove(f.home, { recursive: true });
      }
    });
  }

  for (const damage of damages) {
    Deno.test(`Codex ${source}: refuses ${damage} session input`, async () => {
      const f = await fixture([message("$file-issue")], { ...meta, source });
      try {
        await damageSession(f, damage);
        await assertRejects(() => readCodexTypedSession({ env: f.env }));
      } finally {
        await cleanupFixture(f, damage);
      }
    });
  }
}

Deno.test("Codex: missing and invalid thread identity refuse before reading", async () => {
  await assertRejects(() => readCodexTypedSession({ env: () => undefined }), Error, "unset");
  await assertRejects(
    () => readCodexTypedSession({ env: () => "../other" }),
    Error,
    "not a session id",
  );
});

// Exercise the actual CLI on session-file fixtures, with no transcript override seam.
async function assertWriterResult(
  f: Awaited<ReturnType<typeof fixture>>,
  expected: number,
  args: string[] = [],
) {
  const tokenPath = `${f.home}/token.json`;
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    HOME: f.home,
    CODEX_HOME: f.home,
    CODEX_THREAD_ID: threadId,
  };
  delete env.WRITE_ISSUE_APPROVAL_TOKEN_TEST_TRANSCRIPT_PATH;
  delete env.WRITE_ISSUE_APPROVAL_TOKEN_TEST_CONVERSATION_ID;
  const result = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-write",
      writer,
      "--repo",
      "WebJamApps/JaMmusic",
      "--title",
      "Approved venue task",
      "--token-path",
      tokenPath,
      ...args,
    ],
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.code, expected, new TextDecoder().decode(result.stderr));
  const token = loadToken(tokenPath);
  if (expected === 0) {
    assert(token);
    assertEquals(token.session_id, threadId);
    assertEquals(token.repo, "WebJamApps/JaMmusic");
    assertEquals(token.titles, ["Approved venue task"]);
    assert(Date.parse(token.expires_at) > Date.now());
  } else {
    assertEquals(token, null);
    await assertRejects(() => Deno.stat(tokenPath), Deno.errors.NotFound);
  }
}

const typedCalls: [string, unknown[], string | null, number][] = [
  ["design", [message("$design-issue file the approved guards plan")], "design-issue", 0],
  ["file", [message("$file-issue")], "file-issue", 0],
  ["slash design", [message("/design-issue")], "design-issue", 0],
  ["slash file", [message("/file-issue")], "file-issue", 0],
  ["plugin dollar", [message("$webjam-tasks:file-issue")], "webjam-tasks:file-issue", 0],
  ["plugin slash", [message("/webjam-tasks:design-issue")], "webjam-tasks:design-issue", 0],
  ["plain approval", [message("$design-issue"), message("yes")], "design-issue", 0],
  [
    "non-user text after filing call",
    [
      message("$design-issue"),
      message("$pr-review", "assistant"),
      message("$pr-review", "tool"),
      { type: "event_msg", payload: { type: "user_message", message: "$pr-review" } },
    ],
    "design-issue",
    0,
  ],
  ["different skill", [message("$design-issue"), message("$pr-review")], "pr-review", 1],
  ["plain approval alone", [message("yes")], null, 1],
  ["prose", [message("please file it")], null, 1],
  ["quoted skill", [message("I quoted $file-issue")], null, 1],
  ["assistant", [message("$file-issue", "assistant")], null, 1],
  ["tool", [message("$file-issue", "tool")], null, 1],
  [
    "event",
    [{ type: "event_msg", payload: { type: "user_message", message: "$file-issue" } }],
    null,
    1,
  ],
  [
    "text with image",
    [{
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "$file-issue" }, { type: "input_image" }],
      },
    }],
    "file-issue",
    0,
  ],
];

for (const source of sources) {
  for (const [name, messages, expectedCall, expected] of typedCalls) {
    Deno.test(`Codex ${source} reader and writer CLI: ${name}`, async () => {
      const f = await fixture(messages, { ...meta, source });
      try {
        const read = await readCodexTypedSession({ env: f.env });
        assertEquals(read.latestSkillCall?.name ?? null, expectedCall);
        await assertWriterResult(f, expected);
      } finally {
        await cleanupFixture(f);
      }
    });
  }

  Deno.test(`Codex ${source}: absent optional provenance permits reader and writer CLI`, async () => {
    const f = await fixture([message("$file-issue")], {
      id: threadId,
      source,
      originator: "codex-tui",
    });
    try {
      assertEquals(
        (await readCodexTypedSession({ env: f.env })).latestSkillCall?.name,
        "file-issue",
      );
      await assertWriterResult(f, 0);
    } finally {
      await cleanupFixture(f);
    }
  });

  for (const change of disallowedMetadata) {
    Deno.test(`Codex ${source} writer CLI: refuses ${Object.keys(change)} metadata ${JSON.stringify(change)}`, async () => {
      const f = await fixture([message("$file-issue")], { ...meta, source, ...change });
      try {
        await assertWriterResult(f, 1);
      } finally {
        await cleanupFixture(f);
      }
    });
  }

  for (const damage of damages) {
    Deno.test(`Codex ${source} writer CLI: refuses ${damage} input`, async () => {
      const f = await fixture([message("$file-issue")], { ...meta, source });
      try {
        await damageSession(f, damage);
        await assertWriterResult(f, 1);
      } finally {
        await cleanupFixture(f, damage);
      }
    });
  }

  Deno.test(`Codex ${source} writer CLI: refuses a mismatched requested session id`, async () => {
    const f = await fixture([message("$file-issue")], { ...meta, source });
    try {
      await assertWriterResult(f, 1, ["--session-id", "87654321-4321-8765-abcd-987654321abc"]);
    } finally {
      await cleanupFixture(f);
    }
  });
}
