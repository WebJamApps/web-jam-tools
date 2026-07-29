"""Shared credential-literal detector (web-jam-tools#304).

Used by three call sites that all need the same answer to one question —
"does this text contain a credential-shaped LITERAL?" — without duplicating
the pattern list three times:

  1. hooks/block-secret-literals.sh   (PreToolUse: a Bash command about to be
     approved, and possibly persisted verbatim into permissions.allow)
  2. scripts/scan-settings-for-secrets.sh (scans permissions.allow entries in
     ~/.claude/settings.json for anything that slipped through before this
     hook existed)
  3. scripts/backup-claude-memory.sh  (refuses to rclone settings.json to
     Dropbox if it still contains a credential-shaped literal)

Reads text from the CMD_FOR_PY environment variable (same convention as
normalize_command.py) and prints the matched credential TYPE NAME on stdout
if found, nothing otherwise. NEVER prints the matched value itself — only
its shape name — so this tool cannot itself become a leak vector.

Exit code: 0 always (this is a detector, not a gate — callers decide what a
match means). Callers should treat "non-empty stdout" as "found".

Patterns (web-jam-tools#304's minimum list):
  - AIza[0-9A-Za-z_-]{35}                    Google/Gemini API key
  - ghp_ / gho_ / ghu_ / ghs_ / ghr_ / github_pat_   GitHub tokens
  - sk-ant-...                                Anthropic API key
  - sk-...                                    OpenAI-style key
  - xox[baprs]-...                            Slack token
  - export [A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*=<literal>
    the generic shape — ONLY flagged when the right-hand side is a
    non-empty, non-variable literal. `export FOO=$BAR`, `export FOO="$BAR"`,
    and `export FOO=""` are NOT literals and must never match, whether or
    not FOO happens to be a credential-shaped name.
"""
import os
import re
import sys

# (name, regex) — vendor-documented credential prefixes plus enough opaque
# characters that ordinary prose/hashes cannot collide with them. Matches
# hooks/scan-output-for-secrets.sh's SHAPES list where the two overlap.
SPECIFIC_PATTERNS = [
    ("Google/Gemini API key", r"AIza[0-9A-Za-z_-]{35}"),
    ("GitHub token", r"gh[pousr]_[A-Za-z0-9]{36,}"),
    ("GitHub fine-grained PAT", r"github_pat_[A-Za-z0-9_]{20,}"),
    ("Anthropic API key", r"sk-ant-[A-Za-z0-9_-]{20,}"),
    ("OpenAI-style key", r"sk-[A-Za-z0-9]{32,}"),
    ("Slack token", r"xox[baprs]-[A-Za-z0-9-]{10,}"),
]

# Generic shape: export of a credential-NAMED variable (uppercase identifier
# containing KEY/TOKEN/SECRET/PASSWORD) assigned a literal. The value group
# captures either a quoted or bare token so both `export FOO="bar"` and
# `export FOO=bar` are recognized; the quote character (if any) is backreferenced
# so mismatched quotes don't falsely pair.
GENERIC_EXPORT_RE = re.compile(
    r"\bexport\s+[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*"
    r"(?P<q>[\"']?)(?P<val>[^\s\"']*)(?P=q)",
)


def find_credential_literal(text: str) -> str | None:
    """Return the matched credential type name, or None if nothing matched."""
    for name, pattern in SPECIFIC_PATTERNS:
        if re.search(pattern, text):
            return name

    for m in GENERIC_EXPORT_RE.finditer(text):
        val = m.group("val")
        if not val:
            continue  # export FOO="" — empty, not a literal
        if val.startswith("$"):
            continue  # export FOO=$BAR / "$BAR" — variable reference, not a literal
        return "generic KEY/TOKEN/SECRET/PASSWORD export with a literal value"

    return None


if __name__ == "__main__":
    raw = os.environ.get("CMD_FOR_PY", "")
    if not raw and len(sys.argv) > 1:
        raw = sys.argv[1]
    match = find_credential_literal(raw)
    if match:
        print(match)
