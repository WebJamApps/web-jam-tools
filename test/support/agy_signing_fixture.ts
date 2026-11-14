import { join } from "@std/path";
import {
  readAuthorRoster,
  type RunningModelOptions,
} from "../../src/shared/codex_running_model.ts";

export const AGY_IDENTITIES = [
  {
    conversationId: "alpha",
    modelName: "gemini-4-argon-high",
    transcriptPath: "/tmp/alpha.jsonl",
    author: "agy — Gemini Argon",
  },
  {
    conversationId: "beta",
    modelName: "claude-sonnet-5-5-high",
    transcriptPath: "/tmp/beta.jsonl",
    author: "agy — Claude Sonnet 5.5",
  },
  {
    conversationId: "gamma",
    modelName: "gemini-3.8-flash-high",
    transcriptPath: "/tmp/gamma.jsonl",
    author: "agy — Gemini Flash",
  },
] as const;

/** Interleaved hook records and per-invocation context, never the workstation's live log. */
export async function withAgySigningFixture(
  test: (
    options: RunningModelOptions,
    env: Record<string, string>,
    recordPath: string,
  ) => Promise<void>,
  identity = AGY_IDENTITIES[0] as typeof AGY_IDENTITIES[number],
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "agy-signing-" });
  const recordPath = join(home, "invocations.jsonl");
  const env: Record<string, string> = {
    HOME: home,
    CODEX_THREAD_ID: "",
    CLAUDE_CODE_SESSION_ID: "",
    FORCED_PR_AUTHOR: "",
    WJT_SURFACE: "agy",
    AGY_HOOK_RECORD_PATH: recordPath,
    AGY_CONVERSATION_ID: identity.conversationId,
    AGY_MODEL_NAME: identity.modelName,
    AGY_TRANSCRIPT_PATH: identity.transcriptPath,
  };
  await Deno.writeTextFile(
    recordPath,
    [...AGY_IDENTITIES, AGY_IDENTITIES[0], AGY_IDENTITIES[1]]
      .map(({ conversationId, modelName, transcriptPath }) =>
        JSON.stringify({ conversationId, modelName, transcriptPath })
      ).join("\n") + "\n",
  );
  try {
    await test({ env: (name) => env[name], readRoster: readAuthorRoster }, env, recordPath);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
}
