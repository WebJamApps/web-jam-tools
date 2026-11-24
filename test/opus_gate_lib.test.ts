// opus_gate_lib.test.ts — web-jam-tools#965
//
// Unit tests for hooks/lib/opus_gate.ts (design decisions D-6 and D-7). Files are supplied through
// an in-memory ReadText and labels through an in-memory LabelLookup, so every input the gate reads
// is explicit; the gh and CLI cases at the end run the real code. End-to-end cases through the shell
// hook live in opus_delegation_gate_hook.test.ts.

import { assert, assertEquals } from "@std/assert";
import {
  approvesFableSubagent,
  asksFableToDoTheWork,
  asksForFableSubagent,
  createLabelLookup,
  decide as decideWithSwitch,
  decideMainThreadEdit,
  decideSubagentEdit,
  fableEditApprovalActive,
  findSpawningHumanPrompt,
  isFableModel,
  isOpusModel,
  isReadOnlyQuotedWrite,
  type IssueRef,
  LABEL_CACHE_TTL_MS,
  type LabelLookup,
  parseGitHubRepo,
  parseIssueRef,
  parseLabelsJson,
  type ReadText,
  readTextOrNull,
  type RepoLookup,
  resolveSessionFiles,
  resolveSubagentModel,
  runGhLabels,
  singleSimpleCommandTokens,
  slashCommandOf,
  workIssueApprovalActive,
  workIssueArgs,
} from "../hooks/lib/opus_gate.ts";
import { extractEntryText, type TranscriptEntry } from "../hooks/lib/select_transcript_entry.ts";

/**
 * `decide` with no workflow switch released unless a test passes its own checker. The default
 * checker reads and logs the laptop's live ~/.claude/state/workflow-switch.json, so a release Josh
 * set would flip these tests to "allow" on the laptop (CI has no switch) and the run would append
 * to his real switch log.
 */
const decide = (
  payload: Parameters<typeof decideWithSwitch>[0],
  read: Parameters<typeof decideWithSwitch>[1],
  lookupLabels?: Parameters<typeof decideWithSwitch>[2],
  switchChecker: Parameters<typeof decideWithSwitch>[3] = () => ({ released: false }),
) => decideWithSwitch(payload, read, lookupLabels, switchChecker);

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

Deno.test("fableEditApprovalActive: approval is session-scoped, not per-turn", () => {
  // The defect this replaces: approval was read from the latest prompt alone, so any following
  // message at all silently withdrew permission Josh had already given.
  assert(fableEditApprovalActive([human("fable edit ok")]));
  assert(
    fableEditApprovalActive([human("fable edit ok"), human("api error try again")]),
    "an unrelated later message must not withdraw approval",
  );
  assert(
    fableEditApprovalActive([human("fable edit ok"), human("bullshit gate"), human("damnit")]),
    "several unrelated later messages must not withdraw approval",
  );

  // Nothing approving anywhere in the session.
  assertEquals(fableEditApprovalActive([human("fix the gate")]), false);
  assertEquals(fableEditApprovalActive([]), false);

  // Explicit withdrawal wins over an earlier approval, and a later approval revives it.
  assertEquals(fableEditApprovalActive([human("fable edit ok"), human("fable edit off")]), false);
  assert(
    fableEditApprovalActive([
      human("fable edit ok"),
      human("fable edit off"),
      human("fable edit ok"),
    ]),
  );

  // Asking Fable to do the work approves the same way (D-8), and still persists.
  assert(fableEditApprovalActive([human("have fable fix it"), human("thanks")]));

  // Only prompts Josh actually sent count: injected turns neither grant nor cancel approval.
  assertEquals(fableEditApprovalActive([notification("fable edit ok")]), false);
  assertEquals(fableEditApprovalActive([metaEntry("fable edit ok")]), false);
  assert(
    fableEditApprovalActive([human("fable edit ok"), notification("fable edit off")]),
    "an injected revocation must not cancel Josh's approval",
  );
  assert(
    fableEditApprovalActive([human("fable edit ok"), metaEntry("fable edit off")]),
    "an isMeta revocation must not cancel Josh's approval",
  );
});

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
      model: "claude-fable-5-2",
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

Deno.test("isOpusModel / isFableModel / asksForFableSubagent / approvesFableSubagent", () => {
  assert(isOpusModel("claude-opus-5-5"));
  assert(isOpusModel("opus"));
  assert(!isOpusModel("sonnet"));
  assert(!isOpusModel("claude-fable-5-2"));
  assert(isFableModel("claude-fable-5-2"));
  assert(isFableModel("fable"));
  assert(!isFableModel("claude-opus-5-5"));

  assert(asksForFableSubagent("dispatch to a Fable subagent"));
  assert(asksForFableSubagent("use fable sub-agents for this"));
  assert(!asksForFableSubagent("fable is fine here"));
  assert(!asksForFableSubagent("dispatch to a Sonnet subagent"));

  assert(approvesFableSubagent("OK, fable edit ok, go"));
  assert(approvesFableSubagent("spawn a Fable subagent"));
  assert(!approvesFableSubagent("please fix it"));
  assert(!approvesFableSubagent("why did you spawn a Fable subagent?"));
  assert(!approvesFableSubagent("the Fable subagent broke it"));
  assert(!approvesFableSubagent("don't use a Fable subagent"));
  // An Opus grant or request is not a choice of Fable.
  assert(!approvesFableSubagent("opus edit ok"));
  assert(!approvesFableSubagent("dispatch to an Opus subagent"));
  assert(!approvesFableSubagent("use Opus to fix it"));
});

