// test/health_tracker_report_test.ts
// Unit tests for report.ts, storage.ts helper methods, and main.ts in src/health-tracker/ (web-jam-tools#1660).

import { assert, assertEquals, assertRejects } from "@std/assert";
import * as path from "@std/path";
import { readLineWithDeadline, runHealthReport } from "../src/health-tracker/report.ts";
import {
  formatDateIso,
  getLocalWeekday,
  isSameDate,
  resolveStoragePaths,
  saveReportEntry,
} from "../src/health-tracker/storage.ts";

// --- storage.ts unit tests ---

Deno.test("resolveStoragePaths defaults to HOME/Dropbox/web-jam-llms and honors env overrides", () => {
  const origHome = Deno.env.get("HOME");
  const origTracker = Deno.env.get("HEALTH_TRACKER_FILE");
  const origAct = Deno.env.get("HEALTH_ACTIVITIES_FILE");
  const origSvg = Deno.env.get("HEALTH_PROGRESS_SVG");

  try {
    Deno.env.set("HOME", "/custom/home");
    Deno.env.delete("HEALTH_TRACKER_FILE");
    Deno.env.delete("HEALTH_ACTIVITIES_FILE");
    Deno.env.delete("HEALTH_PROGRESS_SVG");

    const paths = resolveStoragePaths();
    assertEquals(paths.trackerFile, "/custom/home/Dropbox/web-jam-llms/health-tracker.json");
    assertEquals(paths.activitiesFile, "/custom/home/Dropbox/web-jam-llms/health-activities.json");
    assertEquals(paths.progressSvgFile, "/custom/home/Dropbox/web-jam-llms/health-progress.svg");

    // Test overrides
    Deno.env.set("HEALTH_TRACKER_FILE", "/custom/tracker.json");
    Deno.env.set("HEALTH_ACTIVITIES_FILE", "/custom/activities.json");
    Deno.env.set("HEALTH_PROGRESS_SVG", "/custom/graph.svg");

    const customPaths = resolveStoragePaths();
    assertEquals(customPaths.trackerFile, "/custom/tracker.json");
    assertEquals(customPaths.activitiesFile, "/custom/activities.json");
    assertEquals(customPaths.progressSvgFile, "/custom/graph.svg");
  } finally {
    if (origHome !== undefined) Deno.env.set("HOME", origHome);
    else Deno.env.delete("HOME");
    if (origTracker !== undefined) Deno.env.set("HEALTH_TRACKER_FILE", origTracker);
    else Deno.env.delete("HEALTH_TRACKER_FILE");
    if (origAct !== undefined) Deno.env.set("HEALTH_ACTIVITIES_FILE", origAct);
    else Deno.env.delete("HEALTH_ACTIVITIES_FILE");
    if (origSvg !== undefined) Deno.env.set("HEALTH_PROGRESS_SVG", origSvg);
    else Deno.env.delete("HEALTH_PROGRESS_SVG");
  }
});

Deno.test("getLocalWeekday correctly returns day name across all 7 days", () => {
  assertEquals(getLocalWeekday(new Date(2026, 9, 25)), "Sunday");
  assertEquals(getLocalWeekday(new Date(2026, 9, 26)), "Monday");
  assertEquals(getLocalWeekday(new Date(2026, 9, 27)), "Tuesday");
  assertEquals(getLocalWeekday(new Date(2026, 9, 28)), "Wednesday");
  assertEquals(getLocalWeekday(new Date(2026, 9, 29)), "Thursday");
  assertEquals(getLocalWeekday(new Date(2026, 9, 30)), "Friday");
  assertEquals(getLocalWeekday(new Date(2026, 9, 31)), "Saturday");
});

Deno.test("formatDateIso formats date with leading zeros", () => {
  assertEquals(formatDateIso(new Date(2026, 0, 5)), "2026-01-05");
  assertEquals(formatDateIso(new Date(2026, 9, 31)), "2026-10-31");
});

