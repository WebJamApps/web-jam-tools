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
 *   - Condition holds (permitted): Target is an authorized venue endpoint, carries
 *     a valid in-session approval token or approved CLI task invocation (--token),
 *     and is within permissible skill scope -> ALLOW (proceeds without prompt).
 *   - Condition does not hold (denied): Lacks approval token, attempts ad-hoc
 *     unapproved write, or attempts outreach operations during venue-mining ->
 *     DENY (refuses with structured explanation).
 *   - Indeterminate condition: Parser failure, missing environment, unparseable
 *     command, or corrupt token state -> DENY (fails closed).
 *   - Out of scope (read-only query or unrelated command) -> PASS.
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

export function checkSessionToken(
  tokenPath: string,
  sessionId?: string,
  endpoint?: string,
  nowMs = Date.now(),
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
  return { valid: true };
}

export function isVenueMiningContext(
  payload: Record<string, unknown>,
  command: string,
): boolean {
  const activeSkill = Deno.env.get("ACTIVE_SKILL") || Deno.env.get("SKILL_NAME");
  if (activeSkill === "venue-mining") return true;

  if (/\bvenue-mining\b/.test(command) || /skills\/venue-mining\b/.test(command)) {
    return true;
  }

  const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
  if (cwd.includes("skills/venue-mining")) return true;

  const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  if (transcriptPath) {
    try {
      const content = Deno.readTextFileSync(transcriptPath);
      if (
        content.includes("/venue-mining") ||
        content.includes("skills/venue-mining") ||
        content.includes("<command-name>venue-mining</command-name>") ||
        content.includes("<command-name>/venue-mining</command-name>") ||
        content.includes("<command-message>venue-mining</command-message>")
      ) {
        return true;
      }
    } catch {
      // ignore
    }
  }

  return false;
}