// --- D-8 ---

Deno.test("asksFableToDoTheWork: only an instruction naming Fable approves; complaints and bare mentions fail closed", () => {
  const approves = [
    "please use FABLE to fix https://github.com/WebJamApps/web-jam-tools/pull/968 and also post a comment on it from FABLE when done",
    "use Fable to fix it",
    "have Fable fix it",
    "let a Fable agent do it",
    "Please, use Fable",
    "fix it now. use Fable",
    "don't use Sonnet, use Fable",
    "ok and have Fable do it",
  ];
  for (const text of approves) assert(asksFableToDoTheWork(text), text);

  const refuses = [
    "don't use Fable",
    "don’t use Fable",
    "don't  use Fable",
    "do not use fable",
    "please don't use fable",
    "never have Fable edit",
    "I told you not to use Fable",
    "no need to use Fable here",
    "why did you use Fable for this? delegate to Sonnet",
    "you shouldn't use Fable for mechanical work",
    "stop using Fable",
    "the problem with Fable is cost",
    "fix it with Fable",
    "using fable for this",
    "Fable ate my tokens, did not delegate to Sonnet",
    "use Sonnet not Fable",
    "fable is fine here",
    "for FABLE please https://github.com/WebJamApps/web-jam-tools/pull/972",
  ];
  for (const text of refuses) assert(!asksFableToDoTheWork(text), text);

  assert(approvesFableSubagent("please use FABLE to fix it"));
});

Deno.test("asksFableToDoTheWork: a routing instruction to Fable that opens a clause approves; a complaint, question, negation or statement refuses", () => {
  const approves = [
    // Josh's real message that was wrongly refused (web-jam-tools PR 1000 follow-up):
    "send the PR 1000 fix to FABLE !  this is the THIRD time I have said this what is going on !!!!!!!?",
    "dispatch this to Fable",
    "dispatch to Fable",
    "send it to fable",
    "please send it to Fable",
    "yes, give this to Fable",
    "hand the fix to Fable",
    "assign it to fable",
    "route this to Fable",
    "ok and send it to the Fable agent",
    "please use FABLE to fix this",
    "let Fable do it",
  ];
  for (const text of approves) assert(asksFableToDoTheWork(text), text);

  const refuses = [
    // An instruction reported second-hand has the same shape as a complaint, so it fails closed:
    "hi i asked you earlier to dispatch to Fable to fix this and you seem to have ignored me !?  https://github.com/WebJamApps/web-jam-tools/pull/1000",
    // Complaints and questions, with or without a "?":
    "why did you use Fable",
    "why did you send this to Fable",
    "who told you to dispatch this to Fable",
    "should we send this to Fable",
    "did you dispatch it to Fable and why",
    "did you send it to Fable?",
    "should we send this to Fable?",
    "send it to Fable?",
    // Negations, including contractions and a negated object:
    "don't send this to Fable",
    "do not dispatch to fable",
    "please don't send it to Fable",
    "you shouldn't send this to Fable",
    "I didn't send it to Fable",
    "you won't send it to fable",
    "don't take this and send it to Fable",
    "stop, send nothing to Fable",
    "stop send it to Fable",
    "give nothing to Fable",
    "never give Fable this work",
    "stop sending everything to Fable",
    // Statements about Fable:
    "Fable should fix this",
    "Fable should not be doing this",
    "I don't think Fable should do this",
    "Fable should only be used for design",
    "can we avoid Fable? Fable should be the last resort",
    "the problem with Fable is cost",
    // Misdirected or not the word "fable":
    "Sonnet, not Fable",
    "send the report to Josh, not Fable",
    "send it to Fablely",
    "send it to fablees",
    "",
  ];
  for (const text of refuses) assert(!asksFableToDoTheWork(text), text);

  assert(approvesFableSubagent("/pr-review web-jam-tools#1000 dispatch to Fable subagent"));
});

Deno.test("asksFableToDoTheWork: a bare affirmation before the routing verb still opens the instruction", () => {
  const approves = [
    // Josh's real message, refused before because a bare "yes" (no comma) did not open a clause:
    "yes dispatch the fix for that hook right now to Fable please",
    "yeah send it to Fable",
    "ok dispatch this to fable",
    "okay, fine. sure give it to Fable",
    "yes use Fable",
  ];
  for (const text of approves) assert(asksFableToDoTheWork(text), text);
  for (const text of approves) assert(approvesFableSubagent(text), text);

  // Josh's later message spawning a Fable subagent approves that subagent's edits:
  assert(
    approvesFableSubagent(
      "fix now the 'Two problems with the Fable edit gate' fix them now using a Fable subagent, …",
    ),
  );

  const refuses = [
    "you said yes send it to Fable",
    "yes don't send it to Fable",
    "ok send nothing to Fable",
    "yes send it to Fable?",
    "yes, I asked you earlier to dispatch to Fable",
    "yesterday send it to Fable",
  ];
  for (const text of refuses) assert(!asksFableToDoTheWork(text), text);
});

