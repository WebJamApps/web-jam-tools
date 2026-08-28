/**
 * Writes the issue-approval token when the /design-issue plan gate passes (web-jam-tools#595).
 *
 * Writes an approval token in the shape parsed by hooks/lib/check_issue_approval_token.ts:
 *   {
 *     "session_id": "<the session that got approval>",
 *     "repo": "<owner>/<repo>",
 *     "titles": ["exact title 1", "exact title 2", ...],
 *     "expires_at": "<ISO 8601 timestamp>"
 *   }
 *
 * Default token path: $HOME/.claude/state/issue-approval-token.json
 * Supports path override via ISSUE_APPROVAL_TOKEN_PATH env var or --token-path flag.
 *
 * web-jam-tools#808: the CLI invocation below refuses to write at all unless
 * hooks/lib/check_token_write_authorization.ts's decision 21 check passes — the most recent
 * own-session, non-sidechain user turn must have invoked /design-issue or /file-issue, and the
 * invocation must not itself be a dispatched subagent's own turn. See resolveWriteContext() below
 * for how the transcript to check is located on each surface. The exported buildApprovalToken/
 * writeApprovalToken/writeApprovalTokenSync functions themselves stay unchanged and unauthorized —
 * they are the mechanical "write this already-authorized token" primitives the CLI block calls
 * only after authorizeWrite() passes; nothing else in this repo imports them directly.
 *
 * CLI usage:
 *   deno run --allow-env --allow-read --allow-write scripts/write_issue_approval_token.ts \
 *     --session-id "<session-id>" \
 *     --repo "WebJamApps/web-jam-tools" \
 *     --title "Title 1" \
 *     --title "Title 2"
 */

import { dirname } from "@std/path";
import { parseArgs } from "@std/cli/parse-args";
import { type ApprovalToken, defaultTokenPath } from "../hooks/lib/check_issue_approval_token.ts";
import { loadTranscript, type TranscriptEntry } from "../hooks/lib/select_transcript_entry.ts";
import {
  checkTokenWriteAuthorization,
  tailIsCurrentlySidechain,
  type TokenWriteAuthorizationResult,
} from "../hooks/lib/check_token_write_authorization.ts";

export interface WriteApprovalTokenOptions {
  sessionId: string;
  repo: string;
  titles: string[];
  expiresAt?: string;
  ttlHours?: number;
  tokenPath?: string;
}

/**
 * Builds and validates an ApprovalToken object.
 * Throws an Error if required fields are missing or invalid.
 */