const BACKEND_HOST_RE = /(?:https?:\/\/)?webjamsalem\.herokuapp\.com|\$WEB_JAM_BACK_URL|\bWEB_JAM_BACK_URL\b/;
const OUTREACH_PATH_RE = /\/outreach(?:\/|\b|$)/;
const VENUE_PATH_RE = /\/(?:venue|venue-mining)(?:\/|\b|$)/;

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
  rawSegment: string,
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
        return {
          outcome: "deny",
          reason:
            'Outreach operations (/outreach/*) are forbidden during venue-mining tasks (skill boundary violation; see web-jam-tools#208 "venue-mining: require a mandatory street address for every venue create").',
        };
      }
      if (["POST", "PATCH", "PUT", "DELETE"].includes(curl.method)) {
        return {
          outcome: "deny",
          reason:
            "Direct outreach mutations against the production backend (https://webjamsalem.herokuapp.com) are forbidden; outreach workflows must run through approved skills/book-gig/SKILL.md gates.",
        };
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
        if (curl.token) {
          return {
            outcome: "allow",
            reason: "Authorized venue mutation with approval token.",
          };
        }
        const tokenCheck = checkSessionToken(tokenPath, sessionId, curl.path, nowMs);
        if (tokenCheck.valid) {
          return {
            outcome: "allow",
            reason: "Authorized venue mutation with active session approval token.",
          };
        }
        if (tokenCheck.reason && tokenCheck.reason !== "No session approval token found") {
          return {
            outcome: "deny",
            reason: `Approval token rejected: ${tokenCheck.reason}.`,
          };
        }
        return {
          outcome: "deny",
          reason:
            "Unauthorized venue mutation against production backend (https://webjamsalem.herokuapp.com) without an approval token. Requires an explicit session approval token or structured approved CLI invocation.",
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

  // 2. Check deno task / deno run
  if (prog === "deno") {
    const sub = stripped[1];
    if (sub === "task") {
      const task = stripped[2] ?? "";
      if (task === "venue:create" || task === "venue:patch" || task.startsWith("venue:")) {
        const token = extractTokenArg(stripped);
        if (token && token.trim().length > 0) {
          return {
            outcome: "allow",
            reason: "Authorized venue task invocation with approval token.",
          };
        }
        const tokenCheck = checkSessionToken(tokenPath, sessionId, "/venue", nowMs);
        if (tokenCheck.valid) {
          return {
            outcome: "allow",
            reason: "Authorized venue task invocation with active session approval token.",
          };
        }
        if (tokenCheck.reason && tokenCheck.reason !== "No session approval token found") {
          return {
            outcome: "deny",
            reason: `Approval token rejected: ${tokenCheck.reason}.`,
          };
        }
        return {
          outcome: "deny",
          reason:
            "Venue mutation task requires an approval token (--token <token> or active session approval token).",
        };
      }

      if (task === "venue-mining:record-sweep" || task === "venue-mining:seed-sweep-history") {
        return { outcome: "allow", reason: "Authorized venue-mining CLI task." };
      }

      if (task.startsWith("outreach:") || task === "book-gig" || task.startsWith("book-gig:")) {
        if (inVenueMining) {
          return {
            outcome: "deny",
            reason:
              'Outreach operations are forbidden during venue-mining tasks (skill boundary violation; see web-jam-tools#208 "venue-mining: require a mandatory street address for every venue create").',
          };
        }
        return { outcome: "pass" };
      }
    }

    if (sub === "eval") {
      const code = stripped[2] ?? "";
      if (BACKEND_HOST_RE.test(code)) {
        if (OUTREACH_PATH_RE.test(code)) {
          if (inVenueMining) {
            return {
              outcome: "deny",
              reason:
                'Outreach operations (/outreach/*) are forbidden during venue-mining tasks (skill boundary violation; see web-jam-tools#208 "venue-mining: require a mandatory street address for every venue create").',
            };
          }
          return {
            outcome: "deny",
            reason:
              "Direct outreach mutations against the production backend (https://webjamsalem.herokuapp.com) are forbidden; outreach workflows must run through approved skills/book-gig/SKILL.md gates.",
          };
        }

        const isMutation = /(?:method\s*:\s*["'](POST|PUT|PATCH|DELETE)["']|\b(POST|PUT|PATCH|DELETE)\b|body\s*:)/i
          .test(code);
        if (isMutation) {
          const tokenCheck = checkSessionToken(tokenPath, sessionId, "/venue", nowMs);
          if (tokenCheck.valid) {
            return {
              outcome: "allow",
              reason: "Authorized venue script evaluation with session approval token.",
            };
          }
          return {
            outcome: "deny",
            reason:
              "Script evaluation attempts unauthorized backend mutation against production backend without an approval token.",
          };
        }
      }
    }
  }

  // 3. Node or Python script evaluation
  if ((prog === "node" && stripped[1] === "-e") || (prog === "python3" && stripped[1] === "-c")) {
    const code = stripped[2] ?? "";
    if (BACKEND_HOST_RE.test(code)) {
      if (OUTREACH_PATH_RE.test(code) && inVenueMining) {
        return {
          outcome: "deny",
          reason:
            'Outreach operations are forbidden during venue-mining tasks (skill boundary violation; see web-jam-tools#208 "venue-mining: require a mandatory street address for every venue create").',
        };
      }
      const isMutation = /(?:method\s*:\s*["'](POST|PUT|PATCH|DELETE)["']|\b(POST|PUT|PATCH|DELETE)\b|requests\.(post|patch|put|delete)|body\s*:)/i
        .test(code);
      if (isMutation) {
        const tokenCheck = checkSessionToken(tokenPath, sessionId, "/venue", nowMs);
        if (tokenCheck.valid) {
          return {
            outcome: "allow",
            reason: "Authorized venue script evaluation with session approval token.",
          };
        }
        return {
          outcome: "deny",
          reason:
            "Script evaluation attempts unauthorized backend mutation against production backend without an approval token.",
        };
      }
    }
  }

  // 4. Outreach commands during venue-mining
  if (inVenueMining) {
    if (OUTREACH_PATH_RE.test(rawSegment) || /\bbook-gig\b/.test(rawSegment)) {
      return {
        outcome: "deny",
        reason:
          'Outreach operations (/outreach/*) are forbidden during venue-mining tasks (skill boundary violation; see web-jam-tools#208 "venue-mining: require a mandatory street address for every venue create").',
      };
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
