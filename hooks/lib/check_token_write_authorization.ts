/**
 * Authorization check for scripts/write_issue_approval_token.ts (web-jam-tools#808, replaced by
 * web-jam-tools#1000).
 *
 * web-jam-tools#1000 retired the phrase/slash-command matcher this file used to implement
 * (FILE_ISSUE_INVOCATION_RE, filingSkillInvoked, nonFilingSlashCommandInvoked — see git history for
 * that design). Josh, verbatim, on the PR that widened the phrase matcher yet again: "the goal of
 * the guard is to prevent AGENT not to prevent ME!" A wording matcher over Josh's own typing can
 * never fully track "does Josh's ordinary phrasing count as approval" without either refusing him
 * routinely or, eventually, drifting open — the wrong axis to gate on, since Josh is not the party
 * this guard exists to constrain.
 *
 * The replacement gates on two facts a wording matcher can't fake:
 *
 *   1. The exact title Josh is approving was actually SHOWN to him, verbatim, by the assistant
 *      (not by a tool result, a task notification, or a subagent's own turn — those are exactly
 *      the places an agent could plant a title Josh never saw).
 *   2. Josh's own most recent HUMAN-TYPED reply came after that title was shown, and is not a
 *      refusal.
 *
 * This makes the check almost entirely wording-independent on Josh's side — "2", "go", "ok", "yes",
 * a slash command, or a reply that doesn't even mention the title all authorize equally, since what
 * matters is that he saw the title and didn't say no to it. The only wording test left is a short,
 * literal refusal-opener list (isRefusalReply) — the sole way Josh can decline what was shown to
 * him, not the way he approves it.
 *
 * Kept separate from scripts/write_issue_approval_token.ts (rather than inlined) so the pure
 * decision logic is testable via injected entries, matching the pattern
 * hooks/lib/check_issue_approval_token.ts's decide() and getOpusGateInfo() already use — the CLI
 * script's `import.meta.main` block is the only place that does real file I/O.
 */

import {
  entryConversationId,
  extractEntryText,
  isAntigravityEntry,
  isHumanPrompt,
  type TranscriptEntry,
} from "./select_transcript_entry.ts";

/**
 * Claude Code's stored form of a slash-command invocation (web-jam-tools#920). The surface does not
 * record the user's keystrokes as the bare text `/file-issue`; it records a user turn whose whole
 * content is an invocation wrapper:
 *
 *     <command-message>file-issue</command-message>
 *     <command-name>/file-issue</command-name>
 *
 * (the `<command-message>` element is optional, and trailing elements such as `<command-args>` may
 * follow). Verified live on 2026-09-05 in session 26d83a7a-6a81-41c8-8729-45ec0e75348b, where a
 * genuine `/file-issue` was refused a token because that text opens with `<` rather than `/`.
 *
 * The leading `/` inside `<command-name>` is optional (web-jam-tools#956): a live transcript can
 * carry either `<command-name>/file-issue</command-name>` or `<command-name>file-issue</command-name>`
 * for the same real invocation, and only recognizing the slashed form left the bare-name form
 * invisible the same way the pre-#920 code left the whole wrapper invisible.
 *
 * Still used post-web-jam-tools#1000: `hooks/lib/opus_gate.ts` imports this directly for its own,
 * unrelated slash-command detection, and `textAfterSlashCommand` below reuses it to strip a slash
 * command's own name off Josh's reply before running the refusal check on what remains.
 */
const CLAUDE_CODE_COMMAND_NAME_WRAPPER =
  /^(?:<command-message>[^<]*<\/command-message>\s*)?<command-name>\s*\/?([a-zA-Z0-9_-]+)\s*<\/command-name>/;

