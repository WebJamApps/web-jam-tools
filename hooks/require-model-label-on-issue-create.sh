#!/usr/bin/env bash
# PreToolUse guard: deny an issue-creating or issue-editing call that violates
# model-label or executable-issue rules.
# Design: web-jam-tools#265 (model label on issue creation) & web-jam-tools#342 (executable issue rule).
#
# Intercepts BOTH surfaces:
#   - Bash: `gh issue create`, `gh issue edit`
#   - MCP: any `mcp__*__issue_write` tool call (method: create, update, edit)
#
# Fail CLOSED on ambiguity. Exit 2 = block (stderr shown to model).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_LABELS_JSON="$REPO_DIR/skills/fix-labels/model-labels.json"

input=$(cat)

result=$(INPUT_JSON="$input" MODEL_LABELS_JSON_PATH="$MODEL_LABELS_JSON" REPO_DIR="$REPO_DIR" python3 <<'PYEOF' 2>/dev/null
import json
import os
import re
import shlex
import sys

REPO_DIR = os.environ.get("REPO_DIR", "")
if REPO_DIR:
    lib_path = os.path.join(REPO_DIR, "hooks", "lib")
    if lib_path not in sys.path:
        sys.path.insert(0, lib_path)

try:
    from detect_unresolvable_issue_pointers import find_unresolvable_issue_pointers
except ImportError:
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
        text = re.sub(r"```+.*?```+", _blank, text, flags=re.DOTALL)
        text = re.sub(r"`[^`\n]*`", _blank, text)
        text = re.sub(r'"[^"\n]*"', _blank, text)
        text = re.sub(r"'[^'\n]*'", _blank, text)
        return text

    def find_unresolvable_issue_pointers(text: str) -> list[str]:
        if not text:
            return []
        stripped = strip_code_and_quotes(text)
        seen: set[str] = set()
        offenders: list[str] = []
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

INPUT_JSON = os.environ.get("INPUT_JSON", "")
MODEL_LABELS_PATH = os.environ.get("MODEL_LABELS_JSON_PATH", "")
REGEN_HINT = "regenerate it with `deno task fix-labels:generate-model-labels`"

OPERATORS = {"&&", "||", ";", "|", "(", ")"}
ASSIGN_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
MCP_ISSUE_WRITE_RE = re.compile(r"^mcp__.*__issue_write$")


def load_model_labels():
    with open(MODEL_LABELS_PATH) as f:
        data = json.load(f)
    names = data.get("modelLabels")
    if not isinstance(names, list) or not names:
        raise ValueError(f"modelLabels field is missing or empty ({REGEN_HINT})")
    if not all(isinstance(n, str) and n for n in names):
        raise ValueError(f"modelLabels field contains a non-string/empty entry ({REGEN_HINT})")
    return set(names)


def find_gh_issue_create_args(tokens):
    if not tokens:
        return None
    if tokens[0].rsplit("/", 1)[-1] != "gh":
        return None
    for i in range(len(tokens) - 1):
        if tokens[i] == "issue" and tokens[i + 1] == "create":
            return tokens[i + 2:]
    return None


def find_gh_issue_edit_args(tokens):
    if not tokens:
        return None
    if tokens[0].rsplit("/", 1)[-1] != "gh":
        return None
    for i in range(len(tokens) - 1):
        if tokens[i] == "issue" and tokens[i + 1] == "edit":
            return tokens[i + 2:]
    return None


def strip_leading_assignments(tokens):
    i = 0
    while i < len(tokens) and ASSIGN_RE.match(tokens[i]):
        i += 1
    return tokens[i:]


def extract_label_values(args):
    labels = []
    j = 0
    while j < len(args):
        a = args[j]
        if a in ("--label", "-l"):
            if j + 1 >= len(args):
                return (labels, False)
            labels.extend(v.strip() for v in args[j + 1].split(",") if v.strip())
            j += 2
            continue
        if a.startswith("--label="):
            labels.extend(v.strip() for v in a[len("--label="):].split(",") if v.strip())
            j += 1
            continue
        if a.startswith("-l="):
            labels.extend(v.strip() for v in a[len("-l="):].split(",") if v.strip())
            j += 1
            continue
        j += 1
    return (labels, True)


def extract_body_value(args):
    body_parts = []
    j = 0
    while j < len(args):
        a = args[j]
        if a in ("--body", "-b"):
            if j + 1 < len(args):
                body_parts.append(args[j + 1])
                j += 2
                continue
        elif a.startswith("--body="):
            body_parts.append(a[len("--body="):])
            j += 1
            continue
        elif a.startswith("-b="):
            body_parts.append(a[len("-b="):])
            j += 1
            continue
        elif a in ("--body-file", "-F"):
            if j + 1 < len(args):
                filepath = args[j + 1]
                if os.path.isfile(filepath):
                    try:
                        with open(filepath, "r", encoding="utf-8") as f:
                            body_parts.append(f.read())
                    except Exception:
                        pass
                j += 2
                continue
        elif a.startswith("--body-file="):
            filepath = a[len("--body-file="):]
            if os.path.isfile(filepath):
                try:
                    with open(filepath, "r", encoding="utf-8") as f:
                        body_parts.append(f.read())
                except Exception:
                    pass
            j += 1
            continue
        elif a.startswith("-F="):
            filepath = a[len("-F="):]
            if os.path.isfile(filepath):
                try:
                    with open(filepath, "r", encoding="utf-8") as f:
                        body_parts.append(f.read())
                except Exception:
                    pass
            j += 1
            continue
        j += 1
    return "\n".join(body_parts) if body_parts else None


def is_epic_type(tool_input, tokens=None):
    if not isinstance(tool_input, dict):
        tool_input = {}
    for key in ("type", "issue_type", "type_name"):
        val = tool_input.get(key)
        if isinstance(val, str) and val.strip("'\"").lower() == "epic":
            return True
    labels = tool_input.get("labels")
    if isinstance(labels, list):
        if any(isinstance(lbl, str) and lbl.strip("'\"").lower() == "epic" for lbl in labels):
            return True

    if tokens:
        for i, tok in enumerate(tokens):
            if tok in ("--type", "-t", "--label", "-l", "--add-label"):
                if i + 1 < len(tokens) and tokens[i + 1].strip("'\"").lower() == "epic":
                    return True
            for flag in ("--type=", "-t=", "--label=", "-l=", "--add-label="):
                if tok.startswith(flag):
                    val = tok[len(flag):].strip("'\"")
                    parts = [p.strip("'\"").lower() for p in val.split(",")]
                    if "epic" in parts:
                        return True
    return False


def decide(labels, model_labels):
    valid_str = ", ".join(sorted(model_labels))
    matched = sorted({label for label in labels if label in model_labels})
    if len(matched) == 0:
        present = ", ".join(labels) if labels else "(none)"
        return f"DENY:no model label (labels present: {present}). Valid model labels: {valid_str}."
    if len(matched) > 1:
        joined = ", ".join(matched)
        return (
            f"DENY:{len(matched)} model labels given ({joined}) — exactly one is required. "
            f"Valid model labels: {valid_str}."
        )
    return "PASS"


def main():
    try:
        payload = json.loads(INPUT_JSON)
    except Exception:
        print("PASS")
        return

    tool_name = payload.get("tool_name") or ""
    tool_input = payload.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        tool_input = {}

    if tool_name == "Bash":
        cmd = tool_input.get("command", "") or ""
        if not cmd.strip():
            print("PASS")
            return
        try:
            tokens = shlex.split(cmd, posix=True)
        except ValueError:
            if re.search(r"\bgh\b", cmd) and re.search(r"\bissue\b", cmd) and (re.search(r"\bcreate\b", cmd) or re.search(r"\bedit\b", cmd)):
                print("DENY:the command couldn't be parsed (unbalanced quoting) but appears to create/edit a gh issue")
            else:
                print("PASS")
            return

        simple_commands = [[]]
        for tok in tokens:
            if tok in OPERATORS:
                simple_commands.append([])
            else:
                simple_commands[-1].append(tok)

        for sc in simple_commands:
            sc_tokens = strip_leading_assignments(sc)
            create_args = find_gh_issue_create_args(sc_tokens)
            if create_args is not None:
                try:
                    model_labels = load_model_labels()
                except Exception as e:
                    print(f"DENY:couldn't load valid model labels from model-labels.json ({e})")
                    return
                labels, ok = extract_label_values(create_args)
                if not ok:
                    print("DENY:a --label/-l flag was given with no value")
                    return
                res = decide(labels, model_labels)
                if res != "PASS":
                    print(res)
                    return
                body = extract_body_value(create_args)
                if body:
                    pointers = find_unresolvable_issue_pointers(body)
                    if pointers:
                        print(
                            f"DENY:unresolvable pointer phrase '{pointers[0]}' in issue body. "
                            f"Every non-Epic issue body must stand alone without pointer phrases referring to comments or epics."
                        )
                        return
                print("PASS")
                return

            edit_args = find_gh_issue_edit_args(sc_tokens)
            if edit_args is not None:
                if is_epic_type(tool_input, sc_tokens):
                    print("PASS")
                    return
                body = extract_body_value(edit_args)
                if body:
                    pointers = find_unresolvable_issue_pointers(body)
                    if pointers:
                        print(
                            f"DENY:unresolvable pointer phrase '{pointers[0]}' in issue body. "
                            f"Every non-Epic issue body must stand alone without pointer phrases referring to comments or epics."
                        )
                        return
                print("PASS")
                return

        print("PASS")
        return

    if MCP_ISSUE_WRITE_RE.match(tool_name):
        method = tool_input.get("method")
        if method in ("update", "edit"):
            if is_epic_type(tool_input):
                print("PASS")
                return
            body = tool_input.get("body")
            if isinstance(body, str) and body:
                pointers = find_unresolvable_issue_pointers(body)
                if pointers:
                    print(
                        f"DENY:unresolvable pointer phrase '{pointers[0]}' in issue body. "
                        f"Every non-Epic issue body must stand alone without pointer phrases referring to comments or epics."
                    )
                    return
            print("PASS")
            return
        if method != "create":
            print(f"DENY:couldn't determine this issue_write call is a create/update (method={method!r})")
            return
        try:
            model_labels = load_model_labels()
        except Exception as e:
            print(f"DENY:couldn't load valid model labels from model-labels.json ({e})")
            return
        raw_labels = tool_input.get("labels")
        if not isinstance(raw_labels, list) or not all(isinstance(x, str) for x in raw_labels):
            print("DENY:the labels field is missing or not a JSON array of strings")
            return
        res = decide(raw_labels, model_labels)
        if res != "PASS":
            print(res)
            return
        body = tool_input.get("body")
        if isinstance(body, str) and body:
            pointers = find_unresolvable_issue_pointers(body)
            if pointers:
                print(
                    f"DENY:unresolvable pointer phrase '{pointers[0]}' in issue body. "
                    f"Every non-Epic issue body must stand alone without pointer phrases referring to comments or epics."
                )
                return
        print("PASS")
        return

    print("PASS")


main()
PYEOF
) || true

if [ -z "$result" ]; then
  if printf '%s' "$input" | grep -Eq '"tool_name"[[:space:]]*:[[:space:]]*"mcp__[^"]*__issue_write"' \
    || (printf '%s' "$input" | grep -Eq '\bgh\b' \
        && printf '%s' "$input" | grep -Eq '\bissue\b' \
        && (printf '%s' "$input" | grep -Eq '\bcreate\b' || printf '%s' "$input" | grep -Eq '\bedit\b')); then
    echo "BLOCKED (model-label guard): couldn't parse this issue create/edit call (hook parser failure)." >&2
    echo "Check that model label and issue body meet requirements (web-jam-tools#265, web-jam-tools#342)." >&2
    exit 2
  fi
  exit 0
fi

case "$result" in
  PASS)
    exit 0
    ;;
  DENY:*)
    echo "BLOCKED (model-label guard): ${result#DENY:}" >&2
    echo "(rule: executable-issue / model-label — see skills/draft-issue/SKILL.md)" >&2
    exit 2
    ;;
  *)
    exit 0
    ;;
esac
