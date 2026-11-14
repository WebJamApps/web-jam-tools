// snap_updates_test.ts
//
// Exercises src/snap-updates/check_updates.ts. The in-process tests inject the command runner and a
// temporary state folder. The task test runs the real `deno task` with stub `snap` and
// `notify-send` commands on PATH and a temporary HOME, which proves the task's scoped permissions.
// The real snapd, desktop and home folder are never touched.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkSnapUpdates,
  type CommandResult,
  findStuckSnaps,
  parseFirstSeen,
  parsePendingSnaps,
  STATE_FILE,
  updateFirstSeen,
} from "../src/snap-updates/check_updates.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const NOW = new Date("2026-10-31T12:00:00.000Z");
const FOUR_DAYS_AGO = "2026-10-27T12:00:00.000Z";
const ONE_DAY_AGO = "2026-10-30T12:00:00.000Z";
const TABLE = "Name  Version  Rev  Size  Publisher  Notes\n" +
  "code  2c33b50b  274  570MB  vscode**  classic\n" +
  "firefox  159.0-1  9137  297MB  mozilla**  -\n";

interface Harness {
  stateDir: string;
  warnings: string[];
  notifications: string[][];
  check: (query: CommandResult | Error, notifyCode?: number) => ReturnType<typeof checkSnapUpdates>;
}

async function harness(): Promise<Harness> {
  const stateDir = `${await Deno.makeTempDir({ prefix: "snap-updates-" })}/state`;
  const warnings: string[] = [];
  const notifications: string[][] = [];
  return {
    stateDir,
    warnings,
    notifications,
    check: (query, notifyCode = 0) =>
      checkSnapUpdates({
        stateDir,
        now: NOW,
        warn: (message) => warnings.push(message),
        runCommand: (_command, args) => {
          if (args[1] === "notify-send") {
            notifications.push(args);
            return Promise.resolve({ code: notifyCode, stdout: "", stderr: "" });
          }
          return query instanceof Error ? Promise.reject(query) : Promise.resolve(query);
        },
      }),
  };
}

async function seed(stateDir: string, text: string) {
  await Deno.mkdir(stateDir, { recursive: true });
  await Deno.writeTextFile(`${stateDir}/${STATE_FILE}`, text);
}

async function record(stateDir: string) {
  return JSON.parse(await Deno.readTextFile(`${stateDir}/${STATE_FILE}`));
}

Deno.test("parsePendingSnaps reads names from the table and the up-to-date message", () => {
  assertEquals(parsePendingSnaps(TABLE), ["code", "firefox"]);
  assertEquals(parsePendingSnaps("\nAll snaps up to date.\n"), []);
});

Deno.test("parsePendingSnaps refuses empty or unrecognized output", () => {
  for (const output of ["", "\n", "error: cannot refresh", "Name  Version\n", "Name\n../evil  1"]) {
    assertEquals(parsePendingSnaps(output), null, output);
  }
});

Deno.test("parseFirstSeen refuses anything but a record of snap names and dates", () => {
  assertEquals(parseFirstSeen(`{"code":"${ONE_DAY_AGO}"}`), { code: ONE_DAY_AGO });
  for (const text of ["", "not json", "[]", "null", '{"code":"soon"}', '{"code":1}']) {
    assertEquals(parseFirstSeen(text), null, text);
  }
  assertEquals(parseFirstSeen(`{"../evil":"${ONE_DAY_AGO}"}`), null);
});

Deno.test("updateFirstSeen keeps dates of waiting snaps, adds new ones and drops updated ones", () => {
  assertEquals(
    updateFirstSeen(["code", "firefox"], { code: ONE_DAY_AGO, gimp: ONE_DAY_AGO }, NOW),
    { code: ONE_DAY_AGO, firefox: NOW.toISOString() },
  );
});

Deno.test("updateFirstSeen dates an accepted snap name that is also an Object.prototype property", () => {
  const names = ["constructor", "toString", "valueOf"];
  const seen = updateFirstSeen(names, {}, NOW);
  assertEquals(seen, {
    constructor: NOW.toISOString(),
    toString: NOW.toISOString(),
    valueOf: NOW.toISOString(),
  });
  assertEquals(findStuckSnaps(seen, new Date(NOW.getTime() + 4 * 24 * 60 * 60 * 1000)), [
    "constructor",
    "toString",
    "valueOf",
  ]);
});

