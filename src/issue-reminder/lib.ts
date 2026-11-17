import { parseArgs } from "@std/cli/parse-args";

export const VALID_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
export type DayCode = (typeof VALID_DAYS)[number];

export const ALLOWED_GOOGLE_TOOLS = new Set([
  "createCalendarEvent",
  "getCalendarEvents",
  "deleteCalendarEvent",
]);

export const NEW_YORK_TZ = "America/New_York";
export const DEFAULT_TIME = "09:30";
export const EVENT_DURATION_MINUTES = 15;
export const OVERLAP_WINDOW_DAYS = 28;
const MCP_CALL_TIMEOUT_MS = 30_000;

export interface ClaudeGoogleDriveConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface IssueInfo {
  repo: string;
  issue: number;
  title: string;
  state: string;
  body: string;
  url: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  description: string;
  isAllDay: boolean;
  startMs?: number;
  endMs?: number;
  startDate?: string;
  endDate?: string;
  recurrence?: string[];
}

export interface RunCmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface McpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export interface Deps {
  readFile: (path: string) => Promise<string>;
  runCmd: (cmd: string, args: string[]) => Promise<RunCmdResult>;
  connectMcp: (cfg: ClaudeGoogleDriveConfig) => Promise<McpClient>;
  claudeConfigPath: () => string;
  now: () => Date;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export type ParsedCommand =
  | { subcommand: "help" }
  | {
    subcommand: "create";
    repo: string;
    issue: number;
    days: DayCode[];
    hour: number;
    minute: number;
    timeText: string;
    waitingOn?: string;
  }
  | {
    subcommand: "list";
    repo?: string;
    issue?: number;
  }
  | {
    subcommand: "delete";
    repo: string;
    issue: number;
  };

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DAY_SET = new Set<string>(VALID_DAYS);
const ISSUE_URL_RE =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)(?![0-9])/i;
const ISSUE_URL_GLOBAL_RE =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)(?![0-9])/gi;

export function issueAddressFor(repo: string, issue: number): string {
  return `https://github.com/${repo}/issues/${issue}`;
}

export function parseRepo(raw: unknown): string {
  if (typeof raw !== "string" || !REPO_RE.test(raw.trim())) {
    throw new Error("Refused: --repo must be in <owner/repo> format.");
  }
  return raw.trim();
}

export function parseIssueNumber(raw: unknown): number {
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) {
    throw new Error("Refused: --issue must be a positive integer.");
  }
  const num = Number(raw.trim());
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new Error("Refused: --issue must be a positive integer.");
  }
  return num;
}

export function parseDays(raw: unknown): DayCode[] {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Refused: --days is required (for example TU,FR).");
  }
  const parts = raw.split(",").map((part) => part.trim().toUpperCase());
  if (parts.some((part) => !part)) {
    throw new Error(
      `Refused: invalid --days value "${raw}" (empty day entry; use MO,TU,WE,TH,FR,SA,SU).`,
    );
  }
  const result: DayCode[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (!DAY_SET.has(part)) {
      throw new Error(
        `Refused: "${part}" is not a day name (expected two-letter days from MO,TU,WE,TH,FR,SA,SU).`,
      );
    }
    if (!seen.has(part)) {
      seen.add(part);
      result.push(part as DayCode);
    }
  }
  return result;
}

