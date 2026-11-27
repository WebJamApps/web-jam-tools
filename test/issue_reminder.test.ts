import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  computeCandidateSlots,
  createStdioMcpClient,
  type Deps,
  issueAddressFor,
  parseCalendarEventsText,
  runIssueReminder,
} from "../src/issue-reminder/lib.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

// Fixed Tuesday in EST: 2026-11-17T04:00:00-05:00 (09:00:00Z).
const FIXED_NOW = new Date("2026-11-17T09:00:00.000Z");

interface StoredEvent {
  id: string;
  summary: string;
  description?: string;
  meeting?: string;
  attendees?: string;
  link?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  recurrence?: string[];
}

interface StandInState {
  events: StoredEvent[];
  calledTools: string[];
  createCalls: Record<string, unknown>[];
  deleteCalls: Record<string, unknown>[];
}

const STANDIN_SERVER_SOURCE = `
const [statePath, mode] = Deno.args;

function readState() {
  return JSON.parse(Deno.readTextFileSync(statePath));
}
function writeState(state) {
  Deno.writeTextFileSync(statePath, JSON.stringify(state, null, 2));
}

function formatEvent(ev) {
  const lines = ["**" + (ev.summary || "(No title)") + "**"];
  if (ev.start?.date) {
    const endD = ev.end?.date && ev.end.date !== ev.start.date ? " - " + ev.end.date : "";
    lines.push("Date: " + ev.start.date + endD);
  } else if (ev.start?.dateTime) {
    lines.push("Time: " + ev.start.dateTime + " - " + (ev.end?.dateTime || ""));
  }
  if (ev.description) lines.push("Description: " + ev.description);
  if (ev.meeting) lines.push("Meeting: " + ev.meeting);
  if (ev.attendees) lines.push("Attendees: " + ev.attendees);
  if (ev.link) lines.push("Link: " + ev.link);
  lines.push("Event ID: " + ev.id);
  return lines.join("\\n");
}

function expandWeekly(ev, timeMinMs, timeMaxMs) {
  const rule = (ev.recurrence || []).find((r) => r.includes("BYDAY="));
  if (!rule || !ev.start?.dateTime || !ev.end?.dateTime) return [ev];
  const days = rule.split("BYDAY=")[1].split(",").map((d) => d.trim());
  const dayCodes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const startBase = Date.parse(ev.start.dateTime);
  const dur = Date.parse(ev.end.dateTime) - startBase;
  const out = [];
  for (let d = 0; d <= 28; d++) {
    const candidateMs = startBase + d * 86400000;
    if (candidateMs < timeMinMs || candidateMs > timeMaxMs) continue;
    const nyWk = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" })
      .format(new Date(candidateMs));
    const map = { Sun: "SU", Mon: "MO", Tue: "TU", Wed: "WE", Thu: "TH", Fri: "FR", Sat: "SA" };
    if (!days.includes(map[nyWk])) continue;
    out.push({
      ...ev,
      start: { ...ev.start, dateTime: new Date(candidateMs).toISOString() },
      end: { ...ev.end, dateTime: new Date(candidateMs + dur).toISOString() },
    });
  }
  return out;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();
let buf = "";

async function send(obj) {
  await Deno.stdout.write(encoder.encode(JSON.stringify(obj) + "\\n"));
}

const reader = Deno.stdin.readable.getReader();
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  while (true) {
    const nl = buf.indexOf("\\n");
    if (nl === -1) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      if (mode === "crash-on-init") Deno.exit(1);
      await send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "standin-google-drive", version: "1.0.0" },
        },
      });
    } else if (msg.method === "notifications/initialized") {
      // No response for notifications.
    } else if (msg.method === "tools/call") {
      if (mode === "crash-on-call") Deno.exit(1);
      const toolName = msg.params?.name;
      const args = msg.params?.arguments || {};
      const state = readState();
      state.calledTools.push(toolName);

      if (toolName === "getCalendarEvents") {
        let items = [...state.events];
        if (args.singleEvents !== false && args.timeMin && args.timeMax) {
          const minMs = Date.parse(args.timeMin);
          const maxMs = Date.parse(args.timeMax);
          const expanded = [];
          for (const ev of items) {
            if (ev.recurrence && ev.recurrence.length > 0) {
              expanded.push(...expandWeekly(ev, minMs, maxMs));
            } else if (ev.start?.date) {
              const dMs = Date.parse(ev.start.date + "T00:00:00Z");
              if (dMs >= minMs - 86400000 && dMs <= maxMs) expanded.push(ev);
            } else if (ev.start?.dateTime) {
              const sMs = Date.parse(ev.start.dateTime);
              if (sMs >= minMs && sMs <= maxMs) expanded.push(ev);
            }
          }
          items = expanded;
        }
        if (args.query) {
          const q = String(args.query).toLowerCase();
          items = items.filter((ev) =>
            (ev.summary || "").toLowerCase().includes(q) ||
            (ev.description || "").toLowerCase().includes(q)
          );
        }
        writeState(state);
        if (mode === "bad-count" && items.length > 0) {
          const badText = "Found 2 event(s):\\n\\n" + formatEvent(items[0]);
          await send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: badText }], isError: false } });
          continue;
        }
        if (mode === "missing-event-id" && items.length > 0) {
          const noIdText = "Found 1 event(s):\\n\\n**" + (items[0].summary || "Broken") + "**\\nTime: 2026-12-04T09:30:00-05:00 - 2026-12-04T10:00:00-05:00";
          await send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: noIdText }], isError: false } });
          continue;
        }
        const text = items.length === 0
          ? "No events found."
          : "Found " + items.length + " event(s):\\n\\n" + items.map(formatEvent).join("\\n\\n---\\n\\n");
        await send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }], isError: false } });
      } else if (toolName === "createCalendarEvent") {
        state.createCalls.push(args);
        const created = {
          id: "evt-" + (state.events.length + 1),
          summary: args.summary,
          description: args.description,
          start: args.start,
          end: args.end,
          recurrence: args.recurrence,
        };
        if (mode !== "drop-on-readback") {
          state.events.push(created);
        }
        writeState(state);
        await send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: "Event created successfully!\\n\\n" + formatEvent(created) }], isError: false },
        });
      } else if (toolName === "deleteCalendarEvent") {
        state.deleteCalls.push(args);
        state.events = state.events.filter((ev) => ev.id !== args.eventId);
        writeState(state);
        await send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: "Event " + args.eventId + " has been deleted." }], isError: false },
        });
      } else {
        writeState(state);
        await send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: "Error: unsupported tool " + toolName }], isError: true },
        });
      }
    }
  }
}
`;

