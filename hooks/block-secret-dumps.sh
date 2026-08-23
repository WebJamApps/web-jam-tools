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
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
[ -z "$cmd" ] && exit 0

# Build an operation-anchored view of the command for the checks below
# (web-jam-tools#261): strip heredoc BODY text and drop the VALUE of a known
# prose-carrying flag (an issue --body, a git commit -m, ...) before matching,
# so a secret filename or dump-command name that's merely *mentioned* in
# prose being written elsewhere doesn't block the command — only an actual
# command-position occurrence (a real argument token, not sentence text)
# still does.
#
# Earlier version of this fix dropped ANY shlex token containing internal
# whitespace, on the theory that only a quoted phrase can contain whitespace.
# That's true, but it's not only prose that gets quoted — `bash -c "cat
# .env"` / `sh -c 'heroku config'` quote their PAYLOAD too, and that blanket
# rule silently dropped it, reopening exactly the dump the guard exists to
# catch. Fixed by narrowing to an explicit flag allowlist: a token is only
# dropped when the immediately preceding token is one of the prose-carrying
# flags below (or via the `--flag=value` single-token form for the same
# flags) — `-c` is deliberately NOT on this list, so a `sh -c`/`bash -c`/
# `python3 -c`/etc. payload stays in scope for matching same as any other
# argument. As a second safety net, a flag value is still kept (not dropped)
# when it carries a shell operator char ($( ` < >) — a phrase that performs a
# real substitution/read (e.g. "$(< .env)") is never treated as safe prose.
#
# Heredoc bodies are found via a quote-aware per-line scan (a literal "<<"
# inside prose, e.g. "use << as a marker", is never mistaken for real heredoc
# syntax) and, if a closing delimiter is never found, the lines are put back
# rather than silently dropped. On any parse failure (unbalanced quotes,
# Deno unavailable) this falls back to the old "match anywhere" collapse —
# bias to safety, per the issue's guidance.
# Resolve this hook's REAL directory (it is installed as a symlink into
# ~/.claude/hooks, so readlink -f is required) to find the shared normalizer.
HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
c=$(CMD_FOR_PY="$cmd" deno run --no-config --allow-env "$HOOK_DIR/lib/normalize_command.ts" 2>/dev/null) || true
if [ -z "$c" ]; then
  # Deno unavailable or crashed: fall back to the old collapse so the
  # guard still fires on unambiguous cases rather than silently no-op'ing.
  c=$(printf '%s' "$cmd" | tr '\n' ' ' | tr -s ' ')
fi

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

# Echoing a credential-NAMED variable prints its value (web-jam-tools#272).
# The 2026-07-26 leak was a presence check, not a file dump:
#   echo "${TOK:+SET (value hidden)}${TOK:-NOT SET}"
# `:+` and `:-` are opposite halves — `:-` expands to the VALUE whenever the
# var IS set, so the "hidden" branch and the real token both printed.
#
# Scope is deliberately narrow: only OUTPUT commands (echo/printf/print).
# Passing a secret to a command that consumes it — curl -u "$CIRCLECI_TOKEN:"
# — is normal and must keep working, so plain expansion elsewhere is allowed.
#
# Provably-safe forms are stripped before the test, so they never trigger it:
#   ${VAR:+literal}  expands to the LITERAL, never the value
#   ${#VAR}          expands to the length only
safe_stripped=$(printf '%s' "$c" | sed -E \
  -e 's/\$\{#[A-Za-z_][A-Za-z0-9_]*\}//g' \
  -e 's/\$\{[A-Za-z_][A-Za-z0-9_]*:\+[^}]*\}//g')
# Only the OUTPUT command's OWN arguments are examined — everything from an
# echo/printf up to the next separator. Testing the whole command string
# instead would misfire on  [ -n "$TOK" ] && echo SET , where the expansion
# belongs to the test and never reaches echo. `echo` is matched after any
# whitespace too, so a nested  bash -ic 'echo "$TOK"'  is still caught.
# NOTE: `|| true` is required — the script runs under `set -euo pipefail`, and
# grep -o exits 1 when it matches nothing (the common case: most commands have
# no echo at all). Without it every ordinary command aborts the guard with
# exit 1, which reads as neither "allow" (0) nor "block" (2).
echo_args=$(printf '%s' "$safe_stripped" |
  grep -oE '(^|[[:space:];&|])(echo|printf|print)[^;&|]*' | tr '\n' ' ' || true)