export function parseTime(raw: unknown): { hour: number; minute: number; text: string } {
  if (raw === undefined) {
    return { hour: 9, minute: 30, text: DEFAULT_TIME };
  }
  if (typeof raw !== "string" || !/^(\d{1,2}):(\d{2})$/.test(raw.trim())) {
    throw new Error(`Refused: "${String(raw)}" is not a time (expected HH:MM in 00:00-23:59).`);
  }
  const match = raw.trim().match(/^(\d{1,2}):(\d{2})$/)!;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Refused: "${raw}" is not a time (expected HH:MM in 00:00-23:59).`);
  }
  return {
    hour,
    minute,
    text: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

export function parseCliArgs(argv: string[]): ParsedCommand {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    return { subcommand: "help" };
  }
  const sub = argv[0];
  if (sub !== "create" && sub !== "list" && sub !== "delete") {
    throw new Error(
      `Refused: unknown subcommand "${sub}". Expected one of: create, list, delete.`,
    );
  }
  let unknownFlag: string | null = null;
  const flags = parseArgs(argv.slice(1), {
    string: ["repo", "issue", "days", "time", "waiting-on"],
    boolean: ["help"],
    alias: { h: "help" },
    unknown: (arg) => {
      if (arg.startsWith("-") && unknownFlag === null) {
        unknownFlag = arg;
      }
      return false;
    },
  });
  if (flags.help) return { subcommand: "help" };
  if (unknownFlag !== null) {
    throw new Error(`Refused: unknown option "${unknownFlag}".`);
  }
  if (flags._.length > 0) {
    throw new Error(`Refused: unexpected argument "${String(flags._[0])}".`);
  }

  if (sub === "list") {
    const hasRepo = flags.repo !== undefined;
    const hasIssue = flags.issue !== undefined;
    if (hasRepo !== hasIssue) {
      throw new Error("Refused: list filters require both --repo and --issue together.");
    }
    if (!hasRepo) return { subcommand: "list" };
    return {
      subcommand: "list",
      repo: parseRepo(flags.repo),
      issue: parseIssueNumber(flags.issue),
    };
  }

  const repo = parseRepo(flags.repo);
  const issue = parseIssueNumber(flags.issue);

  if (sub === "delete") {
    return { subcommand: "delete", repo, issue };
  }

  const days = parseDays(flags.days);
  const time = parseTime(flags.time);
  const waitingOn = typeof flags["waiting-on"] === "string" && flags["waiting-on"].trim()
    ? flags["waiting-on"].trim()
    : undefined;
  return {
    subcommand: "create",
    repo,
    issue,
    days,
    hour: time.hour,
    minute: time.minute,
    timeText: time.text,
    waitingOn,
  };
}

export async function loadGoogleDriveMcpConfig(
  deps: Pick<Deps, "readFile" | "claudeConfigPath">,
): Promise<ClaudeGoogleDriveConfig> {
  const configPath = deps.claudeConfigPath();
  let rawText: string;
  try {
    rawText = await deps.readFile(configPath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Refused: could not read ~/.claude.json (${configPath}): ${detail}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`Refused: ~/.claude.json (${configPath}) is not valid JSON.`);
  }

  const mcpServers = (parsed && typeof parsed === "object" && "mcpServers" in parsed)
    ? (parsed as { mcpServers?: unknown }).mcpServers
    : undefined;
  const entry = (mcpServers && typeof mcpServers === "object" && "google-drive" in mcpServers)
    ? (mcpServers as Record<string, unknown>)["google-drive"]
    : undefined;

  if (!entry || typeof entry !== "object") {
    throw new Error(
      `Refused: ~/.claude.json (${configPath}) has no "google-drive" entry under mcpServers.`,
    );
  }

  const record = entry as Record<string, unknown>;
  if (typeof record.command !== "string" || !record.command.trim()) {
    throw new Error(
      `Refused: ~/.claude.json "google-drive" entry has no valid "command".`,
    );
  }

  const args: string[] = [];
  if (record.args !== undefined) {
    if (!Array.isArray(record.args) || record.args.some((a) => typeof a !== "string")) {
      throw new Error(
        `Refused: ~/.claude.json "google-drive" entry has non-string "args".`,
      );
    }
    args.push(...(record.args as string[]));
  }

  const env: Record<string, string> = {};
  if (record.env !== undefined) {
    if (!record.env || typeof record.env !== "object" || Array.isArray(record.env)) {
      throw new Error(
        `Refused: ~/.claude.json "google-drive" entry has invalid "env".`,
      );
    }
    for (const [key, val] of Object.entries(record.env as Record<string, unknown>)) {
      if (typeof val !== "string") {
        throw new Error(
          `Refused: ~/.claude.json "google-drive" env.${key} must be a string.`,
        );
      }
      env[key] = val;
    }
  }

  return { command: record.command.trim(), args, env };
}

export async function createStdioMcpClient(cfg: ClaudeGoogleDriveConfig): Promise<McpClient> {
  const cmd = new Deno.Command(cfg.command, {
    args: cfg.args,
    env: cfg.env,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  const stdoutReader = child.stdout.getReader();
  const stderrChunks: string[] = [];
  const stderrDecoder = new TextDecoder();
  const stderrDone = (async () => {
    const reader = child.stderr.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          stderrChunks.push(stderrDecoder.decode(value, { stream: true }));
          if (stderrChunks.length > 20) stderrChunks.shift();
        }
      }
    } catch {
      // Ignore stream close errors on shutdown.
    } finally {
      reader.releaseLock();
    }
  })();

  const decoder = new TextDecoder();
  let buffer = "";
  let nextId = 1;
  let closed = false;

  async function readLineWithTimeout(timeoutMs: number): Promise<string | null> {
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        reject(new Error("Timed out waiting for Google MCP server response."));
      }, timeoutMs);
    });
    try {
      while (true) {
        const nl = buffer.indexOf("\n");
        if (nl !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          return line;
        }
        const chunk = await Promise.race([stdoutReader.read(), timeoutPromise]);
        if (chunk.done) {
          const tail = buffer.trim();
          buffer = "";
          return tail.length > 0 ? tail : null;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      if (timerId !== undefined) clearTimeout(timerId);
    }
  }

  async function sendJson(payload: Record<string, unknown>): Promise<void> {
    const encoded = new TextEncoder().encode(`${JSON.stringify(payload)}\n`);
    await writer.write(encoded);
  }

  async function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = nextId++;
    await sendJson({ jsonrpc: "2.0", id, method, params });
    while (true) {
      const line = await readLineWithTimeout(MCP_CALL_TIMEOUT_MS);
      if (line === null) {
        const stderrTail = stderrChunks.join("").trim().slice(-300);
        throw new Error(
          `Refused: Google MCP server exited before answering (${method})${
            stderrTail ? `: ${stderrTail}` : "."
          }`,
        );
      }
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        throw new Error(
          `Refused: Google MCP server sent non-JSON output: ${trimmed.slice(0, 120)}`,
        );
      }
      if (!msg || typeof msg !== "object") continue;
      const msgObj = msg as Record<string, unknown>;
      if (msgObj.id !== id) {
        // Ignore server-initiated notifications or unrelated message IDs.
        continue;
      }
      if ("error" in msgObj && msgObj.error !== undefined) {
        const errObj = msgObj.error as { message?: unknown };
        const message = typeof errObj?.message === "string"
          ? errObj.message
          : JSON.stringify(msgObj.error);
        throw new Error(`Refused: Google MCP server error: ${message}`);
      }
      return msgObj.result;
    }
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    try {
      await writer.close();
    } catch {
      // Ignore already-closed stdin.
    }
    try {
      stdoutReader.releaseLock();
      await child.stdout.cancel();
    } catch {
      // Ignore already-closed stdout.
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const graceKill = new Promise<void>((resolve) => {
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore if child already exited.
        }
        resolve();
      }, 1000);
    });
    await Promise.race([child.status.then(() => undefined), graceKill]);
    if (killTimer !== undefined) clearTimeout(killTimer);
    await child.status.catch(() => undefined);
    await stderrDone;
  }

  try {
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "web-jam-tools-issue-reminder", version: "1.0.0" },
    });
    await sendJson({ jsonrpc: "2.0", method: "notifications/initialized" });
  } catch (err) {
    await close();
    throw err;
  }

  return {
    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
      if (!ALLOWED_GOOGLE_TOOLS.has(name)) {
        throw new Error(
          `Refused: tool "${name}" is not permitted; only createCalendarEvent, getCalendarEvents, and deleteCalendarEvent may be called.`,
        );
      }
      const res = await request("tools/call", { name, arguments: args });
      if (!res || typeof res !== "object") {
        throw new Error(`Refused: invalid tool reply for ${name}.`);
      }
      const toolRes = res as { isError?: boolean; content?: unknown };
      if (!Array.isArray(toolRes.content)) {
        throw new Error(`Refused: malformed tool reply content for ${name}.`);
      }
      const texts = toolRes.content
        .filter((item): item is { type?: string; text?: string } =>
          Boolean(item && typeof item === "object")
        )
        .map((item) => (typeof item.text === "string" ? item.text : ""))
        .filter((t) => t.length > 0);
      const joined = texts.join("\n");
      if (toolRes.isError) {
        throw new Error(`Refused: ${name} failed: ${joined || "unknown error"}`);
      }
      return joined;
    },
    close,
  };
}

export function extractWaitingOnSection(body: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const headingIdx = lines.findIndex((line) => /^##\s+Waiting on\s*$/i.test(line.trim()));
  if (headingIdx === -1) return undefined;
  const collected: string[] = [];
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i].trim())) break;
    collected.push(lines[i]);
  }
  const text = collected.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

export async function fetchGitHubIssue(
  repo: string,
  issue: number,
  runCmd: Deps["runCmd"],
): Promise<IssueInfo> {
  const res = await runCmd("gh", [
    "issue",
    "view",
    String(issue),
    "--repo",
    repo,
    "--json",
    "title,state,body,url",
  ]);
  if (res.code !== 0) {
    const msg = res.stderr.trim() || res.stdout.trim() || `gh exited ${res.code}`;
    throw new Error(`Refused: could not read ${repo}#${issue} via gh: ${msg}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error(`Refused: gh returned invalid JSON for ${repo}#${issue}.`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Refused: unexpected gh payload for ${repo}#${issue}.`);
  }
  const data = parsed as Record<string, unknown>;
  if (typeof data.title !== "string" || typeof data.state !== "string") {
    throw new Error(`Refused: gh response for ${repo}#${issue} is missing title or state.`);
  }
  return {
    repo,
    issue,
    title: data.title,
    state: data.state,
    body: typeof data.body === "string" ? data.body : "",
    url: typeof data.url === "string" && data.url ? data.url : issueAddressFor(repo, issue),
  };
}

