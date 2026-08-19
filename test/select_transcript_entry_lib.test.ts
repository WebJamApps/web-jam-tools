// select_transcript_entry_lib.test.ts — web-jam-tools#565
//
// Unit tests for hooks/lib/select_transcript_entry.ts covering entry selection,
// sidechain/apiErrorMessage exclusion behavior, text/model extraction,
// and CLI invocation modes.

import { assertEquals } from "@std/assert";
import {
  extractEntryModel,
  extractEntryText,
  getOpusGateInfo,
  isUserTurnBoundary,
  loadTranscript,
  parseTranscriptJsonl,
  selectLastAssistantEntry,
  selectLastUserEntry,
  selectSessionModel,
  type TranscriptEntry,
} from "../hooks/lib/select_transcript_entry.ts";

const SCRIPT_PATH = new URL(
  "../hooks/lib/select_transcript_entry.ts",
  import.meta.url,
).pathname;

function userEntry(text: string): TranscriptEntry {
  return {
    type: "user",
    message: { role: "user", content: text },
  };
}

function assistantEntry(
  textOrBlocks: string | Array<{ type: string; text?: string; [key: string]: unknown }>,
  opts: { isSidechain?: boolean; isApiErrorMessage?: boolean; model?: string } = {},
): TranscriptEntry {
  const content = typeof textOrBlocks === "string"
    ? [{ type: "text", text: textOrBlocks }]
    : textOrBlocks;

  return {
    type: "assistant",
    ...(opts.isSidechain !== undefined ? { isSidechain: opts.isSidechain } : {}),
    ...(opts.isApiErrorMessage !== undefined ? { isApiErrorMessage: opts.isApiErrorMessage } : {}),
    message: {
      role: "assistant",
      model: opts.model ?? "claude-sonnet-4-6",
      content,
    },
  };
}

// --- selectLastAssistantEntry tests ---

Deno.test("selectLastAssistantEntry: returns null on empty array", () => {
  assertEquals(selectLastAssistantEntry([]), null);
});

Deno.test("selectLastAssistantEntry: ignores non-assistant entries", () => {
  const entries: TranscriptEntry[] = [
    userEntry("hello"),
    { type: "tool_result", message: { role: "user", content: "ok" } },
  ];
  assertEquals(selectLastAssistantEntry(entries), null);
});

Deno.test("selectLastAssistantEntry: ignores entries with null or undefined content", () => {
  const entries: TranscriptEntry[] = [
    { type: "assistant", message: { role: "assistant", content: null as unknown as string } },
    { type: "assistant", message: { role: "assistant" } },
  ];
  assertEquals(selectLastAssistantEntry(entries), null);
});

Deno.test("selectLastAssistantEntry: selects the single genuine assistant entry", () => {
  const entry = assistantEntry("Real message");
  const entries = [userEntry("Hi"), entry];
  const selected = selectLastAssistantEntry(entries);
  assertEquals(selected, entry);
});

Deno.test("selectLastAssistantEntry: selects the most recent genuine assistant entry", () => {
  const entry1 = assistantEntry("First reply");
  const entry2 = assistantEntry("Second reply");
  const entries = [userEntry("1"), entry1, userEntry("2"), entry2];
  const selected = selectLastAssistantEntry(entries);
  assertEquals(selected, entry2);
});

Deno.test("selectLastAssistantEntry: excludes isSidechain: true entries", () => {
  const realEntry = assistantEntry("Main conversation reply");
  const sidechainEntry = assistantEntry("Subagent message", { isSidechain: true });
  const entries = [userEntry("start"), realEntry, sidechainEntry];

  const selected = selectLastAssistantEntry(entries);
  assertEquals(selected, realEntry);
});

Deno.test("selectLastAssistantEntry: excludes isApiErrorMessage: true entries", () => {
  const realEntry = assistantEntry("Real reply before API retry");
  const errorEntry = assistantEntry("You have hit your usage limit...", {
    isApiErrorMessage: true,
  });
  const entries = [userEntry("start"), realEntry, errorEntry];

  const selected = selectLastAssistantEntry(entries);
  assertEquals(selected, realEntry);
});

