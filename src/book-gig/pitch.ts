// src/book-gig/pitch.ts — Voice-rule-compliant pitch generator for /book-gig using backend template master

import type {
  CandidateVenue,
  EmailTemplate,
  PitchEmail,
  PitchPreview,
  TargetWeekend,
  TemplateStage,
  TemplateVenueType,
  VenueTweak,
} from "./types.ts";
import { fetchPitchPreviews, type FetchPitchPreviewsOptions } from "./outreach_api.ts";

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

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const DEFAULT_TEMPLATES: EmailTemplate[] = [
  {
    type: "PubFestivalBrewery",
    stage: "cold",
    subject:
      "Performance Inquiry: Josh and Maria — Acoustic Duo for [Booking Period] — [Venue Name]",
    introHtml:
      `<p>Hi [Contact Name],</p>\n<p>My name is Josh Sherman — my wife and I play as Josh and Maria, a professional husband-wife acoustic duo based in Salem, VA. We still have a few [Booking Period] dates open and would love to bring our energetic acoustic set to [Venue Name].</p>`,
    bodyHtml:
      `[Custom Body]\n<p>We have [Target Dates] available and are looking to book a 2-3 hour set. We've spent over 12 years performing at festivals, breweries, and venues throughout Southwest Virginia, providing a versatile mix of original Americana and crowd-pleasing covers.</p>\n<p>Beyond the originals, we know how to read a room. We've built our live set across the Roanoke Valley — regular shows at Stave &amp; Cork in Salem, two summers running at the Pete Dye River Course clubhouse in Blacksburg, the Salem farmers market summer after summer, and Music in the Park up in Marion — so we're equally comfortable filling a dance floor on a Saturday night and holding a quiet room at a Sunday brunch. We bring our own PA.</p>\n<p>A few live samples from our set:</p>\n<ul>\n  <li><a href="https://www.web-jam.com/music/songs?id=66a0ec5fd1005f8095f3cef3">Proud Mary (CCR) — live at Olde Salem Brewing</a></li>\n  <li><a href="https://web-jam.com/music/songs?id=69fdcd7a586f5175c6db44a9">I'm Yours (Jason Mraz) — live at Salem Farmers Market</a></li>\n  <li><a href="https://web-jam.com/music/songs?id=6728e8bb25cc2073a9395c4e">Country Roads (John Denver) — live at Gusto's Pizza</a></li>\n  <li><a href="https://web-jam.com/music/songs?id=5f5e6b7d13772f0004a091ad">Misty Rainy Morning (Original)</a></li>\n</ul>\n<p>Our full performance history and music can be found at <a href="https://www.joshandmariamusic.com">joshandmariamusic.com</a>.</p>\n<p>Let me know if any of those dates work — happy to talk through details.</p>\n<p>Best,<br>Josh &amp; Maria<br>540-494-8035<br><a href="https://www.joshandmariamusic.com">joshandmariamusic.com</a></p>`,
  },
  {
    type: "PubFestivalBrewery",
    stage: "returning",
    subject: "Back at [Venue Name] this [Booking Period]? — Josh & Maria",
    introHtml:
      `<p>Hi [Contact Name],</p>\n<p>It's Josh from "Josh and Maria" — we had a blast playing [Venue Name] last time and would love to get back on your calendar.</p>`,
    bodyHtml:
      `[Custom Body]\n<p>We're booking [Booking Period] now and wanted to check with the spots we love first. Any chance [Target Dates] is open? We'd bring the same energetic 2-3 hour acoustic set — originals plus crowd-pleasing covers — and our own PA, as always.</p>\n<p>A couple of live samples:</p>\n<ul>\n  <li><a href="https://www.web-jam.com/music/songs?id=66a0ec5fd1005f8095f3cef3">Proud Mary (CCR) — live at Olde Salem Brewing</a></li>\n  <li><a href="https://www.web-jam.com/music/songs?id=69fdcd7a586f5175c6db44a9">I'm Yours (Jason Mraz) — live at Salem Farmers Market</a></li>\n</ul>\n<p>Thanks again for having us — hope we can make [Booking Period] work.</p>\n<p>Best,<br>Josh &amp; Maria<br>540-494-8035<br><a href="https://www.joshandmariamusic.com">joshandmariamusic.com</a></p>`,
  },
  {
    type: "Originals",
    stage: "cold",
    subject: "Performance Inquiry: Josh and Maria (Husband-Wife Acoustic Duo) — [Venue Name]",
    introHtml:
      `<p>Hi [Contact Name],</p>\n<p>My name is Josh Sherman, and I perform with my wife Maria as the acoustic duo \"Josh and Maria.\" We are a regional act based in Salem, VA, and we are currently booking our [Booking Period] run and would love to be considered for a slot at [Venue Name].</p>`,
    bodyHtml:
      `[Custom Body]\n<p>We have open availability for [Target Dates]. Our sound comes from a shared kitchen table — balancing our own songwriting with a careful selection of covers. We've built a steady regional following with regular shows at Stave &amp; Cork in Salem; two summers running at the Pete Dye River Course clubhouse in Blacksburg; the Salem farmers market summer after summer; and repeat appearances at Music in the Park in Marion. We take care of our audience and the room.</p>\n<p>A few live samples from our repertoire:</p>\n<ul>\n  <li><a href="https://www.web-jam.com/music/songs?id=66a0ec5fd1005f8095f3cef3">Proud Mary (CCR) — live at Olde Salem Brewing</a></li>\n  <li><a href="https://www.web-jam.com/music/songs?id=6728e8bb25cc2073a9395c4e">Country Roads (John Denver) — live at Gusto's Pizza</a></li>\n  <li><a href="https://web-jam.com/music/songs?id=69fdcc4b586f5175c6db44a9">Dark Light (Original) — live at Salem Farmers Market</a></li>\n</ul>\n<p>Full music links and performance history available at <a href="https://www.joshandmariamusic.com">joshandmariamusic.com</a>.</p>\n<p>Let me know if any of those dates work — happy to talk through details.</p>\n<p>Best,<br>Josh &amp; Maria<br>540-494-8035<br><a href="https://www.joshandmariamusic.com">joshandmariamusic.com</a></p>`,
  },
  {
    type: "Originals",
    stage: "returning",
    subject: "Love to play [Venue Name] again — Josh & Maria",
    introHtml:
      `<p>Hi [Contact Name],</p>\n<p>It's Josh — my wife Maria and I (the husband-wife acoustic duo \"Josh and Maria\") had such a good time the last time we played [Venue Name], and we'd love to come back.</p>`,
    bodyHtml:
      `[Custom Body]\n<p>We're booking our [Booking Period] run now and wanted to check in first with the listening rooms that have been good to us. Could we grab a slot on [Target Dates]? We'd bring fresh originals alongside the close-harmony Americana set you already know.</p>\n<p>A couple of recent live recordings, in case it's helpful:</p>\n<ul>\n  <li><a href="https://web-jam.com/music/songs?id=69fdcc4b586f5175c6db44a7">Dark Light (Original) — live at Salem Farmers Market</a></li>\n  <li><a href="https://web-jam.com/music/songs?id=5f5e6b7d13772f0004a091ad">Misty Rainy Morning (Original)</a></li>\n</ul>\n<p>Thanks again for having us before — hope we can make something work for [Booking Period].</p>\n<p>Best,<br>Josh &amp; Maria<br>540-494-8035<br><a href="https://www.joshandmariamusic.com">joshandmariamusic.com</a></p>`,
  },
  {
    type: "MidRangeCafeBar",
    stage: "cold",
    subject:
      "Performance Inquiry: Josh and Maria — Acoustic Duo for [Booking Period] — [Venue Name]",
    introHtml:
      `<p>Hi [Contact Name],</p>\n<p>My name is Josh Sherman — my wife Maria and I play as Josh and Maria, an acoustic duo based in Salem, VA. We are currently scheduling [Booking Period] live music and would love to perform at [Venue Name].</p>`,
    bodyHtml:
      `[Custom Body]\n<p>We have [Target Dates] open and offer a 2-3 hour acoustic set tailored for a relaxed dining or listening atmosphere, blending original songs with familiar favorites.</p>\n<p>A couple of live recordings:</p>\n<ul>\n  <li><a href="https://www.web-jam.com/music/songs?id=66a0ec5fd1005f8095f3cef3">Proud Mary (CCR) — live at Olde Salem Brewing</a></li>\n  <li><a href="https://www.web-jam.com/music/songs?id=6728e8bb25cc2073a9395c4e">Country Roads (John Denver) — live at Gusto's Pizza</a></li>\n</ul>\n<p>Full bio and music links available at <a href="https://www.joshandmariamusic.com">joshandmariamusic.com</a>.</p>\n<p>Thanks — Josh Sherman, 540-494-8035</p>`,
  },
  {
    type: "MidRangeCafeBar",
    stage: "returning",
    subject: "Back at [Venue Name]? — Josh & Maria",
    introHtml:
      `<p>Hi [Contact Name],</p>\n<p>It's Josh from "Josh and Maria" — Maria and I really enjoyed our last show at [Venue Name], and we'd love to come back.</p>`,
    bodyHtml:
      `[Custom Body]\n<p>We're lining up our [Booking Period] dates and wanted to check in with our favorite rooms first. Would [Target Dates] work for another evening of harmony-driven Americana — the mix of originals and select covers your crowd seemed to enjoy?</p>\n<p>A couple of live samples as a refresher:</p>\n<ul>\n  <li><a href="https://www.web-jam.com/music/songs?id=66a0ec5fd1005f8095f3cef3">Proud Mary (CCR) — live at Olde Salem Brewing</a></li>\n  <li><a href="https://www.web-jam.com/music/songs?id=6728e8bb25cc2073a9395c4e">Country Roads (John Denver) — live at Gusto's Pizza</a></li>\n</ul>\n<p>Thanks again for having us — hope we can find a date that works.</p>\n<p>Best,<br>Josh &amp; Maria<br>540-494-8035<br><a href="https://www.joshandmariamusic.com">joshandmariamusic.com</a></p>`,
  },
];