interface Fixture {
  dir: string;
  claudePath: string;
  statePath: string;
  out: string[];
  err: string[];
  deps: Deps;
  setIssueState: (state: string, title?: string, body?: string) => void;
  readState: () => Promise<StandInState>;
  writeEvents: (events: StoredEvent[]) => Promise<void>;
  cleanup: () => Promise<void>;
}

async function createFixture(options: {
  initialEvents?: StoredEvent[];
  mode?: string;
  omitGoogleDrive?: boolean;
  issueState?: string;
  issueTitle?: string;
  issueBody?: string;
} = {}): Promise<Fixture> {
  const dir = await Deno.makeTempDir({ prefix: "issue-reminder-test-" });
  const serverPath = join(dir, "standin_mcp.ts");
  const statePath = join(dir, "state.json");
  const claudePath = join(dir, "claude.json");

  await Deno.writeTextFile(serverPath, STANDIN_SERVER_SOURCE);
  const initialState: StandInState = {
    events: options.initialEvents ?? [],
    calledTools: [],
    createCalls: [],
    deleteCalls: [],
  };
  await Deno.writeTextFile(statePath, JSON.stringify(initialState, null, 2));

  const mcpServers = options.omitGoogleDrive ? {} : {
    "google-drive": {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        serverPath,
        statePath,
        options.mode ?? "normal",
      ],
      env: {},
    },
  };
  await Deno.writeTextFile(claudePath, JSON.stringify({ mcpServers }, null, 2));

  let currentState = options.issueState ?? "OPEN";
  let currentTitle = options.issueTitle ?? "music-media: revise Distribution";
  let currentBody = options.issueBody ??
    "## Waiting on\n\nCD Baby's reply to the downgrade request\n";

  const out: string[] = [];
  const err: string[] = [];

  const deps: Deps = {
    readFile: (path: string) => Deno.readTextFile(path),
    runCmd: (_cmd: string, args: string[]) => {
      const issueArg = args[2] ?? "10";
      const repoIdx = args.indexOf("--repo");
      const repoArg = repoIdx !== -1 ? args[repoIdx + 1] : "WebJamApps/web-jam-tools";
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          title: currentTitle,
          state: currentState,
          body: currentBody,
          url: `https://github.com/${repoArg}/issues/${issueArg}`,
        }),
        stderr: "",
      });
    },
    connectMcp: createStdioMcpClient,
    claudeConfigPath: () => claudePath,
    now: () => FIXED_NOW,
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
  };

  return {
    dir,
    claudePath,
    statePath,
    out,
    err,
    deps,
    setIssueState: (state: string, title?: string, body?: string) => {
      currentState = state;
      if (title !== undefined) currentTitle = title;
      if (body !== undefined) currentBody = body;
    },
    readState: async () => JSON.parse(await Deno.readTextFile(statePath)) as StandInState,
    writeEvents: async (events: StoredEvent[]) => {
      const st = JSON.parse(await Deno.readTextFile(statePath)) as StandInState;
      st.events = events;
      await Deno.writeTextFile(statePath, JSON.stringify(st, null, 2));
    },
    cleanup: async () => {
      await Deno.remove(dir, { recursive: true });
    },
  };
}

