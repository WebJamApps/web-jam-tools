/**
 * Writes the backend-approval session token that hooks/lib/check_backend_mutation.ts's
 * `loadBackendToken`/`checkSessionToken` read before allowing a production backend mutation
 * (`POST /venue`, `PATCH /venue/:id`, ...) through hooks/block-backend-mutation.sh
 * (web-jam-tools#1021).
 *
 * Closely modeled on scripts/write_issue_approval_token.ts — same builder/writer/CLI shape —
 * but for a DIFFERENT token file with a DIFFERENT shape (see BackendApprovalToken in
 * hooks/lib/check_backend_mutation.ts, imported directly below so this file can never drift from
 * what the guard actually parses):
 *
 *   {
 *     "session_id": "<optional session id the token is scoped to>",
 *     "token": "<optional bearer value a caller may present with --token or a bearer header>",
 *     "endpoints": ["/venue", "/venue/*", "/venue-mining/*"],
 *     "expires_at": "<ISO 8601 timestamp, REQUIRED — loadBackendToken treats a missing/blank
 *                    expires_at as a corrupt file, which fails closed (DENY)>"
 *   }
 *
 * Unlike write_issue_approval_token.ts (web-jam-tools#808), this writer has no transcript-based
 * authorization gate: the guard's own remediation text says "approved by Josh", meaning Josh (or
 * an agent Josh told to) runs `deno task backend-approval-token` directly — there is no
 * `/design-issue`/`/file-issue`-shaped plan gate this token is meant to sit behind, and the guard
 * itself never reads a transcript (see isVenueMiningContext's doc comment in
 * check_backend_mutation.ts for why a transcript scan is unsafe for a guard). If a future issue
 * wants an authorization gate here, model it on checkTokenWriteAuthorization the same way #808 did
 * for the issue-approval token — don't bolt it on ad hoc.
 *
 * A presented `--token`/bearer value is never itself sufficient; checkSessionToken always ALSO
 * validates expiry/session/endpoint against the file. Because of that, most callers never need to
 * know the raw token value at all — a valid token FILE alone (nothing presented) is the approval.
 * For that reason, and because this token is a real secret (unlike the issue-approval token, which
 * carries no secret field), this CLI never prints the full token value to stdout, in --json mode or
 * otherwise — only a short prefix, enough to confirm which token was written without exposing it in
 * scrollback, shell history, or an agent transcript. The full value is only ever in the token file
 * itself, written with owner-only (0600) permissions.
 *
 * CLI usage:
 *   deno run --allow-env --allow-read --allow-write scripts/write_backend_approval_token.ts \
 *     --ttl-minutes 30 \
 *     --endpoints "/venue,/venue/*,/venue-mining/*" \
 *     --session-id "<session-id>"
 */

import { dirname } from "@std/path";
import { parseArgs } from "@std/cli/parse-args";
import {
  type BackendApprovalToken,
  defaultBackendTokenPath,
} from "../hooks/lib/check_backend_mutation.ts";

/** Endpoint patterns the guard accepts by default when the caller doesn't override them. */
export const DEFAULT_ENDPOINTS: readonly string[] = ["/venue", "/venue/*", "/venue-mining/*"];

/** Default token lifetime when neither --ttl-minutes nor --expires-at is given. */
export const DEFAULT_TTL_MINUTES = 30;

export interface WriteBackendApprovalTokenOptions {
  sessionId?: string;
  token?: string;
  endpoints?: string[];
  expiresAt?: string;
  ttlMinutes?: number;
  tokenPath?: string;
}

/** Generates a random hex bearer token — used when the caller omits --token. */
export function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Builds and validates a BackendApprovalToken object. Throws an Error on an invalid TTL or an
 * unparseable explicit expiresAt — the guard's own isTokenExpired() fails closed (treats an
 * unparseable expires_at as already expired), so catching it here at write time gives the caller
 * an immediate, actionable error instead of a silently-useless token file.
 */
