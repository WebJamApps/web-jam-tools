// test/health_tracker_graph_test.ts
// Tests pure SVG progress graph generation and rendered Chrome pixel checks (web-jam-tools#1660).
// Uses made-up activities and made-up numbers in temporary folders.

import { assert, assertEquals, assertFalse } from "@std/assert";
import * as path from "@std/path";
import {
  assertSvgHasNoWhite,
  computeWeeklyMinutes,
  extractWeightHistory,
  generateProgressSvg,
} from "../src/health-tracker/graph.ts";
import type { HealthTrackerEntry } from "../src/health-tracker/storage.ts";

const MOCK_ACTIVITIES = {
  fakesprint: "minutes",
  fakecycle: "minutes",
  fakelift: "sets",
};

const MOCK_ENTRIES: HealthTrackerEntry[] = [
  {
    date: "2026-9-15",
    weekday: "Tuesday",
    weight: 170.0,
    exercise: { fakesprint: 30, fakelift: 5 },
  },
  {
    date: "2026-10-01",
    weekday: "Thursday",
    weight: 168.5,
    exercise: { fakecycle: 45 },
  },
  {
    date: "2026-10-15",
    weekday: "Thursday",
    weight: 166.0,
    exercise: { fakesprint: { time: 40 } as unknown as number },
  },
  {
    date: "2026-10-31",
    weekday: "Saturday",
    weight: 164.2,
    exercise: { fakesprint: 25, fakecycle: 20, fakelift: 10 },
  },
];

Deno.test("extractWeightHistory extracts and sorts weight readings", () => {
  const history = extractWeightHistory(MOCK_ENTRIES);
  assertEquals(history.length, 4);
  assertEquals(history[0].weight, 170.0);
  assertEquals(history[3].weight, 164.2);
});

Deno.test("computeWeeklyMinutes includes only minute activities and sums nested time", () => {
  const now = new Date(2026, 9, 31); // 2026-10-31
  const weekly = computeWeeklyMinutes(MOCK_ENTRIES, MOCK_ACTIVITIES, now);
  assertEquals(weekly.length, 8);

  // The last week (current week ending Saturday 2026-10-31) has fakesprint (25) + fakecycle (20) = 45 min
  // fakelift (sets) is excluded!
  const currentWeek = weekly[7];
  assertEquals(currentWeek.minutes, 45);

  // Week of 2026-10-15 has fakesprint with nested time: 40
  const weekOfOct15 = weekly.find((w) => {
    const t = new Date(2026, 9, 15).getTime();
    return t >= w.weekStart.getTime() && t < w.weekStart.getTime() + 7 * 86400000;
  });
  assert(weekOfOct15 !== undefined);
  assertEquals(weekOfOct15.minutes, 40);
});

Deno.test("generateProgressSvg produces valid dark-mode SVG without white or activity names", () => {
  const now = new Date(2026, 9, 31);
  const svg = generateProgressSvg(MOCK_ENTRIES, MOCK_ACTIVITIES, now);

  // Root element requirement
  assert(
    svg.includes(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 900 420" preserveAspectRatio="xMidYMid meet" style="background:#111418">',
    ),
  );

  // No white literals
  assertSvgHasNoWhite(svg);
  assertFalse(/\bwhite\b/i.test(svg));
  assertFalse(/#fff\b/i.test(svg));
  assertFalse(/#ffffff\b/i.test(svg));
  assertFalse(/rgb\s*\(\s*255/i.test(svg));

  // No activity names on the page
  for (const act of Object.keys(MOCK_ACTIVITIES)) {
    assertFalse(svg.toLowerCase().includes(act.toLowerCase()));
  }

  // Weight statistics are present
  assert(svg.includes("First: 170.0"));
  assert(svg.includes("Latest: 164.2"));
  assert(svg.includes("Change: -5.8"));
});

Deno.test("single weight entry renders as a dot", () => {
  const singleEntry: HealthTrackerEntry[] = [
    { date: "2026-10-31", weight: 165.0 },
  ];
  const svg = generateProgressSvg(singleEntry, MOCK_ACTIVITIES, new Date(2026, 9, 31));
  assertSvgHasNoWhite(svg);
  assert(svg.includes("First: 165.0"));
  assert(svg.includes("Latest: 165.0"));
  assert(svg.includes("Change: +0.0") || svg.includes("Change: 0.0"));
  assert(svg.includes("<circle"));
  // Does not have multi-point line path
  assertFalse(svg.includes('<path d="M'));
});

async function countNearWhitePixelsWithChrome(
  svgContent: string,
  width: number,
  height: number,
): Promise<number> {
  const tmpDir = await Deno.makeTempDir({ prefix: "health-graph-test-" });
  try {
    const svgPath = path.join(tmpDir, "graph.svg");
    const pngPath = path.join(tmpDir, "graph.png");
    await Deno.writeTextFile(svgPath, svgContent);

    // Run Chrome to take screenshot
    const chromeCmd = new Deno.Command("google-chrome", {
      args: [
        "--headless=new",
        `--screenshot=${pngPath}`,
        `--window-size=${width},${height}`,
        `file://${svgPath}`,
      ],
      stdout: "null",
      stderr: "null",
    });
    const chromeOut = await chromeCmd.output();
    assert(chromeOut.success, "google-chrome failed to render screenshot");

    // Count near-white pixels using python3 PIL
    const pyScript = `
import sys
from PIL import Image
img = Image.open(sys.argv[1]).convert('RGB')
near_white = sum(1 for r, g, b in img.get_flattened_data() if r >= 230 and g >= 230 and b >= 230)
print(near_white)
`;
    const pyCmd = new Deno.Command("python3", {
      args: ["-c", pyScript, pngPath],
      stdout: "piped",
      stderr: "piped",
    });
    const pyOut = await pyCmd.output();
    assert(pyOut.success, "python3 script failed to count pixels");
    const countStr = new TextDecoder().decode(pyOut.stdout).trim();
    return parseInt(countStr, 10);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

Deno.test("rendered Chrome check at 1600x1000 has zero near-white pixels", async () => {
  const now = new Date(2026, 9, 31);
  const svg = generateProgressSvg(MOCK_ENTRIES, MOCK_ACTIVITIES, now);
  const nearWhiteCount = await countNearWhitePixelsWithChrome(svg, 1600, 1000);
  assertEquals(nearWhiteCount, 0, "must have zero pixels with R, G, B all >= 230 at 1600x1000");
});

Deno.test("rendered Chrome check at 800x1400 has zero near-white pixels", async () => {
  const now = new Date(2026, 9, 31);
  const svg = generateProgressSvg(MOCK_ENTRIES, MOCK_ACTIVITIES, now);
  const nearWhiteCount = await countNearWhitePixelsWithChrome(svg, 800, 1400);
  assertEquals(nearWhiteCount, 0, "must have zero pixels with R, G, B all >= 230 at 800x1400");
});
