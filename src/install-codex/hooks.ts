import { join } from "@std/path";

export const EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "Stop"] as const;
export type Event = typeof EVENTS[number];
export interface Registration {
  matcher?: string;
  hooks: { type: "command"; command: string }[];
}

export function hookCommand(path: string): string {
  return `WJT_SURFACE=codex '${path.replaceAll("'", "'\\''")}'`;
}

// Read the literal Bash arrays without executing the shared installer. Refuse
// unsupported shell syntax rather than silently omitting a safety hook.
function arrayEntries(source: string, name: string): string[] {
  const start = source.indexOf(`\n${name}=(`);
  if (start === -1 && !source.startsWith(`${name}=(`)) {
    throw new Error(`cannot read hook array ${name}`);
  }
  const offset = start === -1 ? 0 : start + 1;
  let rest = source.slice(offset + name.length + 2);
  const entries: string[] = [];
  while (true) {
    rest = rest.replace(/^\s+/, "");
    if (rest.startsWith("#")) {
      const newline = rest.indexOf("\n");
      if (newline === -1) break;
      rest = rest.slice(newline + 1);
      continue;
    }
    if (rest.startsWith(")")) {
      if (!entries.length) throw new Error(`empty hook array ${name}`);
      return entries;
    }
    const token = rest.match(/^(?:"([^"\\$`\n]*)"|'([^'\n]*)'|([a-zA-Z0-9_.-]+))(?=\s|\))/);
    if (!token) break;
    entries.push(token[1] ?? token[2] ?? token[3]);
    rest = rest.slice(token[0].length);
  }
  throw new Error(`cannot read hook array ${name}: expected literal entries`);
}

export function readHookRegistrations(source: string, home: string): Record<Event, Registration[]> {
  const arrays = ["SESSION_START_HOOKS", "PRE_TOOL_USE_HOOKS", "POST_TOOL_USE_HOOKS", "STOP_HOOKS"];
  return Object.fromEntries(EVENTS.map((event, index) => {
    const registrations = arrayEntries(source, arrays[index]).map((entry) => {
      const paired = event === "PreToolUse" || event === "PostToolUse";
      const parts = paired ? entry.split("::") : [entry];
      const script = parts[paired ? 1 : 0];
      if (parts.length !== (paired ? 2 : 1) || !script || !/^[a-zA-Z0-9_-]+\.sh$/.test(script)) {
        throw new Error(`invalid hook entry in ${arrays[index]}: ${entry}`);
      }
      const matcher = paired ? parts[0] : event === "SessionStart" ? "startup|resume" : undefined;
      if (paired && !matcher) throw new Error(`missing matcher in ${arrays[index]}`);
      return {
        ...(matcher === undefined ? {} : { matcher }),
        hooks: [{
          type: "command" as const,
          command: hookCommand(join(home, ".claude/hooks", script)),
        }],
      };
    });
    return [event, registrations];
  })) as Record<Event, Registration[]>;
}