Deno.test("asksFableToDoTheWork: a use/have/let instruction that is a question does not choose Fable", () => {
  const refuses = [
    "use Fable?",
    "have Fable fix it?",
    "yes use Fable?",
    "ok, let Fable do it?",
    "use Fable for this or Opus?",
    "please use a Fable agent?",
  ];
  for (const text of refuses) assert(!asksFableToDoTheWork(text), text);
  for (const text of refuses) assert(!approvesFableSubagent(text), text);

  const approves = [
    "use Fable? yes, use Fable",
    "have Fable fix it. is that clear?",
    "use Fable and then tell me what changed?",
  ];
  for (const text of approves) assert(asksFableToDoTheWork(text), text);
});

Deno.test("asksForFableSubagent: only an instruction putting a Fable subagent to work counts", () => {
  const approves = [
    "dispatch to a Fable subagent",
    "use fable sub-agents for this",
    "spawn a Fable subagent",
    "yes, please spawn a Fable subagent",
    "fix it with a Fable subagent",
    "fix them now using a Fable subagent, then report",
    "/pr-review web-jam-tools#1000 dispatch to Fable subagent",
  ];
  for (const text of approves) assert(asksForFableSubagent(text), text);

  const refuses = [
    // Questions:
    "why did you spawn a Fable subagent",
    "did you use a Fable subagent?",
    "spawn a Fable subagent?",
    "can you spawn a Fable subagent",
    "do you have a Fable subagent running",
    // Negative mentions:
    "don't use a Fable subagent",
    "no Fable subagent",
    "use a Sonnet subagent, not a Fable subagent",
    "stop using a Fable subagent",
    "never spawn a Fable subagent",
    // Incidental mentions and second-hand reports:
    "the Fable subagent broke it",
    "Fable subagents are expensive",
    "I told you to use a Fable subagent",
    "you used a Fable subagent",
    "fable is fine here",
    "dispatch to a Sonnet subagent",
  ];
  for (const text of refuses) assert(!asksForFableSubagent(text), text);
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
      assistant("claude-fable-5-2", { isSidechain: true, isApiErrorMessage: true }),
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
    human("dispatch to a Fable subagent"),
    notification("<task-notification>fable edit ok</task-notification>"),
    spawn("toolu_1"),
  ]);
  const files = {
    [MAIN]: main,
    ...meta("o1", { model: "fable", toolUseId: "toolu_1", parentAgentId: null }),
    ...meta("o2", { model: "fable", toolUseId: "toolu_nested", parentAgentId: "o1" }),
    ...meta("gone", { model: "fable", toolUseId: "toolu_x", parentAgentId: "missing" }),
    ...meta("loop1", { model: "fable", parentAgentId: "loop2" }),
    ...meta("loop2", { model: "fable", parentAgentId: "loop1" }),
    ...meta("orphan", { model: "fable", toolUseId: "toolu_not_there" }),
    ...meta("early", { model: "fable", toolUseId: "toolu_0" }),
  };

  assertEquals(
    extractEntryText(findSpawningHumanPrompt(FILES, "o1", reader(files))),
    "dispatch to a Fable subagent",
  );
  assertEquals(
    extractEntryText(findSpawningHumanPrompt(FILES, "o2", reader(files))),
    "dispatch to a Fable subagent",
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
  assertEquals(parseIssueRef("when the label is Fable = Fable can edit"), null);
  assertEquals(parseIssueRef(""), null);
});

// --- labels: gh output, cache, live gh ---

Deno.test("parseLabelsJson: gh --json labels output, and anything else", () => {
  assertEquals(parseLabelsJson('{"labels":[{"name":"Fable"},{"name":"Bug"},{}]}'), [
    "Fable",
    "Bug",
  ]);
  assertEquals(parseLabelsJson('{"labels":null}'), null);
  assertEquals(parseLabelsJson("not json"), null);
});

Deno.test("createLabelLookup: reuses a fresh result, refetches a stale or unreadable one, never caches a failure", () => {
  const store: Record<string, string> = {};
  let clock = 1_000;
  const calls: IssueRef[] = [];
  let answer: string[] | null = ["Fable"];
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

  assertEquals(lookup(ref), ["Fable"]);
  assertEquals(Object.keys(store), ["/cache/WebJamApps__web-jam-tools__965.json"]);
  assertEquals(lookup(ref), ["Fable"]);
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
    run: () => ["Fable"],
    read: () => null,
    write: () => {
      throw new Error("read-only");
    },
  });
  assertEquals(throwingWrite(ref), ["Fable"]);
});

Deno.test("runGhLabels: reads labels from gh, and returns null when gh fails", async () => {
  const bin = await Deno.makeTempDir();
  const originalPath = Deno.env.get("PATH") ?? "";
  try {
    await Deno.writeTextFile(
      `${bin}/gh`,
      '#!/usr/bin/env bash\nif [ "$3" = "1" ]; then echo \'{"labels":[{"name":"Fable"}]}\'; else exit 1; fi\n',
    );
    await Deno.chmod(`${bin}/gh`, 0o755);
    Deno.env.set("PATH", `${bin}:${originalPath}`);
    assertEquals(runGhLabels({ repo: "WebJamApps/web-jam-tools", number: 1 }), ["Fable"]);
    assertEquals(runGhLabels({ repo: "WebJamApps/web-jam-tools", number: 2 }), null);
  } finally {
    Deno.env.set("PATH", originalPath);
    await Deno.remove(bin, { recursive: true });
  }
});

