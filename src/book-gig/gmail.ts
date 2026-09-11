// src/book-gig/gmail.ts — Gmail draft creation and weekend run data merging for /book-gig

import type {
  BatchDispatchResult,
  BatchDispatchSkipped,
  BookGigResult,
  CandidateVenue,
  PitchEmail,
  TargetLocation,
} from "./types.ts";

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
