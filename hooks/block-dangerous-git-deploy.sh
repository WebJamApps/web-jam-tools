#!/usr/bin/env bash
# PreToolUse guard (Bash): HARD-BLOCK outward/irreversible actions Claude must
# never take autonomously — PR merges, branch-protection changes, pushes to
# protected branches (main/dev), and production deploys. Josh performs these
# himself; Claude proposes and STOPS.
#
# See memory: never-merge-or-deploy-without-permission. Exit 2 = block
# (stderr is shown to the model). Added 2026-06-15 after an unauthorized
# `gh pr merge --admin` dev->main that triggered a production deploy.
set -euo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)
[ -z "$cmd" ] && exit 0
# Normalize exactly as block-secret-dumps.sh does (web-jam-tools#272). Until
# now only that guard stripped heredoc bodies and prose flag values, so text
# that merely MENTIONED a deploy — a PR body, or a test fixture asserting that
# `deno deploy --prod` is blocked — tripped this guard while the same text
# passed the other one. That inconsistency is what this fixes.
#
# The shared normalizer keeps an interpreter-fed heredoc body in scope
# (`bash <<EOF ... EOF` really executes), so stripping cannot become a bypass.
# Falls back to the naive collapse if python3 is unavailable — bias to safety.
HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
NORMALIZER="$HOOK_DIR/lib/normalize_command.py"
c=$(CMD_FOR_PY="$cmd" python3 "$NORMALIZER" 2>/dev/null) || true
if [ -z "$c" ]; then
  c=$(printf '%s' "$cmd" | tr '\n' ' ' | tr -s ' ')
fi
# Newline-preserving form for rule 3, which splits on command separators.
cmd_hd=$(CMD_FOR_PY="$cmd" NORMALIZE_MODE=heredoc-only python3 "$NORMALIZER" 2>/dev/null) || true
[ -z "$cmd_hd" ] && cmd_hd=$cmd

block() {
  echo "BLOCKED (merge/deploy guard): $1" >&2
  echo "This is Josh's action to perform, not Claude's: propose it and STOP, let Josh run it himself." >&2
  echo "(rule: never-merge-or-deploy-without-permission — do NOT retry or work around this block)" >&2
  exit 2
}

# 1) Any PR merge (includes --admin / --squash / --rebase / --merge)
if printf '%s' "$c" | grep -Eq 'gh +pr +merge( |$)'; then
  block "'gh pr merge' — merging a PR is Josh's decision."
fi

# 2) Branch-protection writes via the API (PUT/DELETE/PATCH on .../protection)
if printf '%s' "$c" | grep -Eq 'gh +api( |$)' \
  && printf '%s' "$c" | grep -Eq 'branches/[^ ]*protection' \
  && printf '%s' "$c" | grep -Eq '(-X|--method) +(PUT|DELETE|PATCH)'; then
  block "writing branch protection via 'gh api .../protection' is Josh's call."
fi

# 3) Pushing to a protected branch (main/dev), force or not. Allows feature
#    branches (e.g. 'git push -u origin claude/...'). Split compound commands on
#    separators (&&, ||, ;, |, newline) so 'git push' and a main/dev REF must be
#    on the SAME sub-command — an unrelated 'dev' elsewhere (e.g.
#    'git push origin feat && gh pr create --base dev') won't false-positive.
if printf '%s' "$cmd_hd" | sed -E 's/(\&\&|\|\||;|\|)/\n/g' \
  | grep -Eq 'git +push .*( (main|dev)( |$)|:(main|dev)( |$))'; then
  block "'git push' to a protected branch (main/dev) — open a PR instead."
fi

# 4) Production deploy
if printf '%s' "$c" | grep -Eq 'deno +deploy( |$).*--prod( |$)' \
  || printf '%s' "$c" | grep -Eq 'deployctl +deploy( |$)'; then
  block "production deploy command — deploying is Josh's decision."
fi

exit 0
