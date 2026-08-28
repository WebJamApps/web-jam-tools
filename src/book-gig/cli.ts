import * as path from "@std/path";
import { matchesVenueFilter, parseBookGigArgs } from "./parser.ts";
import { assessDensity, fetchCandidates, filterAndRankCandidates } from "./candidates.ts";
import { renderPitch } from "./pitch.ts";
import { writeDropboxRunLog } from "./gmail.ts";
import { openHtmlInBrowser } from "./browser.ts";
import {
  checkGmailReplies,
  dispatchBatchOutreach,
  fetchOutreachCampaigns,
  fetchPendingReplies,
  fetchVenueMap,
} from "./outreach_api.ts";
import type {
  BatchDispatchResult,
  BookGigResult,
  OutreachCampaignRecord,
  PitchEmail,
} from "./types.ts";

function printCampaignsTable(campaigns: OutreachCampaignRecord[]): void {
  if (campaigns.length === 0) {
    console.log("  (No active outreach campaigns found)");
    return;
  }

  console.log(
    `┌─────┬──────────────────────────────┬──────────────────────┬────────────────┬────────────┬──────────────────────────────────────┐`,
  );
  console.log(
    `│ #   │ Venue Name                   │ Location             │ Status         │ Sent Date  │ Last Response Snippet                │`,
  );
  console.log(
    `├─────┼──────────────────────────────┼──────────────────────┼────────────────┼────────────┼──────────────────────────────────────┤`,
  );

  campaigns.forEach((c, idx) => {
    const num = String(idx + 1).padEnd(3);
    const name = (c.venueName || c.venueId || "(unknown)").slice(0, 28).padEnd(28);
    const loc = (c.location || "—").slice(0, 20).padEnd(20);
    const status = (c.replyKind === "bounce" ? "bounced" : c.status || "sent").slice(0, 14).padEnd(
      14,
    );
    const sentDate = (
      c.sentAt ? new Date(c.sentAt).toISOString().slice(0, 10) : "—"
    ).slice(0, 10).padEnd(10);
    const snippet = (c.replySnippet || (c.suggestion?.notes ?? "—")).replace(/\r?\n/g, " ").slice(
      0,
      36,
    ).padEnd(36);

    console.log(`│ ${num} │ ${name} │ ${loc} │ ${status} │ ${sentDate} │ ${snippet} │`);
  });

  console.log(
    `└─────┴──────────────────────────────┴──────────────────────┴────────────────┴────────────┴──────────────────────────────────────┘`,
  );
}

