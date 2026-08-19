// src/book-gig/types.ts — Type definitions for /book-gig skill & CLI

export type BookGigMode = "preview" | "send" | "replies";

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

export interface BatchDispatchSkipped {
  venueId: string;
  venueName: string;
  reason: string;
}

export interface BatchDispatchResult {
  requested: number;
  sent: number;
  skipped: BatchDispatchSkipped[];
  records: unknown[];
}

export interface CheckRepliesResult {
  checked: number;
  matched: number;
  classified: number;
  bounced: number;
}

export interface OutreachSuggestion {
  intent?: string;
  confidence?: number;
  action?: string;
  notes?: string;
  suggestedBookingStatus?: string;
  reviewed?: boolean;
}

export interface OutreachCampaignRecord {
  _id: string;
  venueId: string;
  venueName?: string;
  location?: string;
  targetDates?: string;
  targetWeekend?: {
    start: string | Date;
    end: string | Date;
  };
  sentAt?: string | Date;
  status: string; // 'sent' | 'replied' | 'interested' | 'booked' | 'not-interested' | 'no-response' | 'target-filled'
  replySnippet?: string;
  repliedAt?: string | Date;
  replyKind?: string;
  suggestion?: OutreachSuggestion;
  step?: number;
  templateUsed?: string;
  bookingPeriod?: string;
  gmailThreadId?: string;
  messageId?: string;
}

export interface RepliesTrackingResult {
  checkReplies: CheckRepliesResult;
  pendingReplies: OutreachCampaignRecord[];
  campaigns: OutreachCampaignRecord[];
  targetWeekend?: TargetWeekend;
}

export interface ParsedBookGigArgs {
  mode: BookGigMode;
  weekend?: TargetWeekend;
  location?: TargetLocation;
  includeVenues?: string[];
  excludeVenues?: string[];
  rawArgs: string;
}

export interface BookGigResult {
  mode: BookGigMode;
  weekend?: TargetWeekend;
  location?: TargetLocation;
  includeVenues?: string[];
  excludeVenues?: string[];
  candidates: CandidateVenue[];
  density: {
    count: number;
    isSparse: boolean;
    suggestedMetro?: string;
  };
  pitches: PitchEmail[];
  batchDispatch?: BatchDispatchResult;
  repliesTracking?: RepliesTrackingResult;
}
