import * as path from "@std/path";
import { matchesVenueFilter, parseBookGigArgs } from "./parser.ts";
import {
  assessDensity,
  fetchCandidates,
  filterAndRankCandidates,
  renderCandidateTable,
} from "./candidates.ts";
export { renderCandidateTable };
import { renderPitchesFromBackend, verifyBatchAgainstTemplates } from "./pitch.ts";
import { publishAndOpenReport } from "./publish.ts";
import { executeLinkGig } from "./venue_link.ts";
import { executeVenueHold } from "./cooldown.ts";
import { Gate2ReviewSession, isExplicitWholeBatchApproval } from "./gate2.ts";
import {
  checkGmailReplies,
  dispatchBatchOutreach,
  fetchOutreachCampaigns,
  fetchPendingReplies,
  fetchTemplates,
  fetchVenueMap,
  recordGate1Approval,
} from "./outreach_api.ts";
import type { Gate1RevisionOutcome } from "./outreach_api.ts";
import type {
  BatchDispatchResult,
  BookGigResult,
  OutreachCampaignRecord,
  TargetLocation,
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

export function formatLocationDisplay(location?: TargetLocation): string {
  if (!location) return "All Regional Metros (~3.5h drive)";
  if (location.cities && location.cities.length > 1) {
    const list = location.cities.join(", ");
    return location.includeSurrounding ? `${list} (and surrounding regional areas)` : list;
  }
  if (location.city && location.includeSurrounding) {
    return `${location.city}${
      location.state ? `, ${location.state}` : ""
    } (and surrounding regional areas)`;
  }
  if (location.city && location.state) {
    return `${location.city}, ${location.state}`;
  }
  return location.raw;
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

    // 6. Publish the merged report to web-jam-back (the sole durable copy) and open the
    // disposable scratch HTML in Chrome for immediate review.
    const published = await publishAndOpenReport(
      result,
      { noOpen: parsed.noOpen, openBrowser: openBrowserImpl },
      fetchFn,
    );
    const finalResult = published.result;
    if (finalResult.reportUrl) {
      console.log(`\n🌐 Live web-jam.com Report URL: ${finalResult.reportUrl}`);
    }
    if (published.htmlPath) {
      const absHtmlPath = path.resolve(published.htmlPath);
      console.log(
        `📁 Local Review HTML Artifact: [${
          path.basename(published.htmlPath)
        }](file://${absHtmlPath})`,
      );
      console.log(`📁 File URL: file://${absHtmlPath}`);
      if (published.opened) {
        console.log(`🚀 Automatically opened live campaign artifact in Google Chrome.`);
      }
    }

    return finalResult;
  }

  // -------------------------------------------------------------------------
  // Mode: Link Gig to Venue (--link-gig <venue-name>)
  // -------------------------------------------------------------------------
  if (parsed.mode === "link-gig") {
    console.log(`\n======================================================`);
    console.log(`  🔗 book-gig: Link Gig to Venue`);
    console.log(`======================================================`);
    const venueName = parsed.linkVenueName;
    if (!venueName) {
      console.error("Error: Missing required venue name for --link-gig.");
      console.error("Usage: deno task book-gig --link-gig <venue-name>");
      throw new Error("Missing venue name for --link-gig");
    }
    console.log(`Target Venue: "${venueName}"`);
    console.log(`------------------------------------------------------\n`);

    const linkResult = await executeLinkGig(venueName, {}, fetchFn);
    console.log(`[book-gig] ${linkResult.message}`);

    return {
      mode: "link-gig",
      linkGig: linkResult,
      candidates: [],
      density: { count: 0, isSparse: false },
      pitches: [],
    };
  }

  // -------------------------------------------------------------------------
  // Mode: Seasonal Cooldown Hold & Availability Dates
  // -------------------------------------------------------------------------
  if (parsed.mode === "hold") {
    console.log(`\n======================================================`);
    console.log(`  🛑 book-gig: Venue Hold & Availability Configuration`);
    console.log(`======================================================`);
    const venueQuery = parsed.holdVenue;
    if (!venueQuery) {
      console.error("Error: Missing required venue identifier for --hold.");
      console.error(
        'Usage: deno task book-gig --hold "<venueId|venueName>" --until <YYYY-MM-DD> [--booked-through <YYYY-MM-DD>]',
      );
      console.error(
        '       deno task book-gig --venue "<venueId|venueName>" --booked-through <YYYY-MM-DD>',
      );
      throw new Error("Missing venue identifier for --hold");
    }
    const untilDate = parsed.holdUntil;
    const bookedThrough = parsed.bookedThrough;
    if (!untilDate && !bookedThrough) {
      console.error("Error: Missing required date for --hold.");
      console.error(
        "Specify --until <YYYY-MM-DD> (for resumeBooking) and/or --booked-through <YYYY-MM-DD> (for bookedThrough).",
      );
      throw new Error(
        "Missing resume date for --hold. Specify --until <YYYY-MM-DD> or --booked-through <YYYY-MM-DD>.",
      );
    }
    console.log(`Target Venue: "${venueQuery}"`);
    if (untilDate) {
      console.log(`Resume Date:  "${untilDate}" (resumeBooking)`);
    }
    if (bookedThrough) {
      console.log(`Booked Date:  "${bookedThrough}" (bookedThrough)`);
    }
    console.log(`------------------------------------------------------\n`);

    const holdResult = await executeVenueHold(
      venueQuery,
      { untilDate, bookedThroughDate: bookedThrough },
      {},
      fetchFn,
    );
    console.log(`[book-gig] Confirmed venue hold update for "${holdResult.venueName}":`);
    console.log(`  • Venue ID:         ${holdResult.venueId}`);
    if (holdResult.resumeBooking) {
      console.log(`  • resumeBooking:    ${holdResult.resumeBooking}`);
    }
    if (holdResult.bookedThrough) {
      console.log(`  • bookedThrough:    ${holdResult.bookedThrough}`);
    }
    if (holdResult.eligibleDate) {
      console.log(`  • Next Eligible:    ${holdResult.eligibleDate}`);
    }

    return {
      mode: "hold",
      holdResult,
      candidates: [],
      density: { count: 0, isSparse: false },
      pitches: [],
    };
  }

  // -------------------------------------------------------------------------
  // Mode: Record Gate 1 Venue-Set Approval (--record-gate1 / --gate1)
  // -------------------------------------------------------------------------
  if (parsed.mode === "gate1") {
    console.log(`\n======================================================`);
    console.log(`  🛡️ book-gig: Record Gate 1 Venue-Set Approval`);
    console.log(`======================================================`);
    if (!parsed.weekend) {
      console.error("Error: Missing required target weekend for Gate 1 approval.");
      console.error(
        'Usage: deno task book-gig --record-gate1 "<weekend>" [location] [--venues <ids>] [--skip <ids>] [--approver <name>] [--notes <notes>]',
      );
      throw new Error("Missing target weekend argument for Gate 1 approval");
    }

    const weekend = parsed.weekend;
    const location = parsed.location;
    const approver = parsed.approver || "Josh";

    console.log(`Target Weekend:  ${weekend.label} (${weekend.start} to ${weekend.end})`);
    console.log(`Target Location: ${formatLocationDisplay(location)}`);
    console.log(`Approver:        ${approver}`);
    console.log(`------------------------------------------------------\n`);

    // 1. Fetch eligible candidates from web-jam-back
    console.log(`Fetching candidate venues from backend...`);
    const rawCandidates = await fetchCandidates({ weekend }, fetchFn);
    const candidates = filterAndRankCandidates(rawCandidates, location);
    const density = assessDensity(candidates, location);

    // 2. Resolve approved venue IDs
    let eligibleVenues = candidates.filter((c) => c._id && c.email && !c.isExcluded);

    if (parsed.includeVenues && parsed.includeVenues.length > 0) {
      const unmatched = parsed.includeVenues.filter(
        (filterEntry) => !eligibleVenues.some((c) => matchesVenueFilter(c, [filterEntry])),
      );
      if (unmatched.length > 0) {
        console.error(
          `\n⚠️  No eligible candidate venues matched --venues filter: ${unmatched.join(", ")}`,
        );
        throw new Error(
          `No eligible candidate venues matched --venues filter: ${unmatched.join(", ")}`,
        );
      }
      eligibleVenues = eligibleVenues.filter((c) => matchesVenueFilter(c, parsed.includeVenues!));
    }

    if (parsed.excludeVenues && parsed.excludeVenues.length > 0) {
      eligibleVenues = eligibleVenues.filter((c) => !matchesVenueFilter(c, parsed.excludeVenues!));
    }

    const venueIds = eligibleVenues.map((c) => c._id);

    if (venueIds.length === 0) {
      console.error(`\n⚠️  No eligible candidate venues found to approve for ${weekend.label}.`);
      throw new Error("No eligible candidate venues found to approve for Gate 1");
    }

    console.log(`Recording Gate 1 approval for ${venueIds.length} candidate venue(s)...`);

    // D-54: how the requested set related to the stored one, so the operator-facing message
    // below reports a widening, an idempotent re-record, or a first recording rather than
    // describing every outcome as a fresh approval. A non-widening difference and an
    // undeterminable lookup both throw inside recordGate1Approval and never reach here.
    // Held in an object rather than a plain `let`: the callback fires inside
    // recordGate1Approval, which TypeScript's control-flow analysis cannot see, so a bare
    // local would stay narrowed to its initial literal type.
    const revision: { current: Gate1RevisionOutcome } = { current: "new" };

    const gate1Record = await recordGate1Approval(
      {
        batchId: parsed.batchId,
        weekend,
        venueIds,
        approver,
        notes: parsed.notes || `Gate 1 venue-set approval (${venueIds.length} venues approved)`,
        onRevision: (outcome) => {
          revision.current = outcome;
        },
      },
      fetchFn,
    );

    if (revision.current === "widening") {
      console.log(`\n✅ Gate 1 venue-set approval WIDENED and re-recorded successfully!`);
    } else if (revision.current === "identical") {
      console.log(
        `\n✅ Gate 1 venue-set approval re-recorded unchanged (idempotent — same venue set).`,
      );
    } else {
      console.log(`\n✅ Gate 1 venue-set approval recorded successfully!`);
    }
    console.log(`  • Batch ID:     ${gate1Record.batchId}`);
    if (gate1Record._id) {
      console.log(`  • Approval ID:  ${gate1Record._id}`);
    }
    console.log(`  • Approved At:  ${gate1Record.approvedAt || new Date().toISOString()}`);
    console.log(`  • Approver:     ${gate1Record.approver}`);
    console.log(`  • Venue Count:  ${venueIds.length}`);

    console.log(`\n🛑 IMPORTANT INVARIANT (D-39 / D-41):`);
    console.log(`   Gate 1 authorizes ONLY the target venue set and NOTHING else.`);
    console.log(`   It does NOT authorize pitch copy and does NOT authorize email dispatch.`);
    console.log(
      `   Next step: Review rendered draft emails in the Dark Mode HTML artifact (Gate 2).`,
    );
    console.log(
      `   Outreach dispatch (--send --confirm-drafts) may ONLY be invoked after explicit Gate 2 copy approval.\n`,
    );

    return {
      mode: "gate1",
      weekend,
      location,
      includeVenues: parsed.includeVenues,
      excludeVenues: parsed.excludeVenues,
      candidates,
      density,
      pitches: [],
      gate1Record,
    };
  }

  // -------------------------------------------------------------------------
  // Mode: Record Gate 2 Pitch Copy Approval & Review Loop (--record-gate2 / --gate2)
  // -------------------------------------------------------------------------
  if (parsed.mode === "gate2") {
    console.log(`\n======================================================`);
    console.log(`  🛡️ book-gig: Gate 2 Pitch Copy Review & Approval`);
    console.log(`======================================================`);
    if (!parsed.weekend) {
      console.error("Error: Missing required target weekend for Gate 2 review.");
      console.error(
        'Usage: deno task book-gig --record-gate2 "<weekend>" [location] [--confirm-all] [--tweak-venue <name> --custom-body <text>]',
      );
      throw new Error("Missing target weekend argument for Gate 2 review");
    }

    const weekend = parsed.weekend;
    const location = parsed.location;
    const approver = parsed.approver || "Josh";

    console.log(`Target Weekend:  ${weekend.label} (${weekend.start} to ${weekend.end})`);
    console.log(`Target Location: ${formatLocationDisplay(location)}`);
    console.log(`Approver:        ${approver}`);
    console.log(`------------------------------------------------------\n`);

    // 1. Fetch eligible candidates from web-jam-back
    console.log(`Fetching candidate venues from backend...`);
    const rawCandidates = await fetchCandidates({ weekend }, fetchFn);
    const candidates = filterAndRankCandidates(rawCandidates, location);
    const density = assessDensity(candidates, location);

    // 2. Resolve eligible venues
    let eligibleVenues = candidates.filter((c) => c._id && c.email && !c.isExcluded);

    if (parsed.includeVenues && parsed.includeVenues.length > 0) {
      const unmatched = parsed.includeVenues.filter(
        (filterEntry) => !eligibleVenues.some((c) => matchesVenueFilter(c, [filterEntry])),
      );
      if (unmatched.length > 0) {
        console.error(
          `\n⚠️  No eligible candidate venues matched --venues filter: ${unmatched.join(", ")}`,
        );
        throw new Error(
          `No eligible candidate venues matched --venues filter: ${unmatched.join(", ")}`,
        );
      }
      eligibleVenues = eligibleVenues.filter((c) => matchesVenueFilter(c, parsed.includeVenues!));
    }

    if (parsed.excludeVenues && parsed.excludeVenues.length > 0) {
      eligibleVenues = eligibleVenues.filter((c) => !matchesVenueFilter(c, parsed.excludeVenues!));
    }

    if (eligibleVenues.length === 0) {
      console.error(`\n⚠️  No eligible candidate venues found to review for ${weekend.label}.`);
      throw new Error("No eligible candidate venues found for Gate 2 review");
    }

    // 3. Render pitches via backend with any tweaks
    const pitches = await renderPitchesFromBackend(
      eligibleVenues,
      weekend,
      { tweaks: parsed.tweaks },
      fetchFn,
    );

    console.log(`Rendered ${pitches.length} pitch draft(s) via backend rendering.`);

    // 4. Verify templates
    const templates = await fetchTemplates({}, fetchFn);
    const templateVerification = verifyBatchAgainstTemplates(
      pitches,
      eligibleVenues,
      weekend,
      templates,
    );
    if (!templateVerification.valid) {
      const details = templateVerification.violations
        .map((v) => `  - ${v.venueName} (${v.venueId}): ${v.reason}`)
        .join("\n");
      throw new Error(
        `Batch refused: ${templateVerification.violations.length} rendered email(s) diverge from ` +
          `their stored Template record outside declared placeholders:\n${details}`,
      );
    }
    console.log(`✅ Every rendered email verified against its stored template — no divergence.`);

    // 5. Handle tweaks if present (D-44)
    const hasTweaks = Boolean(
      (parsed.tweakVenue && parsed.tweakVenue.trim()) ||
        (parsed.tweaks && parsed.tweaks.length > 0),
    );

    if (hasTweaks) {
      console.log(`\n✏️  Gate 2 Tweak Applied:`);
      for (const t of (parsed.tweaks || [])) {
        console.log(`  • Venue: "${t.venueName || t.venueId}"`);
        if (t.customBody) console.log(`    customBody: "${t.customBody.slice(0, 60)}..."`);
        if (t.customIntro) console.log(`    customIntro: "${t.customIntro.slice(0, 60)}..."`);
      }
      console.log(`\n🛑 GATE 2 IS HOLDING IN REVIEW LOOP (D-44, D-45):`);
      console.log(`   Per-venue tweak has been re-rendered into the review artifact.`);
      console.log(`   All other venues' draft copy remains strictly untouched.`);
      console.log(`   Draft fingerprints are NOT recorded server-side.`);
      console.log(
        `   Approval is NEVER inferred from tweak submissions, partial reviews, or silence.`,
      );
      console.log(
        `   Next step: Review updated drafts in Chrome. Submit further tweaks or explicitly approve all drafts.\n`,
      );

      const result: BookGigResult = {
        mode: "gate2",
        weekend,
        location,
        includeVenues: parsed.includeVenues,
        excludeVenues: parsed.excludeVenues,
        candidates,
        density,
        pitches,
        tweaksApplied: parsed.tweaks,
        gate2Status: "tweaked",
      };

      const published = await publishAndOpenReport(
        result,
        { noOpen: parsed.noOpen, openBrowser: openBrowserImpl },
        fetchFn,
      );
      const finalResult = published.result;
      if (finalResult.reportUrl) {
        console.log(`🌐 Live web-jam.com Report URL: ${finalResult.reportUrl}`);
      }
      if (published.htmlPath) {
        const absHtmlPath = path.resolve(published.htmlPath);
        console.log(
          `📁 Local Review HTML Artifact: [${
            path.basename(published.htmlPath)
          }](file://${absHtmlPath})`,
        );
        console.log(`📁 File URL: file://${absHtmlPath}`);
        if (published.opened) {
          console.log(`🚀 Automatically opened review artifact in Google Chrome.`);
        }
      }
      return finalResult;
    }

    // 6. Check explicit affirmative whole-batch approval (D-45).
    // Only --confirm-all and a deliberate --notes statement count. `rawArgs` carries the
    // weekend and location text, so reading approval out of it would let an incidental
    // word in a positional argument close Gate 2.
    const explicitApproval = Boolean(
      parsed.confirmAll || isExplicitWholeBatchApproval(parsed.notes),
    );

    if (!explicitApproval) {
      if (parsed.recordGate2) {
        console.error(
          "\n❌ Gate 2 approval forbidden: approval cannot be inferred from silence, partial reviews, " +
            "tweak submissions, or venue-list approval. Explicit affirmative whole-batch approval is required via --confirm-all or whole-batch approval statement.",
        );
        throw new Error(
          "Gate 2 approval forbidden: approval cannot be inferred from silence, partial reviews, " +
            "tweak submissions, or venue-list approval. Explicit affirmative whole-batch approval is required.",
        );
      }

      console.log(`\n🛑 GATE 2 IS HOLDING IN REVIEW LOOP (D-44, D-45):`);
      console.log(`   Every draft is written out in full in the review artifact.`);
      console.log(
        `   Approval is NOT recorded until explicit affirmative whole-batch approval is given.`,
      );
      console.log(
        `   Next step: Review drafts in Chrome. Request tweaks or run with --confirm-all to approve.\n`,
      );

      const result: BookGigResult = {
        mode: "gate2",
        weekend,
        location,
        includeVenues: parsed.includeVenues,
        excludeVenues: parsed.excludeVenues,
        candidates,
        density,
        pitches,
        gate2Status: "holding",
      };

      const published = await publishAndOpenReport(
        result,
        { noOpen: parsed.noOpen, openBrowser: openBrowserImpl },
        fetchFn,
      );
      const finalResult = published.result;
      if (finalResult.reportUrl) {
        console.log(`🌐 Live web-jam.com Report URL: ${finalResult.reportUrl}`);
      }
      if (published.htmlPath) {
        const absHtmlPath = path.resolve(published.htmlPath);
        console.log(
          `📁 Local Review HTML Artifact: [${
            path.basename(published.htmlPath)
          }](file://${absHtmlPath})`,
        );
        console.log(`📁 File URL: file://${absHtmlPath}`);
        if (published.opened) {
          console.log(`🚀 Automatically opened review artifact in Google Chrome.`);
        }
      }
      return finalResult;
    }

    // 7. Explicit whole-batch approval is confirmed — record fingerprints server-side
    console.log(`Explicit whole-batch approval confirmed. Computing draft fingerprints...`);
    const session = new Gate2ReviewSession({
      weekend,
      location,
      candidates: eligibleVenues,
      pitches,
      fetchFn,
    });

    const gate2Record = await session.approveWholeBatch({
      approver,
      notes: parsed.notes,
      batchId: parsed.batchId,
      explicitApproval: true,
    });

    console.log(`\n✅ Gate 2 draft copy approval recorded successfully!`);
    console.log(`  • Batch ID:            ${gate2Record.batchId}`);
    if (gate2Record._id) {
      console.log(`  • Approval ID:         ${gate2Record._id}`);
    }
    console.log(`  • Approved At:         ${gate2Record.approvedAt || new Date().toISOString()}`);
    console.log(`  • Approver:            ${gate2Record.approver}`);
    console.log(
      `  • Draft Fingerprints:  ${gate2Record.draftFingerprints.length} email draft(s) fingerprinted`,
    );

    console.log(`\n🛑 IMPORTANT INVARIANT (D-39 / D-41 / D-45):`);
    console.log(`   Gate 2 authorizes draft email copy and nothing else.`);
    console.log(`   Any subsequent tweak to copy or venue set invalidates these fingerprints.`);
    console.log(`   Batch outreach dispatch (--send --confirm-drafts) may now proceed.\n`);

    const result: BookGigResult = {
      mode: "gate2",
      weekend,
      location,
      includeVenues: parsed.includeVenues,
      excludeVenues: parsed.excludeVenues,
      candidates,
      density,
      pitches,
      gate2Record,
      gate2Status: "approved",
    };

    const published = await publishAndOpenReport(
      result,
      { noOpen: parsed.noOpen, openBrowser: openBrowserImpl },
      fetchFn,
    );
    const finalResult = published.result;
    if (finalResult.reportUrl) {
      console.log(`🌐 Live web-jam.com Report URL: ${finalResult.reportUrl}`);
    }
    if (published.htmlPath) {
      const absHtmlPath = path.resolve(published.htmlPath);
      console.log(
        `📁 Local Review HTML Artifact: [${
          path.basename(published.htmlPath)
        }](file://${absHtmlPath})`,
      );
      console.log(`📁 File URL: file://${absHtmlPath}`);
      if (published.opened) {
        console.log(`🚀 Automatically opened review artifact in Google Chrome.`);
      }
    }
    return finalResult;
  }

  // -------------------------------------------------------------------------
  // Discovery & Batch Send Modes
  // -------------------------------------------------------------------------
  if (!parsed.weekend) {
    console.error(
      "Usage: deno task book-gig [--send [--confirm-drafts]|--record-gate1|--record-gate2 [--confirm-all]|--replies|--link-gig <venue>|--hold <venue> --until <date>|--booked-through <date>] <target-weekend> [location] [--venues <ids>] [--skip <ids>]",
    );
    console.error("Examples:");
    console.error('  deno task book-gig "Oct 16-18 2026" "Lynchburg, VA"');
    console.error(
      '  deno task book-gig --record-gate1 "Oct 16-18 2026" "Lynchburg, VA" --venues "v1,v2"',
    );
    console.error('  deno task book-gig --record-gate1 "Oct 16-18 2026"');
    console.error(
      '  deno task book-gig --record-gate2 "Oct 16-18 2026" "Lynchburg, VA" --confirm-all',
    );
    console.error(
      '  deno task book-gig --record-gate2 "Oct 16-18 2026" --tweak-venue "Olde Salem" --custom-body "Hi folks..."',
    );
    console.error('  deno task book-gig --send "Oct 16-18 2026" "Lynchburg, VA" --confirm-drafts');
    console.error(
      '  deno task book-gig --send "Oct 16-18 2026" "Lynchburg, VA" --confirm-drafts --venues "v1,v2"',
    );
    console.error(
      '  deno task book-gig --send "Oct 16-18 2026" "Lynchburg, VA" --confirm-drafts --skip "v3"',
    );
    console.error('  deno task book-gig --replies "Oct 16-18 2026"');
    console.error("  deno task book-gig --replies");
    console.error('  deno task book-gig --link-gig "Olde Salem Brewing"');
    console.error('  deno task book-gig --hold "Tequila\'s" --until 2027-01-01');
    console.error('  deno task book-gig --venue "Olde Salem Brewing" --booked-through 2026-12-31');
    throw new Error("Missing target weekend argument");
  }

  const weekend = parsed.weekend;
  const location = parsed.location;
  const isSendMode = parsed.mode === "send";

  if (isSendMode && !parsed.confirmDrafts) {
    console.error(
      "Please review the rendered pitch drafts and Dark Mode HTML artifact first.",
    );
    console.error(
      'Usage: deno task book-gig --send "<weekend>" [location] --confirm-drafts [--venues <ids>]',
    );
    throw new Error(
      "Batch outreach dispatch requires explicit draft confirmation via --confirm-drafts.",
    );
  }

  console.log(`\n======================================================`);
  if (isSendMode) {
    console.log(`  🚀 book-gig: Batch Outreach Dispatch`);
  } else {
    console.log(`  🎵 book-gig: Target Outreach Discovery`);
  }
  console.log(`======================================================`);
  console.log(`Target Weekend:  ${weekend.label} (${weekend.start} to ${weekend.end})`);
  console.log(`Target Location: ${formatLocationDisplay(location)}`);
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
  console.log(renderCandidateTable(candidates));

  // 4. Check density and offer venue-mining recommendation
  if (density.isSparse) {
    console.log(`\n⚠️  Low candidate density (${density.count} venue(s) found).`);
    if (density.suggestedMetro) {
      console.log(
        `👉 Recommendation: Run \`/venue-mining metro ${density.suggestedMetro}\` to discover net-new venues for this region!`,
      );
    }
  }

  // 5. Render pitches for candidates with valid email using the backend's own
  // rendering (web-jam-tools#948) — the same `buildPitchEmail()` function that
  // composes what gets mailed, so the draft copy in the review artifact is
  // byte-identical to what is dispatched rather than a second, separately
  // implemented rendering that can drift from it.
  const pitches = await renderPitchesFromBackend(
    candidates,
    weekend,
    { tweaks: parsed.tweaks },
    fetchFn,
  );

  console.log(`\nDrafted ${pitches.length} personalized pitch email(s) via backend rendering.`);

  // 5b. Verify every rendered email against its stored template before Gate 2 artifact
  // emission or dispatch — a divergence outside declared placeholders refuses the batch (D-50).
  const templates = await fetchTemplates({}, fetchFn);
  const templateVerification = verifyBatchAgainstTemplates(pitches, candidates, weekend, templates);
  if (!templateVerification.valid) {
    const details = templateVerification.violations
      .map((v) => `  - ${v.venueName} (${v.venueId}): ${v.reason}`)
      .join("\n");
    throw new Error(
      `Batch refused: ${templateVerification.violations.length} rendered email(s) diverge from ` +
        `their stored Template record outside declared placeholders:\n${details}`,
    );
  }
  console.log(`✅ Every rendered email verified against its stored template — no divergence.`);
  let batchDispatch: BatchDispatchResult | undefined;

  // 6. If in --send mode, dispatch batch outreach via POST /outreach/batch
  if (isSendMode) {
    let eligibleVenues = candidates.filter((c) => c._id && c.email && !c.isExcluded);

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
    confirmDrafts: parsed.confirmDrafts,
    candidates,
    density,
    pitches,
    batchDispatch,
    tweaksApplied: parsed.tweaks,
  };

  // 7. Publish the merged report to web-jam-back (the sole durable copy) and open the
  // disposable scratch HTML in Chrome for immediate review.
  const published = await publishAndOpenReport(
    result,
    { noOpen: parsed.noOpen, openBrowser: openBrowserImpl },
    fetchFn,
  );
  const finalResult = published.result;
  if (finalResult.reportUrl) {
    console.log(`🌐 Live web-jam.com Report URL: ${finalResult.reportUrl}`);
  }
  if (published.htmlPath) {
    const absHtmlPath = path.resolve(published.htmlPath);
    console.log(
      `📁 Local Review HTML Artifact: [${
        path.basename(published.htmlPath)
      }](file://${absHtmlPath})`,
    );
    console.log(`📁 File URL: file://${absHtmlPath}`);
    if (published.opened) {
      console.log(`🚀 Automatically opened review artifact in Google Chrome.`);
    }
  }

  return finalResult;
}

if (import.meta.main) {
  try {
    await runBookGigCli(Deno.args);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    Deno.exit(1);
  }
}
