/**
 * Authorization check for scripts/write_issue_approval_token.ts (web-jam-tools#808).
 *
 * Decision 21 of ~/Dropbox/web-jam-llms/Token_Savings/design-issue-enhancements-design-2026-08-23.md:
 * invoking a skill is authorization for what that skill does, so the token writer refuses unless
 * the most recent non-sidechain, own-session user turn invoked one of the two filing skills —
 * design-issue or file-issue — and a dispatched subagent never writes a token at all. This is the
 * same mechanism decision 17 establishes for the work-issue grant (hooks/opus-delegation-gate.sh),
 * applied a second time: it scans the transcript for the most recent authorizing invocation rather
 * than requiring it to be the literal last message, because a `/design-issue` run's Gate 2 approval
 * routinely arrives many turns after the `/design-issue` invocation itself, and requiring the
 * literal last turn would break that legitimate flow (see file header note on scan-vs-last-turn
 * below). It is built on hooks/lib/select_transcript_entry.ts's surface-aware reader (web-jam-tools#841).
 *
 * Kept separate from scripts/write_issue_approval_token.ts (rather than inlined) so the pure
 * decision logic is testable via injected entries, matching the pattern
 * hooks/lib/check_issue_approval_token.ts's decide() and getOpusGateInfo() already use — the CLI
 * script's `import.meta.main` block is the only place that does real file I/O.
 */

import {
  extractEntryText,
  isOwnSessionUserTurnBoundary,
  type TranscriptEntry,
} from "./select_transcript_entry.ts";

/** The two skills decision 21 recognizes as authorizing a token write. Both are filing paths Josh
 * invokes directly — design-issue reaches filing through its own plan gate, file-issue is the
 * standalone path — so recognizing only one would leave the other permanently unable to file. */
export const AUTHORIZING_FILING_SKILLS = ["design-issue", "file-issue"] as const;
export type FilingSkill = typeof AUTHORIZING_FILING_SKILLS[number];

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
 * Anchored at the START of the trimmed text on purpose, exactly like the bare slash form: this is
 * the same mention-vs-use distinction. Prose that quotes a `<command-name>` element mid-sentence
 * (this doc comment included, were it ever a user turn) is discussing the wrapper, not invoking
 * anything, and must not authorize — nor terminate — anything.
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
 * slash invocation stored in wrapper form, or null. Used by both the filing check and the
 * scope-ending check below, so the wrapper form is recognized in both directions: recognizing only
 * the filing half would let an intervening `/work-issue` stay invisible and so widen the gate
 * instead of fixing it (web-jam-tools#920).
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
 * Returns the non-filing slash command invoked at the start of user-turn text, or null. Recognizes
 * both the bare leading form (`/work-issue …`) and Claude Code's `<command-name>` wrapper form
 * (web-jam-tools#920).
 *
 * Any intervening slash command (e.g. /work-issue, /book-gig, /handle-gmails) acts as a
 * scope-ending event: once the user invokes a different skill, any earlier filing skill
 * authorization in the session is terminated.
 */
export function nonFilingSlashCommandInvoked(text: string): string | null {
  const trimmed = text.trim();
  const wrapped = slashCommandFromInvocationWrapper(trimmed);
  if (wrapped && !AUTHORIZING_FILING_SKILLS.includes(wrapped as FilingSkill)) {
    return `/${wrapped}`;
  }
  if (trimmed.startsWith("/")) {
    const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)/);
    if (match) {
      const cmd = match[1].toLowerCase();
      if (!AUTHORIZING_FILING_SKILLS.includes(cmd as FilingSkill)) {
        return `/${cmd}`;
      }
    }
  }
  return null;
}

/**
 * True when `trimmed` (already lowercased) opens with `phrase` as a whole invocation, not a
 * substring or a prefix of a longer word — `phrase` must be the entire text, or be followed by
 * whitespace or a sentence-boundary punctuation mark (`, . : ; ! ?`). Shared by the slash-command
 * check and the natural-language phrase check below, since both need the same "opens the message,
 * as itself" anchor and the same "don't match 'file an issued complaint'" word-boundary guard.
 */
function opensWithPhrase(trimmed: string, phrase: string): boolean {
  if (trimmed === phrase) return true;
  if (!trimmed.startsWith(phrase)) return false;
  const next = trimmed[phrase.length];
  return next === " " || next === "\n" || next === "," || next === "." || next === ":" ||
    next === ";" || next === "!" || next === "?";
}

