// opus_gate_lib.test.ts — web-jam-tools#965
//
// Unit tests for hooks/lib/opus_gate.ts (design decisions D-6 and D-7). Files are supplied through
// an in-memory ReadText and labels through an in-memory LabelLookup, so every input the gate reads
// is explicit; the gh and CLI cases at the end run the real code. End-to-end cases through the shell
// hook live in opus_delegation_gate_hook.test.ts.

import { assert, assertEquals } from "@std/assert";
import {
  approvesOpusSubagent,
  asksForOpusSubagent,
  asksOpusToDoTheWork,
  createLabelLookup,
  decide,
  decideMainThreadEdit,
  decideSubagentEdit,
  findSpawningHumanPrompt,
  isOpusModel,
  isReadOnlyQuotedWrite,
  type IssueRef,
  LABEL_CACHE_TTL_MS,
  type LabelLookup,
  parseIssueRef,
  parseLabelsJson,
  type ReadText,
  readTextOrNull,
  resolveSessionFiles,
  resolveSubagentModel,
  runGhLabels,
  singleSimpleCommandTokens,
  slashCommandOf,
  workIssueApprovalActive,
  workIssueArgs,
} from "../hooks/lib/opus_gate.ts";
import { extractEntryText, type TranscriptEntry } from "../hooks/lib/select_transcript_entry.ts";

const MAIN = "/p/sess.jsonl";
const SUBAGENTS = "/p/sess/subagents";
const FILES = { mainTranscriptPath: MAIN, subagentsDir: SUBAGENTS };

function workIssue(args: string): string {
  return `<command-message>work-issue</command-message>\n<command-name>/work-issue</command-name>\n<command-args>${args}</command-args>`;
}

// Issue 1 is Opus-labeled, 2 Sonnet-labeled, 3 Fable-labeled; anything else fails to look up.
const OPUS_ISSUE = workIssue("web-jam-tools#1");
const SONNET_ISSUE = workIssue("web-jam-tools#2");
const PR_REVIEW =
  "<command-message>pr-review</command-message>\n<command-name>/pr-review</command-name>";

const labels: LabelLookup = (ref) =>
  ({ 1: ["Opus", "Bug"], 2: ["Sonnet"], 3: ["Fable"] } as Record<number, string[]>)[ref.number] ??
    null;

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

// --- D-8 ---

Deno.test("asksOpusToDoTheWork: only an instruction naming Opus approves; complaints and bare mentions fail closed", () => {
  const approves = [
    "please use OPUS to fix https://github.com/WebJamApps/web-jam-tools/pull/968 and also post a comment on it from OPUS when done",
    "use Opus to fix it",
    "have Opus fix it",
    "let an Opus agent do it",
    "Please, use Opus",
    "fix it now. use Opus",
    "don't use Sonnet, use Opus",
    "ok and have Opus do it",
  ];
  for (const text of approves) assert(asksOpusToDoTheWork(text), text);

  const refuses = [
    "don't use Opus",
    "don’t use Opus",
    "don't  use Opus",
    "do not use opus",
    "please don't use opus",
    "never have Opus edit",
    "I told you not to use Opus",
    "no need to use Opus here",
    "why did you use Opus for this? delegate to Sonnet",
    "you shouldn't use Opus for mechanical work",
    "stop using Opus",
    "the problem with Opus is cost",
    "fix it with Opus",
    "using opus for this",
    "Opus ate my tokens, did not delegate to Sonnet",
    "use Sonnet not Opus",
    "opus is fine here",
    "for OPUS please https://github.com/WebJamApps/web-jam-tools/pull/972",
  ];
  for (const text of refuses) assert(!asksOpusToDoTheWork(text), text);

  assert(approvesOpusSubagent("please use OPUS to fix it"));
});

