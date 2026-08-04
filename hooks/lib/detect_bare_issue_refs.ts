/**
 * Shared bare issue/PR citation detector (web-jam-tools#311).
 *
 * Used by hooks/require-issue-citation-titles.sh (a blocking Stop hook) to
 * answer one question — "does this text cite an issue/PR without its title?"
 * — the same shape as hooks/lib/detect_credential_literal.ts's "does this
 * text contain a credential-shaped literal?".
 *
 * Reads text from the MSG_FOR_PY environment variable and prints one
 * offending token per line on stdout (empty output = no violations). Exit
 * code is always 0 — this is a detector, not a gate; the calling hook decides
 * what a non-empty result means.
 */

const FENCED_CODE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const REPO_TOKEN_RE = /[A-Za-z][A-Za-z0-9_-]*$/;
const TITLE_RE = /^\s*(?:"[^"]+"|'[^']+')/;
const HASH_NUM_RE = /#(\d+)/g;

export function stripCode(text: string): string {
  const blank = (match: string) => " ".repeat(match.length);
  return text
    .replace(FENCED_CODE_RE, blank)
    .replace(INLINE_CODE_RE, blank);
}

export function findBareIssueRefs(text: string): string[] {
  const stripped = stripCode(text);
  const seen = new Set<string>();
  const offenders: string[] = [];

  let m: RegExpExecArray | null;
  // Reset lastIndex for global regex iteration
  HASH_NUM_RE.lastIndex = 0;

  while ((m = HASH_NUM_RE.exec(stripped)) !== null) {
    const start = m.index;
    const numStr = m[1];
    const end = start + m[0].length;

    // Digit run butts straight into a letter -> part of a longer token
    if (end < stripped.length && /[A-Za-z]/.test(stripped[end])) {
      continue;
    }

    const prefix = stripped.slice(0, start);
    const repoMatch = prefix.match(REPO_TOKEN_RE);
    const repoToken = repoMatch ? repoMatch[0] : null;

    const suffix = stripped.slice(end);
    const hasTitle = TITLE_RE.test(suffix);

    if (repoToken && hasTitle) {
      continue; // full citation - exempt
    }

    const token = repoToken ? `${repoToken}#${numStr}` : `#${numStr}`;
    if (!seen.has(token)) {
      seen.add(token);
      offenders.push(token);
    }
  }

  return offenders;
}

if (import.meta.main) {
  const raw = Deno.env.get("MSG_FOR_PY") || Deno.args[0] || "";
  for (const tok of findBareIssueRefs(raw)) {
    console.log(tok);
  }
}
