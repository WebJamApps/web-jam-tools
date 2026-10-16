// write_issue_approval_token_chat_approval.test.ts — web-jam-tools#1054 (design decision D-35)
//
// The token writer recognises Josh's approval given in chat: his latest reply follows the agent
// showing every exact title and does not open with a refusal word, with no /design-issue or
// /file-issue invocation. Unit tests drive checkTokenWriteAuthorization() with injected entries;
// the CLI tests run the real script against a fixture transcript through the test-only env seam
// (web-jam-tools#866), the same way test/write_issue_approval_token.test.ts does.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkTokenWriteAuthorization,
  replyOpensWithRefusal,
} from "../hooks/lib/check_token_write_authorization.ts";
import type { TranscriptEntry } from "../hooks/lib/select_transcript_entry.ts";

const SCRIPT_PATH = new URL(
  "../scripts/write_issue_approval_token.ts",
  import.meta.url,
).pathname;

const TITLE_A = "hooks/lib: accept a subagent filing under the approving session";
const TITLE_B = "scripts/write_issue_approval_token: approve filing on a plain yes";
const TITLES = [TITLE_A, TITLE_B];

function human(text: string): TranscriptEntry {
  return { type: "user", origin: { kind: "human" }, message: { role: "user", content: text } };
}

function assistant(text: string, extra: Record<string, unknown> = {}): TranscriptEntry {
  return { type: "assistant", message: { role: "assistant", content: text }, ...extra };
}

/** A transcript where the agent lists both titles and Josh then sends `reply`. */
function titlesThenReply(reply: string): TranscriptEntry[] {
  return [
    human("plan the two fixes"),
    assistant(`Plan:\n1. ${TITLE_A}\n2. ${TITLE_B}\nShall I file these?`),
    human(reply),
  ];
}

/** `titles` defaults to the approved pair; pass `null` to supply none at all. */
function authorize(entries: TranscriptEntry[], titles: string[] | null = TITLES) {
  return checkTokenWriteAuthorization({
    entries,
    ownConversationId: "sess-1",
    isSubagentInvocation: false,
    titles: titles ?? undefined,
  });
}

Deno.test("chat approval: a plain 'yes, go' after the exact titles were shown writes (D-35)", () => {
  const result = authorize(titlesThenReply("yes, go"));
  assertEquals(result.ok, true);
  assertEquals(result.via, "chat-approval");
});

Deno.test("chat approval: a reply opening with each refusal word refuses", () => {
  for (
    const reply of [
      "no, hold off",
      "nope",
      "nah",
      "don't file those",
      "don’t file those",
      "do not file those",
      "stop",
      "never mind",
      "cancel that",
      "hold off for now",
      "wait, change title two",
      "not yet",
      "No.",
      "  NO ",
      "no-go",
    ]
  ) {
    const result = authorize(titlesThenReply(reply));
    assertEquals(result.ok, false, `reply ${JSON.stringify(reply)} must refuse`);
  }
});

Deno.test("chat approval: a refusal word later in the reply, or as the start of a longer word, is not a refusal", () => {
  for (
    const reply of [
      "yes, and do not forget the label",
      "go ahead, no changes needed",
      "nothing to add, file them",
      "notes look fine, go",
      "waiting on nothing, go",
      "stopping by later; yes file them",
      "nahh",
    ]
  ) {
    assertEquals(
      replyOpensWithRefusal(reply),
      false,
      `reply ${JSON.stringify(reply)} must not read as a refusal`,
    );
  }
  assertEquals(authorize(titlesThenReply("nothing to add, file them")).ok, true);
});

Deno.test("chat approval: titles never shown refuses even when Josh says 'yes file it'", () => {
  const entries = [
    human("we should fix the guard"),
    assistant("I could file an issue for the guard, want me to?"),
    human("yes file it"),
  ];
  // "yes file it" would also open a natural-language filing skill, but only through the
  // FILE_ISSUE_INVOCATION_RE shape ("file it" is not "file an issue"), so it must refuse.
  assertEquals(authorize(entries).ok, false);
});

