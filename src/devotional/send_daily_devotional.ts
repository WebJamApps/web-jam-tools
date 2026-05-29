// Daily devotional sender (CollegeLutheran project). (Deno.)
//
// Source: God Pause (Luther Seminary alumni) — daily devotional at
// https://www.luthersem.edu/godpause/. Fetches today's devotion, parses it,
// and emails it to Josh via Gmail. Runs from cron at 06:00 America/New_York.
//
// Reuses the gmail-mcp OAuth tokens at ~/.gmail-mcp/. No Drive dependency.
//
// Run: deno run --allow-net --allow-read --allow-write --allow-env --allow-sys \
//        src/devotional/send_daily_devotional.ts
//
// Replaced the 2026-05-13 ELCA Prayer Ventures pipeline on 2026-05-22
// (Task 5 of claude-opus-tasks). Ported tsx→Deno 2026-05-29.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Buffer } from "node:buffer";
import * as cheerio from "cheerio";

const RECIPIENT = "joshua.v.sherman@gmail.com";
const GMAIL_TOKEN_PATH = path.join(os.homedir(), ".gmail-mcp", "credentials.json");
const GMAIL_KEYS_PATH = path.join(os.homedir(), ".gmail-mcp", "gcp-oauth.keys.json");

type OauthKeys = {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
};
type OauthTokens = { access_token?: string; refresh_token: string };

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf-8")) as T;
}

async function refreshAccessToken(tokenPath: string, keysPath: string): Promise<string> {
  const tokens = await readJson<OauthTokens>(tokenPath);
  const keysRaw = await readJson<OauthKeys>(keysPath);
  const keys = keysRaw.installed ?? keysRaw.web;
  if (!keys) throw new Error(`No installed/web client config at ${keysPath}`);
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: keys.client_id,
      client_secret: keys.client_secret,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) throw new Error(`token refresh ${tokenPath}: ${resp.status} ${await resp.text()}`);
  const data = (await resp.json()) as { access_token: string };
  tokens.access_token = data.access_token;
  await fs.writeFile(tokenPath, JSON.stringify(tokens, null, 2));
  return data.access_token;
}

function todayInEastern(): { year: string; month: string; day: string; humanDate: string } {
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

type GodPause = {
  url: string;
  scriptureRef: string;
  verseText: string;
  devotion: string;
  prayer: string;
  author: string;
};

async function fetchGodPause(today: ReturnType<typeof todayInEastern>): Promise<GodPause | null> {
  const monthUrl = `https://www.luthersem.edu/godpause/${today.year}/${today.month}/`;
  const monthResp = await fetch(monthUrl);
  if (!monthResp.ok) throw new Error(`god pause month fetch: ${monthResp.status}`);
  const monthHtml = await monthResp.text();
  const todayPrefix =
    `https://www.luthersem.edu/godpause/${today.year}/${today.month}/${today.day}/`;
  const match = monthHtml.match(
    new RegExp(`href="(${todayPrefix.replace(/[.]/g, "\\.")}[0-9]+/)"`),
  );
  if (!match) return null;
  const dayUrl = match[1];
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

function buildRawMessage(to: string, subject: string, body: string): string {
  const headers = `To: ${to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n`;
  return Buffer.from(headers + body, "utf-8").toString("base64").replace(/\+/g, "-").replace(
    /\//g,
    "_",
  ).replace(/=+$/, "");
}

async function sendEmail(to: string, subject: string, body: string): Promise<string> {
  const raw = buildRawMessage(to, subject, body);
  const send = (token: string) =>
    fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
  let token = (await readJson<OauthTokens>(GMAIL_TOKEN_PATH)).access_token ??
    (await refreshAccessToken(GMAIL_TOKEN_PATH, GMAIL_KEYS_PATH));
  let resp = await send(token);
  if (resp.status === 401) {
    token = await refreshAccessToken(GMAIL_TOKEN_PATH, GMAIL_KEYS_PATH);
    resp = await send(token);
  }
  if (!resp.ok) throw new Error(`gmail send: ${resp.status} ${await resp.text()}`);
  return ((await resp.json()) as { id: string }).id;
}

// ---------- Compose ----------

function composeBody(gp: GodPause): string {
  const sub = "─".repeat(60);
  const parts: string[] = [];
  parts.push(`Scripture: ${gp.scriptureRef}`);
  parts.push("");
  if (gp.verseText) {
    parts.push(gp.verseText);
    parts.push("");
  }
  parts.push("Devotion");
  parts.push(sub);
  parts.push(gp.devotion);
  parts.push("");
  parts.push("Prayer");
  parts.push(sub);
  parts.push(gp.prayer);
  parts.push("");
  parts.push(`— ${gp.author}`);
  parts.push(`  Source: ${gp.url}`);
  parts.push("");
  return parts.join("\n");
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
  const body = composeBody(gp);
  const messageId = await sendEmail(RECIPIENT, subject, body);
  console.error(`[devotional] sent ${today.humanDate} as Gmail message ${messageId}`);
  return 0;
}

main().then((code) => Deno.exit(code)).catch((err) => {
  console.error(err);
  Deno.exit(1);
});
