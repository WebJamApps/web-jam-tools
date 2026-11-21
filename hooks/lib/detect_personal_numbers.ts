/**
 * The checker of the personal information guards (web-jam-tools#1860).
 *
 * Recognises items 1 and 2 of the protected list in text: a Social Security
 * number or an ITIN, a full card number, a bank routing number and a bank
 * account number. It reports the kind of number and where, never the number.
 *
 * Design: ~/Dropbox/web-jam-llms/AI_Misbehaves/personal-information-guards-design.md,
 * "The checker". Every guard and both accounting programs import this module,
 * so they never disagree.
 *
 * Where one run of digits fits more than one kind, the checker names the first
 * that fits, in this order: a Social Security number or ITIN, a card number, a
 * routing number, a bank account number.
 */

export type PersonalNumberKind = "ssn" | "itin" | "card" | "routing" | "account";

export interface PersonalNumberFinding {
  kind: PersonalNumberKind;
  /** 1-based line of the number's first digit. */
  line: number;
  /** 1-based column of the number's first digit. */
  column: number;
}

/** The order the design names the kinds in; an earlier kind wins a shared run. */
export const KIND_ORDER: readonly PersonalNumberKind[] = [
  "ssn",
  "itin",
  "card",
  "routing",
  "account",
];

const KIND_NAMES: Record<PersonalNumberKind, string> = {
  ssn: "a Social Security number",
  itin: "an ITIN",
  card: "a card number",
  routing: "a routing number",
  account: "a bank account number",
};

/** The words a refusal uses for a kind, e.g. "a Social Security number". */
export function kindName(kind: PersonalNumberKind): string {
  return KIND_NAMES[kind];
}

/** Distinct kinds in a set of findings, named in the checker's order and joined with "and". */
export function describeKinds(findings: PersonalNumberFinding[]): string {
  const kinds = KIND_ORDER.filter((k) => findings.some((f) => f.kind === k));
  return kinds.map(kindName).join(" and ");
}

interface Span {
  kind: PersonalNumberKind;
  start: number;
  end: number;
}

// A keyword begins at a word start; the short acronyms must also end there,
// so "itinerary" and "database" never count as `ITIN` or `ABA`.
const SSN_WORDS =
  /(?<![a-z])(?:ssn(?![a-z])|social security|itin(?![a-z])|taxpayer identification)/gi;
const CARD_WORDS =
  /(?<![a-z])(?:card|visa|mastercard|amex|american express|discover|acct|account)|<acctid>/gi;
const ROUTING_WORDS = /(?<![a-z])(?:routing|aba(?![a-z])|rtn(?![a-z])|transit)/gi;
const ACCOUNT_WORDS = /(?<![a-z])(?:account number|account no|acct no|acct #|account #)/gi;

const PUBLISHED_TEST_CARDS = new Set([
  "4111111111111111",
  "4242424242424242",
  "5555555555554444",
  "378282246310005",
  "6011111111111117",
]);

/** A number never issued as an SSN or ITIN is not one; otherwise its kind. */
function ssnKind(area: string, group: string, serial: string): PersonalNumberKind | null {
  if (area === "000" || area === "666" || group === "00" || serial === "0000") return null;
  if (area.startsWith("9")) {
    const g = Number(group);
    const itin = (g >= 50 && g <= 65) || (g >= 70 && g <= 88) || (g >= 90 && g <= 92) ||
      (g >= 94 && g <= 99);
    return itin ? "itin" : null;
  }
  return "ssn";
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function issuerFits(digits: string): boolean {
  const len = digits.length;
  if (digits.startsWith("4")) return len === 13 || len === 16 || len === 19;
  const two = Number(digits.slice(0, 2));
  const three = Number(digits.slice(0, 3));
  const four = Number(digits.slice(0, 4));
  if ((two >= 51 && two <= 55) || (four >= 2221 && four <= 2720)) return len === 16;
  if (two === 34 || two === 37) return len === 15;
  if (four === 6011 || two === 65 || (three >= 644 && three <= 649)) return len >= 16 && len <= 19;
  return false;
}

function isCard(digits: string): boolean {
  return digits.length >= 13 && digits.length <= 19 && !PUBLISHED_TEST_CARDS.has(digits) &&
    issuerFits(digits) && luhn(digits);
}

function routingChecksum(d: string): boolean {
  if (!/^\d{9}$/.test(d)) return false;
  const n = [...d].map(Number);
  const sum = 3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8]);
  return sum % 10 === 0;
}

