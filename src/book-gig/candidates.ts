// src/book-gig/candidates.ts — Candidate venue query and geographic filtering for /book-gig

import type { CandidateVenue, TargetLocation, TargetWeekend } from "./types.ts";
import { resolveBackendConfig } from "./outreach_api.ts";
import { getDefaultLocation, US_STATES } from "./parser.ts";

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

  try {
    const res = await fetchFn(url, { headers });
    if (!res.ok) {
      console.warn(`[book-gig] Candidates query returned HTTP ${res.status}: ${res.statusText}`);
      return [];
    }

    const data = await res.json();
    if (Array.isArray(data)) {
      return data as CandidateVenue[];
    } else if (data && Array.isArray(data.candidates)) {
      return data.candidates as CandidateVenue[];
    }
    return [];
  } catch (err) {
    console.warn(`[book-gig] Error fetching candidates from ${url}: ${(err as Error).message}`);
    return [];
  }
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
 * Filter and rank candidate venues based on target location (City, State, Zip, or Metro)
 */
export function filterAndRankCandidates(
  candidates: CandidateVenue[],
  location?: TargetLocation,
): CandidateVenue[] {
  if (!candidates || candidates.length === 0) return [];
  const targetLoc = location || getDefaultLocation();

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
    const vCity = (v.city || "").toLowerCase().trim();
    const vAddr = (v.address || "").toLowerCase();
    let vState = (v.usState || "").toUpperCase().trim();
    if (!vState && v.address) {
      const stateMatch = v.address.match(/\b([A-Z]{2})\b(?:\s+\d{5})?$/i);
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
      exactMatches.push(v);
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
      surroundingMatches.push(v);
    }
  }

  // Exact matches first, then neighboring surrounding matches
  return [
    ...exactMatches.sort((a, b) => a.name.localeCompare(b.name)),
    ...surroundingMatches.sort((a, b) => a.name.localeCompare(b.name)),
  ];
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
  const count = candidates.length;
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
