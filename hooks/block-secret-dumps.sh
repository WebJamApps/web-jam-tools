#!/usr/bin/env bash
# PreToolUse guard (Bash): block commands that print secrets in full to the
# terminal/transcript, and point to a redacting/targeted alternative.
#
# Rationale: see memory feedback-never-dump-secrets-via-config. On 2026-06-13
# `rclone config show gdrive | grep -i type` matched "token_type":"Bearer" and
# printed a gdrive OAuth refresh token into the transcript. Earlier: a bare
# `heroku config` dump leaked GMAIL_APP_PASSWORD (2026-05-18) and a Google key
# (2026-05-30). Exit 2 = block (stderr is shown to the model).
set -euo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)
[ -z "$cmd" ] && exit 0

# collapse newlines/whitespace so multi-line commands match too
c=$(printf '%s' "$cmd" | tr '\n' ' ' | tr -s ' ')

block() {
  echo "BLOCKED (secret-dump guard): $1" >&2
  echo "Safe alternative: $2" >&2
  echo "(rule: feedback-never-dump-secrets-via-config — override by rephrasing to a redacted/targeted form)" >&2
  exit 2
}

# rclone config show/dump prints the OAuth access + refresh token
if printf '%s' "$c" | grep -Eq 'rclone +config +(show|dump)'; then
  block "rclone config show/dump prints the OAuth access/refresh token." \
        "rclone config redacted <remote>  (token masked), or anchor the field: rclone config show <remote> | grep -E '^scope ='"
fi

# bare 'heroku config' (full dump); config:get/set/unset pass through here.
# A pipe to a names-only filter (awk -F: '{print $1}' / cut -d: -f1) is safe —
# it's the very alternative this hook recommends below — so allow that form.
# Any other pipe target (| cat, | tee, ...) still exposes values and stays
# blocked; a bare dump with no pipe at all is always blocked. (web-jam-tools#139)
if printf '%s' "$c" | grep -Eq '(^| )heroku +config( |$)' && ! printf '%s' "$c" | grep -Eq 'heroku +config:(get|set|unset)'; then
  if printf '%s' "$c" | grep -q '|'; then
    after_pipe=$(printf '%s' "$c" | sed -E 's/^[^|]*\|//')
    names_only=false
    if printf '%s' "$after_pipe" | grep -Eq 'awk' \
      && printf '%s' "$after_pipe" | grep -Eq -- '-F:' \
      && printf '%s' "$after_pipe" | grep -Eq 'print' \
      && printf '%s' "$after_pipe" | grep -Eq '\$1'; then
      names_only=true
    fi
    if printf '%s' "$after_pipe" | grep -Eq 'cut' \
      && printf '%s' "$after_pipe" | grep -Eq -- '-d:' \
      && printf '%s' "$after_pipe" | grep -Eq -- '-f ?1'; then
      names_only=true
    fi
    if [ "$names_only" != true ]; then
      block "'heroku config' piped to something other than a names-only filter still exposes secret values." \
            "list names only: heroku config -a <app> | awk -F: '{print \$1}'"
    fi
  else
    block "bare 'heroku config' dumps every config var (secrets included)." \
          "heroku config:get <NON_SECRET_VAR>, or list names only: heroku config -a <app> | awk -F: '{print \$1}'"
  fi
fi

# bare env / printenv dumps the whole environment ('env VAR=x cmd' won't match)
if printf '%s' "$c" | grep -Eq '(^|[;&|] *)(env|printenv) *([|;&]|$)'; then
  block "bare env/printenv dumps the whole environment (secrets included)." \
        "printenv <VAR> for a single non-secret var"
fi

# git config --list / -l can expose tokens embedded in remote URLs
if printf '%s' "$c" | grep -Eq 'git +config +(--list|-l)( |$|[|;&])'; then
  block "git config --list can expose tokens embedded in remote URLs." \
        "git config <single.key>"
fi

# reading known credential/secret files
if printf '%s' "$c" | grep -Eiq '(rclone\.conf|\.circleci-token|gcp-oauth\.keys\.json|oauth_creds|credentials\.json|client_secret|/token\.json|google-drive-mcp/|\.env( |$|/))'; then
  block "this command references a credential/secret file and would print its contents." \
        "confirm you truly need the value; to check existence only: test -f <path> && echo present"
fi

exit 0