export interface RenderPitchOptions {
  contactName?: string;
  personalHook?: string;
  customBody?: string;
  customIntro?: string;
  isReturningVenue?: boolean;
  bookingPeriod?: string;
  templateType?: TemplateVenueType;
  hasConversationIntro?: boolean;
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
 * Convert HTML email markup to clean, natural plain text.
 */
export function htmlToPlainText(html: string): string {
  let text = html;

  // Replace <p>...</p> blocks with text and double newline
  text = text.replace(/<p\b[^>]*>(.*?)<\/p>/gis, "$1\n\n");

  // Replace <br\s*/?> with single newline
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Replace <li>...</li> items with bullet points
  text = text.replace(/<li\b[^>]*>(.*?)<\/li>/gis, "• $1\n");

  // Remove <ul>, <ol>, </ul>, </ol>
  text = text.replace(/<\/?(?:ul|ol)\b[^>]*>/gi, "");

  // Replace <a href="URL">TEXT</a>
  text = text.replace(
    /<a\b[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gis,
    (_match, href, anchorText) => {
      const trimmedAnchor = anchorText.trim();
      const trimmedHref = href.trim();
      if (!trimmedAnchor || trimmedAnchor === trimmedHref || trimmedHref.includes(trimmedAnchor)) {
        return trimmedAnchor || trimmedHref;
      }
      return `${trimmedAnchor} (${trimmedHref})`;
    },
  );

  // Decode standard HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Strip any remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Clean up whitespace: normalize multiple empty lines to at most 2 newlines
  text = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

export function resolveVenueTemplateType(
  venue: CandidateVenue,
  override?: TemplateVenueType,
): TemplateVenueType {
  if (override) return override;
  if (venue.templateOverride) return venue.templateOverride as TemplateVenueType;
  const vt = venue.venueType;
  if (
    vt === "Originals" || vt === "PubFestivalBrewery" || vt === "MidRangeCafeBar" ||
    vt === "OnlineForm"
  ) {
    return vt;
  }
  if (
    vt === "Brewery" || vt === "Pub" || vt === "Festival" || vt === "Bar/Restaurant" ||
    vt === "FarmersMarket"
  ) {
    return "PubFestivalBrewery";
  }
  if (vt === "CoffeeShop" || vt === "Cafe" || vt === "Winery") {
    return "MidRangeCafeBar";
  }
  return "PubFestivalBrewery";
}

/**
 * Resolve the intro HTML a rendered pitch is entitled to use for a given template, stage,
 * and detected conversation context. Extracted so the same set of legitimate, deterministic
 * intro variants is used both by `renderPitch` and by `verifyPitchAgainstTemplate` — the
 * verifier must recognize these canned variants as part of the declared rendering mechanism
 * rather than flagging them as invented text (D-50).
 */
export function resolveIntroHtml(
  template: EmailTemplate,
  stage: TemplateStage,
  conversationContext: ConversationContext,
): string {
  if (conversationContext === "phone") {
    return stage === "returning"
      ? `<p>Hi [Contact Name],</p>\n<p>Following up on our recent phone conversation — it's always great playing for you guys at [Venue Name], and we'd love to return on [Target Dates].</p>`
      : `<p>Hi [Contact Name],</p>\n<p>Following up on our recent phone conversation — wanted to check if [Target Dates] might work for an acoustic set at [Venue Name].</p>`;
  }
  if (conversationContext === "in-person") {
    return stage === "returning"
      ? `<p>Hi [Contact Name],</p>\n<p>Following up on connecting in person — it's always great playing for you guys at [Venue Name], and we'd love to return on [Target Dates].</p>`
      : `<p>Hi [Contact Name],</p>\n<p>Following up on connecting in person — wanted to check if [Target Dates] might work for an acoustic set at [Venue Name].</p>`;
  }
  if (conversationContext === "general") {
    return stage === "returning"
      ? `<p>Hi [Contact Name],</p>\n<p>Following up on our earlier conversation — it's always great playing for you guys at [Venue Name], and we'd love to return on [Target Dates].</p>`
      : `<p>Hi [Contact Name],</p>\n<p>Following up on our earlier conversation — wanted to check if [Target Dates] might work for an acoustic set at [Venue Name].</p>`;
  }
  if (stage === "returning") {
    return template.introHtml?.trim()
      ? template.introHtml
      : `<p>Hi [Contact Name],</p>\n<p>It's Josh from "Josh and Maria" — we had a blast playing [Venue Name] last time and would love to get back on your calendar.</p>`;
  }
  return template.introHtml || "";
}

export type ConversationContext = "phone" | "in-person" | "general" | null;

const IN_PERSON_CONVERSATION_RE =
  /\b(in[- ]person|face[- ]to[- ]face|stopped by|visited (?:in person|the venue|them)|met in person|connecting in person)\b/i;
const PHONE_CONVERSATION_RE = /\b(phone|call|called|telephoned)\b/i;
const GENERAL_CONVERSATION_RE =
  /\b(conversation|spoke|spoken|talked|chat|chatted|discussed|contacted|follow(?:ed)?[- ]?up)\b/i;

export function detectConversationContext(venue: CandidateVenue): ConversationContext {
  const combinedNotes = [
    venue.contactNotes,
    venue.priorContactNotes,
    venue.bookingNotes,
    venue.notes,
  ].filter(Boolean).join(" ");

  if (!combinedNotes.trim()) return null;

  // Clean out explicit phone number patterns like "Phone: 540-123-4567" so bare phone numbers don't trigger phone conversation
  const cleanedNotes = combinedNotes
    .replace(
      /(?:cell|phone|tel)(?:\s*(?:#|number|no\.?))?\s*(?::\s*[\d\(\)\-\.\s]+|[\d\(\)\-\.]{7,})/gi,
      " ",
    )
    .trim();

  if (IN_PERSON_CONVERSATION_RE.test(cleanedNotes)) {
    return "in-person";
  }
  if (PHONE_CONVERSATION_RE.test(cleanedNotes)) {
    return "phone";
  }
  if (GENERAL_CONVERSATION_RE.test(cleanedNotes)) {
    return "general";
  }

  return null;
}

export function resolveVenueStage(
  venue: CandidateVenue,
  options?: RenderPitchOptions,
): TemplateStage {
  if (options?.isReturningVenue) return "returning";
  if (venue.reason?.lastGigDate && venue.reason.lastGigDate !== "never") return "returning";
  if (
    venue.priorGigs &&
    (Array.isArray(venue.priorGigs) ? venue.priorGigs.length > 0 : Boolean(venue.priorGigs))
  ) {
    return "returning";
  }
  return "cold";
}

export function synthesizeCustomBodyHook(
  venue: CandidateVenue,
  weekend: TargetWeekend,
  options: RenderPitchOptions = {},
): string {
  const hookText = options.customBody || options.personalHook;
  if (hookText && hookText.trim()) {
    const hook = hookText.trim();
    return hook.startsWith("<p>") ? hook : `<p>${hook}</p>`;
  }

  // Check venue notes for prior touch or booking holds
  const combinedNotes = [
    venue.notes,
    venue.bookingNotes,
    venue.contactNotes,
    venue.priorContactNotes,
  ].filter(Boolean).join(" ");

  const hasConversationIntro = options.hasConversationIntro ??
    Boolean(detectConversationContext(venue));

  if (combinedNotes) {
    const lowerNotes = combinedNotes.toLowerCase();
    if (
      lowerNotes.includes("follow up") ||
      lowerNotes.includes("january") ||
      lowerNotes.includes("2027") ||
      lowerNotes.includes("booked through") ||
      lowerNotes.includes("full for")
    ) {
      if (hasConversationIntro) {
        return `<p>You mentioned checking back around this time for open dates — we'd love to see if we can get on the calendar for ${weekend.label}.</p>`;
      }
      return `<p>Following up on our earlier conversation when you mentioned checking back around this time for open dates — we'd love to see if we can get on the calendar for ${weekend.label}.</p>`;
    }
    if (lowerNotes.includes("spoke with") || lowerNotes.includes("contacted")) {
      if (!hasConversationIntro) {
        return `<p>Following up on our earlier conversation about live music dates — wanted to check if ${weekend.label} might be open for an acoustic set.</p>`;
      }
    }
  }

  // Location-based hook (e.g. Lynchburg/Rustburg area)
  const venueCity = (venue.city || "").toLowerCase();
  if (
    venueCity.includes("lynchburg") ||
    venueCity.includes("forest") ||
    venueCity.includes("bedford") ||
    venueCity.includes("rustburg")
  ) {
    return `<p>My son lives in Rustburg, so we're in the area often and would love to play on your stage.</p>`;
  }

  return "";
}

function substituteTokens(
  templateText: string,
  tokens: {
    contactName?: string;
    venueName: string;
    targetDates: string;
    bookingPeriod: string;
    customBody?: string;
  },
): string {
  let result = templateText;

  // 1. Replace [Custom Body]
  if (tokens.customBody && tokens.customBody.trim()) {
    result = result.replace(/\[Custom Body\]\r?\n?/gi, `${tokens.customBody.trim()}\n`);
  } else {
    result = result.replace(/\[Custom Body\]\r?\n?/gi, "");
  }

  // 2. Replace [Contact Name]
  if (tokens.contactName && tokens.contactName.trim()) {
    result = result.replace(/\[Contact Name\]/gi, tokens.contactName.trim());
  } else {
    // If no contact name provided, format "Hi [Contact Name]," to "Hi," cleanly
    result = result.replace(/Hi\s+\[Contact Name\],/gi, "Hi,");
    result = result.replace(/\[Contact Name\]/gi, "");
  }

  // 3. Replace [Venue Name]
  result = result.replace(/\[Venue Name\]/gi, tokens.venueName);

  // 4. Replace [Target Dates]
  result = result.replace(/\[Target Dates\]/gi, tokens.targetDates);

  // 5. Replace [Booking Period]
  result = result.replace(/\[Booking Period\]/gi, tokens.bookingPeriod);

  return result;
}

/**
 * Render a tailored, voice-rule-compliant pitch email for a candidate venue using template master.
 */
export function renderPitch(
  venue: CandidateVenue,
  weekend: TargetWeekend,
  options: RenderPitchOptions = {},
  templates: EmailTemplate[] = [],
): PitchEmail {
  const to = venue.email || "";
  const secondaryTo = venue.secondaryEmail;

  const type = resolveVenueTemplateType(venue, options.templateType);
  const stage = resolveVenueStage(venue, options);

  // Find matching template from fetched templates or default fallback pool
  const allTemplates = templates && templates.length > 0 ? templates : DEFAULT_TEMPLATES;
  const template =
    allTemplates.find((t) =>
      t.active !== false && t.type === type && (t.stage || "cold") === stage
    ) ||
    allTemplates.find((t) =>
      t.active !== false && t.type === "PubFestivalBrewery" && (t.stage || "cold") === stage
    ) ||
    DEFAULT_TEMPLATES.find((t) => t.type === type && t.stage === stage) ||
    DEFAULT_TEMPLATES[0];

  const monthName = MONTH_NAMES[(weekend.month || 1) - 1] || "October";
  const bookingPeriod = options.bookingPeriod || `${monthName} ${weekend.year}`;
  const contactName = options.contactName || venue.contactName || "";

  const conversationContext = detectConversationContext(venue);
  const introHtml = resolveIntroHtml(template, stage, conversationContext);

  const hasConversationIntro = Boolean(conversationContext);
  const customBody = synthesizeCustomBodyHook(venue, weekend, {
    ...options,
    hasConversationIntro,
  });

  const tokens = {
    contactName,
    venueName: venue.name,
    targetDates: weekend.label,
    bookingPeriod,
    customBody,
  };

  // Build subject line
  let subject = template.subject
    ? substituteTokens(template.subject, tokens)
    : `Performance Inquiry: Josh and Maria — Acoustic Duo for ${bookingPeriod} — ${venue.name}`;
  subject = subject.replace(/\s+/g, " ").trim();

  // Build HTML body
  const intro = introHtml ? substituteTokens(introHtml, tokens) : "";
  const body = template.bodyHtml ? substituteTokens(template.bodyHtml, tokens) : "";
  const htmlBody = `${intro}\n${body}`.trim();

  // Convert to clean plain text
  const plainTextBody = htmlToPlainText(htmlBody);

  // Validate the rendered body against voice rules
  const validation = validateVoiceRules(plainTextBody);
  if (!validation.valid) {
    throw new Error(`Rendered pitch failed voice rules: ${validation.violations.join("; ")}`);
  }

  return {
    venueId: venue._id,
    venueName: venue.name,
    to,
    secondaryTo,
    contactName: options.contactName || venue.contactName,
    phone: venue.phone,
    subject,
    body: plainTextBody,
    htmlBody,
    templateType: template.type,
    templateStage: template.stage || stage,
  };
}

// --- Template fidelity verification (D-50) --------------------------------------------------
//
// Every rendered email is checked against the canonical stored `Template` record it claims to
// come from (its declared `templateType` / `templateStage`), with variation strictly confined
// to the declared placeholder substitutions. Text that came from neither the template nor a
// declared placeholder is a mismatch and refuses the batch (Step 5, D-50).

export interface TemplateViolation {
  venueId: string;
  venueName: string;
  reason: string;
}

export interface TemplateVerificationResult {
  valid: boolean;
  violations: TemplateViolation[];
}

// Internal marker swapped in for the literal "[Custom Body]" token so its exact insertion
// point — and the whitespace the real substitution logic treats specially around it — can be
// located precisely, without disturbing any of the other declared placeholders.
const CUSTOM_BODY_MARKER = " __BOOK_GIG_CUSTOM_BODY_MARKER__ ";

function substituteNonCustomBodyTokens(
  templateText: string,
  tokens: {
    contactName?: string;
    venueName: string;
    targetDates: string;
    bookingPeriod: string;
  },
): string {
  // Protect "[Custom Body]" from substituteTokens' own custom-body handling so every other
  // declared placeholder still resolves exactly as it would for a real render.
  const protectedText = templateText.replace(/\[Custom Body\]/gi, CUSTOM_BODY_MARKER);
  return substituteTokens(protectedText, { ...tokens, customBody: undefined });
}

function findDeclaredTemplate(
  pitch: PitchEmail,
  templates: EmailTemplate[],
): EmailTemplate | undefined {
  const type = pitch.templateType as TemplateVenueType | undefined;
  const stage: TemplateStage = (pitch.templateStage as TemplateStage) || "cold";
  if (!type) return undefined;
  const pool = templates && templates.length > 0 ? templates : DEFAULT_TEMPLATES;
  return (
    pool.find((t) => t.active !== false && t.type === type && (t.stage || "cold") === stage) ||
    DEFAULT_TEMPLATES.find((t) => t.type === type && (t.stage || "cold") === stage)
  );
}

/**
 * Verify a single rendered pitch email against the canonical stored Template record it claims
 * to come from. Returns `null` when the email is faithful to that template (fixed prose intact,
 * variation confined to declared placeholders and the free-form `[Custom Body]` slot), or a
 * `TemplateViolation` describing the divergence otherwise.
 */
export function verifyPitchAgainstTemplate(
  pitch: PitchEmail,
  venue: CandidateVenue,
  weekend: TargetWeekend,
  options: RenderPitchOptions = {},
  templates: EmailTemplate[] = [],
): TemplateViolation | null {
  const violation = (reason: string): TemplateViolation => ({
    venueId: pitch.venueId,
    venueName: pitch.venueName,
    reason,
  });

  const template = findDeclaredTemplate(pitch, templates);
  if (!template) {
    return violation(
      `No stored Template record found matching the declared type "${pitch.templateType}" / stage "${pitch.templateStage}" — cannot verify fidelity.`,
    );
  }

  const stage: TemplateStage = (pitch.templateStage as TemplateStage) ||
    resolveVenueStage(venue, options);
  const conversationContext = detectConversationContext(venue);
  const expectedIntroHtml = resolveIntroHtml(template, stage, conversationContext);

  const monthName = MONTH_NAMES[(weekend.month || 1) - 1] || "October";
  const bookingPeriod = options.bookingPeriod || `${monthName} ${weekend.year}`;
  const contactName = options.contactName || venue.contactName || pitch.contactName || "";

  const tokens = {
    contactName,
    venueName: venue.name || pitch.venueName,
    targetDates: weekend.label,
    bookingPeriod,
  };

  // Subject carries no [Custom Body] slot: it must equal the declared template exactly.
  if (template.subject) {
    const expectedSubject = substituteNonCustomBodyTokens(template.subject, tokens)
      .replace(/\s+/g, " ")
      .trim();
    if (pitch.subject !== expectedSubject) {
      return violation(
        `Subject diverges from stored template "${template.type}/${stage}": expected "${expectedSubject}", got "${pitch.subject}".`,
      );
    }
  }

  const introResolved = expectedIntroHtml
    ? substituteNonCustomBodyTokens(expectedIntroHtml, tokens)
    : "";
  const bodyResolved = template.bodyHtml
    ? substituteNonCustomBodyTokens(template.bodyHtml, tokens)
    : "";
  const skeleton = `${introResolved}\n${bodyResolved}`.trim();

  const actualHtml = pitch.htmlBody || "";
  const markerIndex = skeleton.indexOf(CUSTOM_BODY_MARKER);

  if (markerIndex === -1) {
    // No declared [Custom Body] slot in this template: the fixed prose must match exactly.
    if (actualHtml !== skeleton) {
      return violation(
        `Rendered body diverges from stored template "${template.type}/${stage}" outside its declared placeholders.`,
      );
    }
    return null;
  }

  const prefix = skeleton.slice(0, markerIndex);
  const suffix = skeleton.slice(markerIndex + CUSTOM_BODY_MARKER.length);

  // Empty custom body: the real renderer removes the marker AND its one trailing newline
  // together, so no gap remains at all.
  const emptyVariant = prefix + suffix.replace(/^\r?\n/, "");
  if (actualHtml === emptyVariant) {
    return null;
  }

  // Non-empty custom body: the marker is replaced by trimmed free-form content plus a
  // newline, so the fixed prose on either side — suffix included, with its newline — must
  // still reappear verbatim, with only the [Custom Body] slot's content varying.
  if (
    actualHtml.startsWith(prefix) &&
    actualHtml.endsWith(suffix) &&
    actualHtml.length > prefix.length + suffix.length
  ) {
    return null;
  }

  return violation(
    `Rendered body diverges from stored template "${template.type}/${stage}" outside its declared placeholders (Custom Body slot excepted).`,
  );
}

/**
 * Verify every rendered pitch in a batch against its stored template. Any single divergence
 * refuses the whole batch on the same terms as a broken fingerprint (D-50) — never a partial
 * send of only the venues that still match.
 */
export function verifyBatchAgainstTemplates(
  pitches: PitchEmail[],
  venues: CandidateVenue[],
  weekend: TargetWeekend,
  templates: EmailTemplate[] = [],
  optionsByVenueId: Record<string, RenderPitchOptions> = {},
): TemplateVerificationResult {
  const venueById = new Map(venues.map((v) => [v._id, v]));
  const violations: TemplateViolation[] = [];

  for (const pitch of pitches) {
    const venue = venueById.get(pitch.venueId);
    if (!venue) {
      violations.push({
        venueId: pitch.venueId,
        venueName: pitch.venueName,
        reason: "No matching candidate venue found to verify this pitch against its template.",
      });
      continue;
    }
    const violation = verifyPitchAgainstTemplate(
      pitch,
      venue,
      weekend,
      optionsByVenueId[pitch.venueId] || {},
      templates,
    );
    if (violation) violations.push(violation);
  }

  return { valid: violations.length === 0, violations };
}

export interface RenderPitchesFromBackendOptions
  extends Omit<FetchPitchPreviewsOptions, "venueIds" | "targetDates" | "templateType"> {
  templateType?: TemplateVenueType;
  tweaks?: VenueTweak[] | Map<string, VenueTweak>;
}

export function findTweakForCandidate(
  c: CandidateVenue,
  tweaks?: VenueTweak[] | Map<string, VenueTweak>,
): VenueTweak | undefined {
  if (!tweaks) return undefined;
  if (tweaks instanceof Map) {
    if (c._id && tweaks.has(String(c._id))) return tweaks.get(String(c._id));
    for (const [key, tweak] of tweaks.entries()) {
      if (
        (tweak.venueId && tweak.venueId === c._id) ||
        (tweak.venueName && tweak.venueName.toLowerCase() === c.name.toLowerCase()) ||
        key.toLowerCase() === c.name.toLowerCase() ||
        key === c._id
      ) {
        return tweak;
      }
    }
    return undefined;
  }
  if (Array.isArray(tweaks)) {
    return tweaks.find(
      (t) =>
        (t.venueId && t.venueId === c._id) ||
        (t.venueName && t.venueName.toLowerCase() === c.name.toLowerCase()),
    );
  }
  return undefined;
}

/**
 * Render every eligible candidate's pitch draft using the backend's own
 * rendering (`buildPitchEmail`, via the batch form of `GET /outreach/preview`)
 * rather than the local template renderer above (web-jam-tools#948). The
 * subject and HTML body returned here are byte-identical to what
 * `POST /outreach/batch` will mail, because both paths call the same backend
 * function — see the design doc's load-bearing premise 17.
 *
 * If `options.tweaks` contains custom slot modifications for specific venues,
 * those venues are re-rendered individually with their custom slots (e.g. `customBody`),
 * while all other venues remain completely untouched (D-44, Gate 2 review loop).
 *
 * Eligibility mirrors the local pool used elsewhere in the CLI: a candidate
 * needs an `_id` and a booking `email`, and must not be `isExcluded`. A venue
 * the backend cannot resolve or render is silently absent from the result
 * (`fetchPitchPreviews` already logs a warning for the request as a whole)
 * rather than falling back to a local rendering that could diverge from the
 * copy that actually gets dispatched.
 */
export async function renderPitchesFromBackend(
  candidates: CandidateVenue[],
  weekend: TargetWeekend,
  options: RenderPitchesFromBackendOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<PitchEmail[]> {
  const eligible = candidates.filter((c) => c._id && c.email && !c.isExcluded);
  if (eligible.length === 0) return [];

  const untweaked = eligible.filter((c) => !findTweakForCandidate(c, options.tweaks));
  const tweaked = eligible.filter((c) => Boolean(findTweakForCandidate(c, options.tweaks)));

  const previewPromises: Promise<PitchPreview[]>[] = [];

  if (untweaked.length > 0) {
    previewPromises.push(
      fetchPitchPreviews(
        {
          backendUrl: options.backendUrl,
          token: options.token,
          venueIds: untweaked.map((c) => c._id),
          templateType: options.templateType,
          targetDates: weekend.label,
          bookingPeriod: options.bookingPeriod,
        },
        fetchFn,
      ),
    );
  }

  for (const c of tweaked) {
    const tweak = findTweakForCandidate(c, options.tweaks);
    previewPromises.push(
      fetchPitchPreviews(
        {
          backendUrl: options.backendUrl,
          token: options.token,
          venueIds: [c._id],
          templateType: options.templateType,
          targetDates: weekend.label,
          bookingPeriod: options.bookingPeriod,
          customBody: tweak?.customBody,
          customIntro: tweak?.customIntro,
        },
        fetchFn,
      ),
    );
  }

  const previewArrays = await Promise.all(previewPromises);
  const previews = previewArrays.flat();
  const previewByVenueId = new Map(previews.map((p) => [String(p.venueId), p]));

  const pitches: PitchEmail[] = [];
  for (const c of eligible) {
    const preview = previewByVenueId.get(String(c._id));
    if (!preview) continue;
    pitches.push({
      venueId: c._id,
      venueName: preview.venueName || c.name,
      to: c.email || "",
      secondaryTo: c.secondaryEmail,
      contactName: c.contactName,
      phone: c.phone,
      subject: preview.subject,
      body: htmlToPlainText(preview.body || ""),
      htmlBody: preview.body || "",
      templateType: resolveVenueTemplateType(c, options.templateType),
      templateStage: resolveVenueStage(c, options),
    });
  }
  return pitches;
}