export async function runBookGigCli(
  args: string[],
  fetchFn: typeof fetch = fetch,
  openBrowserImpl?: (htmlPath: string) => Promise<boolean>,
): Promise<BookGigResult> {
  const parsed = parseBookGigArgs(args);

  // -------------------------------------------------------------------------
  // Mode: Replies & Response Tracking (--replies / --check-replies)
  // -------------------------------------------------------------------------
  if (parsed.mode === "replies") {
    console.log(`\n======================================================`);
    console.log(`  📬 book-gig: Outreach Response & Reply Tracking`);
    console.log(`======================================================`);
    if (parsed.weekend) {
      console.log(
        `Target Weekend Filter: ${parsed.weekend.label} (${parsed.weekend.start} to ${parsed.weekend.end})`,
      );
    } else {
      console.log(`Scope: All Active Campaigns`);
    }
    console.log(`------------------------------------------------------\n`);

    // 1. Scan Gmail for incoming replies
    console.log(`Scanning Gmail inbox for incoming replies to active pitches...`);
    const checkReplies = await checkGmailReplies({}, fetchFn);
    console.log(
      `Reply Scan Completed: ${checkReplies.checked} checked, ${checkReplies.matched} matched (${checkReplies.classified} classified, ${checkReplies.bounced} bounced).`,
    );

    // 2. Fetch pending replies & active campaigns
    console.log(`Fetching live outreach records and venue metadata...`);
    const [pendingReplies, rawCampaigns, venueMap] = await Promise.all([
      fetchPendingReplies({}, fetchFn),
      fetchOutreachCampaigns({}, fetchFn),
      fetchVenueMap({}, fetchFn),
    ]);

    // 3. Enrich campaigns with venue names and locations
    const enrichRecord = (r: OutreachCampaignRecord): OutreachCampaignRecord => {
      const v = venueMap.get(String(r.venueId));
      return {
        ...r,
        venueName: v?.name || r.venueName || "(unknown venue)",
        location: [v?.city, v?.usState].filter(Boolean).join(", ") || r.location || "—",
      };
    };

    let campaigns = rawCampaigns.map(enrichRecord);
    const enrichedPending = pendingReplies.map(enrichRecord);

    // Filter by target weekend if specified
    if (parsed.weekend) {
      const wStart = new Date(parsed.weekend.start).getTime();
      const wEnd = new Date(parsed.weekend.end).getTime();

      campaigns = campaigns.filter((c) => {
        if (c.targetWeekend?.start && c.targetWeekend?.end) {
          const cStart = new Date(c.targetWeekend.start).getTime();
          const cEnd = new Date(c.targetWeekend.end).getTime();
          return cStart <= wEnd && cEnd >= wStart;
        }
        if (c.targetDates && parsed.weekend) {
          return c.targetDates.includes(parsed.weekend.start) ||
            c.targetDates.includes(parsed.weekend.label);
        }
        return true;
      });
    }

    // 4. Output campaigns table
    console.log(`\nLive Outreach Campaigns:`);
    printCampaignsTable(campaigns);

    // 5. Output pending reply reviews if any
    if (enrichedPending.length > 0) {
      console.log(`\n⚠️  Pending Reply Reviews & AI Suggestions (${enrichedPending.length}):`);
      for (const p of enrichedPending) {
        const snippetText = p.replySnippet
          ? `"${p.replySnippet.replace(/\r?\n/g, " ").slice(0, 80)}"`
          : "—";
        console.log(`  • ${p.venueName} [${p.status}]: ${snippetText}`);
        if (p.suggestion) {
          const conf = p.suggestion.confidence !== undefined
            ? ` (Confidence: ${Math.round(p.suggestion.confidence * 100)}%)`
            : "";
          console.log(
            `    👉 Suggestion: ${p.suggestion.action || "Review"} [Intent: ${
              p.suggestion.intent || "General"
            }]${conf}`,
          );
        }
      }
    }

    const result: BookGigResult = {
      mode: "replies",
      weekend: parsed.weekend,
      location: parsed.location,
      candidates: [],
      density: { count: 0, isSparse: false },
      pitches: [],
      repliesTracking: {
        checkReplies,
        pendingReplies: enrichedPending,
        campaigns,
        targetWeekend: parsed.weekend,
      },
    };

    // 6. Write tracking log & Dark HTML artifact
    const logPath = await writeDropboxRunLog(result);
    if (logPath) {
      console.log(`\n📝 Saved status run log to: ${logPath}`);
      const htmlPath = logPath.replace(/\.md$/, ".html");
      const absHtmlPath = path.resolve(htmlPath);
      console.log(
        `🌐 Live Review HTML Artifact: [${path.basename(htmlPath)}](file://${absHtmlPath})`,
      );
      console.log(`🌐 File URL: file://${absHtmlPath}`);
      result.htmlPath = htmlPath;

      if (!parsed.noOpen) {
        const opener = openBrowserImpl || openHtmlInBrowser;
        const opened = await opener(htmlPath);
        result.openedBrowser = opened;
        if (opened) {
          console.log(`🚀 Automatically opened live campaign artifact in Google Chrome.`);
        }
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Discovery & Batch Send Modes
  // -------------------------------------------------------------------------
  if (!parsed.weekend) {
    console.error(
      "Usage: deno task book-gig [--send|--replies] <target-weekend> [location] [--venues <ids>] [--skip <ids>]",
    );
    console.error("Examples:");
    console.error('  deno task book-gig "Oct 16-18 2026" "Lynchburg, VA"');
    console.error('  deno task book-gig --send "Oct 16-18 2026" "Lynchburg, VA"');
    console.error('  deno task book-gig --send "Oct 16-18 2026" "Lynchburg, VA" --venues "v1,v2"');
    console.error('  deno task book-gig --send "Oct 16-18 2026" "Lynchburg, VA" --skip "v3"');
    console.error('  deno task book-gig --replies "Oct 16-18 2026"');
    console.error("  deno task book-gig --replies");
    throw new Error("Missing target weekend argument");
  }

  const weekend = parsed.weekend;
  const location = parsed.location;
  const isSendMode = parsed.mode === "send";

  console.log(`\n======================================================`);
  if (isSendMode) {
    console.log(`  🚀 book-gig: Batch Outreach Dispatch`);
  } else {
    console.log(`  🎵 book-gig: Target Outreach Discovery`);
  }
  console.log(`======================================================`);
  console.log(`Target Weekend:  ${weekend.label} (${weekend.start} to ${weekend.end})`);
  console.log(`Target Location: ${location ? location.raw : "All Regional Metros (~3.5h drive)"}`);
  console.log(`------------------------------------------------------\n`);

  // 1. Fetch eligible candidates from web-jam-back
  console.log(`Fetching candidate venues from backend...`);
  const rawCandidates = await fetchCandidates({ weekend }, fetchFn);
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

  let batchDispatch: BatchDispatchResult | undefined;

  // 6. If in --send mode, dispatch batch outreach via POST /outreach/batch
  if (isSendMode) {
    let eligibleVenues = candidates.filter((c) => c._id && c.email);

    if (parsed.includeVenues && parsed.includeVenues.length > 0) {
      console.log(
        `Filtering candidate dispatch to approved venues: ${parsed.includeVenues.join(", ")}`,
      );
      eligibleVenues = eligibleVenues.filter((c) => matchesVenueFilter(c, parsed.includeVenues!));
    }
    if (parsed.excludeVenues && parsed.excludeVenues.length > 0) {
      console.log(
        `Excluding skipped venues from dispatch: ${parsed.excludeVenues.join(", ")}`,
      );
      eligibleVenues = eligibleVenues.filter((c) => !matchesVenueFilter(c, parsed.excludeVenues!));
    }

    const venueIds = eligibleVenues.map((c) => c._id);

    if (venueIds.length === 0) {
      console.log(
        `\n⚠️  No eligible venues with valid emails found to dispatch matching filter criteria.`,
      );
      batchDispatch = { requested: 0, sent: 0, skipped: [], records: [] };
    } else {
      console.log(`\nDispatching batch outreach to ${venueIds.length} candidate venue(s)...`);
      try {
        batchDispatch = await dispatchBatchOutreach(
          {
            weekend,
            venueIds,
          },
          fetchFn,
        );

        console.log(`\n📤 Batch Outreach Dispatch Summary:`);
        console.log(`  • Requested: ${batchDispatch.requested}`);
        console.log(`  • Successfully Dispatched: ${batchDispatch.sent}`);
        console.log(`  • Skipped: ${batchDispatch.skipped.length}`);

        if (batchDispatch.skipped.length > 0) {
          for (const s of batchDispatch.skipped) {
            console.log(`    - ${s.venueName}: ${s.reason}`);
          }
        }

        console.log(
          `\n✅ Email touches recorded on venue timelines and active campaigns created in MongoDB.`,
        );
        console.log(
          `📧 Each pitch CC'd Josh & Maria (joshua.v.sherman@gmail.com, chemmariasherman@gmail.com).`,
        );
      } catch (err) {
        console.error(`❌ Batch dispatch failed: ${(err as Error).message}`);
        throw err;
      }
    }
  }

  const result: BookGigResult = {
    mode: parsed.mode,
    weekend,
    location,
    includeVenues: parsed.includeVenues,
    excludeVenues: parsed.excludeVenues,
    candidates,
    density,
    pitches,
    batchDispatch,
  };

  // 7. Write run log to Dropbox (Markdown + Responsive Dark Mode HTML)
  const logPath = await writeDropboxRunLog(result);
  if (logPath) {
    console.log(`📝 Saved run summary log to: ${logPath}`);
    const htmlPath = logPath.replace(/\.md$/, ".html");
    const absHtmlPath = path.resolve(htmlPath);
    console.log(
      `🌐 Live Review HTML Artifact: [${path.basename(htmlPath)}](file://${absHtmlPath})`,
    );
    console.log(`🌐 File URL: file://${absHtmlPath}`);
    result.htmlPath = htmlPath;

    if (!parsed.noOpen) {
      const opener = openBrowserImpl || openHtmlInBrowser;
      const opened = await opener(htmlPath);
      result.openedBrowser = opened;
      if (opened) {
        console.log(`🚀 Automatically opened review artifact in Google Chrome.`);
      }
    }
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
