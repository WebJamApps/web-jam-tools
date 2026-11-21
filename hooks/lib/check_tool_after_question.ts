/**
 * PreToolUse workflow guard (matcher .*): refuse tool calls emitted after an
 * unanswered prose question (`?`) in the current turn across agy, Codex, and Claude Code.
 *
 * Design reference: ~/Dropbox/web-jam-llms/AI_Misbehaves/hooks-design-2026-09-15.md (v3.8.0),
 * sections "Tool calls after an unanswered question", "Every guard, its group, and its default",
 * and "Both surfaces" (web-jam-tools#1892).
 */

import { findQuestionPositions } from "./detect_clear_communication_violations.ts";
import {
  extractEntryText,
  isUserTurnBoundary,
  parseTranscriptJsonl,
  type TranscriptEntry,
} from "./select_transcript_entry.ts";
import { checkAndConsumeWorkflowSwitch, type SwitchCheckResult } from "./workflow_switch.ts";

export const GUARD_NAME = "block-tool-after-question";

const EXEMPT_TOOLS = new Set(["ask_question", "AskUserQuestion"]);

export type ToolAfterQuestionDecision =
  | { outcome: "allow"; note?: string }
  | { outcome: "allow-with-note"; note: string }
  | { outcome: "refuse"; message: string; snippet: string };

export interface EvaluateOptions {
  readFile?: (path: string) => string;
  switchChecker?: (guardName: string) => SwitchCheckResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCodexResponseMessage(entry: TranscriptEntry, role: "user" | "assistant"): boolean {
  if (entry.type !== "response_item" || !isRecord(entry.payload)) return false;
  return entry.payload.type === "message" && entry.payload.role === role;
}

function extractCodexAssistantText(entry: TranscriptEntry): string {
  if (!isRecord(entry.payload)) return "";
  const content = entry.payload.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || typeof part.text !== "string") continue;
    if (part.type === undefined || part.type === "output_text" || part.type === "text") {
      parts.push(part.text);
    }
  }
  return parts.join("\n");
}

function isSurfaceUserTurnBoundary(
  entry: TranscriptEntry,
  payloadConversationId: string,
): boolean {
  if (entry.type === "USER_INPUT") {
    const entryConv = typeof entry.conversationId === "string" ? entry.conversationId.trim() : "";
    if (payloadConversationId && entryConv && entryConv !== payloadConversationId) {
      return false;
    }
    return true;
  }
  if (isCodexResponseMessage(entry, "user")) {
    return true;
  }
  return isUserTurnBoundary(entry);
}

function extractAssistantProse(
  entry: TranscriptEntry,
  payloadConversationId: string,
): string {
  if (entry.type === "PLANNER_RESPONSE") {
    const entryConv = typeof entry.conversationId === "string" ? entry.conversationId.trim() : "";
    if (payloadConversationId && entryConv && entryConv !== payloadConversationId) {
      return "";
    }
    return typeof entry.content === "string" ? entry.content : "";
  }
  if (
    entry.type === "SYSTEM_MESSAGE" ||
    entry.type === "GENERIC" ||
    entry.type === "CHECKPOINT"
  ) {
    return "";
  }
  if (entry.type === "response_item") {
    return isCodexResponseMessage(entry, "assistant") ? extractCodexAssistantText(entry) : "";
  }
  if (entry.isSidechain === true || entry.isApiErrorMessage === true) {
    return "";
  }
  if (entry.type === "assistant" || entry.message?.role === "assistant") {
    return extractEntryText(entry);
  }
  return "";
}

/**
 * Collects all main-thread assistant prose strings emitted since the most recent
 * real user turn boundary across agy, Codex, and Claude Code transcripts.
 */
export function collectTurnAssistantTexts(
  entries: readonly TranscriptEntry[],
  payloadConversationId = "",
): string[] {
  let lastBoundaryIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isSurfaceUserTurnBoundary(entries[i], payloadConversationId)) {
      lastBoundaryIdx = i;
      break;
    }
  }

  const texts: string[] = [];
  for (let i = lastBoundaryIdx + 1; i < entries.length; i++) {
    const prose = extractAssistantProse(entries[i], payloadConversationId);
    if (prose.trim().length > 0) {
      texts.push(prose);
    }
  }
  return texts;
}

function snippetAroundQuestion(text: string, index: number, radius = 60): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + 1);
  let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = `…${snippet}`;
  return snippet;
}

