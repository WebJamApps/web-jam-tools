import {
  codexRunningModel,
  resolveSigningAuthor,
  type RunningModelOptions,
} from "../src/shared/codex_running_model.ts";

export interface WhoamiOptions extends RunningModelOptions {
  signing?: boolean;
  author?: string;
}

export async function runWhoami(
  options: WhoamiOptions = {},
  stdout: (text: string) => void = console.log,
  stderr: (text: string) => void = console.error,
): Promise<number> {
  try {
    const signature = options.signing
      ? await resolveSigningAuthor(options.author, options)
      : await codexRunningModel(options);
    stdout(signature ?? "");
    return 0;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(
    await runWhoami({
      signing: Deno.args[0] === "--signing-author",
      author: Deno.args[1],
    }),
  );
}
