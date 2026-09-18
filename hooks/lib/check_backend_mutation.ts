/**
 * Decision logic for hooks/block-backend-mutation.sh (web-jam-tools#1021).
 *
 * PreToolUse safety guard that intercepts shell tool calls (Bash on Claude Code,
 * run_command on agy) that attempt HTTP mutations (POST, PATCH, PUT, DELETE)
 * against the production backend (https://webjamsalem.herokuapp.com) and strictly
 * enforces skill boundaries between venue-mining and book-gig.
 *
 * Classification: SAFETY GUARD (prevents irreversible production record mutations).
 * Default when unable to determine validity: REFUSES (fails closed with exit 2).
 * Safety guards NEVER read workflow off-switches.
 *
 * Outcomes:
 *   - Condition holds (permitted): Target is an authorized venue endpoint AND a
 *     presented token (bearer header, `--token <v>`, `--token=<v>`) — if any is
 *     presented — MATCHES the `token` field of an approval token file that also
 *     passes its own expiry/session/endpoint checks (a valid approval file with
 *     NO token presented on the command line is itself sufficient) -> ALLOW.
 *   - Condition does not hold (denied): No matching/valid approval, an ad-hoc
 *     unapproved write, or an outreach operation during venue-mining -> DENY
 *     (refuses with structured explanation naming which check failed).
 *   - Indeterminate condition: Parser failure, missing environment, unparseable
 *     command, or corrupt token state -> DENY (fails closed).
 *   - Out of scope (read-only query or unrelated command) -> PASS.
 *
 * Script files (`deno run <file>`, `node <file>`, `python3 <file>`, `bash
 * <file>`, `sh <file>`) are read (capped at ~256 KB) and analyzed with the
 * same backend-mutation/outreach logic as inline code (`deno eval`, `node
 * -e`, `python3 -c`) — see `readScriptFile` / `decideScriptContent`. An
 * unreadable or missing script file PASSES rather than denying.
 *
 * venue-mining context (`isVenueMiningContext`) is inferred ONLY from
 * `ACTIVE_SKILL`/`SKILL_NAME` env, `payload.cwd`, and a narrow match on the
 * CURRENT command (skill invocation, its SKILL.md path, or one of its deno
 * tasks) — never from `transcript_path`. See the comment on
 * `isVenueMiningContext` for why a transcript scan is unsafe for a guard.
 */

import {
  resolveThroughWrappers,
  splitOnOperators,
  splitShellTokens,
  stripHeredocs,
} from "./normalize_command.ts";

export type BackendMutationOutcome = "allow" | "deny" | "pass";

export interface DecisionResult {
  outcome: BackendMutationOutcome;
  reason?: string;
}

export interface BackendApprovalToken {
  session_id?: string;
  token?: string;
  endpoints?: string[];
  expires_at: string;
}

export function defaultBackendTokenPath(): string {
  const override = Deno.env.get("BACKEND_APPROVAL_TOKEN_PATH") ||
    Deno.env.get("VENUE_APPROVAL_TOKEN_PATH");
  if (override) return override;
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "/home/joshua";
  return `${home}/.claude/state/backend-approval-token.json`;
}

// The remediation named in every deny message that requires approval. The
// sanctioned route is an active session approval token FILE, approved by
// Josh — NOT `deno task venue:create`/`venue:patch`, which are not real
// `deno.json` tasks on this branch (web-jam-tools#1021 review Must Fix #4).
// The `venue:*` deno-task branch below stays in the code (harmless, and
// correct if such a task ever ships) but uses this same remediation text.
const APPROVAL_REMEDIATION =
  "Approve by running `deno task backend-approval-token` (writes an active session " +
  "approval token file, default ~/.claude/state/backend-approval-token.json, override with " +
  "BACKEND_APPROVAL_TOKEN_PATH or VENUE_APPROVAL_TOKEN_PATH), approved by Josh.";

const OUTREACH_DURING_VENUE_MINING_REASON =
  "Outreach operations (/outreach/*, book-gig, outreach:*) are forbidden during " +
  "venue-mining tasks (skill boundary violation; see web-jam-tools#1021 " +
  '"hooks/backend-guard: guard production backend mutations and enforce ' +
  'venue-mining skill boundaries").';

