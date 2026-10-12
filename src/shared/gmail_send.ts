// src/shared/gmail_send.ts
// Shared Gmail API sending module used by both CollegeLutheran devotional sender
// and web-jam-uptime watchdog. (Deno.)
//
// Gmail OAuth comes from env secrets (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET /
// GMAIL_REFRESH_TOKEN); runs on Deno Deploy have no persistent filesystem, so
// each cold-start run refreshes its own short-lived access token from Gmail OAuth API
// and sends email via the Gmail REST API (users/me/messages/send).

import { Buffer } from "node:buffer";

export function gmailSecrets(
  env?: Record<string, string | undefined>,
): { clientId: string; clientSecret: string; refreshToken: string } {
  const clientId = env ? env["GMAIL_CLIENT_ID"] : Deno.env.get("GMAIL_CLIENT_ID");
  const clientSecret = env ? env["GMAIL_CLIENT_SECRET"] : Deno.env.get("GMAIL_CLIENT_SECRET");
  const refreshToken = env ? env["GMAIL_REFRESH_TOKEN"] : Deno.env.get("GMAIL_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing Gmail OAuth secrets: set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN",
    );
  }
  return { clientId, clientSecret, refreshToken };
}

export async function refreshAccessToken(
  secrets?: { clientId: string; clientSecret: string; refreshToken: string },
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const { clientId, clientSecret, refreshToken } = secrets ?? gmailSecrets();
  const resp = await fetchFn("https://oauth2.googleapis.com/token", {
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

export function encodeHeaderWord(s: string): string {
  // RFC 2047 B-encoding for non-ASCII header content (e.g. the em-dash in the
  // subject). Without it the raw UTF-8 bytes are reinterpreted as Latin-1 and
  // render as mojibake ("God Pause Ã¢Â€Â" Friday").
  // deno-lint-ignore no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf-8").toString("base64")}?=`;
}

export function buildRawMessage(
  to: string | string[],
  subject: string,
  htmlBody: string,
): string {
  // HTML body, base64-encoded with CRLF line wrapping (RFC 2045) so non-ASCII
  // glyphs survive intact; the whole message is then base64url-encoded for the
  // Gmail raw API.
  const toHeader = Array.isArray(to) ? to.join(", ") : to;
  const encodedBody = Buffer.from(htmlBody, "utf-8").toString("base64").replace(/.{76}/g, "$&\r\n");
  const headers =
    `To: ${toHeader}\r\nSubject: ${encodeHeaderWord(subject)}\r\nMIME-Version: 1.0\r\n` +
    `Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n`;
  return Buffer.from(headers + encodedBody, "utf-8").toString("base64").replace(/\+/g, "-").replace(
    /\//g,
    "_",
  ).replace(/=+$/, "");
}

export async function sendEmail(
  to: string | string[],
  subject: string,
  body: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const raw = buildRawMessage(to, subject, body);
  // Each run is a cold start with no token cache, so always mint a fresh
  // short-lived access token from the refresh token.
  const token = await refreshAccessToken(undefined, fetchFn);
  const resp = await fetchFn("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!resp.ok) throw new Error(`gmail send: ${resp.status} ${await resp.text()}`);
  return ((await resp.json()) as { id: string }).id;
}
