// test/health_tracker_typed_line_test.ts
// Tests every row of the typed-line table in health-wellness-design.md ("What he types").
// Uses made-up activities and made-up numbers in temporary folders (web-jam-tools#1660).

import { assertEquals, assertStringIncludes } from "@std/assert";
import { parseReportLine } from "../src/health-tracker/parse.ts";
import { runHealthReport } from "../src/health-tracker/report.ts";
import * as path from "@std/path";

const MOCK_ACTIVITIES = {
  orbitjump: "minutes",
  cosmicspin: "minutes",
  gravitylift: "reps",
};

Deno.test("typed-line row 1: weight only is saved", () => {
  const res = parseReportLine("155.2", MOCK_ACTIVITIES);
  assertEquals(res.type, "save");
  if (res.type === "save") {
    assertEquals(res.data.weight, 155.2);
    assertEquals(res.data.exercise, undefined);
  }
});

Deno.test("typed-line row 2: weight and two activities are saved", () => {
  const res = parseReportLine("155.2 orbitjump 35 cosmicspin 20", MOCK_ACTIVITIES);
  assertEquals(res.type, "save");
  if (res.type === "save") {
    assertEquals(res.data.weight, 155.2);
    assertEquals(res.data.exercise, {
      orbitjump: 35,
      cosmicspin: 20,
    });
  }
});

Deno.test("typed-line row 3: activity only without weight is saved", () => {
  const res = parseReportLine("orbitjump 35", MOCK_ACTIVITIES);
  assertEquals(res.type, "save");
  if (res.type === "save") {
    assertEquals(res.data.weight, undefined);
    assertEquals(res.data.exercise, { orbitjump: 35 });
  }
});

Deno.test("typed-line row 4: letter case does not matter and saves lower-case", () => {
  const res = parseReportLine("ORBITJUMP 35", MOCK_ACTIVITIES);
  assertEquals(res.type, "save");
  if (res.type === "save") {
    assertEquals(res.data.weight, undefined);
    assertEquals(res.data.exercise, { orbitjump: 35 });
  }
});

Deno.test("typed-line row 5: activity number may hold a decimal", () => {
  const res = parseReportLine("155.2 orbitjump 35.5", MOCK_ACTIVITIES);
  assertEquals(res.type, "save");
  if (res.type === "save") {
    assertEquals(res.data.weight, 155.2);
    assertEquals(res.data.exercise, { orbitjump: 35.5 });
  }
});

Deno.test("typed-line row 6: empty line is skipped and writes nothing", () => {
  const resEmpty = parseReportLine("", MOCK_ACTIVITIES);
  assertEquals(resEmpty.type, "skip");

  const resWhitespace = parseReportLine("    ", MOCK_ACTIVITIES);
  assertEquals(resWhitespace.type, "skip");
});

Deno.test("typed-line row 7: Ctrl-D (null line) is skipped cleanly via runner", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "health-test-" });
  try {
    const trackerFile = path.join(tmpDir, "health-tracker.json");
    const activitiesFile = path.join(tmpDir, "health-activities.json");
    const progressSvgFile = path.join(tmpDir, "health-progress.svg");

    await Deno.writeTextFile(trackerFile, "[]\n");
    await Deno.writeTextFile(activitiesFile, JSON.stringify(MOCK_ACTIVITIES, null, 4));

    let output = "";
    const code = await runHealthReport({
      paths: { trackerFile, activitiesFile, progressSvgFile },
      isTerminal: () => true,
      readLine: () => Promise.resolve(null), // Simulates Ctrl-D / EOF
      printOut: (s) => output += s,
    });

    assertEquals(code, 0);
    // Nothing written to tracker file
    const trackerContent = await Deno.readTextFile(trackerFile);
    assertEquals(trackerContent, "[]\n");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("typed-line row 8: missing number refuses, names activity, and asks again", () => {
  const res = parseReportLine("155.2 orbitjump", MOCK_ACTIVITIES);
  assertEquals(res.type, "refusal");
  if (res.type === "refusal") {
    assertStringIncludes(res.reason, "orbitjump");
    assertStringIncludes(res.reason.toLowerCase(), "missing its number");
  }
});

Deno.test("typed-line row 9: unknown activity refuses, names activity and lists allowed activities", () => {
  const res = parseReportLine("155.2 orbitjumpX 35", MOCK_ACTIVITIES);
  assertEquals(res.type, "refusal");
  if (res.type === "refusal") {
    assertStringIncludes(res.reason, "orbitjumpX");
    assertStringIncludes(res.reason, "cosmicspin");
    assertStringIncludes(res.reason, "gravitylift");
    assertStringIncludes(res.reason, "orbitjump");
  }
});

Deno.test("typed-line row 10: repeated activity refuses and names activity as repeated", () => {
  const res = parseReportLine("155.2 orbitjump 35 orbitjump 15", MOCK_ACTIVITIES);
  assertEquals(res.type, "refusal");
  if (res.type === "refusal") {
    assertStringIncludes(res.reason, "orbitjump");
    assertStringIncludes(res.reason.toLowerCase(), "repeated");
  }
});

Deno.test("typed-line row 11: negative number refuses and names the negative number", () => {
  const res = parseReportLine("155.2 orbitjump -5", MOCK_ACTIVITIES);
  assertEquals(res.type, "refusal");
  if (res.type === "refusal") {
    assertStringIncludes(res.reason, "-5");
  }
});

Deno.test("typed-line row 12: weight outside 50 to 700 is refused as typo and asked again", () => {
  const resTooHigh = parseReportLine("1552", MOCK_ACTIVITIES);
  assertEquals(resTooHigh.type, "refusal");
  if (resTooHigh.type === "refusal") {
    assertStringIncludes(resTooHigh.reason, "1552");
    assertStringIncludes(resTooHigh.reason, "outside 50 to 700");
    assertStringIncludes(resTooHigh.reason.toLowerCase(), "typo");
  }

  const resTooLow = parseReportLine("45", MOCK_ACTIVITIES);
  assertEquals(resTooLow.type, "refusal");
  if (resTooLow.type === "refusal") {
    assertStringIncludes(resTooLow.reason, "45");
    assertStringIncludes(resTooLow.reason, "outside 50 to 700");
  }
});

Deno.test("typed-line row 13: unknown token refuses and lists allowed activities", () => {
  const res = parseReportLine("randomtoken", MOCK_ACTIVITIES);
  assertEquals(res.type, "refusal");
  if (res.type === "refusal") {
    assertStringIncludes(res.reason, "randomtoken");
    assertStringIncludes(res.reason, "cosmicspin");
    assertStringIncludes(res.reason, "gravitylift");
    assertStringIncludes(res.reason, "orbitjump");
  }
});