/**
 * Fallback form of the wrapper above, for a transcript entry whose `<command-name>` element is
 * missing and only `<command-message>` carries the invoked skill's name (web-jam-tools#956). Kept as
 * a separate regex rather than folding into CLAUDE_CODE_COMMAND_NAME_WRAPPER above. This regex has
 * no end anchor, so on its own it also matches a `<command-message>` followed by anything —
 * including a `<command-name>` element the pattern above rejected. What keeps a well-formed wrapper
 * on its `<command-name>` element is the ORDER of the checks in slashCommandFromInvocationWrapper:
 * CLAUDE_CODE_COMMAND_NAME_WRAPPER is tried first, and this fallback runs only when it does not match.
 */
const CLAUDE_CODE_COMMAND_MESSAGE_ONLY_WRAPPER =
  /^<command-message>\s*\/?([a-zA-Z0-9_-]+)\s*<\/command-message>/;

/**
 * Returns the slash command name (lowercased, without its leading `/`) when `text` IS a Claude Code
 * slash invocation stored in wrapper form, or null.
 */
export function slashCommandFromInvocationWrapper(text: string): string | null {
  const trimmed = text.trim();
  const nameMatch = trimmed.match(CLAUDE_CODE_COMMAND_NAME_WRAPPER);
  if (nameMatch) return nameMatch[1].toLowerCase();
  const messageMatch = trimmed.match(CLAUDE_CODE_COMMAND_MESSAGE_ONLY_WRAPPER);
  if (messageMatch) return messageMatch[1].toLowerCase();
  return null;
}

/**
 * Returns the text a slash-command reply should be refusal-checked against: the `<command-args>`
 * element's content when present, or "" for a bare wrapper/slash command with no arguments — never
 * the command name itself, which is never a refusal opener. Non-slash text passes through
 * unchanged (trimmed).
 *
 * web-jam-tools#1000 acceptance criterion: Josh replying with a bare `/file-issue` (no args) after
 * seeing a title is an approval, not a refusal — "" is not a refusal opener (isRefusalReply("")
 * returns false), so it authorizes.
 */
export function textAfterSlashCommand(rawText: string): string {
  const trimmed = rawText.trim();
  const argsMatch = trimmed.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (argsMatch) return argsMatch[1].trim();
  if (slashCommandFromInvocationWrapper(trimmed) !== null) return "";
  const bareSlash = trimmed.match(/^\/[a-zA-Z0-9_-]+\b([\s\S]*)$/);
  if (bareSlash) return bareSlash[1].trim();
  return trimmed;
}

/**
 * The only wording test this file still applies, and only to REFUSE what was already shown to
 * Josh — never to recognize an approval (see file header). Each opener must be the whole leading
 * word/phrase, not a prefix of a longer word: `phrase` must be the entire (trimmed, lowercased)
 * text, or be followed by whitespace or a sentence-boundary punctuation mark (`, . : ; ! ?`).
 * "nothing to change, file it" is deliberately NOT a refusal — "nothing" starts with "no" but the
 * next character ("t") is not a word boundary, so the whole-word check correctly rejects it
 * (web-jam-tools#1000 acceptance criterion).
 */
const REFUSAL_OPENERS = [
  "not yet",
  "do not",
  "hold off",
  "don't",
  "dont",
  "no",
  "nope",
  "nah",
  "stop",
  "never",
  "cancel",
  "wait",
] as const;

/** True when `text` (Josh's reply, or the argument text of a slash command he typed) opens with a
 * literal refusal phrase. Empty text is never a refusal — there is nothing to refuse with. */
