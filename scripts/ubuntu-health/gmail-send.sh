#!/usr/bin/env bash
# gmail-send.sh — the root-owned, send-only Gmail sender for the ubuntu-health weekly job.
#
# Usage: gmail-send.sh <subject>   (the plain-text body is read from stdin)
#
# Makes the same two Gmail API requests as src/shared/gmail_send.ts — a token refresh, then
# users/me/messages/send — with curl, because the scheduled job never runs Deno.
# Reads GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN from
# /etc/ubuntu-health/gmail-send.env, which must be owned by root with mode 0600. The file is
# parsed, never sourced, and the secrets reach curl on stdin, never on its command line.
# Every failure writes one line to stderr (the job's log), sends nothing more, and exits 1.
set -euo pipefail

ROOT="${UBUNTU_HEALTH_ROOT:-}"
ENV_FILE="$ROOT/etc/ubuntu-health/gmail-send.env"
TO="joshua.v.sherman@gmail.com"

fail() {
  echo "gmail-send: $*" >&2
  exit 1
}

[ "$#" -eq 1 ] || fail "usage: gmail-send.sh <subject> (body on stdin)"
SUBJECT="$1"

[ -f "$ENV_FILE" ] || fail "email login missing: $ENV_FILE does not exist"

want_uid=0
[ -z "$ROOT" ] || want_uid="$(id -u)" # the test harness stands in for root
mode="$(stat -c %a "$ENV_FILE")"
owner="$(stat -c %u "$ENV_FILE")"
if (((8#$mode & ~8#600) != 0)); then
  fail "refusing to read $ENV_FILE: mode is $mode, wider than 600"
fi
[ "$owner" -eq "$want_uid" ] || fail "refusing to read $ENV_FILE: it is not owned by root"

client_id="" client_secret="" refresh_token=""
while IFS='=' read -r key value; do
  case "$key" in
    GMAIL_CLIENT_ID) client_id="$value" ;;
    GMAIL_CLIENT_SECRET) client_secret="$value" ;;
    GMAIL_REFRESH_TOKEN) refresh_token="$value" ;;
  esac
done <"$ENV_FILE"
for v in "$client_id" "$client_secret" "$refresh_token"; do
  [[ "$v" =~ ^[A-Za-z0-9._/+=~-]+$ ]] || fail "$ENV_FILE must set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN"
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

b64url() { base64 -w0 | tr '+/' '-_' | tr -d '='; }
body_b64="$(base64 -w76 | sed 's/$/\r/')"
printf 'To: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n%s\r\n' \
  "$TO" "$SUBJECT" "$body_b64" >"$work/message"
printf '{"raw":"%s"}' "$(b64url <"$work/message")" >"$work/send.json"

response="$(curl -sS -K - https://oauth2.googleapis.com/token <<CONFIG
data-urlencode = "client_id=$client_id"
data-urlencode = "client_secret=$client_secret"
data-urlencode = "refresh_token=$refresh_token"
data-urlencode = "grant_type=refresh_token"
CONFIG
)" || fail "token refresh: curl failed"
token="$(printf '%s\n' "$response" | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p' | head -n1)"
[ -n "$token" ] || fail "token refresh: $(printf '%s' "$response" | tr -s '[:space:]' ' ')"

response="$(curl -sS -K - --data-binary "@$work/send.json" https://gmail.googleapis.com/gmail/v1/users/me/messages/send <<CONFIG
header = "Authorization: Bearer $token"
header = "Content-Type: application/json"
CONFIG
)" || fail "gmail send: curl failed"
printf '%s\n' "$response" | grep -q '"id"' || fail "gmail send: $(printf '%s' "$response" | tr -s '[:space:]' ' ')"