Deno.test("findStuckSnaps uses the 3-day limit exactly", () => {
  assertEquals(
    findStuckSnaps({
      zoom: FOUR_DAYS_AGO,
      code: "2026-10-28T12:00:00.000Z",
      gimp: "2026-10-28T12:00:01.000Z",
    }, NOW),
    ["code", "zoom"],
  );
});

Deno.test("a newly waiting snap is recorded without any warning", async () => {
  const h = await harness();
  assertEquals(await h.check({ code: 0, stdout: TABLE, stderr: "" }), "ok");
  assertEquals(await record(h.stateDir), {
    code: NOW.toISOString(),
    firefox: NOW.toISOString(),
  });
  assertEquals(h.warnings, []);
  assertEquals(h.notifications, []);
});

Deno.test("a snap waiting past the limit gets a warning and a critical notification", async () => {
  const h = await harness();
  await seed(h.stateDir, JSON.stringify({ code: FOUR_DAYS_AGO, firefox: ONE_DAY_AGO }));
  assertEquals(await h.check({ code: 0, stdout: TABLE, stderr: "" }), "stuck");
  assertEquals(h.notifications.length, 1);
  assertEquals(h.notifications[0].slice(0, 3), ["5", "notify-send", "--urgency=critical"]);
  const body = h.notifications[0].at(-1) ?? "";
  assertStringIncludes(body, "code: waiting 3+ days");
  assertStringIncludes(body, "sudo snap refresh");
  assert(!body.includes("firefox"), body);
  assertStringIncludes(h.warnings[0], "code: waiting 3+ days");
  assertEquals((await record(h.stateDir)).code, FOUR_DAYS_AGO);
});

Deno.test("up-to-date output clears the record, so a later update starts a new count", async () => {
  const h = await harness();
  await seed(h.stateDir, JSON.stringify({ code: FOUR_DAYS_AGO }));
  assertEquals(await h.check({ code: 0, stdout: "", stderr: "All snaps up to date.\n" }), "ok");
  assertEquals(await record(h.stateDir), {});
  assertEquals(h.notifications, []);
});

Deno.test("a machine without snap or timeout is a silent no-op", async () => {
  for (
    const query of [{ code: 127, stdout: "", stderr: "" }, new Deno.errors.NotFound("timeout")]
  ) {
    const h = await harness();
    assertEquals(await h.check(query), "skipped");
    assertEquals(h.warnings, []);
    assertEquals(h.notifications, []);
  }
});

Deno.test("a failed or unusable query fails, notifies and leaves the record alone", async () => {
  const cases: (CommandResult | Error)[] = [
    { code: 124, stdout: "", stderr: "" },
    { code: 1, stdout: "", stderr: "server misbehaving" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "something new\n", stderr: "" },
    new Error("spawn failed"),
  ];
  for (const query of cases) {
    const h = await harness();
    const before = JSON.stringify({ code: FOUR_DAYS_AGO });
    await seed(h.stateDir, before);
    assertEquals(await h.check(query), "failed");
    assertEquals(h.notifications.length, 1);
    assertEquals(h.notifications[0][2], "--urgency=normal");
    assertEquals(await Deno.readTextFile(`${h.stateDir}/${STATE_FILE}`), before);
  }
});

Deno.test("a damaged record warns and restarts the count", async () => {
  const h = await harness();
  await seed(h.stateDir, "not json");
  assertEquals(await h.check({ code: 0, stdout: TABLE, stderr: "" }), "ok");
  assertStringIncludes(h.warnings[0], "is not a valid record");
  assertEquals((await record(h.stateDir)).code, NOW.toISOString());
});

Deno.test("a record that cannot be saved fails instead of reporting ok", async () => {
  const h = await harness();
  // The state folder's path is taken by a file, so neither reading nor saving can work.
  await Deno.writeTextFile(h.stateDir, "");
  assertEquals(await h.check({ code: 0, stdout: TABLE, stderr: "" }), "failed");
  assertStringIncludes(h.notifications[0].at(-1) ?? "", "could not be saved");
});

