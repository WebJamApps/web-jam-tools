// opus_gate_lib.test.ts — web-jam-tools#965
//
// Unit tests for hooks/lib/opus_gate.ts (design decisions D-6 and D-7). Files are supplied through
// an in-memory ReadText so every path the gate reads is explicit; the CLI cases at the end run the
// module for real. End-to-end cases through the shell hook live in opus_delegation_gate_hook.test.ts.

import { assert, assertEquals } from "@std/assert";
import {
  approvesOpusSubagent,
  asksForOpusSubagent,
  decide,
  decideMainThreadEdit,
  decideSubagentEdit,
  findSpawningHumanPrompt,
  isOpusModel,
  type ReadText,
  readTextOrNull,
  resolveSessionFiles,
  resolveSubagentModel,
  slashCommandOf,
  workIssueApprovalActive,
} from "../hooks/lib/opus_gate.ts";
import { extractEntryText, type TranscriptEntry } from "../hooks/lib/select_transcript_entry.ts";

const MAIN = "/p/sess.jsonl";
const SUBAGENTS = "/p/sess/subagents";
const FILES = { mainTranscriptPath: MAIN, subagentsDir: SUBAGENTS };
const WORK_ISSUE =
  "<command-message>work-issue</command-message>\n<command-name>/work-issue</command-name>\n<command-args>web-jam-tools#965</command-args>";
const PR_REVIEW =
  "<command-message>pr-review</command-message>\n<command-name>/pr-review</command-name>";

function human(text: string): TranscriptEntry {
  return { type: "user", origin: { kind: "human" }, message: { role: "user", content: text } };
}

function notification(text: string): TranscriptEntry {
  return {
    type: "user",
    origin: { kind: "task-notification" },
    promptSource: "system",
    message: { role: "user", content: text },
  };
}

function metaEntry(text: string): TranscriptEntry {
  return { type: "user", isMeta: true, message: { role: "user", content: text } };
}

function assistant(model: string, extra: Record<string, unknown> = {}): TranscriptEntry {
  return {
    type: "assistant",
    message: { role: "assistant", model, content: [{ type: "text", text: "ok" }] },
    ...extra,
  };
}

function spawn(toolUseId: string): TranscriptEntry {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "tool_use", id: toolUseId, name: "Agent", input: {} }],
    },
  };
}

