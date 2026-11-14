/** Gmail model context only; action permissions belong to the separate mail fence. */
import { codexRunningModel } from "../../src/shared/codex_running_model.ts";
import { loadTranscript, selectSessionModel } from "./select_transcript_entry.ts";

export const UNKNOWN_GMAIL_MODEL_NOTE =
  "Gmail model note: the session's model could not be read, so this call proceeds. If this is /handle-gmails on Opus, Fable or Astra, ask Josh the cost question first.";

export function gmailModelNote(model: string, surface: string): string | null {
  if (!model.trim()) return UNKNOWN_GMAIL_MODEL_NOTE;
  const expensive = surface === "codex"
    ? /\bastra\b/i.test(model)
    : /\b(opus|fable)\b/i.test(model);
  return expensive
    ? `Gmail model note: this session runs on ${model}. /handle-gmails asks Josh its cost question before any mailbox work on this model. A one-off lookup needs no question.`
    : null;
}

if (import.meta.main) {
  const surface = Deno.env.get("WJT_SURFACE") || "claude";
  let model = "";
  try {
    if (surface === "codex") {
      model = await codexRunningModel();
    } else {
      const input = await new Response(Deno.stdin.readable).text();
      model = selectSessionModel(await loadTranscript(input));
    }
  } catch {
    // Workflow default: an unreadable identity never blocks a mailbox call.
  }
  const note = gmailModelNote(model, surface);
  if (note) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: note },
      }),
    );
  }
}
