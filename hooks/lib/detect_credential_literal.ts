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

export function findCredentialLiteral(text: string): string | null {
  for (const [name, pattern] of SPECIFIC_PATTERNS) {
    if (pattern.test(text)) {
      return name;
    }
  }

  const genericRe = /\bexport\s+[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']*))/g;
  let match: RegExpExecArray | null;
  genericRe.lastIndex = 0;

  while ((match = genericRe.exec(text)) !== null) {
    const val = match[1] ?? match[2] ?? match[3] ?? "";
    if (!val) {
      continue; // export FOO="" — empty, not a literal
    }
    if (val.startsWith("$")) {
      continue; // export FOO=$BAR / "$BAR" — variable reference, not a literal
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
