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
  const isSend = current.mode === "send";

  // Identify any candidates that were already dispatched in prior batches
  const priorDispatchedIds = new Set<string>();
  if (existing.batches && existing.batches.length > 0) {
    for (const b of existing.batches) {
      if (b.sent > 0 || (b.candidateIds && b.candidateIds.length > 0)) {
        const skipped = new Set(b.skippedVenueIds || []);
        for (const id of b.candidateIds) {
          if (id && !skipped.has(id)) priorDispatchedIds.add(id);
        }
      }
    }
  }
  if (existing.batchDispatch?.records && existing.batchDispatch.records.length > 0) {
    for (const r of existing.batchDispatch.records) {
      const rec = r as { _id?: string; venueId?: string; venueName?: string; venue?: string };
      const venueId = rec.venueId || rec.venue;
      if (venueId) {
        priorDispatchedIds.add(venueId);
      } else if (rec.venueName) {
        priorDispatchedIds.add(rec.venueName);
      } else if (rec._id) {
        priorDispatchedIds.add(rec._id);
      }
      if (rec.venueName) {
        priorDispatchedIds.add(rec.venueName);
      }
    }
  }
  if (priorDispatchedIds.size === 0 && existing.batchDispatch && existing.batchDispatch.sent > 0) {
    for (const c of existing.candidates || []) {
      const id = c._id || (c as unknown as { venueId?: string }).venueId || c.name;
      if (id && !c.isExcluded) priorDispatchedIds.add(id);
    }
  }
  const hasPriorDispatch = priorDispatchedIds.size > 0 ||
    Boolean(existing.batchDispatch && existing.batchDispatch.sent > 0);

  // 1. Candidate Venues
  // For sends: accumulate all candidates from existing and current, preserving exclusions and holds.
  // For discovery sweeps and Gate 1/Gate 2 reviews: render strictly the curated set under review.
  let mergedCandidates: CandidateVenue[];
  if (isSend) {
    const candidateMap = new Map<string, CandidateVenue>();
    if (!current.location?.allLocations) {
      for (const c of existing.candidates || []) {
        const id = c._id || (c as unknown as { venueId?: string }).venueId || c.name;
        if (id) {
          candidateMap.set(id, { ...c, _id: c._id || id });
        }
      }
    }
    for (const c of current.candidates || []) {
      const id = c._id || (c as unknown as { venueId?: string }).venueId || c.name;
      if (id) {
        if (candidateMap.has(id)) {
          const prev = candidateMap.get(id)!;
          const isExcluded = Boolean(prev.isExcluded || c.isExcluded);
          const exclusionReason = c.isExcluded
            ? (c.exclusionReason ?? prev.exclusionReason)
            : (prev.isExcluded
              ? prev.exclusionReason
              : (c.exclusionReason ?? prev.exclusionReason));
          const statusBadge = c.isExcluded
            ? (c.statusBadge ?? prev.statusBadge)
            : (prev.isExcluded ? prev.statusBadge : (c.statusBadge ?? prev.statusBadge));
          const reason = c.isExcluded
            ? (c.reason ?? prev.reason)
            : (prev.isExcluded ? prev.reason : (c.reason ?? prev.reason));
          const resumeBooking = c.resumeBooking ?? prev.resumeBooking;
          const bookedThrough = c.bookedThrough ?? prev.bookedThrough;
          const outreachEligible = (prev.outreachEligible === false || c.outreachEligible === false)
            ? false
            : (c.outreachEligible ?? prev.outreachEligible);

          candidateMap.set(id, {
            ...prev,
            ...c,
            _id: id,
            ...(resumeBooking ? { resumeBooking } : {}),
            ...(bookedThrough ? { bookedThrough } : {}),
            ...(outreachEligible !== undefined ? { outreachEligible } : {}),
            ...(isExcluded ? { isExcluded: true, exclusionReason, statusBadge, reason } : {}),
          });
        } else {
          candidateMap.set(id, { ...c, _id: id });
        }
      }
    }
    mergedCandidates = Array.from(candidateMap.values());
  } else {
    mergedCandidates = [...(current.candidates || [])];
  }

  // 2. Pitch Cards
  // For sends: accumulate all pitches from existing and current, excluding pitches for excluded venues.
  // For discovery sweeps and Gate 1/Gate 2 reviews: render strictly the curated pitches under review.
  let mergedPitches: PitchEmail[];
  if (isSend) {
    const pitchMap = new Map<string, PitchEmail>();
    const currentCandidateMap = new Map<string, CandidateVenue>(
      mergedCandidates.map((
        c,
      ) => [c._id || (c as unknown as { venueId?: string }).venueId || c.name, c]),
    );
    if (!current.location?.allLocations) {
      for (const p of existing.pitches || []) {
        const id = p.venueId || p.venueName;
        if (id) {
          const c = currentCandidateMap.get(id);
          if (c?.isExcluded) {
            continue;
          }
          pitchMap.set(id, { ...p, venueId: p.venueId || id });
        }
      }
    }
    for (const p of current.pitches || []) {
      const id = p.venueId || p.venueName;
      if (id) {
        const c = currentCandidateMap.get(id);
        if (c?.isExcluded) {
          continue;
        }
        if (pitchMap.has(id)) {
          pitchMap.set(id, { ...pitchMap.get(id)!, ...p, venueId: id });
        } else {
          pitchMap.set(id, { ...p, venueId: id });
        }
      }
    }

    // Purge any pitch for any candidate marked excluded in currentCandidateMap
    for (const [id, c] of currentCandidateMap.entries()) {
      if (c.isExcluded) {
        pitchMap.delete(id);
        if (c.name) pitchMap.delete(c.name);
      }
    }
    mergedPitches = Array.from(pitchMap.values());
  } else {
    mergedPitches = [...(current.pitches || [])];
  }

  // 3. Machine-readable run data candidates & pitches
  let runDataCandidates = mergedCandidates;
  let runDataPitches = mergedPitches;
  if (!isSend && hasPriorDispatch) {
    const rdCandMap = new Map<string, CandidateVenue>();
    for (const c of existing.candidates || []) {
      const id = c._id || (c as unknown as { venueId?: string }).venueId || c.name;
      if (id && priorDispatchedIds.has(id)) {
        rdCandMap.set(id, { ...c, _id: c._id || id });
      }
    }
    for (const c of current.candidates || []) {
      const id = c._id || (c as unknown as { venueId?: string }).venueId || c.name;
      if (id) {
        rdCandMap.set(id, { ...(rdCandMap.get(id) || {}), ...c, _id: id });
      }
    }
    runDataCandidates = Array.from(rdCandMap.values());

    const rdPitchMap = new Map<string, PitchEmail>();
    for (const p of existing.pitches || []) {
      const id = p.venueId || p.venueName;
      if (id && priorDispatchedIds.has(id)) {
        rdPitchMap.set(id, { ...p });
      }
    }
    for (const p of current.pitches || []) {
      const id = p.venueId || p.venueName;
      if (id) {
        rdPitchMap.set(id, { ...p });
      }
    }
    runDataPitches = Array.from(rdPitchMap.values());
  }

  // 4. Batch Dispatch: accumulate requested and sent counts, deduplicate skipped by venueId
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
        const rec = r as { _id?: string; venueId?: string; venue?: string };
        const id = rec?.venueId || rec?.venue || rec?._id;
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
      _runDataCandidates: runDataCandidates,
      _runDataPitches: runDataPitches,
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
