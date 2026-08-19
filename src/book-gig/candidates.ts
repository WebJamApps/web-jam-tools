// src/book-gig/candidates.ts — Candidate venue query and geographic filtering for /book-gig

import type { CandidateVenue, TargetLocation, TargetWeekend } from "./types.ts";
import { resolveBackendConfig } from "./outreach_api.ts";

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

/**
 * Filter and rank candidate venues based on target location (City, State, Zip, or Metro)
 */
export function filterAndRankCandidates(
  candidates: CandidateVenue[],
  location?: TargetLocation,
): CandidateVenue[] {
  if (!candidates || candidates.length === 0) return [];
  if (!location) {
    // If no location filter, return all eligible candidates sorted by name
    return [...candidates].sort((a, b) => a.name.localeCompare(b.name));
  }

  const locCity = location.city?.toLowerCase();
  const locZip = location.zip;
  const locMetro = location.metroSlug?.toLowerCase();

  const exactMatches: CandidateVenue[] = [];
  const regionalMatches: CandidateVenue[] = [];

  for (const v of candidates) {
    const vCity = (v.city || "").toLowerCase();
    const vAddr = (v.address || "").toLowerCase();
    const vState = (v.usState || "").toUpperCase();

    let isExact = false;

    // Check exact zipcode match in address
    if (locZip && vAddr.includes(locZip)) {
      isExact = true;
    }

    // Check city equality or substring match
    if (locCity && (vCity === locCity || vAddr.includes(locCity))) {
      isExact = true;
    }

    // Check metro slug proximity
    if (locMetro && (vCity.includes(locMetro) || locMetro.includes(vCity))) {
      isExact = true;
    }

    if (isExact) {
      exactMatches.push(v);
    } else if (location.state && vState === location.state) {
      regionalMatches.push(v);
    } else if (!location.state) {
      regionalMatches.push(v);
    }
  }

  // Exact matches first, then neighboring regional matches
  return [
    ...exactMatches.sort((a, b) => a.name.localeCompare(b.name)),
    ...regionalMatches.sort((a, b) => a.name.localeCompare(b.name)),
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
