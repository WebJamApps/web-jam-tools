// src/book-gig/gmail.ts — Gmail draft creation and run logging for /book-gig

import type {
  BatchDispatchResult,
  BatchDispatchSkipped,
  BookGigResult,
  CandidateVenue,
  PitchEmail,
  TargetLocation,
} from "./types.ts";
import { extractRunDataFromHtml, renderDarkHtml } from "./html.ts";

export interface CreateDraftResult {
  venueId: string;
  venueName: string;
  to: string;
  subject: string;
  draftCreated: boolean;
  draftId?: string;
  error?: string;
}

export interface WeekendRunData {
  candidates: CandidateVenue[];
  pitches: PitchEmail[];
  batchDispatch?: BatchDispatchResult;
  reportUrl?: string;
  location?: TargetLocation;
  batches?: Array<{
    candidateIds: string[];
    requested: number;
    sent: number;
    skippedVenueIds: string[];
    timestamp?: string;
  }>;
}

/**
 * Extract structured run data from an existing Markdown run log.
 * Reads the embedded JSON comment if present, falling back to Markdown table/block regex parsing.
 */
export function extractRunDataFromMarkdown(mdContent: string): WeekendRunData | null {
  const match = mdContent.match(/<!--\s*BOOK_GIG_RUN_DATA:\s*([\s\S]*?)\s*-->/i);
  if (match) {
    try {
      const data = JSON.parse(match[1]);
      return {
        candidates: Array.isArray(data.candidates) ? data.candidates : [],
        pitches: Array.isArray(data.pitches) ? data.pitches : [],
        batchDispatch: data.batchDispatch,
        reportUrl: data.reportUrl,
        location: data.location,
        batches: Array.isArray(data.batches) ? data.batches : undefined,
      };
    } catch {
      // Fall through to regex parsing
    }
  }

  // Fallback: parse markdown tables and blocks
  let reportUrl: string | undefined;
  const urlMatch = mdContent.match(/\*\*Web Report URL:\*\*\s*\[(.*?)\]\((.*?)\)/);
  if (urlMatch) {
    reportUrl = urlMatch[2] || urlMatch[1];
  }

  let batchDispatch: BatchDispatchResult | undefined;
  const dispatchMatch = mdContent.match(
    /\*\*Batch Dispatch:\*\*\s*(\d+)\s*sent\s*\/\s*(\d+)\s*requested(?:\s*\((\d+)\s*skipped\))?/i,
  );
  if (dispatchMatch) {
    batchDispatch = {
      sent: parseInt(dispatchMatch[1], 10),
      requested: parseInt(dispatchMatch[2], 10),
      skipped: [],
      records: [],
    };
  }

  const candidates: CandidateVenue[] = [];
  const candidateSectionMatch = mdContent.match(
    /## 1\. Candidate Venues Evaluated\s*([\s\S]*?)(?:\n---|\n##|$)/,
  );
  if (candidateSectionMatch) {
    const lines = candidateSectionMatch[1].split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        !trimmed.startsWith("|") ||
        trimmed.includes("Venue Name") ||
        trimmed.includes("---|") ||
        trimmed.includes("No candidates found")
      ) {
        continue;
      }
      const cols = trimmed
        .split("|")
        .map((c) => c.trim())
        .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
      if (cols.length >= 6) {
        const name = cols[1];
        const loc = cols[2];
        const contact = cols[3] !== "—" ? cols[3] : undefined;
        const phone = cols[4] !== "—" ? cols[4] : undefined;
        const email = cols[5] !== "—" ? cols[5] : undefined;
        const spacingNote = cols[6] && cols[6] !== "—" ? cols[6] : undefined;

        let city: string | undefined;
        let usState: string | undefined;
        if (loc && loc !== "—") {
          const parts = loc.split(",").map((s) => s.trim());
          city = parts[0];
          usState = parts[1];
        }

        const id = `venue-${
          name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
        }`;
        candidates.push({
          _id: id,
          name,
          city,
          usState,
          contactName: contact,
          phone,
          email,
          reason: spacingNote ? { spacingNote } : undefined,
        });
      }
    }
  }

  const pitches: PitchEmail[] = [];
  const pitchSectionMatch = mdContent.match(
    /## 2\. Generated Gmail Pitches\s*([\s\S]*?)(?:\n---|\n##|$)/,
  );
  if (pitchSectionMatch) {
    const pitchBlocks = pitchSectionMatch[1].split(/(?=### Pitch \d+:)/);
    for (const block of pitchBlocks) {
      const titleMatch = block.match(/### Pitch \d+:\s*(.*)/);
      if (!titleMatch) continue;
      const venueName = titleMatch[1].trim();
      const toMatch = block.match(/- \*\*To:\*\*\s*`([^`]+)`(?:\s*\(CC:\s*`([^`]+)`\))?/);
      const subjectMatch = block.match(/- \*\*Subject:\*\*\s*(.*)/);
      const bodyMatch = block.match(/```text\s*([\s\S]*?)\s*```/);

      const to = toMatch ? toMatch[1].trim() : "";
      const secondaryTo = toMatch && toMatch[2] ? toMatch[2].trim() : undefined;
      const subject = subjectMatch ? subjectMatch[1].trim() : "";
      const body = bodyMatch ? bodyMatch[1].trim() : "";

      const matchedCandidate = candidates.find((c) => c.name === venueName);
      const venueId = matchedCandidate?._id ||
        `venue-${venueName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;

      pitches.push({
        venueId,
        venueName,
        to,
        secondaryTo,
        subject,
        body,
      });
    }
  }

  if (candidates.length > 0 || pitches.length > 0 || batchDispatch) {
    return {
      candidates,
      pitches,
      batchDispatch,
      reportUrl,
    };
  }

  return null;
}

/**
 * Reads any existing run log / report for the specified dateSlug from outputDir.
 * Tries markdown log first, then HTML artifact.
 */
export async function readExistingWeekendRunLog(
  outputDir: string,
  dateSlug: string,
): Promise<WeekendRunData | null> {
  const mdPath = `${outputDir}/book-gig-run-${dateSlug}.md`;
  const htmlPath = `${outputDir}/book-gig-run-${dateSlug}.html`;

  try {
    const mdContent = await Deno.readTextFile(mdPath);
    const mdData = extractRunDataFromMarkdown(mdContent);
    if (mdData) return mdData;
  } catch {
    // Markdown file doesn't exist or failed to read
  }

  try {
    const htmlContent = await Deno.readTextFile(htmlPath);
    const htmlData = extractRunDataFromHtml(htmlContent);
    if (htmlData) {
      return {
        candidates: htmlData.candidates || [],
        pitches: htmlData.pitches || [],
        batchDispatch: htmlData.batchDispatch,
        reportUrl: htmlData.reportUrl,
      };
    }
  } catch {
    // HTML file doesn't exist or failed to read
  }

  return null;
}

/**
 * Merges existing run data with the current BookGigResult, deduplicating candidate venues,
 * pitch cards, and skipped venues by venueId, and accumulating requested and sent metrics.
 */
export function mergeWeekendRuns(
  existing: WeekendRunData,
  current: BookGigResult,
): BookGigResult {
  // 1. Candidate Venues: deduplicate by venueId / _id
  const candidateMap = new Map<string, CandidateVenue>();
  for (const c of existing.candidates || []) {
    const id = c._id || (c as unknown as { venueId?: string }).venueId || c.name;
    if (id) {
      candidateMap.set(id, { ...c, _id: c._id || id });
    }
  }
  for (const c of current.candidates || []) {
    const id = c._id || (c as unknown as { venueId?: string }).venueId || c.name;
    if (id) {
      if (candidateMap.has(id)) {
        candidateMap.set(id, { ...candidateMap.get(id)!, ...c, _id: id });
      } else {
        candidateMap.set(id, { ...c, _id: id });
      }
    }
  }
  const mergedCandidates = Array.from(candidateMap.values());

  // 2. Pitch Cards: deduplicate by venueId
  const pitchMap = new Map<string, PitchEmail>();
  for (const p of existing.pitches || []) {
    const id = p.venueId || p.venueName;
    if (id) {
      pitchMap.set(id, { ...p, venueId: p.venueId || id });
    }
  }
  for (const p of current.pitches || []) {
    const id = p.venueId || p.venueName;
    if (id) {
      if (pitchMap.has(id)) {
        pitchMap.set(id, { ...pitchMap.get(id)!, ...p, venueId: id });
      } else {
        pitchMap.set(id, { ...p, venueId: id });
      }
    }
  }
  const mergedPitches = Array.from(pitchMap.values());

  // 3. Batch Dispatch: accumulate requested and sent counts, deduplicate skipped by venueId
  const currentCandidateIds = (current.candidates || []).map((c) =>
    c._id || (c as unknown as { venueId?: string }).venueId || c.name
  );
  const currentSkippedVenueIds = (current.batchDispatch?.skipped || []).map((s) =>
    s.venueId || s.venueName
  );

  const mergedBatches = existing.batches ? [...existing.batches] : [];
  if (mergedBatches.length === 0 && existing.batchDispatch) {
    // Synthesize the previous batch from existing state
    mergedBatches.push({
      candidateIds: (existing.candidates || []).map((c) =>
        c._id || (c as unknown as { venueId?: string }).venueId || c.name
      ),
      requested: existing.batchDispatch.requested,
      sent: existing.batchDispatch.sent,
      skippedVenueIds: (existing.batchDispatch.skipped || []).map((s) => s.venueId || s.venueName),
    });
  }

  // Check if current batch was already accounted for in batches
  const isDuplicateBatch = mergedBatches.some((b) => {
    if (current.batchDispatch) {
      if (
        b.requested !== current.batchDispatch.requested || b.sent !== current.batchDispatch.sent
      ) {
        return false;
      }
    }
    if (b.candidateIds.length !== currentCandidateIds.length) return false;
    return currentCandidateIds.every((id) => b.candidateIds.includes(id));
  });

  let mergedBatchDispatch: BatchDispatchResult | undefined;
  if (!existing.batchDispatch && !current.batchDispatch) {
    mergedBatchDispatch = undefined;
  } else if (!existing.batchDispatch && current.batchDispatch) {
    mergedBatchDispatch = { ...current.batchDispatch };
    mergedBatches.push({
      candidateIds: currentCandidateIds,
      requested: current.batchDispatch.requested,
      sent: current.batchDispatch.sent,
      skippedVenueIds: currentSkippedVenueIds,
    });
  } else if (existing.batchDispatch && !current.batchDispatch) {
    mergedBatchDispatch = { ...existing.batchDispatch };
  } else if (existing.batchDispatch && current.batchDispatch) {
    if (isDuplicateBatch) {
      mergedBatchDispatch = { ...existing.batchDispatch };
    } else {
      const requested = (existing.batchDispatch.requested || 0) +
        (current.batchDispatch.requested || 0);
      const sent = (existing.batchDispatch.sent || 0) + (current.batchDispatch.sent || 0);

      // Deduplicate skipped by venueId
      const skippedMap = new Map<string, BatchDispatchSkipped>();
      for (const s of existing.batchDispatch.skipped || []) {
        const id = s.venueId || s.venueName;
        if (id) skippedMap.set(id, { ...s, venueId: s.venueId || id });
      }
      for (const s of current.batchDispatch.skipped || []) {
        const id = s.venueId || s.venueName;
        if (id) skippedMap.set(id, { ...s, venueId: s.venueId || id });
      }

      // Merge records
      const recordMap = new Map<string, unknown>();
      let canDedupeRecords = true;
      const allRecords = [
        ...(existing.batchDispatch.records || []),
        ...(current.batchDispatch.records || []),
      ];
      for (const r of allRecords) {
        const rec = r as { _id?: string; venueId?: string };
        const id = rec?._id || rec?.venueId;
        if (id) {
          recordMap.set(id, r);
        } else {
          canDedupeRecords = false;
        }
      }
      const records = canDedupeRecords && recordMap.size > 0
        ? Array.from(recordMap.values())
        : allRecords;

      mergedBatchDispatch = {
        requested,
        sent,
        skipped: Array.from(skippedMap.values()),
        records,
      };

      mergedBatches.push({
        candidateIds: currentCandidateIds,
        requested: current.batchDispatch.requested,
        sent: current.batchDispatch.sent,
        skippedVenueIds: currentSkippedVenueIds,
      });
    }
  }

  return {
    ...current,
    candidates: mergedCandidates,
    pitches: mergedPitches,
    batchDispatch: mergedBatchDispatch,
    density: {
      ...current.density,
      count: mergedCandidates.length,
      isSparse: mergedCandidates.length < 3,
    },
    reportUrl: current.reportUrl || existing.reportUrl,
    ...({
      _runDataBatches: mergedBatches,
      _alreadyConsolidated: true,
    } as Record<string, unknown>),
  };
}

/**
 * Format a pitch as a Gmail draft object (ready for Gmail API or MCP)
 */
export function formatDraftPayload(pitch: PitchEmail): {
  to: string;
  cc?: string;
  subject: string;
  body: string;
} {
  return {
    to: pitch.to,
    cc: pitch.secondaryTo,
    subject: pitch.subject,
    body: pitch.body,
  };
}

/**
 * Record an outreach run log in Dropbox for Josh's records (Markdown + Responsive Dark Mode HTML)
 */
export async function writeDropboxRunLog(
  result: BookGigResult,
  outputDir = `${Deno.env.get("HOME")}/Dropbox/web-jam-llms/gig-outreach`,
): Promise<string | null> {
  try {
    await Deno.mkdir(outputDir, { recursive: true });
    const dateSlug = result.weekend
      ? `${result.weekend.start}-to-${result.weekend.end}`
      : `replies-${new Date().toISOString().slice(0, 10)}`;
    const mdPath = `${outputDir}/book-gig-run-${dateSlug}.md`;
    const htmlPath = `${outputDir}/book-gig-run-${dateSlug}.html`;

    // If target weekend is present, consolidate with any existing run log
    let consolidated = result;
    if (
      result.weekend &&
      !(result as unknown as { _alreadyConsolidated?: boolean })._alreadyConsolidated
    ) {
      const existing = await readExistingWeekendRunLog(outputDir, dateSlug);
      if (existing) {
        consolidated = mergeWeekendRuns(existing, result);
      }
    }

    const candidateRows = consolidated.candidates.map((c, i) =>
      `| ${i + 1} | ${c.name} | ${c.city || "—"}, ${c.usState || "—"} | ${c.contactName || "—"} | ${
        c.phone || "—"
      } | ${c.email || "—"} | ${c.reason?.spacingNote || "—"} |`
    ).join("\n");

    const pitchBlocks = consolidated.pitches.map((p, i) =>
      `### Pitch ${i + 1}: ${p.venueName}
- **To:** \`${p.to}\`${p.secondaryTo ? ` (CC: \`${p.secondaryTo}\`)` : ""}
- **Subject:** ${p.subject}

\`\`\`text
${p.body}
\`\`\`
`
    ).join("\n\n");

    const weekendHeader = consolidated.weekend
      ? `${consolidated.weekend.start} to ${consolidated.weekend.end} (${consolidated.weekend.label})`
      : "All Active Outreach Campaigns";

    let reportUrlSummary = "";
    if (consolidated.reportUrl) {
      reportUrlSummary =
        `\n**Web Report URL:** [${consolidated.reportUrl}](${consolidated.reportUrl})  `;
    }

    let dispatchSummary = "";
    if (consolidated.batchDispatch) {
      dispatchSummary =
        `\n**Batch Dispatch:** ${consolidated.batchDispatch.sent} sent / ${consolidated.batchDispatch.requested} requested (${consolidated.batchDispatch.skipped.length} skipped)  `;
    }

    let repliesSummary = "";
    if (consolidated.repliesTracking) {
      repliesSummary =
        `\n**Replies Scan:** ${consolidated.repliesTracking.checkReplies.checked} checked, ${consolidated.repliesTracking.checkReplies.matched} matched (${consolidated.repliesTracking.pendingReplies.length} pending review)  `;
    }

    const content = `# \`book-gig\` Run Record: ${consolidated.weekend?.label || "Outreach Status"}

**Run Timestamp:** ${new Date().toISOString()}  
**Mode:** ${consolidated.mode}  
**Target Weekend:** ${weekendHeader}  
**Target Location Filter:** ${
      consolidated.location ? consolidated.location.raw : "All Regional Metros (~3.5h drive)"
    }  
**Candidates Found:** ${consolidated.candidates.length} (Sparse: ${
      consolidated.density.isSparse ? "Yes" : "No"
    })  
**Pitches Drafted:** ${consolidated.pitches.length}  ${reportUrlSummary}${dispatchSummary}${repliesSummary}

---

## 1. Candidate Venues Evaluated

| # | Venue Name | Location | Contact Person | Phone | Booking Email | Spacing Note |
|---|---|---|---|---|---|---|
${candidateRows || "| — | No candidates found | — | — | — | — | — |"}

---

## 2. Generated Gmail Pitches

${pitchBlocks || "*No pitches generated.*"}

---

*Note: Generated by WebJamApps \`book-gig\` outreach pipeline.*
<!-- BOOK_GIG_RUN_DATA:
${
      JSON.stringify(
        {
          candidates: consolidated.candidates,
          pitches: consolidated.pitches,
          batchDispatch: consolidated.batchDispatch,
          reportUrl: consolidated.reportUrl,
          location: consolidated.location,
          batches: (consolidated as unknown as { _runDataBatches?: WeekendRunData["batches"] })
            ._runDataBatches,
        },
        null,
        2,
      )
    }
-->
`;

    await Deno.writeTextFile(mdPath, content);

    // Generate and write standalone responsive Dark Mode HTML for Chrome review
    const htmlContent = renderDarkHtml(consolidated);
    await Deno.writeTextFile(htmlPath, htmlContent);

    return mdPath;
  } catch (err) {
    console.warn(`[book-gig] Failed to write run log to Dropbox: ${(err as Error).message}`);
    return null;
  }
}
