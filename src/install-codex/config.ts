import { parse } from "@std/toml";
import { join } from "@std/path";
import { type Event, EVENTS, hookCommand, type Registration } from "./hooks.ts";

const SANDBOX_LINE = 'sandbox_mode = "danger-full-access"';

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

/** Deep equality of parsed TOML values; a date-time is compared as the moment it names. */
function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((item, index) => same(item, b[index]));
  }
  if (object(a) || object(b)) {
    if (!object(a) || !object(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length &&
      keys.every((key) => key in b && same(a[key], b[key]));
  }
  return a === b;
}

function inPlaceError(reason: string): Error {
  return new Error(
    `cannot update the file in place (${reason}); remove the installer's hook tables by hand and run again`,
  );
}

const ANY_HEADER = /^\s*\[/;
const COMMENT = /^\s*#/;

const GROUP_HEADERS: Record<Event, RegExp> = {
  SessionStart: /^\s*\[\[\s*hooks\s*\.\s*SessionStart\s*\]\]\s*(?:#.*)?$/,
  PreToolUse: /^\s*\[\[\s*hooks\s*\.\s*PreToolUse\s*\]\]\s*(?:#.*)?$/,
  PostToolUse: /^\s*\[\[\s*hooks\s*\.\s*PostToolUse\s*\]\]\s*(?:#.*)?$/,
  Stop: /^\s*\[\[\s*hooks\s*\.\s*Stop\s*\]\]\s*(?:#.*)?$/,
};

const HANDLER_HEADERS: Record<Event, RegExp> = {
  SessionStart: /^\s*\[\[\s*hooks\s*\.\s*SessionStart\s*\.\s*hooks\s*\]\]\s*(?:#.*)?$/,
  PreToolUse: /^\s*\[\[\s*hooks\s*\.\s*PreToolUse\s*\.\s*hooks\s*\]\]\s*(?:#.*)?$/,
  PostToolUse: /^\s*\[\[\s*hooks\s*\.\s*PostToolUse\s*\.\s*hooks\s*\]\]\s*(?:#.*)?$/,
  Stop: /^\s*\[\[\s*hooks\s*\.\s*Stop\s*\.\s*hooks\s*\]\]\s*(?:#.*)?$/,
};

/** Line ranges [start, end) of the installer's own hook tables for one event. */
function managedRanges(
  lines: string[],
  event: Event,
  groups: Record<string, unknown>[],
  home: string,
): [number, number][] {
  const groupHeader = GROUP_HEADERS[event];
  const handlerHeader = HANDLER_HEADERS[event];
  const starts = lines.flatMap((line, index) => groupHeader.test(line) ? [index] : []);
  if (starts.length !== groups.length) {
    throw inPlaceError(`hooks.${event} is not written as [[hooks.${event}]] tables`);
  }
  const ranges: [number, number][] = [];
  groups.forEach((group, position) => {
    const start = starts[position];
    let end = start + 1;
    while (
      end < lines.length && (!ANY_HEADER.test(lines[end]) || handlerHeader.test(lines[end]))
    ) end++;
    const handlers = group.hooks as unknown[];
    const handlerStarts: number[] = [];
    for (let index = start + 1; index < end; index++) {
      if (handlerHeader.test(lines[index])) handlerStarts.push(index);
    }
    if (handlerStarts.length !== handlers.length) {
      throw inPlaceError(`a hooks.${event} table does not use [[hooks.${event}.hooks]] tables`);
    }
    const ours = handlers.map((handler) => managed(handler, home));
    if (!ours.includes(true)) return;
    if (!ours.includes(false)) ranges.push([start, end]);
    else {
      ours.forEach((own, index) => {
        if (own) ranges.push([handlerStarts[index], handlerStarts[index + 1] ?? end]);
      });
    }
  });
  // A range runs to the next table header. Give back a comment that follows the table, and
  // everything after that comment: it belongs to whatever comes next.
  return ranges.map(([start, end]) => {
    let stop = start + 1;
    while (stop < end && !COMMENT.test(lines[stop])) stop++;
    return [start, stop];
  });
}

function tableText(event: Event, entry: Registration): string {
  const matcher = entry.matcher === undefined ? "" : `matcher = ${JSON.stringify(entry.matcher)}\n`;
  const handlers = entry.hooks.map((handler) =>
    `\n[[hooks.${event}.hooks]]\ntype = ${JSON.stringify(handler.type)}\ncommand = ${
      JSON.stringify(handler.command)
    }\n`
  ).join("");
  return `\n[[hooks.${event}]]\n${matcher}${handlers}`;
}

/** Sets the top-level sandbox_mode key in the text, touching no other line. */
function setSandboxMode(lines: string[], present: boolean): void {
  if (!present) {
    lines.unshift(SANDBOX_LINE);
    return;
  }
  const firstTable = lines.findIndex((line) => ANY_HEADER.test(line));
  const topLevel = firstTable === -1 ? lines.length : firstTable;
  const index = lines.findIndex((line, position) =>
    position < topLevel && /^\s*(?:sandbox_mode|"sandbox_mode"|'sandbox_mode')\s*=/.test(line)
  );
  if (index === -1) throw inPlaceError("the top-level sandbox_mode line was not found");
  lines[index] = SANDBOX_LINE + (lines[index].endsWith("\r") ? "\r" : "");
}

/**
 * Brings config.toml to the wanted state by editing its text: the sandbox_mode line and the
 * installer's own hook tables. Every other line is kept byte for byte, so a value this
 * installer does not manage cannot change in form or meaning, and comments survive. The result
 * is parsed again and checked against the values read; a file that cannot be edited this way is
 * refused, never rewritten.
 */
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
  const expected: Record<string, unknown> = { ...hooks };
  const lines = source === "" ? [] : source.replace(/\n$/, "").split("\n");
  const remove: [number, number][] = [];
  let appended = "";
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
      expected[event] = [...other, ...wanted[event]];
      if (own.length) remove.push(...managedRanges(lines, event, current, home));
      appended += wanted[event].map((entry) => tableText(event, entry)).join("");
    }
  }
  // Leaving an already-correct file untouched keeps it byte-identical.
  if (!drift.length) return { text: source, drift };

  for (const [start, end] of remove.sort((a, b) => b[0] - a[0])) lines.splice(start, end - start);
  if (config.sandbox_mode !== "danger-full-access") {
    setSandboxMode(lines, config.sandbox_mode !== undefined);
  }
  const text = (lines.length ? lines.join("\n") + "\n" : "") + appended;

  // Prove the edit before anything is written: unmanaged values as read, managed values as wanted.
  const result = parse(text);
  for (const key of new Set([...Object.keys(config), ...Object.keys(result)])) {
    if (key !== "sandbox_mode" && key !== "hooks" && !same(config[key], result[key])) {
      throw inPlaceError(`the value of ${key} would change`);
    }
  }
  if (result.sandbox_mode !== "danger-full-access") {
    throw inPlaceError("sandbox_mode would not be set");
  }
  const written = object(result.hooks) ? result.hooks : {};
  for (const key of new Set([...Object.keys(expected), ...Object.keys(written)])) {
    if (!same(expected[key], written[key])) throw inPlaceError(`hooks.${key} would not match`);
  }
  return { text, drift };
}