// --- Appendix D case list: "Waiting on someone outside GitHub" ---

Deno.test("create --days TU,FR creates 15-min event at 09:30 NY time, reads back, exits 0", async () => {
  const fx = await createFixture();
  try {
    const code = await runIssueReminder(
      ["create", "--repo", "WebJamApps/web-jam-tools", "--issue", "10", "--days", "TU,FR"],
      fx.deps,
    );
    assertEquals(code, 0, fx.err.join("\n"));
    const state = await fx.readState();
    assertEquals(state.events.length, 1);
    const ev = state.events[0];
    assertEquals(ev.summary, "Check on: music-media: revise Distribution");
    assertEquals(ev.start, { dateTime: "2026-11-17T09:30:00-05:00", timeZone: "America/New_York" });
    assertEquals(ev.end, { dateTime: "2026-11-17T09:45:00-05:00", timeZone: "America/New_York" });
    assertEquals(ev.recurrence, ["RRULE:FREQ=WEEKLY;BYDAY=TU,FR"]);
    assertEquals(
      ev.description?.includes("https://github.com/WebJamApps/web-jam-tools/issues/10"),
      true,
    );
    assertEquals(ev.description?.includes("CD Baby's reply to the downgrade request"), true);
    assertEquals(
      ev.description?.includes(
        "deno task edit-issue --repo WebJamApps/web-jam-tools --issue 10 --remove-label Blocked",
      ),
      true,
    );
    assertEquals(state.calledTools.includes("getCalendarEvents"), true);
    assertEquals(state.calledTools.at(-1), "getCalendarEvents");
  } finally {
    await fx.cleanup();
  }
});

Deno.test("create with --time 14:00 creates event at 14:00-14:15 NY time", async () => {
  const fx = await createFixture();
  try {
    const code = await runIssueReminder(
      [
        "create",
        "--repo",
        "WebJamApps/web-jam-tools",
        "--issue",
        "10",
        "--days",
        "TU,FR",
        "--time",
        "14:00",
      ],
      fx.deps,
    );
    assertEquals(code, 0, fx.err.join("\n"));
    const state = await fx.readState();
    assertEquals(state.events[0].start, {
      dateTime: "2026-11-17T14:00:00-05:00",
      timeZone: "America/New_York",
    });
    assertEquals(state.events[0].end, {
      dateTime: "2026-11-17T14:15:00-05:00",
      timeZone: "America/New_York",
    });
  } finally {
    await fx.cleanup();
  }
});

