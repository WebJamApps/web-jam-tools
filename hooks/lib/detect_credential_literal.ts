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
 */

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

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

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

export function isFlaggableMongoDbUri(uri: string): boolean {
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/([^\s"'\/\?#]+)/i);
  if (!match) {
    return false;
  }
  const authority = match[1];

  if (authority.includes("@")) {
    return true;
  }

  const hostTokens = authority.split(",");
  for (const token of hostTokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    let hostname: string;
    if (trimmed.startsWith("[")) {
      const endBracket = trimmed.indexOf("]");
      hostname = endBracket !== -1 ? trimmed.substring(0, endBracket + 1) : trimmed;
    } else {
      hostname = trimmed.split(":")[0];
    }

    if (!LOCAL_HOSTS.has(hostname.toLowerCase())) {
      return true;
    }
  }

  return false;
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

export function findCredentialLiteral(text: string): string | null {
  for (const [name, pattern] of SPECIFIC_PATTERNS) {
    if (name === "MongoDB connection string") {
      if (hasFlaggableMongoDbUri(text)) {
        return name;
      }
    } else {
      const match = text.match(pattern);
      if (match && !isPlaceholderValue(match[0])) {
        return name;
      }
    }
  }

  const urlQueryParamRe =
    /(?:[?&])(token|api[-_]?key|apikey|access[-_]?token|accesstoken|secret(?:[-_]?key)?|auth[-_]?token|authtoken|app[-_]?key)=(?:"([^"&\s]+)"|'([^'&]+)'|([^&\s"'\)`>]+))/gi;
  let urlMatch: RegExpExecArray | null;
  urlQueryParamRe.lastIndex = 0;
  while ((urlMatch = urlQueryParamRe.exec(text)) !== null) {
    const val = urlMatch[2] ?? urlMatch[3] ?? urlMatch[4] ?? "";
    if (!val || val.startsWith("$") || isPlaceholderValue(val)) {
      continue;
    }
    if (val.length < 8) {
      continue;
    }
    return "URL-embedded token/key/secret parameter with a literal value";
  }

  const genericRe =
    /\bexport\s+[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']*))/g;
  let match: RegExpExecArray | null;
  genericRe.lastIndex = 0;

  while ((match = genericRe.exec(text)) !== null) {
    let val = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    val = val.replace(/^\\+/, "").replace(/\\+$/, "").trim();
    if (!val || val.startsWith("$") || isPlaceholderValue(val)) {
      continue; // export FOO="" or FOO=$BAR or FOO="<key>" — empty, var ref, or placeholder
    }
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