function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  if (tzName === "GMT" || tzName === "UTC") return 0;
  const match = tzName.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  if (!match) {
    throw new Error(`Could not determine timezone offset for ${timeZone}: "${tzName}"`);
  }
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

export function getNewYorkDateParts(date: Date): {
  year: number;
  month: number;
  day: number;
  weekday: DayCode;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const wkMap: Record<string, DayCode> = {
    Sun: "SU",
    Mon: "MO",
    Tue: "TU",
    Wed: "WE",
    Thu: "TH",
    Fri: "FR",
    Sat: "SA",
  };
  const weekday = wkMap[get("weekday")];
  if (!weekday || !Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new Error("Failed to format New York date parts.");
  }
  return { year, month, day, weekday };
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

export function newYorkWallTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): { utcMs: number; rfc3339: string } {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offset1 = getTimeZoneOffsetMinutes(new Date(guess), NEW_YORK_TZ);
  const utc1 = guess - offset1 * 60_000;
  const offset2 = getTimeZoneOffsetMinutes(new Date(utc1), NEW_YORK_TZ);
  const utcMs = guess - offset2 * 60_000;
  const yStr = String(year).padStart(4, "0");
  const mStr = String(month).padStart(2, "0");
  const dStr = String(day).padStart(2, "0");
  const hStr = String(hour).padStart(2, "0");
  const minStr = String(minute).padStart(2, "0");
  return {
    utcMs,
    rfc3339: `${yStr}-${mStr}-${dStr}T${hStr}:${minStr}:00${formatOffset(offset2)}`,
  };
}

