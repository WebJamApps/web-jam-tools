// src/health-tracker/storage.ts
// File reading and writing for daily health tracker and activities (web-jam-tools#1660).

import * as path from "@std/path";

export interface HealthTrackerEntry {
  date: string;
  weekday?: string;
  weight?: number;
  exercise?: Record<string, number | { time?: number }>;
  [key: string]: unknown;
}

export interface StoragePaths {
  trackerFile: string;
  activitiesFile: string;
  progressSvgFile: string;
}

export function resolveStoragePaths(): StoragePaths {
  const home = Deno.env.get("HOME") || "";
  const defaultDir = path.join(home, "Dropbox", "web-jam-llms");

  const trackerFile = Deno.env.get("HEALTH_TRACKER_FILE") ||
    path.join(defaultDir, "health-tracker.json");
  const activitiesFile = Deno.env.get("HEALTH_ACTIVITIES_FILE") ||
    path.join(defaultDir, "health-activities.json");
  const progressSvgFile = Deno.env.get("HEALTH_PROGRESS_SVG") ||
    path.join(defaultDir, "health-progress.svg");

  return {
    trackerFile,
    activitiesFile,
    progressSvgFile,
  };
}

export type ReadinessResult =
  | { status: "ready"; entries: HealthTrackerEntry[]; activities: Record<string, string> }
  | { status: "no_tracker" } // File does not exist; silent exit 0
  | { status: "already_reported" } // Today's entry exists; silent exit 0
  | { status: "error"; warning: string }; // Unusable file; exit 1 with warning

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function getLocalWeekday(date: Date): string {
  return WEEKDAYS[date.getDay()];
}

export function formatDateIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isSameDate(entryDateStr: unknown, targetDate: Date): boolean {
  if (typeof entryDateStr !== "string") return false;
  const match = entryDateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return false;
  const y = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const d = parseInt(match[3], 10);
  return (
    y === targetDate.getFullYear() &&
    m === targetDate.getMonth() + 1 &&
    d === targetDate.getDate()
  );
}

/**
 * Checks readiness of health tracker and activities files before prompting.
 * Implements "When the files are not usable" table:
 * 1. tracker does not exist -> no_tracker (silent exit 0)
 * 2. tracker not readable JSON array -> error (exit 1 with warning)
 * 3. activities missing or not readable JSON object -> error (exit 1 with warning)
 * 4. today's entry already exists -> already_reported (silent exit 0)
 */
export async function checkReadiness(
  paths: StoragePaths,
  now: Date = new Date(),
): Promise<ReadinessResult> {
  // 1. Check if tracker file exists
  let trackerText: string;
  try {
    trackerText = await Deno.readTextFile(paths.trackerFile);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return { status: "no_tracker" };
    }
    return {
      status: "error",
      warning: `warning: ${paths.trackerFile} is not readable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // 2. Validate tracker is a JSON array
  let entries: HealthTrackerEntry[];
  try {
    const parsed = JSON.parse(trackerText);
    if (!Array.isArray(parsed)) {
      return {
        status: "error",
        warning: `warning: ${paths.trackerFile} is not a readable JSON array`,
      };
    }
    entries = parsed as HealthTrackerEntry[];
  } catch (_err) {
    return {
      status: "error",
      warning: `warning: ${paths.trackerFile} is not a readable JSON array`,
    };
  }

  // 3. Check if today's entry already exists
  const hasToday = entries.some((e) => isSameDate(e.date, now));
  if (hasToday) {
    return { status: "already_reported" };
  }

  // 4. Validate activities file exists and is a readable JSON object
  let activitiesText: string;
  try {
    activitiesText = await Deno.readTextFile(paths.activitiesFile);
  } catch (_err) {
    return {
      status: "error",
      warning: `warning: ${paths.activitiesFile} is missing or not readable`,
    };
  }

  let activities: Record<string, string>;
  try {
    const parsed = JSON.parse(activitiesText);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        status: "error",
        warning: `warning: ${paths.activitiesFile} is missing or not readable`,
      };
    }
    activities = parsed as Record<string, string>;
  } catch (_err) {
    return {
      status: "error",
      warning: `warning: ${paths.activitiesFile} is missing or not readable`,
    };
  }

  return {
    status: "ready",
    entries,
    activities,
  };
}

/**
 * Saves a daily report entry to the tracker file.
 * Re-reads before write; if today's entry appeared in the meantime, the first one stands.
 * Formats with 4-space indents and final newline.
 */
export async function saveReportEntry(
  trackerFile: string,
  newEntry: HealthTrackerEntry,
  now: Date = new Date(),
): Promise<{ saved: boolean; entries: HealthTrackerEntry[] }> {
  // Re-read file just before write
  const text = await Deno.readTextFile(trackerFile);
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`${trackerFile} is not a readable JSON array`);
  }

  const entries = parsed as HealthTrackerEntry[];
  // If today's entry appeared in the meantime from another device, first stands
  if (entries.some((e) => isSameDate(e.date, now))) {
    return { saved: false, entries };
  }

  entries.push(newEntry);
  const serialized = JSON.stringify(entries, null, 4) + "\n";
  await Deno.writeTextFile(trackerFile, serialized);

  return { saved: true, entries };
}