Deno.test("asksOpusToDoTheWork: a routing instruction to Opus that opens a clause approves; a complaint, question, negation or statement refuses", () => {
  const approves = [
    // Josh's real message that was wrongly refused (web-jam-tools PR 1000 follow-up):
    "send the PR 1000 fix to OPUS !  this is the THIRD time I have said this what is going on !!!!!!!?",
    "dispatch this to Opus",
    "dispatch to Opus",
    "send it to opus",
    "please send it to Opus",
    "yes, give this to Opus",
    "hand the fix to Opus",
    "assign it to opus",
    "route this to Opus",
    "ok and send it to the Opus agent",
    "please use OPUS to fix this",
    "let Opus do it",
  ];
  for (const text of approves) assert(asksOpusToDoTheWork(text), text);

  const refuses = [
    // An instruction reported second-hand has the same shape as a complaint, so it fails closed:
    "hi i asked you earlier to dispatch to Opus to fix this and you seem to have ignored me !?  https://github.com/WebJamApps/web-jam-tools/pull/1000",
    // Complaints and questions, with or without a "?":
    "why did you use Opus",
    "why did you send this to Opus",
    "who told you to dispatch this to Opus",
    "should we send this to Opus",
    "did you dispatch it to Opus and why",
    "did you send it to Opus?",
    "should we send this to Opus?",
    "send it to Opus?",
    // Negations, including contractions and a negated object:
    "don't send this to Opus",
    "do not dispatch to opus",
    "please don't send it to Opus",
    "you shouldn't send this to Opus",
    "I didn't send it to Opus",
    "you won't send it to opus",
    "don't take this and send it to Opus",
    "stop, send nothing to Opus",
    "stop send it to Opus",
    "give nothing to Opus",
    "never give Opus this work",
    "stop sending everything to Opus",
    // Statements about Opus:
    "Opus should fix this",
    "Opus should not be doing this",
    "I don't think Opus should do this",
    "Opus should only be used for design",
    "can we avoid Opus? Opus should be the last resort",
    "the problem with Opus is cost",
    // Misdirected or not the word "opus":
    "Sonnet, not Opus",
    "send the report to Josh, not Opus",
    "send it to Opusly",
    "send it to opuses",
    "",
  ];
  for (const text of refuses) assert(!asksOpusToDoTheWork(text), text);

  assert(approvesOpusSubagent("/pr-review web-jam-tools#1000 dispatch to Opus subagent"));
});

