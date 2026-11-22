// src/design-issue/gate1_reply.ts — web-jam-tools#1412
//
// Holds a Gate 1 reply to text Josh typed. `design:gate1-approve` and `design:gate1-adopt` take
// `--session-id <id>` and record the reply only when it appears word for word in one of Josh's own
// turns of that session's transcript (for an approval, a turn after the latest `design:gate1`
// presentation). A reply found only in an agent's turn, a subagent's or sidechain's prompt, a tool
// result, an injected instruction block, or before the presentation is refused; a transcript that
// cannot be found, read or parsed is refused, naming its path.
//
// Each tool's transcript is found the way the Gate 2 token writer finds it
// (scripts/write_issue_approval_token.ts), and Josh's own turns are picked out with the shared reader
// hooks/lib/select_transcript_entry.ts:
//   - Claude Code: ~/.claude/projects/<any project>/<session-id>.jsonl; a turn counts when
//     isHumanPrompt() says a person sent it (never a sidechain, task notification, peer message,
//     tool result or isMeta injection).
//   - agy/Antigravity: the conversation the skill-run hook handed this command (AGY_CONVERSATION_ID,
//     AGY_TRANSCRIPT_PATH), corroborated against the hook record in strict mode; a subagent's
//     conversation is refused outright, and a turn counts when isOwnSessionUserTurnBoundary() says
//     it is this conversation's own prompt. Only the text inside <USER_REQUEST> is Josh's.
//   - Codex: the rollout file of CODEX_THREAD_ID under $CODEX_HOME/sessions (or ~/.codex/sessions),
//     which must be a human-started session; a turn is a user message, minus the instruction
//     blocks Codex injects as user messages (AGENTS.md, <environment_context>, <skill>, ...).

import { join } from "@std/path";
import {
  extractEntryText,
  isHumanPrompt,
  isOwnSessionUserTurnBoundary,
  parseTranscriptJsonl,
  tagAntigravityEntries,
  type TranscriptEntry,
} from "../../hooks/lib/select_transcript_entry.ts";
import { isHumanStartedCodexMeta } from "../../hooks/lib/codex_session_reader.ts";
import { resolveAntigravityWriteContext } from "../../scripts/write_issue_approval_token.ts";

export type ReplySurface = "Claude Code" | "agy" | "Codex";

/** One turn Josh typed, with when the tool recorded it (null when it carries no usable time). */
export interface JoshTurn {
  text: string;
  at: number | null;
}

export interface SessionTurns {
  surface: ReplySurface;
  transcriptPath: string;
  turns: JoshTurn[];
}

export interface ReplyCheckOptions {
  /** Session (Claude Code), conversation (agy) or thread (Codex) id of the approving session. */
  sessionId: string;
  /** The reply to look for, as passed to --reply or --reply-file. */
  reply: string;
  /**
   * For an approval: only turns after this ISO time (the latest presentation) count. A missing or
   * unparseable time is refused; omit the key only for adoption, which has no cutoff.
   */
  after?: string;
  /** Environment lookup; defaults to Deno.env.get. Tests point HOME/CODEX_HOME/AGY_* at fixtures. */
  env?: (name: string) => string | undefined;
}

export class Gate1ReplyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Gate1ReplyRefusal";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function isSafeId(id: string): boolean {
  return id.length > 0 && !id.includes("/") && !id.includes("\\") && !id.includes("..") &&
    id.trim() === id;
}

async function readText(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    throw new Gate1ReplyRefusal(
      `Cannot read the session transcript at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function parseStrict(text: string, path: string): TranscriptEntry[] {
  let entries: TranscriptEntry[];
  try {
    entries = parseTranscriptJsonl(text, true);
  } catch {
    throw new Gate1ReplyRefusal(`Cannot parse the session transcript at ${path}`);
  }
  if (entries.length === 0) {
    throw new Gate1ReplyRefusal(`The session transcript at ${path} holds no records`);
  }
  return entries;
}

// ---------------------------------------------------------------- Claude Code

/** Josh's own turns in a Claude Code transcript: prompts a person sent, nothing else. */
export function claudeCodeJoshTurns(entries: readonly TranscriptEntry[]): JoshTurn[] {
  return entries.filter((e) => isHumanPrompt(e)).map((e) => ({
    text: extractEntryText(e),
    at: parseTime(e.timestamp),
  }));
}

async function claudeCodeSession(
  sessionId: string,
  env: (name: string) => string | undefined,
): Promise<SessionTurns> {
  const home = env("HOME") || env("USERPROFILE") || "";
  const projectsDir = join(home, ".claude", "projects");
  const lookedFor = join(projectsDir, "<project>", `${sessionId}.jsonl`);
  const matches: string[] = [];
  try {
    for await (const project of Deno.readDir(projectsDir)) {
      if (!project.isDirectory) continue;
      const candidate = join(projectsDir, project.name, `${sessionId}.jsonl`);
      try {
        if ((await Deno.stat(candidate)).isFile) matches.push(candidate);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
          throw new Gate1ReplyRefusal(
            `Cannot read the session transcript at ${candidate}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
  } catch (err) {
    if (err instanceof Gate1ReplyRefusal) throw err;
    throw new Gate1ReplyRefusal(`No session transcript found: looked for ${lookedFor}`);
  }
  if (matches.length === 0) {
    throw new Gate1ReplyRefusal(`No session transcript found: looked for ${lookedFor}`);
  }
  if (matches.length > 1) {
    throw new Gate1ReplyRefusal(
      `More than one session transcript is named ${sessionId}.jsonl: ${matches.sort().join(", ")}`,
    );
  }
  const transcriptPath = matches[0];
  const entries = parseStrict(await readText(transcriptPath), transcriptPath);
  return { surface: "Claude Code", transcriptPath, turns: claudeCodeJoshTurns(entries) };
}

