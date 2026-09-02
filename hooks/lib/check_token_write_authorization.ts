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
 * Maximum number of own-session user turns to scan backward for an authorizing filing skill.
 * Prevents a filing skill invocation early in a long session from unboundedly authorizing token
 * writes hours later during unrelated chat (Must Fix 2 on web-jam-tools#866).
 */
export const MAX_AUTHORIZING_USER_TURNS = 20;

/**
 * Returns the non-filing slash command invoked at the start of user-turn text, or null.
 *
 * Any intervening slash command (e.g. /work-issue, /book-gig, /handle-gmails) acts as a
 * scope-ending event: once the user invokes a different skill, any earlier filing skill
 * authorization in the session is terminated.
 */
export function nonFilingSlashCommandInvoked(text: string): string | null {
  const trimmed = text.trim();
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
 * Natural-language phrases that authorize a file-issue write, verbatim from file-issue/SKILL.md's
 * own frontmatter `description` ("Triggered when the user says 'file an issue', 'open an issue',
 * 'draft an issue' ...") — this scan is only allowed to enumerate phrases it can point at a
 * documented source for (design-issue/SKILL.md's guidance on trigger-list/matcher work: a case
 * list counts as closed only when every entry is a literal string traceable to something, never an
 * invented category). design-issue/SKILL.md's own description documents no equivalent
 * natural-language trigger — only its slash form, `/design-issue`, appears anywhere in that file —
 * so no phrase is added for it here; inventing one without a documented source would be exactly
 * the unenumerated-category failure that guidance warns against.
 */
const FILE_ISSUE_NATURAL_LANGUAGE_TRIGGERS = [
  "file an issue",
  "open an issue",
  "draft an issue",
] as const;

/**
 * Returns the filing skill a piece of user-turn text invokes, or null. Recognizes two forms:
 *
 * 1. A slash command (`/file-issue`, `/design-issue`) opening the (trimmed) text — a slash command
 *    is only recognized by either surface when it opens the message, so prose that merely mentions
 *    "/file-issue" mid-sentence (discussing the skill, not invoking it) must not count, the same
 *    mention-vs-use distinction this repo's other banned-phrase/invocation checks apply.
 * 2. For file-issue only, one of FILE_ISSUE_NATURAL_LANGUAGE_TRIGGERS opening the text (same
 *    start-of-message anchor — web-jam-tools#866 Suggestion: Josh routinely invokes file-issue by
 *    saying "file an issue" rather than typing the slash form, and a session that started that way
 *    was being refused a token write despite a genuine authorizing invocation). design-issue has no
 *    natural-language form recognized here; see FILE_ISSUE_NATURAL_LANGUAGE_TRIGGERS's doc comment
 *    for why none is invented for it.
 */
export function filingSkillInvoked(text: string): FilingSkill | null {
  const trimmed = text.trim().toLowerCase();
  for (const skill of AUTHORIZING_FILING_SKILLS) {
    if (opensWithPhrase(trimmed, `/${skill}`)) {
      return skill;
    }
  }
  for (const phrase of FILE_ISSUE_NATURAL_LANGUAGE_TRIGGERS) {
    if (opensWithPhrase(trimmed, phrase)) {
      return "file-issue";
    }
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
 * invokes /design-issue or /file-issue, bounded by two constraints:
 * 1. Scope-ending event: Any intervening non-filing slash command (/work-issue, etc.) terminates
 *    authorization immediately, preventing cross-skill leaks.
 * 2. Turn bound: The scan looks at most MAX_AUTHORIZING_USER_TURNS (20) user turns back,
 *    preventing an early filing skill invocation from authorizing writes in unrelated later chat.
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

  let userTurnsScanned = 0;
  for (let i = ctx.entries.length - 1; i >= 0; i--) {
    const entry = ctx.entries[i];
    if (!isOwnSessionUserTurnBoundary(entry, ctx.ownConversationId)) continue;
    userTurnsScanned++;
    if (userTurnsScanned > MAX_AUTHORIZING_USER_TURNS) {
      break;
    }
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
      `Refused: no /design-issue invocation, and no /file-issue invocation (slash form, or "file an issue"/"open an issue"/"draft an issue"), found within the last ${MAX_AUTHORIZING_USER_TURNS} user turns in this session's own transcript. Get Josh's explicit approval for this plan first, or ask him directly.`,
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
