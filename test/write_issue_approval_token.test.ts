// write_issue_approval_token.test.ts — web-jam-tools#595
//
// Unit tests and round-trip integration tests for scripts/write_issue_approval_token.ts
// validating that the written approval token is accepted by
// hooks/lib/check_issue_approval_token.ts and hooks/require-approval-token-on-issue-write.sh.
//
// web-jam-tools#808: the CLI block now refuses to write at all unless
// hooks/lib/check_token_write_authorization.ts's decision 21 check passes, so every CLI-level test
// below that expects a successful write supplies the WRITE_ISSUE_APPROVAL_TOKEN_TEST_TRANSCRIPT_PATH/
// WRITE_ISSUE_APPROVAL_TOKEN_TEST_CONVERSATION_ID test-only env seam (web-jam-tools#866 — there is
// deliberately no CLI flag for this; see the seam's doc comment in
// scripts/write_issue_approval_token.ts) pointing at a fixture transcript carrying an authorizing
// /file-issue or /design-issue turn (see writeAuthorizingTranscriptFixture below) — a plain CLI
// invocation with nothing authorizing it is exactly what "CLI: refuses ..." further down exercises.
// web-jam-tools#920: some fixtures below carry Claude Code's `<command-name>` slash-invocation
// wrapper instead of bare `/file-issue` text, because that is what the surface actually stores for a
// typed slash command — see the "Claude Code's <command-name> slash-invocation wrapper" block.
// buildApprovalToken/writeApprovalToken/
// writeApprovalTokenSync stay unauthorized on purpose (see file header on scripts/
// write_issue_approval_token.ts) so the pre-existing unit tests of those three functions are
// unchanged below.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  authorizeWrite,
  buildApprovalToken,
  resolveClaudeCodeWriteContext,
  writeApprovalToken,
  writeApprovalTokenSync,
} from "../scripts/write_issue_approval_token.ts";
import { checkIssueApprovalToken, loadToken } from "../hooks/lib/check_issue_approval_token.ts";
import {
  checkTokenWriteAuthorization,
  filingSkillInvoked,
  MAX_AUTHORIZING_USER_TURNS,
  nonFilingSlashCommandInvoked,
  tailIsCurrentlySidechain,
} from "../hooks/lib/check_token_write_authorization.ts";
import type { TranscriptEntry } from "../hooks/lib/select_transcript_entry.ts";

const SCRIPT_PATH = new URL(
  "../scripts/write_issue_approval_token.ts",
  import.meta.url,
).pathname;

const HOOK_PATH = new URL(
  "../hooks/require-approval-token-on-issue-write.sh",
  import.meta.url,
).pathname;

