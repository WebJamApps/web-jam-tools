// test/gate1_reply_fixtures.ts — web-jam-tools#1412
//
// Session-transcript fixtures for the Gate 1 reply check, one per tool: a Claude Code transcript, an
// agy transcript_full.jsonl with its hook record, and a Codex rollout. Each writes its files under a
// temporary HOME and returns the env the command reads, so the CLI runs against the fixture exactly
// as it would against a live session.

import * as path from "@std/path";

export type TurnKind = "josh" | "agent" | "subagent" | "tool";

export interface FixtureTurn {
  kind: TurnKind;
  text: string;
  /** When the tool recorded the turn. */
  at: Date;
}

export interface SessionFixture {
  surface: "Claude Code" | "agy" | "Codex";
  sessionId: string;
  transcriptPath: string;
  env: (name: string) => string | undefined;
}

function envOf(vars: Record<string, string>): (name: string) => string | undefined {
  return (name) => vars[name];
}

async function writeLines(file: string, records: unknown[]): Promise<void> {
  await Deno.mkdir(path.dirname(file), { recursive: true });
  await Deno.writeTextFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export async function claudeCodeFixture(
  home: string,
  turns: FixtureTurn[],
  sessionId = "11111111-2222-4333-8444-555555555555",
): Promise<SessionFixture> {
  const transcriptPath = path.join(home, ".claude", "projects", "-home-josh", `${sessionId}.jsonl`);
  const records = turns.map((t) => {
    const timestamp = t.at.toISOString();
    switch (t.kind) {
      case "josh":
        return {
          type: "user",
          isSidechain: false,
          origin: { kind: "human" },
          timestamp,
          message: { role: "user", content: t.text },
        };
      case "agent":
        return {
          type: "assistant",
          isSidechain: false,
          timestamp,
          message: { role: "assistant", content: [{ type: "text", text: t.text }] },
        };
      case "subagent":
        return {
          type: "user",
          isSidechain: true,
          timestamp,
          message: { role: "user", content: t.text },
        };
      case "tool":
        return {
          type: "user",
          isSidechain: false,
          timestamp,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: t.text }],
          },
        };
    }
  });
  await writeLines(transcriptPath, records);
  return {
    surface: "Claude Code",
    sessionId,
    transcriptPath,
    env: envOf({ HOME: home }),
  };
}

export async function agyFixture(
  home: string,
  turns: FixtureTurn[],
  conversationId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
): Promise<SessionFixture> {
  const brain = path.join(home, ".gemini", "antigravity-cli", "brain");
  const logs = path.join(brain, conversationId, ".system_generated", "logs");
  const transcriptPath = path.join(logs, "transcript_full.jsonl");
  const subagentId = "99999999-8888-4777-8666-555555555555";
  const subagentTurns = turns.filter((t) => t.kind === "subagent");
  const records = turns.filter((t) => t.kind !== "subagent").map((t, i) => {
    const created_at = t.at.toISOString().replace(/\.\d{3}Z$/, "Z");
    if (t.kind === "josh") {
      return {
        step_index: i,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at,
        content:
          `<USER_REQUEST>\n${t.text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${created_at}\n</ADDITIONAL_METADATA>`,
      };
    }
    if (t.kind === "agent") {
      return {
        step_index: i,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at,
        content: t.text,
      };
    }
    return {
      step_index: i,
      source: "SYSTEM",
      type: "RUN_COMMAND",
      status: "DONE",
      created_at,
      content: t.text,
    };
  });
  await writeLines(transcriptPath, records);
  // A subagent's opening prompt lives in its own conversation, which the parent lists.
  if (subagentTurns.length > 0) {
    const childLogs = path.join(brain, subagentId, ".system_generated", "logs");
    await writeLines(
      path.join(childLogs, "transcript_full.jsonl"),
      subagentTurns.map((t, i) => ({
        step_index: i,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: t.at.toISOString().replace(/\.\d{3}Z$/, "Z"),
        content: `<USER_REQUEST>\n${t.text}\n</USER_REQUEST>`,
      })),
    );
    await writeLines(
      path.join(brain, conversationId, ".system_generated", "subagents", `${subagentId}.json`),
      [{ conversationId: subagentId }],
    );
  }
  const recordPath = path.join(home, "agy-hook-invocations.jsonl");
  await writeLines(recordPath, [
    { conversationId, transcriptPath },
    {
      conversationId: subagentId,
      transcriptPath: path.join(
        brain,
        subagentId,
        ".system_generated",
        "logs",
        "transcript_full.jsonl",
      ),
    },
  ]);
  return {
    surface: "agy",
    sessionId: conversationId,
    transcriptPath,
    env: envOf({
      HOME: home,
      AGY_CONVERSATION_ID: conversationId,
      AGY_TRANSCRIPT_PATH: transcriptPath,
      AGY_HOOK_RECORD_PATH: recordPath,
    }),
  };
}

/** The env an agy subagent conversation under `parent` would carry (for the subagent case). */
export function agySubagentEnv(home: string): {
  sessionId: string;
  env: (name: string) => string | undefined;
} {
  const subagentId = "99999999-8888-4777-8666-555555555555";
  const transcriptPath = path.join(
    home,
    ".gemini",
    "antigravity-cli",
    "brain",
    subagentId,
    ".system_generated",
    "logs",
    "transcript_full.jsonl",
  );
  return {
    sessionId: subagentId,
    env: envOf({
      HOME: home,
      AGY_CONVERSATION_ID: subagentId,
      AGY_TRANSCRIPT_PATH: transcriptPath,
      AGY_HOOK_RECORD_PATH: path.join(home, "agy-hook-invocations.jsonl"),
    }),
  };
}

export async function codexFixture(
  home: string,
  turns: FixtureTurn[],
  threadId = "019a0000-1111-7222-8333-444444444444",
  meta: Record<string, unknown> = { source: "cli", originator: "codex-tui" },
): Promise<SessionFixture> {
  const sessions = path.join(home, ".codex", "sessions", "2026", "11", "22");
  const transcriptPath = path.join(sessions, `rollout-2026-11-22T10-00-00-${threadId}.jsonl`);
  const start = turns.length > 0 ? turns[0].at : new Date();
  const records: unknown[] = [
    { timestamp: start.toISOString(), type: "session_meta", payload: { id: threadId, ...meta } },
    {
      timestamp: start.toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>",
        }],
      },
    },
  ];
  for (const t of turns) {
    const timestamp = t.at.toISOString();
    if (t.kind === "josh") {
      records.push({
        timestamp,
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: t.text }] },
      });
    } else if (t.kind === "agent") {
      records.push({
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: t.text }],
        },
      });
    } else if (t.kind === "subagent") {
      // An instruction block Codex injects as a user message (a skill body), never typed by Josh.
      records.push({
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: `<skill>\n<name>design-issue</name>\n${t.text}\n</skill>`,
          }],
        },
      });
    } else {
      records.push({
        timestamp,
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call_1", output: t.text },
      });
    }
  }
  await writeLines(transcriptPath, records);
  return {
    surface: "Codex",
    sessionId: threadId,
    transcriptPath,
    env: envOf({ HOME: home, CODEX_THREAD_ID: threadId }),
  };
}

export const FIXTURES = [
  { name: "Claude Code", build: claudeCodeFixture },
  { name: "agy", build: agyFixture },
  { name: "Codex", build: codexFixture },
] as const;