const DIRECT_OUTREACH_MUTATION_REASON =
  "Direct outreach mutations against the production backend " +
  "(https://webjamsalem.herokuapp.com) are forbidden; outreach workflows must " +
  "run through approved skills/book-gig/SKILL.md gates.";

export type TokenLoadResult =
  | { kind: "missing" }
  | { kind: "corrupt"; reason: string }
  | { kind: "valid"; token: BackendApprovalToken };

export function loadBackendToken(tokenPath: string): TokenLoadResult {
  let text: string;
  try {
    text = Deno.readTextFileSync(tokenPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return { kind: "missing" };
    }
    return {
      kind: "corrupt",
      reason: `Cannot read token file at ${tokenPath}: ${(err as Error).message}`,
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return {
      kind: "corrupt",
      reason: `Token file at ${tokenPath} is invalid JSON: ${(err as Error).message}`,
    };
  }
  if (typeof data !== "object" || data === null) {
    return { kind: "corrupt", reason: `Token file at ${tokenPath} is not a JSON object` };
  }
  const d = data as Record<string, unknown>;
  if (typeof d.expires_at !== "string" || !d.expires_at) {
    return {
      kind: "corrupt",
      reason: `Token file at ${tokenPath} lacks valid expires_at timestamp`,
    };
  }
  return {
    kind: "valid",
    token: {
      session_id: typeof d.session_id === "string" ? d.session_id : undefined,
      token: typeof d.token === "string" ? d.token : undefined,
      endpoints: Array.isArray(d.endpoints) && d.endpoints.every((e) => typeof e === "string")
        ? (d.endpoints as string[])
        : undefined,
      expires_at: d.expires_at,
    },
  };
}

export function isTokenExpired(token: BackendApprovalToken, nowMs: number): boolean {
  const expMs = new Date(token.expires_at).getTime();
  if (isNaN(expMs)) return true; // unparseable timestamp fails closed
  return expMs <= nowMs;
}

/**
 * Validate the session approval token file, and — if `presentedToken` is
 * given (from a curl bearer header, `--token <v>`, or `--token=<v>`) —
 * require it to MATCH the file's own `token` field on top of the existing
 * expiry/session/endpoint checks. A presented token is never itself
 * authorization; it only narrows an otherwise-valid approval file to the
 * caller that was actually handed the token. Omitting `presentedToken`
 * (i.e. no token was presented on the command line) validates the file
 * alone — a valid approval file with nothing presented is the approval.
 */
export function checkSessionToken(
  tokenPath: string,
  sessionId?: string,
  endpoint?: string,
  nowMs = Date.now(),
  presentedToken?: string,
): { valid: boolean; reason?: string; corrupt?: boolean } {
  const load = loadBackendToken(tokenPath);
  if (load.kind === "missing") {
    return { valid: false, reason: "No session approval token found" };
  }
  if (load.kind === "corrupt") {
    return { valid: false, corrupt: true, reason: load.reason };
  }
  const token = load.token;
  if (isTokenExpired(token, nowMs)) {
    return { valid: false, reason: `Approval token expired at ${token.expires_at}` };
  }
  if (token.session_id && sessionId && token.session_id !== sessionId) {
    return { valid: false, reason: "Approval token belongs to a different session" };
  }
  if (endpoint && token.endpoints && token.endpoints.length > 0) {
    const matched = token.endpoints.some((pattern) => {
      if (pattern.endsWith("*")) {
        return endpoint.startsWith(pattern.slice(0, -1));
      }
      return endpoint === pattern;
    });
    if (!matched) {
      return { valid: false, reason: `Approval token does not cover endpoint ${endpoint}` };
    }
  }
  if (presentedToken !== undefined) {
    if (!token.token || token.token !== presentedToken) {
      return { valid: false, reason: "Presented token does not match the approval token file" };
    }
  }
  return { valid: true };
}

const VENUE_MINING_SKILL_INVOKE_RE = /(^|\s)\/venue-mining(?=\s|$)/;
const VENUE_MINING_SKILL_PATH_RE = /skills\/venue-mining\/SKILL\.md\b/;
const VENUE_MINING_TASK_RE = /\bvenue-mining:[A-Za-z0-9_-]+\b/;

/**
 * Whether the CURRENT command is running inside the venue-mining skill.
 *
 * Deliberately does NOT read `payload.transcript_path`. Transcripts are
 * append-only, and this guard's own DENY text contains the words
 * "venue-mining" and "outreach" — so a transcript-content scan meant a
 * single denied command permanently tainted every later command in the
 * same session (the transcript now contains the deny reason itself), and a
 * transcript that merely quotes or discusses the skill (`let's look at
 * skills/venue-mining/SKILL.md`) falsely put an unrelated, read-only
 * session into venue-mining context. A safety guard must never carry a
 * self-inflicted, permanent off-switch.
 *
 * Context is instead: `ACTIVE_SKILL`/`SKILL_NAME` env equal to
 * "venue-mining"; `payload.cwd` containing `skills/venue-mining`; or the
 * command itself invoking the skill (`/venue-mining` as its own token, or
 * the literal `skills/venue-mining/SKILL.md` path) or running one of its
 * deno tasks (`venue-mining:<task>`). A bare `\bvenue-mining\b` substring
 * match was removed for the same reason as the transcript scan — it made
 * any command merely mentioning the word (e.g. in a code comment or file
 * path unrelated to the skill) count as venue-mining context.
 */
export function isVenueMiningContext(
  payload: Record<string, unknown>,
  command: string,
): boolean {
  const activeSkill = Deno.env.get("ACTIVE_SKILL") || Deno.env.get("SKILL_NAME");
  if (activeSkill === "venue-mining") return true;

  const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
  if (cwd.includes("skills/venue-mining")) return true;

  if (
    VENUE_MINING_SKILL_INVOKE_RE.test(command) ||
    VENUE_MINING_SKILL_PATH_RE.test(command) ||
    VENUE_MINING_TASK_RE.test(command)
  ) {
    return true;
  }

  return false;
}

// Matches the literal production host, or a shell EXPANSION of
// WEB_JAM_BACK_URL ($WEB_JAM_BACK_URL / ${WEB_JAM_BACK_URL}) — but not the
// bare identifier, so a command merely mentioning the env var's NAME (e.g.
// in a comment, or `echo "uses WEB_JAM_BACK_URL"`) doesn't get classified
// as production traffic.
const BACKEND_HOST_RE = /(?:https?:\/\/)?webjamsalem\.herokuapp\.com|\$\{?WEB_JAM_BACK_URL\}?/;
const OUTREACH_PATH_RE = /\/outreach(?:\/|\b|$)/;
const VENUE_PATH_RE = /\/(?:venue|venue-mining)(?:\/|\b|$)/;
const MUTATION_CODE_RE =
  /(?:method\s*:\s*["'](POST|PUT|PATCH|DELETE)["']|\b(POST|PUT|PATCH|DELETE)\b|requests\.(post|patch|put|delete)|body\s*:)/i;

function extractTokenArg(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--token" && i + 1 < args.length) {
      return args[i + 1];
    }
    if (a.startsWith("--token=")) {
      return a.slice("--token=".length);
    }
  }
  return null;
}

const ASSIGN_RE = /^[a-zA-Z_][a-zA-Z0-9_]*=/;
function stripLeadingAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && ASSIGN_RE.test(tokens[i])) i++;
  return tokens.slice(i);
}