// --- D-7 ---

Deno.test("workIssueApprovalActive: only a human /work-issue on an issue Josh labeled Fable approves, until another slash command", () => {
  const FABLE_ISSUE = workIssue("web-jam-tools#3");
  assert(
    workIssueApprovalActive([
      human(FABLE_ISSUE),
      metaEntry("Base directory for this skill"),
      human("why?"),
    ], labels),
  );
  // Revision 1.3.0: an Opus label names the top coding lane and never chooses Fable.
  assert(!workIssueApprovalActive([human(OPUS_ISSUE)], labels));
  assert(!workIssueApprovalActive([human(SONNET_ISSUE)], labels));
  assert(!workIssueApprovalActive([human(workIssue("web-jam-tools#99"))], labels));
  assert(
    !workIssueApprovalActive(
      [human(workIssue("when the label is Fable = Fable can edit"))],
      labels,
    ),
  );
  assert(!workIssueApprovalActive([human(FABLE_ISSUE), human(PR_REVIEW)], labels));
  assert(
    !workIssueApprovalActive(
      [human(FABLE_ISSUE), {
        type: "user",
        message: { role: "user", content: "<command-name>/model</command-name>" },
      }],
      labels,
    ),
  );
  assert(!workIssueApprovalActive([metaEntry(FABLE_ISSUE)], labels));
  assert(
    !workIssueApprovalActive([
      notification("<task-notification>done</task-notification>"),
      human("hello"),
    ], labels),
  );
  assert(!workIssueApprovalActive([], labels));
});

// --- Typed fix-pr approval (web-jam-tools#1336) ---

Deno.test("fix-pr: the newest human typed call approves the session until another typed skill", () => {
  const call = "/fix-pr web-jam-tools#1318";
  const noLookup: LabelLookup = () => {
    throw new Error("fix-pr approval must not look up issue labels");
  };
  const cases: [TranscriptEntry[], "allow" | "deny"][] = [
    [[human(call)], "allow"],
    [[human(call), human("go ahead")], "allow"],
    [[human(call), human(PR_REVIEW)], "deny"],
    [[human(call + " use a Fable helper"), human(PR_REVIEW)], "deny"],
    [[
      human("fix it"),
      assistant("claude-fable-5-2", {
        message: { role: "assistant", model: "claude-fable-5-2", content: call },
      }),
    ], "deny"],
    [[notification(call)], "deny"],
    [[metaEntry(call)], "deny"],
    [[{ type: "tool", message: { role: "tool", content: call } }], "deny"],
    [[human("The command is " + call)], "deny"],
    [[human(call), notification("/pr-review"), metaEntry("/pr-review")], "allow"],
    [[human(call), { type: "user", message: { role: "user", content: "/pr-review" } }], "allow"],
  ];
  for (const [entries, expected] of cases) {
    const read = reader({ [MAIN]: jsonl([...entries, assistant("claude-fable-5-2")]) });
    assertEquals(decideMainThreadEdit(MAIN, read, noLookup).decision, expected, jsonl(entries));
  }
});

Deno.test("fix-pr: only a named PR in a typed skill call approves, including wrapper and plugin forms", () => {
  const args = "web-jam-tools#1318";
  const approves = [
    "/fix-pr " + args,
    "/fix-pr WebJamApps/" + args,
    "/fix-pr https://github.com/WebJamApps/web-jam-tools/pull/1318",
    "/fix-pr 1318",
    "/fix-pr #1318",
    "/webjam-tasks:fix-pr " + args,
    "$fix-pr " + args,
    "<command-name>/fix-pr</command-name>\n<command-args>" + args +
    "</command-args>",
  ];
  const refuses = [
    "/fix-pr",
    "/fix-pr use a Fable helper",
    "/fix-pr https://github.com/WebJamApps/web-jam-tools/issues/1318",
    "/fix-pr web-jam-tools#0",
    "/fix-pr -1318",
    "/fix-pr 1318.5",
    "/fix-pr web-jam-tools#9007199254740992",
    "/fix-pr-other " + args,
  ];
  for (const [calls, expected] of [[approves, "allow"], [refuses, "deny"]] as const) {
    for (const call of calls) {
      // A bare number names the repository of the folder Josh typed the call in.
      const typed = { ...human(call), cwd: "/work/web-jam-tools" };
      const read = reader({ [MAIN]: jsonl([typed, assistant("claude-fable-5-2")]) });
      assertEquals(
        decideMainThreadEdit(MAIN, read, labels, [TOOLS_FILE], twoRepos).decision,
        expected,
        call,
      );
    }
  }
});

// --- Typed task grants are bound to their repository and ended by "fable edit off" ---

const TOOLS_FILE = "/work/web-jam-tools/hooks/a.ts";
const MUSIC_FILE = "/work/JaMmusic/src/b.tsx";