function addMinutesRfc3339(utcMs: number, addMinutes: number): { utcMs: number; rfc3339: string } {
  const targetMs = utcMs + addMinutes * 60_000;
  const date = new Date(targetMs);
  const offset = getTimeZoneOffsetMinutes(date, NEW_YORK_TZ);
  const shifted = new Date(targetMs + offset * 60_000);
  const yStr = String(shifted.getUTCFullYear()).padStart(4, "0");
  const mStr = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dStr = String(shifted.getUTCDate()).padStart(2, "0");
  const hStr = String(shifted.getUTCHours()).padStart(2, "0");
  const minStr = String(shifted.getUTCMinutes()).padStart(2, "0");
  const secStr = String(shifted.getUTCSeconds()).padStart(2, "0");
  return {
    utcMs: targetMs,
    rfc3339: `${yStr}-${mStr}-${dStr}T${hStr}:${minStr}:${secStr}${formatOffset(offset)}`,
  };
}

export interface SlotWindow {
  startMs: number;
  endMs: number;
  startIso: string;
  endIso: string;
}

export function computeCandidateSlots(
  now: Date,
  days: DayCode[],
  hour: number,
  minute: number,
  windowDays = OVERLAP_WINDOW_DAYS,
): SlotWindow[] {
  const todayNy = getNewYorkDateParts(now);
  const daySet = new Set(days);
  const nowMs = now.getTime();
  const limitMs = nowMs + windowDays * 86_400_000;
  const slots: SlotWindow[] = [];

  for (let offset = 0; offset <= windowDays; offset++) {
    const calDate = new Date(Date.UTC(todayNy.year, todayNy.month - 1, todayNy.day + offset));
    const y = calDate.getUTCFullYear();
    const m = calDate.getUTCMonth() + 1;
    const d = calDate.getUTCDate();
    const weekday = VALID_DAYS[calDate.getUTCDay()];
    if (!daySet.has(weekday)) continue;

    const start = newYorkWallTimeToInstant(y, m, d, hour, minute);
    if (start.utcMs < nowMs || start.utcMs > limitMs) continue;
    const end = addMinutesRfc3339(start.utcMs, EVENT_DURATION_MINUTES);
    slots.push({
      startMs: start.utcMs,
      endMs: end.utcMs,
      startIso: start.rfc3339,
      endIso: end.rfc3339,
    });
  }
  return slots;
}