export function buildBackendApprovalToken(
  options: WriteBackendApprovalTokenOptions = {},
): BackendApprovalToken {
  const sessionId = options.sessionId?.trim();

  const token = options.token?.trim() || generateToken();

  const endpointsInput = options.endpoints !== undefined ? options.endpoints : DEFAULT_ENDPOINTS;
  const endpoints = endpointsInput.map((e) => e.trim()).filter((e) => e.length > 0);
  if (endpoints.length === 0) {
    throw new Error("endpoints must contain at least one non-empty pattern");
  }

  let expiresAt = options.expiresAt?.trim();
  if (!expiresAt) {
    const ttlMinutes = options.ttlMinutes ?? DEFAULT_TTL_MINUTES;
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
      throw new Error(`ttlMinutes must be a positive number, got: ${options.ttlMinutes}`);
    }
    expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  } else {
    const parsed = Date.parse(expiresAt);
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid expiresAt timestamp: ${expiresAt}`);
    }
  }

  const result: BackendApprovalToken = { token, endpoints, expires_at: expiresAt };
  if (sessionId) result.session_id = sessionId;
  return result;
}

/** Writes the approval token to disk asynchronously, creating the parent directory if missing and
 * setting owner-only (0600) permissions on the token file. */
export async function writeBackendApprovalToken(
  options: WriteBackendApprovalTokenOptions = {},
): Promise<{ token: BackendApprovalToken; path: string }> {
  const token = buildBackendApprovalToken(options);
  const path = options.tokenPath || defaultBackendTokenPath();
  const dir = dirname(path);
  if (dir && dir !== ".") {
    await Deno.mkdir(dir, { recursive: true });
  }
  await Deno.writeTextFile(path, JSON.stringify(token, null, 2) + "\n");
  await Deno.chmod(path, 0o600);
  return { token, path };
}

/** Synchronous counterpart to writeBackendApprovalToken. */
export function writeBackendApprovalTokenSync(
  options: WriteBackendApprovalTokenOptions = {},
): { token: BackendApprovalToken; path: string } {
  const token = buildBackendApprovalToken(options);
  const path = options.tokenPath || defaultBackendTokenPath();
  const dir = dirname(path);
  if (dir && dir !== ".") {
    Deno.mkdirSync(dir, { recursive: true });
  }
  Deno.writeTextFileSync(path, JSON.stringify(token, null, 2) + "\n");
  Deno.chmodSync(path, 0o600);
  return { token, path };
}

/** Redacts a secret value for terminal/log output: first 6 chars plus a length-independent
 * ellipsis, never the full value. */
export function redactToken(token: string): string {
  if (token.length <= 6) return "*".repeat(token.length);
  return `${token.slice(0, 6)}...(redacted)`;
}

function parseEndpoints(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // fall through to comma-splitting
  }
  return raw.split(",");
}

if (import.meta.main) {
  try {
    const args = parseArgs(Deno.args, {
      string: [
        "session-id",
        "token",
        "endpoints",
        "ttl-minutes",
        "expires-at",
        "path",
      ],
      boolean: ["json", "help"],
      alias: {
        s: "session-id",
        t: "token",
        e: "endpoints",
        p: "path",
        h: "help",
      },
    });

    if (args.help) {
      console.log(
        `Usage: deno task backend-approval-token [options]
   or: deno run --allow-env --allow-read --allow-write scripts/write_backend_approval_token.ts [options]

Writes the backend-mutation approval token that hooks/block-backend-mutation.sh checks before
allowing a production venue mutation (POST /venue, PATCH /venue/:id, ...).

Options:
  -s, --session-id <id>     Scope the token to a session id (omit to leave it unscoped — a
                            missing/blank session_id in the token file matches any session)
  -t, --token <value>       Bearer value a caller may present with --token or a bearer header
                            (generated randomly when omitted; never printed in full)
  -e, --endpoints <list>    Approved endpoint patterns, JSON array or comma-separated, trailing
                            "*" wildcard supported (default: ${DEFAULT_ENDPOINTS.join(",")})
  --ttl-minutes <minutes>   Token TTL in minutes from now (default: ${DEFAULT_TTL_MINUTES})
  --expires-at <iso>        Explicit expiration ISO 8601 timestamp (overrides --ttl-minutes)
  -p, --path <path>         Override token output path (defaults to $BACKEND_APPROVAL_TOKEN_PATH,
                            $VENUE_APPROVAL_TOKEN_PATH, or ~/.claude/state/backend-approval-token.json)
  --json                    Also print the written token as JSON to stdout (token field redacted)
  -h, --help                Show this help message
`,
      );
      Deno.exit(0);
    }

    const sessionId = args["session-id"] ||
      Deno.env.get("CLAUDE_CODE_SESSION_ID") ||
      Deno.env.get("CLAUDE_SESSION_ID") ||
      Deno.env.get("SESSION_ID") ||
      undefined;

    const ttlMinutes = args["ttl-minutes"] ? Number(args["ttl-minutes"]) : undefined;

    const { token, path } = await writeBackendApprovalToken({
      sessionId,
      token: args.token,
      endpoints: parseEndpoints(args.endpoints),
      ttlMinutes,
      expiresAt: args["expires-at"],
      tokenPath: args.path,
    });

    const redacted = { ...token, token: redactToken(token.token ?? "") };

    if (args.json) {
      console.log(JSON.stringify(redacted, null, 2));
    }
    console.log(
      `Approval token successfully written to ${path} ` +
        `(expires ${token.expires_at}, endpoints: ${(token.endpoints ?? []).join(", ")}, ` +
        `token: ${redacted.token})`,
    );
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
}
