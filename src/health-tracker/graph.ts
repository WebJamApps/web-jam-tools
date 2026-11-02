// src/health-tracker/graph.ts
// Pure SVG progress graph generator with strict dark mode and no white (web-jam-tools#1660).

import type { HealthTrackerEntry } from "./storage.ts";

export interface WeightPoint {
  date: string;
  dateObj: Date;
  weight: number;
}

export interface WeeklyMinutes {
  weekStart: Date;
  label: string;
  minutes: number;
}

export function parseEntryDate(dateStr: string): Date | null {
  if (typeof dateStr !== "string") return null;
  const match = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const y = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const d = parseInt(match[3], 10);
  return new Date(y, m - 1, d, 12, 0, 0);
}

/**
 * Extracts and sorts weight history from tracker entries.
 */
export function extractWeightHistory(entries: HealthTrackerEntry[]): WeightPoint[] {
  const points: WeightPoint[] = [];
  for (const entry of entries) {
    if (typeof entry.weight !== "number" || isNaN(entry.weight)) {
      continue;
    }
    const d = parseEntryDate(entry.date);
    if (!d) continue;
    points.push({
      date: entry.date,
      dateObj: d,
      weight: entry.weight,
    });
  }
  points.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
  return points;
}

/**
 * Computes 8 weekly minute totals ending at the current week.
 * Only activities whose unit is "minutes" in the activities map are included.
 * Nested activity shapes like `{"time": 45}` count their `time`.
 */
export function computeWeeklyMinutes(
  entries: HealthTrackerEntry[],
  activities: Record<string, string>,
  now: Date = new Date(),
): WeeklyMinutes[] {
  // Normalize activities map to lower-case keys
  const minuteActivities = new Set<string>();
  for (const [key, unit] of Object.entries(activities)) {
    if (typeof unit === "string" && unit.toLowerCase() === "minutes") {
      minuteActivities.add(key.toLowerCase());
    }
  }

  // Find start of current week (Sunday)
  const currentWeekStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - now.getDay(),
    0,
    0,
    0,
    0,
  );

  const weeks: WeeklyMinutes[] = [];
  // 8 weeks: week 0 is 7 weeks ago, week 7 is current week
  for (let i = 7; i >= 0; i--) {
    const wStart = new Date(
      currentWeekStart.getFullYear(),
      currentWeekStart.getMonth(),
      currentWeekStart.getDate() - i * 7,
      0,
      0,
      0,
      0,
    );
    const label = `${wStart.getMonth() + 1}/${wStart.getDate()}`;
    weeks.push({
      weekStart: wStart,
      label,
      minutes: 0,
    });
  }

  for (const entry of entries) {
    if (!entry.exercise || typeof entry.exercise !== "object") {
      continue;
    }
    const d = parseEntryDate(entry.date);
    if (!d) continue;

    // Check if this entry falls within any of our 8 weeks
    for (let w = 0; w < weeks.length; w++) {
      const wStart = weeks[w].weekStart;
      const start = wStart.getTime();
      const end = new Date(
        wStart.getFullYear(),
        wStart.getMonth(),
        wStart.getDate() + 7,
        0,
        0,
        0,
        0,
      ).getTime();
      const t = d.getTime();
      if (t >= start && t < end) {
        // Sum matching minutes
        for (const [actName, val] of Object.entries(entry.exercise)) {
          if (!minuteActivities.has(actName.toLowerCase())) {
            continue;
          }
          if (typeof val === "number" && !isNaN(val) && val > 0) {
            weeks[w].minutes += val;
          } else if (
            val !== null &&
            typeof val === "object" &&
            typeof (val as { time?: unknown }).time === "number"
          ) {
            const timeNum = (val as { time: number }).time;
            if (!isNaN(timeNum) && timeNum > 0) {
              weeks[w].minutes += timeNum;
            }
          }
        }
        break;
      }
    }
  }

  return weeks;
}

/**
 * Validates that the SVG contains no white color literals.
 */
export function assertSvgHasNoWhite(svg: string): void {
  const forbiddenPatterns = [
    /\bwhite\b/i,
    /#fff\b/i,
    /#ffffff\b/i,
    /rgb\s*\(\s*255/i,
  ];
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(svg)) {
      throw new Error(`SVG contains forbidden white color pattern: ${pattern}`);
    }
  }
}

