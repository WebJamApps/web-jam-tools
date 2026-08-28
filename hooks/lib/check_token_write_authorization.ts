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
 * Returns the filing skill a piece of user-turn text invokes as a slash command, or null.
 *
 * Anchored to the START of the (trimmed) text, not a substring match anywhere in it: a slash
 * command is only recognized by either surface when it opens the message, so prose that merely
 * mentions "/file-issue" mid-sentence (discussing the skill, not invoking it) must not count —
 * the same mention-vs-use distinction this repo's other banned-phrase/invocation checks apply.
 */
export function filingSkillInvoked(text: string): FilingSkill | null {
  const trimmed = text.trim().toLowerCase();
  for (const skill of AUTHORIZING_FILING_SKILLS) {
    const token = `/${skill}`;
    if (trimmed === token || trimmed.startsWith(`${token} `) || trimmed.startsWith(`${token}\n`)) {
      return skill;
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
   * this mechanically (see tailIsCurrentlySidechain below); Antigravity has no reliable direct
   * signal for it (see resolveAntigravityWriteContext's doc comment) and passes false, relying on
   * the scan below instead — a dispatched subagent's own composed prompt is virtually never a
   * literal "/file-issue"/"/design-issue" invocation, so the scan denies it in practice even
   * without this flag, though not as an adversarial-proof guarantee. This is a real, acknowledged
   * asymmetry between surfaces, not a gap silently assumed closed.
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
 * invokes /design-issue or /file-issue, mirroring decision 17's opus-delegation-gate.sh mechanism:
 * that gate explicitly rejected "read the literal last user turn alone" as an alternative, because
 * the grant would die on the user's very next message — the exact failure a single-turn check has
 * here too, since /design-issue's Gate 2 approval routinely lands many turns after the
 * /design-issue invocation itself. Scanning for the most recent occurrence (not just the latest
 * turn) is what keeps that legitimate multi-turn flow working; the resulting token's own bounded
 * expiry (4h TTL, unchanged by this fix) is what keeps a scan-based grant from being unboundedly
 * stale, the same way decision 17's branch-scoping bounds its own grant.
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
    const skill = filingSkillInvoked(extractEntryText(entry));
    if (skill) return { ok: true, skill };
  }

  return {
    ok: false,
    reason:
      "Refused: no /design-issue or /file-issue invocation found in this session's own transcript. Get Josh's explicit approval for this plan first, or ask him directly.",
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