// ---------------------------------------------------------------- agy / Antigravity

/** The part of an agy prompt Josh typed: the <USER_REQUEST> block, never the metadata after it. */
export function agyUserRequestText(content: string): string {
  const match = content.match(/<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/);
  return match ? match[1] : "";
}

/** Josh's own turns in an agy transcript: this conversation's prompts, never another's. */
export function agyJoshTurns(
  entries: readonly TranscriptEntry[],
  conversationId: string,
): JoshTurn[] {
  return entries.filter((e) => isOwnSessionUserTurnBoundary(e, conversationId)).map((e) => ({
    text: agyUserRequestText(extractEntryText(e)),
    at: parseTime(e.created_at),
  }));
}

async function agySession(
  sessionId: string,
  env: (name: string) => string | undefined,
): Promise<SessionTurns> {
  const conversationId = env("AGY_CONVERSATION_ID") ?? "";
  const transcriptPath = env("AGY_TRANSCRIPT_PATH") ?? "";
  if (sessionId !== conversationId) {
    throw new Gate1ReplyRefusal(
      `--session-id ${sessionId} is not this agy conversation (${conversationId})`,
    );
  }
  if (!transcriptPath) {
    throw new Gate1ReplyRefusal(
      `No session transcript found for agy conversation ${sessionId}: AGY_TRANSCRIPT_PATH is unset`,
    );
  }
  // Read it ourselves first so a missing or damaged file is refused naming its path; the turns
  // themselves come from the strict resolver's own parse below.
  parseStrict(await readText(transcriptPath), transcriptPath);
  const recordPath = env("AGY_HOOK_RECORD_PATH") || "/tmp/agy-hook-invocations.jsonl";
  const context = await resolveAntigravityWriteContext(true, {
    conversationId,
    transcriptPath,
    recordPath,
  });
  if (!context) {
    throw new Gate1ReplyRefusal(
      `The agy transcript at ${transcriptPath} is not corroborated for conversation ${sessionId} by the hook record at ${recordPath}`,
    );
  }
  if (context.isSubagentInvocation) {
    throw new Gate1ReplyRefusal(
      `agy conversation ${sessionId} is a subagent's (or cannot be shown not to be); its prompts were written by its parent, not typed by Josh: ${transcriptPath}`,
    );
  }
  // The shared tagging helper keeps an entry's own conversation id, so a turn the transcript
  // attributes to another conversation stays excluded.
  const tagged = tagAntigravityEntries(context.entries, { conversationId });
  return { surface: "agy", transcriptPath, turns: agyJoshTurns(tagged, conversationId) };
}

// ---------------------------------------------------------------- Codex

/** An instruction block Codex injects as a user message: AGENTS.md, or one wrapped in a tag. */
export function isCodexInjectedText(text: string): boolean {
  const t = text.trim();
  if (t.startsWith("# AGENTS.md instructions")) return true;
  const open = t.match(/^<([A-Za-z_][\w-]*)(?:\s[^>]*)?>/);
  return open !== null && t.endsWith(`</${open[1]}>`);
}

/** Josh's own turns in a Codex rollout: user messages, minus the blocks Codex injects. */
export function codexJoshTurns(
  records: readonly Record<string, unknown>[],
  path: string,
): JoshTurn[] {
  const turns: JoshTurn[] = [];
  for (const record of records) {
    if (record.type !== "response_item" || !isRecord(record.payload)) continue;
    const message = record.payload;
    if (message.type !== "message" || message.role !== "user") continue;
    if (!Array.isArray(message.content)) {
      throw new Gate1ReplyRefusal(
        `Cannot parse a user message in the session transcript at ${path}`,
      );
    }
    const parts: string[] = [];
    for (const part of message.content) {
      if (!isRecord(part)) {
        throw new Gate1ReplyRefusal(
          `Cannot parse a user message in the session transcript at ${path}`,
        );
      }
      if (part.type === "input_text" && typeof part.text === "string") {
        if (!isCodexInjectedText(part.text)) parts.push(part.text);
      }
    }
    if (parts.length > 0) turns.push({ text: parts.join("\n"), at: parseTime(record.timestamp) });
  }
  return turns;
}

