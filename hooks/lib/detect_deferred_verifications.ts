/**
 * Shared deferred verification detector (web-jam-tools#1115).
 *
 * Used to detect deferred-verification phrases in non-Epic, non-Needs-Design
 * issue bodies that leave unfinished checks in filed issues rather than
 * resolving them prior to filing or presenting them as decisions.
 */

import { stripCodeAndQuotes } from "./detect_unresolvable_issue_pointers.ts";

export const FORBIDDEN_DEFERRED_VERIFICATION_PHRASES = [
  "must be verified before removal",
  "needs to be verified",
  "should be verified",
  "to be confirmed",
  "not yet confirmed",
  "remains to be",
  "assumed but not confirmed",
];

export function stripBlockquotes(text: string): string {
  const blank = (match: string) => " ".repeat(match.length);
  return text.replace(/^[ \t]*>.*$/gm, blank);
}

export function findDeferredVerifications(text: string): string[] {
  if (!text) return [];
  const stripped = stripCodeAndQuotes(stripBlockquotes(text));
  const seen = new Set<string>();
  const offenders: string[] = [];
  const sortedPhrases = [...FORBIDDEN_DEFERRED_VERIFICATION_PHRASES].sort(
    (a, b) => b.length - a.length,
  );
  const matchedSpans: Array<[number, number]> = [];

  for (const phrase of sortedPhrases) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "gi");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(stripped)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (matchedSpans.some(([s, e]) => s <= start && end <= e)) {
        continue;
      }
      matchedSpans.push([start, end]);
      if (!seen.has(phrase)) {
        seen.add(phrase);
        offenders.push(phrase);
      }
    }
  }

  const dynamicPatterns = [
    /\bverify\s+against\s+(?:(?!\.\s)[^\n])+?\s+(?:before\s+(?:removal|removing)|first)\b/gi,
  ];

  for (const pattern of dynamicPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(stripped)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (matchedSpans.some(([s, e]) => s <= start && end <= e)) {
        continue;
      }
      matchedSpans.push([start, end]);
      const matchedText = text.slice(start, end);
      if (!seen.has(matchedText)) {
        seen.add(matchedText);
        offenders.push(matchedText);
      }
    }
  }

  return offenders;
}

if (import.meta.main) {
  const raw = Deno.env.get("MSG_FOR_PY") || Deno.args[0] || "";
  for (const tok of findDeferredVerifications(raw)) {
    console.log(tok);
  }
}