/** Two repositories, a working tree whose origin cannot be read, and everything else outside git. */
const twoRepos: RepoLookup = (path) => {
  if (path.startsWith("/work/web-jam-tools")) {
    return { inTree: true, repo: "webjamapps/web-jam-tools" };
  }
  if (path.startsWith("/work/JaMmusic")) return { inTree: true, repo: "webjamapps/jammusic" };
  if (path.startsWith("/work/no-origin")) return { inTree: true, repo: null };
  return { inTree: false, repo: null };
};

Deno.test("task grants: a typed /work-issue or /fix-pr covers edits in its own repository only", () => {
  const ISSUE = workIssue("web-jam-tools#3");
  const PR_LINK = "/fix-pr https://github.com/WebJamApps/web-jam-tools/pull/1318";
  const OUTSIDE = "/tmp/fix-pr-1318-comment.md";
  const NO_ORIGIN = "/work/no-origin/c.ts";
  const cases: [TranscriptEntry, string[], "allow" | "deny"][] = [
    [human(ISSUE), [TOOLS_FILE], "allow"],
    [human(ISSUE), [MUSIC_FILE], "deny"],
    [human(ISSUE), [TOOLS_FILE, MUSIC_FILE], "deny"],
    [human(ISSUE), [TOOLS_FILE, OUTSIDE], "allow"],
    [human(ISSUE), [NO_ORIGIN], "deny"],
    [human(PR_LINK), [TOOLS_FILE], "allow"],
    [human(PR_LINK), [MUSIC_FILE], "deny"],
    [human("/fix-pr WebJamApps/JaMmusic#5"), [MUSIC_FILE], "allow"],
    [human("/fix-pr JaMmusic#5"), [TOOLS_FILE], "deny"],
    [human("/fix-pr webjamapps/WEB-JAM-TOOLS#1318"), [TOOLS_FILE], "allow"],
    [{ ...human("/fix-pr 1318"), cwd: "/work/JaMmusic" }, [MUSIC_FILE], "allow"],
    [{ ...human("/fix-pr 1318"), cwd: "/work/JaMmusic" }, [TOOLS_FILE], "deny"],
    // A bare number typed outside any repository, or with no folder recorded, names none.
    [{ ...human("/fix-pr 1318"), cwd: "/home/joshua" }, [MUSIC_FILE], "deny"],
    [human("/fix-pr 1318"), [MUSIC_FILE], "deny"],
  ];
  for (const [call, targets, expected] of cases) {
    const read = reader({ [MAIN]: jsonl([call, assistant("claude-fable-5-2")]) });
    const decision = decideMainThreadEdit(MAIN, read, labels, targets, twoRepos);
    assertEquals(decision.decision, expected, `${extractEntryText(call)} -> ${targets}`);
  }

  const read = reader({ [MAIN]: jsonl([human(ISSUE), assistant("claude-fable-5-2")]) });
  assert(
    decideMainThreadEdit(MAIN, read, labels, [MUSIC_FILE], twoRepos).why.includes(
      "webjamapps/web-jam-tools",
    ),
  );

  // Josh's separate session grant is not tied to the task's repository.
  const granted = reader({
    [MAIN]: jsonl([human(ISSUE), human("fable edit ok"), assistant("claude-fable-5-2")]),
  });
  assertEquals(
    decideMainThreadEdit(MAIN, granted, labels, [MUSIC_FILE], twoRepos).decision,
    "allow",
  );
});

Deno.test("task grants: fable edit off after a typed task ends it until Josh chooses Fable again", () => {
  for (const task of [workIssue("web-jam-tools#3"), "/fix-pr web-jam-tools#1318"]) {
    const cases: [TranscriptEntry[], "allow" | "deny"][] = [
      [[human(task)], "allow"],
      [[human(task), human("fable edit off")], "deny"],
      [[human(task), human("fable edit off"), human("go ahead")], "deny"],
      [[human(task), human("fable edit ok"), human("fable edit off")], "deny"],
      [[human(task), human("fable edit off"), human("fable edit ok")], "allow"],
      [[human(task), human("fable edit off"), human(task)], "allow"],
      [[human("fable edit off"), human(task)], "allow"],
      // Only Josh's own prompt withdraws.
      [[human(task), notification("fable edit off")], "allow"],
      [[human(task), metaEntry("fable edit off")], "allow"],
    ];
    for (const [entries, expected] of cases) {
      const read = reader({ [MAIN]: jsonl([...entries, assistant("claude-fable-5-2")]) });
      assertEquals(
        decideMainThreadEdit(MAIN, read, labels, [TOOLS_FILE], twoRepos).decision,
        expected,
        jsonl(entries),
      );
    }
  }
});

Deno.test("fix-pr: a Fable helper edits only in its pull request's repository, until fable edit off", () => {
  const call = "/fix-pr https://github.com/WebJamApps/web-jam-tools/pull/1318 use a Fable helper";
  const cases: [TranscriptEntry[], string[], "allow" | "deny"][] = [
    [[], [TOOLS_FILE], "allow"],
    [[], [MUSIC_FILE], "deny"],
    [[human("go ahead")], [TOOLS_FILE], "allow"],
    [[human("fable edit off")], [TOOLS_FILE], "deny"],
    [[human("fable edit off"), human("go ahead")], [TOOLS_FILE], "deny"],
  ];
  for (const [later, targets, expected] of cases) {
    const read = reader({
      [MAIN]: jsonl([human(call), spawn("toolu_fix"), ...later]),
      ...meta("fix", { model: "fable", toolUseId: "toolu_fix" }),
    });
    assertEquals(
      decideSubagentEdit("fix", MAIN, read, targets, twoRepos).decision,
      expected,
      `${jsonl(later)} -> ${targets}`,
    );
  }
});