// Cap on how much of a script file is read for analysis (web-jam-tools#1021
// review Must Fix #2). Large enough for any real script; prevents a huge
// file from blowing up the hook's latency or memory.
const SCRIPT_READ_CAP_BYTES = 256 * 1024;

/**
 * Read a script file for backend-mutation/outreach analysis, capped at
 * ~256 KB. Returns `null` (never denies) when the path is missing,
 * unreadable, or not a plain file — this guard cannot distinguish an
 * ordinary repo script this process merely lacks permission to read (or a
 * script that doesn't exist yet, e.g. a generator's own output path) from
 * a hostile one, and denying every unreadable `deno run`/`node`/etc. would
 * break ordinary repo tasks, which is a worse failure than the narrow gap
 * of an unreadable script that happens to mutate the backend.
 */
function readScriptFile(path: string): string | null {
  try {
    const info = Deno.statSync(path);
    if (!info.isFile) return null;
    const bytes = Deno.readFileSync(path);
    const capped = bytes.length > SCRIPT_READ_CAP_BYTES
      ? bytes.subarray(0, SCRIPT_READ_CAP_BYTES)
      : bytes;
    return new TextDecoder().decode(capped);
  } catch {
    return null;
  }
}

// The first non-flag argument after the program's own name (and, for
// `deno`, after the `run` subcommand) — i.e. the script file path. Flags
// are skipped positionally rather than by an allowlist, since deno/node/
// python3/bash/sh flags are all `-x`/`--long`/`--long=value` single tokens
// with no separately-tokenized value in the forms this guard needs to see
// through (`deno run -A file.ts`, `node file.js`, `python3 file.py`,
// `bash file.sh`).
function extractScriptPath(prog: string, stripped: string[]): string | null {
  const startIdx = prog === "deno" ? 2 : 1;
  for (let i = startIdx; i < stripped.length; i++) {
    const a = stripped[i];
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
}

/**
 * Shared backend-mutation/outreach analysis for a blob of CODE — whether
 * it came from inline `deno eval`/`node -e`/`python3 -c`, or was read from
 * a script FILE (`deno run <file>`, `node <file>`, `python3 <file>`,
 * `bash <file>`, `sh <file>`; web-jam-tools#1021 review Must Fix #2).
 * Returns `null` when the code doesn't reference the backend at all, or
 * references it but isn't a mutation — i.e. "no opinion, keep evaluating
 * this segment other ways" rather than "pass".
 */
function decideScriptContent(
  code: string,
  tokenPath: string,
  nowMs: number,
  inVenueMining: boolean,
  sessionId?: string,
): DecisionResult | null {
  if (!BACKEND_HOST_RE.test(code)) return null;

  if (OUTREACH_PATH_RE.test(code)) {
    if (inVenueMining) {
      return { outcome: "deny", reason: OUTREACH_DURING_VENUE_MINING_REASON };
    }
    return { outcome: "deny", reason: DIRECT_OUTREACH_MUTATION_REASON };
  }

  if (!MUTATION_CODE_RE.test(code)) return null;

  const tokenCheck = checkSessionToken(tokenPath, sessionId, "/venue", nowMs);
  if (tokenCheck.valid) {
    return {
      outcome: "allow",
      reason: "Authorized venue script mutation with active session approval token.",
    };
  }
  return {
    outcome: "deny",
    reason: `Script attempts unauthorized backend mutation against production backend ` +
      `(https://webjamsalem.herokuapp.com): ${tokenCheck.reason}. ${APPROVAL_REMEDIATION}`,
  };
}

interface CurlInfo {
  method: string;
  url?: string;
  path?: string;
  isBackend: boolean;
  isOutreach: boolean;
  isVenue: boolean;
  hasData: boolean;
  token?: string;
}

function parseCurl(args: string[]): CurlInfo | null {
  if (args.length === 0) return null;
  const bin = args[0].split("/").pop();
  if (bin !== "curl") return null;

  let explicitMethod: string | null = null;
  let hasData = false;
  let hasGet = false;
  let url: string | null = null;
  let token: string | null = null;

  let i = 1;
  while (i < args.length) {
    const a = args[i];
    if (a === "-X" || a === "--request") {
      if (i + 1 < args.length) {
        explicitMethod = args[i + 1].toUpperCase();
        i += 2;
        continue;
      }
    } else if (a.startsWith("-X")) {
      explicitMethod = a.slice(2).toUpperCase();
    } else if (a.startsWith("--request=")) {
      explicitMethod = a.slice("--request=".length).toUpperCase();
    } else if (
      a === "-d" || a === "--data" || a === "--data-raw" || a === "--data-binary" ||
      a === "--data-urlencode" || a === "--data-ascii" || a === "--json" || a === "-F" ||
      a === "--form" || a === "--form-string"
    ) {
      hasData = true;
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        i += 2;
        continue;
      }
    } else if (
      a.startsWith("-d") || a.startsWith("--data=") || a.startsWith("--data-raw=") ||
      a.startsWith("--json=") || a.startsWith("-F")
    ) {
      hasData = true;
    } else if (a === "-G" || a === "--get") {
      hasGet = true;
    } else if (a === "--url") {
      if (i + 1 < args.length) {
        url = args[i + 1];
        i += 2;
        continue;
      }
    } else if (a.startsWith("--url=")) {
      url = a.slice("--url=".length);
    } else if (a === "-H" || a === "--header") {
      if (i + 1 < args.length) {
        const header = args[i + 1];
        const m = header.match(/bearer\s+([a-zA-Z0-9._-]+)/i);
        if (m) token = m[1];
        i += 2;
        continue;
      }
    } else if (a.startsWith("-H") || a.startsWith("--header=")) {
      const header = a.startsWith("-H") ? a.slice(2) : a.slice("--header=".length);
      const m = header.match(/bearer\s+([a-zA-Z0-9._-]+)/i);
      if (m) token = m[1];
    } else if (a === "--token") {
      if (i + 1 < args.length) {
        token = args[i + 1];
        i += 2;
        continue;
      }
    } else if (a.startsWith("--token=")) {
      token = a.slice("--token=".length);
    } else if (!a.startsWith("-") && url === null) {
      url = a;
    }
    i++;
  }

  const method = explicitMethod ?? (hasData && !hasGet ? "POST" : "GET");
  const urlStr = url ?? "";
  const isBackend = BACKEND_HOST_RE.test(urlStr) ||
    args.some((arg) => BACKEND_HOST_RE.test(arg));

  let path = "";
  try {
    if (urlStr.startsWith("http://") || urlStr.startsWith("https://")) {
      const parsed = new URL(urlStr);
      path = parsed.pathname;
    } else {
      const slashIdx = urlStr.indexOf("/");
      path = slashIdx >= 0 ? urlStr.slice(slashIdx) : urlStr;
    }
  } catch {
    path = urlStr;
  }

  const isOutreach = OUTREACH_PATH_RE.test(path) || OUTREACH_PATH_RE.test(urlStr);
  const isVenue = VENUE_PATH_RE.test(path) || VENUE_PATH_RE.test(urlStr);

  return {
    method,
    url: urlStr,
    path,
    isBackend,
    isOutreach,
    isVenue,
    hasData,
    token: token ?? undefined,
  };
}