/**
 * Recognizes a natural-language file-issue invocation by SHAPE rather than as an enumerated phrase
 * list (web-jam-tools#973, web-jam-tools#975 fixed one literal phrase at a time and Josh was refused
 * twice in the same day on ordinary phrasings a literal list can never keep up with — "create an
 * issue for JaMmusic then for the work you want to dispatch to Flash" before #975 merged, then
 * "please create a new issue to constrain adding to memory..." right after, because of the leading
 * "please" AND the word "new"). Josh: "use a regex so that I can say various chat messages that =
 * file, create, whatever and issue, ticket, whatever". skills/file-issue/SKILL.md's frontmatter
 * `description` documents the same shape in prose (a filing verb, optionally behind "please"/"can you
 * ...", followed by issue/ticket/bug) — see the drift test tying the two together below — rather than
 * a closed list of literal strings, since a regex's contract is "matches this shape", not
 * "traceable to an enumerated string".
 *
 * Widened again for web-jam-tools#1000 "Widen file-issue natural-language matcher: leading
 * affirmation + bounded filler words": Josh was refused on "yes file the new issue and link it to the
 * Epic https://..." because the leading "yes" affirmation, a normal way Josh approves, was not a
 * recognized opener ("the new" already fit the old determiner+adjective slot). Two additions, neither
 * loosening the anchor:
 *   1. An optional leading affirmation — yes/yeah/yep/ok/okay/sure, with an optional comma — since
 *      Josh routinely opens an approval with one of these before the actual instruction.
 *   2. The single fixed determiner-then-adjective slot is replaced with a BOUNDED repeat (0 to 3) of
 *      one filler-word group (a/an/the/new/another/quick/separate/follow-up), so short runs of
 *      filler in any order/count up to the bound are absorbed, while an unrelated word (as in "file
 *      the report and later issue a refund") still is not — it is not in the filler list, so the
 *      loop stops and the required noun fails to match right after, exactly as before.
 *      The demonstratives "this"/"that" are deliberately NOT fillers: they point at an issue that
 *      already exists, and after the verbs with a non-filing meaning (open/add/make/log/write) they
 *      would authorize filing on "add that issue to the Epic" or "open this issue".
 * Neither change touches the START anchor below, so mention-vs-use and the far-apart-verb-and-noun
 * case are unaffected.
 *
 * `^\s*` is load-bearing (see filingSkillInvoked's doc comment): it is the same mention-vs-use
 * distinction every other check in this file draws. Anchoring at the START of the (already-trimmed)
 * message is what makes "I don't want you to file an issue" and "the file-issue skill says to open an
 * issue" both fail to authorize — neither opens with the verb, so neither can reach the alternation at
 * all. Do not relax this anchor (e.g. to `\b`) to make some hard phrasing match; if a genuine
 * "must-match" case cannot be matched without weakening it, that is a decision for Josh, not something
 * to fix by widening the gate.
 *
 * design-issue/SKILL.md documents no equivalent natural-language trigger — only its slash form,
 * `/design-issue`, appears anywhere in that file — so this regex is deliberately used only for
 * file-issue (see filingSkillInvoked below); inventing a natural-language form for design-issue
 * without a documented source is out of scope.
 */
export const FILE_ISSUE_INVOCATION_RE =
  /^\s*(?:(?:yes|yeah|yep|okay|ok|sure)\b(?:\s*,)?\s+)?(?:please\s+|pls\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:go\s+ahead\s+and\s+)?(?:file|create|open|draft|make|add|log|raise|write)\s+(?:me\s+)?(?:(?:a|an|the|new|another|quick|separate|follow-up)\b\s+){0,3}(?:issue|ticket|bug\s+report|bug)\b/i;

/**
 * Returns the filing skill a piece of user-turn text invokes, or null. Recognizes three forms:
 *
 * 1. A slash command (`/file-issue`, `/design-issue`) opening the (trimmed) text — a slash command
 *    is only recognized by either surface when it opens the message, so prose that merely mentions
 *    "/file-issue" mid-sentence (discussing the skill, not invoking it) must not count, the same
 *    mention-vs-use distinction this repo's other banned-phrase/invocation checks apply.
 * 1a. The same slash command in Claude Code's `<command-name>` invocation wrapper, which is what
 *    that surface actually stores for a typed `/file-issue` — see CLAUDE_CODE_INVOCATION_WRAPPER.
 *    Same start-of-turn anchor, so the mention-vs-use distinction is unchanged: a `<command-name>`
 *    element quoted inside prose is not the turn's own invocation and does not count
 *    (web-jam-tools#920).
 * 2. For file-issue only, FILE_ISSUE_INVOCATION_RE matching at the start of the text (same
 *    start-of-message anchor — web-jam-tools#866 Suggestion: Josh routinely invokes file-issue by
 *    saying "file an issue" (or "create an issue") rather than typing the slash form, and a session
 *    that started that way was being refused a token write despite a genuine authorizing
 *    invocation; web-jam-tools#973/#975 then found that a literal phrase list can never keep up with
 *    ordinary phrasing, hence the shape-based regex). design-issue has no natural-language form
 *    recognized here; see FILE_ISSUE_INVOCATION_RE's doc comment for why none is invented for it.
 */
