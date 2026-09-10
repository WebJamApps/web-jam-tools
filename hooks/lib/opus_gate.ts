/**
 * Opus delegation gate decisions (web-jam-tools#965).
 *
 * Requirements: ~/Dropbox/web-jam-llms/Token_Savings/opus-delegation-gate-design-2026-08-18.md,
 * Appendix C, decisions D-6 (subagent edits in auto mode) and D-7 (a `/work-issue` run approves the
 * Opus session's own edits).
 *
 * hooks/opus-delegation-gate.sh makes the cheap exits itself (a subagent call outside auto mode, no
 * target path, a path outside any git working tree) and pipes every remaining PreToolUse payload to
 * this module, which prints one JSON decision.
 *
 * Main-thread call — allowed when:
 *   - the session model is not Opus, or
 *   - Josh's latest HUMAN prompt contains "opus edit ok", or
 *   - the most recent slash command in the transcript is a `/work-issue` Josh typed (D-7).
 *
 * Subagent call in auto mode (D-6) — allowed when the subagent's own model is not Opus, or when it is
 * Opus and the human prompt that spawned it contains "opus edit ok" or asks for an Opus subagent.
 * An undeterminable model or spawning prompt is refused.
 *
 * Only prompts a person actually sent count (isHumanPrompt), on every path: a task notification or
 * an isMeta injection can neither grant approval nor displace Josh's last real prompt.
 *
 * Session layout, read from a live Claude Code 2.1.267 session:
 *   <project>/<session_id>.jsonl                                  main transcript
 *   <project>/<session_id>/subagents/agent-<agent_id>.jsonl       subagent transcript (isSidechain)
 *   <project>/<session_id>/subagents/agent-<agent_id>.meta.json   {model, spawnDepth, parentAgentId, toolUseId}
 *
 * A depth-1 subagent's `toolUseId` names an Agent tool_use in the main transcript. A nested
 * subagent's names one in its parent's transcript, so the spawning prompt is always looked up
 * through the depth-1 ancestor — which is also why an approval covers that agent's descendants.
 */

import {
  extractEntryModel,
  extractEntryText,
  getOpusGateInfo,
  isHumanPrompt,
  isUserTurnBoundary,
  parseTranscriptJsonl,
  type TranscriptEntry,
} from "./select_transcript_entry.ts";
import { slashCommandFromInvocationWrapper } from "./check_token_write_authorization.ts";

export const ESCAPE_PHRASE = "opus edit ok";

/** A parent chain longer than this is treated as broken rather than walked forever. */
export const MAX_SPAWN_DEPTH = 32;

/** Reads a file as text, returning null when it is missing or unreadable. */
export type ReadText = (path: string) => string | null;

export function readTextOrNull(path: string): string | null {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
}

export interface GatePayload {
  agent_id?: unknown;
  permission_mode?: unknown;
  transcript_path?: unknown;
}

export interface GateDecision {
  decision: "allow" | "deny";
  /** Which path decided: the main thread's own edit, or a subagent's. */
  kind: "main" | "subagent";
  /** Why a call was refused, for the refusal message. Empty when allowed or when the reason is the standard one. */
  why: string;
}

function allow(kind: GateDecision["kind"]): GateDecision {
  return { decision: "allow", kind, why: "" };
}

function deny(kind: GateDecision["kind"], why: string): GateDecision {
  return { decision: "deny", kind, why };
}

export function isOpusModel(model: string): boolean {
  return /opus/i.test(model);
}

/** True when the text asks for an Opus subagent, e.g. "dispatch to an Opus subagent". */
export function asksForOpusSubagent(text: string): boolean {
  return /\bopus\s+sub-?agents?\b/i.test(text);
}

export function approvesOpusSubagent(text: string): boolean {
  return text.toLowerCase().includes(ESCAPE_PHRASE) || asksForOpusSubagent(text);
}

export interface SessionFiles {
  mainTranscriptPath: string;
  subagentsDir: string;
}

/**
 * Resolves a session's files from either transcript_path shape: the main transcript (what Claude
 * Code 2.1.267 sends on every PreToolUse call, subagent calls included) or a subagent's own
 * `subagents/agent-<id>.jsonl`. Both resolve to the same files. Returns null for any other path.
 */
export function resolveSessionFiles(transcriptPath: string): SessionFiles | null {
  if (!transcriptPath.endsWith(".jsonl")) return null;
  const parts = transcriptPath.split("/");
  if (parts.length >= 3 && parts[parts.length - 2] === "subagents") {
    const sessionDir = parts.slice(0, -2).join("/");
    if (!sessionDir) return null;
    return { mainTranscriptPath: `${sessionDir}.jsonl`, subagentsDir: `${sessionDir}/subagents` };
  }
  const sessionDir = transcriptPath.slice(0, -".jsonl".length);
  return { mainTranscriptPath: transcriptPath, subagentsDir: `${sessionDir}/subagents` };
}

interface SubagentMeta {
  model?: unknown;
  parentAgentId?: unknown;
  toolUseId?: unknown;
}

function bareAgentId(agentId: string): string {
  return agentId.startsWith("agent-") ? agentId.slice("agent-".length) : agentId;
}

function readSubagentMeta(
  files: SessionFiles,
  agentId: string,
  read: ReadText,
): SubagentMeta | null {
  const raw = read(`${files.subagentsDir}/agent-${bareAgentId(agentId)}.meta.json`);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as SubagentMeta : null;
  } catch {
    return null;
  }
}

/**
 * The subagent's real model: `model` from its meta file when that names a model family, otherwise
 * the last assistant `message.model` in its own transcript. Returns "" when neither says.
 */
