import { join } from "@std/path";
import {
  readAuthorRoster,
  type RunningModelOptions,
} from "../../src/shared/codex_running_model.ts";

export const SIGNING_SESSION_ID = "01a10611-a947-7b00-87b3-414e9e2085eb";
export const LUNA_SIGNATURE = "Codex — GPT-6 Luna";

/** A real session file and real roster probe, isolated from the running session. */
export async function withSigningFixture(
  test: (
    options: RunningModelOptions,
    env: Record<string, string>,
    sessionPath: string,
  ) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "codex-signing-" });
  const directory = join(home, "sessions", "2026", "10", "04");
  const sessionPath = join(directory, `rollout-2026-10-04T04-39-43-${SIGNING_SESSION_ID}.jsonl`);
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    sessionPath,
    '{"type":"turn_context","payload":{"model":"gpt-6-luna"}}\n',
  );
  const env: Record<string, string> = {
    CODEX_HOME: home,
    CODEX_THREAD_ID: SIGNING_SESSION_ID,
    FORCED_PR_AUTHOR: "",
  };
  try {
    await test(
      { env: (name) => env[name], readRoster: readAuthorRoster },
      env,
      sessionPath,
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
}
