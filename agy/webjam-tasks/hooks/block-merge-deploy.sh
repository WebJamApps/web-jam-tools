#!/usr/bin/env bash
# agy PreToolUse hook (plugin-bundled): denies PR merges, protected-branch
# pushes, and production deploys inside an Antigravity CLI (agy/Flash)
# session. web-jam-tools#308 follow-up "gap 2" -- hooks/block-dangerous-git-
# deploy.sh only binds Claude Code's harness; agy runs its own sessions
# outside that harness entirely, so none of Claude's PreToolUse guards ever
# fire for it. This hook is the agy-native equivalent, shipped as part of
# this plugin so it installs wherever the webjam-tasks plugin does.
#
# Contract (antigravity.google/docs/hooks, verified 2026-07-30): a PreToolUse
# hook receives a JSON payload on stdin shaped roughly like
# {"toolCall":{"name":...,"args":{...}}, "stepIdx":..., ...} and must print a
# JSON decision to stdout: {"decision":"allow"} lets the call proceed;
# {"decision":"deny","reason":"..."} hard-blocks it before it runs.
#
# Field-name caveat (documented honestly, not asserted from source): agy is
# closed-source (a compiled binary, not a browsable repo), so the exact args
# schema for its shell-execution tool (docs/blog examples call it
# `run_command` with args including CommandLine/Cwd/WaitMsBeforeAsync) is not
# independently verifiable here. Rather than hard-code one field name that
# might be wrong and silently never fire, this hook stringifies the ENTIRE
# stdin payload and pattern-matches that blob -- whatever field actually
# holds the command text, its content still appears somewhere in the JSON.
# The hooks.json matcher is "*" for the same reason: it costs one extra
# process per tool call, but removes any dependency on knowing the exact
# tool name.
#
# Known limitation vs. the Claude-side hook: this is a simpler, blunter port.
# It does NOT share hooks/lib/normalize_command.py's heredoc/prose stripping,
# so it may over-block prose that merely MENTIONS a blocked command (e.g. a
# PR body describing `deno deploy --prod`) rather than executing it. That is
# an intentional bias toward safety, not an oversight -- see the PR/issue for
# the honest statement of what is and is not verified end-to-end.
set -euo pipefail

input=$(cat)

blob=$(printf '%s' "$input" | python3 -c '
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    print("")
    sys.exit(0)
print(json.dumps(data))
' 2>/dev/null || true)
[ -z "$blob" ] && blob=$(printf '%s' "$input" | tr "\n" " ")

# Boundary class for a JSON-encoded string blob: a word ends at a space, an
# unescaped closing quote, a backslash (start of an escape sequence), a
# comma/brace (adjacent JSON structure), or end of string.
B='([ ",}]|$)'

deny() {
  python3 -c 'import json,sys; print(json.dumps({"decision":"deny","reason":sys.argv[1]}))' "$1"
  exit 0
}

# 1) Any PR merge (includes --admin / --squash / --rebase / --merge)
if printf '%s' "$blob" | grep -Eq "gh +pr +merge$B"; then
  deny "'gh pr merge' -- merging a PR is Josh's decision (web-jam-tools merge/deploy guard)."
fi

# 2) Branch-protection writes via the API (PUT/DELETE/PATCH on .../protection)
if printf '%s' "$blob" | grep -Eq "gh +api$B" \
  && printf '%s' "$blob" | grep -Eq 'branches/[^ "]*protection' \
  && printf '%s' "$blob" | grep -Eq '(-X|--method) +(PUT|DELETE|PATCH)'; then
  deny "writing branch protection via 'gh api .../protection' is Josh's call (web-jam-tools merge/deploy guard)."
fi

# 3) Pushing to a protected branch (main/dev), force or not.
if printf '%s' "$blob" | grep -Eq "git +push .*( (main|dev)$B|:(main|dev)$B)"; then
  deny "'git push' to a protected branch (main/dev) -- open a PR instead (web-jam-tools merge/deploy guard)."
fi

# 4) Production deploy
if printf '%s' "$blob" | grep -Eq "deno +deploy$B.*--prod$B" \
  || printf '%s' "$blob" | grep -Eq "deployctl +deploy$B"; then
  deny "production deploy command -- deploying is Josh's decision (web-jam-tools merge/deploy guard)."
fi

# 5) REST/GraphQL merge endpoints (same gap-1 fix as the Claude-side hook)
if printf '%s' "$blob" | grep -Eq "gh +api$B"; then
  if printf '%s' "$blob" | grep -Eq "pulls/[^ \"]+/merge($B|\\\\?)" \
    && printf '%s' "$blob" | grep -Eq '(-X|--method) +PUT'; then
    deny "'gh api ... pulls/N/merge' (PUT) -- merging a PR via the REST API is Josh's decision (web-jam-tools merge/deploy guard)."
  fi
  if printf '%s' "$blob" | grep -Eq "repos/[^ \"]+/merges($B|\\\\?)"; then
    deny "'gh api ... repos/OWNER/REPO/merges' -- merging a branch via the REST API is Josh's decision (web-jam-tools merge/deploy guard)."
  fi
  if printf '%s' "$blob" | grep -Eq "graphql$B" \
    && printf '%s' "$blob" | grep -Eq 'merge(PullRequest|Branch)'; then
    deny "'gh api graphql' merge mutation -- merging via the GraphQL API is Josh's decision (web-jam-tools merge/deploy guard)."
  fi
fi

echo '{"decision":"allow"}'
exit 0