Deno.test("asksOpusToDoTheWork: a bare affirmation before the routing verb still opens the instruction", () => {
  const approves = [
    // Josh's real message, refused before because a bare "yes" (no comma) did not open a clause:
    "yes dispatch the fix for that hook right now to Opus please",
    "yeah send it to Opus",
    "ok dispatch this to opus",
    "okay, fine. sure give it to Opus",
    "yes use Opus",
  ];
  for (const text of approves) assert(asksOpusToDoTheWork(text), text);
  for (const text of approves) assert(approvesOpusSubagent(text), text);

  // Josh's later message spawning an Opus subagent approves that subagent's edits:
  assert(
    approvesOpusSubagent(
      "fix now the 'Two problems with the Opus edit gate' fix them now using an Opus subagent, …",
    ),
  );

  const refuses = [
    "you said yes send it to Opus",
    "yes don't send it to Opus",
    "ok send nothing to Opus",
    "yes send it to Opus?",
    "yes, I asked you earlier to dispatch to Opus",
    "yesterday send it to Opus",
  ];
  for (const text of refuses) assert(!asksOpusToDoTheWork(text), text);
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

// --- slash commands, /work-issue arguments and issue references ---

Deno.test("slashCommandOf: wrapper form, bare form, and prose", () => {
  assertEquals(slashCommandOf(OPUS_ISSUE), "work-issue");
  assertEquals(slashCommandOf("/work-issue web-jam-tools#965"), "work-issue");
  assertEquals(slashCommandOf("please run work-issue"), null);
});

Deno.test("workIssueArgs: wrapper <command-args>, bare /work-issue text, and none", () => {
  assertEquals(workIssueArgs(workIssue(" JaMmusic#12 ")), "JaMmusic#12");
  assertEquals(workIssueArgs("/work-issue web-jam-back#7 please"), "web-jam-back#7 please");
  assertEquals(workIssueArgs("<command-name>/work-issue</command-name>"), "");
});

Deno.test("parseIssueRef: URL, Owner/Repo#N, Repo#N, and prose with no issue", () => {
  assertEquals(parseIssueRef("https://github.com/WebJamApps/web-jam-tools/issues/965"), {
    repo: "WebJamApps/web-jam-tools",
    number: 965,
  });
  assertEquals(parseIssueRef("WebJamApps/JaMmusic#1352"), {
    repo: "WebJamApps/JaMmusic",
    number: 1352,
  });
  assertEquals(parseIssueRef("web-jam-back#1086 now"), {
    repo: "WebJamApps/web-jam-back",
    number: 1086,
  });
  assertEquals(parseIssueRef("when the label is Opus = Opus can edit"), null);
  assertEquals(parseIssueRef(""), null);
});

// --- labels: gh output, cache, live gh ---

Deno.test("parseLabelsJson: gh --json labels output, and anything else", () => {
  assertEquals(parseLabelsJson('{"labels":[{"name":"Opus"},{"name":"Bug"},{}]}'), ["Opus", "Bug"]);
  assertEquals(parseLabelsJson('{"labels":null}'), null);
  assertEquals(parseLabelsJson("not json"), null);
});

Deno.test("createLabelLookup: reuses a fresh result, refetches a stale or unreadable one, never caches a failure", () => {
  const store: Record<string, string> = {};
  let clock = 1_000;
  const calls: IssueRef[] = [];
  let answer: string[] | null = ["Opus"];
  const lookup = createLabelLookup({
    cacheDir: "/cache",
    now: () => clock,
    run: (ref) => {
      calls.push(ref);
      return answer;
    },
    read: (path) => store[path] ?? null,
    write: (path, text) => {
      store[path] = text;
    },
  });
  const ref = { repo: "WebJamApps/web-jam-tools", number: 965 };

  assertEquals(lookup(ref), ["Opus"]);
  assertEquals(Object.keys(store), ["/cache/WebJamApps__web-jam-tools__965.json"]);
  assertEquals(lookup(ref), ["Opus"]);
  assertEquals(calls.length, 1);

  clock += LABEL_CACHE_TTL_MS;
  answer = ["Sonnet"];
  assertEquals(lookup(ref), ["Sonnet"]);
  assertEquals(calls.length, 2);

  store["/cache/WebJamApps__web-jam-tools__965.json"] = "garbage";
  answer = null;
  assertEquals(lookup(ref), null);
  assertEquals(store["/cache/WebJamApps__web-jam-tools__965.json"], "garbage");
  assertEquals(calls.length, 3);

  const throwingWrite = createLabelLookup({
    cacheDir: "/cache",
    now: () => clock,
    run: () => ["Opus"],
    read: () => null,
    write: () => {
      throw new Error("read-only");
    },
  });
  assertEquals(throwingWrite(ref), ["Opus"]);
});

Deno.test("runGhLabels: reads labels from gh, and returns null when gh fails", async () => {
  const bin = await Deno.makeTempDir();
  const originalPath = Deno.env.get("PATH") ?? "";
  try {
    await Deno.writeTextFile(
      `${bin}/gh`,
      '#!/usr/bin/env bash\nif [ "$3" = "1" ]; then echo \'{"labels":[{"name":"Opus"}]}\'; else exit 1; fi\n',
    );
    await Deno.chmod(`${bin}/gh`, 0o755);
    Deno.env.set("PATH", `${bin}:${originalPath}`);
    assertEquals(runGhLabels({ repo: "WebJamApps/web-jam-tools", number: 1 }), ["Opus"]);
    assertEquals(runGhLabels({ repo: "WebJamApps/web-jam-tools", number: 2 }), null);
  } finally {
    Deno.env.set("PATH", originalPath);
    await Deno.remove(bin, { recursive: true });
  }
});

// --- D-7 ---

Deno.test("workIssueApprovalActive: only a human /work-issue on an Opus- or Fable-labeled issue approves, until another slash command", () => {
  assert(
    workIssueApprovalActive([
      human(OPUS_ISSUE),
      metaEntry("Base directory for this skill"),
      human("why?"),
    ], labels),
  );
  assert(workIssueApprovalActive([human(workIssue("web-jam-tools#3"))], labels));
  assert(!workIssueApprovalActive([human(SONNET_ISSUE)], labels));
  assert(!workIssueApprovalActive([human(workIssue("web-jam-tools#99"))], labels));
  assert(
    !workIssueApprovalActive([human(workIssue("when the label is Opus = Opus can edit"))], labels),
  );
  assert(!workIssueApprovalActive([human(OPUS_ISSUE), human(PR_REVIEW)], labels));
  assert(
    !workIssueApprovalActive(
      [human(OPUS_ISSUE), {
        type: "user",
        message: { role: "user", content: "<command-name>/model</command-name>" },
      }],
      labels,
    ),
  );
  assert(!workIssueApprovalActive([metaEntry(OPUS_ISSUE)], labels));
  assert(
    !workIssueApprovalActive([
      notification("<task-notification>done</task-notification>"),
      human("hello"),
    ], labels),
  );
  assert(!workIssueApprovalActive([], labels));
});

// --- decisions ---

Deno.test("decideMainThreadEdit: every outcome", () => {
  const at = (entries: TranscriptEntry[]) => reader({ [MAIN]: jsonl(entries) });
  const noLookup: LabelLookup = () => {
    throw new Error("the label lookup must not run");
  };

  assertEquals(decideMainThreadEdit("", reader({}), noLookup).decision, "allow");
  assert(decideMainThreadEdit("", reader({}), noLookup).why.includes("could not be read"));
  assert(decideMainThreadEdit(MAIN, reader({}), noLookup).why.includes("could not be read"));
  assert(
    decideMainThreadEdit(MAIN, at([human("hi")]), noLookup).why.includes("could not be determined"),
  );
  assertEquals(
    decideMainThreadEdit(MAIN, at([human("hi"), assistant("claude-sonnet-5")]), noLookup).decision,
    "allow",
  );
  assertEquals(
    decideMainThreadEdit(
      MAIN,
      at([human(OPUS_ISSUE), human("opus edit ok"), assistant("claude-opus-5")]),
      noLookup,
    )
      .decision,
    "allow",
  );
  assertEquals(
    decideMainThreadEdit(MAIN, at([human(OPUS_ISSUE), assistant("claude-opus-5")]), labels)
      .decision,
    "allow",
  );
  assertEquals(
    decideMainThreadEdit(MAIN, at([human(SONNET_ISSUE), assistant("claude-opus-5")]), labels),
    { decision: "deny", kind: "main", why: "" },
  );
  assertEquals(
    decideMainThreadEdit(
      MAIN,
      at([
        human("opus edit ok"),
        assistant("claude-opus-5"),
        notification("<task-notification>x</task-notification>"),
      ]),
      noLookup,
    ).decision,
    "allow",
  );
  const plain = decideMainThreadEdit(
    MAIN,
    at([human("fix it"), assistant("claude-opus-5"), notification("opus edit ok")]),
    labels,
  );
  assertEquals(plain, { decision: "deny", kind: "main", why: "" });

  // D-8: a message asking Opus to do the work approves like "opus edit ok" does.
  assertEquals(
    decideMainThreadEdit(
      MAIN,
      at([human("please use OPUS to fix PR 968"), assistant("claude-opus-5")]),
      noLookup,
    ).decision,
    "allow",
  );
  assertEquals(
    decideMainThreadEdit(
      MAIN,
      at([human("don't use Opus, fix it"), assistant("claude-opus-5")]),
      noLookup,
    ),
    { decision: "deny", kind: "main", why: "" },
  );
  assertEquals(
    decideMainThreadEdit(
      MAIN,
      at([
        human("fix it"),
        assistant("claude-opus-5"),
        notification("<task-notification>use Opus</task-notification>"),
      ]),
      noLookup,
    ),
    { decision: "deny", kind: "main", why: "" },
  );
});

Deno.test("decideSubagentEdit: every outcome", () => {
  const main = jsonl([
    human("please fix it"),
    spawn("toolu_plain"),
    human("dispatch to an Opus subagent"),
    spawn("toolu_ok"),
    human("use Opus to fix it"),
    spawn("toolu_ask"),
  ]);
  const files = {
    [MAIN]: main,
    ...meta("s1", { model: "sonnet", toolUseId: "toolu_plain" }),
    ...meta("plain", { model: "opus", toolUseId: "toolu_plain" }),
    ...meta("ok", { model: "opus", toolUseId: "toolu_ok" }),
    ...meta("ask", { model: "opus", toolUseId: "toolu_ask" }),
    ...meta("orphan", { model: "opus", toolUseId: "toolu_missing" }),
  };
  const read = reader(files);

  assert(decideSubagentEdit("s1", "", read).why.includes("could not be located"));
  assert(decideSubagentEdit("nobody", MAIN, read).why.includes("model could not be determined"));
  assertEquals(decideSubagentEdit("s1", MAIN, read).decision, "allow");
  assertEquals(decideSubagentEdit("ok", MAIN, read).decision, "allow");
  assertEquals(decideSubagentEdit("ok", `${SUBAGENTS}/agent-ok.jsonl`, read).decision, "allow");
  // D-8: an Opus subagent spawned by "use Opus to fix it" proceeds.
  assertEquals(decideSubagentEdit("ask", MAIN, read).decision, "allow");
  assert(decideSubagentEdit("plain", MAIN, read).why.includes("neither contains"));
  assert(decideSubagentEdit("orphan", MAIN, read).why.includes("could not be found"));
});

Deno.test("decide: routes auto-mode subagent calls, exempts other subagent calls, and decides main-thread calls", () => {
  const read = reader({ [MAIN]: jsonl([human(OPUS_ISSUE), assistant("claude-opus-5")]) });
  assertEquals(
    decide({ agent_id: "x", permission_mode: "auto", transcript_path: MAIN }, read, labels).kind,
    "subagent",
  );
  assertEquals(
    decide({ agent_id: "x", permission_mode: "default", transcript_path: MAIN }, read, labels),
    {
      decision: "allow",
      kind: "subagent",
      why: "",
    },
  );
  assertEquals(decide({ transcript_path: MAIN }, read, labels), {
    decision: "allow",
    kind: "main",
    why: "",
  });
  assertEquals(decide({}, read, labels).decision, "allow");
  assert(decide({}, read, labels).why.includes("could not be read"));
});

// --- Four literal cases named in 'What this builds' (allow and say so) ---

Deno.test("Case 1: an unreadable transcript allows with note", () => {
  const read = reader({});
  const res = decide({ transcript_path: "/nonexistent/transcript.jsonl" }, read, labels);
  assertEquals(res.decision, "allow");
  assert(res.why.includes("could not be read"));
});

Deno.test("Case 2: missing subagent metadata allows with note", () => {
  const read = reader({ [MAIN]: jsonl([human("opus edit ok"), spawn("toolu_sub")]) });
  const res = decide(
    { agent_id: "missing-meta", permission_mode: "auto", transcript_path: MAIN },
    read,
    labels,
  );
  assertEquals(res.decision, "allow");
  assertEquals(res.kind, "subagent");
  assert(res.why.includes("model could not be determined"));
});

Deno.test("Case 3: a Bash write whose destination cannot be read allows with note", () => {
  const read = reader({ [MAIN]: jsonl([human("fix this"), assistant("claude-opus-5")]) });
  const res = decide(
    {
      tool_name: "Bash",
      tool_input: {
        command: "python3 -c \"import pathlib; p = pathlib.Path('foo'); p.write_text('hi')\"",
      },
      cwd: "/home/joshua/WebJamApps/web-jam-tools",
      transcript_path: MAIN,
    },
    read,
    labels,
  );
  assertEquals(res.decision, "allow");
  assert(res.why.includes("destination cannot be read"));
});

Deno.test("Case 4: a read-only command whose quoted text merely contains a write allows with note", () => {
  const read = reader({ [MAIN]: jsonl([human("fix this"), assistant("claude-opus-5")]) });
  const res = decide(
    {
      tool_name: "Bash",
      tool_input: { command: 'deno eval \'console.log("open(f, \\"w\\")")\'' },
      cwd: "/home/joshua/WebJamApps/web-jam-tools",
      transcript_path: MAIN,
    },
    read,
    labels,
  );
  assertEquals(res.decision, "allow");
  assert(res.why.includes("read-only command whose quoted text merely contains a write"));
});

// --- Reproduction check: 2026-09-17 finding ---

Deno.test("Reproduction 2026-09-17: deno eval with Python heredoc writing via pathlib allows with note", () => {
  const read = reader({ [MAIN]: jsonl([human("fix this"), assistant("claude-opus-5")]) });
  const cmd = `deno eval '
const script = \`
cd /home/joshua/WebJamApps/web-jam-tools
python3 - <<EOF
import pathlib
p = pathlib.Path("/home/joshua/Dropbox/test.txt")
p.write_text("hello")
EOF
\`;
console.log(script);
'`;
  const res = decide(
    {
      tool_name: "Bash",
      tool_input: { command: cmd },
      cwd: "/home/joshua/WebJamApps/web-jam-tools",
      transcript_path: MAIN,
    },
    read,
    labels,
  );
  assertEquals(res.decision, "allow");
  assert(
    res.why.includes("read-only command whose quoted text merely contains a write") ||
      res.why.includes("destination cannot be read"),
  );
});

// --- A read-only invocation may not launder a real write (web-jam-tools#1077 review) ---

Deno.test("isReadOnlyQuotedWrite: only a lone read-only invocation counts, never a chained write", () => {
  // Genuinely read-only: the write pattern lives in text the interpreter merely prints.
  assert(isReadOnlyQuotedWrite(`deno eval 'console.log("open(f, \\"w\\")")'`));
  assert(isReadOnlyQuotedWrite(`node -p 'JSON.stringify({a:1})'`));
  assert(isReadOnlyQuotedWrite(`python3 -c 'print("writeFileSync")'`));

  // A real write chained onto a harmless evaluation is NOT read-only: the second command writes.
  assert(!isReadOnlyQuotedWrite(`deno eval 'console.log(1)' && echo x > src/a.ts`));
  assert(!isReadOnlyQuotedWrite(`python3 -c 'print(1)'; echo x > src/a.ts`));
  assert(!isReadOnlyQuotedWrite(`node -e 'console.log(1)' && echo x > src/a.ts`));
  assert(!isReadOnlyQuotedWrite(`deno eval 'console.log(1)' | tee src/a.ts`));
  assert(!isReadOnlyQuotedWrite(`deno eval 'console.log(1)' && rm -rf src`));

  // A trailing comment naming an interpreter does not make a write read-only.
  assert(!isReadOnlyQuotedWrite(`echo x > src/a.ts # deno eval`));

  // The script's own write APIs are matched under the runtime that actually runs it.
  assert(!isReadOnlyQuotedWrite(`deno eval 'Deno.writeTextFileSync("src/a.ts","x")'`));
  assert(!isReadOnlyQuotedWrite(`node -e 'require("fs").writeFileSync("src/a.ts","x")'`));
  assert(!isReadOnlyQuotedWrite(`python3 -c 'open("src/a.ts","w").write("x")'`));

  // Spawning a subprocess from an inline script is a write the gate cannot see into.
  assert(!isReadOnlyQuotedWrite(`deno eval 'new Deno.Command("sh",{args:["-c","echo x > a"]})'`));
  assert(!isReadOnlyQuotedWrite(`python3 -c 'import subprocess; subprocess.run(["sh"])'`));

  // A command substitution can run anything, so the shape is not readable.
  assert(!isReadOnlyQuotedWrite('deno eval "console.log(`cat /etc/passwd`)"'));
  assert(!isReadOnlyQuotedWrite('deno eval "console.log($(id))"'));
});

Deno.test("singleSimpleCommandTokens: one simple command tokenizes, anything else is null", () => {
  assertEquals(singleSimpleCommandTokens(`deno eval 'console.log(1)'`), [
    "deno",
    "eval",
    "console.log(1)",
  ]);
  // An operator inside a quoted argument is data, not a second command.
  assertEquals(singleSimpleCommandTokens(`deno eval 'a && b > c'`), ["deno", "eval", "a && b > c"]);

  for (
    const command of [
      `deno eval 'x' && echo y`,
      `deno eval 'x'; echo y`,
      `deno eval 'x' | cat`,
      `deno eval 'x' > out.txt`,
      `deno eval 'x' &`,
      `deno eval 'x' # comment`,
      `deno eval 'unterminated`,
    ]
  ) {
    assertEquals(singleSimpleCommandTokens(command), null, command);
  }
});

Deno.test("decide: a write chained onto a read-only invocation is still refused", () => {
  const read = reader({ [MAIN]: jsonl([human("fix this"), assistant("claude-opus-5")]) });
  const bypasses = [
    `deno eval 'console.log(1)' && echo x > /home/joshua/WebJamApps/web-jam-tools/src/a.ts`,
    `python3 -c 'print(1)'; echo x > /home/joshua/WebJamApps/web-jam-tools/src/a.ts`,
    `node -e 'console.log(1)' && echo x > /home/joshua/WebJamApps/web-jam-tools/src/a.ts`,
    `echo x > /home/joshua/WebJamApps/web-jam-tools/src/a.ts # deno eval`,
  ];
  for (const command of bypasses) {
    const res = decide(
      {
        tool_name: "Bash",
        tool_input: { command },
        cwd: "/home/joshua/WebJamApps/web-jam-tools",
        transcript_path: MAIN,
      },
      read,
      labels,
    );
    assertEquals(res.decision, "deny", command);
  }
});

// --- Checker throws proceeds by workflow default ---

Deno.test("checker throws proceeds by workflow default (allow)", () => {
  const throwingRead: ReadText = () => {
    throw new Error("disk read error");
  };
  const res = decide({ transcript_path: MAIN }, throwingRead, labels);
  assertEquals(res.decision, "allow");
  assert(res.why.includes("The gate's checker threw an error"));
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

Deno.test("CLI: prints a decision for a payload and allows by workflow default on unreadable stdin", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const transcript = `${dir}/sess.jsonl`;
    await Deno.writeTextFile(
      transcript,
      jsonl([human("opus edit ok"), assistant("claude-opus-5")]),
    );
    assertEquals((await runCli(JSON.stringify({ transcript_path: transcript }))).decision, "allow");
    const unreadable = await runCli("not json");
    assertEquals(unreadable.decision, "allow");
    assert(typeof unreadable.why === "string" && unreadable.why.length > 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
