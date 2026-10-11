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

Deno.test("Codex: plain approval retains the latest skill; assistant/tool/event text is ignored", async () => {
  const f = await fixture([
    message("$design-issue file the approved guards plan"),
    message("yes"),
    message("$pr-review", "assistant"),
    message("$pr-review", "tool"),
    { type: "event_msg", payload: { type: "user_message", message: "$pr-review" } },
  ]);
  try {
    const read = await readCodexTypedSession({ env: f.env });
    assertEquals(read.threadId, threadId);
    assertEquals(read.path, f.path);
    assertEquals(read.latestSkillCall?.name, "design-issue");
    assertEquals(read.latestSkillCall?.arguments, "file the approved guards plan");
    await Deno.writeTextFile(f.path, JSON.stringify(message("$pr-review")) + "\n", {
      append: true,
    });
    assertEquals((await readCodexTypedSession({ env: f.env })).latestSkillCall?.name, "pr-review");
  } finally {
    await Deno.remove(f.home, { recursive: true });
  }
});

for (
  const change of [
    { source: "exec", originator: "codex_exec" },
    { thread_source: "subagent", parent_thread_id: "parent" },
    { thread_source: { subagent: { parent_thread_id: "parent" } } },
    { parent_thread_id: "parent" },
    { source: "unknown" },
    { originator: "unknown" },
    { id: "other-thread" },
  ]
) {
  Deno.test(`Codex: refuses untrusted metadata ${JSON.stringify(change)}`, async () => {
    const f = await fixture([message("$file-issue")], { ...meta, ...change });
    try {
      await assertRejects(
        () => readCodexTypedSession({ env: f.env }),
        Error,
        "Not a human-started",
      );
    } finally {
      await Deno.remove(f.home, { recursive: true });
    }
  });
}

for (
  const damage of [
    "missing",
    "duplicate",
    "malformed",
    "torn",
    "no metadata",
    "two metadata",
    "unreadable",
    "unknown user content",
  ]
) {
  Deno.test(`Codex: refuses ${damage} session input`, async () => {
    const f = await fixture([message("$file-issue")]);
    try {
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
        case "unreadable":
          await Deno.chmod(f.path, 0);
          break;
        case "unknown user content":
          await Deno.writeTextFile(
            f.path,
            JSON.stringify({
              type: "response_item",
              payload: { type: "message", role: "user", content: [{ type: "mystery" }] },
            }),
            { append: true },
          );
      }
      await assertRejects(() => readCodexTypedSession({ env: f.env }));
    } finally {
      if (damage === "unreadable") await Deno.chmod(f.path, 0o600);
      await Deno.remove(f.home, { recursive: true });
    }
  });
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
for (
  const [name, texts, metadata, expected] of [
    ["design", ["$design-issue file the approved guards plan"], meta, 0],
    ["file", ["$file-issue"], meta, 0],
    ["plain approval", ["$design-issue", "yes"], meta, 0],
    ["different skill", ["$design-issue", "$pr-review"], meta, 1],
    ["prose", ["please file it"], meta, 1],
    ["exec", ["$file-issue"], { ...meta, source: "exec", originator: "codex_exec" }, 1],
    [
      "helper",
      ["$file-issue"],
      { ...meta, thread_source: "subagent", parent_thread_id: "parent" },
      1,
    ],
  ] as const
) {
  Deno.test(`Codex writer CLI: ${name}`, async () => {
    const f = await fixture(texts.map((text) => message(text)), metadata);
    const tokenPath = `${f.home}/token.json`;
    const env: Record<string, string> = {
      ...Deno.env.toObject(),
      CODEX_HOME: f.home,
      CODEX_THREAD_ID: threadId,
    };
    delete env.WRITE_ISSUE_APPROVAL_TOKEN_TEST_TRANSCRIPT_PATH;
    delete env.WRITE_ISSUE_APPROVAL_TOKEN_TEST_CONVERSATION_ID;
    try {
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
      }
    } finally {
      await Deno.remove(f.home, { recursive: true });
    }
  });
}