async function runCli(
  args: string[],
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-write",
      SCRIPT_PATH,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
    // clearEnv is required for `env` to actually override an inherited var — otherwise
    // Deno.Command MERGES `env` with the parent's environment rather than replacing it, so a
    // deleted key here would still show up in the child from ambient inheritance.
    ...(env ? { env, clearEnv: true } : {}),
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

/** Merges `extra` on top of this test process's own inherited env, for a runCli() call that needs
 * to ADD env vars (e.g. the WRITE_ISSUE_APPROVAL_TOKEN_TEST_TRANSCRIPT_PATH seam) without losing
 * ambient inheritance — runCli's clearEnv:true means passing `extra` alone would drop everything
 * else the child process needs (PATH, HOME, etc). */
function envWith(extra: Record<string, string>): Record<string, string> {
  return { ...Deno.env.toObject(), ...extra };
}

/** Env for a CLI test that must NOT inherit this real Claude Code session's own ambient
 * CLAUDE_CODE_SESSION_ID/CLAUDE_SESSION_ID/SESSION_ID — used only by tests that deliberately omit
 * --session-id and would otherwise silently pick up this test run's own real session id. */
function envWithoutAmbientSessionId(): Record<string, string> {
  const env = Deno.env.toObject();
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.SESSION_ID;
  return env;
}

/**
 * Writes a fixture transcript (JSONL, Claude Code shape) to `dir`, and returns the
 * WRITE_ISSUE_APPROVAL_TOKEN_TEST_TRANSCRIPT_PATH/_TEST_CONVERSATION_ID env vars (web-jam-tools#866
 * test-only seam — there is deliberately no CLI flag for this) ready to merge via envWith() into a
 * runCli() call's env. Claude Code-shaped entries ignore the conversation id entirely
 * (isOwnSessionUserTurnBoundary delegates straight to isUserTurnBoundary for them), so the value
 * only matters for the Antigravity-shaped fixtures used further down.
 */
async function writeAuthorizingTranscriptFixture(
  dir: string,
  text: string,
  opts?: { sidechainTail?: boolean },
): Promise<Record<string, string>> {
  const path = `${dir}/transcript.jsonl`;
  const lines: unknown[] = [
    { type: "user", message: { role: "user", content: text } },
  ];
  if (opts?.sidechainTail) {
    lines.push({
      type: "assistant",
      isSidechain: true,
      message: { role: "assistant", content: "working on the delegated task" },
    });
  }
  await Deno.writeTextFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return {
    WRITE_ISSUE_APPROVAL_TOKEN_TEST_TRANSCRIPT_PATH: path,
    WRITE_ISSUE_APPROVAL_TOKEN_TEST_CONVERSATION_ID: "test-conv",
  };
}

async function runHook(
  payload: Record<string, unknown>,
  tokenPath: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const input = JSON.stringify(payload);
  const cmd = new Deno.Command("bash", {
    args: [HOOK_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject(), ISSUE_APPROVAL_TOKEN_PATH: tokenPath },
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

// --- buildApprovalToken unit tests ---

Deno.test("buildApprovalToken: builds valid token with defaults", () => {
  const token = buildApprovalToken({
    sessionId: "sess-123",
    repo: "web-jam-tools",
    titles: ["Fix bug A", "Add feature B"],
  });

  assertEquals(token.session_id, "sess-123");
  assertEquals(token.repo, "WebJamApps/web-jam-tools");
  assertEquals(token.titles, ["Fix bug A", "Add feature B"]);
  const expMs = Date.parse(token.expires_at);
  assertEquals(Number.isNaN(expMs), false);
  assert(expMs > Date.now() + 3 * 3600_000);
});

Deno.test("buildApprovalToken: preserves existing owner in repo string", () => {
  const token = buildApprovalToken({
    sessionId: "sess-123",
    repo: "CustomOwner/my-repo",
    titles: ["Title 1"],
  });
  assertEquals(token.repo, "CustomOwner/my-repo");
});

Deno.test("buildApprovalToken: honors custom explicit expiresAt", () => {
  const customIso = "2028-01-01T00:00:00.000Z";
  const token = buildApprovalToken({
    sessionId: "sess-123",
    repo: "web-jam-tools",
    titles: ["Title 1"],
    expiresAt: customIso,
  });
  assertEquals(token.expires_at, customIso);
});

Deno.test("buildApprovalToken: throws on missing or empty sessionId", () => {
  assertThrows(
    () => buildApprovalToken({ sessionId: "", repo: "web-jam-tools", titles: ["T1"] }),
    Error,
    "sessionId",
  );
});

Deno.test("buildApprovalToken: throws on missing or empty repo", () => {
  assertThrows(
    () => buildApprovalToken({ sessionId: "sess-1", repo: "", titles: ["T1"] }),
    Error,
    "repo",
  );
});

Deno.test("buildApprovalToken: throws on empty titles array", () => {
  assertThrows(
    () => buildApprovalToken({ sessionId: "sess-1", repo: "web-jam-tools", titles: [] }),
    Error,
    "titles",
  );
  assertThrows(
    () => buildApprovalToken({ sessionId: "sess-1", repo: "web-jam-tools", titles: ["  ", ""] }),
    Error,
    "titles",
  );
});

Deno.test("buildApprovalToken: throws on unparseable expiresAt", () => {
  assertThrows(
    () =>
      buildApprovalToken({
        sessionId: "sess-1",
        repo: "web-jam-tools",
        titles: ["T1"],
        expiresAt: "not-a-date",
      }),
    Error,
    "Invalid expiresAt",
  );
});

// --- writeApprovalToken & writeApprovalTokenSync unit tests ---

Deno.test("writeApprovalToken: writes valid token file and creates parent directories", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/nested/subdir/issue-approval-token.json`;
  try {
    const { token, path } = await writeApprovalToken({
      sessionId: "session-xyz",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Approved title 1", "Approved title 2"],
      tokenPath,
    });

    assertEquals(path, tokenPath);
    assertEquals(token.session_id, "session-xyz");

    const loaded = loadToken(tokenPath);
    assertEquals(loaded, token);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeApprovalTokenSync: writes token synchronously", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/issue-approval-token-sync.json`;
  try {
    const { token, path } = writeApprovalTokenSync({
      sessionId: "session-sync",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Sync title"],
      tokenPath,
    });

    assertEquals(path, tokenPath);
    const loaded = loadToken(tokenPath);
    assertEquals(loaded, token);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- CLI execution tests ---

Deno.test("CLI: writes token via repeated --title arguments", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/cli-token.json`;
  try {
    const authEnv = await writeAuthorizingTranscriptFixture(dir, "/file-issue do the thing");
    const res = await runCli([
      "--session-id",
      "cli-session",
      "--repo",
      "web-jam-tools",
      "--title",
      "Title One",
      "--title",
      "Title Two",
      "--token-path",
      tokenPath,
    ], envWith(authEnv));

    assertEquals(res.code, 0, res.stderr);
    const loaded = loadToken(tokenPath);
    assert(loaded !== null);
    assertEquals(loaded?.session_id, "cli-session");
    assertEquals(loaded?.repo, "WebJamApps/web-jam-tools");
    assertEquals(loaded?.titles, ["Title One", "Title Two"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: writes token via --titles JSON array and --json stdout", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/cli-token-json.json`;
  try {
    const authEnv = await writeAuthorizingTranscriptFixture(dir, "/design-issue plan the thing");
    const res = await runCli([
      "--session-id",
      "json-session",
      "--repo",
      "WebJamApps/JaMmusic",
      "--titles",
      JSON.stringify(["Song list fix", "Tour dates update"]),
      "--token-path",
      tokenPath,
      "--json",
    ], envWith(authEnv));

    assertEquals(res.code, 0, res.stderr);
    const parsedStdout = JSON.parse(res.stdout);
    assertEquals(parsedStdout.session_id, "json-session");
    assertEquals(parsedStdout.repo, "WebJamApps/JaMmusic");
    assertEquals(parsedStdout.titles, ["Song list fix", "Tour dates update"]);

    const loaded = loadToken(tokenPath);
    assertEquals(loaded, parsedStdout);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: writes token via --titles-file argument", async () => {
  const dir = await Deno.makeTempDir();
  const titlesFilePath = `${dir}/titles.txt`;
  const tokenPath = `${dir}/file-token.json`;
  try {
    await Deno.writeTextFile(titlesFilePath, "File Title 1\nFile Title 2\n");
    const authEnv = await writeAuthorizingTranscriptFixture(dir, "/file-issue do the thing");
    const res = await runCli([
      "--session-id",
      "file-session",
      "--repo",
      "web-jam-tools",
      "--titles-file",
      titlesFilePath,
      "--token-path",
      tokenPath,
    ], envWith(authEnv));

    assertEquals(res.code, 0, res.stderr);
    const loaded = loadToken(tokenPath);
    assertEquals(loaded?.titles, ["File Title 1", "File Title 2"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: fails with exit code 1 when required arguments are missing (authorized invocation)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // Authorized (an authorizing transcript + explicit conversation id via the test-only env seam,
    // deliberately with no --session-id) so this exercises buildApprovalToken's OWN validation, not
    // web-jam-tools#808's authorization gate — see the next test for the unauthorized-invocation
    // case.
    const authEnv = await writeAuthorizingTranscriptFixture(dir, "/file-issue do the thing");
    const res = await runCli(
      ["--repo", "web-jam-tools"],
      { ...envWithoutAmbientSessionId(), ...authEnv },
    );
    assertEquals(res.code, 1);
    assert(res.stderr.includes("sessionId is required"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- web-jam-tools#808: authorization-gate regression tests ---
//
// Each of these fails against the pre-#808 code: without checkTokenWriteAuthorization gating the
// CLI block, EVERY invocation below would exit 0 and write a token regardless of transcript
// content, since no such gate existed at all.

Deno.test("CLI: refuses when no authorizing skill invocation is found anywhere in the transcript", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/should-not-exist.json`;
  try {
    const authEnv = await writeAuthorizingTranscriptFixture(
      dir,
      "please go file this issue for me",
    );
    const res = await runCli([
      "--session-id",
      "unauthorized-session",
      "--repo",
      "web-jam-tools",
      "--title",
      "Some title",
      "--token-path",
      tokenPath,
    ], envWith(authEnv));
    assertEquals(res.code, 1);
    assert(res.stderr.includes("Refused to write approval token"));
    assert(res.stderr.includes("no /design-issue invocation, and no /file-issue invocation"));
    const exists = await Deno.stat(tokenPath).then(() => true).catch(() => false);
    assertEquals(exists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: refuses a token write when the current invocation is a dispatched subagent's own turn, even though an authorizing invocation is present", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/should-not-exist.json`;
  try {
    // The orchestrator's own turn WAS an authorizing /file-issue invocation, but the transcript's
    // tail — the entry immediately preceding THIS tool call — is flagged isSidechain: true, i.e.
    // this call belongs to a dispatched subagent's turn, not the main thread's.
    const authEnv = await writeAuthorizingTranscriptFixture(
      dir,
      "/file-issue do the thing",
      { sidechainTail: true },
    );
    const res = await runCli([
      "--session-id",
      "subagent-session",
      "--repo",
      "web-jam-tools",
      "--title",
      "Some title",
      "--token-path",
      tokenPath,
    ], envWith(authEnv));
    assertEquals(res.code, 1);
    assert(res.stderr.includes("dispatched subagent"));
    const exists = await Deno.stat(tokenPath).then(() => true).catch(() => false);
    assertEquals(exists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: succeeds when the most recent authorizing turn invoked /design-issue, several turns before the write (Gate 2 flow)", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/design-issue-authorized.json`;
  try {
    const path = `${dir}/transcript.jsonl`;
    const lines = [
      { type: "user", message: { role: "user", content: "/design-issue token savings" } },
      { type: "assistant", message: { role: "assistant", content: "Here's the design doc..." } },
      { type: "user", message: { role: "user", content: "looks good, approved" } },
      { type: "assistant", message: { role: "assistant", content: "Writing the approval token." } },
    ];
    await Deno.writeTextFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const res = await runCli(
      [
        "--session-id",
        "design-issue-session",
        "--repo",
        "web-jam-tools",
        "--title",
        "Some title",
        "--token-path",
        tokenPath,
      ],
      envWith({
        WRITE_ISSUE_APPROVAL_TOKEN_TEST_TRANSCRIPT_PATH: path,
        WRITE_ISSUE_APPROVAL_TOKEN_TEST_CONVERSATION_ID: "test-conv",
      }),
    );
    assertEquals(res.code, 0, res.stderr);
    const loaded = loadToken(tokenPath);
    assert(loaded !== null);
    assertEquals(loaded?.session_id, "design-issue-session");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: succeeds when the most recent authorizing turn invoked /file-issue", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/file-issue-authorized.json`;
  try {
    const authEnv = await writeAuthorizingTranscriptFixture(
      dir,
      "/file-issue add zipCode to the Venue model",
    );
    const res = await runCli([
      "--session-id",
      "file-issue-session",
      "--repo",
      "web-jam-tools",
      "--title",
      "Some title",
      "--token-path",
      tokenPath,
    ], envWith(authEnv));
    assertEquals(res.code, 0, res.stderr);
    const loaded = loadToken(tokenPath);
    assert(loaded !== null);
    assertEquals(loaded?.session_id, "file-issue-session");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: succeeds when the most recent authorizing turn used file-issue's natural-language trigger phrase (web-jam-tools#866)", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/file-issue-natural-language-authorized.json`;
  try {
    const authEnv = await writeAuthorizingTranscriptFixture(
      dir,
      "file an issue to add zipCode to the Venue model",
    );
    const res = await runCli([
      "--session-id",
      "file-issue-natural-language-session",
      "--repo",
      "web-jam-tools",
      "--title",
      "Some title",
      "--token-path",
      tokenPath,
    ], envWith(authEnv));
    assertEquals(res.code, 0, res.stderr);
    const loaded = loadToken(tokenPath);
    assert(loaded !== null);
    assertEquals(loaded?.session_id, "file-issue-natural-language-session");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: writes the token when the authorizing turn is a real Claude Code /file-issue slash invocation, stored in <command-name> wrapper form (web-jam-tools#920)", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/wrapper-form-authorized.json`;
  try {
    const authEnv = await writeAuthorizingTranscriptFixture(
      dir,
      "<command-message>file-issue</command-message>\n<command-name>/file-issue</command-name>",
    );
    const res = await runCli([
      "--session-id",
      "wrapper-form-session",
      "--repo",
      "web-jam-tools",
      "--title",
      "Some title",
      "--token-path",
      tokenPath,
    ], envWith(authEnv));
    assertEquals(res.code, 0, res.stderr);
    const loaded = loadToken(tokenPath);
    assert(loaded !== null);
    assertEquals(loaded?.session_id, "wrapper-form-session");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI: refuses when a wrapper-form /work-issue invocation follows the filing invocation (web-jam-tools#920 scope-ending half)", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/should-not-exist.json`;
  try {
    const path = `${dir}/transcript.jsonl`;
    const lines = [
      { type: "user", message: { role: "user", content: "/file-issue add zipCode to the Venue" } },
      { type: "assistant", message: { role: "assistant", content: "filed it" } },
      {
        type: "user",
        message: {
          role: "user",
          content:
            "<command-message>work-issue</command-message>\n<command-name>/work-issue</command-name>",
        },
      },
    ];
    await Deno.writeTextFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const res = await runCli(
      [
        "--session-id",
        "wrapper-scope-end-session",
        "--repo",
        "web-jam-tools",
        "--title",
        "Some title",
        "--token-path",
        tokenPath,
      ],
      envWith({
        WRITE_ISSUE_APPROVAL_TOKEN_TEST_TRANSCRIPT_PATH: path,
        WRITE_ISSUE_APPROVAL_TOKEN_TEST_CONVERSATION_ID: "test-conv",
      }),
    );
    assertEquals(res.code, 1);
    assert(res.stderr.includes("different skill or command (/work-issue) was invoked"));
    const exists = await Deno.stat(tokenPath).then(() => true).catch(() => false);
    assertEquals(exists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- checkTokenWriteAuthorization / filingSkillInvoked / tailIsCurrentlySidechain unit tests ---

Deno.test("filingSkillInvoked: recognizes /file-issue and /design-issue at the start of the text", () => {
  assertEquals(filingSkillInvoked("/file-issue add a thing"), "file-issue");
  assertEquals(filingSkillInvoked("/design-issue plan a thing"), "design-issue");
  assertEquals(filingSkillInvoked("/file-issue"), "file-issue");
  assertEquals(filingSkillInvoked("  /design-issue  \nmore text"), "design-issue");
});

Deno.test("filingSkillInvoked: does not match a mid-sentence mention, only an invocation", () => {
  assertEquals(filingSkillInvoked("let's talk about /file-issue later"), null);
  assertEquals(
    filingSkillInvoked("the /design-issue skill handles this, but first..."),
    null,
  );
  assertEquals(filingSkillInvoked("/file-issueX add a thing"), null);
});

Deno.test("filingSkillInvoked: recognizes file-issue's documented natural-language triggers at the start of the text (web-jam-tools#866)", () => {
  assertEquals(filingSkillInvoked("file an issue about the zip code bug"), "file-issue");
  assertEquals(filingSkillInvoked("open an issue for this"), "file-issue");
  assertEquals(filingSkillInvoked("draft an issue"), "file-issue");
  assertEquals(filingSkillInvoked("File an issue, please"), "file-issue");
  assertEquals(filingSkillInvoked("  open an issue.\nmore text"), "file-issue");
});

Deno.test("filingSkillInvoked: does not match the natural-language triggers mid-sentence, as a word prefix, or for design-issue", () => {
  // Mid-sentence: the phrase must open the message, same anchor as the slash form.
  assertEquals(filingSkillInvoked("let's file an issue about this"), null);
  assertEquals(filingSkillInvoked("I should open an issue later"), null);
  // Word-prefix false positive: "file an issued complaint" is not "file an issue".
  assertEquals(filingSkillInvoked("file an issued complaint"), null);
  // "filing" is not "file" — no partial-word match.
  assertEquals(filingSkillInvoked("filing an issue right now"), null);
  // design-issue has no documented natural-language trigger — only its slash form authorizes it.
  assertEquals(filingSkillInvoked("design an issue for this"), null);
  assertEquals(filingSkillInvoked("run design-issue"), null);
});

// --- web-jam-tools#920: Claude Code's <command-name> slash-invocation wrapper ---
//
// Claude Code does not store a typed `/file-issue` as the bare text `/file-issue`; it stores a user
// turn whose whole content is the wrapper below. Every test in this block fails against the pre-#920
// code, where such a turn was invisible to BOTH halves of the check — so a real /file-issue could
// not authorize (fails closed, visibly) and a real /work-issue could not end the authorization scope
// (fails open, silently).

const FILE_ISSUE_WRAPPER =
  "<command-message>file-issue</command-message>\n<command-name>/file-issue</command-name>";
const DESIGN_ISSUE_WRAPPER =
  "<command-message>design-issue</command-message>\n<command-name>/design-issue</command-name>";
const WORK_ISSUE_WRAPPER =
  "<command-message>work-issue</command-message>\n<command-name>/work-issue</command-name>";

Deno.test("filingSkillInvoked: recognizes Claude Code's <command-name> invocation wrapper (web-jam-tools#920)", () => {
  assertEquals(filingSkillInvoked(FILE_ISSUE_WRAPPER), "file-issue");
  assertEquals(filingSkillInvoked(DESIGN_ISSUE_WRAPPER), "design-issue");
  // The <command-message> element is optional, leading/trailing whitespace is tolerated, and
  // trailing elements (e.g. <command-args>) may follow the wrapper.
  assertEquals(filingSkillInvoked("<command-name>/file-issue</command-name>"), "file-issue");
  assertEquals(filingSkillInvoked(`  ${DESIGN_ISSUE_WRAPPER}\n`), "design-issue");
  assertEquals(
    filingSkillInvoked(
      `${FILE_ISSUE_WRAPPER}\n<command-args>add zipCode to the Venue model</command-args>`,
    ),
    "file-issue",
  );
});

Deno.test("filingSkillInvoked: a <command-name> element that is not the turn's own invocation wrapper is still a mention, not a use (web-jam-tools#920)", () => {
  // Prose quoting the wrapper while discussing it — the mention-vs-use distinction the bare slash
  // form already draws, applied identically to the wrapper form.
  assertEquals(
    filingSkillInvoked(
      `Claude Code stores the invocation as ${FILE_ISSUE_WRAPPER} rather than as bare text`,
    ),
    null,
  );
  assertEquals(
    filingSkillInvoked("see <command-name>/design-issue</command-name> in the transcript"),
    null,
  );
  // A non-filing skill's wrapper is not a filing invocation.
  assertEquals(filingSkillInvoked(WORK_ISSUE_WRAPPER), null);
  // Not the wrapper element at all.
  assertEquals(filingSkillInvoked("<command-message>file-issue</command-message>"), null);
  assertEquals(filingSkillInvoked("<command-name>file-issue</command-name>"), null);
});

Deno.test("nonFilingSlashCommandInvoked: recognizes the wrapper form so a wrapped non-filing skill still ends the authorization scope (web-jam-tools#920)", () => {
  assertEquals(nonFilingSlashCommandInvoked(WORK_ISSUE_WRAPPER), "/work-issue");
  assertEquals(
    nonFilingSlashCommandInvoked(
      "<command-message>book-gig</command-message>\n<command-name>/book-gig</command-name>",
    ),
    "/book-gig",
  );
  assertEquals(
    nonFilingSlashCommandInvoked("<command-name>/pr-review</command-name>"),
    "/pr-review",
  );
  // Filing wrappers are not scope-ending — they are the authorization itself.
  assertEquals(nonFilingSlashCommandInvoked(FILE_ISSUE_WRAPPER), null);
  assertEquals(nonFilingSlashCommandInvoked(DESIGN_ISSUE_WRAPPER), null);
  // A quoted wrapper mid-prose is a mention, so it must not silently terminate an authorization.
  assertEquals(
    nonFilingSlashCommandInvoked(`the ${WORK_ISSUE_WRAPPER} form is what Claude Code writes`),
    null,
  );
});

Deno.test("checkTokenWriteAuthorization: a wrapper-form /file-issue turn authorizes the write (web-jam-tools#920)", () => {
  const entries: TranscriptEntry[] = [
    { type: "user", message: { role: "user", content: FILE_ISSUE_WRAPPER } },
    { type: "assistant", message: { role: "assistant", content: "researching duplicates..." } },
    { type: "user", message: { role: "user", content: "yes that plan looks right" } },
  ];
  const result = checkTokenWriteAuthorization({
    entries,
    ownConversationId: "sess-1",
    isSubagentInvocation: false,
  });
  assertEquals(result.ok, true);
  assertEquals(result.skill, "file-issue");
});

Deno.test("checkTokenWriteAuthorization: a wrapper-form /work-issue turn ends the scope of an earlier filing invocation (web-jam-tools#920 fail-open half)", () => {
  // Pre-#920 this returned ok:true — the wrapped /work-issue was invisible, so the earlier
  // /file-issue kept authorizing writes across an intervening non-filing skill.
  const entries: TranscriptEntry[] = [
    { type: "user", message: { role: "user", content: "/file-issue add zipCode to the Venue" } },
    { type: "assistant", message: { role: "assistant", content: "filed" } },
    { type: "user", message: { role: "user", content: WORK_ISSUE_WRAPPER } },
    { type: "assistant", message: { role: "assistant", content: "working the issue" } },
  ];
  const result = checkTokenWriteAuthorization({
    entries,
    ownConversationId: "sess-1",
    isSubagentInvocation: false,
  });
  assertEquals(result.ok, false);
  assert(result.reason?.includes("different skill or command (/work-issue) was invoked"));
});

Deno.test("nonFilingSlashCommandInvoked: recognizes other slash commands and ignores filing skills or prose", () => {
  assertEquals(nonFilingSlashCommandInvoked("/work-issue #123"), "/work-issue");
  assertEquals(nonFilingSlashCommandInvoked("/book-gig next-weekend"), "/book-gig");
  assertEquals(nonFilingSlashCommandInvoked("/pr-review"), "/pr-review");
  assertEquals(nonFilingSlashCommandInvoked("/file-issue add a thing"), null);
  assertEquals(nonFilingSlashCommandInvoked("/design-issue plan a thing"), null);
  assertEquals(nonFilingSlashCommandInvoked("let's talk about /work-issue"), null);
  assertEquals(nonFilingSlashCommandInvoked("just ordinary chat"), null);
});

Deno.test("checkTokenWriteAuthorization: refuses when an intervening non-filing slash command is invoked (scope-ending event)", () => {
  const entries: TranscriptEntry[] = [
    { type: "user", message: { role: "user", content: "/design-issue plan token-savings" } },
    { type: "assistant", message: { role: "assistant", content: "planning..." } },
    { type: "user", message: { role: "user", content: "/work-issue web-jam-tools#800" } },
    { type: "assistant", message: { role: "assistant", content: "switching to work..." } },
    { type: "user", message: { role: "user", content: "please file the issue now" } },
  ];
  const result = checkTokenWriteAuthorization({
    entries,
    ownConversationId: "sess-1",
    isSubagentInvocation: false,
  });
  assertEquals(result.ok, false);
  assert(result.reason?.includes("different skill or command (/work-issue) was invoked"));
});

Deno.test("checkTokenWriteAuthorization: refuses when filing skill invocation is older than MAX_AUTHORIZING_USER_TURNS turns", () => {
  const entries: TranscriptEntry[] = [
    { type: "user", message: { role: "user", content: "/file-issue old filing" } },
    { type: "assistant", message: { role: "assistant", content: "filed old issue" } },
  ];
  // Add MAX_AUTHORIZING_USER_TURNS (20) subsequent user turns with ordinary chat
  for (let i = 0; i < MAX_AUTHORIZING_USER_TURNS; i++) {
    entries.push({
      type: "user",
      message: { role: "user", content: `unrelated chat message ${i + 1}` },
    });
    entries.push({
      type: "assistant",
      message: { role: "assistant", content: `assistant response ${i + 1}` },
    });
  }

  const result = checkTokenWriteAuthorization({
    entries,
    ownConversationId: "sess-1",
    isSubagentInvocation: false,
  });
  assertEquals(result.ok, false);
  assert(result.reason?.includes(`within the last ${MAX_AUTHORIZING_USER_TURNS} user turns`));
});

Deno.test("checkTokenWriteAuthorization: succeeds when filing skill invocation is within MAX_AUTHORIZING_USER_TURNS turns", () => {
  const entries: TranscriptEntry[] = [
    { type: "user", message: { role: "user", content: "/design-issue plan the thing" } },
    { type: "assistant", message: { role: "assistant", content: "here is research" } },
  ];
  // Add 10 subsequent user turns (e.g. interactive Q&A during design-issue)
  for (let i = 0; i < 10; i++) {
    entries.push({
      type: "user",
      message: { role: "user", content: `design discussion ${i + 1}` },
    });
    entries.push({
      type: "assistant",
      message: { role: "assistant", content: `reply ${i + 1}` },
    });
  }

  const result = checkTokenWriteAuthorization({
    entries,
    ownConversationId: "sess-1",
    isSubagentInvocation: false,
  });
  assertEquals(result.ok, true);
  assertEquals(result.skill, "design-issue");
});

Deno.test("checkTokenWriteAuthorization: refuses when isSubagentInvocation is true regardless of transcript content", () => {
  const entries: TranscriptEntry[] = [
    { type: "user", message: { role: "user", content: "/file-issue do the thing" } },
  ];
  const result = checkTokenWriteAuthorization({
    entries,
    ownConversationId: "sess-1",
    isSubagentInvocation: true,
  });
  assertEquals(result.ok, false);
  assert(result.reason?.includes("dispatched subagent"));
});

Deno.test("checkTokenWriteAuthorization: refuses when ownConversationId is undetermined", () => {
  const result = checkTokenWriteAuthorization({
    entries: [],
    ownConversationId: null,
    isSubagentInvocation: false,
  });
  assertEquals(result.ok, false);
  assert(result.reason?.includes("could not determine"));
});

Deno.test("checkTokenWriteAuthorization: finds the most recent authorizing turn, skipping a subagent's interleaved sidechain turns", () => {
  const entries: TranscriptEntry[] = [
    { type: "user", message: { role: "user", content: "/file-issue add a thing" } },
    { type: "user", isSidechain: true, message: { role: "user", content: "/file-issue a decoy" } },
    { type: "assistant", isSidechain: true, message: { role: "assistant", content: "working" } },
  ];
  const result = checkTokenWriteAuthorization({
    entries,
    ownConversationId: "sess-1",
    isSubagentInvocation: false,
  });
  assertEquals(result.ok, true);
  assertEquals(result.skill, "file-issue");
});

Deno.test("checkTokenWriteAuthorization: Antigravity entries only count when conversationId matches", () => {
  const entries: TranscriptEntry[] = [
    {
      type: "USER_INPUT",
      source: "USER_EXPLICIT",
      step_index: 0,
      content: "/design-issue plan a thing",
      conversationId: "parent-conv",
    },
    {
      type: "USER_INPUT",
      source: "USER_EXPLICIT",
      step_index: 0,
      content: "/design-issue a subagent decoy",
      conversationId: "subagent-conv",
    },
  ];
  const result = checkTokenWriteAuthorization({
    entries,
    ownConversationId: "parent-conv",
    isSubagentInvocation: false,
  });
  assertEquals(result.ok, true);
  assertEquals(result.skill, "design-issue");
});

Deno.test("tailIsCurrentlySidechain: true only when the LAST entry is flagged isSidechain", () => {
  assertEquals(
    tailIsCurrentlySidechain([
      { type: "user", message: { role: "user", content: "hi" } },
      { type: "assistant", isSidechain: true, message: { role: "assistant", content: "hi" } },
    ]),
    true,
  );
  assertEquals(
    tailIsCurrentlySidechain([
      { type: "assistant", isSidechain: true, message: { role: "assistant", content: "hi" } },
      { type: "user", message: { role: "user", content: "hi" } },
    ]),
    false,
  );
  assertEquals(tailIsCurrentlySidechain([]), false);
});

Deno.test("resolveClaudeCodeWriteContext: returns null when no session id is given", async () => {
  const result = await resolveClaudeCodeWriteContext("");
  assertEquals(result, null);
});

Deno.test("resolveClaudeCodeWriteContext: returns null when no matching transcript file exists", async () => {
  const result = await resolveClaudeCodeWriteContext(
    "definitely-not-a-real-session-id-web-jam-tools-808",
  );
  assertEquals(result, null);
});

Deno.test("authorizeWrite: end-to-end via an explicit in-process transcriptPath option (no CLI flag exists for this — web-jam-tools#866)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/transcript.jsonl`;
    await Deno.writeTextFile(
      path,
      JSON.stringify({ type: "user", message: { role: "user", content: "/file-issue thing" } }) +
        "\n",
    );
    const result = await authorizeWrite({
      sessionId: "irrelevant-since-transcript-path-given",
      transcriptPath: path,
      conversationId: "test-conv",
    });
    assertEquals(result.ok, true);
    assertEquals(result.skill, "file-issue");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("authorizeWrite: refuses (fails closed) when the transcript cannot be read and the own conversation identity cannot be established — outcome 3", async () => {
  const result = await authorizeWrite({
    sessionId: "",
    transcriptPath: "/nonexistent/web-jam-tools-920/transcript.jsonl",
  });
  assertEquals(result.ok, false);
  assert(result.reason?.includes("could not determine"));
});

Deno.test("authorizeWrite: refuses (fails closed) when the transcript cannot be read even though the conversation identity is known — outcome 3", async () => {
  const result = await authorizeWrite({
    sessionId: "known-session",
    transcriptPath: "/nonexistent/web-jam-tools-920/transcript.jsonl",
    conversationId: "known-conv",
  });
  assertEquals(result.ok, false);
  assert(result.reason?.includes("no /design-issue invocation, and no /file-issue invocation"));
});

// --- Round-trip integration tests with hook and reader (web-jam-tools#595) ---

Deno.test("Round-trip: written token allows matching issue_write create without a prompt", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/round-trip-token.json`;
  try {
    await writeApprovalToken({
      sessionId: "sess-round-trip",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Approved title A", "Approved title B"],
      tokenPath,
    });

    // 1. Direct reader check
    const payload = JSON.stringify({
      session_id: "sess-round-trip",
      tool_name: "mcp__claude_ai_GitHub_MCP__issue_write",
      tool_input: {
        method: "create",
        owner: "WebJamApps",
        repo: "web-jam-tools",
        title: "Approved title A",
      },
    });
    const decision = checkIssueApprovalToken(payload, tokenPath, Date.now());
    assert(decision.startsWith("ALLOW:"));

    // 2. End-to-end hook check
    const res = await runHook(
      {
        session_id: "sess-round-trip",
        tool_name: "mcp__claude_ai_GitHub_MCP__issue_write",
        tool_input: {
          method: "create",
          owner: "WebJamApps",
          repo: "web-jam-tools",
          title: "Approved title A",
        },
      },
      tokenPath,
    );

    assertEquals(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assertEquals(parsed.hookSpecificOutput.permissionDecision, "allow");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Round-trip: written token DENIES unapproved title", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/round-trip-unapproved.json`;
  try {
    await writeApprovalToken({
      sessionId: "sess-round-trip",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Approved title A"],
      tokenPath,
    });

    const res = await runHook(
      {
        session_id: "sess-round-trip",
        tool_name: "mcp__claude_ai_GitHub_MCP__issue_write",
        tool_input: {
          method: "create",
          owner: "WebJamApps",
          repo: "web-jam-tools",
          title: "Unapproved title",
        },
      },
      tokenPath,
    );

    assertEquals(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assertEquals(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert(parsed.hookSpecificOutput.permissionDecisionReason.includes("not among the titles"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Round-trip: written token DENIES when token is expired", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/round-trip-expired.json`;
  try {
    await writeApprovalToken({
      sessionId: "sess-round-trip",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Approved title A"],
      expiresAt: new Date(Date.now() - 3600_000).toISOString(), // expired 1 hour ago
      tokenPath,
    });

    const res = await runHook(
      {
        session_id: "sess-round-trip",
        tool_name: "mcp__claude_ai_GitHub_MCP__issue_write",
        tool_input: {
          method: "create",
          owner: "WebJamApps",
          repo: "web-jam-tools",
          title: "Approved title A",
        },
      },
      tokenPath,
    );

    assertEquals(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assertEquals(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert(parsed.hookSpecificOutput.permissionDecisionReason.includes("expired"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Round-trip: written token DENIES when session ID does not match", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/round-trip-session.json`;
  try {
    await writeApprovalToken({
      sessionId: "sess-authorizing",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Approved title A"],
      tokenPath,
    });

    const res = await runHook(
      {
        session_id: "sess-other-session",
        tool_name: "mcp__claude_ai_GitHub_MCP__issue_write",
        tool_input: {
          method: "create",
          owner: "WebJamApps",
          repo: "web-jam-tools",
          title: "Approved title A",
        },
      },
      tokenPath,
    );

    assertEquals(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assertEquals(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert(parsed.hookSpecificOutput.permissionDecisionReason.includes("different session"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