Deno.test("selectLastAssistantEntry: skips multiple trailing excluded entries to find the genuine entry", () => {
  const realEntry = assistantEntry("Genuine reply");
  const sidechain1 = assistantEntry("Subagent chatter 1", { isSidechain: true });
  const sidechain2 = assistantEntry("Subagent chatter 2", { isSidechain: true });
  const errorEntry = assistantEntry("Synthetic API error", { isApiErrorMessage: true });
  const entries = [userEntry("start"), realEntry, sidechain1, errorEntry, sidechain2];

  const selected = selectLastAssistantEntry(entries);
  assertEquals(selected, realEntry);
});

Deno.test("selectLastAssistantEntry: returns null when all assistant entries are excluded", () => {
  const entries = [
    userEntry("start"),
    assistantEntry("Subagent chatter", { isSidechain: true }),
    assistantEntry("API error", { isApiErrorMessage: true }),
  ];
  assertEquals(selectLastAssistantEntry(entries), null);
});

// --- isUserTurnBoundary tests ---

Deno.test("isUserTurnBoundary: identifies genuine user messages with string content", () => {
  assertEquals(isUserTurnBoundary(userEntry("hello")), true);
  assertEquals(
    isUserTurnBoundary({ type: "user", message: { role: "user", content: "hi" } }),
    true,
  );
});

Deno.test("isUserTurnBoundary: identifies genuine user messages with text content blocks", () => {
  const entry: TranscriptEntry = {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: "user prompt text" }],
    },
  };
  assertEquals(isUserTurnBoundary(entry), true);
});

Deno.test("isUserTurnBoundary: returns false for tool_result entries and content blocks", () => {
  assertEquals(
    isUserTurnBoundary({ type: "tool_result", message: { role: "user", content: "ok" } }),
    false,
  );
  const userWithToolResult: TranscriptEntry = {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "output" }],
    },
  };
  assertEquals(isUserTurnBoundary(userWithToolResult), false);
});

Deno.test("isUserTurnBoundary: returns false for sidechain and apiErrorMessage entries", () => {
  assertEquals(
    isUserTurnBoundary({
      type: "user",
      isSidechain: true,
      message: { role: "user", content: "hi" },
    }),
    false,
  );
  assertEquals(
    isUserTurnBoundary({
      type: "user",
      isApiErrorMessage: true,
      message: { role: "user", content: "err" },
    }),
    false,
  );
});

Deno.test("isUserTurnBoundary: returns false for non-user entries", () => {
  assertEquals(isUserTurnBoundary(null), false);
  assertEquals(isUserTurnBoundary(undefined), false);
  assertEquals(isUserTurnBoundary({ type: "assistant" }), false);
  assertEquals(isUserTurnBoundary({ type: "attachment" }), false);
  assertEquals(isUserTurnBoundary({ type: "queue-operation" }), false);
});

// --- turn boundary and text fallback tests (web-jam-tools#596) ---

Deno.test("selectLastAssistantEntry: never returns an entry from before the most recent user entry", () => {
  const prevTurnAssistant = assistantEntry("Previous turn reply with bare ref #299");
  const toolUseEntry = assistantEntry([{ type: "tool_use", id: "t1", name: "Edit", input: {} }]);
  const entries = [
    userEntry("Turn 1 prompt"),
    prevTurnAssistant,
    userEntry("Turn 2 prompt — current turn"),
    toolUseEntry,
  ];

  // In the current turn (Turn 2), the only assistant entry carries no text.
  // It must return null rather than reaching back into Turn 1.
  const selected = selectLastAssistantEntry(entries);
  assertEquals(selected, null);
});

Deno.test("selectLastAssistantEntry: falls back within the current turn to the last assistant entry that carries text", () => {
  const turn1Assistant = assistantEntry("Turn 1 text");
  const turn2AssistantText = assistantEntry("Turn 2 initial explanation of the plan");
  const turn2ToolUse = assistantEntry([{ type: "tool_use", id: "t1", name: "Edit", input: {} }]);

  const entries = [
    userEntry("Turn 1"),
    turn1Assistant,
    userEntry("Turn 2"),
    turn2AssistantText,
    turn2ToolUse,
  ];

  const selected = selectLastAssistantEntry(entries);
  assertEquals(selected, turn2AssistantText);
  assertEquals(extractEntryText(selected), "Turn 2 initial explanation of the plan");
});