function parseSingleEventBlock(block: string): CalendarEvent {
  const lines = block.split(/\r?\n/);
  let summary = "";
  let isAllDay = false;
  let startMs: number | undefined;
  let endMs: number | undefined;
  let startDate: string | undefined;
  let endDate: string | undefined;
  let id = "";
  const descriptionLines: string[] = [];
  const recurrence: string[] = [];
  let inDescription = false;

  for (const line of lines) {
    if (!summary && line.startsWith("**") && line.endsWith("**") && line.length >= 4) {
      summary = line.slice(2, -2);
      inDescription = false;
      continue;
    }
    if (
      inDescription &&
      /^(Meeting|Attendees|Link|Event ID|Recurrence): /.test(line)
    ) {
      inDescription = false;
    }
    if (inDescription) {
      descriptionLines.push(line);
      continue;
    }
    if (line.startsWith("Date: ")) {
      isAllDay = true;
      const rest = line.slice("Date: ".length).trim();
      const [s, e] = rest.split(" - ");
      startDate = s;
      endDate = e ?? s;
    } else if (line.startsWith("Time: ")) {
      isAllDay = false;
      const rest = line.slice("Time: ".length).trim();
      const sep = rest.indexOf(" - ");
      if (sep === -1) {
        throw new Error(`Refused: could not parse calendar event time "${rest}".`);
      }
      const sMs = Date.parse(rest.slice(0, sep).trim());
      const eMs = Date.parse(rest.slice(sep + 3).trim());
      if (!Number.isFinite(sMs) || !Number.isFinite(eMs)) {
        throw new Error(`Refused: calendar event has unparseable time "${rest}".`);
      }
      startMs = sMs;
      endMs = eMs;
    } else if (line.startsWith("Description: ")) {
      inDescription = true;
      descriptionLines.push(line.slice("Description: ".length));
    } else if (line.startsWith("Recurrence: ")) {
      recurrence.push(line.slice("Recurrence: ".length).trim());
    } else if (line.startsWith("Event ID: ")) {
      id = line.slice("Event ID: ".length).trim();
    }
  }

  if (!id) {
    throw new Error("Refused: calendar response included an event without an Event ID.");
  }

  return {
    id,
    summary,
    description: descriptionLines.join("\n"),
    isAllDay,
    startMs,
    endMs,
    startDate,
    endDate,
    recurrence: recurrence.length > 0 ? recurrence : undefined,
  };
}

