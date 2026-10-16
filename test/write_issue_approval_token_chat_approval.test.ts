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
  titles: readonly string[] = TITLES,
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
      ...titles.flatMap((title) => ["--title", title]),
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

// --- Review fixes (web-jam-tools#1054): refusal spacing, complete titles, a multi-message turn ---

const IRREGULAR_REFUSALS = [
  "do  not file it",
  "do\tnot file it",
  "do\nnot file it",
  "do not file it",
  "hold  off",
  "hold\noff for now",
  "not  yet",
  "not\nyet",
  "  Do   Not file those",
];

Deno.test("chat approval: refusal phrases tolerate any whitespace between their words", () => {
  for (const reply of IRREGULAR_REFUSALS) {
    assertEquals(
      replyOpensWithRefusal(reply),
      true,
      `reply ${JSON.stringify(reply)} must read as a refusal`,
    );
    assertEquals(
      authorize(titlesThenReply(reply)).ok,
      false,
      `reply ${JSON.stringify(reply)} must refuse`,
    );
  }
});

Deno.test("chat approval: irregular spacing does not turn a longer word into a refusal", () => {
  for (const reply of ["do notate it, go", "hold offices are fine, go", "not yetis, go"]) {
    assertEquals(
      replyOpensWithRefusal(reply),
      false,
      `reply ${JSON.stringify(reply)} must not read as a refusal`,
    );
  }
});