function looksLikeBackendMutation(command: string): boolean {
  return (
    BACKEND_HOST_RE.test(command) ||
    /\bvenue:create\b/.test(command) ||
    /\bvenue:patch\b/.test(command) ||
    (/\bcurl\b/.test(command) && (OUTREACH_PATH_RE.test(command) || VENUE_PATH_RE.test(command)))
  );
}

function decideSegment(
  argv: string[],
  _rawSegment: string,
  payload: Record<string, unknown>,
  tokenPath: string,
  nowMs: number,
  inVenueMining: boolean,
  sessionId?: string,
): DecisionResult {
  const stripped = stripLeadingAssignments(argv);
  if (stripped.length === 0) return { outcome: "pass" };

  const prog = stripped[0].split("/").pop() ?? stripped[0];

  // 1. Check curl
  if (prog === "curl") {
    const curl = parseCurl(stripped);
    if (!curl) return { outcome: "pass" };

    // Outreach endpoints
    if (curl.isOutreach) {
      if (inVenueMining) {
        return { outcome: "deny", reason: OUTREACH_DURING_VENUE_MINING_REASON };
      }
      if (["POST", "PATCH", "PUT", "DELETE"].includes(curl.method)) {
        return { outcome: "deny", reason: DIRECT_OUTREACH_MUTATION_REASON };
      }
      return { outcome: "pass" };
    }

    // Target backend checks
    if (curl.isBackend) {
      const isMutation = ["POST", "PATCH", "PUT", "DELETE"].includes(curl.method);
      if (!isMutation) {
        return { outcome: "pass" }; // Read-only GET/HEAD/OPTIONS allowed
      }

      if (curl.isVenue) {
        const tokenCheck = checkSessionToken(tokenPath, sessionId, curl.path, nowMs, curl.token);
        if (tokenCheck.valid) {
          return {
            outcome: "allow",
            reason: curl.token
              ? "Authorized venue mutation: presented token matches the active session approval token."
              : "Authorized venue mutation with active session approval token.",
          };
        }
        return {
          outcome: "deny",
          reason: `Unauthorized venue mutation against production backend ` +
            `(https://webjamsalem.herokuapp.com): ${tokenCheck.reason}. ${APPROVAL_REMEDIATION}`,
        };
      }

      return {
        outcome: "deny",
        reason:
          "Unauthorized HTTP mutation against production backend (https://webjamsalem.herokuapp.com).",
      };
    }

    return { outcome: "pass" };
  }

  // 2. deno task / deno run / deno eval
  if (prog === "deno") {
    const sub = stripped[1];
    if (sub === "task") {
      const task = stripped[2] ?? "";
      if (task === "venue:create" || task === "venue:patch" || task.startsWith("venue:")) {
        const token = extractTokenArg(stripped);
        const tokenCheck = checkSessionToken(
          tokenPath,
          sessionId,
          "/venue",
          nowMs,
          token ?? undefined,
        );
        if (tokenCheck.valid) {
          return {
            outcome: "allow",
            reason: token
              ? "Authorized venue task invocation: presented token matches the active session approval token."
              : "Authorized venue task invocation with active session approval token.",
          };
        }
        return {
          outcome: "deny",
          reason: `Unauthorized venue task invocation against production backend ` +
            `(https://webjamsalem.herokuapp.com): ${tokenCheck.reason}. ${APPROVAL_REMEDIATION}`,
        };
      }

      if (task === "venue-mining:record-sweep" || task === "venue-mining:seed-sweep-history") {
        return { outcome: "allow", reason: "Authorized venue-mining CLI task." };
      }

      if (task.startsWith("outreach:") || task === "book-gig" || task.startsWith("book-gig:")) {
        if (inVenueMining) {
          return { outcome: "deny", reason: OUTREACH_DURING_VENUE_MINING_REASON };
        }
        return { outcome: "pass" };
      }
    }

    if (sub === "eval") {
      const code = stripped[2] ?? "";
      const dec = decideScriptContent(code, tokenPath, nowMs, inVenueMining, sessionId);
      if (dec) return dec;
    }

    if (sub === "run") {
      const scriptPath = extractScriptPath("deno", stripped);
      if (scriptPath) {
        const content = readScriptFile(scriptPath);
        if (content !== null) {
          const dec = decideScriptContent(content, tokenPath, nowMs, inVenueMining, sessionId);
          if (dec) return dec;
        }
      }
    }
  }

  // 3. node / python3 — inline eval (-e / -c) or a script FILE
  if (prog === "node" || prog === "python3") {
    const inlineFlag = prog === "node" ? "-e" : "-c";
    if (stripped[1] === inlineFlag) {
      const code = stripped[2] ?? "";
      const dec = decideScriptContent(code, tokenPath, nowMs, inVenueMining, sessionId);
      if (dec) return dec;
    } else {
      const scriptPath = extractScriptPath(prog, stripped);
      if (scriptPath) {
        const content = readScriptFile(scriptPath);
        if (content !== null) {
          const dec = decideScriptContent(content, tokenPath, nowMs, inVenueMining, sessionId);
          if (dec) return dec;
        }
      }
    }
  }

  // 4. bash / sh — a script FILE (`bash -c "..."` is resolved to a nested
  // command string by resolveThroughWrappers before decideSegment ever
  // sees it, so only the file-argument form reaches here).
  if (prog === "bash" || prog === "sh") {
    if (stripped[1] !== "-c") {
      const scriptPath = extractScriptPath(prog, stripped);
      if (scriptPath) {
        const content = readScriptFile(scriptPath);
        if (content !== null) {
          const dec = decideScriptContent(content, tokenPath, nowMs, inVenueMining, sessionId);
          if (dec) return dec;
        }
      }
    }
  }

  return { outcome: "pass" };
}