Deno.test('create with --days "TU, FR" quoted with space creates the same event', async () => {
  const fx = await createFixture();
  try {
    const code = await runIssueReminder(
      ["create", "--repo", "WebJamApps/web-jam-tools", "--issue", "10", "--days", "TU, FR"],
      fx.deps,
    );
    assertEquals(code, 0, fx.err.join("\n"));
    const state = await fx.readState();
    assertEquals(state.events[0].recurrence, ["RRULE:FREQ=WEEKLY;BYDAY=TU,FR"]);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("create with --days XX refuses: not a day name", async () => {
  const fx = await createFixture();
  try {
    const code = await runIssueReminder(
      ["create", "--repo", "WebJamApps/web-jam-tools", "--issue", "10", "--days", "XX"],
      fx.deps,
    );
    assertEquals(code, 1);
    assertMatch(fx.err.join("\n"), /not a day name/i);
    assertEquals((await fx.readState()).events.length, 0);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("create with --days missing is refused", async () => {
  const fx = await createFixture();
  try {
    const code = await runIssueReminder(
      ["create", "--repo", "WebJamApps/web-jam-tools", "--issue", "10"],
      fx.deps,
    );
    assertEquals(code, 1);
    assertMatch(fx.err.join("\n"), /--days/i);
    assertEquals((await fx.readState()).events.length, 0);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("create with --time 25:00 refuses: not a time", async () => {
  const fx = await createFixture();
  try {
    const code = await runIssueReminder(
      [
        "create",
        "--repo",
        "WebJamApps/web-jam-tools",
        "--issue",
        "10",
        "--days",
        "TU,FR",
        "--time",
        "25:00",
      ],
      fx.deps,
    );
    assertEquals(code, 1);
    assertMatch(fx.err.join("\n"), /not a time/i);
    assertEquals((await fx.readState()).events.length, 0);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("create refuses when issue 10 already has a reminder, naming event and creating nothing", async () => {
  const existing: StoredEvent = {
    id: "evt-existing",
    summary: "Check on: music-media: revise Distribution",
    description: `Issue: ${issueAddressFor("WebJamApps/web-jam-tools", 10)}\nCheck days: TU,FR`,
    start: { dateTime: "2026-11-17T09:30:00-05:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-11-17T09:45:00-05:00", timeZone: "America/New_York" },
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU,FR"],
  };
  const fx = await createFixture({ initialEvents: [existing] });
  try {
    const code = await runIssueReminder(
      ["create", "--repo", "WebJamApps/web-jam-tools", "--issue", "10", "--days", "TU,FR"],
      fx.deps,
    );
    assertEquals(code, 1);
    assertEquals(fx.err.join("\n").includes("Check on: music-media: revise Distribution"), true);
    const state = await fx.readState();
    assertEquals(state.createCalls.length, 0);
    assertEquals(state.events.length, 1);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("create (no --time) auto-steps from 09:30 to 10:00 NY time on Friday conflict, reads back, prints chosen time, exits 0", async () => {
  const conflict: StoredEvent = {
    id: "evt-friday-sync",
    summary: "Friday Studio Sync",
    description: "Weekly team meeting",
    start: { dateTime: "2026-12-04T09:30:00-05:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-12-04T10:00:00-05:00", timeZone: "America/New_York" },
  };
  const fx = await createFixture({ initialEvents: [conflict] });
  try {
    const code = await runIssueReminder(
      ["create", "--repo", "WebJamApps/web-jam-tools", "--issue", "10", "--days", "TU,FR"],
      fx.deps,
    );
    assertEquals(code, 0, fx.err.join("\n"));
    const state = await fx.readState();
    assertEquals(state.createCalls.length, 1);
    const created = state.events.find((e) => e.id !== "evt-friday-sync");
    assertEquals(created?.start, {
      dateTime: "2026-11-17T10:00:00-05:00",
      timeZone: "America/New_York",
    });
    assertEquals(created?.end, {
      dateTime: "2026-11-17T10:15:00-05:00",
      timeZone: "America/New_York",
    });
    assertEquals(fx.out.join("\n").includes("10:00"), true);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("create with explicit --time 09:30 refuses when a timed event sits at 09:30-10:00 on a Friday within 28 days", async () => {
  const conflict: StoredEvent = {
    id: "evt-friday-sync",
    summary: "Friday Studio Sync",
    description: "Weekly team meeting",
    start: { dateTime: "2026-12-04T09:30:00-05:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-12-04T10:00:00-05:00", timeZone: "America/New_York" },
  };
  const fx = await createFixture({ initialEvents: [conflict] });
  try {
    const code = await runIssueReminder(
      [
        "create",
        "--repo",
        "WebJamApps/web-jam-tools",
        "--issue",
        "10",
        "--days",
        "TU,FR",
        "--time",
        "09:30",
      ],
      fx.deps,
    );
    assertEquals(code, 1);
    assertEquals(fx.err.join("\n").includes("Friday Studio Sync"), true);
    const state = await fx.readState();
    assertEquals(state.createCalls.length, 0);
    assertEquals(state.events.length, 1);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("create (no --time) refuses when every 15-minute slot from 09:30 through 17:00 overlaps a timed event within 28 days", async () => {
  const allDayLong: StoredEvent = {
    id: "evt-all-day-block",
    summary: "All-Day Studio Session",
    description: "Blocks 09:30 through 17:15",
    start: { dateTime: "2026-12-04T09:00:00-05:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-12-04T17:15:00-05:00", timeZone: "America/New_York" },
  };
  const fx = await createFixture({ initialEvents: [allDayLong] });
  try {
    const code = await runIssueReminder(
      ["create", "--repo", "WebJamApps/web-jam-tools", "--issue", "10", "--days", "TU,FR"],
      fx.deps,
    );
    assertEquals(code, 1);
    assertMatch(fx.err.join("\n"), /09:30 through 17:00/);
    assertEquals((await fx.readState()).createCalls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("create (no --time) picks 17:00 when 09:30-17:00 is blocked but 17:00-17:15 is free", async () => {
  const almostAllDay: StoredEvent = {
    id: "evt-almost-all-day",
    summary: "Daytime Block",
    start: { dateTime: "2026-12-04T09:00:00-05:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-12-04T17:00:00-05:00", timeZone: "America/New_York" },
  };
  const fx = await createFixture({ initialEvents: [almostAllDay] });
  try {
    const code = await runIssueReminder(
      ["create", "--repo", "WebJamApps/web-jam-tools", "--issue", "10", "--days", "TU,FR"],
      fx.deps,
    );
    assertEquals(code, 0, fx.err.join("\n"));
    const state = await fx.readState();
    const created = state.events.find((e) => e.id !== "evt-almost-all-day");
    assertEquals(created?.start, {
      dateTime: "2026-11-17T17:00:00-05:00",
      timeZone: "America/New_York",
    });
    assertEquals(fx.out.join("\n").includes("17:00"), true);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("create parses multi-line Zoom description with --- dividers and Link:/Meeting: lines cleanly", async () => {
  const zoomEvent: StoredEvent = {
    id: "evt-zoom",
    summary: "Weekly Sync",
    description: [
      "Agenda notes",
      "",
      "---",
      "",
      "Join Zoom Meeting",
      "Link: https://zoom.us/j/123456789",
      "Meeting: 123 456 789",
      "",
      "---",
      "",
      "**Dial by your location**",
      "Event ID: fake-in-body",
    ].join("\n"),
    meeting: "https://meet.google.com/abc-defg-hij",
    attendees: "a@example.com, b@example.com",
    link: "https://www.google.com/calendar/event?eid=zoom123",
    start: { dateTime: "2026-11-20T11:00:00-05:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-11-20T11:30:00-05:00", timeZone: "America/New_York" },
  };
  const otherEvent: StoredEvent = {
    id: "evt-other",
    summary: "Afternoon Coffee",
    description: "Catch up",
    link: "https://www.google.com/calendar/event?eid=other",
    start: { dateTime: "2026-11-20T15:00:00-05:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-11-20T15:30:00-05:00", timeZone: "America/New_York" },
  };
  const fx = await createFixture({ initialEvents: [zoomEvent, otherEvent] });
  try {
    const code = await runIssueReminder(
      ["create", "--repo", "WebJamApps/web-jam-tools", "--issue", "10", "--days", "TU,FR"],
      fx.deps,
    );
    assertEquals(code, 0, fx.err.join("\n"));
    const state = await fx.readState();
    assertEquals(state.createCalls.length, 1);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("create refuses and creates nothing when Found N event(s) count disagrees or Event ID is missing", async () => {
  const existing: StoredEvent = {
    id: "evt-1",
    summary: "Some Event",
    start: { dateTime: "2026-11-20T11:00:00-05:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-11-20T11:30:00-05:00", timeZone: "America/New_York" },
  };
  const fxMismatch = await createFixture({ initialEvents: [existing], mode: "bad-count" });
  try {
    const code = await runIssueReminder(
      ["create", "--repo", "WebJamApps/web-jam-tools", "--issue", "10", "--days", "TU,FR"],
      fxMismatch.deps,
    );
    assertEquals(code, 1);
    assertMatch(fxMismatch.err.join("\n"), /claimed 2 event\(s\) but parsed 1/i);
    assertEquals((await fxMismatch.readState()).createCalls.length, 0);
  } finally {
    await fxMismatch.cleanup();
  }

  const fxMissingId = await createFixture({ initialEvents: [existing], mode: "missing-event-id" });
  try {
    const code = await runIssueReminder(
      ["create", "--repo", "WebJamApps/web-jam-tools", "--issue", "10", "--days", "TU,FR"],
      fxMissingId.deps,
    );
    assertEquals(code, 1);
    assertMatch(fxMissingId.err.join("\n"), /without an Event ID/i);
    assertEquals((await fxMissingId.readState()).createCalls.length, 0);
  } finally {
    await fxMissingId.cleanup();
  }
});

Deno.test("create refuses and creates nothing when the 28-day window returns the 250-event maximum", async () => {
  const startMs = FIXED_NOW.getTime() + 86_400_000;
  const crowded: StoredEvent[] = Array.from({ length: 250 }, (_, i) => {
    const s = new Date(startMs + i * 2 * 3_600_000);
    const e = new Date(s.getTime() + 15 * 60_000);
    return {
      id: `evt-busy-${i}`,
      summary: `Busy ${i}`,
      start: { dateTime: s.toISOString(), timeZone: "America/New_York" },
      end: { dateTime: e.toISOString(), timeZone: "America/New_York" },
    };
  });
  const fx = await createFixture({ initialEvents: crowded });
  try {
    const code = await runIssueReminder(
      ["create", "--repo", "WebJamApps/web-jam-tools", "--issue", "10", "--days", "TU,FR"],
      fx.deps,
    );
    assertEquals(code, 1);
    assertMatch(fx.err.join("\n"), /returned 250 events.*may be incomplete/);
    assertEquals((await fx.readState()).createCalls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("create succeeds when an all-day event sits on a Tuesday within 28 days", async () => {
  const allDay: StoredEvent = {
    id: "evt-all-day",
    summary: "Thanksgiving Prep Day",
    start: { date: "2026-11-24" },
    end: { date: "2026-11-25" },
  };
  const fx = await createFixture({ initialEvents: [allDay] });
  try {
    const code = await runIssueReminder(
      ["create", "--repo", "WebJamApps/web-jam-tools", "--issue", "10", "--days", "TU,FR"],
      fx.deps,
    );
    assertEquals(code, 0, fx.err.join("\n"));
    const state = await fx.readState();
    assertEquals(state.createCalls.length, 1);
    assertEquals(state.events.length, 2);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("create refuses when issue 10 is closed", async () => {
  const fx = await createFixture({ issueState: "CLOSED" });
  try {
    const code = await runIssueReminder(
      ["create", "--repo", "WebJamApps/web-jam-tools", "--issue", "10", "--days", "TU,FR"],
      fx.deps,
    );
    assertEquals(code, 1);
    assertMatch(fx.err.join("\n"), /not open/i);
    assertEquals((await fx.readState()).createCalls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("create refuses when ~/.claude.json has no google-drive entry, naming it and creating nothing", async () => {
  const fx = await createFixture({ omitGoogleDrive: true });
  try {
    const code = await runIssueReminder(
      ["create", "--repo", "WebJamApps/web-jam-tools", "--issue", "10", "--days", "TU,FR"],
      fx.deps,
    );
    assertEquals(code, 1);
    assertEquals(fx.err.join("\n").includes("google-drive"), true);
    assertEquals((await fx.readState()).createCalls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("create refuses when the Google server exits before answering", async () => {
  const fx = await createFixture({ mode: "crash-on-call" });
  try {
    const code = await runIssueReminder(
      ["create", "--repo", "WebJamApps/web-jam-tools", "--issue", "10", "--days", "TU,FR"],
      fx.deps,
    );
    assertEquals(code, 1);
    assertMatch(fx.err.join("\n"), /exited before answering/i);
    assertEquals((await fx.readState()).createCalls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("create exits non-zero naming the issue when read-back finds no event", async () => {
  const fx = await createFixture({ mode: "drop-on-readback" });
  try {
    const code = await runIssueReminder(
      ["create", "--repo", "WebJamApps/web-jam-tools", "--issue", "10", "--days", "TU,FR"],
      fx.deps,
    );
    assertEquals(code, 1);
    assertEquals(fx.err.join("\n").includes("WebJamApps/web-jam-tools#10"), true);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("list prints two lines with issue and days for reminders 10 and 12", async () => {
  const events: StoredEvent[] = [
    {
      id: "evt-10",
      summary: "Check on: music-media: revise Distribution",
      description: `Issue: ${issueAddressFor("WebJamApps/web-jam-tools", 10)}\nCheck days: TU,FR`,
      start: { dateTime: "2026-11-17T09:30:00-05:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-11-17T09:45:00-05:00", timeZone: "America/New_York" },
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU,FR"],
    },
    {
      id: "evt-12",
      summary: "Check on: Wait for vendor logo",
      description: `Issue: ${issueAddressFor("WebJamApps/web-jam-tools", 12)}\nCheck days: MO,TH`,
      start: { dateTime: "2026-11-16T09:30:00-05:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-11-16T09:45:00-05:00", timeZone: "America/New_York" },
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TH"],
    },
  ];
  const fx = await createFixture({ initialEvents: events });
  try {
    const code = await runIssueReminder(["list"], fx.deps);
    assertEquals(code, 0, fx.err.join("\n"));
    assertEquals(fx.out.length, 2);
    assertEquals(fx.out[0].includes("WebJamApps/web-jam-tools#10"), true);
    assertEquals(fx.out[0].includes("TU,FR"), true);
    assertEquals(fx.out[1].includes("WebJamApps/web-jam-tools#12"), true);
    assertEquals(fx.out[1].includes("MO,TH"), true);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("list discovers older reminder without colon or Check days via 14-day expansion and ignores #boards events", async () => {
  const events: StoredEvent[] = [
    {
      id: "evt-legacy-1694",
      summary: "Check on CD Baby's answer",
      description: `Waiting on CD Baby reply\n${issueAddressFor("WebJamApps/web-jam-tools", 10)}`,
      link: "https://www.google.com/calendar/event?eid=legacy",
      start: { dateTime: "2026-11-17T09:30:00-05:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-11-17T09:45:00-05:00", timeZone: "America/New_York" },
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU,FR"],
    },
    {
      id: "evt-boards",
      summary: "Weekly board review",
      description: "See https://github.com/orgs/WebJamApps/projects/1/views/2#boards",
      start: { dateTime: "2026-11-18T10:00:00-05:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-11-18T10:30:00-05:00", timeZone: "America/New_York" },
    },
  ];
  const fx = await createFixture({ initialEvents: events });
  // Also run from a Wednesday to verify weekday order stays TU,FR rather than FR,TU.
  const wedDeps: Deps = { ...fx.deps, now: () => new Date("2026-11-18T12:00:00.000Z") };
  try {
    const code = await runIssueReminder(["list"], wedDeps);
    assertEquals(code, 0, fx.err.join("\n"));
    assertEquals(fx.out.length, 1);
    assertEquals(fx.out[0].includes("WebJamApps/web-jam-tools#10"), true);
    assertEquals(fx.out[0].includes("TU,FR"), true);
    assertEquals(fx.out[0].includes("Check on CD Baby's answer"), true);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("list --repo WebJamApps/web-jam-tools --issue 10 with no reminder prints nothing and exits 1", async () => {
  const fx = await createFixture();
  try {
    const code = await runIssueReminder(
      ["list", "--repo", "WebJamApps/web-jam-tools", "--issue", "10"],
      fx.deps,
    );
    assertEquals(code, 1);
    assertEquals(fx.out.length, 0);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("delete --repo WebJamApps/web-jam-tools --issue 10 deletes reminder, reads back gone, exits 0", async () => {
  const ev: StoredEvent = {
    id: "evt-10",
    summary: "Check on: music-media: revise Distribution",
    description: `Issue: ${issueAddressFor("WebJamApps/web-jam-tools", 10)}\nCheck days: TU,FR`,
    start: { dateTime: "2026-11-17T09:30:00-05:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-11-17T09:45:00-05:00", timeZone: "America/New_York" },
  };
  const fx = await createFixture({ initialEvents: [ev] });
  try {
    const code = await runIssueReminder(
      ["delete", "--repo", "WebJamApps/web-jam-tools", "--issue", "10"],
      fx.deps,
    );
    assertEquals(code, 0, fx.err.join("\n"));
    const state = await fx.readState();
    assertEquals(state.events.length, 0);
    assertEquals(state.deleteCalls.length, 1);
    assertEquals(state.calledTools.at(-1), "getCalendarEvents");
  } finally {
    await fx.cleanup();
  }
});

Deno.test("delete with no reminder changes nothing and exits non-zero", async () => {
  const fx = await createFixture();
  try {
    const code = await runIssueReminder(
      ["delete", "--repo", "WebJamApps/web-jam-tools", "--issue", "10"],
      fx.deps,
    );
    assertEquals(code, 1);
    assertEquals((await fx.readState()).deleteCalls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("delete matches issue address whole so issue 100 is never deleted when deleting issue 10", async () => {
  const ev100: StoredEvent = {
    id: "evt-100",
    summary: "Check on: issue 100",
    description: `Issue: ${issueAddressFor("WebJamApps/web-jam-tools", 100)}\nCheck days: TU,FR`,
    start: { dateTime: "2026-11-17T09:30:00-05:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-11-17T09:45:00-05:00", timeZone: "America/New_York" },
  };
  const fx = await createFixture({ initialEvents: [ev100] });
  try {
    const code = await runIssueReminder(
      ["delete", "--repo", "WebJamApps/web-jam-tools", "--issue", "10"],
      fx.deps,
    );
    assertEquals(code, 1);
    const state = await fx.readState();
    assertEquals(state.deleteCalls.length, 0);
    assertEquals(state.events.length, 1);
    assertEquals(state.events[0].id, "evt-100");
  } finally {
    await fx.cleanup();
  }
});

// --- Additional requirement and boundary tests ---

Deno.test("issue-reminder calls only createCalendarEvent, getCalendarEvents, and deleteCalendarEvent", async () => {
  const fx = await createFixture();
  try {
    assertEquals(
      await runIssueReminder(
        ["create", "--repo", "WebJamApps/web-jam-tools", "--issue", "10", "--days", "TU,FR"],
        fx.deps,
      ),
      0,
    );
    assertEquals(await runIssueReminder(["list"], fx.deps), 0);
    assertEquals(
      await runIssueReminder(
        ["delete", "--repo", "WebJamApps/web-jam-tools", "--issue", "10"],
        fx.deps,
      ),
      0,
    );

    const state = await fx.readState();
    const uniqueTools = new Set(state.calledTools);
    assertEquals(
      uniqueTools,
      new Set(["createCalendarEvent", "getCalendarEvents", "deleteCalendarEvent"]),
    );

    const cfg = JSON.parse(await Deno.readTextFile(fx.claudePath)).mcpServers["google-drive"];
    const client = await createStdioMcpClient(cfg);
    try {
      await assertRejects(
        () => client.callTool("listCalendars", {}),
        Error,
        "not permitted",
      );
    } finally {
      await client.close();
    }
  } finally {
    await fx.cleanup();
  }
});

Deno.test("list with no filters exits 0 with empty output when calendar has no reminders", async () => {
  const fx = await createFixture();
  try {
    const code = await runIssueReminder(["list"], fx.deps);
    assertEquals(code, 0, fx.err.join("\n"));
    assertEquals(fx.out.length, 0);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("helpers handle NY DST offsets and malformed calendar responses safely", () => {
  // July is EDT (-04:00)
  const julySlots = computeCandidateSlots(new Date("2026-07-14T12:00:00.000Z"), ["TU"], 9, 30, 7);
  assertEquals(julySlots[0].startIso, "2026-07-14T09:30:00-04:00");
  assertEquals(julySlots[0].endIso, "2026-07-14T09:45:00-04:00");

  assertEquals(parseCalendarEventsText("No events found."), []);

  const zoomMulti = [
    "Found 2 event(s):",
    "",
    "**Zoom Sync**",
    "Time: 2026-11-20T10:00:00-05:00 - 2026-11-20T10:30:00-05:00",
    "Description: Intro",
    "",
    "---",
    "",
    "Link: https://zoom.us/j/999",
    "Meeting: 999",
    "Link: https://www.google.com/calendar/event?eid=1",
    "Attendees: a@example.com",
    "Meeting: https://meet.google.com/xyz",
    "Event ID: evt-z1",
    "",
    "---",
    "",
    "**Follow-up**",
    "Time: 2026-11-20T11:00:00-05:00 - 2026-11-20T11:15:00-05:00",
    "Description: https://github.com/WebJamApps/web-jam-tools/issues/10",
    "Event ID: evt-z2",
  ].join("\n");
  const parsed = parseCalendarEventsText(zoomMulti);
  assertEquals(parsed.length, 2);
  assertEquals(parsed[0].id, "evt-z1");
  assertEquals(parsed[0].description.includes("Link: https://zoom.us/j/999"), true);
  assertEquals(parsed[1].id, "evt-z2");
});

Deno.test("deno.json registers issue-reminder with scoped permissions (Rule 12, Rule 21)", async () => {
  const denoJson = JSON.parse(await Deno.readTextFile(join(REPO_ROOT, "deno.json")));
  const task: string = denoJson.tasks?.["issue-reminder"] ?? "";
  assertEquals(task.includes("src/issue-reminder/cli.ts"), true);
  assertEquals(task.includes(" -A "), false);
  assertEquals(/--allow-read(\s|$)/.test(task), false);
  assertEquals(/--allow-env(\s|$)/.test(task), false);
  assertEquals(/--allow-run(\s|$)/.test(task), false);

  const cmd = new Deno.Command("deno", {
    args: ["task", "--config", join(REPO_ROOT, "deno.json"), "issue-reminder", "--help"],
    stdout: "piped",
    stderr: "piped",
  });
  const res = await cmd.output();
  assertEquals(res.code, 0, new TextDecoder().decode(res.stderr));
});
