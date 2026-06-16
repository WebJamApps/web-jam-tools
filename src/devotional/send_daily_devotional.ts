// Daily devotional sender (CollegeLutheran project). (Deno.)
//
// Source: God Pause (Luther Seminary alumni) — daily devotional at
// https://www.luthersem.edu/godpause/. Fetches today's devotion, parses it,
// and emails it to Josh via Gmail. Runs daily at 06:00 America/New_York.
//
// Hosting: deployed to Deno Deploy, which fires the schedule via Deno.cron
// (see the bottom of this file) — no laptop dependency (web-jam-tools#69).
// Gmail OAuth comes from env secrets (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET /
// GMAIL_REFRESH_TOKEN); Deno Deploy has no persistent filesystem, so each
// cold-start run refreshes its own short-lived access token.
//
// Run locally (single send, e.g. for testing): deno task devotional, with the
// three GMAIL_* env vars set. NOTE: the laptop cron that used to fire this is
// retired by #69 — do not re-add it, or every devotion sends twice.
//
// Replaced the 2026-05-13 ELCA Prayer Ventures pipeline on 2026-05-22
// (Task 5 of claude-opus-tasks). Ported tsx→Deno 2026-05-29.

import { Buffer } from "node:buffer";
import * as cheerio from "cheerio";

const RECIPIENT = "joshua.v.sherman@gmail.com";

export function gmailSecrets(): { clientId: string; clientSecret: string; refreshToken: string } {
  const clientId = Deno.env.get("GMAIL_CLIENT_ID");
  const clientSecret = Deno.env.get("GMAIL_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GMAIL_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing Gmail OAuth secrets: set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN",
    );
  }
  return { clientId, clientSecret, refreshToken };
}

export async function refreshAccessToken(): Promise<string> {
  const { clientId, clientSecret, refreshToken } = gmailSecrets();
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) throw new Error(`token refresh: ${resp.status} ${await resp.text()}`);
  return ((await resp.json()) as { access_token: string }).access_token;
}

export function todayInEastern(): { year: string; month: string; day: string; humanDate: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const monthName = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
  }).format(new Date());
  const humanDate = `${parts.weekday}, ${monthName} ${Number(parts.day)}, ${parts.year}`;
  return { year: parts.year, month: parts.month, day: parts.day, humanDate };
}

// ---------- God Pause ----------

export type GodPause = {
  url: string;
  scriptureRef: string;
  verseText: string;
  devotion: string;
  prayer: string;
  author: string;
};

export async function fetchGodPause(
  today: ReturnType<typeof todayInEastern>,
): Promise<GodPause | null> {
  const monthUrl = `https://www.luthersem.edu/godpause/${today.year}/${today.month}/`;
  const monthResp = await fetch(monthUrl);
  if (!monthResp.ok) throw new Error(`god pause month fetch: ${monthResp.status}`);
  const monthHtml = await monthResp.text();
  const todayPrefix =
    `https://www.luthersem.edu/godpause/${today.year}/${today.month}/${today.day}/`;
  // Find the day's devotional link without building a RegExp from a variable
  // (avoids the detect-non-literal-regexp / ReDoS rule — web-jam-tools#87).
  // `todayPrefix` is matched as a literal substring; only the trailing numeric
  // id segment is parsed, with a STATIC regex.
  const marker = `href="${todayPrefix}`;
  const markerIdx = monthHtml.indexOf(marker);
  if (markerIdx === -1) return null;
  const idMatch = monthHtml.slice(markerIdx + marker.length).match(/^(\d+\/)"/);
  if (!idMatch) return null;
  const dayUrl = todayPrefix + idMatch[1];
  const dayResp = await fetch(dayUrl);
  if (!dayResp.ok) throw new Error(`god pause day fetch: ${dayResp.status}`);
  const $ = cheerio.load(await dayResp.text());
  const verseBlock = $("div.godpause-verse");
  const scriptureRef = verseBlock.find("h2").first().text().trim().replace(/\s+/g, " ");
  const verseText = verseBlock.find("p").map((_, el) => $(el).text().trim()).get()
    .filter((t) => !/biblegateway\.com/i.test(t)).join("\n\n").replace(/\s+\n/g, "\n").trim();
  const devotion = $("div.godpause-devo").find("p").map((_, el) => $(el).text().trim()).get().join(
    "\n\n",
  ).trim();
  const prayer = $("div.godpause-prayer").find("p").map((_, el) => $(el).text().trim()).get().join(
    "\n\n",
  ).trim();
  const authorName = $("div.godpause-author span.author-name").text().trim();
  const authorInfo = $("div.godpause-author span.godpause-author-info").text().trim();
  const author = [authorName, authorInfo].filter(Boolean).join(", ");
  if (!devotion && !prayer) return null;
  return { url: dayUrl, scriptureRef, verseText, devotion, prayer, author };
}

// ---------- Gmail ----------

export function encodeHeaderWord(s: string): string {
  // RFC 2047 B-encoding for non-ASCII header content (e.g. the em-dash in the
  // subject). Without it the raw UTF-8 bytes are reinterpreted as Latin-1 and
  // render as mojibake ("God Pause Ã¢Â€Â" Friday").
  // deno-lint-ignore no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf-8").toString("base64")}?=`;
}

export function buildRawMessage(to: string, subject: string, htmlBody: string): string {
  // HTML body, base64-encoded with CRLF line wrapping (RFC 2045) so non-ASCII
  // glyphs survive intact; the whole message is then base64url-encoded for the
  // Gmail raw API.
  const encodedBody = Buffer.from(htmlBody, "utf-8").toString("base64").replace(/.{76}/g, "$&\r\n");
  const headers = `To: ${to}\r\nSubject: ${encodeHeaderWord(subject)}\r\nMIME-Version: 1.0\r\n` +
    `Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n`;
  return Buffer.from(headers + encodedBody, "utf-8").toString("base64").replace(/\+/g, "-").replace(
    /\//g,
    "_",
  ).replace(/=+$/, "");
}

export async function sendEmail(to: string, subject: string, body: string): Promise<string> {
  const raw = buildRawMessage(to, subject, body);
  // Each run is a cold start with no token cache, so always mint a fresh
  // short-lived access token from the refresh token.
  const token = await refreshAccessToken();
  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!resp.ok) throw new Error(`gmail send: ${resp.status} ${await resp.text()}`);
  return ((await resp.json()) as { id: string }).id;
}

