// Venue contact/address extractor with Playwright fallback (web-jam-tools#210).
//
// Code companion to the /venue-mining skill (web-jam-tools#208): given a
// venue's website, tries a plain HTTP fetch first, and only falls back to a
// real browser (Playwright) when the plain fetch yields a client-rendered
// shell with no meaningful text. Follows a small, bounded set of
// contact-bearing internal links (/contact, /about, /events, /booking, and
// footer-style links whose text matches) — never a full crawl of the site.
//
// Playwright dependency decision: this module DRIVES the Playwright install
// already declared in this repo's deno.json (`npm:playwright`, the same
// package src/gig-scraper uses) rather than adding a second one. One
// Playwright install per repo is enough; `defaultRender` below is the only
// place that imports it, and it does so lazily (dynamic `import()`) so a
// plain-fetch-only run — and every unit test, which injects its own
// `renderImpl` stub — never has to load or launch a browser.
//
// Never invents a value: every extractor here returns null/empty when it
// finds nothing, rather than guessing. Callers must not fabricate contact
// data from a `null`/empty result.

import * as cheerio from "cheerio";

export type FetchPath = "plain" | "playwright" | "failed";

export interface EmailHit {
  /** Lowercased email address. */
  email: string;
  /** The page URL this address was found on. */
  sourceUrl: string;
}

export interface VenueContactResult {
  emails: EmailHit[];
  /** A street address if one was found on any visited page, else null. */
  address: string | null;
  /** Which fetch path produced the landing-page result, for debuggability. */
  fetchPath: FetchPath;
  /** Every page URL actually fetched (landing page + any followed links). */
  pagesVisited: string[];
  /** Set when the whole run failed (dead/slow host, browser failure, etc). */
  error: string | null;
  /** True when the page content matches venue name + city/address. */
  identifiesVenue?: boolean;
}

export interface ExtractOptions {
  /** Venue name — when set, the page is checked for whether it identifies as this venue. */
  name?: string;
  /**
   * Venue city AS RECORDED FOR THE VENUE — never scraped from the page under
   * test. Used to prefer an address containing this city, and as corroborating
   * evidence for `identifiesVenue`.
   */
  city?: string;
  /**
   * Venue street address AS RECORDED FOR THE VENUE — never scraped from the
   * page under test. Corroborating evidence for `identifiesVenue`.
   */
  address?: string;
  /** Timeout for a single plain HTTP fetch, in ms. Default 8000. */
  fetchTimeoutMs?: number;
  /** Timeout for a single Playwright render, in ms. Default 20000. */
  renderTimeoutMs?: number;
  /** Max additional contact-bearing pages to follow beyond the landing page. Default 4. */
  maxExtraPages?: number;
  /** Injectable plain-fetch implementation — tests stub this to avoid real network calls. */
  fetchImpl?: typeof fetch;
  /** Injectable Playwright-render implementation — tests stub this to avoid launching a browser. */
  renderImpl?: (url: string, timeoutMs: number) => Promise<string>;
}

const DEFAULT_FETCH_TIMEOUT_MS = 8000;
const DEFAULT_RENDER_TIMEOUT_MS = 20000;
const DEFAULT_MAX_EXTRA_PAGES = 4;

/** A page counts as a client-rendered shell below this many characters of visible text. */
const MEANINGFUL_TEXT_MIN_LENGTH = 80;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Tracking pixels, framework boilerplate, and placeholder domains that show
// up in page markup but are never a venue's real contact address.
const EMAIL_DOMAIN_DENYLIST = [
  "example.com",
  "sentry.io",
  "sentry-cdn.com",
  "wixpress.com",
  "godaddy.com",
  "schema.org",
  "w3.org",
  "google.com",
  "googleapis.com",
  "gstatic.com",
  "cloudflare.com",
];

const STREET_SUFFIXES =
  "Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|" +
  "Place|Pl|Highway|Hwy|Circle|Cir|Terrace|Ter|Parkway|Pkwy|Square|Sq";

const DIRECTIONALS = "N|S|E|W|NE|NW|SE|SW|North|South|East|West";