Deno.test("isSameDate validates and parses dates correctly", () => {
  const target = new Date(2026, 9, 31);
  assertEquals(isSameDate("2026-10-31", target), true);
  assertEquals(isSameDate("2026-10-30", target), false);
  assertEquals(isSameDate("2025-10-31", target), false);
  assertEquals(isSameDate("2026-9-31", target), false);
  assertEquals(isSameDate(12345, target), false);
  assertEquals(isSameDate(null, target), false);
  assertEquals(isSameDate(undefined, target), false);
  assertEquals(isSameDate("invalid-date", target), false);
  assertEquals(isSameDate("2026/10/31", target), false);

  // Single digit month/day in entry
  const nov5 = new Date(2026, 10, 5);
  assertEquals(isSameDate("2026-11-5", nov5), true);
  assertEquals(isSameDate("2026-11-05", nov5), true);
});

Deno.test("saveReportEntry throws if re-read content is not a JSON array", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "health-save-invalid-" });
  const trackerFile = path.join(tmpDir, "tracker.json");
  await Deno.writeTextFile(trackerFile, JSON.stringify({ not: "an array" }));

  try {
    await assertRejects(
      () =>
        saveReportEntry(
          trackerFile,
          { date: "2026-10-31", weight: 170 },
          new Date(2026, 9, 31),
        ),
      Error,
      "not a readable JSON array",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// --- readLineWithDeadline unit tests ---

Deno.test("readLineWithDeadline returns timeout if deadline has already passed", async () => {
  const result = await readLineWithDeadline(Date.now() - 100);
  assertEquals(result, "timeout");
});

Deno.test("readLineWithDeadline reads line ending with LF", async () => {
  const encoder = new TextEncoder();
  const chunks = [encoder.encode("152.4 orbitjump 45\n")];
  let idx = 0;
  const mockReader = {
    read: (buf: Uint8Array): Promise<number | null> => {
      if (idx >= chunks.length) return Promise.resolve(null);
      const chunk = chunks[idx++];
      buf.set(chunk);
      return Promise.resolve(chunk.length);
    },
  };

  const result = await readLineWithDeadline(Date.now() + 5000, mockReader);
  assertEquals(result, "152.4 orbitjump 45");
});

Deno.test("readLineWithDeadline reads line ending with CRLF", async () => {
  const encoder = new TextEncoder();
  const chunks = [encoder.encode("152.4\r\n")];
  let idx = 0;
  const mockReader = {
    read: (buf: Uint8Array): Promise<number | null> => {
      if (idx >= chunks.length) return Promise.resolve(null);
      const chunk = chunks[idx++];
      buf.set(chunk);
      return Promise.resolve(chunk.length);
    },
  };

  const result = await readLineWithDeadline(Date.now() + 5000, mockReader);
  assertEquals(result, "152.4");
});

Deno.test("readLineWithDeadline returns accumulated line on EOF without newline", async () => {
  const encoder = new TextEncoder();
  const chunks = [encoder.encode("no newline here")];
  let idx = 0;
  const mockReader = {
    read: (buf: Uint8Array): Promise<number | null> => {
      if (idx >= chunks.length) return Promise.resolve(null);
      const chunk = chunks[idx++];
      buf.set(chunk);
      return Promise.resolve(chunk.length);
    },
  };

  const result = await readLineWithDeadline(Date.now() + 5000, mockReader);
  assertEquals(result, "no newline here");
});

Deno.test("readLineWithDeadline returns timeout when deadline triggers before input", async () => {
  const mockReader = {
    read: (): Promise<number | null> => {
      return new Promise((resolve) => setTimeout(() => resolve(null), 500));
    },
  };

  const result = await readLineWithDeadline(Date.now() + 50, mockReader);
  assertEquals(result, "timeout");
});

// --- runHealthReport unit tests ---

Deno.test("runHealthReport returns 0 immediately when isTerminal is false", async () => {
  let asked = false;
  const code = await runHealthReport({
    isTerminal: () => false,
    readLine: () => {
      asked = true;
      return Promise.resolve("152.4");
    },
  });
  assertEquals(code, 0);
  assertEquals(asked, false);
});

Deno.test("runHealthReport honors HEALTH_REPORT_NOW and HEALTH_REPORT_TIMEOUT_MS env vars", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "health-env-test-" });
  const trackerFile = path.join(tmpDir, "tracker.json");
  const activitiesFile = path.join(tmpDir, "activities.json");
  const svgFile = path.join(tmpDir, "progress.svg");

  await Deno.writeTextFile(trackerFile, "[]\n");
  await Deno.writeTextFile(activitiesFile, JSON.stringify({ orbitjump: "minutes" }));

  const origNow = Deno.env.get("HEALTH_REPORT_NOW");
  const origTimeout = Deno.env.get("HEALTH_REPORT_TIMEOUT_MS");
  const origSkipChrome = Deno.env.get("HEALTH_REPORT_SKIP_CHROME");

  try {
    Deno.env.set("HEALTH_REPORT_NOW", "2026-10-31T12:00:00Z");
    Deno.env.set("HEALTH_REPORT_TIMEOUT_MS", "3000");
    Deno.env.set("HEALTH_REPORT_SKIP_CHROME", "1");

    const code = await runHealthReport({
      paths: { trackerFile, activitiesFile, progressSvgFile: svgFile },
      isTerminal: () => true,
      readLine: () => Promise.resolve("151.5 orbitjump 30"),
    });

    assertEquals(code, 0);
    const saved = JSON.parse(await Deno.readTextFile(trackerFile));
    assertEquals(saved.length, 1);
    assertEquals(saved[0].date, "2026-10-31");
    assertEquals(saved[0].weight, 151.5);
    assertEquals(saved[0].exercise, { orbitjump: 30 });
    assert(await Deno.stat(svgFile));
  } finally {
    if (origNow !== undefined) Deno.env.set("HEALTH_REPORT_NOW", origNow);
    else Deno.env.delete("HEALTH_REPORT_NOW");
    if (origTimeout !== undefined) Deno.env.set("HEALTH_REPORT_TIMEOUT_MS", origTimeout);
    else Deno.env.delete("HEALTH_REPORT_TIMEOUT_MS");
    if (origSkipChrome !== undefined) Deno.env.set("HEALTH_REPORT_SKIP_CHROME", origSkipChrome);
    else Deno.env.delete("HEALTH_REPORT_SKIP_CHROME");
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("runHealthReport prompts again on refusal and saves on subsequent valid line", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "health-refusal-loop-" });
  const trackerFile = path.join(tmpDir, "tracker.json");
  const activitiesFile = path.join(tmpDir, "activities.json");
  const svgFile = path.join(tmpDir, "progress.svg");

  await Deno.writeTextFile(trackerFile, "[]\n");
  await Deno.writeTextFile(activitiesFile, JSON.stringify({ cosmicspin: "minutes" }));

  const inputs = ["cosmicspin -5", "cosmicspin 25"];
  let inputIdx = 0;
  const errLogs: string[] = [];
  const outLogs: string[] = [];

  const code = await runHealthReport({
    paths: { trackerFile, activitiesFile, progressSvgFile: svgFile },
    isTerminal: () => true,
    now: new Date(2026, 9, 31),
    readLine: () => Promise.resolve(inputs[inputIdx++]),
    printOut: (msg) => outLogs.push(msg),
    printErr: (msg) => errLogs.push(msg),
  });

  assertEquals(code, 0);
  assert(outLogs.some((l) => l.includes("Activities: cosmicspin")));
  assert(errLogs.some((l) => l.includes("-5")));
  const saved = JSON.parse(await Deno.readTextFile(trackerFile));
  assertEquals(saved.length, 1);
  assertEquals(saved[0].exercise, { cosmicspin: 25 });

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("runHealthReport skips cleanly on timeout", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "health-timeout-" });
  const trackerFile = path.join(tmpDir, "tracker.json");
  const activitiesFile = path.join(tmpDir, "activities.json");
  const svgFile = path.join(tmpDir, "progress.svg");

  await Deno.writeTextFile(trackerFile, "[]\n");
  await Deno.writeTextFile(activitiesFile, JSON.stringify({ cosmicspin: "minutes" }));

  const code = await runHealthReport({
    paths: { trackerFile, activitiesFile, progressSvgFile: svgFile },
    isTerminal: () => true,
    now: new Date(2026, 9, 31),
    readLine: () => Promise.resolve("timeout"),
  });

  assertEquals(code, 0);
  const saved = JSON.parse(await Deno.readTextFile(trackerFile));
  assertEquals(saved.length, 0);

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("runHealthReport warns and continues if SVG generation/write fails", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "health-svg-err-" });
  const trackerFile = path.join(tmpDir, "tracker.json");
  const activitiesFile = path.join(tmpDir, "activities.json");
  // Point SVG to a directory to induce write error
  const invalidSvgFile = tmpDir;

  await Deno.writeTextFile(trackerFile, "[]\n");
  await Deno.writeTextFile(activitiesFile, JSON.stringify({ cosmicspin: "minutes" }));

  const errLogs: string[] = [];
  const code = await runHealthReport({
    paths: { trackerFile, activitiesFile, progressSvgFile: invalidSvgFile },
    isTerminal: () => true,
    now: new Date(2026, 9, 31),
    readLine: () => Promise.resolve("cosmicspin 20"),
    printErr: (msg) => errLogs.push(msg),
  });

  assertEquals(code, 0);
  assert(errLogs.some((l) => l.includes("warning: could not generate progress graph")));

  await Deno.remove(tmpDir, { recursive: true });
});