// ---------- Compose ----------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// God Pause emits verse markers as the literal words "Verse 35" / "Chapter 10"
// jammed against the text ("Verse 35Then Jesus..."). Render them as a superscript
// number (chapter boundaries as "N:1") so the passage reads like scripture.
// Operates on already-escaped text; the inserted <sup> tags are intentional markup.
function superscriptVerseMarkers(escaped: string): string {
  return escaped
    .replace(/\bChapter\s+(\d+)/g, "<sup>$1:1</sup> ")
    .replace(/\bVerse\s+(\d+)/g, "<sup>$1</sup> ");
}

function paragraphs(escaped: string): string {
  return escaped
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export function composeHtmlBody(gp: GodPause): string {
  const parts: string[] = [];
  parts.push(`<p><strong>Scripture:</strong> ${escapeHtml(gp.scriptureRef)}</p>`);
  if (gp.verseText) {
    const verses = superscriptVerseMarkers(paragraphs(escapeHtml(gp.verseText)));
    parts.push(
      `<blockquote style="margin:0 0 1em;padding-left:1em;border-left:3px solid #ccc;">${verses}</blockquote>`,
    );
  }
  parts.push(`<h3 style="margin:1em 0 0.25em;">Devotion</h3>`);
  parts.push(paragraphs(escapeHtml(gp.devotion)));
  parts.push(`<h3 style="margin:1em 0 0.25em;">Prayer</h3>`);
  parts.push(paragraphs(escapeHtml(gp.prayer)));
  parts.push(
    `<p style="margin-top:1.5em;">— ${escapeHtml(gp.author)}<br>` +
      `<span style="color:#666;">Source: <a href="${escapeHtml(gp.url)}">${
        escapeHtml(gp.url)
      }</a></span></p>`,
  );
  return `<!doctype html><html><body style="font-family:Georgia,serif;line-height:1.5;` +
    `color:#222;max-width:640px;">\n${parts.join("\n")}\n</body></html>`;
}

// ---------- main ----------

async function main(): Promise<number> {
  const today = todayInEastern();
  const gp = await fetchGodPause(today);
  if (!gp) {
    console.error(`[devotional] no God Pause devotion published for ${today.humanDate}; skipping`);
    return 0;
  }
  const subject = `God Pause — ${today.humanDate}`;
  const body = composeHtmlBody(gp);
  const messageId = await sendEmail(RECIPIENT, subject, body);
  console.error(`[devotional] sent ${today.humanDate} as Gmail message ${messageId}`);
  return 0;
}

// Deno Deploy runs Deno.cron schedules in UTC (no timezone support), so to land
// on 06:00 America/New_York year-round we register both candidate UTC hours —
// 10:00 (06:00 EDT) and 11:00 (06:00 EST) — and only actually send when it is
// in fact 06:00 in Eastern. The off-season hour is a cheap no-op (well within
// Deno Deploy's ~1M/mo cron ceiling), and there is never a double send.
export function easternHour(now: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hour12: false,
    }).format(now),
  );
}

async function runAtSixEastern(): Promise<void> {
  if (easternHour() !== 6) return;
  await main();
}

if (import.meta.main) {
  if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
    // On Deno Deploy: register the schedule and let the runtime invoke it.
    // Cron NAMES may contain only alphanumerics, whitespace, hyphens, and
    // underscores — no parens or colons, or warm-up throws "Invalid cron name"
    // and the revision fails (web-jam-tools#69).
    Deno.cron("daily devotional 0600 EDT", "0 10 * * *", runAtSixEastern);
    Deno.cron("daily devotional 0600 EST", "0 11 * * *", runAtSixEastern);
    // Deno Deploy provisions an HTTP route per revision; serve a trivial
    // response so the isolate stays addressable (cron itself doesn't require a
    // server, but this is harmless and satisfies the deploy's Route step).
    Deno.serve(() => new Response("devotional cron service: alive\n"));
  } else {
    // Local / manual run (deno task devotional): send once, now.
    try {
      Deno.exit(await main());
    } catch (err) {
      console.error(err);
      Deno.exit(1);
    }
  }
}