const ADDRESS_RE = new RegExp(
  `\\d{1,6}\\s+(?:(?:${DIRECTIONALS})\\.?\\s+)?[A-Za-z0-9.'\\s]{1,40}(?:${STREET_SUFFIXES})\\.?,?\\s*` +
    `(?:(?:${DIRECTIONALS})\\.?,?\\s*)?` +
    `(?:(?:Suite|Ste|Unit|#|Apt|Building|Bldg)\\.?\\s*[A-Za-z0-9-]+,?\\s*)?` +
    `[A-Za-z][A-Za-z.\\s]{1,30},?\\s*[A-Z]{2}\\s*\\d{5}(?:-\\d{4})?`,
  "i",
);

const CONTACT_LINK_RE = /contact|about|events|booking|find us|visit|location/i;

/**
 * Separators a site puts between its own name and a tagline in a <title> or
 * heading (" | ", " - ", " — ", " · ", ": "). A hyphen only counts when it is
 * whitespace-surrounded, so a hyphenated venue name stays intact.
 */
const NAME_SEPARATOR_RE = /\s+[-–—|·•]\s+|\s*\|\s*|\s*:\s*/;

/** Extracts email and telephone from schema.org JSON-LD blocks (single object or @graph array). */
export function extractFromJsonLd(html: string): { emails: string[]; phones: string[] } {
  const emails: string[] = [];
  const phones: string[] = [];
  const $ = cheerio.load(html);

  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const text = $(el).html();
      if (!text) return;
      const data = JSON.parse(text);
      const items = Array.isArray(data) ? data : data["@graph"] ? data["@graph"] : [data];
      for (const item of items) {
        if (typeof item !== "object" || !item) continue;
        if (item.email && typeof item.email === "string") {
          emails.push(item.email.toLowerCase());
        }
        if (item.telephone && typeof item.telephone === "string") {
          phones.push(item.telephone);
        }
      }
    } catch {
      // ignore malformed JSON-LD
    }
  });

  return { emails, phones };
}

/** Strips script/style/noscript and returns normalized visible body text. */
export function extractVisibleText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

/** True when the page has enough visible text to not be a client-rendered shell. */
export function hasMeaningfulText(html: string): boolean {
  return extractVisibleText(html).length >= MEANINGFUL_TEXT_MIN_LENGTH;
}

/** Extracts candidate email addresses from mailto: links, JSON-LD, and page text. */
export function extractEmails(html: string): string[] {
  const $ = cheerio.load(html);
  const found = new Set<string>();

  // Extract from JSON-LD blocks
  const { emails: jsonLdEmails } = extractFromJsonLd(html);
  for (const email of jsonLdEmails) {
    found.add(email);
  }

  $('a[href^="mailto:"]').each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    const addr = href.replace(/^mailto:/i, "").split("?")[0].trim();
    if (addr) found.add(addr.toLowerCase());
  });

  $("script, style, noscript").remove();
  for (const m of $.root().text().matchAll(EMAIL_RE)) {
    found.add(m[0].toLowerCase());
  }

  return [...found].filter((email) => {
    const domain = email.split("@")[1] ?? "";
    return !EMAIL_DOMAIN_DENYLIST.some((d) => domain === d || domain.endsWith(`.${d}`));
  });
}

/**
 * Extracts a street address from the page's visible text, if present.
 * When `cityHint` is given, an address mentioning that city is preferred
 * over the first match found.
 */
export function extractAddress(html: string, cityHint?: string): string | null {
  const text = extractVisibleText(html);
  const matches = [...text.matchAll(new RegExp(ADDRESS_RE.source, "gi"))]
    .map((m) => m[0].replace(/\s+/g, " ").trim());
  if (matches.length === 0) return null;
  if (cityHint) {
    const hit = matches.find((m) => m.toLowerCase().includes(cityHint.toLowerCase()));
    if (hit) return hit;
  }
  return matches[0];
}

/**
 * Finds same-host, contact-bearing internal links (nav/footer style) worth
 * following from the landing page — bounded to `max` links, never a crawl.
 */