Deno.test("a notification that cannot be sent still warns in the terminal", async () => {
  const h = await harness();
  await seed(h.stateDir, JSON.stringify({ code: FOUR_DAYS_AGO, firefox: FOUR_DAYS_AGO }));
  assertEquals(await h.check({ code: 0, stdout: TABLE, stderr: "" }, 127), "stuck");
  assertStringIncludes(h.warnings[0], "code, firefox: waiting 3+ days");
  assertEquals(h.warnings[1], "warning: the desktop notification could not be sent");
});

Deno.test("a notification command that cannot start still warns in the terminal", async () => {
  const stateDir = `${await Deno.makeTempDir({ prefix: "snap-updates-" })}/state`;
  await seed(stateDir, JSON.stringify({ code: FOUR_DAYS_AGO, firefox: FOUR_DAYS_AGO }));
  const warnings: string[] = [];
  const status = await checkSnapUpdates({
    stateDir,
    now: NOW,
    warn: (message) => warnings.push(message),
    runCommand: (_command, args) =>
      args[1] === "notify-send"
        ? Promise.reject(new Error("spawn failed"))
        : Promise.resolve({ code: 0, stdout: TABLE, stderr: "" }),
  });
  assertEquals(status, "stuck");
  assertEquals(warnings[1], "warning: the desktop notification could not be sent");
});

// ---- The registered task, end to end ----

async function runTask(snapScript: string, seedRecord?: string) {
  const home = await Deno.makeTempDir({ prefix: "snap-updates-home-" });
  const bin = `${home}/bin`;
  const notified = `${home}/notified.txt`;
  await Deno.mkdir(bin);
  await Deno.writeTextFile(`${bin}/snap`, `#!/bin/sh\n${snapScript}\n`, { mode: 0o755 });
  await Deno.writeTextFile(
    `${bin}/notify-send`,
    `#!/bin/sh\necho "$1 $4" >> "${notified}"\n`,
    { mode: 0o755 },
  );
  const stateDir = `${home}/.local/state/web-jam-tools`;
  if (seedRecord) await seed(stateDir, seedRecord);
  const out = await new Deno.Command("deno", {
    args: ["task", "--config", `${REPO_ROOT}deno.json`, "check-snap-updates"],
    env: {
      HOME: home,
      PATH: `${bin}:${Deno.env.get("PATH")}`,
      DENO_DIR: Deno.env.get("DENO_DIR") ?? `${Deno.env.get("HOME")}/.cache/deno`,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stderr = new TextDecoder().decode(out.stderr);
  const notifiedText = await Deno.readTextFile(notified).catch(() => "");
  return { code: out.code, stderr, notifiedText, stateDir };
}

Deno.test("the check-snap-updates task warns about a stuck snap with its own permissions", async () => {
  const printTable = `printf 'Name  Version  Rev\\ncode  2  274\\n'`;
  const task = await runTask(printTable, JSON.stringify({ code: FOUR_DAYS_AGO }));
  assertEquals(task.code, 0, task.stderr);
  assertStringIncludes(task.stderr, "code: waiting 3+ days");
  assertStringIncludes(task.notifiedText, "--urgency=critical");
  assertStringIncludes(task.notifiedText, "sudo snap refresh");
});

Deno.test("the check-snap-updates task saves its record when nothing is stuck yet", async () => {
  const task = await runTask(`printf 'Name  Version  Rev\\ncode  2  274\\n'`);
  assertEquals(task.code, 0, task.stderr);
  assertEquals(task.notifiedText, "");
  assert(Object.hasOwn(await record(task.stateDir), "code"));
});

Deno.test("the check-snap-updates task exits 1 when the query fails", async () => {
  const task = await runTask(`echo 'server misbehaving' >&2; exit 1`);
  assertEquals(task.code, 1);
  assertStringIncludes(task.stderr, "Could not check snap updates");
  assertStringIncludes(task.notifiedText, "--urgency=normal");
});