export function decideCommand(
  command: string,
  payload: Record<string, unknown>,
  tokenPath: string,
  nowMs: number,
  sessionId?: string,
  depth = 0,
): DecisionResult {
  if (depth > 6) {
    return {
      outcome: "deny",
      reason: "Exceeded wrapper recursion depth while evaluating command — failing closed.",
    };
  }

  const inVenueMining = isVenueMiningContext(payload, command);
  const stripped = stripHeredocs(command);
  const { segments, unterminated } = splitOnOperators(stripped);

  if (unterminated) {
    if (looksLikeBackendMutation(stripped)) {
      return {
        outcome: "deny",
        reason:
          "This command could not be parsed (unterminated quote) and references the production backend — failing closed.",
      };
    }
    return { outcome: "pass" };
  }

  let hasAllow = false;
  let allowReason = "";

  for (const seg of segments) {
    const rawTokens = splitShellTokens(seg);
    if (rawTokens.length === 0) continue;

    const res = resolveThroughWrappers(rawTokens);
    if (res.kind === "cap-exceeded") {
      return {
        outcome: "deny",
        reason: "Exceeded wrapper iteration cap while evaluating command — failing closed.",
      };
    }
    if (res.kind === "nested") {
      const nestedDec = decideCommand(res.command, payload, tokenPath, nowMs, sessionId, depth + 1);
      if (nestedDec.outcome === "deny") return nestedDec;
      if (nestedDec.outcome === "allow") {
        hasAllow = true;
        allowReason = nestedDec.reason ?? "";
      }
      continue;
    }

    const segDec = decideSegment(
      res.argv,
      seg,
      payload,
      tokenPath,
      nowMs,
      inVenueMining,
      sessionId,
    );
    if (segDec.outcome === "deny") return segDec;
    if (segDec.outcome === "allow") {
      hasAllow = true;
      allowReason = segDec.reason ?? "";
    }
  }

  if (hasAllow) {
    return { outcome: "allow", reason: allowReason };
  }

  return { outcome: "pass" };
}