async function codexSession(
  sessionId: string,
  env: (name: string) => string | undefined,
): Promise<SessionTurns> {
  const threadId = env("CODEX_THREAD_ID") ?? "";
  if (sessionId !== threadId) {
    throw new Gate1ReplyRefusal(
      `--session-id ${sessionId} is not this Codex session (${threadId})`,
    );
  }
  const codexHome = env("CODEX_HOME") || join(env("HOME") || "", ".codex");
  const sessionsDir = join(codexHome, "sessions");
  const lookedFor = join(sessionsDir, "**", `*-${sessionId}.jsonl`);
  const matches: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory) await walk(full);
      else if (entry.name.endsWith(`-${sessionId}.jsonl`)) matches.push(full);
    }
  };
  try {
    await walk(sessionsDir);
  } catch {
    throw new Gate1ReplyRefusal(`No session transcript found: looked for ${lookedFor}`);
  }
  if (matches.length === 0) {
    throw new Gate1ReplyRefusal(`No session transcript found: looked for ${lookedFor}`);
  }
  if (matches.length > 1) {
    throw new Gate1ReplyRefusal(
      `More than one session transcript ends with ${sessionId}: ${matches.sort().join(", ")}`,
    );
  }
  const transcriptPath = matches[0];
  const records = parseStrict(await readText(transcriptPath), transcriptPath) as Record<
    string,
    unknown
  >[];
  const metas = records.filter((r) => r.type === "session_meta");
  if (metas.length !== 1 || !isRecord(metas[0].payload)) {
    throw new Gate1ReplyRefusal(`Cannot parse the session transcript at ${transcriptPath}`);
  }
  const meta = metas[0].payload;
  if (meta.id !== sessionId || !isHumanStartedCodexMeta(meta)) {
    throw new Gate1ReplyRefusal(
      `Codex session ${sessionId} is not one Josh started; its prompts were not typed by him: ${transcriptPath}`,
    );
  }
  return { surface: "Codex", transcriptPath, turns: codexJoshTurns(records, transcriptPath) };
}

// ---------------------------------------------------------------- the check

/** Finds the approving session's transcript on whichever tool is running this command. */
export async function findSessionTurns(
  sessionId: string,
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): Promise<SessionTurns> {
  const id = sessionId.trim();
  if (!id) {
    throw new Gate1ReplyRefusal(
      "No session id: pass --session-id <id> naming the session in which Josh replied.",
    );
  }
  if (!isSafeId(id)) {
    throw new Gate1ReplyRefusal(`--session-id is not a session id: ${JSON.stringify(sessionId)}`);
  }
  if (env("CODEX_THREAD_ID")) return await codexSession(id, env);
  if (env("AGY_CONVERSATION_ID")) return await agySession(id, env);
  return await claudeCodeSession(id, env);
}

/**
 * Refuses unless `reply` appears word for word in one of Josh's own turns of the session (after
 * `after`, when given). Returns where it was found.
 */
export async function verifyReplyTypedByJosh(
  options: ReplyCheckOptions,
): Promise<{ surface: ReplySurface; transcriptPath: string; turnAt: number | null }> {
  // Matched exactly as given: the caller stores this same text, so what is verified is what is
  // recorded (callers trim the input once, before both).
  const needle = options.reply;
  if (!needle.trim()) {
    throw new Gate1ReplyRefusal("Reply is empty — there is nothing Josh typed to look for.");
  }
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  const session = await findSessionTurns(options.sessionId, env);
  const hasCutoff = "after" in options;
  const after = hasCutoff ? parseTime(options.after) : null;
  if (hasCutoff && after === null) {
    throw new Gate1ReplyRefusal(
      `The Gate 1 record holds no usable presentation time (${
        JSON.stringify(options.after)
      }); present the document with deno task design:gate1 first.`,
    );
  }
  const holding = session.turns.filter((t) => t.text.includes(needle));
  const counted = after === null ? holding : holding.filter((t) => t.at !== null && t.at > after);
  if (counted.length > 0) {
    return {
      surface: session.surface,
      transcriptPath: session.transcriptPath,
      turnAt: counted[counted.length - 1].at,
    };
  }
  if (holding.length > 0) {
    throw new Gate1ReplyRefusal(
      `The reply appears in Josh's turns of ${session.transcriptPath} only before the document was last presented (${options.after}); a reply to an earlier presentation does not approve this one.`,
    );
  }
  throw new Gate1ReplyRefusal(
    `The reply does not appear word for word in any of Josh's own turns of ${session.transcriptPath} (${session.surface}); nothing was recorded. Record only text Josh typed.`,
  );
}
