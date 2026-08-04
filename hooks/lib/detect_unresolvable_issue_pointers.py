"""Shared unresolvable issue pointer detector (web-jam-tools#342).

Used by hooks/require-model-label-on-issue-create.sh to inspect issue bodies
for pointer phrases that violate the Executable Issue rule.
"""

import os
import re
import sys

FORBIDDEN_POINTER_PHRASES = [
    "read the comment first",
    "read comment first",
    "see the comment",
    "see comment",
    "as discussed above",
    "as discussed in",
    "per the discussion",
    "see the epic",
    "in the epic",
]


def _blank(match: "re.Match[str]") -> str:
    return " " * len(match.group(0))


def strip_code_and_quotes(text: str) -> str:
    """Strip code blocks/spans (```...```, `...`) and quotes ("...", '...')
    prior to scanning to avoid false-positives when quoting forbidden phrases."""
    # Fenced code blocks (3 or more backticks)
    text = re.sub(r"```+.*?```+", _blank, text, flags=re.DOTALL)
    # Inline code spans
    text = re.sub(r"`[^`\n]*`", _blank, text)
    # Double-quoted strings (single line)
    text = re.sub(r'"[^"\n]*"', _blank, text)
    # Single-quoted strings (single line)
    text = re.sub(r"'[^'\n]*'", _blank, text)
    return text


def find_unresolvable_issue_pointers(text: str) -> list[str]:
    """Return offending pointer phrases found in text (deduped, order preserved)."""
    if not text:
        return []
    stripped = strip_code_and_quotes(text)
    seen: set[str] = set()
    offenders: list[str] = []

    # Sort phrases by length descending to match longest phrase first
    sorted_phrases = sorted(FORBIDDEN_POINTER_PHRASES, key=len, reverse=True)
    matched_spans: list[tuple[int, int]] = []

    for phrase in sorted_phrases:
        pattern = r"\b" + re.escape(phrase) + r"\b"
        for m in re.finditer(pattern, stripped, flags=re.IGNORECASE):
            start, end = m.span()
            if any(s <= start and end <= e for s, e in matched_spans):
                continue
            matched_spans.append((start, end))
            if phrase not in seen:
                seen.add(phrase)
                offenders.append(phrase)

    return offenders


if __name__ == "__main__":
    raw = os.environ.get("MSG_FOR_PY", "")
    if not raw and len(sys.argv) > 1:
        raw = sys.argv[1]
    for p in find_unresolvable_issue_pointers(raw):
        print(p)