export function checkBackendMutation(
  inputJson: string,
  tokenPath = defaultBackendTokenPath(),
  nowMs = Date.now(),
): string {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(inputJson);
  } catch {
    return "DENY:Invalid JSON payload (parser failure) — failing closed.";
  }

  if (typeof data !== "object" || data === null) {
    return "DENY:Indeterminate payload (not an object) — failing closed.";
  }

  if (data.tool_input === null || data.tool_input === undefined) {
    return "DENY:Indeterminate payload (tool_input is null or missing) — failing closed.";
  }

  if (typeof data.tool_input !== "object") {
    return "DENY:Indeterminate payload (tool_input is not an object) — failing closed.";
  }

  const toolName = typeof data.tool_name === "string" ? data.tool_name : "";
  if (toolName && toolName !== "Bash" && toolName !== "run_command") {
    return "PASS";
  }

  const toolInput = data.tool_input as Record<string, unknown>;
  const command = typeof toolInput.command === "string"
    ? toolInput.command
    : typeof toolInput.CommandLine === "string"
    ? toolInput.CommandLine
    : null;

  if (command === null) {
    return "DENY:Indeterminate payload (command is missing or not a string) — failing closed.";
  }

  if (command.trim().length === 0) {
    return "PASS";
  }

  const sessionId = typeof data.session_id === "string" ? data.session_id : undefined;
  const result = decideCommand(command, data, tokenPath, nowMs, sessionId);

  if (result.outcome === "allow") {
    return `ALLOW:${result.reason ?? ""}`;
  }
  if (result.outcome === "deny") {
    return `DENY:${result.reason ?? ""}`;
  }
  return "PASS";
}

if (import.meta.main) {
  let inputJson = "";
  try {
    inputJson = await new Response(Deno.stdin.readable).text();
  } catch {
    // ignore
  }
  console.log(checkBackendMutation(inputJson));
}