// --- main.ts subprocess execution test ---

Deno.test("src/health-tracker/main.ts exits cleanly when executed as main task", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "src/health-tracker/main.ts"],
    env: {
      ...Deno.env.toObject(),
      HEALTH_REPORT_FORCE_TERMINAL: "0",
      HEALTH_REPORT_SKIP_CHROME: "1",
    },
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  assertEquals(out.code, 0);
});

Deno.test("runHealthReport terminates cleanly on timeout with idle pseudo-terminal", async () => {
  const pyCode = `
import pty, os, time, subprocess, sys

master, slave = pty.openpty()
env = os.environ.copy()
env["HEALTH_REPORT_TIMEOUT_MS"] = "150"
env["HEALTH_REPORT_FORCE_TERMINAL"] = "1"
env["HEALTH_REPORT_SKIP_CHROME"] = "1"

proc = subprocess.Popen(
    [sys.argv[1], "run", "--allow-all", "src/health-tracker/main.ts"],
    stdin=slave,
    stdout=slave,
    stderr=slave,
    env=env,
    close_fds=True
)
os.close(slave)

try:
    proc.wait(timeout=3)
    sys.exit(proc.returncode)
except subprocess.TimeoutExpired:
    proc.kill()
    sys.exit(99)
`;

  const cmd = new Deno.Command("python3", {
    args: ["-c", pyCode, Deno.execPath()],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  assertEquals(
    out.code,
    0,
    "health-report must exit cleanly (code 0) on timeout in pseudo-terminal",
  );
});

Deno.test("health-report task executes cleanly under scoped permissions from deno.json", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "health-task-perm-" });
  const trackerFile = path.join(tmpDir, "health-tracker.json");
  const activitiesFile = path.join(tmpDir, "health-activities.json");
  const progressSvgFile = path.join(tmpDir, "health-progress.svg");

  await Deno.writeTextFile(trackerFile, "[]\n");
  await Deno.writeTextFile(activitiesFile, JSON.stringify({ orbitjump: "minutes" }));

  try {
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        `--allow-read=.,${tmpDir}`,
        `--allow-write=${tmpDir}`,
        `--allow-env=HOME,HEALTH_TRACKER_FILE,HEALTH_ACTIVITIES_FILE,HEALTH_PROGRESS_SVG,HEALTH_REPORT_NOW,HEALTH_REPORT_TIMEOUT_MS,HEALTH_REPORT_CHROME_CMD,HEALTH_REPORT_SKIP_CHROME,HEALTH_REPORT_FORCE_TERMINAL,DISPLAY,XAUTHORITY,DBUS_SESSION_BUS_ADDRESS,XDG_RUNTIME_DIR`,
        "--allow-run=google-chrome,systemctl",
        "src/health-tracker/main.ts",
      ],
      env: {
        HOME: tmpDir,
        HEALTH_TRACKER_FILE: trackerFile,
        HEALTH_ACTIVITIES_FILE: activitiesFile,
        HEALTH_PROGRESS_SVG: progressSvgFile,
        HEALTH_REPORT_FORCE_TERMINAL: "1",
        HEALTH_REPORT_TIMEOUT_MS: "150",
        HEALTH_REPORT_SKIP_CHROME: "1",
      },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });

    const child = cmd.spawn();
    const out = await child.output();
    assertEquals(out.code, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