export function findContactLinks(html: string, baseUrl: string, max: number): string[] {
  if (max <= 0) return [];
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const seen = new Set<string>();
  const found: string[] = [];

  $("a[href]").each((_i, el) => {
    if (found.length >= max) return;
    const href = $(el).attr("href");
    if (!href || /^(mailto:|tel:|#|javascript:)/i.test(href)) return;

    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      return;
    }
    if (resolved.hostname !== base.hostname) return;
    resolved.hash = "";
    const key = resolved.toString();
    if (key === base.toString() || seen.has(key)) return;

    const linkText = $(el).text();
    if (!CONTACT_LINK_RE.test(href) && !CONTACT_LINK_RE.test(linkText)) return;

    seen.add(key);
    found.push(key);
  });

  return found;
}

async function fetchPlainHtml(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function defaultRender(url: string, timeoutMs: number): Promise<string> {
  // Lazy import: only loaded when a real fallback is actually needed, so a
  // plain-fetch-only run (and every unit test, which injects `renderImpl`)
  // never has to load or launch Playwright.
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
    return await page.content();
  } finally {
    await browser.close();
  }
}

type FetchOpts = {
  fetchTimeoutMs: number;
  renderTimeoutMs: number;
  fetchImpl: typeof fetch;
  renderImpl: (url: string, timeoutMs: number) => Promise<string>;
};

type FetchOutcome = { html: string; path: FetchPath } | { error: string };

/**
 * Fetches one page: plain HTTP first, falling back to Playwright ONLY when
 * the plain result has no meaningful text (a client-rendered shell). A dead
 * host fails the plain fetch itself and is reported as a clean error without
 * ever trying Playwright (which would just as surely time out).
 */
async function fetchPageWithFallback(url: string, opts: FetchOpts): Promise<FetchOutcome> {
  let plainHtml: string;
  try {
    plainHtml = await fetchPlainHtml(url, opts.fetchTimeoutMs, opts.fetchImpl);
  } catch (err) {
    return { error: `plain fetch failed for ${url}: ${(err as Error).message}` };
  }

  if (hasMeaningfulText(plainHtml)) {
    return { html: plainHtml, path: "plain" };
  }

  try {
    const renderedHtml = await opts.renderImpl(url, opts.renderTimeoutMs);
    return { html: renderedHtml, path: "playwright" };
  } catch (err) {
    return { error: `playwright render failed for ${url}: ${(err as Error).message}` };
  }
}

/**
 * Collects contact data from an ALREADY-FETCHED landing page plus a bounded set
 * of contact-bearing internal links. Taking the landing HTML as a parameter is
 * what lets `probeVenueDomains` fetch each candidate domain exactly once
 * instead of fetching it, then fetching it again through `extractVenueContact`
 * (which for a client-rendered shell meant launching Playwright twice).
 */
async function collectContactFromPage(
  startUrl: string,
  landing: { html: string; path: FetchPath },
  opts: FetchOpts,
  options: ExtractOptions,
): Promise<VenueContactResult> {
  const maxExtraPages = options.maxExtraPages ?? DEFAULT_MAX_EXTRA_PAGES;
  const pagesVisited = [startUrl];
  const emails: EmailHit[] = [];
  const seenEmails = new Set<string>();
  let address: string | null = null;

  const collect = (html: string, pageUrl: string) => {
    for (const email of extractEmails(html)) {
      if (!seenEmails.has(email)) {
        seenEmails.add(email);
        emails.push({ email, sourceUrl: pageUrl });
      }
    }
    if (!address) address = extractAddress(html, options.city);
  };

  collect(landing.html, startUrl);

  const extraLinks = findContactLinks(landing.html, startUrl, maxExtraPages);
  for (const link of extraLinks) {
    const page = await fetchPageWithFallback(link, opts);
    if ("error" in page) continue; // bounded best-effort: a dead sub-link is skipped, not fatal
    pagesVisited.push(link);
    collect(page.html, link);
  }

  // Identity evidence comes only from the CALLER's venue record — never from
  // `address` above, which was scraped off the page being judged.
  const identifies = options.name
    ? pageIdentifiesVenue(landing.html, options.name, {
      city: options.city,
      address: options.address,
    })
    : undefined;

  return {
    emails,
    address,
    fetchPath: landing.path,
    pagesVisited,
    error: null,
    identifiesVenue: identifies,
  };
}

/**
 * Extracts venue contact info (emails + address) starting from a venue
 * website URL. Tries a plain fetch, falls back to Playwright for
 * client-rendered shells, and follows a bounded set of contact-bearing
 * internal links. Never invents data — returns null/empty where nothing was
 * found, and a clear `error` (fetchPath "failed") for a dead or slow host.
 */
export async function extractVenueContact(
  startUrl: string,
  options: ExtractOptions = {},
): Promise<VenueContactResult> {
  const opts: FetchOpts = {
    fetchTimeoutMs: options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    renderTimeoutMs: options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS,
    fetchImpl: options.fetchImpl ?? fetch,
    renderImpl: options.renderImpl ?? defaultRender,
  };

  const landing = await fetchPageWithFallback(startUrl, opts);
  if ("error" in landing) {
    return {
      emails: [],
      address: null,
      fetchPath: "failed",
      pagesVisited: [],
      error: landing.error,
    };
  }

  return await collectContactFromPage(startUrl, landing, opts, options);
}

/** Common alternative hospitality TLDs used by venues (D-49). */
export const HOSPITALITY_TLDS = [
  ".com",
  ".shop",
  ".bar",
  ".restaurant",
  ".site",
  ".beer",
  ".square.site",
] as const;

/**
 * Builds predictable candidate URLs from a venue name using common slug formats
 * and hospitality TLDs (.com, .shop, .bar, .restaurant, .site, .beer, .square.site).
 */
export function generateCandidateDomains(
  venueName: string,
  tlds: readonly string[] = HOSPITALITY_TLDS,
): string[] {
  const normalized = venueName.toLowerCase().trim();
  const slugHyphenated = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const slugCondensed = normalized.replace(/[^a-z0-9]+/g, "");

  const slugs = Array.from(new Set([slugHyphenated, slugCondensed].filter((s) => s.length > 0)));
  const domains: string[] = [];

  for (const slug of slugs) {
    for (const tld of tlds) {
      domains.push(`https://${slug}${tld}`);
    }
  }

  return domains;
}

/** Lowercases and collapses whitespace for name comparison. */
function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * True when the venue's name is the page's OWN identity — it appears as a whole
 * segment of the <title>, an <h1>/<h2>/<h3>, or an og:site_name/og:title — and
 * not merely as a substring of a longer business name. A bare substring test
 * would let "Wild Magnolia Florist" satisfy "Wild Magnolia".
 */
export function pageNamesVenue(html: string, venueName: string): boolean {
  const target = normalizeName(venueName);
  if (!target) return false;

  const $ = cheerio.load(html);
  const candidates: string[] = [];
  const push = (value?: string | null) => {
    if (value) candidates.push(value);
  };

  push($("title").first().text());
  $("h1, h2, h3").each((_i, el) => push($(el).text()));
  push($('meta[property="og:site_name"]').attr("content"));
  push($('meta[property="og:title"]').attr("content"));
  push($('meta[name="application-name"]').attr("content"));

  return candidates.some((candidate) =>
    normalizeName(candidate)
      .split(NAME_SEPARATOR_RE)
      .some((segment) => normalizeName(segment) === target)
  );
}

/**
 * Checks whether a page identifies itself as the given venue: its name must be
 * the page's own identity, corroborated by location evidence SUPPLIED BY THE
 * CALLER from the venue record.
 *
 * Per D-49 an email from a probed domain flips outreachEligible: true only when
 * the page identifies itself as that venue. The location must therefore never
 * come from the page under test — a page that supplies its own expected address
 * verifies itself, and any same-named business anywhere would pass. With no
 * caller-supplied city or address there is no independent evidence at all, so
 * the answer is `false`, not `true`.
 */
export function pageIdentifiesVenue(
  html: string,
  venueName: string,
  location?: { city?: string; address?: string },
): boolean {
  if (!pageNamesVenue(html, venueName)) return false;

  const city = location?.city?.trim();
  const address = location?.address?.trim();
  if (!city && !address) return false;

  const text = extractVisibleText(html).toLowerCase();

  if (city && text.includes(city.toLowerCase())) return true;

  if (address) {
    const street = address.toLowerCase().split(",")[0].trim();
    if (street && text.includes(street)) return true;
  }

  return false;
}

export type EmailDiscoverySource =
  | "google_maps_website"
  | "publication_link"
  | "venue_website"
  | "probed_domain"
  | "none";

/** One candidate domain the probe tried, and what came of it. */
export interface ProbeAttempt {
  url: string;
  outcome: "fetch_failed" | "no_identity" | "no_email" | "match" | "error";
  detail?: string;
}

export interface ProbedVenueResult {
  url: string;
  identifiesVenue: boolean;
  contact: VenueContactResult;
  sourceType: "probed_domain";
  outreachEligible: boolean;
  /** Every candidate domain tried, in order, and why each was rejected. */
  attempts: ProbeAttempt[];
}

export interface ProbeOptions extends ExtractOptions {
  address?: string;
  candidateDomains?: string[];
  /** Called as each candidate domain is tried — lets a caller log a probe that found nothing. */
  onAttempt?: (attempt: ProbeAttempt) => void;
}

/**
 * Probes predictable domain patterns built from the venue's name when search engines
 * are rate-limited or return only social links.
 * Per D-49: an email lifted from a probed domain flips outreachEligible: true only when
 * the page identifies itself as that venue (carrying venue name + city or street address);
 * otherwise outreachEligible: false. The venue's city/address must be supplied by the
 * caller from the venue record — never scraped from the page under test. Every candidate
 * domain is tried (a parked or squatted page returning HTTP 200 must not end the probe
 * before the venue's real domain is tried), and the strongest outcome across all of them
 * is returned: identified-with-email short-circuits immediately, otherwise the best of
 * identified-only or has-an-email-only wins.
 */
export async function probeVenueDomains(
  venueName: string,
  options: ProbeOptions = {},
): Promise<ProbedVenueResult | null> {
  const domains = options.candidateDomains ?? generateCandidateDomains(venueName);
  const opts: FetchOpts = {
    fetchTimeoutMs: options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    renderTimeoutMs: options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS,
    fetchImpl: options.fetchImpl ?? fetch,
    renderImpl: options.renderImpl ?? defaultRender,
  };

  const attempts: ProbeAttempt[] = [];
  const record = (attempt: ProbeAttempt) => {
    attempts.push(attempt);
    options.onAttempt?.(attempt);
  };

  // A domain that merely resolves is not a result: a parked or squatted page
  // returning HTTP 200 must not end the probe before the venue's real domain is
  // tried. Every candidate is visited, and the strongest outcome wins —
  // identified-with-email short-circuits, then identified, then has-an-email.
  let best: { rank: number; result: ProbedVenueResult } | null = null;

  for (const domainUrl of domains) {
    try {
      const outcome = await fetchPageWithFallback(domainUrl, opts);
      if ("error" in outcome) {
        record({ url: domainUrl, outcome: "fetch_failed", detail: outcome.error });
        continue;
      }

      const identifies = pageIdentifiesVenue(outcome.html, venueName, {
        city: options.city,
        address: options.address,
      });

      const contact = await collectContactFromPage(domainUrl, outcome, opts, {
        ...options,
        name: venueName,
      });
      contact.identifiesVenue = identifies;

      const hasViableEmail = contact.emails.length > 0;
      const candidate: ProbedVenueResult = {
        url: domainUrl,
        identifiesVenue: identifies,
        contact,
        sourceType: "probed_domain",
        outreachEligible: hasViableEmail && identifies,
        attempts,
      };

      if (identifies && hasViableEmail) {
        record({ url: domainUrl, outcome: "match" });
        return candidate;
      }

      record({ url: domainUrl, outcome: identifies ? "no_email" : "no_identity" });
      const rank = identifies ? 2 : hasViableEmail ? 1 : 0;
      if (!best || rank > best.rank) best = { rank, result: candidate };
    } catch (err) {
      record({ url: domainUrl, outcome: "error", detail: (err as Error).message });
    }
  }

  return best?.result ?? null;
}