function jsonl(entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

function reader(files: Record<string, string>): ReadText {
  return (path) => (path in files ? files[path] : null);
}

function meta(id: string, fields: Record<string, unknown>): Record<string, string> {
  return { [`${SUBAGENTS}/agent-${id}.meta.json`]: JSON.stringify(fields) };
}

// --- small predicates ---

Deno.test("isOpusModel / asksForOpusSubagent / approvesOpusSubagent", () => {
  assert(isOpusModel("claude-opus-5"));
  assert(isOpusModel("opus"));
  assert(!isOpusModel("sonnet"));

  assert(asksForOpusSubagent("dispatch to an Opus subagent"));
  assert(asksForOpusSubagent("use opus sub-agents for this"));
  assert(!asksForOpusSubagent("opus is fine here"));
  assert(!asksForOpusSubagent("dispatch to a Sonnet subagent"));

  assert(approvesOpusSubagent("OK, opus edit ok, go"));
  assert(approvesOpusSubagent("spawn an Opus subagent"));
  assert(!approvesOpusSubagent("please fix it"));
});

Deno.test("resolveSessionFiles: main transcript and subagent transcript resolve to the same files", () => {
  assertEquals(resolveSessionFiles(MAIN), FILES);
  assertEquals(resolveSessionFiles(`${SUBAGENTS}/agent-abc.jsonl`), FILES);
  assertEquals(resolveSessionFiles("/p/sess.txt"), null);
  assertEquals(resolveSessionFiles("/subagents/agent-abc.jsonl"), null);
});

Deno.test("readTextOrNull: returns null for a missing file", () => {
  assertEquals(readTextOrNull("/nonexistent/opus-gate-test/file.jsonl"), null);
});

// --- subagent model ---

Deno.test("resolveSubagentModel: meta model wins; a non-model value falls back to the transcript", () => {
  const transcript = {
    [`${SUBAGENTS}/agent-a1.jsonl`]: jsonl([
      assistant("claude-sonnet-5", { isSidechain: true }),
      assistant("claude-opus-5", { isSidechain: true, isApiErrorMessage: true }),
    ]),
  };
  assertEquals(
    resolveSubagentModel(FILES, "a1", reader({ ...meta("a1", { model: "haiku" }) })),
    "haiku",
  );
  assertEquals(
    resolveSubagentModel(
      FILES,
      "a1",
      reader({ ...meta("a1", { model: "inherit" }), ...transcript }),
    ),
    "claude-sonnet-5",
  );
  assertEquals(resolveSubagentModel(FILES, "agent-a1", reader(transcript)), "claude-sonnet-5");
  assertEquals(
    resolveSubagentModel(FILES, "a1", reader({ [`${SUBAGENTS}/agent-a1.meta.json`]: "not json" })),
    "",
  );
  assertEquals(resolveSubagentModel(FILES, "a1", reader({})), "");
});

// --- spawning prompt ---

Deno.test("findSpawningHumanPrompt: depth-1 agent, nested agent, and every broken case", () => {
  const main = jsonl([
    human("dispatch to an Opus subagent"),
    notification("<task-notification>opus edit ok</task-notification>"),
    spawn("toolu_1"),
  ]);
  const files = {
    [MAIN]: main,
    ...meta("o1", { model: "opus", toolUseId: "toolu_1", parentAgentId: null }),
    ...meta("o2", { model: "opus", toolUseId: "toolu_nested", parentAgentId: "o1" }),
    ...meta("gone", { model: "opus", toolUseId: "toolu_x", parentAgentId: "missing" }),
    ...meta("loop1", { model: "opus", parentAgentId: "loop2" }),
    ...meta("loop2", { model: "opus", parentAgentId: "loop1" }),
    ...meta("orphan", { model: "opus", toolUseId: "toolu_not_there" }),
    ...meta("early", { model: "opus", toolUseId: "toolu_0" }),
  };

  assertEquals(
    extractEntryText(findSpawningHumanPrompt(FILES, "o1", reader(files))),
    "dispatch to an Opus subagent",
  );
  assertEquals(
    extractEntryText(findSpawningHumanPrompt(FILES, "o2", reader(files))),
    "dispatch to an Opus subagent",
  );
  assertEquals(findSpawningHumanPrompt(FILES, "gone", reader(files)), null);
  assertEquals(findSpawningHumanPrompt(FILES, "loop1", reader(files)), null);
  assertEquals(findSpawningHumanPrompt(FILES, "orphan", reader(files)), null);
  assertEquals(findSpawningHumanPrompt(FILES, "o1", reader({ ...files, [MAIN]: "" })), null);
  const { [MAIN]: _unused, ...withoutMain } = files;
  assertEquals(findSpawningHumanPrompt(FILES, "o1", reader(withoutMain)), null);
  assertEquals(
    findSpawningHumanPrompt(
      FILES,
      "early",
      reader({ ...files, [MAIN]: jsonl([spawn("toolu_0"), human("later")]) }),
    ),
    null,
  );
});

// --- slash commands and D-7 ---

Deno.test("slashCommandOf: wrapper form, bare form, and prose", () => {
  assertEquals(slashCommandOf(WORK_ISSUE), "work-issue");
  assertEquals(slashCommandOf("/work-issue web-jam-tools#965"), "work-issue");
  assertEquals(slashCommandOf("please run work-issue"), null);
});

Deno.test("workIssueApprovalActive: a human /work-issue stays active through plain messages until another slash command", () => {
  assert(
    workIssueApprovalActive([
      human(WORK_ISSUE),
      metaEntry("Base directory for this skill"),
      human("why?"),
    ]),
  );
  assert(!workIssueApprovalActive([human(WORK_ISSUE), human(PR_REVIEW)]));
  assert(
    !workIssueApprovalActive([human(WORK_ISSUE), {
      type: "user",
      message: { role: "user", content: "<command-name>/model</command-name>" },
    }]),
  );
  assert(!workIssueApprovalActive([metaEntry(WORK_ISSUE)]));
  assert(
    !workIssueApprovalActive([
      notification("<task-notification>done</task-notification>"),
      human("hello"),
    ]),
  );
  assert(!workIssueApprovalActive([]));
});

// --- decisions ---

Deno.test("decideMainThreadEdit: every outcome", () => {
  const at = (entries: TranscriptEntry[]) => reader({ [MAIN]: jsonl(entries) });

  assertEquals(decideMainThreadEdit("", reader({})).decision, "deny");
  assert(decideMainThreadEdit(MAIN, reader({})).why.includes("could not be read"));
  assert(decideMainThreadEdit(MAIN, at([human("hi")])).why.includes("could not be determined"));
  assertEquals(
    decideMainThreadEdit(MAIN, at([human("hi"), assistant("claude-sonnet-5")])).decision,
    "allow",
  );
  assertEquals(
    decideMainThreadEdit(MAIN, at([human("opus edit ok"), assistant("claude-opus-5")])).decision,
    "allow",
  );
  assertEquals(
    decideMainThreadEdit(MAIN, at([human(WORK_ISSUE), assistant("claude-opus-5")])).decision,
    "allow",
  );
  assertEquals(
    decideMainThreadEdit(
      MAIN,
      at([
        human("opus edit ok"),
        assistant("claude-opus-5"),
        notification("<task-notification>x</task-notification>"),
      ]),
    )
      .decision,
    "allow",
  );
  const plain = decideMainThreadEdit(
    MAIN,
    at([human("fix it"), assistant("claude-opus-5"), notification("opus edit ok")]),
  );
  assertEquals(plain, { decision: "deny", kind: "main", why: "" });
});

Deno.test("decideSubagentEdit: every outcome", () => {
  const main = jsonl([
    human("please fix it"),
    spawn("toolu_plain"),
    human("dispatch to an Opus subagent"),
    spawn("toolu_ok"),
  ]);
  const files = {
    [MAIN]: main,
    ...meta("s1", { model: "sonnet", toolUseId: "toolu_plain" }),
    ...meta("plain", { model: "opus", toolUseId: "toolu_plain" }),
    ...meta("ok", { model: "opus", toolUseId: "toolu_ok" }),
    ...meta("orphan", { model: "opus", toolUseId: "toolu_missing" }),
  };
  const read = reader(files);

  assert(decideSubagentEdit("s1", "", read).why.includes("could not be located"));
  assert(decideSubagentEdit("nobody", MAIN, read).why.includes("model could not be determined"));
  assertEquals(decideSubagentEdit("s1", MAIN, read).decision, "allow");
  assertEquals(decideSubagentEdit("ok", MAIN, read).decision, "allow");
  assertEquals(decideSubagentEdit("ok", `${SUBAGENTS}/agent-ok.jsonl`, read).decision, "allow");
  assert(decideSubagentEdit("plain", MAIN, read).why.includes("neither contains"));
  assert(decideSubagentEdit("orphan", MAIN, read).why.includes("could not be found"));
});

Deno.test("decide: routes auto-mode subagent calls, exempts other subagent calls, and decides main-thread calls", () => {
  const read = reader({ [MAIN]: jsonl([human("fix it"), assistant("claude-opus-5")]) });
  assertEquals(
    decide({ agent_id: "x", permission_mode: "auto", transcript_path: MAIN }, read).kind,
    "subagent",
  );
  assertEquals(decide({ agent_id: "x", permission_mode: "default", transcript_path: MAIN }, read), {
    decision: "allow",
    kind: "subagent",
    why: "",
  });
  assertEquals(decide({ transcript_path: MAIN }, read), {
    decision: "deny",
    kind: "main",
    why: "",
  });
  assertEquals(decide({}, read).decision, "deny");
});

// --- CLI ---

async function runCli(stdin: string): Promise<Record<string, unknown>> {
  const child = new Deno.Command("deno", {
    args: [
      "run",
      "--no-config",
      "--allow-read",
      new URL("../hooks/lib/opus_gate.ts", import.meta.url).pathname,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(stdin));
  await writer.close();
  const { stdout } = await child.output();
  return JSON.parse(new TextDecoder().decode(stdout));
}

Deno.test("CLI: prints a decision for a payload and fails closed on unreadable stdin", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const transcript = `${dir}/sess.jsonl`;
    await Deno.writeTextFile(transcript, jsonl([human(WORK_ISSUE), assistant("claude-opus-5")]));
    assertEquals((await runCli(JSON.stringify({ transcript_path: transcript }))).decision, "allow");
    assertEquals(await runCli("not json"), {
      decision: "deny",
      kind: "main",
      why: "The hook payload could not be read.",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