/** Each match of `run` that starts no more than `within` characters after a match of `words`. */
function runsAfterWords(
  text: string,
  words: RegExp,
  run: RegExp,
  within: number,
): { start: number; end: number; value: string }[] {
  const out: { start: number; end: number; value: string }[] = [];
  const seen = new Set<number>();
  words.lastIndex = 0;
  for (let w = words.exec(text); w !== null; w = words.exec(text)) {
    const from = w.index + w[0].length;
    // Search only a window after the word, so a long text with many words and
    // no numbers stays linear; a run cut off by the window's end is re-checked
    // against the full text below.
    const window = text.slice(from, from + within + 64);
    run.lastIndex = 0;
    for (let r = run.exec(window); r !== null; r = run.exec(window)) {
      if (r.index > within) break;
      const start = from + r.index;
      const end = start + r[0].length;
      if (/\d/.test(text[end] ?? "") || seen.has(start)) continue;
      seen.add(start);
      out.push({ start, end, value: r[0] });
    }
  }
  return out;
}

function ssnSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const m of text.matchAll(/(?<!\d)(\d{3})-(\d{2})-(\d{4})(?!\d)/g)) {
    const kind = ssnKind(m[1], m[2], m[3]);
    if (kind) spans.push({ kind, start: m.index!, end: m.index! + m[0].length });
  }
  for (const r of runsAfterWords(text, SSN_WORDS, /(?<!\d)\d{9}(?!\d)/g, 20)) {
    const kind = ssnKind(r.value.slice(0, 3), r.value.slice(3, 5), r.value.slice(5));
    if (kind) spans.push({ kind, start: r.start, end: r.end });
  }
  return spans;
}

function cardSpans(text: string): Span[] {
  const spans: Span[] = [];
  const grouped = [
    /(?<!\d)\d{4}([ -])\d{4}\1\d{4}\1\d{4}(?!\d)/g,
    /(?<!\d)\d{4}([ -])\d{6}\1\d{5}(?!\d)/g,
  ];
  for (const re of grouped) {
    for (const m of text.matchAll(re)) {
      if (isCard(m[0].replace(/[ -]/g, ""))) {
        spans.push({ kind: "card", start: m.index!, end: m.index! + m[0].length });
      }
    }
  }
  const run = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;
  for (const r of runsAfterWords(text, CARD_WORDS, run, 40)) {
    if (isCard(r.value.replace(/[ -]/g, ""))) {
      spans.push({ kind: "card", start: r.start, end: r.end });
    }
  }
  return spans;
}

function routingSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const r of runsAfterWords(text, ROUTING_WORDS, /(?<!\d)\d{9}(?!\d)/g, 30)) {
    if (routingChecksum(r.value)) spans.push({ kind: "routing", start: r.start, end: r.end });
  }
  for (const m of text.matchAll(/<bankid>\s*(\d{9})(?!\d)/gi)) {
    if (routingChecksum(m[1])) {
      const start = m.index! + m[0].length - 9;
      spans.push({ kind: "routing", start, end: start + 9 });
    }
  }
  return spans;
}

function accountSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const r of runsAfterWords(text, ACCOUNT_WORDS, /(?<!\d)\d{6,17}(?!\d)/g, 30)) {
    spans.push({ kind: "account", start: r.start, end: r.end });
  }
  for (const m of text.matchAll(/<acctid>\s*(\d{6,17})(?!\d)/gi)) {
    const start = m.index! + m[0].length - m[1].length;
    spans.push({ kind: "account", start, end: start + m[1].length });
  }
  return spans;
}

function position(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, column: index - lineStart + 1 };
}

/**
 * Every protected number in `text`, as its kind and position, in text order.
 * The number itself is never returned.
 */
export function detectPersonalNumbers(text: string): PersonalNumberFinding[] {
  const kept: Span[] = [];
  // Kinds in the design's order: a later kind never claims a run an earlier one took.
  for (const spans of [ssnSpans(text), cardSpans(text), routingSpans(text), accountSpans(text)]) {
    for (const s of spans) {
      if (kept.some((k) => s.start < k.end && k.start < s.end)) continue;
      kept.push(s);
    }
  }
  kept.sort((a, b) => a.start - b.start);
  return kept.map((s) => ({ kind: s.kind, ...position(text, s.start) }));
}