export function resolveSubagentModel(files: SessionFiles, agentId: string, read: ReadText): string {
  const meta = readSubagentMeta(files, agentId, read);
  if (typeof meta?.model === "string" && /opus|sonnet|haiku|claude/i.test(meta.model)) {
    return meta.model;
  }
  const raw = read(`${files.subagentsDir}/agent-${bareAgentId(agentId)}.jsonl`);
  if (raw === null) return "";
  const entries = parseTranscriptJsonl(raw);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const isAssistant = entry.type === "assistant" || entry.message?.role === "assistant";
    if (!isAssistant || entry.isApiErrorMessage === true) continue;
    const model = extractEntryModel(entry);
    if (model) return model;
  }
  return "";
}

function toolUseIds(entry: TranscriptEntry): string[] {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === "tool_use" && typeof block.id === "string")
    .map((block) => block.id as string);
}

/**
 * The human prompt that spawned a subagent: walk `parentAgentId` up to the depth-1 ancestor, find
 * that ancestor's `toolUseId` in the main transcript, and take the nearest human prompt before it.
 * Returns null when the chain is broken, the tool_use is missing, or no human prompt precedes it.
 */
export function findSpawningHumanPrompt(
  files: SessionFiles,
  agentId: string,
  read: ReadText,
): TranscriptEntry | null {
  let meta = readSubagentMeta(files, agentId, read);
  for (let hops = 0; typeof meta?.parentAgentId === "string" && meta.parentAgentId !== ""; hops++) {
    if (hops >= MAX_SPAWN_DEPTH) return null;
    meta = readSubagentMeta(files, meta.parentAgentId, read);
  }
  const toolUseId = meta?.toolUseId;
  if (typeof toolUseId !== "string" || toolUseId === "") return null;

  const raw = read(files.mainTranscriptPath);
  if (raw === null) return null;
  const entries = parseTranscriptJsonl(raw);
  const spawnIndex = entries.findIndex((entry) =>
    entry.isSidechain !== true && toolUseIds(entry).includes(toolUseId)
  );
  for (let i = spawnIndex - 1; i >= 0; i--) {
    if (isHumanPrompt(entries[i])) return entries[i];
  }
  return null;
}

/** The slash command a user-turn text invokes — Claude Code's wrapper form or a bare leading `/` — or null. */
export function slashCommandOf(text: string): string | null {
  const trimmed = text.trim();
  const wrapped = slashCommandFromInvocationWrapper(trimmed);
  if (wrapped) return wrapped;
  const bare = trimmed.match(/^\/([a-zA-Z0-9_-]+)/);
  return bare ? bare[1].toLowerCase() : null;
}

/**
 * D-7: true when the most recent slash command in the transcript is a `/work-issue` that Josh typed.
 *
 * Josh's later plain messages do not end the approval; any other slash command does — the same
 * scope-ending rule hooks/lib/check_token_write_authorization.ts applies to the issue-approval token.
 * Local-command echoes (e.g. `/model`, which carry no origin) still count as that other command, so
 * the scope only ever ends early, never extends.
 */
export function workIssueApprovalActive(entries: readonly TranscriptEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isUserTurnBoundary(entry) || entry.isMeta === true) continue;
    const command = slashCommandOf(extractEntryText(entry));
    if (command === null) continue;
    return command === "work-issue" && isHumanPrompt(entry);
  }
  return false;
}

export function decideMainThreadEdit(transcriptPath: string, read: ReadText): GateDecision {
  const raw = transcriptPath ? read(transcriptPath) : null;
  if (raw === null) {
    return deny(
      "main",
      "The session transcript could not be read, so the session model is unknown.",
    );
  }
  const entries = parseTranscriptJsonl(raw);
  const info = getOpusGateInfo(entries);
  if (!info.model) {
    return deny("main", "The session model could not be determined from the transcript.");
  }
  if (!isOpusModel(info.model)) return allow("main");
  if (info.hasEscape || workIssueApprovalActive(entries)) return allow("main");
  return deny("main", "");
}

export function decideSubagentEdit(
  agentId: string,
  transcriptPath: string,
  read: ReadText,
): GateDecision {
  const files = resolveSessionFiles(transcriptPath);
  if (!files) {
    return deny("subagent", "The session's files could not be located from transcript_path.");
  }
  const model = resolveSubagentModel(files, agentId, read);
  if (!model) {
    return deny(
      "subagent",
      "The subagent's model could not be determined: no meta file or transcript names it.",
    );
  }
  if (!isOpusModel(model)) return allow("subagent");
  const prompt = findSpawningHumanPrompt(files, agentId, read);
  if (!prompt) {
    return deny(
      "subagent",
      "The message Josh typed that spawned this Opus subagent could not be found.",
    );
  }
  if (approvesOpusSubagent(extractEntryText(prompt))) return allow("subagent");
  return deny(
    "subagent",
    'This is an Opus subagent, and the message that spawned it neither contains "opus edit ok" nor asks for an Opus subagent.',
  );
}

export function decide(payload: GatePayload, read: ReadText = readTextOrNull): GateDecision {
  const agentId = typeof payload.agent_id === "string" ? payload.agent_id : "";
  const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  if (agentId && payload.permission_mode === "auto") {
    return decideSubagentEdit(agentId, transcriptPath, read);
  }
  // A subagent call outside auto mode keeps its exemption. The shell hook exits before calling this
  // module in that case; the branch keeps decide() total.
  if (agentId) return allow("subagent");
  return decideMainThreadEdit(transcriptPath, read);
}

if (import.meta.main) {
  let result = deny("main", "The hook payload could not be read.");
  try {
    const raw = await new Response(Deno.stdin.readable).text();
    const payload = JSON.parse(raw);
    if (payload && typeof payload === "object") result = decide(payload as GatePayload);
  } catch {
    // Fail closed: the deny above stands.
  }
  console.log(JSON.stringify(result));
}