/**
 * Generates the dark-mode SVG progress graph.
 * Root element fills window:
 * `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 900 420" preserveAspectRatio="xMidYMid meet" style="background:#111418">`
 */
export function generateProgressSvg(
  entries: HealthTrackerEntry[],
  activities: Record<string, string>,
  now: Date = new Date(),
): string {
  const weights = extractWeightHistory(entries);
  const weekly = computeWeeklyMinutes(entries, activities, now);

  const lines: string[] = [];
  lines.push(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 900 420" preserveAspectRatio="xMidYMid meet" style="background:#111418">',
  );

  // Styling
  lines.push("  <style>");
  lines.push(
    '    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }',
  );
  lines.push("  </style>");

  // Separator between charts
  lines.push('  <line x1="450" y1="30" x2="450" y2="390" stroke="#1f2937" stroke-width="1" />');

  // ==========================================
  // CHART 1: Weight History (Left Panel)
  // ==========================================
  lines.push("  <!-- Weight History Chart -->");
  lines.push(
    '  <text x="50" y="50" fill="#94a3b8" font-size="16" font-weight="600">Weight History</text>',
  );

  if (weights.length === 0) {
    lines.push(
      '  <text x="50" y="80" fill="#64748b" font-size="13">No weight entries recorded</text>',
    );
  } else {
    const firstW = weights[0].weight;
    const latestW = weights[weights.length - 1].weight;
    const diff = latestW - firstW;
    const diffStr = (diff >= 0 ? "+" : "") + diff.toFixed(1);

    lines.push(
      `  <text x="50" y="75" fill="#cbd5e1" font-size="13">First: ${firstW.toFixed(1)}   Latest: ${
        latestW.toFixed(1)
      }   Change: ${diffStr}</text>`,
    );

    const plotLeft = 60;
    const plotRight = 410;
    const plotTop = 110;
    const plotBottom = 350;
    const plotWidth = plotRight - plotLeft;
    const plotHeight = plotBottom - plotTop;

    let minW = Math.min(...weights.map((w) => w.weight));
    let maxW = Math.max(...weights.map((w) => w.weight));
    if (minW === maxW) {
      minW -= 5;
      maxW += 5;
    } else {
      const pad = (maxW - minW) * 0.15;
      minW -= pad;
      maxW += pad;
    }

    // Grid lines and labels (min, mid, max)
    const midW = (minW + maxW) / 2;
    const gridY = [
      { val: maxW, y: plotTop },
      { val: midW, y: plotTop + plotHeight / 2 },
      { val: minW, y: plotBottom },
    ];

    for (const g of gridY) {
      lines.push(
        `  <line x1="${plotLeft}" y1="${g.y}" x2="${plotRight}" y2="${g.y}" stroke="#1e293b" stroke-width="1" stroke-dasharray="3,3" />`,
      );
      lines.push(
        `  <text x="${plotLeft - 8}" y="${
          g.y + 4
        }" fill="#64748b" font-size="11" text-anchor="end">${g.val.toFixed(1)}</text>`,
      );
    }

    // Axes
    lines.push(
      `  <line x1="${plotLeft}" y1="${plotTop}" x2="${plotLeft}" y2="${plotBottom}" stroke="#334155" stroke-width="1" />`,
    );
    lines.push(
      `  <line x1="${plotLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" stroke="#334155" stroke-width="1" />`,
    );

    if (weights.length === 1) {
      // Single reading shows as a dot
      const cx = (plotLeft + plotRight) / 2;
      const cy = (plotTop + plotBottom) / 2;
      lines.push(`  <circle cx="${cx}" cy="${cy}" r="6" fill="#38bdf8" />`);
      lines.push(
        `  <text x="${cx}" y="${
          plotBottom + 20
        }" fill="#64748b" font-size="11" text-anchor="middle">${weights[0].date}</text>`,
      );
    } else {
      const coords = weights.map((pt, idx) => {
        const x = plotLeft + (idx / (weights.length - 1)) * plotWidth;
        const yNorm = (pt.weight - minW) / (maxW - minW);
        const y = plotBottom - yNorm * plotHeight;
        return { x, y, pt };
      });

      // Path
      const pathD = coords
        .map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
        .join(" ");
      lines.push(
        `  <path d="${pathD}" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`,
      );

      // Dots on each point
      for (const c of coords) {
        lines.push(
          `  <circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3" fill="#38bdf8" />`,
        );
      }

      // First and latest date labels on x-axis
      lines.push(
        `  <text x="${plotLeft}" y="${
          plotBottom + 20
        }" fill="#64748b" font-size="11" text-anchor="start">${weights[0].date}</text>`,
      );
      lines.push(
        `  <text x="${plotRight}" y="${
          plotBottom + 20
        }" fill="#64748b" font-size="11" text-anchor="end">${
          weights[weights.length - 1].date
        }</text>`,
      );
    }
  }

  // ==========================================
  // CHART 2: Weekly Exercise (Right Panel)
  // ==========================================
  lines.push("  <!-- Weekly Exercise Chart -->");
  lines.push(
    '  <text x="490" y="50" fill="#94a3b8" font-size="16" font-weight="600">Weekly Exercise</text>',
  );
  lines.push(
    '  <text x="490" y="75" fill="#64748b" font-size="13">Last 8 weeks (minutes)</text>',
  );

  const barPlotLeft = 500;
  const barPlotRight = 860;
  const barPlotTop = 110;
  const barPlotBottom = 350;
  const barPlotWidth = barPlotRight - barPlotLeft;
  const barPlotHeight = barPlotBottom - barPlotTop;

  let maxMinutes = Math.max(...weekly.map((w) => w.minutes));
  if (maxMinutes <= 0) {
    maxMinutes = 60;
  }

  // Grid lines (0, 50%, 100%)
  const barGrid = [
    { val: maxMinutes, y: barPlotTop },
    { val: Math.round(maxMinutes / 2), y: barPlotTop + barPlotHeight / 2 },
    { val: 0, y: barPlotBottom },
  ];

  for (const g of barGrid) {
    lines.push(
      `  <line x1="${barPlotLeft}" y1="${g.y}" x2="${barPlotRight}" y2="${g.y}" stroke="#1e293b" stroke-width="1" stroke-dasharray="3,3" />`,
    );
    lines.push(
      `  <text x="${barPlotLeft - 8}" y="${
        g.y + 4
      }" fill="#64748b" font-size="11" text-anchor="end">${g.val}</text>`,
    );
  }

  // Axes
  lines.push(
    `  <line x1="${barPlotLeft}" y1="${barPlotTop}" x2="${barPlotLeft}" y2="${barPlotBottom}" stroke="#334155" stroke-width="1" />`,
  );
  lines.push(
    `  <line x1="${barPlotLeft}" y1="${barPlotBottom}" x2="${barPlotRight}" y2="${barPlotBottom}" stroke="#334155" stroke-width="1" />`,
  );

  // 8 weekly bars
  const slotWidth = barPlotWidth / 8;
  const barWidth = 26;

  for (let i = 0; i < weekly.length; i++) {
    const item = weekly[i];
    const slotX = barPlotLeft + i * slotWidth;
    const barX = slotX + (slotWidth - barWidth) / 2;
    const barH = (item.minutes / maxMinutes) * barPlotHeight;
    const barY = barPlotBottom - barH;

    if (item.minutes > 0) {
      lines.push(
        `  <rect x="${barX.toFixed(1)}" y="${barY.toFixed(1)}" width="${barWidth}" height="${
          barH.toFixed(1)
        }" rx="3" fill="#34d399" />`,
      );
      lines.push(
        `  <text x="${(barX + barWidth / 2).toFixed(1)}" y="${
          (barY - 5).toFixed(1)
        }" fill="#cbd5e1" font-size="11" text-anchor="middle">${item.minutes}</text>`,
      );
    }

    // Week date label
    lines.push(
      `  <text x="${(barX + barWidth / 2).toFixed(1)}" y="${
        barPlotBottom + 20
      }" fill="#64748b" font-size="11" text-anchor="middle">${item.label}</text>`,
    );
  }

  lines.push("</svg>");
  const svg = lines.join("\n");

  // Verify no white color literals
  assertSvgHasNoWhite(svg);

  return svg;
}
