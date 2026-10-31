/**
 * src/snap-updates/check_updates.ts
 *
 * Warns when a snap has had an update waiting for days. snapd retries refreshes on its own and
 * tells nobody when they stop working, and Ubuntu's Software Updater does not update snaps, so a
 * stalled refresh otherwise goes unseen.
 *
 * A snap showing in `snap refresh --list` for a short while is normal, so this records when each
 * snap first showed there and warns only once one has stayed for STUCK_AFTER_DAYS. The `agents`
 * command attaches to tmux straight after it runs this, which hides anything printed, so the
 * warning also goes out as a desktop notification. A machine without snap is a silent no-op.
 */

export const STUCK_AFTER_DAYS = 3;
export const STATE_FILE = "snap-updates.json";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const UP_TO_DATE = "All snaps up to date.";
const SNAP_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const COMMAND_NOT_FOUND = 127;

export type FirstSeen = Record<string, string>;
export type CheckStatus = "ok" | "stuck" | "skipped" | "failed";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CheckOptions {
  stateDir?: string;
  now?: Date;
  runCommand?: (command: string, args: string[]) => Promise<CommandResult>;
  warn?: (message: string) => void;
}

/** The names of the snaps waiting for an update, or null when the output is not recognized. */
export function parsePendingSnaps(output: string): string[] | null {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length === 1 && lines[0] === UP_TO_DATE) return [];
  if (lines.length < 2 || !lines[0].startsWith("Name")) return null;
  const names = lines.slice(1).map((line) => line.split(/\s+/)[0]);
  return names.every((name) => SNAP_NAME.test(name)) ? names : null;
}

/** The recorded first-seen dates, or null when the text is not a valid record. */
export function parseFirstSeen(text: string): FirstSeen | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed);
  const valid = entries.every(([name, date]) =>
    SNAP_NAME.test(name) && typeof date === "string" && !isNaN(new Date(date).getTime())
  );
  return valid ? Object.fromEntries(entries) as FirstSeen : null;
}

/** Keeps the date of each snap still waiting, adds new ones as of now, drops the rest. */
export function updateFirstSeen(pending: string[], previous: FirstSeen, now: Date): FirstSeen {
  return Object.fromEntries(
    pending.map((
      name,
    ) => [name, Object.hasOwn(previous, name) ? previous[name] : now.toISOString()]),
  );
}

/** The snaps that have been waiting for at least STUCK_AFTER_DAYS. */
export function findStuckSnaps(firstSeen: FirstSeen, now: Date): string[] {
  return Object.entries(firstSeen)
    .filter(([, date]) => now.getTime() - new Date(date).getTime() >= STUCK_AFTER_DAYS * MS_PER_DAY)
    .map(([name]) => name)
    .sort();
}

async function runSystemCommand(command: string, args: string[]): Promise<CommandResult> {
  const env: Record<string, string> = { LC_ALL: "C" };
  // Over SSH the desktop's message bus may not be in the environment.
  const runtimeDir = Deno.env.get("XDG_RUNTIME_DIR");
  if (!Deno.env.get("DBUS_SESSION_BUS_ADDRESS") && runtimeDir) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtimeDir}/bus`;
  }
  const out = await new Deno.Command(command, { args, env, stdout: "piped", stderr: "piped" })
    .output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function readFirstSeen(path: string, warn: (message: string) => void): Promise<FirstSeen> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {};
    throw error;
  }
  const firstSeen = parseFirstSeen(text);
  if (firstSeen) return firstSeen;
  warn(`warning: ${path} is not a valid record; counting waiting snap updates from today`);
  return {};
}

export async function checkSnapUpdates(options: CheckOptions = {}): Promise<CheckStatus> {
  const runCommand = options.runCommand ?? runSystemCommand;
  const warn = options.warn ?? ((message: string) => console.error(message));
  const now = options.now ?? new Date();
  const stateDir = options.stateDir ?? `${Deno.env.get("HOME")}/.local/state/web-jam-tools`;

  const alert = async (urgency: "normal" | "critical", title: string, body: string) => {
    warn(`warning: ${title}: ${body}`);
    try {
      const sent = await runCommand("timeout", [
        "5",
        "notify-send",
        `--urgency=${urgency}`,
        "--app-name=agents",
        title,
        body,
      ]);
      if (sent.code !== 0) warn("warning: the desktop notification could not be sent");
    } catch {
      warn("warning: the desktop notification could not be sent");
    }
  };

  const failed = async (reason: string): Promise<CheckStatus> => {
    await alert("normal", "Could not check snap updates", reason);
    return "failed";
  };

  let query: CommandResult;
  try {
    query = await runCommand("timeout", ["30", "snap", "refresh", "--list"]);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "skipped";
    return await failed(String(error));
  }
  if (query.code === COMMAND_NOT_FOUND) return "skipped";
  if (query.code !== 0) return await failed(`snap refresh --list exited with ${query.code}`);

  // snapd prints "All snaps up to date." on stderr and the table on stdout.
  const pending = parsePendingSnaps(`${query.stdout}\n${query.stderr}`);
  if (pending === null) return await failed("snap refresh --list printed something unrecognized");

  let firstSeen: FirstSeen;
  try {
    const path = `${stateDir}/${STATE_FILE}`;
    firstSeen = updateFirstSeen(pending, await readFirstSeen(path, warn), now);
    await Deno.mkdir(stateDir, { recursive: true });
    await Deno.writeTextFile(path, `${JSON.stringify(firstSeen, null, 2)}\n`);
  } catch (error) {
    return await failed(`the record of waiting updates could not be saved: ${error}`);
  }

  const stuck = findStuckSnaps(firstSeen, now);
  if (stuck.length === 0) return "ok";
  await alert(
    "critical",
    "Snap updates look stuck",
    `${stuck.join(", ")}: waiting ${STUCK_AFTER_DAYS}+ days. Run: sudo snap refresh`,
  );
  return "stuck";
}

if (import.meta.main) {
  // A failed check exits 1 so `agents` says so; `agents` starts either way.
  if (await checkSnapUpdates() === "failed") Deno.exit(1);
}