export function parseCalendarEventsText(text: string): CalendarEvent[] {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "No events found.") return [];

  let body = trimmed;
  if (body.startsWith("Event created successfully!")) {
    body = body.replace(/^Event created successfully!\s*/u, "").trim();
    return body ? [parseSingleEventBlock(body)] : [];
  }
  const foundMatch = body.match(/^Found \d+ event\(s\):\s*/u);
  if (foundMatch) {
    body = body.slice(foundMatch[0].length).trim();
    if (!body) return [];
    return body.split(/\n\n---\n\n/).map((block) => parseSingleEventBlock(block.trim()));
  }

  // Fallback: single formatted block (e.g., from getCalendarEvent or minimal stand-in)
  if (trimmed.includes("Event ID: ")) {
    return trimmed.split(/\n\n---\n\n/).map((block) => parseSingleEventBlock(block.trim()));
  }

  throw new Error(`Refused: unrecognized calendar tool response: ${trimmed.slice(0, 120)}`);
}

export function eventMatchesIssue(event: CalendarEvent, repo: string, issue: number): boolean {
  const targetRepo = repo.toLowerCase();
  for (const match of event.description.matchAll(ISSUE_URL_GLOBAL_RE)) {
    if (match[1].toLowerCase() === targetRepo && Number(match[2]) === issue) {
      return true;
    }
  }
  return false;
}

export function findOverlappingTimedEvent(
  events: CalendarEvent[],
  slots: SlotWindow[],
): { event: CalendarEvent; slot: SlotWindow } | null {
  for (const event of events) {
    if (event.isAllDay) continue;
    if (event.startMs === undefined || event.endMs === undefined) continue;
    for (const slot of slots) {
      if (event.startMs < slot.endMs && event.endMs > slot.startMs) {
        return { event, slot };
      }
    }
  }
  return null;
}

function buildDescription(
  repo: string,
  issue: number,
  days: DayCode[],
  waitingOn?: string,
): string {
  const lines = [`Issue: ${issueAddressFor(repo, issue)}`];
  if (waitingOn) lines.push(`Waiting on: ${waitingOn}`);
  lines.push(`Check days: ${days.join(",")}`);
  lines.push(
    `To end this wait: deno task edit-issue --repo ${repo} --issue ${issue} --remove-label Blocked`,
  );
  return lines.join("\n");
}

function extractDaysFromEvent(events: CalendarEvent[]): DayCode[] {
  for (const ev of events) {
    const descMatch = ev.description.match(/^(?:Check days|Days):\s*([A-Z,\s]+)$/im);
    if (descMatch) {
      try {
        return parseDays(descMatch[1]);
      } catch {
        // Fall through to recurrence/instance extraction.
      }
    }
    const rruleSource = [...(ev.recurrence ?? []), ev.description].join("\n");
    const byDayMatch = rruleSource.match(/BYDAY=([A-Z,]+)/i);
    if (byDayMatch) {
      try {
        return parseDays(byDayMatch[1]);
      } catch {
        // Fall through to instance extraction.
      }
    }
  }
  const derived: DayCode[] = [];
  const seen = new Set<DayCode>();
  for (const ev of events) {
    if (ev.startMs === undefined) continue;
    const wk = getNewYorkDateParts(new Date(ev.startMs)).weekday;
    if (!seen.has(wk)) {
      seen.add(wk);
      derived.push(wk);
    }
  }
  return derived;
}

function extractReminderIssue(
  event: CalendarEvent,
): { repo: string; issue: number } | null {
  const isReminder = event.summary.startsWith("Check on: ") ||
    /^(?:Check days|To end this wait):/m.test(event.description);
  if (!isReminder) return null;
  const match = event.description.match(ISSUE_URL_RE);
  if (!match) return null;
  return { repo: match[1], issue: Number(match[2]) };
}

