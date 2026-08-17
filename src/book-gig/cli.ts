// src/book-gig/cli.ts — CLI entry point for /book-gig skill

import { parseBookGigArgs } from "./parser.ts";
import { assessDensity, fetchCandidates, filterAndRankCandidates } from "./candidates.ts";
import { renderPitch } from "./pitch.ts";
import { writeDropboxRunLog } from "./gmail.ts";
import type { BookGigResult, PitchEmail } from "./types.ts";

export async function runBookGigCli(args: string[]): Promise<BookGigResult> {
  const parsed = parseBookGigArgs(args);

  if (!parsed.weekend) {
    console.error("Usage: deno task book-gig <target-weekend> [location]");
    console.error("Examples:");
    console.error('  deno task book-gig "Oct 16-18 2026" "Lynchburg, VA"');
    console.error('  deno task book-gig "2026-10-16" "24502"');
    console.error('  deno task book-gig "Oct 16-18 2026"');
    throw new Error("Missing target weekend argument");
  }

  const weekend = parsed.weekend;
  const location = parsed.location;

  console.log(`\n======================================================`);
  console.log(`  🎵 book-gig: Target Outreach Discovery`);
  console.log(`======================================================`);
  console.log(`Target Weekend:  ${weekend.label} (${weekend.start} to ${weekend.end})`);
  console.log(`Target Location: ${location ? location.raw : "All Regional Metros (~3.5h drive)"}`);
  console.log(`------------------------------------------------------\n`);

  // 1. Fetch eligible candidates from web-jam-back
  console.log(`Fetching candidate venues from backend...`);
  const rawCandidates = await fetchCandidates({ weekend });
  console.log(`Backend returned ${rawCandidates.length} eligible venue candidate(s).`);

  // 2. Filter & rank by location
  const candidates = filterAndRankCandidates(rawCandidates, location);
  const density = assessDensity(candidates, location);

  // 3. Output candidate table
  console.log(`\nCandidate Venues for ${weekend.label}:`);
  if (candidates.length === 0) {
    console.log(`  (No eligible venues found matching criteria)`);
  } else {
    console.log(
      `┌─────┬──────────────────────────────┬──────────────────────┬──────────────────────────────┬─────────────────────────┐`,
    );
    console.log(
      `│ #   │ Venue Name                   │ Location             │ Email                        │ Spacing Note            │`,
    );
    console.log(
      `├─────┼──────────────────────────────┼──────────────────────┼──────────────────────────────┼─────────────────────────┤`,
    );
    candidates.forEach((c, idx) => {
      const num = String(idx + 1).padEnd(3);
      const name = c.name.slice(0, 28).padEnd(28);
      const loc = `${c.city || ""}, ${c.usState || ""}`.slice(0, 20).padEnd(20);
      const email = (c.email || "—").slice(0, 28).padEnd(28);
      const note = (c.reason?.spacingNote || "Eligible").slice(0, 23).padEnd(23);
      console.log(`│ ${num} │ ${name} │ ${loc} │ ${email} │ ${note} │`);
    });
    console.log(
      `└─────┴──────────────────────────────┴──────────────────────┴──────────────────────────────┴─────────────────────────┘`,
    );
  }

  // 4. Check density and offer venue-mining recommendation
  if (density.isSparse) {
    console.log(`\n⚠️  Low candidate density (${density.count} venue(s) found).`);
    if (density.suggestedMetro) {
      console.log(
        `👉 Recommendation: Run \`/venue-mining metro ${density.suggestedMetro}\` to discover net-new venues for this region!`,
      );
    }
  }

  // 5. Render pitches for candidates with valid email
  const pitches: PitchEmail[] = [];
  for (const c of candidates) {
    if (c.email) {
      try {
        const pitch = renderPitch(c, weekend);
        pitches.push(pitch);
      } catch (err) {
        console.warn(`[book-gig] Warning: Skipping pitch for ${c.name}: ${(err as Error).message}`);
      }
    }
  }

  console.log(`\nDrafted ${pitches.length} personalized pitch email(s) adhering to voice rules.`);

  const result: BookGigResult = {
    weekend,
    location,
    candidates,
    density,
    pitches,
  };

  // 6. Write run log to Dropbox (Markdown + Responsive Dark Mode HTML)
  const logPath = await writeDropboxRunLog(result);
  if (logPath) {
    console.log(`📝 Saved run summary log to: ${logPath}`);
    const htmlPath = logPath.replace(/\.md$/, ".html");
    console.log(`🌐 Saved Dark Mode HTML review artifact to: ${htmlPath}`);
  }

  return result;
}

if (import.meta.main) {
  try {
    await runBookGigCli(Deno.args);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    Deno.exit(1);
  }
}
