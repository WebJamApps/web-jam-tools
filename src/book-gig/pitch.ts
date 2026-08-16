// src/book-gig/pitch.ts — Voice-rule-compliant pitch generator for /book-gig

import type { CandidateVenue, PitchEmail, TargetWeekend } from "./types.ts";

export const BANNED_VOICE_WORDS = [
  "exciting",
  "opportunity",
  "passionate",
  "thrilled",
  "reach out",
  "circle back",
  "truly admire",
  "deep connection",
  "great addition",
  "perfect fit",
  "your spot",
  "dear booking manager",
  "dear manager",
];

export interface RenderPitchOptions {
  contactName?: string;
  personalHook?: string;
  isReturningVenue?: boolean;
}

/**
 * Validate that email body adheres strictly to Voice Rules in docs/cross-ai-rules.md
 */
export function validateVoiceRules(text: string): { valid: boolean; violations: string[] } {
  const lower = text.toLowerCase();
  const violations: string[] = [];

  for (const banned of BANNED_VOICE_WORDS) {
    if (lower.includes(banned)) {
      violations.push(`Contains banned phrase: "${banned}"`);
    }
  }

  // Check for banned salutations (e.g. "Dear ...")
  if (/^dear\b/i.test(text.trim())) {
    violations.push("Opens with 'Dear' instead of 'Hi' or 'Hi [Name],'");
  }

  // Check for corporate/marketing plural ("we are writing to", "we are confident")
  if (/we\s+are\s+writing\s+to/i.test(text)) {
    violations.push("Contains corporate 'we are writing to'");
  }
  if (/we\s+specialize\s+in/i.test(text)) {
    violations.push("Contains corporate 'we specialize in'");
  }
  if (/we\s+are\s+confident/i.test(text)) {
    violations.push("Contains corporate 'we are confident'");
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Render a tailored, voice-rule-compliant pitch email for a candidate venue
 */
export function renderPitch(
  venue: CandidateVenue,
  weekend: TargetWeekend,
  options: RenderPitchOptions = {},
): PitchEmail {
  const to = venue.email || "";
  const secondaryTo = venue.secondaryEmail;

  // Determine salutation
  const contact = options.contactName || "";
  const salutation = contact.trim() ? `Hi ${contact.trim()},` : "Hi,";

  // Build subject line
  const subject = `Josh & Maria Sherman - Live music for ${weekend.label} at ${venue.name}`;

  // Build personal hook or area connection if applicable
  const venueCity = (venue.city || "").toLowerCase();
  let hookLine = "";
  if (options.personalHook) {
    hookLine = ` ${options.personalHook.trim()}`;
  } else if (
    venueCity.includes("lynchburg") || venueCity.includes("forest") ||
    venueCity.includes("bedford") || venueCity.includes("rustburg")
  ) {
    hookLine =
      " My son lives in Rustburg, so we're in the area often and would love to play on your stage.";
  }

  // Compose body matching Example A & B in cross-ai-rules.md
  let body: string;
  if (
    options.isReturningVenue || (venue.reason?.lastGigDate && venue.reason.lastGigDate !== "never")
  ) {
    // Returning venue / warm tone
    body = `${salutation}

My wife Maria and I play as Josh and Maria, an acoustic duo based out of Salem, VA. We have open dates for the weekend of ${weekend.label} and would love to play a show at ${venue.name}.${hookLine}

You can hear our music and see upcoming shows at joshandmariamusic.com. Let me know if you have any music slots available for that weekend.

Thanks — Josh Sherman, joshandmariamusic.com`;
  } else {
    // New venue / professional coffee-shop tone
    body = `${salutation}

I'm Josh Sherman — my wife and I play as Josh and Maria, an acoustic duo out of Salem, VA. I came across ${venue.name} and wanted to ask about live music booking. We have open availability for the weekend of ${weekend.label}.${hookLine}

Happy to send audio samples or talk through what we play. You can also check out our site at joshandmariamusic.com.

Let me know if any slots are open for that weekend.

Thanks — Josh Sherman, joshandmariamusic.com`;
  }

  // Validate the rendered body against voice rules
  const validation = validateVoiceRules(body);
  if (!validation.valid) {
    throw new Error(`Rendered pitch failed voice rules: ${validation.violations.join("; ")}`);
  }

  return {
    venueId: venue._id,
    venueName: venue.name,
    to,
    secondaryTo,
    subject,
    body,
  };
}
