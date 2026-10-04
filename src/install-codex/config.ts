import { parse, stringify } from "@std/toml";
import { join } from "@std/path";
import { type Event, EVENTS, hookCommand, type Registration } from "./hooks.ts";

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function managed(handler: unknown, home: string): boolean {
  if (!object(handler) || handler.type !== "command" || typeof handler.command !== "string") {
    return false;
  }
  const command = handler.command;
  const directory = join(home, ".claude/hooks") + "/";
  // Only a command executing a script in our installed hook directory is ours.
  // An unrelated command mentioning that directory in its arguments is preserved.
  const path = command.replace(/^WJT_SURFACE=codex\s+/, "");
  return path.startsWith(hookCommand(directory).slice("WJT_SURFACE=codex ".length, -1)) ||
    path.startsWith(`"${directory}`) || path.startsWith(directory);
}

export function updateConfig(
  source: string,
  wanted: Record<Event, Registration[]>,
  home: string,
): { text: string; drift: string[] } {
  const config = parse(source);
  if (config.hooks !== undefined && !object(config.hooks)) throw new Error("hooks must be a table");
  const hooks = (config.hooks ?? {}) as Record<string, unknown>;
  const drift: string[] = [];
  if (config.sandbox_mode !== "danger-full-access") drift.push("sandbox_mode");
  config.sandbox_mode = "danger-full-access";
  for (const event of EVENTS) {
    const current = hooks[event] ?? [];
    if (!Array.isArray(current)) throw new Error(`hooks.${event} must be an array of tables`);
    const own: unknown[] = [];
    const other: unknown[] = [];
    for (const group of current) {
      if (!object(group) || !Array.isArray(group.hooks)) {
        throw new Error(`hooks.${event}: expected nested hooks array`);
      }
      const kept = group.hooks.filter((handler: unknown) => !managed(handler, home));
      const ours = group.hooks.filter((handler: unknown) => managed(handler, home));
      if (ours.length) own.push({ ...group, hooks: ours });
      if (kept.length || !ours.length) other.push({ ...group, hooks: kept });
    }
    if (JSON.stringify(own) !== JSON.stringify(wanted[event])) {
      for (const entry of wanted[event]) {
        if (!own.some((item) => JSON.stringify(item) === JSON.stringify(entry))) {
          drift.push(`hook registration ${event} ${entry.hooks[0].command}`);
        }
      }
      drift.push(`hook registrations ${event}: differ in entries or order`);
      hooks[event] = [...other, ...wanted[event]];
    }
  }
  config.hooks = hooks;
  // Leaving an already-correct file byte-identical also preserves its comments.
  return { text: drift.length ? stringify(config) : source, drift };
}
