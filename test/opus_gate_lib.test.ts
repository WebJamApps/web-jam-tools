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

Deno.test("asksOpusToDoTheWork: a verb naming Opus as the one to do the work, negated by a preceding not/don't/never/no", () => {
  assert(
    asksOpusToDoTheWork(
      "please use OPUS to fix https://github.com/WebJamApps/web-jam-tools/pull/968",
    ),
  );
  assert(asksOpusToDoTheWork("have Opus fix it"));
  assert(asksOpusToDoTheWork("using opus for this"));
  assert(asksOpusToDoTheWork("let an Opus agent do it"));
  assert(asksOpusToDoTheWork("fix it with Opus"));

  assert(!asksOpusToDoTheWork("don't use Opus"));
  assert(!asksOpusToDoTheWork("do not use opus"));
  assert(!asksOpusToDoTheWork("never have Opus edit"));
  assert(!asksOpusToDoTheWork("Opus ate my tokens, did not delegate to Sonnet"));
  assert(!asksOpusToDoTheWork("use Sonnet not Opus"));
  assert(!asksOpusToDoTheWork("opus is fine here"));

  assert(approvesOpusSubagent("please use OPUS to fix it"));
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

  assertEquals(decideMainThreadEdit("", reader({}), noLookup).decision, "deny");
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
  assertEquals(decide({}, read, labels).decision, "deny");
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
    await Deno.writeTextFile(
      transcript,
      jsonl([human("opus edit ok"), assistant("claude-opus-5")]),
    );
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
