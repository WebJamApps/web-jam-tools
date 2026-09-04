// src/book-gig/pitch.ts — Voice-rule-compliant pitch generator for /book-gig using backend template master

import type {
  CandidateVenue,
  EmailTemplate,
  PitchEmail,
  TargetWeekend,
  TemplateStage,
  TemplateVenueType,
} from "./types.ts";

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
      `[Custom Body]\n<p>We have [Target Dates] available and are looking to book a 2-3 hour set. We've spent over 12 years performing at festivals, breweries, and venues throughout Southwest Virginia, providing a versatile mix of original Americana and crowd-pleasing covers.</p>\n<p>Beyond the originals, we know how to read a room. We've built our live set across the Roanoke Valley — regular shows at Stave &amp; Cork in Salem, two summers running at the Pete Dye River Course clubhouse in Blacksburg, the Salem farmers market summer after summer, and Music in the Park up in Marion — so we're equally comfortable filling a dance floor on a Saturday night and holding a quiet room at a Sunday brunch. We bring our own PA.</p>\n<p>A few live samples from our set:</p>\n<ul>\n  <li><a href="https://www.web-jam.com/music/songs?id=66a0ec5fd1005f8095f3cef3">Proud Mary (CCR) — live at Olde Salem Brewing</a></li>\n  <li><a href="https://web-jam.com/music/songs?id=69fdcd7a586f5175c6db44a9">I'm Yours (Jason Mraz) — live at Salem Farmers Market</a></li>\n  <li><a href="https://www.web-jam.com/music/songs?id=6728e8bb25cc2073a9395c4e">Country Roads (John Denver) — live at Gusto's Pizza</a></li>\n  <li><a href="https://web-jam.com/music/songs?id=5f5e6b7d13772f0004a091ad">Misty Rainy Morning (Original)</a></li>\n</ul>\n<p>Our full performance history and music can be found at <a href="https://www.joshandmariamusic.com">joshandmariamusic.com</a>.</p>\n<p>Let me know if any of those dates work — happy to talk through details.</p>\n<p>Best,<br>Josh &amp; Maria<br>540-494-8035<br><a href="https://www.joshandmariamusic.com">joshandmariamusic.com</a></p>`,
  },
  {
    type: "PubFestivalBrewery",
    stage: "returning",
    subject: "Back at [Venue Name] this [Booking Period]? — Josh & Maria",
    introHtml:
      `<p>Hi [Contact Name],</p>\n<p>It's Josh from "Josh and Maria" — we had a blast playing [Venue Name] last time and would love to get back on your calendar.</p>`,
    bodyHtml:
      `[Custom Body]\n<p>We're booking [Booking Period] now and wanted to check with the spots we love first. Any chance [Target Dates] is open? We'd bring the same energetic 2-3 hour acoustic set — originals plus crowd-pleasing covers — and our own PA, as always.</p>\n<p>A couple of live samples:</p>\n<ul>\n  <li><a href="https://www.web-jam.com/music/songs?id=66a0ec5fd1005f8095f3cef3">Proud Mary (CCR) — live at Olde Salem Brewing</a></li>\n  <li><a href="https://web-jam.com/music/songs?id=69fdcd7a586f5175c6db44a9">I'm Yours (Jason Mraz) — live at Salem Farmers Market</a></li>\n</ul>\n<p>Thanks again for having us — hope we can make [Booking Period] work.</p>\n<p>Best,<br>Josh &amp; Maria<br>540-494-8035<br><a href="https://www.joshandmariamusic.com">joshandmariamusic.com</a></p>`,
  },
  {
    type: "Originals",
    stage: "cold",
    subject: "Performance Inquiry: Josh and Maria (Husband-Wife Acoustic Duo) — [Venue Name]",
    introHtml:
      `<p>Hi [Contact Name],</p>\n<p>My name is Josh Sherman, and I perform with my wife Maria as the acoustic duo \"Josh and Maria.\" We are a regional act based in Salem, VA, and we are currently booking our [Booking Period] run and would love to be considered for a slot at [Venue Name].</p>`,
    bodyHtml:
      `[Custom Body]\n<p>We have open availability for [Target Dates]. Our sound comes from a shared kitchen table — balancing our own songwriting with a careful selection of covers. We've built a steady regional following with regular shows at Stave &amp; Cork in Salem; two summers running at the Pete Dye River Course clubhouse in Blacksburg; the Salem farmers market summer after summer; and repeat appearances at Music in the Park in Marion. We take care of our audience and the room.</p>\n<p>A few live samples from our repertoire:</p>\n<ul>\n  <li><a href="https://www.web-jam.com/music/songs?id=66a0ec5fd1005f8095f3cef3">Proud Mary (CCR) — live at Olde Salem Brewing</a></li>\n  <li><a href="https://web-jam.com/music/songs?id=6728e8bb25cc2073a9395c4e">Country Roads (John Denver) — live at Gusto's Pizza</a></li>\n  <li><a href="https://web-jam.com/music/songs?id=69fdcc4b586f5175c6db44a7">Dark Light (Original) — live at Salem Farmers Market</a></li>\n</ul>\n<p>Full music links and performance history available at <a href="https://www.joshandmariamusic.com">joshandmariamusic.com</a>.</p>\n<p>Let me know if any of those dates work — happy to talk through details.</p>\n<p>Best,<br>Josh &amp; Maria<br>540-494-8035<br><a href="https://www.joshandmariamusic.com">joshandmariamusic.com</a></p>`,
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
  isReturningVenue?: boolean;
  bookingPeriod?: string;
  templateType?: TemplateVenueType;
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

export function resolveVenueStage(
  venue: CandidateVenue,
  options?: RenderPitchOptions,
): TemplateStage {
  if (options?.isReturningVenue) return "returning";
  if (venue.reason?.lastGigDate && venue.reason.lastGigDate !== "never") return "returning";
  return "cold";
}

export function synthesizeCustomBodyHook(
  venue: CandidateVenue,
  weekend: TargetWeekend,
  options: RenderPitchOptions = {},
): string {
  if (options.personalHook && options.personalHook.trim()) {
    const hook = options.personalHook.trim();
    return hook.startsWith("<p>") ? hook : `<p>${hook}</p>`;
  }

  // Check venue notes for prior touch or booking holds
  const combinedNotes = [
    venue.notes,
    venue.bookingNotes,
    venue.priorContactNotes,
  ].filter(Boolean).join(" ");

  if (combinedNotes) {
    const lowerNotes = combinedNotes.toLowerCase();
    if (
      lowerNotes.includes("follow up") ||
      lowerNotes.includes("january") ||
      lowerNotes.includes("2027") ||
      lowerNotes.includes("booked through") ||
      lowerNotes.includes("full for")
    ) {
      return `<p>Following up on our earlier conversation when you mentioned checking back around this time for open dates — we'd love to see if we can get on the calendar for ${weekend.label}.</p>`;
    }
    if (lowerNotes.includes("spoke with") || lowerNotes.includes("contacted")) {
      return `<p>Following up on our earlier conversation about live music dates — wanted to check if ${weekend.label} might be open for an acoustic set.</p>`;
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

  const customBody = synthesizeCustomBodyHook(venue, weekend, options);

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
  const intro = template.introHtml ? substituteTokens(template.introHtml, tokens) : "";
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
