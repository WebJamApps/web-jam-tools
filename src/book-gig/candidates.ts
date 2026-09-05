// src/book-gig/candidates.ts — Candidate venue query and geographic filtering for /book-gig

import type {
  CandidateBadgeInfo,
  CandidateVenue,
  OutreachCampaignRecord,
  TargetLocation,
  TargetWeekend,
} from "./types.ts";
import { resolveBackendConfig } from "./outreach_api.ts";
import { getDefaultLocation, US_STATES } from "./parser.ts";

export const DIRECT_CHAT_REGEX =
  /direct|chat|phone|spoke|talk(ed|ing)?|conversation|call(ed)?|text(ed)?|in\s*person/i;

export interface FetchCandidatesOptions {
  backendUrl?: string;
  token?: string;
  weekend: TargetWeekend;
}

/**
 * Fetch eligible candidate venues from web-jam-back /outreach/candidates
 */
export async function fetchCandidates(
  options: FetchCandidatesOptions,
  fetchFn: typeof fetch = fetch,
): Promise<CandidateVenue[]> {
  const { baseUrl, token } = await resolveBackendConfig(options);
  const targetDatesParam = encodeURIComponent(`${options.weekend.start} to ${options.weekend.end}`);
  const startParam = encodeURIComponent(options.weekend.start);
  const endParam = encodeURIComponent(options.weekend.end);
  const url =
    `${baseUrl}/outreach/candidates?targetDates=${targetDatesParam}&targetWeekend[start]=${startParam}&targetWeekend[end]=${endParam}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let candidates: CandidateVenue[] = [];
  try {
    const res = await fetchFn(url, { headers });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        candidates = (data as CandidateVenue[]).map((c) => ({
          ...c,
          isExcluded: c.isExcluded ?? false,
        }));
      } else if (data && Array.isArray(data.candidates)) {
        candidates = (data.candidates as CandidateVenue[]).map((c) => ({
          ...c,
          isExcluded: c.isExcluded ?? false,
        }));
      }
      if (data && Array.isArray(data.held)) {
        candidates.push(
          ...(data.held as CandidateVenue[]).map((c) => ({ ...c, isExcluded: true })),
        );
      }
      if (data && Array.isArray(data.excluded)) {
        candidates.push(
          ...(data.excluded as CandidateVenue[]).map((c) => ({ ...c, isExcluded: true })),
        );
      }
    } else {
      console.warn(`[book-gig] Candidates query returned HTTP ${res.status}: ${res.statusText}`);
    }
  } catch (err) {
    console.warn(`[book-gig] Error fetching candidates from ${url}: ${(err as Error).message}`);
  }

  // Enrich candidate pool with venues carrying active holds, spacing constraints, direct-chat, or cooldowns
  // so the terminal candidate table and HTML review artifact display granular reason badges.
  const allVenuesMap = new Map<string, CandidateVenue>();
  try {
    const venueUrl = `${baseUrl}/venue?status=active`;
    const venueRes = await fetchFn(venueUrl, { headers });
    if (venueRes.ok) {
      const venues = await venueRes.json();
      if (Array.isArray(venues)) {
        for (const v of venues) {
          if (v && v._id) allVenuesMap.set(String(v._id), v as CandidateVenue);
        }
        const candidateIds = new Set(candidates.map((c) => String(c._id)));
        const nowMs = Date.now();
        const weekendStartMs = new Date(options.weekend.start).getTime();

        for (const v of venues) {
          if (!v || !v._id || candidateIds.has(String(v._id))) continue;
          if (v.status === "archived") continue;

          // 1. Seasonal Hold: active resumeBooking in the future
          if (v.resumeBooking) {
            const rbDate = new Date(v.resumeBooking);
            if (!Number.isNaN(rbDate.getTime()) && rbDate.getTime() > nowMs) {
              candidates.push({
                ...v,
                isExcluded: true,
                statusBadge: `[Seasonal Hold: ${formatMonthYear(rbDate)}]`,
                exclusionReason: "seasonal-hold",
                reason: {
                  resumeBooking: v.resumeBooking,
                  statusBadge: `[Seasonal Hold: ${formatMonthYear(rbDate)}]`,
                  exclusionReason: "seasonal-hold",
                },
              });
              candidateIds.add(String(v._id));
              continue;
            }
          }

          // 1b. Seasonal Hold: bookedThrough on or after weekend start
          if (v.bookedThrough) {
            const btDate = new Date(v.bookedThrough);
            if (!Number.isNaN(btDate.getTime()) && btDate.getTime() >= weekendStartMs) {
              candidates.push({
                ...v,
                isExcluded: true,
                statusBadge: `[Seasonal Hold: ${formatMonthYear(btDate)}]`,
                exclusionReason: "seasonal-hold",
                reason: {
                  bookedThrough: v.bookedThrough,
                  statusBadge: `[Seasonal Hold: ${formatMonthYear(btDate)}]`,
                  exclusionReason: "seasonal-hold",
                },
              });
              candidateIds.add(String(v._id));
              continue;
            }
          }

          // 2. Direct Chat Active: outreachEligible === false AND positive evidence of active direct chat in notes
          const hasDirectChatInNotes = typeof v.notes === "string" &&
            DIRECT_CHAT_REGEX.test(v.notes);
          if (v.outreachEligible === false && hasDirectChatInNotes) {
            candidates.push({
              ...v,
              isExcluded: true,
              statusBadge: "[Direct Chat Active]",
              exclusionReason: "direct-chat",
              reason: {
                activeDirectChat: true,
                statusBadge: "[Direct Chat Active]",
                exclusionReason: "direct-chat",
              },
            });
            candidateIds.add(String(v._id));
            continue;
          }

          // 3. Gig Spacing: conflicting gig within gigInterval (default 2 months)
          const gigIntervalMonths = (typeof v.gigInterval === "number" && v.gigInterval > 0)
            ? v.gigInterval
            : 2;
          const lower = new Date(weekendStartMs);
          lower.setMonth(lower.getMonth() - gigIntervalMonths);
          const upper = new Date(weekendStartMs);
          upper.setMonth(upper.getMonth() + gigIntervalMonths);

          const conflictingGig = [v.lastGig, v.nextGig].find((g) => {
            if (!g || !g.datetime) return false;
            const gTime = new Date(g.datetime).getTime();
            return !Number.isNaN(gTime) && gTime > lower.getTime() && gTime < upper.getTime();
          });
          if (conflictingGig) {
            const gFormatted = formatMonthDay(conflictingGig.datetime);
            candidates.push({
              ...v,
              isExcluded: true,
              statusBadge: `[Gig Spacing: ${gFormatted} Show]`,
              exclusionReason: "gig-spacing",
              conflictingGigDate: conflictingGig.datetime,
              reason: {
                conflictingGigDate: conflictingGig.datetime,
                lastGigDate: conflictingGig.datetime,
                gigIntervalMonths,
                statusBadge: `[Gig Spacing: ${gFormatted} Show]`,
                exclusionReason: "gig-spacing",
              },
            });
            candidateIds.add(String(v._id));
            continue;
          }
        }
      }
    }
  } catch {
    // Best-effort venue enrichment
  }

  // 4. Cooldown Active: venues pitched within 7-day cooldown window for this weekend
  try {
    const [sentRes, repliedRes] = await Promise.all([
      fetchFn(`${baseUrl}/outreach?status=sent`, { headers }),
      fetchFn(`${baseUrl}/outreach?status=replied`, { headers }),
    ]);
    const campaigns: OutreachCampaignRecord[] = [];
    if (sentRes.ok) {
      const sentData = await sentRes.json();
      if (Array.isArray(sentData)) campaigns.push(...sentData);
    }
    if (repliedRes.ok) {
      const repliedData = await repliedRes.json();
      if (Array.isArray(repliedData)) campaigns.push(...repliedData);
    }

    if (campaigns.length > 0) {
      const nowMs = Date.now();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const wStartMs = new Date(options.weekend.start).getTime();
      const wEndMs = new Date(options.weekend.end).getTime();

      for (const camp of campaigns) {
        if (!camp || !camp.venueId) continue;
        const sentDate = camp.sentAt ? new Date(camp.sentAt) : null;
        const repliedDate = camp.repliedAt ? new Date(camp.repliedAt) : null;
        const isReplied = camp.status === "replied";
        const actionDate = (isReplied && repliedDate && !Number.isNaN(repliedDate.getTime()))
          ? repliedDate
          : (sentDate && !Number.isNaN(sentDate.getTime()) ? sentDate : null);

        if (!actionDate) continue;
        const diffMs = nowMs - actionDate.getTime();
        if (diffMs < 0 || diffMs > sevenDaysMs) continue;

        const twStart = camp.targetWeekend?.start
          ? new Date(camp.targetWeekend.start).getTime()
          : null;
        const twEnd = camp.targetWeekend?.end ? new Date(camp.targetWeekend.end).getTime() : null;
        const matchesWeekend =
          (twStart !== null && twEnd !== null && twStart <= wEndMs && twEnd >= wStartMs) ||
          Boolean(
            camp.targetDates &&
              (camp.targetDates.includes(options.weekend.start) ||
                camp.targetDates.includes(options.weekend.label)),
          );

        if (matchesWeekend) {
          const formatted = formatMonthDay(actionDate);
          const badgeAction = isReplied ? "Replied" : "Sent";
          const badgeText = `[Cooldown Active: ${badgeAction} ${formatted}]`;
          const isoDate = actionDate.toISOString();

          const existing = candidates.find((c) => String(c._id) === String(camp.venueId));
          if (existing) {
            existing.isExcluded = true;
            existing.statusBadge = badgeText;
            existing.exclusionReason = "cooldown";
            if (isReplied) {
              existing.cooldownRepliedDate = isoDate;
            } else {
              existing.cooldownSentDate = isoDate;
            }
            existing.reason = {
              ...existing.reason,
              ...(isReplied ? { cooldownRepliedDate: isoDate } : { cooldownSentDate: isoDate }),
              statusBadge: badgeText,
              exclusionReason: "cooldown",
            };
          } else {
            const v = allVenuesMap.get(String(camp.venueId));
            if (v) {
              candidates.push({
                ...v,
                isExcluded: true,
                statusBadge: badgeText,
                exclusionReason: "cooldown",
                ...(isReplied ? { cooldownRepliedDate: isoDate } : { cooldownSentDate: isoDate }),
                reason: {
                  ...(isReplied ? { cooldownRepliedDate: isoDate } : { cooldownSentDate: isoDate }),
                  statusBadge: badgeText,
                  exclusionReason: "cooldown",
                },
              });
            }
          }
        }
      }
    }
  } catch {
    // Best-effort cooldown enrichment
  }

  return candidates;
}

// Word boundary matching via string indexing and static regex character testing.
// Avoids dynamic new RegExp (detect-non-literal-regexp / ReDoS rule — AGENTS.md).
function isAlphaNum(char: string | undefined): boolean {
  return Boolean(char && /[a-z0-9]/i.test(char));
}

function matchesWordBoundary(text: string, target: string): boolean {
  if (!text || !target) return false;
  let idx = text.indexOf(target);
  while (idx !== -1) {
    const beforeOk = idx === 0 || !isAlphaNum(text[idx - 1]);
    const afterOk = (idx + target.length === text.length) || !isAlphaNum(text[idx + target.length]);
    if (beforeOk && afterOk) {
      return true;
    }
    idx = text.indexOf(target, idx + 1);
  }
  return false;
}

/**
 * Format a Date or ISO string as "MMM YYYY", e.g. "Jan 2027"
 */
export function formatMonthYear(d: string | Date): string {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  if (typeof d === "string") {
    const trimmed = d.trim();
    if (/^[A-Za-z]{3}\s+\d{4}$/.test(trimmed)) return trimmed;
    const match = trimmed.match(/^(\d{4})-(\d{1,2})/);
    if (match) {
      const year = match[1];
      const monthIdx = parseInt(match[2], 10) - 1;
      if (months[monthIdx]) return `${months[monthIdx]} ${year}`;
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return `${months[parsed.getUTCMonth()]} ${parsed.getUTCFullYear()}`;
    }
    return trimmed;
  }
  return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Format a Date or ISO string as "MMM D", e.g. "Nov 20", "Oct 10"
 */
export function formatMonthDay(d: string | Date): string {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  if (typeof d === "string") {
    const trimmed = d.trim().replace(/^Sent\s+/i, "");
    if (/^[A-Za-z]{3}\s+\d{1,2}$/.test(trimmed)) return trimmed;
    const match = trimmed.match(/^\d{4}-(\d{1,2})-(\d{1,2})/);
    if (match) {
      const monthIdx = parseInt(match[1], 10) - 1;
      const day = parseInt(match[2], 10);
      if (months[monthIdx]) return `${months[monthIdx]} ${day}`;
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return `${months[parsed.getUTCMonth()]} ${parsed.getUTCDate()}`;
    }
    return trimmed;
  }
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * Identify eligibility status badge and exclusion reasoning for a candidate venue
 */
export function identifyCandidateBadge(
  v: CandidateVenue,
  referenceDate: Date = new Date(),
): CandidateBadgeInfo {
  if (v.statusBadge) {
    const sb = v.statusBadge;
    if (sb.includes("Seasonal Hold") || sb.includes("Hold:")) {
      return { badge: sb, cssClass: "badge-seasonal-hold", isExcluded: true };
    }
    if (sb.includes("Gig Spacing") || sb.includes("Spacing:")) {
      return { badge: sb, cssClass: "badge-gig-spacing", isExcluded: true };
    }
    if (sb.includes("Direct Chat")) {
      return { badge: sb, cssClass: "badge-direct-chat", isExcluded: true };
    }
    if (sb.includes("Cooldown Active") || sb.includes("Cooldown:")) {
      return { badge: sb, cssClass: "badge-cooldown", isExcluded: true };
    }
    if (sb.startsWith("Returning")) {
      return { badge: sb, cssClass: "badge-returning", isExcluded: false };
    }
    return { badge: sb, cssClass: "badge-eligible", isExcluded: false };
  }

  const nowMs = referenceDate.getTime();

  // 1. Seasonal Hold: venues with active resumeBooking in the future
  const resumeBookingVal = v.resumeBooking ?? v.reason?.resumeBooking;
  if (resumeBookingVal) {
    const rDate = typeof resumeBookingVal === "string"
      ? new Date(resumeBookingVal)
      : resumeBookingVal;
    if (!Number.isNaN(rDate.getTime()) && rDate.getTime() > nowMs) {
      return {
        badge: `[Seasonal Hold: ${formatMonthYear(rDate)}]`,
        cssClass: "badge-seasonal-hold",
        isExcluded: true,
      };
    }
  }

  const bookedThroughVal = v.bookedThrough ?? v.reason?.bookedThrough;
  if (bookedThroughVal) {
    const btDate = typeof bookedThroughVal === "string"
      ? new Date(bookedThroughVal)
      : bookedThroughVal;
    if (!Number.isNaN(btDate.getTime()) && btDate.getTime() > nowMs) {
      return {
        badge: `[Seasonal Hold: ${formatMonthYear(btDate)}]`,
        cssClass: "badge-seasonal-hold",
        isExcluded: true,
      };
    }
  }

  // 2. Gig Spacing: venues excluded by the ±2 month gig window
  const conflictingGigDate = v.conflictingGigDate ?? v.reason?.conflictingGigDate;
  if (conflictingGigDate) {
    const formatted = formatMonthDay(conflictingGigDate);
    return {
      badge: `[Gig Spacing: ${formatted} Show]`,
      cssClass: "badge-gig-spacing",
      isExcluded: true,
    };
  }
  if (v.exclusionReason === "gig-spacing" || v.reason?.exclusionReason?.includes("Gig Spacing")) {
    const formatted = v.reason?.lastGigDate ? formatMonthDay(v.reason.lastGigDate) : "";
    return {
      badge: formatted ? `[Gig Spacing: ${formatted} Show]` : "[Gig Spacing Show]",
      cssClass: "badge-gig-spacing",
      isExcluded: true,
    };
  }
  if (
    v.reason?.spacingNote &&
    (v.reason.spacingNote.includes("Show") ||
      v.reason.spacingNote.toLowerCase().includes("gig spacing") ||
      v.reason.spacingNote.toLowerCase().includes("conflict"))
  ) {
    const match = v.reason.spacingNote.match(/\b([A-Za-z]{3}\s+\d{1,2}|\d{4}-\d{2}-\d{2})\b/);
    const formatted = match ? formatMonthDay(match[1]) : "";
    return {
      badge: formatted ? `[Gig Spacing: ${formatted} Show]` : `[${v.reason.spacingNote}]`,
      cssClass: "badge-gig-spacing",
      isExcluded: true,
    };
  }
  if (
    v.reason?.nearestGigMonthsAway !== null &&
    v.reason?.nearestGigMonthsAway !== undefined &&
    v.reason.nearestGigMonthsAway < (v.gigInterval || 2) &&
    v.reason?.lastGigDate
  ) {
    const formatted = formatMonthDay(v.reason.lastGigDate);
    return {
      badge: `[Gig Spacing: ${formatted} Show]`,
      cssClass: "badge-gig-spacing",
      isExcluded: true,
    };
  }

  // 3. Direct Chat Active: outreachEligible: false with active direct conversation notes
  const hasDirectChatNotes = Boolean(
    (typeof v.notes === "string" && DIRECT_CHAT_REGEX.test(v.notes)) ||
      (typeof v.bookingNotes === "string" && DIRECT_CHAT_REGEX.test(v.bookingNotes)),
  );
  if (
    v.activeDirectChat ||
    v.reason?.activeDirectChat ||
    (v.outreachEligible === false && hasDirectChatNotes)
  ) {
    return {
      badge: "[Direct Chat Active]",
      cssClass: "badge-direct-chat",
      isExcluded: true,
    };
  }

  // 4. Cooldown Active: venues pitched within the 7-day cooldown window
  const cooldownRepliedVal = v.cooldownRepliedDate ?? v.reason?.cooldownRepliedDate;
  if (cooldownRepliedVal) {
    const formatted = formatMonthDay(cooldownRepliedVal);
    return {
      badge: `[Cooldown Active: Replied ${formatted}]`,
      cssClass: "badge-cooldown",
      isExcluded: true,
    };
  }
  const cooldownSentVal = v.cooldownSentDate ??
    v.reason?.cooldownSentDate ??
    v.lastSentDate ??
    v.reason?.lastSentDate;
  if (cooldownSentVal) {
    const formatted = formatMonthDay(cooldownSentVal);
    return {
      badge: `[Cooldown Active: Sent ${formatted}]`,
      cssClass: "badge-cooldown",
      isExcluded: true,
    };
  }
  const sentAtVal = v.sentAt ?? v.reason?.sentAt;
  if (sentAtVal) {
    const sentDate = typeof sentAtVal === "string" ? new Date(sentAtVal) : sentAtVal;
    if (!Number.isNaN(sentDate.getTime())) {
      const diffMs = nowMs - sentDate.getTime();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      if (diffMs >= 0 && diffMs <= sevenDaysMs) {
        const formatted = formatMonthDay(sentDate);
        return {
          badge: `[Cooldown Active: Sent ${formatted}]`,
          cssClass: "badge-cooldown",
          isExcluded: true,
        };
      }
    }
  }
  if (v.exclusionReason === "cooldown") {
    return {
      badge: "[Cooldown Active]",
      cssClass: "badge-cooldown",
      isExcluded: true,
    };
  }

  // 5. Eligible: Returning or New
  if (v.reason?.lastGigDate) {
    return {
      badge: `Returning · Last: ${formatMonthDay(v.reason.lastGigDate)}`,
      cssClass: "badge-returning",
      isExcluded: false,
    };
  }

  return {
    badge: v.reason?.spacingNote || "New",
    cssClass: "badge-eligible",
    isExcluded: false,
  };
}

/**
 * Filter and rank candidate venues based on target location (City, State, Zip, or Metro)
 */
export function filterAndRankCandidates(
  candidates: CandidateVenue[],
  location?: TargetLocation,
  options?: { referenceDate?: Date },
): CandidateVenue[] {
  if (!candidates || candidates.length === 0) return [];
  const targetLoc = location || getDefaultLocation();
  const refDate = options?.referenceDate ?? new Date();

  const targetCities = (targetLoc.cities && targetLoc.cities.length > 0)
    ? targetLoc.cities.map((c) => c.toLowerCase())
    : (targetLoc.city ? [targetLoc.city.toLowerCase()] : []);
  const surroundingCities = (targetLoc.surroundingCities || []).map((c) => c.toLowerCase());
  const locZip = targetLoc.zip;
  const locMetro = targetLoc.metroSlug?.toLowerCase();
  const locState = targetLoc.state?.toUpperCase();
  const hasMultiCityOrSurrounding = (targetLoc.cities && targetLoc.cities.length > 1) ||
    Boolean(targetLoc.includeSurrounding);

  const exactMatches: CandidateVenue[] = [];
  const surroundingMatches: CandidateVenue[] = [];

  for (const v of candidates) {
    // Populate granular status badge and reasoning on shallow-cloned venue (immutability)
    const badgeInfo = identifyCandidateBadge(v, refDate);
    const vCopy: CandidateVenue = {
      ...v,
      statusBadge: v.statusBadge || badgeInfo.badge,
      isExcluded: v.isExcluded ?? badgeInfo.isExcluded,
      reason: v.reason
        ? {
          ...v.reason,
          statusBadge: v.reason.statusBadge || badgeInfo.badge,
          ...(badgeInfo.isExcluded
            ? { exclusionReason: v.reason.exclusionReason || badgeInfo.badge }
            : {}),
        }
        : {
          statusBadge: badgeInfo.badge,
          ...(badgeInfo.isExcluded ? { exclusionReason: badgeInfo.badge } : {}),
        },
    };

    const vCity = (vCopy.city || "").toLowerCase().trim();
    const vAddr = (vCopy.address || "").toLowerCase();
    let vState = (vCopy.usState || "").toUpperCase().trim();
    if (!vState && vCopy.address) {
      const stateMatch = vCopy.address.match(/\b([A-Z]{2})\b(?:\s+\d{5})?$/i);
      if (stateMatch && US_STATES.has(stateMatch[1].toUpperCase())) {
        vState = stateMatch[1].toUpperCase();
      }
    }

    // If target location has a specific state and venue is in a different state, exclude it
    if (locState && vState && vState !== locState) {
      continue;
    }

    let isExact = false;

    // 1. Check exact zipcode match
    if (locZip && (vAddr.includes(locZip) || vAddr.endsWith(locZip))) {
      isExact = true;
    }

    // 2. Check exact city match across target cities
    if (!isExact && targetCities.length > 0) {
      for (const tc of targetCities) {
        if (vCity === tc || matchesWordBoundary(vCity, tc) || matchesWordBoundary(vAddr, tc)) {
          isExact = true;
          break;
        }
      }
    }

    // 3. Check metro slug proximity if single city/metro
    if (
      !isExact && !hasMultiCityOrSurrounding && locMetro &&
      (vCity.includes(locMetro) || locMetro.includes(vCity))
    ) {
      isExact = true;
    }

    if (isExact) {
      exactMatches.push(vCopy);
      continue;
    }

    // 4. Check surrounding areas match
    let isSurrounding = false;
    if (surroundingCities.length > 0) {
      for (const sc of surroundingCities) {
        if (vCity === sc || matchesWordBoundary(vCity, sc) || matchesWordBoundary(vAddr, sc)) {
          isSurrounding = true;
          break;
        }
      }
    }

    if (isSurrounding) {
      surroundingMatches.push(vCopy);
    }
  }

  // Exact matches first, then neighboring surrounding matches
  return [
    ...exactMatches.sort((a, b) => a.name.localeCompare(b.name)),
    ...surroundingMatches.sort((a, b) => a.name.localeCompare(b.name)),
  ];
}

/**
 * Render candidate table for terminal display with colored status badges
 */
export function renderCandidateTable(
  candidates: CandidateVenue[],
  options?: { color?: boolean; referenceDate?: Date },
): string {
  if (!candidates || candidates.length === 0) {
    return "  (No eligible venues found matching criteria)";
  }

  const useColor = options?.color ?? true;
  const refDate = options?.referenceDate ?? new Date();

  const lines: string[] = [];
  lines.push(
    `┌─────┬──────────────────────────┬──────────────────┬──────────────────┬────────────────┬──────────────────────────┬────────────────────────────────┐`,
  );
  lines.push(
    `│ #   │ Venue Name               │ Location         │ Contact          │ Phone          │ Email                    │ Spacing Status                 │`,
  );
  lines.push(
    `├─────┼──────────────────────────┼──────────────────┼──────────────────┼────────────────┼──────────────────────────┼────────────────────────────────┤`,
  );

  candidates.forEach((c, idx) => {
    const num = String(idx + 1).padEnd(3);
    const name = c.name.slice(0, 24).padEnd(24);
    const loc = `${c.city || ""}, ${c.usState || ""}`.slice(0, 16).padEnd(16);
    const contact = (c.contactName || "—").slice(0, 16).padEnd(16);
    const phone = (c.phone || "—").slice(0, 14).padEnd(14);
    const email = (c.email || "—").slice(0, 24).padEnd(24);

    const badgeInfo = identifyCandidateBadge(c, refDate);
    const rawBadge = c.statusBadge || badgeInfo.badge;

    let badgeCol: string;
    const colWidth = 30;
    if (useColor) {
      let colorCode = "\x1b[32m"; // default green
      if (badgeInfo.cssClass === "badge-seasonal-hold") colorCode = "\x1b[36m"; // cyan
      else if (badgeInfo.cssClass === "badge-gig-spacing") colorCode = "\x1b[31m"; // red
      else if (badgeInfo.cssClass === "badge-direct-chat") colorCode = "\x1b[35m"; // magenta
      else if (badgeInfo.cssClass === "badge-cooldown") colorCode = "\x1b[34m"; // blue
      else if (badgeInfo.cssClass === "badge-returning") colorCode = "\x1b[33m"; // yellow

      const visible = rawBadge.slice(0, colWidth);
      const padding = " ".repeat(Math.max(0, colWidth - visible.length));
      badgeCol = `${colorCode}${visible}\x1b[0m${padding}`;
    } else {
      badgeCol = rawBadge.slice(0, colWidth).padEnd(colWidth);
    }

    lines.push(`│ ${num} │ ${name} │ ${loc} │ ${contact} │ ${phone} │ ${email} │ ${badgeCol} │`);
  });

  lines.push(
    `└─────┴──────────────────────────┴──────────────────┴──────────────────┴────────────────┴──────────────────────────┴────────────────────────────────┘`,
  );

  return lines.join("\n");
}

/**
 * Assess candidate density to determine if /venue-mining should be recommended
 */
export function assessDensity(
  candidates: CandidateVenue[],
  location?: TargetLocation,
  threshold = 3,
): {
  count: number;
  isSparse: boolean;
  suggestedMetro?: string;
} {
  const count = candidates.filter((c) => !c.isExcluded).length;
  const isSparse = count < threshold;

  let suggestedMetro = location?.metroSlug;
  if (!suggestedMetro && location?.city) {
    suggestedMetro = location.city.toLowerCase().replace(/\s+/g, "-");
  }

  return {
    count,
    isSparse,
    suggestedMetro,
  };
}