Deno.test("parseGitHubRepo: owner/name in lower case from GitHub remote URLs only", () => {
  assertEquals(
    parseGitHubRepo("git@github.com:WebJamApps/web-jam-tools.git"),
    "webjamapps/web-jam-tools",
  );
  assertEquals(parseGitHubRepo("https://github.com/WebJamApps/JaMmusic"), "webjamapps/jammusic");
  assertEquals(
    parseGitHubRepo("https://github.com/WebJamApps/JaMmusic.git/\n"),
    "webjamapps/jammusic",
  );
  assertEquals(
    parseGitHubRepo("ssh://git@github.com/WebJamApps/web-jam-tools.git"),
    "webjamapps/web-jam-tools",
  );
  assertEquals(parseGitHubRepo("https://gitlab.com/WebJamApps/web-jam-tools.git"), null);
  assertEquals(parseGitHubRepo(""), null);
});

Deno.test("decide: a typed task's grant reaches its own repository and not another (two real repositories)", async () => {
  const root = await Deno.makeTempDir({ prefix: "opus-gate-two-repos-" });
  try {
    const repos: [string, string][] = [
      ["tools", "git@github.com:WebJamApps/web-jam-tools.git"],
      ["music", "https://github.com/WebJamApps/JaMmusic.git"],
      ["no-origin", ""],
    ];
    for (const [name, url] of repos) {
      const repo = `${root}/${name}`;
      const steps = [
        ["init", "-q", repo],
        ...(url ? [["-C", repo, "remote", "add", "origin", url]] : []),
      ];
      for (const args of steps) {
        const { success } = await new Deno.Command("git", { args, stdout: "null", stderr: "null" })
          .output();
        assert(success, args.join(" "));
      }
    }
    for (const task of ["/fix-pr web-jam-tools#1318", workIssue("web-jam-tools#3")]) {
      const read = reader({ [MAIN]: jsonl([human(task), assistant("claude-fable-5-2")]) });
      const run = (tool_input: Record<string, unknown>, tool_name = "Write") =>
        decide({ tool_name, tool_input, transcript_path: MAIN, cwd: `${root}/tools` }, read, labels)
          .decision;

      // A folder that does not exist yet is judged by its nearest existing parent.
      assertEquals(run({ file_path: `${root}/tools/src/new/a.ts` }), "allow", task);
      assertEquals(run({ file_path: `${root}/music/src/b.ts` }), "deny", task);
      assertEquals(run({ file_path: `${root}/no-origin/c.ts` }), "deny", task);
      assertEquals(run({ command: "printf x > src/d.ts" }, "Bash"), "allow", task);
      assertEquals(run({ command: `printf x > ${root}/music/d.ts` }, "Bash"), "deny", task);
      assertEquals(
        run({ command: `printf x | tee src/e.ts ${root}/music/e.ts` }, "Bash"),
        "deny",
        task,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("fix-pr: a Fable helper needs the same active call to ask for it, through later plain messages", () => {
  const call = "/fix-pr web-jam-tools#1318";
  const cases: [string, TranscriptEntry[], "allow" | "deny"][] = [
    [call + " use a Fable helper", [], "allow"],
    [call + " use a Fable helper", [human("go ahead")], "allow"],
    [call + " dispatch to a Fable subagent", [], "allow"],
    [call, [], "deny"],
    [call + " use Fable", [], "deny"],
    [call + " do not use a Fable helper", [], "deny"],
    [call + " use a Sonnet helper", [], "deny"],
  ];
  for (const [text, later, expected] of cases) {
    const entries = [human(text), ...later, spawn("toolu_fix")];
    const read = reader({
      [MAIN]: jsonl(entries),
      ...meta("fix", { model: "fable", toolUseId: "toolu_fix" }),
      ...meta("nested", { model: "fable", parentAgentId: "fix" }),
    });
    for (const id of ["fix", "nested"]) {
      assertEquals(decideSubagentEdit(id, MAIN, read).decision, expected, text);
    }
  }
  for (const later of [human(PR_REVIEW), human(call), human(call + " use a Fable helper")]) {
    const read = reader({
      [MAIN]: jsonl([human(call + " use a Fable helper"), spawn("toolu_fix"), later]),
      ...meta("fix", { model: "fable", toolUseId: "toolu_fix" }),
    });
    assertEquals(decideSubagentEdit("fix", MAIN, read).decision, "deny");
  }
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
      at([human(OPUS_ISSUE), human("fable edit ok"), assistant("claude-fable-5-2")]),
      noLookup,
    )
      .decision,
    "allow",
  );
  // A /work-issue on an issue Josh labeled Fable chooses Fable; an Opus label does not.
  assertEquals(
    decideMainThreadEdit(
      MAIN,
      at([human(workIssue("web-jam-tools#3")), assistant("claude-fable-5-2")]),
      labels,
    ).decision,
    "allow",
  );
  assertEquals(
    decideMainThreadEdit(MAIN, at([human(OPUS_ISSUE), assistant("claude-fable-5-2")]), labels),
    { decision: "deny", kind: "main", why: "" },
  );
  assertEquals(
    decideMainThreadEdit(MAIN, at([human(SONNET_ISSUE), assistant("claude-fable-5-2")]), labels),
    { decision: "deny", kind: "main", why: "" },
  );
  // An old Opus edit grant, or asking Opus to do the work, never authorizes a Fable edit.
  for (const grant of ["opus edit ok", "use Opus to fix it", "dispatch to an Opus subagent"]) {
    assertEquals(
      decideMainThreadEdit(MAIN, at([human(grant), assistant("claude-fable-5-2")]), labels),
      { decision: "deny", kind: "main", why: "" },
      grant,
    );
  }
  // Josh's withdrawal ends his choice of Fable.
  assertEquals(
    decideMainThreadEdit(
      MAIN,
      at([human("fable edit ok"), human("fable edit off"), assistant("claude-fable-5-2")]),
      noLookup,
    ),
    { decision: "deny", kind: "main", why: "" },
  );
  assertEquals(
    decideMainThreadEdit(
      MAIN,
      at([
        human("fable edit ok"),
        assistant("claude-fable-5-2"),
        notification("<task-notification>x</task-notification>"),
      ]),
      noLookup,
    ).decision,
    "allow",
  );
  const plain = decideMainThreadEdit(
    MAIN,
    at([human("fix it"), assistant("claude-fable-5-2"), notification("fable edit ok")]),
    labels,
  );
  assertEquals(plain, { decision: "deny", kind: "main", why: "" });

  // D-8: a message asking Fable to do the work approves like "fable edit ok" does.
  assertEquals(
    decideMainThreadEdit(
      MAIN,
      at([human("please use FABLE to fix PR 968"), assistant("claude-fable-5-2")]),
      noLookup,
    ).decision,
    "allow",
  );
  assertEquals(
    decideMainThreadEdit(
      MAIN,
      at([human("don't use Fable, fix it"), assistant("claude-fable-5-2")]),
      noLookup,
    ),
    { decision: "deny", kind: "main", why: "" },
  );
  assertEquals(
    decideMainThreadEdit(
      MAIN,
      at([
        human("fix it"),
        assistant("claude-fable-5-2"),
        notification("<task-notification>use Fable</task-notification>"),
      ]),
      noLookup,
    ),
    { decision: "deny", kind: "main", why: "" },
  );
});

Deno.test("decideMainThreadEdit: an Opus session edits directly, with no grant and no label lookup", () => {
  const at = (entries: TranscriptEntry[]) => reader({ [MAIN]: jsonl(entries) });
  const noLookup: LabelLookup = () => {
    throw new Error("an Opus decision must not look up issue labels");
  };
  const sessions: TranscriptEntry[][] = [
    [human("fix it"), assistant("claude-opus-5-5")],
    [human(SONNET_ISSUE), assistant("claude-opus-5-5")],
    [human(PR_REVIEW), assistant("claude-opus-5-5")],
    // An Opus grant withdrawn in an earlier turn no longer matters.
    [human("opus edit ok"), human("opus edit off"), assistant("claude-opus-5-5")],
    [human("don't use Opus, fix it"), assistant("claude-opus-5-5")],
  ];
  for (const entries of sessions) {
    assertEquals(
      decideMainThreadEdit(MAIN, at(entries), noLookup),
      { decision: "allow", kind: "main", why: "" },
      jsonl(entries),
    );
  }
});

Deno.test("decideSubagentEdit: every outcome", () => {
  const main = jsonl([
    human("please fix it"),
    spawn("toolu_plain"),
    human("dispatch to a Fable subagent"),
    spawn("toolu_ok"),
    human("use Fable to fix it"),
    spawn("toolu_ask"),
  ]);
  const files = {
    [MAIN]: main,
    ...meta("s1", { model: "sonnet", toolUseId: "toolu_plain" }),
    ...meta("plain", { model: "fable", toolUseId: "toolu_plain" }),
    ...meta("ok", { model: "fable", toolUseId: "toolu_ok" }),
    ...meta("ask", { model: "fable", toolUseId: "toolu_ask" }),
    ...meta("orphan", { model: "fable", toolUseId: "toolu_missing" }),
    ...meta("opus-helper", { model: "opus", toolUseId: "toolu_plain" }),
    ...meta("opus-orphan", { model: "claude-opus-5-5", toolUseId: "toolu_missing" }),
  };
  const read = reader(files);

  assert(decideSubagentEdit("s1", "", read).why.includes("could not be located"));
  assert(decideSubagentEdit("nobody", MAIN, read).why.includes("model could not be determined"));
  assertEquals(decideSubagentEdit("s1", MAIN, read).decision, "allow");
  assertEquals(decideSubagentEdit("ok", MAIN, read).decision, "allow");
  assertEquals(decideSubagentEdit("ok", `${SUBAGENTS}/agent-ok.jsonl`, read).decision, "allow");
  // D-8: a Fable subagent spawned by "use Fable to fix it" proceeds.
  assertEquals(decideSubagentEdit("ask", MAIN, read).decision, "allow");
  assert(decideSubagentEdit("plain", MAIN, read).why.includes("neither contains"));
  assert(decideSubagentEdit("orphan", MAIN, read).why.includes("could not be found"));
  // An Opus coding helper edits directly, even when Josh's spawning message never named Opus.
  assertEquals(decideSubagentEdit("opus-helper", MAIN, read), {
    decision: "allow",
    kind: "subagent",
    why: "",
  });
  assertEquals(decideSubagentEdit("opus-orphan", MAIN, read).why, "");
});

Deno.test("decide: routes auto-mode subagent calls, exempts other subagent calls, and decides main-thread calls", () => {
  const read = reader({ [MAIN]: jsonl([human(OPUS_ISSUE), assistant("claude-opus-5-5")]) });
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

/**
 * Refusal tests pass this instead of the live workflow switch, so they do not depend on whether Josh
 * has the switch on for this gate on the machine running them.
 */
const noSwitch = (_guard: string) => ({ released: false });

// --- Four literal cases named in 'What this builds' (allow and say so) ---

Deno.test("Case 1: an unreadable transcript allows with note", () => {
  const read = reader({});
  const res = decide({ transcript_path: "/nonexistent/transcript.jsonl" }, read, labels);
  assertEquals(res.decision, "allow");
  assert(res.why.includes("could not be read"));
});

Deno.test("Case 2: missing subagent metadata allows with note", () => {
  const read = reader({ [MAIN]: jsonl([human("fable edit ok"), spawn("toolu_sub")]) });
  const res = decide(
    { agent_id: "missing-meta", permission_mode: "auto", transcript_path: MAIN },
    read,
    labels,
  );
  assertEquals(res.decision, "allow");
  assertEquals(res.kind, "subagent");
  assert(res.why.includes("model could not be determined"));
});

Deno.test("a single-assignment pathlib variable now names the repository file for the Fable decision", () => {
  const read = reader({ [MAIN]: jsonl([human("fix this"), assistant("claude-fable-5-2")]) });
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
    noSwitch,
  );
  assertEquals(res.decision, "deny");
});

Deno.test("Case 4: a read-only command whose quoted text merely contains a write allows with note", () => {
  const read = reader({ [MAIN]: jsonl([human("fix this"), assistant("claude-fable-5-2")]) });
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
  const read = reader({ [MAIN]: jsonl([human("fix this"), assistant("claude-fable-5-2")]) });
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
  const read = reader({ [MAIN]: jsonl([human("fix this"), assistant("claude-fable-5-2")]) });
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
      noSwitch,
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

async function runCli(
  stdin: string,
  env: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const child = new Deno.Command("deno", {
    args: [
      "run",
      "--no-config",
      "--allow-read",
      "--allow-env",
      "--allow-write",
      new URL("../hooks/lib/opus_gate.ts", import.meta.url).pathname,
    ],
    env,
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
      jsonl([human("fable edit ok"), assistant("claude-fable-5-2")]),
    );
    assertEquals((await runCli(JSON.stringify({ transcript_path: transcript }))).decision, "allow");
    const unreadable = await runCli("not json");
    assertEquals(unreadable.decision, "allow");
    assert(typeof unreadable.why === "string" && unreadable.why.length > 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Workflow switch unit tests (web-jam-tools#1046) ---

Deno.test("decide: switchChecker releasing allows an otherwise-denied edit", () => {
  const read: ReadText = (p) =>
    p === "sess.jsonl" ? jsonl([human("no phrase"), assistant("claude-fable-5-2")]) : null;

  const releasedChecker = (guard: string) => ({
    released: guard === "opus-delegation-gate",
    reason: "Released by test switch.",
  });

  const res = decide(
    { transcript_path: "sess.jsonl", tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
    read,
    () => null,
    releasedChecker,
  );
  assertEquals(res.decision, "allow");
  assertEquals(res.why, "Released by test switch.");

  const unreleasedChecker = (_guard: string) => ({ released: false });
  const deniedRes = decide(
    { transcript_path: "sess.jsonl", tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
    read,
    () => null,
    unreleasedChecker,
  );
  assertEquals(deniedRes.decision, "deny");
});

Deno.test("CLI: unexpired switch releases otherwise-denied payload and logs release", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const transcript = `${dir}/sess.jsonl`;
    const switchPath = `${dir}/switch.json`;
    const logPath = `${dir}/switch.log`;
    await Deno.writeTextFile(
      transcript,
      jsonl([human("no approval"), assistant("claude-fable-5-2")]),
    );
    await Deno.writeTextFile(
      switchPath,
      JSON.stringify({
        guard: "opus-delegation-gate",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    );

    const payload = JSON.stringify({
      transcript_path: transcript,
      tool_name: "Edit",
      tool_input: { file_path: "src/a.ts" },
    });
    const res = await runCli(payload, {
      WORKFLOW_SWITCH_PATH: switchPath,
      WORKFLOW_SWITCH_LOG_PATH: logPath,
    });
    assertEquals(res.decision, "allow");
    assert(typeof res.why === "string" && res.why.includes("opus-delegation-gate"));

    const log = await Deno.readTextFile(logPath);
    assert(log.includes("released guard: opus-delegation-gate"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
