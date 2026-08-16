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
 *
 * SYNTHETIC-VALUE HEURISTIC (item 4, same defect)
 * ---------------------------------------------------------------
 * The pragma fails open: a fixture written tomorrow trips the alarm until
 * someone remembers the marker. This second, unconditional layer catches
 * values that are self-evidently NOT live secrets, with no marker required.
 * It is deliberately CONSERVATIVE — when in doubt, FLAG, and a path (e.g.
 * living under test/) is NEVER evidence on its own, only the value's own
 * shape is. Three independent triggers, any one suppresses:
 *
 *   1. RESERVED/NON-RESOLVABLE HOST (RFC 2606 / RFC 6761) — a hostname
 *      under .invalid, .example, .test, .localhost, or the reserved
 *      example.com/example.net/example.org domains cannot resolve on the
 *      public internet, so nothing addressed through it can be a live
 *      credential. Only meaningful for the MongoDB category, the only one
 *      whose match includes a host.
 *   2. PLACEHOLDER WORDING — the matched text contains a word nobody puts
 *      in a real secret (example, fixture, dummy, placeholder, redacted,
 *      changeme, xxx, a "your_"/"your-" prefix, angle brackets), or — for
 *      userinfo-style credentials specifically — the username or password
 *      segment IS, verbatim, one of the generic nouns "user" / "password" /
 *      "secret" / "token" standing in for a real value.
 *   3. DEGENERATE ENTROPY — an unbroken run of 8+ identical characters, or
 *      of 8+ strictly-sequential characters (e.g. "12345678", "abcdefgh").
 *      Threshold rationale: for even a 16-symbol alphabet (hex), the odds
 *      of ANY 8-long same-character run appearing by chance in a normal
 *      live token are on the order of 1-in-16^7 — for the 62-symbol
 *      alphanumeric alphabet most of these formats actually use, far
 *      smaller still. 8 is comfortably below every repeat/sequence length
 *      this repo's own test fixtures use (12-36) and comfortably above
 *      what randomness could plausibly produce, so it errs toward "flag
 *      the real thing" over "hide the fixture".
 *
 * This heuristic never narrows a detection PATTERN — it only judges a
 * value already matched by one, exactly like isPlaceholderValue already did
 * for a narrower set of cases.
 */

export const FIXTURE_PRAGMA = "webjam-fixture-ok";

const RESERVED_TLDS = ["invalid", "example", "test", "localhost"];
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];
const RESERVED_HOST_RE = new RegExp(`\\.(?:${RESERVED_TLDS.join("|")})(?=[:/?#]|$)`, "i");

/** Rule 1: a hostname under a reserved/non-resolvable TLD or domain (RFC 2606/6761). */
export function hasReservedHost(text: string): boolean {
  const lower = text.toLowerCase();
  for (const domain of RESERVED_DOMAINS) {
    if (lower.includes(domain)) return true;
  }
  return RESERVED_HOST_RE.test(text);
}

const PLACEHOLDER_WORDS = ["example", "fixture", "dummy", "placeholder", "redacted", "changeme", "xxx"];
const GENERIC_STANDIN_WORDS = new Set(["user", "password", "secret", "token"]);

/** Rule 2 (general half): a placeholder word anywhere in the matched text. */
export function hasPlaceholderWording(text: string): boolean {
  const lower = text.toLowerCase();
  for (const word of PLACEHOLDER_WORDS) {
    if (lower.includes(word)) return true;
  }
  if (/your[-_]/i.test(text)) return true;
  if (text.includes("<") && text.includes(">")) return true;
  return false;
}

/** Rule 2 (userinfo half): the user or password segment of `user[:pass]` IS, verbatim, a generic standin noun. */
export function hasGenericStandinUserinfo(userinfo: string): boolean {
  return userinfo.split(":").some((part) => GENERIC_STANDIN_WORDS.has(part.trim().toLowerCase()));
}

const DEGENERATE_RUN_THRESHOLD = 8;

function longestRepeatedRun(s: string): number {
  let best = 0, cur = 0, prev = "";
  for (const ch of s) {
    cur = ch === prev ? cur + 1 : 1;
    prev = ch;
    if (cur > best) best = cur;
  }
  return best;
}

function sameSequentialClass(a: string, b: string): boolean {
  const digit = (c: string) => c >= "0" && c <= "9";
  const lower = (c: string) => c >= "a" && c <= "z";
  const upper = (c: string) => c >= "A" && c <= "Z";
  return (digit(a) && digit(b)) || (lower(a) && lower(b)) || (upper(a) && upper(b));
}

function longestSequentialRun(s: string): number {
  let best = s.length > 0 ? 1 : 0, cur = 1;
  for (let i = 1; i < s.length; i++) {
    const isNext = sameSequentialClass(s[i - 1], s[i]) && s.charCodeAt(i) === s.charCodeAt(i - 1) + 1;
    cur = isNext ? cur + 1 : 1;
    if (cur > best) best = cur;
  }
  return best;
}

/** Rule 3: a run of 8+ identical or 8+ strictly-sequential characters. */
export function hasDegenerateEntropy(value: string): boolean {
  return longestRepeatedRun(value) >= DEGENERATE_RUN_THRESHOLD ||
    longestSequentialRun(value) >= DEGENERATE_RUN_THRESHOLD;
}

/** Rules 2 (general) + 3 combined — the checks meaningful for ANY matched value, not just URL-shaped ones. */
export function looksSynthetic(value: string): boolean {
  return hasPlaceholderWording(value) || hasDegenerateEntropy(value);
}

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
 *
 * Returns the `user[:pass]` segment of the URI's authority, or null if
 * there is none.
 */
export function extractMongoUserinfo(uri: string): string | null {
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/([^\s"'\/\?#]+)/i);
  if (!match) {
    return null;
  }
  const authority = match[1];

  const atIndex = authority.indexOf("@");
  if (atIndex === -1) {
    return null;
  }

  const userinfo = authority.slice(0, atIndex);
  return userinfo.length > 0 ? userinfo : null;
}

export function isFlaggableMongoDbUri(uri: string): boolean {
  return extractMongoUserinfo(uri) !== null;
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
        const userinfo = extractMongoUserinfo(uriMatch[0]);
        if (userinfo === null) continue;
        if (hasReservedHost(uriMatch[0])) continue;
        if (hasGenericStandinUserinfo(userinfo)) continue;
        if (looksSynthetic(uriMatch[0])) continue;
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
      if (looksSynthetic(match[0])) continue;
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
    if (looksSynthetic(val)) continue;
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
    if (looksSynthetic(val)) continue;
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
