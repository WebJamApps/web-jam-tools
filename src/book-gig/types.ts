// src/book-gig/types.ts — Type definitions for /book-gig skill & CLI

export interface TargetWeekend {
  start: string; // ISO date string (YYYY-MM-DD), usually Friday
  end: string; // ISO date string (YYYY-MM-DD), usually Sunday
  rawText: string;
  label: string; // e.g. "October 16–18, 2026"
  year: number;
  month: number; // 1-12
  days: number[]; // e.g. [16, 17, 18]
}

export interface TargetLocation {
  raw: string;
  city?: string;
  state?: string;
  zip?: string;
  metroSlug?: string;
}

export interface CandidateVenue {
  _id: string;
  name: string;
  city?: string;
  usState?: string;
  address?: string;
  email?: string;
  secondaryEmail?: string;
  venueType?: string;
  outreachEligible?: boolean;
  gigInterval?: number;
  reason?: {
    lastGigDate?: string | null;
    gigIntervalMonths?: number;
    nearestGigMonthsAway?: number | null;
    spacingNote?: string;
    resumeBookingExpired?: boolean;
  };
  distanceMiles?: number;
}

export interface PitchEmail {
  venueId: string;
  venueName: string;
  to: string;
  secondaryTo?: string;
  subject: string;
  body: string;
}

export interface BookGigResult {
  weekend: TargetWeekend;
  location?: TargetLocation;
  candidates: CandidateVenue[];
  density: {
    count: number;
    isSparse: boolean;
    suggestedMetro?: string;
  };
  pitches: PitchEmail[];
}
