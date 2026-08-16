/**
 * Shared credential-literal detector (web-jam-tools#304).
 *
 * Used by call sites that all need the same answer to one question —
 * "does this text contain a credential-shaped LITERAL?" — without duplicating
 * the pattern list:
 *
 *   1. hooks/block-secret-literals.sh (PreToolUse)
 *   2. scripts/scan-settings-for-secrets.sh
 *   3. scripts/backup-claude-memory.sh
 *   4. hooks/scan-output-for-secrets.sh
 *
 * Reads text from the CMD_FOR_PY environment variable (same convention as
 * normalize_command.ts) or CLI arguments and prints the matched credential TYPE NAME
 * on stdout if found, nothing otherwise. NEVER prints the matched value itself.
 *
 * FIXTURE PRAGMA (web-jam-tools issue-detector-false-positive)
 * ---------------------------------------------------------------
 * A test that exercises a credential-refusal guard has to contain a
 * credential-SHAPED literal, which this detector otherwise cannot tell apart
 * from a live one. Rather than loosen any pattern above (that would trade a
 * false positive for a missed real credential) or exempt a whole path (that
 * would blind the detector to a real credential someone commits into a test
 * file), a single literal can carry an explicit marker that suppresses ONLY
 * that match:
 *
 *   export const FIXTURE_PRAGMA = "webjam-fixture-ok";
 *
 * Put the literal string `webjam-fixture-ok` anywhere on the SAME line as
 * the credential-shaped literal, or on the line immediately ABOVE it, e.g.:
 *
 *   const FAKE = "ghp_" + "C".repeat(36); // webjam-fixture-ok
 *
 * or
 *
 *   // webjam-fixture-ok
 *   const FAKE = "ghp_" + "C".repeat(36);
 *
 * Only the match adjacent to the marker is suppressed. Every other
 * credential-shaped literal in the same input — marked or not — is still
 * evaluated independently and reported if unmarked.
 */

export const FIXTURE_PRAGMA = "webjam-fixture-ok";