Deno.test("chat approval: only some of the titles shown refuses", () => {
  const entries = [
    human("plan it"),
    assistant(`Plan:\n1. ${TITLE_A}`),
    human("yes, go"),
  ];
  assertEquals(authorize(entries).ok, false);
});

Deno.test("chat approval: a title shown in an earlier turn, not the turn before the reply, refuses", () => {
  const entries = [
    human("plan it"),
    assistant(`Plan:\n1. ${TITLE_A}\n2. ${TITLE_B}`),
    human("what does the second one cover?"),
    assistant("It lets a plain yes approve filing."),
    human("ok, go"),
  ];
  assertEquals(authorize(entries).ok, false);
});

Deno.test("chat approval: titles the agent says only after Josh's reply do not count", () => {
  const entries = [
    human("go ahead"),
    assistant(`Filing now:\n1. ${TITLE_A}\n2. ${TITLE_B}`),
  ];
  assertEquals(authorize(entries).ok, false);
});

Deno.test("chat approval: titles shown by a subagent's sidechain turn do not count", () => {
  const entries = [
    human("plan it"),
    assistant(`Plan:\n1. ${TITLE_A}\n2. ${TITLE_B}`, { isSidechain: true }),
    human("yes, go"),
  ];
  assertEquals(authorize(entries).ok, false);
});

Deno.test("chat approval: a reply that is not a human prompt (hook or task injection) does not approve", () => {
  const entries = [
    human("plan it"),
    assistant(`Plan:\n1. ${TITLE_A}\n2. ${TITLE_B}`),
    { type: "user", isMeta: true, message: { role: "user", content: "yes, go" } },
  ] as TranscriptEntry[];
  assertEquals(authorize(entries).ok, false);
});

Deno.test("chat approval: a reply that invokes another skill is not an approval", () => {
  assertEquals(authorize(titlesThenReply("/work-issue web-jam-tools#1054")).ok, false);
});

Deno.test("chat approval: an empty transcript or an empty reply refuses", () => {
  assertEquals(authorize([]).ok, false);
  assertEquals(authorize(titlesThenReply("   ")).ok, false);
});

Deno.test("chat approval: a dispatched subagent still never writes, whatever Josh said", () => {
  const result = checkTokenWriteAuthorization({
    entries: titlesThenReply("yes, go"),
    ownConversationId: "sess-1",
    isSubagentInvocation: true,
    titles: TITLES,
  });
  assertEquals(result.ok, false);
  assertStringIncludes(result.reason ?? "", "subagent");
});

Deno.test("chat approval: an undetermined session identity still refuses", () => {
  const result = checkTokenWriteAuthorization({
    entries: titlesThenReply("yes, go"),
    ownConversationId: null,
    isSubagentInvocation: false,
    titles: TITLES,
  });
  assertEquals(result.ok, false);
});

Deno.test("chat approval: without titles supplied, only a filing skill invocation authorizes (unchanged)", () => {
  assertEquals(authorize(titlesThenReply("yes, go"), null).ok, false);
});

Deno.test("chat approval: a filing skill invocation still authorizes, with no chat marker", () => {
  const withSkill = authorize([...titlesThenReply("no"), human("/file-issue go")]);
  assertEquals(withSkill.ok, true);
  assertEquals(withSkill.skill, "file-issue");
  assertEquals(withSkill.via, undefined);
});

Deno.test("chat approval: a refusal reply after an earlier skill invocation is judged on the skill scan alone", () => {
  // The skill scan is unchanged: the earlier /design-issue turn still authorizes the write, exactly
  // as it did before chat approval existed. Chat approval only adds a way in, it never takes one away.
  const result = authorize([human("/design-issue plan it"), ...titlesThenReply("no")]);
  assertEquals(result.ok, true);
  assertEquals(result.skill, "design-issue");
});