async function runCreate(
  cmd: Extract<ParsedCommand, { subcommand: "create" }>,
  deps: Deps,
): Promise<number> {
  const issueInfo = await fetchGitHubIssue(cmd.repo, cmd.issue, deps.runCmd);
  if (issueInfo.state.toUpperCase() !== "OPEN") {
    throw new Error(
      `Refused: ${cmd.repo}#${cmd.issue} is ${issueInfo.state}; the issue is not open.`,
    );
  }

  const cfg = await loadGoogleDriveMcpConfig(deps);
  const now = deps.now();
  const slots = computeCandidateSlots(now, cmd.days, cmd.hour, cmd.minute, OVERLAP_WINDOW_DAYS);
  if (slots.length === 0) {
    throw new Error(
      `Refused: no occurrence of ${
        cmd.days.join(",")
      } at ${cmd.timeText} falls within the next ${OVERLAP_WINDOW_DAYS} days.`,
    );
  }
  const firstSlot = slots[0];
  const windowEndIso = new Date(now.getTime() + OVERLAP_WINDOW_DAYS * 86_400_000).toISOString();
  const issueUrl = issueAddressFor(cmd.repo, cmd.issue);

  const client = await deps.connectMcp(cfg);
  try {
    const existingText = await client.callTool("getCalendarEvents", {
      calendarId: "primary",
      singleEvents: false,
      orderBy: "updated",
      query: issueUrl,
      maxResults: 250,
    });
    const existingEvents = parseCalendarEventsText(existingText);
    const existingMatch = existingEvents.find((ev) => eventMatchesIssue(ev, cmd.repo, cmd.issue));
    if (existingMatch) {
      throw new Error(
        `Refused: ${cmd.repo}#${cmd.issue} already has a reminder ("${existingMatch.summary}", ID ${existingMatch.id}).`,
      );
    }

    const windowText = await client.callTool("getCalendarEvents", {
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: windowEndIso,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
    });
    const windowEvents = parseCalendarEventsText(windowText);
    const windowDup = windowEvents.find((ev) => eventMatchesIssue(ev, cmd.repo, cmd.issue));
    if (windowDup) {
      throw new Error(
        `Refused: ${cmd.repo}#${cmd.issue} already has a reminder ("${windowDup.summary}", ID ${windowDup.id}).`,
      );
    }

    const overlap = findOverlappingTimedEvent(windowEvents, slots);
    if (overlap) {
      throw new Error(
        `Refused: timed event "${
          overlap.event.summary || overlap.event.id
        }" overlaps ${overlap.slot.startIso} - ${overlap.slot.endIso}.`,
      );
    }

    const waitingOn = cmd.waitingOn ?? extractWaitingOnSection(issueInfo.body);
    const summary = `Check on: ${issueInfo.title}`;
    const description = buildDescription(cmd.repo, cmd.issue, cmd.days, waitingOn);
    const createdText = await client.callTool("createCalendarEvent", {
      calendarId: "primary",
      summary,
      description,
      start: { dateTime: firstSlot.startIso, timeZone: NEW_YORK_TZ },
      end: { dateTime: firstSlot.endIso, timeZone: NEW_YORK_TZ },
      recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${cmd.days.join(",")}`],
    });
    parseCalendarEventsText(createdText);

    const readBackText = await client.callTool("getCalendarEvents", {
      calendarId: "primary",
      singleEvents: false,
      orderBy: "updated",
      query: issueUrl,
      maxResults: 250,
    });
    const readBackEvents = parseCalendarEventsText(readBackText);
    const verified = readBackEvents.find((ev) => eventMatchesIssue(ev, cmd.repo, cmd.issue));
    if (!verified) {
      throw new Error(
        `Error: created reminder for ${cmd.repo}#${cmd.issue} (${issueUrl}) was not found on calendar read-back.`,
      );
    }

    deps.stdout(
      `Created reminder for ${cmd.repo}#${cmd.issue} (${
        cmd.days.join(",")
      } at ${cmd.timeText} ${NEW_YORK_TZ}): ${verified.summary} [${verified.id}]`,
    );
    return 0;
  } finally {
    await client.close();
  }
}

