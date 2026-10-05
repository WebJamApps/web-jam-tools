import { codexRunningModel, type RunningModelOptions } from "../src/shared/codex_running_model.ts";

export async function runWhoami(
  options: RunningModelOptions = {},
  stdout: (text: string) => void = console.log,
  stderr: (text: string) => void = console.error,
): Promise<number> {
  try {
    stdout(await codexRunningModel(options));
    return 0;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) Deno.exit(await runWhoami());