export function isRefusalReply(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "") return false;
  for (const phrase of REFUSAL_OPENERS) {
    if (trimmed === phrase) return true;
    if (!trimmed.startsWith(phrase)) continue;
    const next = trimmed[phrase.length];
    if (
      next === " " || next === "\n" || next === "," || next === "." || next === ":" ||
      next === ";" || next === "!" || next === "?"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True when `entry` belongs to the session's own main thread: on Claude Code, not a subagent's
 * interleaved sidechain entry and not a synthetic API-error entry; on Antigravity, an entry
 * recorded in the same conversation as `ownConversationId` (a subagent runs in its own isolated
 * conversation with its own transcript, so a mismatch means the entry is not this session's own).
 * Role-agnostic — narrow further with isAssistantAuthored or isHumanPrompt.
 */
function isOwnSessionMainThreadEntry(
  entry: TranscriptEntry | null | undefined,
  ownConversationId: string | null,
): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (isAntigravityEntry(entry)) {
    if (!ownConversationId) return false;
    return entryConversationId(entry) === ownConversationId;
  }
  return entry.isSidechain !== true && entry.isApiErrorMessage !== true;
}

/** True when `entry` is model/assistant-authored text, on either surface. Antigravity has no
 * documented "assistant" type constant the way it does for a prompt (ANTIGRAVITY_PROMPT_ENTRY_TYPE
 * in select_transcript_entry.ts); the only thing distinguishing a model turn from Josh's own prompt
 * in that store is that it is NOT that prompt type, so that is what this checks. */
function isAssistantAuthored(entry: TranscriptEntry): boolean {
  if (isAntigravityEntry(entry)) {
    return entry.type !== "USER_INPUT";
  }
  return entry.type === "assistant" || entry.message?.role === "assistant";
}

export interface TokenWriteAuthorizationContext {
  /** The transcript entries to scan — the invoking session's own transcript. */
  entries: readonly TranscriptEntry[];
  /** Claude Code: the session id. Antigravity: the conversationId. Empty/null means undetermined
   * — the check fails closed rather than guessing. */
  ownConversationId: string | null;
  /**
   * True when THIS invocation is itself happening inside a dispatched subagent's turn, so the
   * write must be refused regardless of what the transcript shows elsewhere (acceptance
   * criterion: "A dispatched subagent is refused a token write even when the exact title was
   * shown and approved on the main thread"). Claude Code computes this mechanically (see
   * tailIsCurrentlySidechain below); Antigravity subagents run in isolated conversations with
   * their own conversationId and separate transcript, so isOwnSessionMainThreadEntry never
   * matches a parent turn and the scan denies it in practice.
   */
  isSubagentInvocation: boolean;
  /** The exact issue titles the write is being requested for. Every one of these must have been
   * shown verbatim by the assistant before Josh's latest human-typed, non-refusing reply. */
  titles: readonly string[];
}

export interface TokenWriteAuthorizationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Decides whether scripts/write_issue_approval_token.ts may write a token for `ctx.titles`
 * (web-jam-tools#1000, replacing web-jam-tools#808's decision 21 phrase check).
 *
 * Three conditions, all required:
 *   1. For every requested title, some own-session, main-thread ASSISTANT message contains that
 *      title verbatim (case-sensitive exact substring — quotes/backticks/markdown around it in the
 *      assistant's own formatting are irrelevant, since a substring search does not care what
 *      surrounds the match). The title's "shown point" is the LATEST such assistant entry, since an
 *      earlier draft of a title is not the one being approved.
 *   2. The most recent human-typed turn in the session (isHumanPrompt — typed, queued, or an
 *      accepted suggestion; never a tool_result, task notification, isMeta/system-reminder
 *      injection, or subagent/sidechain entry) comes AFTER every requested title's shown point. A
 *      title shown only after Josh's latest reply has not yet been put in front of him.
 *   3. That most recent human-typed turn is not a refusal (isRefusalReply) — checked against the
 *      command-argument text when that turn was itself a slash command Josh typed
 *      (textAfterSlashCommand), since a slash command's own name is never a refusal opener.
 *
 * Any condition failing, or the transcript/conversation identity being unreadable or undetermined,
 * refuses (fails closed) — this function never guesses in the agent's favor.
 */
export function checkTokenWriteAuthorization(
  ctx: TokenWriteAuthorizationContext,
): TokenWriteAuthorizationResult {
  if (ctx.isSubagentInvocation) {
    return {
      ok: false,
      reason:
        "Refused: this invocation is a dispatched subagent's own turn. A subagent never writes an approval token — the orchestrating session asks Josh and writes it.",
    };
  }

  if (!ctx.ownConversationId) {
    return {
      ok: false,
      reason:
        "Refused: could not determine this invocation's own session/conversation identity, so Josh's approval cannot be verified. Failing closed rather than guessing.",
    };
  }

  const titles = (ctx.titles ?? []).map((t) => t.trim()).filter((t) => t.length > 0);

  // Condition 1: every requested title's latest verbatim "shown" point.
  const shownAtIndex = new Map<string, number>();
  for (let i = 0; i < ctx.entries.length; i++) {
    const entry = ctx.entries[i];
    if (!isOwnSessionMainThreadEntry(entry, ctx.ownConversationId)) continue;
    if (!isAssistantAuthored(entry)) continue;
    const text = extractEntryText(entry);
    if (!text) continue;
    for (const title of titles) {
      if (text.includes(title)) shownAtIndex.set(title, i);
    }
  }

  const neverShown = titles.find((t) => !shownAtIndex.has(t));
  if (neverShown !== undefined) {
    return {
      ok: false,
      reason:
        `Refused: the exact title ${JSON.stringify(neverShown)} was never shown to Josh, verbatim, in an assistant message in this session — his approval of it cannot be verified.`,
    };
  }

  // Condition 2: the most recent human-typed turn, anywhere in the session's own main thread.
  let lastHumanIndex = -1;
  let lastHumanEntry: TranscriptEntry | null = null;
  for (let i = ctx.entries.length - 1; i >= 0; i--) {
    const entry = ctx.entries[i];
    if (!isOwnSessionMainThreadEntry(entry, ctx.ownConversationId)) continue;
    if (isHumanPrompt(entry)) {
      lastHumanIndex = i;
      lastHumanEntry = entry;
      break;
    }
  }

  if (lastHumanIndex === -1 || lastHumanEntry === null) {
    return {
      ok: false,
      reason:
        "Refused: no human-typed reply found anywhere in this session, so Josh's approval cannot be verified.",
    };
  }

  const shownTooLate = titles.find((t) => (shownAtIndex.get(t) ?? -1) >= lastHumanIndex);
  if (shownTooLate !== undefined) {
    return {
      ok: false,
      reason:
        `Refused: the exact title ${
          JSON.stringify(shownTooLate)
        } was shown to Josh only AFTER his most recent reply — he has not had a chance to approve it yet.`,
    };
  }

  // Condition 3: that most recent human-typed turn must not be a refusal.
  const rawReplyText = extractEntryText(lastHumanEntry).trim();
  const replyTextForRefusalCheck = textAfterSlashCommand(rawReplyText);
  if (isRefusalReply(replyTextForRefusalCheck)) {
    return {
      ok: false,
      reason:
        `Refused: Josh's most recent reply ("${rawReplyText}") reads as a refusal, not an approval.`,
    };
  }

  return { ok: true };
}

/**
 * Claude Code only: true when the transcript's own tail — the entry most recently written,
 * immediately preceding the tool call now running this script — sits inside a sidechain. Claude
 * Code interleaves a subagent's entries into the SAME transcript file flagged isSidechain: true,
 * written before the tool it describes executes (the same guarantee PreToolUse hooks already rely
 * on to see the current call in their own transcript_path read), so the last entry reliably
 * reflects whether THIS invocation belongs to a subagent's turn rather than the main thread.
 *
 * Always false for an Antigravity transcript (no isSidechain field exists there at all) — that
 * surface's subagent detection is handled by the caller passing isSubagentInvocation itself; this
 * function only ever answers the Claude Code half of that question.
 */
export function tailIsCurrentlySidechain(entries: readonly TranscriptEntry[]): boolean {
  const last = entries[entries.length - 1];
  return Boolean(last && typeof last === "object" && last.isSidechain === true);
}