async function runList(
  cmd: Extract<ParsedCommand, { subcommand: "list" }>,
  deps: Deps,
): Promise<number> {
  const cfg = await loadGoogleDriveMcpConfig(deps);
  const client = await deps.connectMcp(cfg);
  try {
    const query = cmd.repo && cmd.issue ? issueAddressFor(cmd.repo, cmd.issue) : "Check on:";
    const text = await client.callTool("getCalendarEvents", {
      calendarId: "primary",
      singleEvents: false,
      orderBy: "updated",
      query,
      maxResults: 250,
    });
    const events = parseCalendarEventsText(text);
    const grouped = new Map<string, { repo: string; issue: number; events: CalendarEvent[] }>();
    for (const ev of events) {
      const ref = extractReminderIssue(ev);
      if (!ref) continue;
      if (cmd.repo && cmd.issue && (ref.repo !== cmd.repo || ref.issue !== cmd.issue)) continue;
      const key = `${ref.repo}#${ref.issue}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.events.push(ev);
      } else {
        grouped.set(key, { repo: ref.repo, issue: ref.issue, events: [ev] });
      }
    }

    if (cmd.repo && cmd.issue && grouped.size === 0) {
      return 1;
    }

    for (const [key, entry] of grouped) {
      const days = extractDaysFromEvent(entry.events);
      const dayLabel = days.length > 0 ? days.join(",") : "unknown";
      const summary = entry.events[0].summary;
      deps.stdout(`${key} (${dayLabel}) — ${summary}`);
    }
    return 0;
  } finally {
    await client.close();
  }
}

async function runDelete(
  cmd: Extract<ParsedCommand, { subcommand: "delete" }>,
  deps: Deps,
): Promise<number> {
  const cfg = await loadGoogleDriveMcpConfig(deps);
  const issueUrl = issueAddressFor(cmd.repo, cmd.issue);
  const client = await deps.connectMcp(cfg);
  try {
    const beforeText = await client.callTool("getCalendarEvents", {
      calendarId: "primary",
      singleEvents: false,
      orderBy: "updated",
      query: issueUrl,
      maxResults: 250,
    });
    const beforeEvents = parseCalendarEventsText(beforeText);
    const targets = beforeEvents.filter((ev) => eventMatchesIssue(ev, cmd.repo, cmd.issue));
    if (targets.length === 0) {
      throw new Error(`Refused: no reminder found for ${cmd.repo}#${cmd.issue}.`);
    }

    for (const target of targets) {
      await client.callTool("deleteCalendarEvent", {
        calendarId: "primary",
        eventId: target.id,
      });
    }

    const afterText = await client.callTool("getCalendarEvents", {
      calendarId: "primary",
      singleEvents: false,
      orderBy: "updated",
      query: issueUrl,
      maxResults: 250,
    });
    const afterEvents = parseCalendarEventsText(afterText);
    const remaining = afterEvents.filter((ev) => eventMatchesIssue(ev, cmd.repo, cmd.issue));
    if (remaining.length > 0) {
      throw new Error(
        `Error: reminder for ${cmd.repo}#${cmd.issue} still present after deletion (event ID ${
          remaining[0].id
        }).`,
      );
    }

    deps.stdout(
      `Deleted ${targets.length} reminder(s) for ${cmd.repo}#${cmd.issue} (${targets[0].summary}).`,
    );
    return 0;
  } finally {
    await client.close();
  }
}

export function usageText(): string {
  return [
    "usage:",
    "  deno task issue-reminder create --repo <owner/repo> --issue <n> --days <MO,TU,...> [--time <HH:MM>] [--waiting-on <text>]",
    "  deno task issue-reminder list [--repo <owner/repo> --issue <n>]",
    "  deno task issue-reminder delete --repo <owner/repo> --issue <n>",
  ].join("\n");
}

export async function runIssueReminder(argv: string[], deps: Deps): Promise<number> {
  try {
    const parsed = parseCliArgs(argv);
    if (parsed.subcommand === "help") {
      deps.stdout(usageText());
      return 0;
    }
    if (parsed.subcommand === "create") {
      return await runCreate(parsed, deps);
    }
    if (parsed.subcommand === "list") {
      return await runList(parsed, deps);
    }
    return await runDelete(parsed, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.stderr(message);
    return 1;
  }
}

export async function realRunCmd(cmd: string, args: string[]): Promise<RunCmdResult> {
  const out = await new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

export function createRealDeps(): Deps {
  return {
    readFile: (path: string) => Deno.readTextFile(path),
    runCmd: realRunCmd,
    connectMcp: createStdioMcpClient,
    claudeConfigPath: () => `${Deno.env.get("HOME") || "/home/joshua"}/.claude.json`,
    now: () => new Date(),
    stdout: (line: string) => console.log(line),
    stderr: (line: string) => console.error(line),
  };
}
