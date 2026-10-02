/**
 * Register the REAPER check on Codex's SessionStart surface. This merger is
 * deliberately append-only: the Claude/agy merger retires managed hooks, which
 * would remove unrelated Codex hooks. Never change hook trust or enabled state;
 * Codex owns those controls through /hooks.
 */
import { basename, dirname } from "node:path";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function mergeCodexReaperHook(
  hooksPath: string,
  installedHookPath: string,
  check = false,
): number {
  let data: Record<string, unknown> = {};
  let exists = false;
  try {
    const parsed: unknown = JSON.parse(Deno.readTextFileSync(hooksPath));
    if (!isObject(parsed)) throw new Error("hooks file must contain a JSON object");
    data = parsed;
    exists = true;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.error(`error: refusing to change ${hooksPath}: ${error}`);
      return 1;
    }
  }

  if (data.hooks !== undefined && !isObject(data.hooks)) {
    console.error(`error: refusing to change ${hooksPath}: hooks must be an object`);
    return 1;
  }
  const hooks = (data.hooks ?? {}) as Record<string, unknown>;
  if (hooks.SessionStart !== undefined && !Array.isArray(hooks.SessionStart)) {
    console.error(`error: refusing to change ${hooksPath}: SessionStart must be an array`);
    return 1;
  }
  const sessionStart = (hooks.SessionStart ?? []) as unknown[];
  // Shell single quotes keep whitespace, apostrophes and metacharacters in an
  // override path literal when Codex invokes the registered command.
  const command = `WJT_SURFACE=codex '${installedHookPath.replaceAll("'", "'\\''")}'`;
  const matcher = "startup|resume";
  const registered = sessionStart.some((entry) =>
    isObject(entry) && entry.matcher === matcher && Array.isArray(entry.hooks) &&
    entry.hooks.some((hook: unknown) =>
      isObject(hook) && hook.type === "command" && hook.command === command
    )
  );
  if (registered) {
    console.log(`${basename(hooksPath)}: Codex REAPER startup hook already registered (no-op)`);
    return 0;
  }
  if (check) {
    console.error(`${basename(hooksPath)}: missing Codex REAPER SessionStart hook ${command}`);
    return 1;
  }

  hooks.SessionStart = [...sessionStart, { matcher, hooks: [{ type: "command", command }] }];
  data.hooks = hooks;
  Deno.mkdirSync(dirname(hooksPath), { recursive: true });
  if (exists) {
    // makeTempFile prevents two installs in the same second overwriting a backup.
    const backup = Deno.makeTempFileSync({
      dir: dirname(hooksPath),
      prefix: `${basename(hooksPath)}.bak-${Date.now()}-`,
    });
    Deno.copyFileSync(hooksPath, backup);
    console.log(`${basename(hooksPath)}: backed up previous version to ${basename(backup)}`);
  }
  Deno.writeTextFileSync(hooksPath, JSON.stringify(data, null, 2) + "\n");
  console.log(`${basename(hooksPath)}: registered Codex REAPER startup hook`);
  return 0;
}

if (import.meta.main) {
  if (
    Deno.args.length < 2 || Deno.args.length > 3 ||
    (Deno.args.length === 3 && Deno.args[2] !== "--check")
  ) {
    console.error("usage: merge-codex-reaper-hook.ts HOOKS_PATH INSTALLED_HOOK_PATH [--check]");
    Deno.exit(1);
  }
  Deno.exit(mergeCodexReaperHook(Deno.args[0], Deno.args[1], Deno.args[2] === "--check"));
}
