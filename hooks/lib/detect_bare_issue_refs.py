"""Shared bare issue/PR citation detector (web-jam-tools#311).

Used by hooks/require-issue-citation-titles.sh (a blocking Stop hook) to
answer one question — "does this text cite an issue/PR without its title?"
— the same shape as hooks/lib/detect_credential_literal.py's "does this
text contain a credential-shaped literal?".

Reads text from the MSG_FOR_PY environment variable and prints one
offending token per line on stdout (empty output = no violations). Exit
code is always 0 — this is a detector, not a gate; the calling hook decides
what a non-empty result means.

## Detection rule

Flag any `#` immediately followed by digits, UNLESS it is part of a FULL
citation: a repo-name token immediately before it (no space) AND a quoted
title immediately after it (allowing whitespace), e.g.:

    web-jam-tools#299 "Delete replaced labels org-wide, after migration"

The repo token is a bare identifier match (letters/digits/hyphens/
underscores) — this is a regex heuristic, not a lookup against a real repo
list, matching the issue's own framing ("regex heuristic", not a citation
database).

## Must-NOT-fire cases and how they're handled

- Hex colours (`#FEF2C0`): the digit-run right after `#` almost always
  butts up against a hex LETTER with no boundary (`#2563eb`, `#FEF2C0`'s
  own trailing digits `2` immediately followed by `C`... etc.) — if the
  character immediately after the matched digit run is itself a letter,
  this is treated as part of a longer token (hex colour, identifier, hash)
  rather than a citation, and skipped. A hex colour that happens to be
  ALL DECIMAL DIGITS (e.g. `#333333`) is NOT excluded by this rule and
  would still be flagged — a known, accepted gap; see the module-level
  note in the hook script for why that's the safe-direction failure mode.
- Markdown headings (`#`, `##`, `###`): these are never immediately
  followed by a digit (there's always a space before the heading text), so
  they never match the base pattern in the first place.
- Fenced code blocks and inline code spans: stripped out before scanning.
- Milestone/ordinal prose like `(#2)`: DELIBERATELY flagged, not exempted
  — see the hook script's header comment for the reasoning (Josh's HARD
  RULE 1 treats a bare `#`+digits as illegal with "no exceptions, ever").

## Known limits
- Only straight `"`/`'` quotes are recognised for the title; a smart/curly
  quote around an otherwise-full citation will misfire as a violation
  (safe direction: costs one rewrite).
- A citation is validated by SHAPE, not by checking the number/title
  against the real repo. A wrong or made-up title still counts as "has a
  title" as far as this detector is concerned.
"""
import os
import re
import sys

FENCED_CODE_RE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE_RE = re.compile(r"`[^`\n]*`")

# The repo-name token immediately preceding a `#`, anchored so it only
# matches a contiguous identifier run that reaches all the way up to the
# `#` with no space in between.
REPO_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_-]*$")

# A quoted title immediately (allowing leading whitespace) after the
# number. Two alternatives (rather than a single backreferenced class) so
# a double-quoted title may itself contain an apostrophe, and vice versa.
TITLE_RE = re.compile(r"""^\s*(?:"[^"]+"|'[^']+')""")

HASH_NUM_RE = re.compile(r"#(\d+)")


def _blank(match: "re.Match[str]") -> str:
    # Replace with spaces (not deleted) so surrounding character offsets
    # are preserved — not load-bearing today, but keeps future callers that
    # might want offsets from silently getting garbage.
    return " " * len(match.group(0))


def strip_code(text: str) -> str:
    text = FENCED_CODE_RE.sub(_blank, text)
    text = INLINE_CODE_RE.sub(_blank, text)
    return text


def find_bare_issue_refs(text: str) -> list[str]:
    """Return offending `#`-citation tokens (deduped, order preserved)."""
    stripped = strip_code(text)
    seen: set[str] = set()
    offenders: list[str] = []

    for m in HASH_NUM_RE.finditer(stripped):
        start, end = m.span()

        # Digit run butts straight into a letter -> part of a longer token
        # (hex colour, identifier, hash), not an issue/PR number.
        if end < len(stripped) and stripped[end].isalpha():
            continue

        prefix = stripped[:start]
        repo_match = REPO_TOKEN_RE.search(prefix)
        repo_token = repo_match.group(0) if repo_match else None

        has_title = bool(TITLE_RE.match(stripped[end:]))

        if repo_token and has_title:
            continue  # full citation - exempt

        token = f"{repo_token}#{m.group(1)}" if repo_token else f"#{m.group(1)}"
        if token not in seen:
            seen.add(token)
            offenders.append(token)

    return offenders


if __name__ == "__main__":
    raw = os.environ.get("MSG_FOR_PY", "")
    if not raw and len(sys.argv) > 1:
        raw = sys.argv[1]
    for tok in find_bare_issue_refs(raw):
        print(tok)
