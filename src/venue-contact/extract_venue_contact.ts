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
}

export interface ExtractOptions {
  /** Venue name, reserved for future disambiguation; unused today. */
  name?: string;
  /** Venue city — when set, an address containing this city is preferred. */
  city?: string;
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

const ADDRESS_RE = new RegExp(
  `\\d{1,6}\\s+[A-Za-z0-9.'\\s]{1,40}(?:${STREET_SUFFIXES})\\.?,?\\s*` +
    `(?:(?:Suite|Ste|Unit|#)\\s*\\w+,?\\s*)?` +
    `[A-Za-z][A-Za-z.\\s]{1,30},?\\s*[A-Z]{2}\\s*\\d{5}(?:-\\d{4})?`,
  "i",
);

const CONTACT_LINK_RE = /contact|about|events|booking|find us|visit|location/i;

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
  const maxExtraPages = options.maxExtraPages ?? DEFAULT_MAX_EXTRA_PAGES;

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

  return { emails, address, fetchPath: landing.path, pagesVisited, error: null };
}
