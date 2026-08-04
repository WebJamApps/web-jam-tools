/**
 * Shared unresolvable issue pointer detector (web-jam-tools#342 / web-jam-tools#382).
 *
 * Used to detect pointer phrases in non-Epic issue bodies referring to comments,
 * epics, or prior discussions without standing alone as executable issues.
 */

export const FORBIDDEN_POINTER_PHRASES = [
  "read the comment first",
  "read comment first",
  "see the comment",
  "see comment",
  "as discussed above",
  "as discussed in",
  "per the discussion",
  "see the epic",
  "in the epic",
];

export function stripCodeAndQuotes(text: string): string {
  const blank = (match: string) => " ".repeat(match.length);
  return text
    .replace(/```+[\s\S]*?```+/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/"[^"\n]*"/g, blank)
    .replace(/'[^'\n]*'/g, blank);
}

export function findUnresolvableIssuePointers(text: string): string[] {
  if (!text) return [];
  const stripped = stripCodeAndQuotes(text);
  const seen = new Set<string>();
  const offenders: string[] = [];
  const sortedPhrases = [...FORBIDDEN_POINTER_PHRASES].sort((a, b) => b.length - a.length);
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

  return offenders;
}

export function detectUnresolvableIssuePointers(text: string): string[] {
  return findUnresolvableIssuePointers(text);
}

if (import.meta.main) {
  const raw = Deno.env.get("MSG_FOR_PY") || Deno.args[0] || "";
  for (const tok of findUnresolvableIssuePointers(raw)) {
    console.log(tok);
  }
}