Deno.test("chat approval: Antigravity shape, own-conversation prompt and model turn, approves", () => {
  const agy = (type: string, source: string, step: number, content: string, conv = "conv-1") =>
    ({
      type,
      source,
      step_index: step,
      content,
      conversationId: conv,
    }) as TranscriptEntry;
  const entries = [
    agy("USER_INPUT", "USER_EXPLICIT", 0, "<USER_REQUEST>plan it</USER_REQUEST>"),
    agy("PLANNER_RESPONSE", "MODEL", 1, `Plan:\n1. ${TITLE_A}\n2. ${TITLE_B}`),
    agy("USER_INPUT", "USER_EXPLICIT", 2, "<USER_REQUEST>yes, go</USER_REQUEST>"),
  ];
  const ok = checkTokenWriteAuthorization({
    entries,
    ownConversationId: "conv-1",
    isSubagentInvocation: false,
    titles: TITLES,
  });
  assertEquals(ok.ok, true);
  assertEquals(ok.via, "chat-approval");

  const refused = checkTokenWriteAuthorization({
    entries: [...entries.slice(0, 2), agy("USER_INPUT", "USER_EXPLICIT", 2, "no, hold off")],
    ownConversationId: "conv-1",
    isSubagentInvocation: false,
    titles: TITLES,
  });
  assertEquals(refused.ok, false);

  const otherConversation = checkTokenWriteAuthorization({
    entries,
    ownConversationId: "conv-2",
    isSubagentInvocation: false,
    titles: TITLES,
  });
  assertEquals(otherConversation.ok, false);
});

// --- CLI: the real script against a fixture transcript -----------------------------------------

async function runWriter(
  entries: TranscriptEntry[] | null,
): Promise<{ code: number; stdout: string; stderr: string; tokenPath: string; dir: string }> {
  const dir = await Deno.makeTempDir();
  const transcript = `${dir}/transcript.jsonl`;
  const tokenPath = `${dir}/token.json`;
  if (entries) {
    await Deno.writeTextFile(transcript, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  const cmd = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-write",
      SCRIPT_PATH,
      "--session-id",
      "sess-chat-1",
      "--repo",
      "WebJamApps/web-jam-tools",
      "--title",
      TITLE_A,
      "--title",
      TITLE_B,
      "--token-path",
      tokenPath,
    ],
    stdout: "piped",
    stderr: "piped",
    env: {
      ...Deno.env.toObject(),
      WRITE_ISSUE_APPROVAL_TOKEN_TEST_TRANSCRIPT_PATH: transcript,
      WRITE_ISSUE_APPROVAL_TOKEN_TEST_CONVERSATION_ID: "sess-chat-1",
    },
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    tokenPath,
    dir,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("CLI chat approval: reply 'yes, go' after the titles were shown writes the token", async () => {
  const r = await runWriter(titlesThenReply("yes, go"));
  try {
    assertEquals(r.code, 0, r.stderr);
    assert(await exists(r.tokenPath));
    const token = JSON.parse(await Deno.readTextFile(r.tokenPath));
    assertEquals(token.titles, TITLES);
    assertEquals(token.session_id, "sess-chat-1");
  } finally {
    await Deno.remove(r.dir, { recursive: true });
  }
});

Deno.test("CLI chat approval: reply 'no, hold off' and reply 'nah' refuse and write nothing", async () => {
  for (const reply of ["no, hold off", "nah"]) {
    const r = await runWriter(titlesThenReply(reply));
    try {
      assertEquals(r.code, 1, `reply ${JSON.stringify(reply)} must exit 1`);
      assertStringIncludes(r.stderr, "Refused to write approval token");
      assertEquals(await exists(r.tokenPath), false);
    } finally {
      await Deno.remove(r.dir, { recursive: true });
    }
  }
});

Deno.test("CLI chat approval: an unreadable transcript refuses and writes nothing", async () => {
  const r = await runWriter(null);
  try {
    assertEquals(r.code, 1);
    assertStringIncludes(r.stderr, "Refused to write approval token");
    assertEquals(await exists(r.tokenPath), false);
  } finally {
    await Deno.remove(r.dir, { recursive: true });
  }
});

Deno.test("CLI chat approval: titles never shown, Josh says 'yes file it', refuses and writes nothing", async () => {
  const r = await runWriter([
    human("we should fix the guard"),
    assistant("I could file an issue for the guard, want me to?"),
    human("yes file it"),
  ]);
  try {
    assertEquals(r.code, 1);
    assertEquals(await exists(r.tokenPath), false);
  } finally {
    await Deno.remove(r.dir, { recursive: true });
  }
});
