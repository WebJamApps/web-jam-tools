#!/usr/bin/env bash
# PreToolUse guard: deny an issue-creating call that does not carry exactly
# one model label. Design: web-jam-tools#265 ("Hard-gate issue creation on a
# model label", Josh's settled design 2026-07-25).
#
# Rationale: the model label is what routes an issue to the cheapest tier
# that can do the work. web-jam-tools#263 shipped with only a `bug` label and
# no model label because the "always apply it" instruction lived in prose
# (CLAUDE.md + memory) only, and nothing checked it. This hook makes it a
# guarantee instead of a habit.
#
# Matches BOTH surfaces, or the gate is bypassed by simply using the other
# tool:
#   - Bash: `gh issue create` (labels via one or more --label/-l flags, a
#     single comma-separated value, or both mixed).
#   - MCP: any `mcp__*__issue_write` tool (server-agnostic match) whose
#     method is "create" (labels arrive as a JSON array field).
#
# Valid labels are read from the generated JSON sidecar
# skills/fix-labels/model-labels.json — labels.yaml's `modelTier: true`
# entries, computed by src/fix-labels/generate-model-labels.ts — never
# hardcoded here. labels.yaml stays the single hand-edited source of truth;
# this hook reads the sidecar (stdlib `json`, no PyYAML — the CircleCI image
# doesn't have it, web-jam-tools#265 CI fix) so it never needs to parse YAML
# itself. test/fix_labels_model_labels_parity.test.ts fails CI if the
# sidecar ever drifts from labels.yaml.
#
# Fail CLOSED on ambiguity: a call that is clearly creating an issue but
# whose labels can't be confidently parsed is DENIED, not allowed. A false
# block costs one rephrase; a false allow costs the thing this hook exists
# to prevent. Exit 2 = block (stderr shown to the model), matching the
# existing guards' convention (block-secret-dumps.sh, feature-branch-guard.sh).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_LABELS_JSON="$REPO_DIR/skills/fix-labels/model-labels.json"

input=$(cat)

result=$(INPUT_JSON="$input" MODEL_LABELS_JSON_PATH="$MODEL_LABELS_JSON" python3 <<'PYEOF' 2>/dev/null
import json
import os
import re
import shlex

INPUT_JSON = os.environ.get("INPUT_JSON", "")
MODEL_LABELS_PATH = os.environ.get("MODEL_LABELS_JSON_PATH", "")
REGEN_HINT = "regenerate it with `deno task fix-labels:generate-model-labels`"

OPERATORS = {"&&", "||", ";", "|", "(", ")"}
ASSIGN_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
MCP_ISSUE_WRITE_RE = re.compile(r"^mcp__.*__issue_write$")


def load_model_labels():
    """Valid model labels: the modelLabels array in the generated JSON
    sidecar skills/fix-labels/model-labels.json (labels.yaml entries with
    modelTier: true — web-jam-tools#265, the single source of truth, no
    second copy here). Fails CLOSED (raises) if the sidecar is missing,
    unparseable, or empty."""
    with open(MODEL_LABELS_PATH) as f:
        data = json.load(f)
    names = data.get("modelLabels")
    if not isinstance(names, list) or not names:
        raise ValueError(f"modelLabels field is missing or empty ({REGEN_HINT})")
    if not all(isinstance(n, str) and n for n in names):
        raise ValueError(f"modelLabels field contains a non-string/empty entry ({REGEN_HINT})")
    return set(names)


def find_gh_issue_create_args(tokens):
    """None if this simple-command isn't `gh ... issue create ...`; else the
    argv AFTER the literal `create` token (global flags like `-R owner/repo`
    before `issue` are tolerated)."""
    if not tokens:
        return None
    if tokens[0].rsplit("/", 1)[-1] != "gh":
        return None
    for i in range(len(tokens) - 1):
        if tokens[i] == "issue" and tokens[i + 1] == "create":
            return tokens[i + 2:]
    return None


def strip_leading_assignments(tokens):
    i = 0
    while i < len(tokens) and ASSIGN_RE.match(tokens[i]):
        i += 1
    return tokens[i:]


def extract_label_values(args):
    """(labels, ok). ok=False means a --label/-l flag had no value at all
    (malformed, not just "zero model labels among real values")."""
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


def decide(labels, model_labels):
    """PASS, or DENY:<reason> naming what's missing + the valid labels."""
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
        print("PASS")  # not JSON we understand -> nothing this hook can act on
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
            # Unbalanced quotes: can't parse. If the raw text looks like it's
            # creating a gh issue, fail CLOSED rather than guess; otherwise
            # this is out of scope and shouldn't block unrelated commands.
            if re.search(r"\bgh\b", cmd) and re.search(r"\bissue\b", cmd) and re.search(r"\bcreate\b", cmd):
                print("DENY:the command couldn't be parsed (unbalanced quoting) but appears to create a gh issue")
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
            args = find_gh_issue_create_args(strip_leading_assignments(sc))
            if args is None:
                continue
            try:
                model_labels = load_model_labels()
            except Exception as e:
                print(f"DENY:couldn't load valid model labels from model-labels.json ({e})")
                return
            labels, ok = extract_label_values(args)
            if not ok:
                print("DENY:a --label/-l flag was given with no value")
                return
            print(decide(labels, model_labels))
            return

        print("PASS")  # `gh` command, but not `issue create` (e.g. `gh issue list`)
        return

    if MCP_ISSUE_WRITE_RE.match(tool_name):
        method = tool_input.get("method")
        if method == "update":
            print("PASS")  # out of scope: only issue CREATION is gated
            return
        if method != "create":
            # method is a required field on this tool's schema; anything
            # other than the two known values is ambiguous -> fail CLOSED.
            print(f"DENY:couldn't determine this issue_write call is a create (method={method!r})")
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
        print(decide(raw_labels, model_labels))
        return

    print("PASS")  # neither gated surface


main()
PYEOF
) || true

if [ -z "$result" ]; then
  # python3 crashed or is unavailable entirely — we can't tell PASS from
  # DENY. Fail closed ONLY if the raw payload looks like one of the two
  # gated surfaces (an mcp__*__issue_write tool call, or a Bash command
  # mentioning gh/issue/create); otherwise this hook would block every
  # unrelated Bash/MCP call the moment python3 broke, which is a far bigger
  # blast radius than this guard's job.
  if printf '%s' "$input" | grep -Eq '"tool_name"[[:space:]]*:[[:space:]]*"mcp__[^"]*__issue_write"' \
    || (printf '%s' "$input" | grep -Eq '\bgh\b' \
        && printf '%s' "$input" | grep -Eq '\bissue\b' \
        && printf '%s' "$input" | grep -Eq '\bcreate\b'); then
    echo "BLOCKED (model-label guard): couldn't parse this issue-create call (hook parser failure)." >&2
    echo "Valid model labels are in skills/fix-labels/model-labels.json (generated from labels.yaml's modelTier: true entries) — retry with exactly one, or rephrase so the command parses." >&2
    echo "(design: web-jam-tools#265)" >&2
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
    echo "(design: web-jam-tools#265 — pick exactly one model label and retry)" >&2
    exit 2
    ;;
  *)
    exit 0
    ;;
esac