export function buildApprovalToken(options: WriteApprovalTokenOptions): ApprovalToken {
  const sessionId = options.sessionId?.trim();
  if (!sessionId) {
    throw new Error("sessionId is required and cannot be empty");
  }

  let repo = options.repo?.trim();
  if (!repo) {
    throw new Error("repo is required and cannot be empty");
  }
  if (!repo.includes("/")) {
    repo = `WebJamApps/${repo}`;
  }

  const titles = (options.titles || [])
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (titles.length === 0) {
    throw new Error("titles must contain at least one non-empty title");
  }

  let expiresAt = options.expiresAt?.trim();
  if (!expiresAt) {
    const ttlHours = options.ttlHours ?? 4;
    expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
  } else {
    const parsed = Date.parse(expiresAt);
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid expiresAt timestamp: ${expiresAt}`);
    }
  }

  return {
    session_id: sessionId,
    repo,
    titles,
    expires_at: expiresAt,
  };
}

/**
 * Writes the approval token to disk asynchronously.
 */
export async function writeApprovalToken(
  options: WriteApprovalTokenOptions,
): Promise<{ token: ApprovalToken; path: string }> {
  const token = buildApprovalToken(options);
  const path = options.tokenPath || defaultTokenPath();
  const dir = dirname(path);
  if (dir && dir !== ".") {
    await Deno.mkdir(dir, { recursive: true });
  }
  await Deno.writeTextFile(path, JSON.stringify(token, null, 2) + "\n");
  return { token, path };
}

/**
 * Writes the approval token to disk synchronously.
 */
export function writeApprovalTokenSync(
  options: WriteApprovalTokenOptions,
): { token: ApprovalToken; path: string } {
  const token = buildApprovalToken(options);
  const path = options.tokenPath || defaultTokenPath();
  const dir = dirname(path);
  if (dir && dir !== ".") {
    Deno.mkdirSync(dir, { recursive: true });
  }
  Deno.writeTextFileSync(path, JSON.stringify(token, null, 2) + "\n");
  return { token, path };
}

/**
 * Resolved authorization-check inputs for one CLI invocation: the transcript entries to scan,
 * whose conversation counts as "own", and whether this call is itself a subagent's turn.
 */
export interface ResolvedWriteContext {
  entries: TranscriptEntry[];
  ownConversationId: string | null;
  isSubagentInvocation: boolean;
}

/**
 * Claude Code discovery: finds THIS session's own transcript file purely from its session id, with
 * no hook-delivered payload to read it from (this script is a plain CLI, not a hook). Transcripts
 * live at ~/.claude/projects/<project-slug>/<session-id>.jsonl, but the slug is derived from
 * wherever the Claude Code process was originally launched — NOT the script's current working
 * directory, which a prior `cd` (e.g. into a /work-issue worktree) may have moved — so the slug
 * cannot be reconstructed from Deno.cwd(). Session ids are UUIDs, so searching every project
 * directory for a file named exactly "<session-id>.jsonl" is unambiguous and avoids needing the
 * slug algorithm at all.
 */
export async function resolveClaudeCodeWriteContext(
  sessionId: string,
): Promise<ResolvedWriteContext | null> {
  if (!sessionId) return null;
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "/home/joshua";
  const projectsDir = `${home}/.claude/projects`;
  let matchPath: string | null = null;
  try {
    for await (const projectEntry of Deno.readDir(projectsDir)) {
      if (!projectEntry.isDirectory) continue;
      const candidate = `${projectsDir}/${projectEntry.name}/${sessionId}.jsonl`;
      try {
        await Deno.stat(candidate);
        matchPath = candidate;
        break;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  if (!matchPath) return null;
  const entries = await loadTranscript(matchPath);
  return {
    entries,
    ownConversationId: sessionId,
    isSubagentInvocation: tailIsCurrentlySidechain(entries),
  };
}

/**
 * Antigravity discovery: agy has no hook-delivered payload here either, and unlike Claude Code its
 * transcript path cannot be located from a session id (Antigravity keys transcripts by
 * conversationId, which this script is never told directly). The one existing, real record of that
 * identity is hooks/lib/agy_hook_shim.ts's recordInvocation() — already writing every agy tool
 * call's full payload (conversationId, transcriptPath) to AGY_HOOK_RECORD_PATH (default
 * /tmp/agy-hook-invocations.jsonl) for an unrelated purpose (web-jam-tools#816). Because at least
 * one hook is registered against every command agy runs (".*::agy-model-guard.sh"), and recording
 * happens before the matched hook decides, THIS invocation's own run_command call is normally the
 * most recently recorded line by the time this script starts — so the last parseable line's
 * conversationId/transcriptPath is normally this invocation's own.
 *
 * Known limitation, stated rather than silently assumed away: this is a shared, cross-session log.
 * Under genuine concurrent agy activity the last line could belong to a different session's call
 * instead, and Antigravity's own transcript shape carries no in-band signal distinguishing a
 * subagent's turn from a person's (web-jam-tools#841 non-goals) — so unlike
 * resolveClaudeCodeWriteContext, this cannot compute isSubagentInvocation directly and always
 * returns false for it, leaning on checkTokenWriteAuthorization's text scan instead (see that
 * function's isSubagentInvocation doc comment for why that still denies a dispatched subagent's
 * own composed prompt in practice, short of an adversarial one).
 */
export async function resolveAntigravityWriteContext(): Promise<ResolvedWriteContext | null> {
  const recordPath = Deno.env.get("AGY_HOOK_RECORD_PATH") || "/tmp/agy-hook-invocations.jsonl";
  let text: string;
  try {
    text = await Deno.readTextFile(recordPath);
  } catch {
    return null;
  }
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const rec = parsed as Record<string, unknown>;
    const conversationId = typeof rec.conversationId === "string" ? rec.conversationId : "";
    const transcriptPath = typeof rec.transcriptPath === "string" ? rec.transcriptPath : "";
    if (!conversationId || !transcriptPath) continue;
    let entries: TranscriptEntry[];
    try {
      entries = await loadTranscript(transcriptPath);
    } catch {
      return null;
    }
    return { entries, ownConversationId: conversationId, isSubagentInvocation: false };
  }
  return null;
}

/**
 * Resolves the authorization context for one real CLI invocation: explicit flags first (also how
 * tests exercise the full path without needing real Claude Code/agy state on disk), then Claude
 * Code discovery, then Antigravity discovery. Undetermined (no session id, no explicit transcript,
 * neither surface's discovery finds anything) resolves to null conversation identity, which
 * checkTokenWriteAuthorization refuses rather than guesses at.
 */
export async function resolveWriteContext(
  options: { sessionId: string; transcriptPath?: string; conversationId?: string },
): Promise<ResolvedWriteContext> {
  if (options.transcriptPath) {
    let entries: TranscriptEntry[];
    try {
      entries = await loadTranscript(options.transcriptPath);
    } catch {
      entries = [];
    }
    const ownConversationId = options.conversationId || options.sessionId || null;
    return {
      entries,
      ownConversationId,
      isSubagentInvocation: tailIsCurrentlySidechain(entries),
    };
  }

  const claudeCode = await resolveClaudeCodeWriteContext(options.sessionId);
  if (claudeCode) return claudeCode;

  const antigravity = await resolveAntigravityWriteContext();
  if (antigravity) return antigravity;

  return { entries: [], ownConversationId: null, isSubagentInvocation: false };
}

/** Runs the decision 21 authorization check for one CLI invocation. Exported for testing. */
export async function authorizeWrite(
  options: { sessionId: string; transcriptPath?: string; conversationId?: string },
): Promise<TokenWriteAuthorizationResult> {
  const context = await resolveWriteContext(options);
  return checkTokenWriteAuthorization(context);
}

if (import.meta.main) {
  try {
    const args = parseArgs(Deno.args, {
      string: [
        "session-id",
        "repo",
        "title",
        "titles",
        "titles-file",
        "expires-at",
        "ttl-hours",
        "token-path",
        "transcript-path",
        "conversation-id",
      ],
      boolean: ["json", "help"],
      collect: ["title"],
      alias: {
        s: "session-id",
        r: "repo",
        t: "title",
        p: "token-path",
        h: "help",
      },
    });

    if (args.help) {
      console.log(
        `Usage: deno run --allow-env --allow-read --allow-write scripts/write_issue_approval_token.ts [options]

Options:
  -s, --session-id <id>     Session ID that received plan-gate approval (defaults to
                            $CLAUDE_CODE_SESSION_ID, $CLAUDE_SESSION_ID, or $SESSION_ID)
  -r, --repo <owner/repo>   Target repository (e.g. WebJamApps/web-jam-tools)
  -t, --title <title>       Approved issue title (can be repeated)
  --titles <list|json>      Approved titles as JSON array or comma-separated list
  --titles-file <path>      Path to file with titles (one per line or JSON array)
  --ttl-hours <hours>       Token TTL in hours (default: 4)
  --expires-at <iso>        Explicit expiration ISO 8601 timestamp
  -p, --token-path <path>   Override token output path (defaults to $ISSUE_APPROVAL_TOKEN_PATH or ~/.claude/state/issue-approval-token.json)
  --transcript-path <path>  Override transcript auto-discovery (web-jam-tools#808) with an explicit
                            transcript file to scan for the authorizing skill invocation
  --conversation-id <id>    Own conversation identity to check the transcript against (web-jam-tools#808);
                            defaults to --session-id when a transcript is given without it
  --json                    Output written token as JSON to stdout
  -h, --help                Show this help message
`,
      );
      Deno.exit(0);
    }

    const sessionId = args["session-id"] ||
      Deno.env.get("CLAUDE_CODE_SESSION_ID") ||
      Deno.env.get("CLAUDE_SESSION_ID") ||
      Deno.env.get("SESSION_ID") ||
      "";
    const repo = args.repo || "";

    const titles: string[] = [];
    if (Array.isArray(args.title)) {
      titles.push(...args.title);
    } else if (typeof args.title === "string" && args.title) {
      titles.push(args.title);
    }

    if (args.titles) {
      try {
        const parsed = JSON.parse(args.titles);
        if (Array.isArray(parsed)) {
          titles.push(...parsed.map(String));
        } else {
          titles.push(...args.titles.split(","));
        }
      } catch {
        titles.push(...args.titles.split(","));
      }
    }

    if (args["titles-file"]) {
      const content = await Deno.readTextFile(args["titles-file"]);
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          titles.push(...parsed.map(String));
        } else {
          titles.push(...content.split("\n"));
        }
      } catch {
        titles.push(...content.split("\n"));
      }
    }

    if (titles.length === 0 && args._.length > 0) {
      titles.push(...args._.map(String));
    }

    const ttlHours = args["ttl-hours"] ? Number(args["ttl-hours"]) : undefined;
    const expiresAt = args["expires-at"];
    const tokenPath = args["token-path"];

    // web-jam-tools#808: refuse unless the most recent own-session, non-sidechain user turn
    // invoked /design-issue or /file-issue, and never for a dispatched subagent's own turn — see
    // hooks/lib/check_token_write_authorization.ts for the decision and this file's
    // resolveWriteContext() for how each surface's transcript is located.
    const authorization = await authorizeWrite({
      sessionId,
      transcriptPath: args["transcript-path"],
      conversationId: args["conversation-id"],
    });
    if (!authorization.ok) {
      console.error(`Refused to write approval token: ${authorization.reason}`);
      Deno.exit(1);
    }

    const { token, path } = await writeApprovalToken({
      sessionId,
      repo,
      titles,
      ttlHours,
      expiresAt,
      tokenPath,
    });

    if (args.json) {
      console.log(JSON.stringify(token, null, 2));
    } else {
      console.log(`Approval token successfully written to ${path}`);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
}
