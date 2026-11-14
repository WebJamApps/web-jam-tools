import { parse } from "@std/toml";
import { join } from "@std/path";
import { type Event, EVENTS, hookCommand, type Registration } from "./hooks.ts";

const SANDBOX_LINE = 'sandbox_mode = "danger-full-access"';
const GMAIL_CONNECTOR = "connector_2128aebfecb84f64a069897515042a44";
const GMAIL_SEND_TOOLS = ["send_email", "send_draft", "forward_emails"] as const;

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

function gmailSwitchError(keys: string[]): Error {
  return new Error(
    `cannot update Gmail switches in place; set ${
      keys.map((key) => `${key} = false`).join(", ")
    } by hand and run again`,
  );
}

/** Only a complete, parsed prefix can end at a real TOML statement boundary. */
function statementStart(lines: string[], index: number): boolean {
  try {
    parse(lines.slice(0, index).join("\n") + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Keeps the inline comment and whitespace without mistaking a quoted # for a comment. */
function valueSuffix(line: string): string {
  let quote = "";
  for (let index = line.indexOf("=") + 1; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (quote === '"' && char === "\\") index++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") {
      let start = index;
      while (start > 0 && /[ \t]/.test(line[start - 1])) start--;
      return line.slice(start);
    }
  }
  return line.match(/[ \t]*\r?$/)![0];
}

function hasInlineParent(value: unknown, parts: string[]): boolean {
  if (!object(value) || !parts.length || !Object.hasOwn(value, parts[0])) return false;
  const child = value[parts[0]];
  return object(child) &&
    (Object.keys(child).length === 0 || hasInlineParent(child, parts.slice(1)));
}

/** The parser accepts extending an inline table, but the updater deliberately refuses it. */
function refuseInlineParents(lines: string[], keys: string[]): void {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const equals = line.indexOf("=");
    if (equals === -1 || !line.slice(equals + 1).trimStart().startsWith("{")) continue;
    if (!statementStart(lines, index)) continue;
    let header = "";
    for (let previous = index - 1; previous >= 0; previous--) {
      if (ANY_HEADER.test(lines[previous]) && statementStart(lines, previous)) {
        header = lines[previous];
        break;
      }
    }
    // Parse an empty placeholder to locate the assignment's key, including quoted/dotted keys.
    const assignment = parse(`${header}\n${line.slice(0, equals)} = {}\n`);
    const affected = keys.filter((key) => hasInlineParent(assignment, key.split(".").slice(0, -1)));
    if (affected.length) throw gmailSwitchError(affected);
  }
}

/** Edits only the three Gmail sending switches; uneditable representations fail closed. */
function setGmailSwitches(source: string, config: Record<string, unknown>): {
  text: string;
  drift: string[];
  apps: Record<string, unknown>;
} {
  const keys = GMAIL_SEND_TOOLS.map((tool) => `apps.${GMAIL_CONNECTOR}.tools.${tool}.enabled`);
  const apps = structuredClone(config.apps ?? {});
  if (!object(apps)) throw gmailSwitchError(keys);
  const connector = apps[GMAIL_CONNECTOR] ?? {};
  if (!object(connector)) throw gmailSwitchError(keys);
  const tools = connector.tools ?? {};
  if (!object(tools)) throw gmailSwitchError(keys);
  apps[GMAIL_CONNECTOR] = connector;
  connector.tools = tools;

  const drift: string[] = [];
  const lines = source.split("\n");
  let appended = "";
  for (const tool of GMAIL_SEND_TOOLS) {
    const key = `apps.${GMAIL_CONNECTOR}.tools.${tool}.enabled`;
    const current = tools[tool] ?? {};
    if (!object(current)) throw gmailSwitchError([key]);
    if (current.enabled === false) continue;
    drift.push(key);
    const header = { apps: { [GMAIL_CONNECTOR]: { tools: { [tool]: {} } } } };
    const start = lines.findIndex((line, index) => {
      if (!ANY_HEADER.test(line) || !statementStart(lines, index)) return false;
      try {
        return same(parse(line + "\n"), header);
      } catch {
        return false;
      }
    });
    if (start === -1) {
      // An existing value in a dotted key or inline table cannot be edited as a leaf table.
      if (tools[tool] !== undefined) throw gmailSwitchError([key]);
      appended += `\n[apps.${GMAIL_CONNECTOR}.tools.${tool}]\nenabled = false\n`;
    } else {
      let end = start + 1;
      while (
        end < lines.length && !(ANY_HEADER.test(lines[end]) && statementStart(lines, end))
      ) end++;
      const enabled = /^\s*(?:enabled|"enabled"|'enabled')\s*=\s*/;
      const index = lines.findIndex((line, position) =>
        position > start && position < end && enabled.test(line) && statementStart(lines, position)
      );
      if (current.enabled === undefined) {
        lines.splice(start + 1, 0, "enabled = false" + (lines[start].endsWith("\r") ? "\r" : ""));
      } else {
        if (index === -1) throw gmailSwitchError([key]);
        try {
          if (!same(parse(lines[index] + "\n"), { enabled: current.enabled })) {
            throw gmailSwitchError([key]);
          }
        } catch {
          throw gmailSwitchError([key]);
        }
        lines[index] = lines[index].match(enabled)![0] + "false" + valueSuffix(lines[index]);
      }
    }
    tools[tool] = { ...current, enabled: false };
  }
  if (drift.length) refuseInlineParents(lines, drift);
  let text = lines.join("\n");
  if (appended) text += (text && !text.endsWith("\n") ? "\n" : "") + appended;
  // Validate the entire apps subtree, including every unmanaged connector and tool.
  try {
    if (!same(parse(text).apps, apps)) throw gmailSwitchError(drift);
  } catch {
    throw gmailSwitchError(drift);
  }
  return { text, drift, apps };
}

/**
 * Brings config.toml to the wanted state by editing its text: the sandbox_mode line and the
 * installer's own hook tables and Gmail sending switches. Every other line is kept byte for byte,
 * so a value this installer does not manage cannot change in form or meaning, and comments survive.
 * The result is parsed again and checked against the values read; a file that cannot be edited
 * this way is refused, never rewritten.
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
  for (const [start, end] of remove.sort((a, b) => b[0] - a[0])) lines.splice(start, end - start);
  if (config.sandbox_mode !== "danger-full-access") {
    setSandboxMode(lines, config.sandbox_mode !== undefined);
  }
  const hooksText = drift.length
    ? (lines.length ? lines.join("\n") + "\n" : "") + appended
    : source;
  const gmail = setGmailSwitches(hooksText, config);
  drift.push(...gmail.drift);
  // Leaving an already-correct file untouched keeps it byte-identical.
  if (!drift.length) return { text: source, drift };
  const text = gmail.text;

  // Prove the edit before anything is written: unmanaged values as read, managed values as wanted.
  const result = parse(text);
  for (const key of new Set([...Object.keys(config), ...Object.keys(result)])) {
    if (
      key !== "sandbox_mode" && key !== "hooks" && key !== "apps" && !same(config[key], result[key])
    ) {
      throw inPlaceError(`the value of ${key} would change`);
    }
  }
  if (result.sandbox_mode !== "danger-full-access") {
    throw inPlaceError("sandbox_mode would not be set");
  }
  if (!same(result.apps, gmail.apps)) throw gmailSwitchError(gmail.drift);
  const written = object(result.hooks) ? result.hooks : {};
  for (const key of new Set([...Object.keys(expected), ...Object.keys(written)])) {
    if (!same(expected[key], written[key])) throw inPlaceError(`hooks.${key} would not match`);
  }
  return { text, drift };
}