export const SPECIFIC_PATTERNS: Array<[string, RegExp]> = [
  ["Google/Gemini API key", /AIza[0-9A-Za-z_-]{35}/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{36,}/],
  ["GitHub fine-grained PAT", /github_pat_[A-Za-z0-9_]{20,}/],
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI-style key", /sk-[A-Za-z0-9]{32,}/],
  ["Slack token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ["Deno Deploy token", /\bdd[p]?_[A-Za-z0-9_-]{16,}/],
  ["Dropbox access token", /sl\.[A-Za-z0-9_-]{20,}/],
  ["AWS access key id", /AKIA[0-9A-Z]{16}/],
  ["Google OAuth secret", /GOCSPX-[A-Za-z0-9_-]{20,}/],
  ["JWT token", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["Bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{15,}=*/i],
  ["MongoDB connection string", /mongodb(?:\+srv)?:\/\/[^\s"']+/i],
  ["Auth header flag", /(?:--header|-H)\s+["']?(?:[A-Za-z0-9_-]+:\s*)?(?:Bearer|token|Basic|Secret|[A-Za-z0-9_-]{15,})/i],
];

export function isPlaceholderValue(val: string): boolean {
  if (!val) return true;
  const trimmed = val.trim();
  if (!trimmed) return true;

  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return true;
  }

  if (/^\.{2,}|…$/.test(trimmed)) {
    return true;
  }

  const lower = trimmed.toLowerCase();
  if (
    lower === "placeholder" ||
    lower === "example" ||
    lower === "sample" ||
    lower === "dummy" ||
    lower === "todo" ||
    lower === "xxxx" ||
    lower === "xxx" ||
    lower === "abc" ||
    lower === "123" ||
    lower === "0000"
  ) {
    return true;
  }

  if (
    /^your[-_]?(?:api[-_]?)?(?:key|token|secret|password)(?:[-_]?here)?$/i.test(trimmed) ||
    /^(?:key|token|secret|password|api[-_]?key)[-_]?(?:here|example|placeholder|name|value)?$/i.test(trimmed)
  ) {
    return true;
  }

  return false;
}

/**
 * A MongoDB connection string is only a credential LITERAL when it actually
 * carries userinfo (`user[:pass]@`) in its authority section. A bare
 * `mongodb+srv://cluster.example.net/db` with no userinfo names
 * infrastructure, not a secret, and must not be flagged regardless of
 * whether the host is remote or local. A userinfo-bearing URI must still be
 * flagged regardless of whether the host is remote OR local — a local
 * MongoDB with a live password (`mongodb://admin:hunter2@localhost:27017`)
 * is still a real credential.
 */
export function isFlaggableMongoDbUri(uri: string): boolean {
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/([^\s"'\/\?#]+)/i);
  if (!match) {
    return false;
  }
  const authority = match[1];

  const atIndex = authority.indexOf("@");
  if (atIndex === -1) {
    return false;
  }

  const userinfo = authority.slice(0, atIndex);
  return userinfo.length > 0;
}

export function hasFlaggableMongoDbUri(text: string): boolean {
  const matches = text.match(/mongodb(?:\+srv)?:\/\/[^\s"']+/gi);
  if (!matches) {
    return false;
  }
  for (const uri of matches) {
    if (isFlaggableMongoDbUri(uri)) {
      return true;
    }
  }
  return false;
}

/** Returns the 0-based line index containing byte offset `index` in `text`. */
function lineIndexForOffset(text: string, index: number): number {
  let line = 0;
  const limit = Math.min(index, text.length);
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/** Ensures a regex can be iterated with `exec` in a loop without mutating the caller's pattern. */
function toGlobal(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  return new RegExp(pattern.source, flags);
}

const URL_QUERY_PARAM_RE =
  /(?:[?&])(token|api[-_]?key|apikey|access[-_]?token|accesstoken|secret(?:[-_]?key)?|auth[-_]?token|authtoken|app[-_]?key)=(?:"([^"&\s]+)"|'([^'&]+)'|([^&\s"'\)`>]+))/i;
const GENERIC_EXPORT_RE =
  /\bexport\s+[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']*))/;

/**
 * True when `line` itself contains a credential-shaped match under ANY
 * detection category (used only to resolve pragma adjacency, never to
 * report — see isPragmaSuppressedForLine below).
 */
function lineHostsOwnMatch(line: string): boolean {
  for (const [name, pattern] of SPECIFIC_PATTERNS) {
    if (name === "MongoDB connection string") {
      if (hasFlaggableMongoDbUri(line)) return true;
      continue;
    }
    if (pattern.test(line)) return true;
  }
  return URL_QUERY_PARAM_RE.test(line) || GENERIC_EXPORT_RE.test(line);
}

/**
 * True when the FIXTURE_PRAGMA marker suppresses the match on `lineIndex`.
 *
 * Two adjacency rules, applied so a marker never reaches past the literal
 * it was written for:
 *   1. Same line: the marker is on `lineIndex` itself (e.g. a trailing
 *      comment next to the literal it annotates).
 *   2. Line above, STANDALONE ONLY: the marker is on `lineIndex - 1`, and
 *      that line hosts no credential match of its own. If the line above
 *      instead pairs the marker with its OWN literal (rule 1 for that
 *      line), the marker is considered spent there and does not also reach
 *      forward to suppress an unrelated match on the next line.
 */
function isPragmaSuppressedForLine(lines: string[], lineIndex: number): boolean {
  const current = lines[lineIndex] ?? "";
  if (current.includes(FIXTURE_PRAGMA)) return true;

  if (lineIndex > 0) {
    const above = lines[lineIndex - 1];
    if (above.includes(FIXTURE_PRAGMA) && !lineHostsOwnMatch(above)) {
      return true;
    }
  }

  return false;
}

export function findCredentialLiteral(text: string): string | null {
  const lines = text.split("\n");

  for (const [name, pattern] of SPECIFIC_PATTERNS) {
    if (name === "MongoDB connection string") {
      const uriRe = /mongodb(?:\+srv)?:\/\/[^\s"']+/gi;
      let uriMatch: RegExpExecArray | null;
      while ((uriMatch = uriRe.exec(text)) !== null) {
        if (!isFlaggableMongoDbUri(uriMatch[0])) continue;
        const lineIndex = lineIndexForOffset(text, uriMatch.index);
        if (isPragmaSuppressedForLine(lines, lineIndex)) continue;
        return name;
      }
      continue;
    }

    const globalPattern = toGlobal(pattern);
    let match: RegExpExecArray | null;
    while ((match = globalPattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        globalPattern.lastIndex++;
        continue;
      }
      if (isPlaceholderValue(match[0])) continue;
      const lineIndex = lineIndexForOffset(text, match.index);
      if (isPragmaSuppressedForLine(lines, lineIndex)) continue;
      return name;
    }
  }

  const urlQueryParamRe = toGlobal(URL_QUERY_PARAM_RE);
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = urlQueryParamRe.exec(text)) !== null) {
    const val = urlMatch[2] ?? urlMatch[3] ?? urlMatch[4] ?? "";
    if (!val || val.startsWith("$") || isPlaceholderValue(val)) {
      continue;
    }
    if (val.length < 8) {
      continue;
    }
    const lineIndex = lineIndexForOffset(text, urlMatch.index);
    if (isPragmaSuppressedForLine(lines, lineIndex)) continue;
    return "URL-embedded token/key/secret parameter with a literal value";
  }

  const genericRe = toGlobal(GENERIC_EXPORT_RE);
  let match: RegExpExecArray | null;
  while ((match = genericRe.exec(text)) !== null) {
    let val = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    val = val.replace(/^\\+/, "").replace(/\\+$/, "").trim();
    if (!val || val.startsWith("$") || isPlaceholderValue(val)) {
      continue; // export FOO="" or FOO=$BAR or FOO="<key>" — empty, var ref, or placeholder
    }
    const lineIndex = lineIndexForOffset(text, match.index);
    if (isPragmaSuppressedForLine(lines, lineIndex)) continue;
    return "generic KEY/TOKEN/SECRET/PASSWORD export with a literal value";
  }

  return null;
}

if (import.meta.main) {
  const raw = Deno.env.get("CMD_FOR_PY") || Deno.args[0] || "";
  const match = findCredentialLiteral(raw);
  if (match) {
    console.log(match);
  }
}