export function filingSkillInvoked(text: string): FilingSkill | null {
  const trimmed = text.trim().toLowerCase();
  const wrapped = slashCommandFromInvocationWrapper(trimmed);
  if (wrapped && AUTHORIZING_FILING_SKILLS.includes(wrapped as FilingSkill)) {
    return wrapped as FilingSkill;
  }
  for (const skill of AUTHORIZING_FILING_SKILLS) {
    if (opensWithPhrase(trimmed, `/${skill}`)) {
      return skill;
    }
  }
  if (FILE_ISSUE_INVOCATION_RE.test(trimmed)) {
    return "file-issue";
  }
  return null;
}

export interface TokenWriteAuthorizationContext {
  /** The transcript entries to scan — the invoking session's own transcript. */
  entries: readonly TranscriptEntry[];
  /** Claude Code: the session id. Antigravity: the conversationId. Empty/null means undetermined
   * — the check fails closed rather than guessing. */
  ownConversationId: string | null;
  /**
   * True when THIS invocation is itself happening inside a dispatched subagent's turn, so the
   * write must be refused regardless of what an authorizing turn elsewhere in the transcript says
   * (acceptance criterion: "A dispatched subagent is refused a token write even when an
   * authorizing skill invocation is present on the most recent user turn"). Claude Code computes
   * this mechanically (see tailIsCurrentlySidechain below); Antigravity subagents run in isolated
   * conversations with their own conversationId and separate transcript containing only the
   * dispatched task prompt (which does not start with /file-issue or /design-issue), so
   * isOwnSessionUserTurnBoundary never matches a parent turn and the scan denies it in practice.
   */
  isSubagentInvocation: boolean;
}

export interface TokenWriteAuthorizationResult {
  ok: boolean;
  reason?: string;
  /** Which skill's invocation satisfied the check, when ok is true. */
  skill?: FilingSkill;
}

/**
 * Decides whether scripts/write_issue_approval_token.ts may write a token for this invocation.
 *
 * Scans the transcript BACKWARD (most recent first) for the first own-session user turn
 * (isOwnSessionUserTurnBoundary — already excludes another conversation's/subagent's entries) that
 * invokes /design-issue or /file-issue. The scan is bounded only by one thing — a scope-ending
 * event: any intervening non-filing slash command (/work-issue, etc.) terminates authorization
 * immediately, preventing cross-skill leaks. There is no separate turn-count cap (web-jam-tools#956
 * removed the earlier 20-turn window): the search covers this session's own transcript in full,
 * since a long `/design-issue` run can settle decisions over many turns before filing at the end,
 * and the token this check gates is already bound to this session id and carries its own bounded
 * TTL — a second, shorter expiry here only broke the runs it exists to serve.
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
        "Refused: could not determine this invocation's own session/conversation identity, so the authorizing invocation cannot be verified. Failing closed rather than guessing.",
    };
  }

  for (let i = ctx.entries.length - 1; i >= 0; i--) {
    const entry = ctx.entries[i];
    if (!isOwnSessionUserTurnBoundary(entry, ctx.ownConversationId)) continue;
    const text = extractEntryText(entry);
    const otherCmd = nonFilingSlashCommandInvoked(text);
    if (otherCmd) {
      return {
        ok: false,
        reason:
          `Refused: a different skill or command (${otherCmd}) was invoked since any filing skill invocation.`,
      };
    }
    const skill = filingSkillInvoked(text);
    if (skill) return { ok: true, skill };
  }

  return {
    ok: false,
    reason:
      `Refused: no /design-issue invocation, and no /file-issue invocation (slash form, or a natural-language phrase like "file an issue"/"create a ticket"/"can you open a bug report"), found anywhere in this session's own transcript. Get Josh's explicit approval for this plan first, or ask him directly.`,
  };
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