Deno.test("selectLastAssistantEntry: selects the last text-bearing entry in a turn spanning multiple assistant text entries", () => {
  const text1 = assistantEntry("First assistant text in turn");
  const text2 = assistantEntry("Second assistant text in turn");
  const toolUse = assistantEntry([{ type: "tool_use", id: "t2", name: "Bash", input: {} }]);

  const entries = [
    userEntry("Turn prompt"),
    text1,
    text2,
    toolUse,
  ];

  const selected = selectLastAssistantEntry(entries);
  assertEquals(selected, text2);
  assertEquals(extractEntryText(selected), "Second assistant text in turn");
});

Deno.test("selectLastAssistantEntry: returns null when current turn contains no assistant text at all", () => {
  const toolUse1 = assistantEntry([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]);
  const toolUse2 = assistantEntry([{ type: "tool_use", id: "t2", name: "Edit", input: {} }]);

  const entries = [
    userEntry("Run some commands"),
    toolUse1,
    toolUse2,
  ];

  assertEquals(selectLastAssistantEntry(entries), null);
});

Deno.test("selectLastAssistantEntry: tool_result in current turn does not break turn boundary", () => {
  const text1 = assistantEntry("Starting work");
  const toolUse = assistantEntry([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]);
  const toolResultEntry: TranscriptEntry = {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "command output" }],
    },
  };
  const text2 = assistantEntry("Finishing work");

  const entries = [
    userEntry("Please work on task"),
    text1,
    toolUse,
    toolResultEntry,
    text2,
  ];

  const selected = selectLastAssistantEntry(entries);
  assertEquals(selected, text2);
  assertEquals(extractEntryText(selected), "Finishing work");
});

