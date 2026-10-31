// src/health-tracker/report.ts
// Interactive daily report runner with terminal prompt and timeout (web-jam-tools#1660).

import { parseReportLine } from "./parse.ts";
import {
  checkReadiness,
  formatDateIso,
  getLocalWeekday,
  type HealthTrackerEntry,
  resolveStoragePaths,
  saveReportEntry,
  type StoragePaths,
} from "./storage.ts";
import { generateProgressSvg } from "./graph.ts";
import { openProgressSvgInChrome } from "./open_chrome.ts";

export interface ReportRunnerOptions {
  paths?: StoragePaths;
  now?: Date;
  timeoutMs?: number;
  isTerminal?: () => boolean;
  readLine?: () => Promise<string | null | "timeout">;
  printOut?: (msg: string) => void;
  printErr?: (msg: string) => void;
}

export async function readLineWithDeadline(
  deadline: number,
  reader: { read: (buf: Uint8Array) => Promise<number | null> } = Deno.stdin,
): Promise<string | null | "timeout"> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return "timeout";

  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timerId = setTimeout(() => resolve("timeout"), remaining);
  });

  const readPromise = (async (): Promise<string | null> => {
    const decoder = new TextDecoder();
    let accumulated = "";
    const buf = new Uint8Array(1024);
    while (true) {
      const n = await reader.read(buf);
      if (n === null) {
        return accumulated.length > 0 ? accumulated : null;
      }
      accumulated += decoder.decode(buf.subarray(0, n));
      const nlIdx = accumulated.indexOf("\n");
      if (nlIdx !== -1) {
        let line = accumulated.slice(0, nlIdx);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        return line;
      }
    }
  })();

  try {
    return await Promise.race([readPromise, timeoutPromise]);
  } finally {
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
  }
}

/**
 * Runs the daily report workflow.
 * Returns the process exit code: 0 for success/skip/no-tracker, 1 for errors.
 */
export async function runHealthReport(options: ReportRunnerOptions = {}): Promise<number> {
  const isTerm = options.isTerminal || (() => {
    return Deno.env.get("HEALTH_REPORT_FORCE_TERMINAL") === "1" || Deno.stdin.isTerminal();
  });

  // With no keyboard attached, do not ask
  if (!isTerm()) {
    return 0;
  }

  const paths = options.paths || resolveStoragePaths();

  let now = options.now;
  if (!now) {
    const nowEnv = Deno.env.get("HEALTH_REPORT_NOW");
    now = nowEnv ? new Date(nowEnv) : new Date();
  }

  const printOut = options.printOut || ((msg: string) => {
    Deno.stdout.writeSync(new TextEncoder().encode(msg));
  });
  const printErr = options.printErr || ((msg: string) => {
    Deno.stderr.writeSync(new TextEncoder().encode(msg));
  });

  // Check file readiness
  const readiness = await checkReadiness(paths, now);
  if (readiness.status === "no_tracker") {
    // Machine without tracker has no question and no message
    return 0;
  }
  if (readiness.status === "already_reported") {
    // Today's entry already exists; no question and no message
    return 0;
  }
  if (readiness.status === "error") {
    // File not readable array or activities missing/not readable
    printErr(`${readiness.warning}\n`);
    return 1;
  }

  const { activities } = readiness;

  // Show available activity names once
  const activityNames = Object.keys(activities).sort().join(", ");
  printOut(`Activities: ${activityNames}\n`);

  // Prompt against a 5-minute timer (overridable)
  let timeoutMs = options.timeoutMs;
  if (timeoutMs === undefined) {
    const envTimeout = Deno.env.get("HEALTH_REPORT_TIMEOUT_MS");
    timeoutMs = envTimeout ? parseInt(envTimeout, 10) : 5 * 60 * 1000;
  }
  const deadline = Date.now() + timeoutMs;

  const defaultReadLine = () => readLineWithDeadline(deadline);
  const readFn = options.readLine || defaultReadLine;

  const promptText = "Report (weight, then activity and number; Enter to skip): ";

  while (true) {
    printOut(promptText);

    const input = await readFn();
    if (input === "timeout" || input === null) {
      // 5-minute timeout or Ctrl-D -> skip cleanly
      printOut("\n");
      return 0;
    }

    const parseResult = parseReportLine(input, activities);

    if (parseResult.type === "skip") {
      // Empty line -> skip cleanly
      return 0;
    }

    if (parseResult.type === "refusal") {
      printErr(`${parseResult.reason}\n`);
      // Ask again
      continue;
    }

    // Valid entry: save to file
    const newEntry: HealthTrackerEntry = {
      date: formatDateIso(now),
      weekday: getLocalWeekday(now),
    };
    if (parseResult.data.weight !== undefined) {
      newEntry.weight = parseResult.data.weight;
    }
    if (parseResult.data.exercise !== undefined) {
      newEntry.exercise = parseResult.data.exercise;
    }

    let saveResult: { saved: boolean; entries: HealthTrackerEntry[] };
    try {
      saveResult = await saveReportEntry(paths.trackerFile, newEntry, now);
    } catch (_err) {
      printErr(`report was not saved: ${input}\n`);
      return 1;
    }

    // Generate dark mode SVG and open in Chrome
    try {
      const svg = generateProgressSvg(saveResult.entries, activities, now);
      await Deno.writeTextFile(paths.progressSvgFile, svg);
      await openProgressSvgInChrome(paths.progressSvgFile);
    } catch (err) {
      printErr(
        `warning: could not generate progress graph: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }

    return 0;
  }
}