if printf '%s' "$echo_args" | grep -Eiq '\$\{?[A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|AUTH)[A-Za-z0-9_]*'; then
  block "echoing a credential-named variable prints its value (\${VAR:-...} expands to the VALUE when set)." \
        "test presence without expanding it: [ -n \"\$VAR\" ] && echo SET || echo 'NOT SET'   (or \${VAR:+SET} / \${#VAR})"
fi

# reading known credential/secret files
#
# The .env boundary (web-jam-tools#257 review fix) matches a literal `.`
# (so .env.test/.env.local/.env.production are recognized too), any
# non-identifier character (space, /, ), quote, pipe, redirect, backtick,
# $, etc.), or end-of-string. The old `( |$|/)` boundary missed both: (a)
# suffixed files like .env.test/.env.local fell outside the match entirely
# (so `cat .env.test` was never even flagged), and (b) .env wrapped in
# command substitution parens, e.g. `echo $(cat .env)` or
# `printf '%s' "$(< .env)"`, dodged the guard because ")" wasn't in the old
# boundary set. Still excludes real words like "environment" (the char
# after "env" there is alnum, matching neither alternative).
# web-jam-tools#272: shell rc/profile files, .netrc, .npmrc, gh's hosts.yml and
# agy's settings.json all hold live credentials and were NOT on this list — that
# is how a Dropbox refresh token (tail -15 ~/.bashrc) and a Google API key
# (agy settings.json) reached transcripts on 2026-07-25.
SECRET_FILE_RE='(rclone\.conf|\.circleci-token|gcp-oauth\.keys\.json|oauth_creds|credentials\.json|client_secret|/token\.json|google-drive-mcp/|\.bashrc|\.bash_profile|\.zshrc|\.zprofile|/\.profile|\.netrc|\.npmrc|\.config/gh/hosts\.yml|antigravity-cli/settings\.json|\.env(\.|[^A-Za-z0-9_-]|$))'
if printf '%s' "$c" | grep -Eiq "$SECRET_FILE_RE"; then
  # WRITE-ONLY exception (web-jam-tools#272): appending to ~/.bashrc is normal,
  # safe work — the guard must block READING these files, not writing to them.
  # Strip every redirect target (`> path`, `>> path`); if no secret path
  # remains, the file was only ever written to, never read.
  #   cat >> ~/.bashrc <<'EOF' ... EOF   -> allowed (heredoc body, not the file)
  #   echo 'export X=1' >> ~/.bashrc     -> allowed
  #   cat .env > /tmp/x                  -> still BLOCKED (.env is read here)
  # `tee` is deliberately NOT covered: it copies stdin to stdout as well as to
  # the file, so `tee .env` is never write-only.
  write_stripped=$(printf '%s' "$c" | sed -E 's/>>?[[:space:]]*[^[:space:];&|]+//g')
  if ! printf '%s' "$write_stripped" | grep -Eiq "$SECRET_FILE_RE"; then
    exit 0
  fi
  # cp/test exception (web-jam-tools#257): copying a secret file or checking
  # its existence never prints its contents (you could already copy-then-print
  # today), so a *simple* `cp` or `test`/`[` invocation is allowed. This is
  # what unblocks seeding a gitignored .env into a fresh git worktree, which
  # this same guard was blocking outright (even the `test -f <path>` it
  # recommends as the safe check below was itself blocked for .env).
  #
  # "Simple" means: no pipe, no redirect, no command substitution, and no
  # chained command — those can still exfiltrate the value (e.g.
  # `cp .env /dev/stdout`, `test -f .env && cat .env`) and must stay blocked.
  # Same reasoning covers a copy to a process file descriptor
  # (`cp .env /proc/self/fd/1`, `/proc/1234/fd/2`) or the terminal
  # (`cp .env /dev/tty`, `/dev/tty1`) — both dump the contents to
  # stdout/the terminal just like /dev/stdout does, so they disqualify the
  # exception too. When in doubt this falls through to the block below.
  if ! printf '%s' "$c" | grep -Eq '[|<>`;&]|\$\(' \
    && ! printf '%s' "$c" | grep -Eiq '/dev/(stdout|stderr|fd/)|/proc/[^ ]+/fd/|/dev/tty'; then
    if printf '%s' "$c" | grep -Eq '^ *cp +' \
      || printf '%s' "$c" | grep -Eq '^ *(test|\[) '; then
      exit 0
    fi
  fi
  block "this command references a credential/secret file and would print its contents." \
        "cp <path> <dest> to copy it, or test -f <path> (then check \$?) to check existence — both allowed only as simple, unchained invocations with no pipe/redirect/substitution (web-jam-tools#257)"
fi

exit 0