Deno.test("CLI chat approval: refusals with irregular spacing refuse and write nothing", async () => {
  for (const reply of ["do  not file it", "hold\noff for now", "not\tyet"]) {
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

const LONG_TITLE = "Fix approval token validation";

/** A transcript where the agent's only message is `shown`, then Josh replies "yes, go". */
function showThenApprove(shown: string): TranscriptEntry[] {
  return [human("plan it"), assistant(shown), human("yes, go")];
}

Deno.test("chat approval: a shortened title is not the complete title that was shown", () => {
  const shownForms = [
    `Proposed title: "${LONG_TITLE}"`,
    `1. ${LONG_TITLE}`,
    `| 1 | ${LONG_TITLE} | Sonnet |`,
    `Title: \`${LONG_TITLE}\``,
  ];
  for (const shown of shownForms) {
    for (
      const shortened of [
        "approval token",
        "Fix approval token",
        "approval token validation",
        "Fix",
      ]
    ) {
      assertEquals(
        authorize(showThenApprove(shown), [shortened]).ok,
        false,
        `${JSON.stringify(shortened)} inside ${JSON.stringify(shown)} must refuse`,
      );
    }
    assertEquals(
      authorize(showThenApprove(shown), [LONG_TITLE]).ok,
      true,
      `${JSON.stringify(shown)} shows the complete title`,
    );
  }
});

Deno.test("chat approval: a title longer than the one shown is not shown", () => {
  assertEquals(
    authorize(showThenApprove(`1. ${LONG_TITLE}`), [`${LONG_TITLE} and more`]).ok,
    false,
  );
});

Deno.test("chat approval: an unquoted title in the middle of a sentence is not shown", () => {
  assertEquals(
    authorize(showThenApprove(`I will file ${LONG_TITLE} next.`), [LONG_TITLE]).ok,
    false,
  );
});

Deno.test("chat approval: a quoted or code-formatted span inside a longer title is not a title of its own", () => {
  const innerTitle = "approval token";
  for (
    const shown of [
      `1. Fix \`${innerTitle}\` validation`,
      `Proposed title: "Fix \`${innerTitle}\` validation"`,
      `- Fix **${innerTitle}** validation`,
      `Fix "${innerTitle}" validation`,
      `Fix validation of the \`${innerTitle}\``,
      `Then \`${innerTitle}\` is checked`,
      // Punctuation on both sides of the span does not set it off from the title that encloses it.
      `Proposed title: "hooks: \`${innerTitle}\` — validation"`,
      `Proposed title: "hooks: \`${innerTitle}\`, validation"`,
      `1. hooks: \`${innerTitle}\` — validation`,
      `Title: hooks: "${innerTitle}"`,
      `Title: "hooks" — "${innerTitle}"`,
      `- Title: **hooks** (\`${innerTitle}\`)`,
      // A title that merely contains the word "title" is not a presentation label plus a title.
      `1. Fix issue title: "${innerTitle}"`,
      `Fix issue title: "${innerTitle}"`,
      `- Update the title: \`${innerTitle}\``,
      `## Rename proposed title: **${innerTitle}**`,
      `Retitle: "${innerTitle}"`,
    ]
  ) {
    assertEquals(
      authorize(showThenApprove(shown), [innerTitle]).ok,
      false,
      `${JSON.stringify(innerTitle)} inside ${JSON.stringify(shown)} must refuse`,
    );
  }
  // The complete longer title, with its inner span kept as content, still matches.
  const longer = `Fix \`${innerTitle}\` validation`;
  assertEquals(authorize(showThenApprove(`1. ${longer}`), [longer]).ok, true);
  assertEquals(authorize(showThenApprove(`Proposed title: "${longer}"`), [longer]).ok, true);
  // So does a longer title whose inner span sits between punctuation.
  const punctuated = `hooks: \`${innerTitle}\` — validation`;
  assertEquals(
    authorize(showThenApprove(`Proposed title: "${punctuated}"`), [punctuated]).ok,
    true,
  );
  assertEquals(authorize(showThenApprove(`1. ${punctuated}`), [punctuated]).ok, true);
  // The complete list-item title is the displayed field, label-like words and all.
  const titleWord = `Fix issue title: "${innerTitle}"`;
  assertEquals(authorize(showThenApprove(`1. ${titleWord}`), [titleWord]).ok, true);
  // Explicit presentation labels still introduce a wrapped title.
  for (
    const shown of [
      `Title: "${innerTitle}"`,
      `Proposed title: **${innerTitle}**`,
      `- Title 2: \`${innerTitle}\``,
      `3. Issue title (3): "${innerTitle}"`,
      `suggested title #1: "${innerTitle}"`,
    ]
  ) {
    assertEquals(
      authorize(showThenApprove(shown), [innerTitle]).ok,
      true,
      `${JSON.stringify(shown)} labels the title`,
    );
  }
  // A trailing full stop after the wrapped title is sentence punctuation, not title content.
  assertEquals(
    authorize(showThenApprove(`Proposed title: "${LONG_TITLE}".`), [LONG_TITLE]).ok,
    true,
  );
});

Deno.test("chat approval: a quoted title in the middle of a sentence is not shown", () => {
  assertEquals(
    authorize(showThenApprove(`Filing \`${LONG_TITLE}\` next`), [LONG_TITLE]).ok,
    false,
  );
});

Deno.test("chat approval: a complete title in quotes, bold, a bullet, a heading or a table cell is shown", () => {
  for (
    const shown of [
      `“${LONG_TITLE}”`,
      `'${LONG_TITLE}'`,
      `**${LONG_TITLE}**`,
      `- ${LONG_TITLE}`,
      `> ${LONG_TITLE}`,
      `## ${LONG_TITLE}`,
      `1) ${LONG_TITLE}`,
      `| # | Proposed title |\n|---|---|\n| 1 | ${LONG_TITLE} |`,
    ]
  ) {
    assertEquals(
      authorize(showThenApprove(shown), [LONG_TITLE]).ok,
      true,
      `${JSON.stringify(shown)} shows the complete title`,
    );
  }
});

Deno.test("CLI chat approval: a shortened title is refused, the complete title writes", async () => {
  const transcript = showThenApprove(`Proposed title: "${LONG_TITLE}"`);
  const shortened = await runWriter(transcript, ["approval token"]);
  try {
    assertEquals(shortened.code, 1);
    assertStringIncludes(shortened.stderr, "Refused to write approval token");
    assertEquals(await exists(shortened.tokenPath), false);
  } finally {
    await Deno.remove(shortened.dir, { recursive: true });
  }
  const full = await runWriter(transcript, [LONG_TITLE]);
  try {
    assertEquals(full.code, 0, full.stderr);
    assertEquals(JSON.parse(await Deno.readTextFile(full.tokenPath)).titles, [LONG_TITLE]);
  } finally {
    await Deno.remove(full.dir, { recursive: true });
  }
});

/** A tool result, which Claude Code records as a user entry that is not a prompt from a person. */
function toolResult(): TranscriptEntry {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
    },
  } as TranscriptEntry;
}

Deno.test("chat approval: titles shown across several assistant messages in one turn count", () => {
  const entries = [
    human("plan the two fixes"),
    assistant(`First:\n1. ${TITLE_A}`),
    toolResult(),
    assistant(`Second:\n2. ${TITLE_B}\nShall I file these?`),
    human("yes, go"),
  ];
  const result = authorize(entries);
  assertEquals(result.ok, true);
  assertEquals(result.via, "chat-approval");
});

Deno.test("chat approval: titles split across turns, or into a subagent's sidechain, still refuse", () => {
  // The first title is before an earlier prompt of Josh's, so it belongs to a previous turn.
  assertEquals(
    authorize([
      human("plan it"),
      assistant(`1. ${TITLE_A}`),
      human("and the second?"),
      assistant(`2. ${TITLE_B}`),
      human("yes, go"),
    ]).ok,
    false,
  );
  // The second title is a subagent's sidechain message, not the session's own turn.
  assertEquals(
    authorize([
      human("plan it"),
      assistant(`1. ${TITLE_A}`),
      assistant(`2. ${TITLE_B}`, { isSidechain: true }),
      human("yes, go"),
    ]).ok,
    false,
  );
});

Deno.test("chat approval: Antigravity titles shown across two model messages count", () => {
  const agy = (type: string, source: string, step: number, content: string) =>
    ({ type, source, step_index: step, content, conversationId: "conv-1" }) as TranscriptEntry;
  const result = checkTokenWriteAuthorization({
    entries: [
      agy("USER_INPUT", "USER_EXPLICIT", 0, "<USER_REQUEST>plan it</USER_REQUEST>"),
      agy("PLANNER_RESPONSE", "MODEL", 1, `1. ${TITLE_A}`),
      agy("PLANNER_RESPONSE", "MODEL", 2, `2. ${TITLE_B}`),
      agy("USER_INPUT", "USER_EXPLICIT", 3, "<USER_REQUEST>yes, go</USER_REQUEST>"),
    ],
    ownConversationId: "conv-1",
    isSubagentInvocation: false,
    titles: TITLES,
  });
  assertEquals(result.ok, true);
  assertEquals(result.via, "chat-approval");
});

Deno.test("CLI chat approval: a formatted fragment inside a longer title is refused, the longer title writes", async () => {
  const longer = "Fix `approval token` validation";
  const transcript = showThenApprove(`1. ${longer}`);
  const fragment = await runWriter(transcript, ["approval token"]);
  try {
    assertEquals(fragment.code, 1);
    assertStringIncludes(fragment.stderr, "Refused to write approval token");
    assertEquals(await exists(fragment.tokenPath), false);
  } finally {
    await Deno.remove(fragment.dir, { recursive: true });
  }
  const full = await runWriter(transcript, [longer]);
  try {
    assertEquals(full.code, 0, full.stderr);
    assertEquals(JSON.parse(await Deno.readTextFile(full.tokenPath)).titles, [longer]);
  } finally {
    await Deno.remove(full.dir, { recursive: true });
  }
});

Deno.test("CLI chat approval: a list title that contains the word title is not split at its colon", async () => {
  const longer = 'Fix issue title: "approval token"';
  const transcript = showThenApprove(`1. ${longer}`);
  const fragment = await runWriter(transcript, ["approval token"]);
  try {
    assertEquals(fragment.code, 1);
    assertStringIncludes(fragment.stderr, "Refused to write approval token");
    assertEquals(await exists(fragment.tokenPath), false);
  } finally {
    await Deno.remove(fragment.dir, { recursive: true });
  }
  const full = await runWriter(transcript, [longer]);
  try {
    assertEquals(full.code, 0, full.stderr);
    assertEquals(JSON.parse(await Deno.readTextFile(full.tokenPath)).titles, [longer]);
  } finally {
    await Deno.remove(full.dir, { recursive: true });
  }
});

Deno.test("CLI chat approval: a span between punctuation inside a longer title is refused, the longer title writes", async () => {
  const longer = "hooks: `approval token` — validation";
  const transcript = showThenApprove(`Proposed title: "${longer}"`);
  const fragment = await runWriter(transcript, ["approval token"]);
  try {
    assertEquals(fragment.code, 1);
    assertStringIncludes(fragment.stderr, "Refused to write approval token");
    assertEquals(await exists(fragment.tokenPath), false);
  } finally {
    await Deno.remove(fragment.dir, { recursive: true });
  }
  const full = await runWriter(transcript, [longer]);
  try {
    assertEquals(full.code, 0, full.stderr);
    assertEquals(JSON.parse(await Deno.readTextFile(full.tokenPath)).titles, [longer]);
  } finally {
    await Deno.remove(full.dir, { recursive: true });
  }
});

Deno.test("CLI chat approval: titles shown across two assistant messages write the token", async () => {
  const r = await runWriter([
    human("plan the two fixes"),
    assistant(`First:\n1. ${TITLE_A}`),
    toolResult(),
    assistant(`Second:\n2. ${TITLE_B}`),
    human("yes, go"),
  ]);
  try {
    assertEquals(r.code, 0, r.stderr);
    assertEquals(JSON.parse(await Deno.readTextFile(r.tokenPath)).titles, TITLES);
  } finally {
    await Deno.remove(r.dir, { recursive: true });
  }
});
