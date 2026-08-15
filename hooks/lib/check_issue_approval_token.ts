/**
 * Helper logic for require-approval-token-on-issue-write.sh (web-jam-tools#502).
 *
 * Reads a PreToolUse payload for an `issue_write` or `sub_issue_write` MCP
 * call and decides whether Josh's plan-gate approval already covers it.
 *
 * The approval token is written by the plan gate (web-jam-tools#497, not
 * this change) once Josh approves a filing plan. Its shape:
 *
 *   {
 *     "session_id": "<the session that got approval>",
 *     "repo": "<owner>/<repo>",
 *     "titles": ["exact title 1", "exact title 2", ...],
 *     "expires_at": "<ISO 8601 timestamp>"
 *   }
 *
 * Decision:
 *   - issue_write, method "create", title in the token, same session, same
 *     repo, not expired  -> ALLOW (proceed with no prompt).
 *   - issue_write, method "create", any of the above false               -> DENY.
 *   - issue_write, method other than "create" (update/edit)              -> PASS
 *     (out of scope: the approval token covers filing new issues, not
 *     editing existing ones).
 *   - sub_issue_write, method "add", same session, same repo, not expired
 *     -> ALLOW (sub_issue_write carries no title to check — it links an
 *     already-created issue, so the token's presence/scope is all there is
 *     to verify).
 *   - sub_issue_write, method other than "add" (remove/reprioritize)     -> PASS.
 *   - any other tool                                                    -> PASS.
 *
 * PASS means "this hook has no opinion" — the normal permission flow (the
 * standing `ask` rule) still applies. Only ALLOW silences the prompt, and
 * only for a title Josh already approved.
 */

const ISSUE_WRITE_RE = /^mcp__.*__issue_write$/;
const SUB_ISSUE_WRITE_RE = /^mcp__.*__sub_issue_write$/;

export interface ApprovalToken {
  session_id: string;
  repo: string;
  titles: string[];
  expires_at: string;
}

export function defaultTokenPath(): string {
  const override = Deno.env.get("ISSUE_APPROVAL_TOKEN_PATH");
  if (override) return override;
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "/home/joshua";
  return `${home}/.claude/state/issue-approval-token.json`;
}

/** Returns null on anything not a well-formed token (missing file, bad JSON, wrong shape) — fail closed. */
export function loadToken(tokenPath: string): ApprovalToken | null {
  let text: string;
  try {
    text = Deno.readTextFileSync(tokenPath);
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.session_id !== "string" || !d.session_id) return null;
  if (typeof d.repo !== "string" || !d.repo) return null;
  if (!Array.isArray(d.titles) || !d.titles.every((t) => typeof t === "string")) return null;
  if (typeof d.expires_at !== "string" || !d.expires_at) return null;
  return {
    session_id: d.session_id,
    repo: d.repo,
    titles: d.titles as string[],
    expires_at: d.expires_at,
  };
}

/** Fails closed: an unparseable expires_at counts as expired. */
export function isExpired(token: ApprovalToken, nowMs: number): boolean {
  const exp = Date.parse(token.expires_at);
  if (Number.isNaN(exp)) return true;
  return exp <= nowMs;
}

export interface Decision {
  outcome: "pass" | "allow" | "deny";
  reason?: string;
}

function repoFullName(toolInput: Record<string, unknown>): string {
  const owner = typeof toolInput.owner === "string" ? toolInput.owner : "";
  const repo = typeof toolInput.repo === "string" ? toolInput.repo : "";
  return owner && repo ? `${owner}/${repo}` : "";
}

/** Loads and validates the token against session/expiry/repo. Returns a deny Decision on any failure, or null if the token is good to use. */
function checkTokenValidity(
  toolInput: Record<string, unknown>,
  sessionId: string,
  tokenPath: string,
  nowMs: number,
): { token: ApprovalToken } | { deny: Decision } {
  const token = loadToken(tokenPath);
  if (!token) {
    return {
      deny: {
        outcome: "deny",
        reason:
          `No approval token found at ${tokenPath}. Get Josh's explicit approval for this plan first (via /design-issue's plan gate), or ask him directly.`,
      },
    };
  }
  if (token.session_id !== sessionId) {
    return {
      deny: {
        outcome: "deny",
        reason: "Approval token belongs to a different session and does not apply here.",
      },
    };
  }
  if (isExpired(token, nowMs)) {
    return {
      deny: { outcome: "deny", reason: `Approval token expired at ${token.expires_at}.` },
    };
  }
  const repoFull = repoFullName(toolInput);
  if (repoFull && token.repo !== repoFull) {
    return {
      deny: {
        outcome: "deny",
        reason: `Approval token is scoped to ${token.repo}, not ${repoFull}.`,
      },
    };
  }
  return { token };
}

export function decide(
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId: string,
  tokenPath: string,
  nowMs: number,
): Decision {
  if (ISSUE_WRITE_RE.test(toolName)) {
    const method = typeof toolInput.method === "string" ? toolInput.method : "";
    if (method !== "create") {
      return { outcome: "pass" };
    }
    const title = typeof toolInput.title === "string" ? toolInput.title.trim() : "";
    if (!title) {
      return {
        outcome: "deny",
        reason: "issue_write create call carries no title to check against the approved plan.",
      };
    }
    const check = checkTokenValidity(toolInput, sessionId, tokenPath, nowMs);
    if ("deny" in check) return check.deny;
    if (!check.token.titles.includes(title)) {
      return {
        outcome: "deny",
        reason: `"${title}" is not among the titles Josh approved in this session's plan.`,
      };
    }
    return { outcome: "allow", reason: `"${title}" was approved in this session's plan.` };
  }

  if (SUB_ISSUE_WRITE_RE.test(toolName)) {
    const method = typeof toolInput.method === "string" ? toolInput.method : "";
    if (method !== "add") {
      return { outcome: "pass" };
    }
    const check = checkTokenValidity(toolInput, sessionId, tokenPath, nowMs);
    if ("deny" in check) return check.deny;
    return {
      outcome: "allow",
      reason: "Session has a valid approval token covering this repository's plan.",
    };
  }

  return { outcome: "pass" };
}

/** Parses the raw PreToolUse JSON and returns the sentinel string printed to stdout: "PASS" | "ALLOW:<reason>" | "DENY:<reason>". */
export function checkIssueApprovalToken(inputJson: string, tokenPath: string, nowMs: number): string {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(inputJson);
  } catch {
    return "PASS";
  }
  const toolName = typeof data.tool_name === "string" ? data.tool_name : "";
  const sessionId = typeof data.session_id === "string" ? data.session_id : "";
  const toolInputRaw = data.tool_input;
  const toolInput = typeof toolInputRaw === "object" && toolInputRaw !== null
    ? (toolInputRaw as Record<string, unknown>)
    : {};

  const result = decide(toolName, toolInput, sessionId, tokenPath, nowMs);
  if (result.outcome === "pass") return "PASS";
  if (result.outcome === "allow") return `ALLOW:${result.reason ?? ""}`;
  return `DENY:${result.reason ?? ""}`;
}

if (import.meta.main) {
  let inputJson = "";
  try {
    inputJson = await new Response(Deno.stdin.readable).text();
  } catch {
    // ignore
  }
  console.log(checkIssueApprovalToken(inputJson, defaultTokenPath(), Date.now()));
}
