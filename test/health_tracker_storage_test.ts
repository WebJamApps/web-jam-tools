// test/health_tracker_storage_test.ts
// Tests every row of "When the files are not usable" table in health-wellness-design.md.
// Uses made-up activities and made-up numbers in temporary folders (web-jam-tools#1660).

import { assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { runHealthReport } from "../src/health-tracker/report.ts";
import { saveReportEntry } from "../src/health-tracker/storage.ts";

const MOCK_ACTIVITIES = {
  fakesprint: "minutes",
  fakeclimb: "floors",
};

Deno.test("files-not-usable row 1: tracker file does not exist -> silent exit 0", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "health-test-" });
  try {
    const trackerFile = path.join(tmpDir, "nonexistent-tracker.json");
    const activitiesFile = path.join(tmpDir, "health-activities.json");
    const progressSvgFile = path.join(tmpDir, "health-progress.svg");

    await Deno.writeTextFile(activitiesFile, JSON.stringify(MOCK_ACTIVITIES));

    let output = "";
    let errOutput = "";

    const code = await runHealthReport({
      paths: { trackerFile, activitiesFile, progressSvgFile },
      isTerminal: () => true,
      printOut: (s) => output += s,
      printErr: (s) => errOutput += s,
    });

    assertEquals(code, 0, "must exit 0 cleanly");
    assertEquals(output, "", "no question asked");
    assertEquals(errOutput, "", "no message printed");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("files-not-usable row 2: today's entry already exists -> silent exit 0", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "health-test-" });
  try {
    const trackerFile = path.join(tmpDir, "health-tracker.json");
    const activitiesFile = path.join(tmpDir, "health-activities.json");
    const progressSvgFile = path.join(tmpDir, "health-progress.svg");

    const todayDate = new Date(2026, 9, 31); // 2026-10-31
    const initialData = [
      {
        date: "2026-10-31",
        weekday: "Saturday",
        weight: 160.0,
      },
    ];
    await Deno.writeTextFile(trackerFile, JSON.stringify(initialData, null, 4) + "\n");
    await Deno.writeTextFile(activitiesFile, JSON.stringify(MOCK_ACTIVITIES));

    let output = "";
    let errOutput = "";

    const code = await runHealthReport({
      paths: { trackerFile, activitiesFile, progressSvgFile },
      now: todayDate,
      isTerminal: () => true,
      printOut: (s) => output += s,
      printErr: (s) => errOutput += s,
    });

    assertEquals(code, 0, "must exit 0 cleanly");
    assertEquals(output, "", "no question asked");
    assertEquals(errOutput, "", "no message printed");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("files-not-usable row 3: tracker file is not a readable JSON array -> warning names file and exit 1", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "health-test-" });
  try {
    const trackerFile = path.join(tmpDir, "health-tracker.json");
    const activitiesFile = path.join(tmpDir, "health-activities.json");
    const progressSvgFile = path.join(tmpDir, "health-progress.svg");

    await Deno.writeTextFile(trackerFile, '{ "not": "an array" }\n');
    await Deno.writeTextFile(activitiesFile, JSON.stringify(MOCK_ACTIVITIES));

    let output = "";
    let errOutput = "";

    const code = await runHealthReport({
      paths: { trackerFile, activitiesFile, progressSvgFile },
      isTerminal: () => true,
      printOut: (s) => output += s,
      printErr: (s) => errOutput += s,
    });

    assertEquals(code, 1, "must exit 1");
    assertEquals(output, "", "no question asked");
    assertStringIncludes(errOutput, trackerFile);
    assertStringIncludes(errOutput, "not a readable JSON array");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("files-not-usable row 4: activities file is missing or not readable -> warning names file and exit 1", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "health-test-" });
  try {
    const trackerFile = path.join(tmpDir, "health-tracker.json");
    const activitiesFile = path.join(tmpDir, "missing-activities.json");
    const progressSvgFile = path.join(tmpDir, "health-progress.svg");

    await Deno.writeTextFile(trackerFile, "[]\n");

    let output = "";
    let errOutput = "";

    const code = await runHealthReport({
      paths: { trackerFile, activitiesFile, progressSvgFile },
      isTerminal: () => true,
      printOut: (s) => output += s,
      printErr: (s) => errOutput += s,
    });

    assertEquals(code, 1, "must exit 1");
    assertEquals(output, "", "no question asked");
    assertStringIncludes(errOutput, activitiesFile);
    assertStringIncludes(errOutput, "missing or not readable");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("files-not-usable row 5: write failure says report was not saved, repeats typed line and exit 1", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "health-test-" });
  try {
    const trackerFile = path.join(tmpDir, "health-tracker.json");
    const activitiesFile = path.join(tmpDir, "health-activities.json");
    const progressSvgFile = path.join(tmpDir, "health-progress.svg");

    await Deno.writeTextFile(trackerFile, "[]\n");
    await Deno.writeTextFile(activitiesFile, JSON.stringify(MOCK_ACTIVITIES));

    // Make tracker file read-only so write fails
    await Deno.chmod(trackerFile, 0o444);

    let output = "";
    let errOutput = "";
    const typedLine = "162.5 fakesprint 25";

    const code = await runHealthReport({
      paths: { trackerFile, activitiesFile, progressSvgFile },
      isTerminal: () => true,
      readLine: () => Promise.resolve(typedLine),
      printOut: (s) => output += s,
      printErr: (s) => errOutput += s,
    });

    assertEquals(code, 1, "must exit 1");
    assertStringIncludes(errOutput, "report was not saved");
    assertStringIncludes(errOutput, typedLine);
  } finally {
    // Restore write permission so tempDir cleanup succeeds
    try {
      await Deno.chmod(path.join(tmpDir, "health-tracker.json"), 0o666);
    } catch {
      // ignore
    }
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("re-reads before write and skips if today entry appeared concurrently", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "health-test-" });
  try {
    const trackerFile = path.join(tmpDir, "health-tracker.json");
    const today = new Date(2026, 9, 31);

    // Initial file has today's date already
    const initial = [{ date: "2026-10-31", weight: 160.0 }];
    await Deno.writeTextFile(trackerFile, JSON.stringify(initial, null, 4) + "\n");

    const attempt = { date: "2026-10-31", weight: 161.0 };
    const res = await saveReportEntry(trackerFile, attempt, today);

    assertEquals(res.saved, false, "must not overwrite concurrent entry");
    const fileContent = await Deno.readTextFile(trackerFile);
    assertEquals(JSON.parse(fileContent), initial);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("saves entry with 4-space indent and trailing newline", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "health-test-" });
  try {
    const trackerFile = path.join(tmpDir, "health-tracker.json");
    const today = new Date(2026, 9, 31);

    await Deno.writeTextFile(trackerFile, "[]\n");
    const entry = { date: "2026-10-31", weekday: "Saturday", weight: 160.5 };
    await saveReportEntry(trackerFile, entry, today);

    const content = await Deno.readTextFile(trackerFile);
    assertEquals(content, JSON.stringify([entry], null, 4) + "\n");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