Deno.test("selectLastAssistantEntry: with requireText: false returns tool-use entry in current turn", () => {
  const toolUse = assistantEntry(
    [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
    { model: "claude-haiku-3-5" },
  );
  const entries = [userEntry("Run tool"), toolUse];

  const selected = selectLastAssistantEntry(entries, { requireText: false });
  assertEquals(selected, toolUse);
  assertEquals(extractEntryModel(selected), "claude-haiku-3-5");
});

// --- extractEntryText tests ---

Deno.test("extractEntryText: returns empty string for null or missing message", () => {
  assertEquals(extractEntryText(null), "");
  assertEquals(extractEntryText(undefined), "");
  assertEquals(extractEntryText({ type: "assistant" }), "");
});

Deno.test("extractEntryText: extracts string content", () => {
  const entry: TranscriptEntry = {
    type: "assistant",
    message: { role: "assistant", content: "Direct text string" },
  };
  assertEquals(extractEntryText(entry), "Direct text string");
});

Deno.test("extractEntryText: extracts and joins multiple text blocks with newlines", () => {
  const entry = assistantEntry([
    { type: "text", text: "Paragraph 1" },
    { type: "tool_use", id: "t1", name: "Bash", input: {} },
    { type: "text", text: "Paragraph 2" },
  ]);
  assertEquals(extractEntryText(entry), "Paragraph 1\nParagraph 2");
});

Deno.test("extractEntryText: returns empty string if content has no text blocks", () => {
  const entry = assistantEntry([
    { type: "tool_use", id: "t1", name: "Bash", input: {} },
  ]);
  assertEquals(extractEntryText(entry), "");
});

// --- extractEntryModel tests ---

Deno.test("extractEntryModel: extracts model identifier", () => {
  const entry = assistantEntry("text", { model: "claude-opus-4-6" });
  assertEquals(extractEntryModel(entry), "claude-opus-4-6");
});

Deno.test("extractEntryModel: returns empty string for missing or non-string model", () => {
  assertEquals(extractEntryModel(null), "");
  assertEquals(extractEntryModel({ type: "assistant" }), "");
  assertEquals(extractEntryModel({ type: "assistant", message: { role: "assistant" } }), "");
});

// --- parseTranscriptJsonl tests ---

Deno.test("parseTranscriptJsonl: parses JSON lines and skips malformed lines", () => {
  const jsonl = [
    JSON.stringify(userEntry("hello")),
    "not valid json {{{",
    "",
    "   ",
    JSON.stringify(assistantEntry("world")),
  ].join("\n");

  const parsed = parseTranscriptJsonl(jsonl);
  assertEquals(parsed.length, 2);
  assertEquals(parsed[0].type, "user");
  assertEquals(parsed[1].type, "assistant");
});

// --- loadTranscript tests ---

Deno.test("loadTranscript: loads from a temporary file", async () => {
  const dir = await Deno.makeTempDir();
  const filePath = `${dir}/transcript.jsonl`;
  try {
    const lines = [
      JSON.stringify(userEntry("input")),
      JSON.stringify(assistantEntry("output")),
    ].join("\n");
    await Deno.writeTextFile(filePath, lines);

    const loaded = await loadTranscript(filePath);
    assertEquals(loaded.length, 2);
    assertEquals(loaded[1].type, "assistant");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadTranscript: loads from JSON payload containing transcript_path", async () => {
  const dir = await Deno.makeTempDir();
  const filePath = `${dir}/transcript.jsonl`;
  try {
    const lines = [JSON.stringify(assistantEntry("payload text"))].join("\n");
    await Deno.writeTextFile(filePath, lines);

    const payload = JSON.stringify({ transcript_path: filePath });
    const loaded = await loadTranscript(payload);
    assertEquals(loaded.length, 1);
    assertEquals(extractEntryText(loaded[0]), "payload text");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadTranscript: returns empty array on nonexistent file", async () => {
  const loaded = await loadTranscript("/nonexistent/file/path/does-not-exist.jsonl");
  assertEquals(loaded, []);
});

// --- CLI execution tests ---

async function runCli(
  args: string[],
  stdinInput?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-read", SCRIPT_PATH, ...args],
    stdin: stdinInput !== undefined ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  if (stdinInput !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdinInput));
    await writer.close();
  }
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

Deno.test("CLI: --text prints extracted text for the last genuine assistant entry", async () => {
  const dir = await Deno.makeTempDir();
  const filePath = `${dir}/transcript.jsonl`;
  try {
    const lines = [
      JSON.stringify(userEntry("Question")),
      JSON.stringify(assistantEntry("Answer to question")),
      JSON.stringify(assistantEntry("Subagent response", { isSidechain: true })),
    ].join("\n");
    await Deno.writeTextFile(filePath, lines);

    const res = await runCli(["--text", filePath]);
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stdout.trim(), "Answer to question");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: --model prints model name for the last genuine assistant entry", async () => {
  const dir = await Deno.makeTempDir();
  const filePath = `${dir}/transcript.jsonl`;
  try {
    const lines = [
      JSON.stringify(assistantEntry("Real answer", { model: "claude-haiku-3-5" })),
      JSON.stringify(
        assistantEntry("Subagent answer", { isSidechain: true, model: "claude-opus-4-6" }),
      ),
    ].join("\n");
    await Deno.writeTextFile(filePath, lines);

    const res = await runCli(["--model", filePath]);
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stdout.trim(), "claude-haiku-3-5");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: --json prints raw JSON entry", async () => {
  const dir = await Deno.makeTempDir();
  const filePath = `${dir}/transcript.jsonl`;
  try {
    const real = assistantEntry("JSON reply");
    const lines = [
      JSON.stringify(real),
      JSON.stringify(assistantEntry("Synthetic error", { isApiErrorMessage: true })),
    ].join("\n");
    await Deno.writeTextFile(filePath, lines);

    const res = await runCli(["--json", filePath]);
    assertEquals(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout.trim());
    assertEquals(parsed.type, "assistant");
    assertEquals(parsed.message.content[0].text, "JSON reply");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: reads from stdin when no path argument is given", async () => {
  const lines = [
    JSON.stringify(userEntry("Hi")),
    JSON.stringify(assistantEntry("Stdin reply")),
  ].join("\n");

  const res = await runCli(["--text"], lines);
  assertEquals(res.code, 0, res.stderr);
  assertEquals(res.stdout.trim(), "Stdin reply");
});

Deno.test("CLI: fails open (exit 0, empty output) on missing file", async () => {
  const res = await runCli(["--text", "/path/that/does/not/exist.jsonl"]);
  assertEquals(res.code, 0, res.stderr);
  assertEquals(res.stdout.trim(), "");
});

Deno.test("CLI: --text returns empty when current turn contains only tool-use, never returning previous turn text", async () => {
  const dir = await Deno.makeTempDir();
  const filePath = `${dir}/transcript.jsonl`;
  try {
    const lines = [
      JSON.stringify(userEntry("Turn 1 prompt")),
      JSON.stringify(assistantEntry("Turn 1 assistant text referencing bare #123")),
      JSON.stringify(userEntry("Turn 2 prompt — current turn")),
      JSON.stringify(assistantEntry([{ type: "tool_use", id: "t1", name: "Edit", input: {} }])),
    ].join("\n");
    await Deno.writeTextFile(filePath, lines);

    const res = await runCli(["--text", filePath]);
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stdout.trim(), "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: --text returns earlier text within current turn when trailing entry is tool-use", async () => {
  const dir = await Deno.makeTempDir();
  const filePath = `${dir}/transcript.jsonl`;
  try {
    const lines = [
      JSON.stringify(userEntry("Turn 1 prompt")),
      JSON.stringify(assistantEntry("Turn 1 text")),
      JSON.stringify(userEntry("Turn 2 prompt")),
      JSON.stringify(assistantEntry("Turn 2 plan of action")),
      JSON.stringify(assistantEntry([{ type: "tool_use", id: "t1", name: "Bash", input: {} }])),
    ].join("\n");
    await Deno.writeTextFile(filePath, lines);

    const res = await runCli(["--text", filePath]);
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stdout.trim(), "Turn 2 plan of action");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- selectLastUserEntry tests ---

Deno.test("selectLastUserEntry: returns null on empty array", () => {
  assertEquals(selectLastUserEntry([]), null);
});

Deno.test("selectLastUserEntry: selects the most recent genuine user prompt, skipping trailing tool_result", () => {
  const user1 = userEntry("First user prompt");
  const user2 = userEntry("Second user prompt");
  const toolResultEntry: TranscriptEntry = {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "cmd output" }],
    },
  };
  const entries = [
    user1,
    assistantEntry("Reply 1"),
    user2,
    assistantEntry([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
    toolResultEntry,
  ];

  const selected = selectLastUserEntry(entries);
  assertEquals(selected, user2);
  assertEquals(extractEntryText(selected), "Second user prompt");
});

// --- selectSessionModel tests ---

Deno.test("selectSessionModel: returns model from latest genuine assistant entry", () => {
  const entries = [
    userEntry("prompt"),
    assistantEntry("reply", { model: "claude-opus-4-6" }),
    userEntry("second prompt"),
  ];
  assertEquals(selectSessionModel(entries), "claude-opus-4-6");
});

Deno.test("selectSessionModel: skips sidechain and api error messages across session", () => {
  const entries = [
    userEntry("prompt"),
    assistantEntry("reply", { model: "claude-opus-4-6" }),
    assistantEntry("subagent chatter", { isSidechain: true, model: "claude-haiku-3-5" }),
    assistantEntry("error", { isApiErrorMessage: true, model: "claude-haiku-3-5" }),
  ];
  assertEquals(selectSessionModel(entries), "claude-opus-4-6");
});

// --- getOpusGateInfo tests ---

Deno.test("getOpusGateInfo: detects model and escape phrase correctly", () => {
  const entries = [
    userEntry("please edit this file — opus edit ok"),
    assistantEntry("ok", { model: "claude-opus-4-6" }),
  ];
  const info = getOpusGateInfo(entries);
  assertEquals(info.model, "claude-opus-4-6");
  assertEquals(info.hasEscape, true);
  assertEquals(info.lastUserText, "please edit this file — opus edit ok");
});

Deno.test("getOpusGateInfo: reports hasEscape false when escape phrase is absent", () => {
  const entries = [
    userEntry("please edit this file directly"),
    assistantEntry("ok", { model: "claude-opus-4-6" }),
  ];
  const info = getOpusGateInfo(entries);
  assertEquals(info.model, "claude-opus-4-6");
  assertEquals(info.hasEscape, false);
});

// --- CLI --opus-gate tests ---

Deno.test("CLI: --opus-gate outputs JSON with model and escape phrase detection", async () => {
  const dir = await Deno.makeTempDir();
  const filePath = `${dir}/transcript.jsonl`;
  try {
    const lines = [
      JSON.stringify(userEntry("opus edit ok, update the file")),
      JSON.stringify(assistantEntry("processing", { model: "claude-opus-4-6" })),
    ].join("\n");
    await Deno.writeTextFile(filePath, lines);

    const res = await runCli(["--opus-gate", filePath]);
    assertEquals(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout.trim());
    assertEquals(parsed.model, "claude-opus-4-6");
    assertEquals(parsed.hasEscape, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