export function findUnansweredQuestion(texts: readonly string[]): { snippet: string } | null {
  let match: { snippet: string } | null = null;
  for (const text of texts) {
    const positions = findQuestionPositions(text);
    if (positions.length > 0) {
      const lastPos = positions[positions.length - 1];
      match = { snippet: snippetAroundQuestion(text, lastPos) };
    }
  }
  return match;
}

export function formatRefusalMessage(snippet: string): string {
  return [
    `BLOCKED (${GUARD_NAME}): refusing tool call after an unanswered prose question in the current turn ("${snippet}").`,
    `This guard is working as designed. End your turn immediately and wait for Josh's actual reply — do not fabricate a user reply or retry through another tool or command; report \`${GUARD_NAME}\` and this message.`,
    `Remedy: end the turn so Josh can reply (a new user message clears the block immediately), or if Josh explicitly asks to bypass a false refusal, run \`deno task workflow-switch --guard ${GUARD_NAME} --ttl-minutes 15\`.`,
  ].join("\n");
}

export function formatWorkflowNote(reason: string): string {
  return `${GUARD_NAME}: ${reason}; proceeding via workflow default. Ensure you have not asked Josh an unanswered question in the current turn before calling tools.`;
}

function extractToolName(data: Record<string, unknown>): string {
  if (typeof data.tool_name === "string" && data.tool_name.trim()) {
    return data.tool_name.trim();
  }
  if (typeof data.name === "string" && data.name.trim()) {
    return data.name.trim();
  }
  if (isRecord(data.toolCall) && typeof data.toolCall.name === "string") {
    return data.toolCall.name.trim();
  }
  return "";
}

export function evaluateToolAfterQuestion(
  rawInput: string,
  options: EvaluateOptions = {},
): ToolAfterQuestionDecision {
  const readFile = options.readFile ?? ((filePath: string) => Deno.readTextFileSync(filePath));
  const switchChecker = options.switchChecker ??
    ((guardName: string) => checkAndConsumeWorkflowSwitch(guardName));

  if (!rawInput.trim()) {
    return { outcome: "allow-with-note", note: "hook payload is empty" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    return { outcome: "allow-with-note", note: "hook payload could not be parsed" };
  }

  if (!isRecord(parsed)) {
    return { outcome: "allow-with-note", note: "hook payload is not a JSON object" };
  }

  const toolName = extractToolName(parsed);
  if (EXEMPT_TOOLS.has(toolName)) {
    return { outcome: "allow" };
  }

  const agentId = typeof parsed.agent_id === "string" ? parsed.agent_id.trim() : "";
  if (agentId.length > 0) {
    return { outcome: "allow" };
  }

  const transcriptPath = typeof parsed.transcript_path === "string" && parsed.transcript_path.trim()
    ? parsed.transcript_path.trim()
    : typeof parsed.transcriptPath === "string" && parsed.transcriptPath.trim()
    ? parsed.transcriptPath.trim()
    : "";
  if (!transcriptPath) {
    return { outcome: "allow-with-note", note: "transcript_path is missing from hook payload" };
  }

  let content: string;
  try {
    content = readFile(transcriptPath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      outcome: "allow-with-note",
      note: `transcript file could not be read (${transcriptPath}: ${detail})`,
    };
  }

  const entries = parseTranscriptJsonl(content, false);
  if (content.trim().length > 0 && entries.length === 0) {
    return {
      outcome: "allow-with-note",
      note: `transcript file contains no valid JSONL entries (${transcriptPath})`,
    };
  }

  const payloadConversationId = typeof parsed.conversationId === "string"
    ? parsed.conversationId.trim()
    : "";
  const texts = collectTurnAssistantTexts(entries, payloadConversationId);
  const question = findUnansweredQuestion(texts);
  if (!question) {
    return { outcome: "allow" };
  }

  const sw = switchChecker(GUARD_NAME);
  if (sw.released) {
    return {
      outcome: "allow",
      note: sw.reason ?? `Released by workflow switch (${GUARD_NAME}).`,
    };
  }

  return {
    outcome: "refuse",
    snippet: question.snippet,
    message: formatRefusalMessage(question.snippet),
  };
}

if (import.meta.main) {
  try {
    const rawInput = await new Response(Deno.stdin.readable).text();
    const result = evaluateToolAfterQuestion(rawInput);
    if (result.outcome === "refuse") {
      console.error(result.message);
      Deno.exit(2);
    }
    if (result.outcome === "allow-with-note") {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: formatWorkflowNote(result.note),
        },
      }));
    } else if (result.note) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: `${GUARD_NAME}: ${result.note}`,
        },
      }));
    }
    Deno.exit(0);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: formatWorkflowNote(`unexpected checker error (${detail})`),
      },
    }));
    Deno.exit(0);
  }
}
