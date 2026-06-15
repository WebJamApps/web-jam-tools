import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  buildRawMessage,
  composeHtmlBody,
  encodeHeaderWord,
  type GodPause,
} from "../src/devotional/send_daily_devotional.ts";

function pad(s: string): string {
  return s + "=".repeat((4 - (s.length % 4)) % 4);
}
function b64ToUtf8(s: string): string {
  const bin = atob(pad(s.replace(/\r?\n/g, "")));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function b64urlToUtf8(s: string): string {
  return b64ToUtf8(s.replace(/-/g, "+").replace(/_/g, "/"));
}
function decodeEncodedWord(header: string): string {
  const m = header.match(/=\?UTF-8\?B\?([^?]+)\?=/);
  assert(m, `expected an RFC 2047 encoded-word in: ${header}`);
  return b64ToUtf8(m![1]);
}

const GP: GodPause = {
  url: "https://www.luthersem.edu/godpause/2026/06/12/example/",
  scriptureRef: "Matthew 9:35-10:8 (NRSV)",
  // mirrors the real God Pause shape: "Verse 35" / "Chapter 10" jammed to the text
  verseText:
    "Verse 35Then Jesus went about all the cities.\n\nVerse 36When he saw the crowds.\n\nChapter 10Then Jesus summoned his twelve disciples.",
  devotion: "A devotion mentioning <angle> & an ampersand.",
  prayer: "A short prayer.",
  author: "Some Author, Luther Seminary",
};

Deno.test("verse markers become superscript numbers, not 'Verse N' words", () => {
  const html = composeHtmlBody(GP);
  assertStringIncludes(html, "<sup>35</sup> Then");
  assertStringIncludes(html, "<sup>36</sup> When");
  assertStringIncludes(html, "<sup>10:1</sup> Then"); // chapter boundary
  assert(!html.includes("Verse 35"), "literal 'Verse 35' should be gone");
  assert(!html.includes("Chapter 10"), "literal 'Chapter 10' should be gone");
});

Deno.test("HTML body escapes content and links the source", () => {
  const html = composeHtmlBody(GP);
  assertStringIncludes(html, "&lt;angle&gt;");
  assertStringIncludes(html, "&amp;");
  assertStringIncludes(html, `<a href="https://www.luthersem.edu/godpause/2026/06/12/example/"`);
  assert(!html.includes("<angle>"), "raw unescaped markup must not leak");
});

Deno.test("raw message is HTML with base64 transfer encoding", () => {
  const raw = buildRawMessage(
    "me@example.com",
    "God Pause — Friday, June 12, 2026",
    composeHtmlBody(GP),
  );
  const msg = b64urlToUtf8(raw);
  assertMatch(msg, /Content-Type: text\/html; charset="UTF-8"/);
  assertMatch(msg, /Content-Transfer-Encoding: base64/);
  assert(!/Content-Type: text\/plain/.test(msg), "must not be plain text");
  // body (after the header/body separator) decodes back to the HTML
  const body = msg.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  assertStringIncludes(b64ToUtf8(body), "<sup>35</sup> Then");
});

Deno.test("subject em-dash is RFC 2047 encoded (fixes mojibake)", () => {
  const raw = buildRawMessage("me@example.com", "God Pause — Friday, June 12, 2026", "<p>x</p>");
  const msg = b64urlToUtf8(raw);
  const subjectLine = msg.split("\r\n").find((l) => l.startsWith("Subject:"))!;
  assertMatch(subjectLine, /Subject: =\?UTF-8\?B\?.+\?=/);
  assertStringIncludes(decodeEncodedWord(subjectLine), "God Pause — Friday");
});

Deno.test("encodeHeaderWord leaves ASCII alone, encodes non-ASCII", () => {
  assertEquals(encodeHeaderWord("plain ascii subject"), "plain ascii subject");
  const enc = encodeHeaderWord("God Pause — x");
  assertMatch(enc, /^=\?UTF-8\?B\?.+\?=$/);
  assertStringIncludes(b64ToUtf8(enc.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, "")), "—");
});
