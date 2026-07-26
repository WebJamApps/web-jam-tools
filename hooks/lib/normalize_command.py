"""Shared command normalization for the PreToolUse Bash guards.

Reads the raw command from the CMD_FOR_PY environment variable and prints a
normalized, whitespace-collapsed form for the guards to pattern-match against.

Two transformations, both about the same question: *is this text going to be
executed, or is it prose being recorded?*

1. strip_heredocs — drops heredoc BODIES, because a heredoc is usually how a
   PR body / commit message / issue text gets passed inline, and prose that
   merely mentions a dangerous command must not trip a guard.

   ⚠️ EXCEPT when the heredoc feeds an interpreter. `bash <<EOF ... EOF`
   EXECUTES its body. Stripping that would turn every guard into a one-line
   bypass, so an interpreter-fed body is kept in scope. This was a live hole:
   before web-jam-tools#272 the secret guard stripped those bodies too.

2. drop_prose — drops the values of flags that carry free-form authored text
   (--body, -m, --title, ...). Deliberately does NOT include -c: sh/bash/
   python3/node payloads are executed and must stay in scope.

Extracted from hooks/block-secret-dumps.sh so hooks/block-dangerous-git-deploy.sh
gets identical treatment. Previously only the secret guard stripped heredocs,
so writing a *test fixture* containing a deploy command was blocked while the
same text in the other guard sailed through — the inconsistency this fixes.

On any parse failure the caller falls back to a naive collapse: bias to safety,
since a guard that over-matches blocks too much rather than too little.
"""

import os
import re
import shlex

# Commands that EXECUTE a heredoc body rather than consume it as data. A body
# fed to one of these must stay in scope for matching. Matching loosely here is
# the safe direction: it keeps more text under scrutiny, never less.
INTERPRETER = re.compile(
    r"(^|[\s;&|(])(env\s+)?"
    r"((ba|z|k|da)?sh|python3?|node|deno|perl|ruby|awk|xargs)\b"
)


def find_heredoc_marker(line):
    """First heredoc marker (<<WORD, <<-WORD, <<'WORD', ...) outside any
    quoted region of the line, as (word, strip_tabs), or None."""
    in_squote = False
    in_dquote = False
    i = 0
    n = len(line)
    while i < n:
        ch = line[i]
        if in_squote:
            if ch == "'":
                in_squote = False
            i += 1
            continue
        if in_dquote:
            if ch == "\\" and i + 1 < n:
                i += 2
                continue
            if ch == '"':
                in_dquote = False
            i += 1
            continue
        if ch == "'":
            in_squote = True
            i += 1
            continue
        if ch == '"':
            in_dquote = True
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            i += 2
            continue
        if ch == "<" and i + 1 < n and line[i + 1] == "<":
            j = i + 2
            strip_tabs = False
            if j < n and line[j] == "-":
                strip_tabs = True
                j += 1
            while j < n and line[j] == " ":
                j += 1
            if j < n and line[j] in ("'", '"'):
                j += 1
            start = j
            while j < n and (line[j].isalnum() or line[j] == "_"):
                j += 1
            word = line[start:j]
            if word:
                return word, strip_tabs
            i += 2
            continue
        i += 1
    return None


def strip_heredocs(text):
    lines = text.split("\n")
    out = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        out.append(line)
        marker = find_heredoc_marker(line)
        if marker:
            word, strip_tabs = marker
            # An interpreter-fed body is EXECUTED — keep it in scope.
            executed = bool(INTERPRETER.search(line))
            j = i + 1
            body = []
            terminated = False
            while j < n:
                probe = lines[j].lstrip("\t") if strip_tabs else lines[j]
                if probe.rstrip("\r") == word:
                    terminated = True
                    j += 1
                    break
                body.append(lines[j])
                j += 1
            if executed or not terminated:
                # executed: the body really runs, so it must stay matchable.
                # not terminated: no closing delimiter before EOF — fail safe,
                # keep every line rather than risk silently dropping a real
                # command that never actually ran through a heredoc.
                out.extend(body)
            i = j
            continue
        i += 1
    return "\n".join(out)


SHELL_OP = re.compile(r"\$\(|`|[<>|]")

# Flags whose value is free-form prose text being authored/recorded, not a
# command argument that gets executed. Deliberately does NOT include -c
# (sh/bash/zsh/python3/node/perl/... payloads must stay in scope for matching).
PROSE_FLAGS = {
    "--body",
    "--body-file",
    "-m",
    "--message",
    "--summary",
    "--summary-file",
    "--test-plan",
    "--test-plan-file",
    "--test-evidence",
    "--test-evidence-file",
    "--notes",
    "--title",
    "-t",
}


def drop_prose(text):
    tokens = shlex.split(text, posix=True)
    kept = []
    prev_flag = None
    for tok in tokens:
        if "=" in tok:
            flag, _, value = tok.partition("=")
            if flag in PROSE_FLAGS and not SHELL_OP.search(value):
                kept.append(flag)
                prev_flag = None
                continue
        if prev_flag is not None and not SHELL_OP.search(tok):
            prev_flag = None
            continue
        kept.append(tok)
        prev_flag = tok if tok in PROSE_FLAGS else None
    return " ".join(kept)


def normalize(cmd):
    try:
        result = drop_prose(strip_heredocs(cmd))
    except Exception:
        result = cmd
    return re.sub(r"\s+", " ", result).strip()


if __name__ == "__main__":
    _cmd = os.environ.get("CMD_FOR_PY", "")
    # heredoc-only mode preserves NEWLINES, for callers that split a compound
    # command on separators (the protected-branch push rule needs that) and so
    # cannot use the whitespace-collapsed form.
    if os.environ.get("NORMALIZE_MODE") == "heredoc-only":
        try:
            print(strip_heredocs(_cmd))
        except Exception:
            print(_cmd)
    else:
        print(normalize(_cmd))
