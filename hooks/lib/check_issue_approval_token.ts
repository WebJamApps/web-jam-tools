/**
 * Helper logic for require-approval-token-on-issue-write.sh (web-jam-tools#502,
 * extended to the Bash filing path by web-jam-tools#747).
 *
 * Reads a PreToolUse payload and decides whether Josh's plan-gate approval
 * already covers the issue-filing call it describes — either an
 * `issue_write` / `sub_issue_write` MCP call, or a Bash `gh issue create` /
 * `deno task create-issue` (and its other invocation forms) call.
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
 *   - Bash `gh issue create` / `deno task create-issue` / `deno task
 *     issue:create` / `deno run .../create-issue.ts` / direct
 *     `scripts/create-issue.ts`, title in the token, same session, same
 *     repo, not expired -> PASS (silent — see the Bash `allow` note below;
 *     the settings permission layer still evaluates the whole call).
 *   - Bash issue-creating command, any of the above false, or no --title
 *     given at all -> DENY (web-jam-tools#747: this is the Bash-path hole —
 *     dropping to a shell must not walk around the gate that
 *     mcp__*__issue_write already enforces).
 *   - Bash `gh issue edit` or any other Bash command                     -> PASS
 *     (edits are out of scope, same as issue_write's "update"/"edit"; an
 *     unrelated command is untouched).
 *   - any other tool                                                    -> PASS.
 *
 * PASS means "this hook has no opinion" — the normal permission flow (the
 * standing `ask` rule) still applies. Only ALLOW silences the prompt, and
 * only for a title Josh already approved.
 *
 * Bash NEVER gets `allow` (web-jam-tools#788 review, Must Fix #2): a
 * PreToolUse `allow` bypasses the whole tool call through the settings
 * permission system (`permissions.deny`/`ask`), not just the piece this
 * guard reasoned about. On the MCP path that's safe because an
 * `issue_write`/`sub_issue_write` call carries no other composed command to
 * ride along. On Bash, `decideBash()` only ever vets the issue-creating
 * segment(s) it finds in a whole `&&`/`;`/`\n`/`&`/`|`-separated string — any
 * OTHER segment chained into the same call is never inspected at all, so
 * emitting `allow` would let an approved title silence the settings layer
 * for whatever else rides along (e.g.
 * `gh issue create --title "<approved>" && git push origin --delete x`).
 * So a satisfied Bash approval resolves to PASS (silent, exit 0, no
 * decision) — Josh still gets the standing `ask` prompt (or the settings
 * rules run as normal) for the rest of the command; only an *unapproved*
 * issue-creating command is actively DENIED.
 *
 * Bash command parsing reuses the shell-tokenizing and issue-creating-command
 * detection already built for hooks/lib/check_model_label_on_issue_create.ts
 * (web-jam-tools#382/#553) rather than re-implementing it — same repo, same
 * question ("is this argv shape an issue-creating call, and what are its
 * args"), so it lives in one place. Command segmentation (splitting on
 * `&&`/`||`/`;`/`|`/newline/bare-`&`) reuses splitOnOperators() from
 * normalize_command.ts for the same reason — a hand-rolled operator set that
 * doesn't understand newline or bare `&` is exactly the Must Fix #1 bypass
 * this file used to have.
 */

import {
  findCreateIssueScriptArgs,
  findGhIssueCreateArgs,
  stripLeadingAssignments,
} from "./check_model_label_on_issue_create.ts";
import { splitOnOperators, splitShellTokens } from "./normalize_command.ts";

// Dependency direction (web-jam-tools#788 review, Actionable Feedback A):
// src/create-issue/lib.ts imports defaultTokenPath()/isExpired()/loadToken()
// FROM this file — the repo's first src/ -> hooks/lib/ dependency. That
// direction is intentional and the only one allowed: hooks/lib/ stays
// independently invocable (no deno.json import map, no src/ tree required)
// by never importing FROM src/, but src/ is free to import FROM hooks/lib/
// since hooks/lib/ is the lower layer. Consequently the token primitives
// live here, once, and src/create-issue/lib.ts's own approval-token check
// (checkApprovalToken(), used as createIssueAndVerify()'s default
// approvalCheck) reuses them instead of re-implementing token
// load/expiry logic a second time.
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

/**
 * `--repo`/`-R` value explicitly present in a Bash gh/create-issue argv,
 * normalized to "owner/name" — or `null` if no `--repo`/`-R` flag was
 * given at all. Deliberately does NOT apply any default: the two Bash
 * invocation families this hook covers resolve a missing `--repo`
 * differently, so the default has to live with the caller, which knows
 * which family it's looking at (see decideBash()):
 *   - `gh issue create` resolves the target repo from the current
 *     directory's git remote when `--repo` is absent — a fixed constant
 *     cannot reproduce that, so decideBash() fails closed (denies) instead
 *     of guessing.
 *   - `deno task create-issue` / `issue:create` / `deno run
 *     .../create-issue.ts` / direct `scripts/create-issue.ts` really do
 *     default to WebJamApps/web-jam-tools — that's normalizeRepo()'s own
 *     contract in src/create-issue/lib.ts, which decideBash() applies
 *     directly for this family (the same literal, not imported: hooks/lib/
 *     never depends on src/ — see the import block above this function for
 *     why src/ is allowed to depend on hooks/lib/ instead).
 */
function extractExplicitBashRepo(args: string[]): string | null {
  let raw: string | null = null;
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a === "--repo" || a === "-R") {
      if (j + 1 < args.length) raw = args[j + 1];
      break;
    }
    if (a.startsWith("--repo=")) {
      raw = a.slice("--repo=".length);
      break;
    }
  }
  if (!raw) return null;
  return raw.includes("/") ? raw : `WebJamApps/${raw}`;
}

/** `--title` value from a Bash gh/create-issue argv. No `-t` alias: this repo's own convention (see check_model_label_on_issue_create.ts's extractTypeValue and src/create-issue/lib.ts's parseArgs) already reassigns `-t` to mean `--type`. */
function extractBashTitle(args: string[]): string | null {
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a === "--title") {
      return j + 1 < args.length ? args[j + 1] : null;
    }
    if (a.startsWith("--title=")) {
      return a.slice("--title=".length);
    }
  }
  return null;
}

/** Loads and validates the token against session/expiry/repo. Returns a deny Decision on any failure, or null if the token is good to use. */
function checkTokenValidity(
  repoFull: string,
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

/**
 * Cheap, deliberately approximate "does this raw command plausibly file an
 * issue" test — same shape check_model_label_on_issue_create.ts already
 * applies to its own `unterminated`-quote fallback. Used ONLY to decide
 * whether an unparseable (unterminated-quote) command should fail closed;
 * a real, parseable command is always evaluated by the full segment scan
 * in decideBash() below instead, so a false positive/negative here only
 * matters on the rare ambiguous-parse path. Deliberately narrower than the
 * sibling's version (no `edit` alternative): this hook's Bash path only
 * ever cares about issue CREATION, never `gh issue edit`.
 *
 * Narrower on `edit`, but NEVER narrower on the set of create forms. It must
 * recognise every form the parseable path below treats as issue-creating, or
 * the ambiguous-parse path fails OPEN on whichever form it misses. The
 * `issue:create` alternative exists for exactly that reason
 * (web-jam-tools#788 third review): that task name carries no `gh` token, so
 * the first alternative can never match it, and without an alternative of its
 * own, `deno task issue:create --title 'unterminated` passed silently while
 * the same command with balanced quotes was correctly denied.
 */
function looksLikeIssueCreatingCommand(command: string): boolean {
  return (
    (/\bgh\b/.test(command) && /\bissue\b/.test(command) && /\bcreate\b/.test(command)) ||
    /\bcreate-issue\b/.test(command) ||
    /\bissue:create\b/.test(command)
  );
}

/**
 * Bash-path counterpart of the issue_write "create" branch above
 * (web-jam-tools#747): finds every issue-creating command (`gh issue
 * create`, `deno task create-issue`/`issue:create`, `deno run
 * .../create-issue.ts`, or a direct `scripts/create-issue.ts` invocation)
 * among the command's `&&`/`||`/`;`/`|`/newline/bare-`&`-separated simple
 * commands (splitOnOperators() — NOT a hand-rolled operator set, see
 * web-jam-tools#788 review Must Fix #1), and applies the same
 * session/repo/expiry/title checks as the MCP path to each one.
 *
 * Unlike the MCP path, an approved match here never short-circuits to
 * `allow` (Must Fix #2 — see the file-header comment) — it keeps scanning
 * the REST of the composed command, because a later segment could be a
 * second, unapproved issue-creating call riding on the same approved one
 * (`gh issue create --title "<approved>" && gh issue create --title
 * "<not approved>"`). Only when every issue-creating segment found (there
 * may be zero) checks out does the whole call resolve to PASS.
 *
 * A command with no issue-creating segment at all is PASS, untouched.
 *
 * An unterminated quote (ambiguous parse) fails CLOSED — but ONLY when the
 * raw command plausibly files an issue in the first place (web-jam-tools#788
 * re-review, Must Fix #1 of the follow-up commit). `splitOnOperators()`
 * strips neither `#` comments nor heredoc bodies, so an apostrophe in
 * either (`# Josh's note`, a `<<EOF ... Josh's change ... EOF` heredoc) opens
 * a quote state that never closes — for an UNRELATED command, that must
 * stay silent, not hard-deny. This mirrors the exact narrowing
 * check_model_label_on_issue_create.ts already applies to its own
 * `unterminated` branch (see `looksLikeIssueCreatingCommand()` below).
 */
function decideBash(
  command: string,
  sessionId: string,
  tokenPath: string,
  nowMs: number,
): Decision {
  const { segments, unterminated } = splitOnOperators(command);
  if (unterminated) {
    if (looksLikeIssueCreatingCommand(command)) {
      return {
        outcome: "deny",
        reason:
          "This command could not be parsed (unterminated quote) but appears to create an issue — failing closed.",
      };
    }
    return { outcome: "pass" };
  }

  for (const segment of segments) {
    const scTokens = stripLeadingAssignments(splitShellTokens(segment));
    const ghCreateArgs = findGhIssueCreateArgs(scTokens);
    const createArgs = ghCreateArgs ?? findCreateIssueScriptArgs(scTokens);
    if (createArgs === null) continue;

    const title = extractBashTitle(createArgs)?.trim() ?? "";
    if (!title) {
      return {
        outcome: "deny",
        reason:
          "This issue-creating command carries no --title to check against the approved plan.",
      };
    }

    const explicitRepo = extractExplicitBashRepo(createArgs);
    let repoFull: string;
    if (explicitRepo !== null) {
      repoFull = explicitRepo;
    } else if (ghCreateArgs !== null) {
      // `gh issue create` with no `--repo` resolves the target repo from
      // the shell's cwd git remote — this hook cannot reliably reproduce
      // that resolution, so it cannot verify the token's repo scope.
      // Fail closed (web-jam-tools#788 review Must Fix #3) rather than
      // assuming WebJamApps/web-jam-tools.
      return {
        outcome: "deny",
        reason: `This "gh issue create" call has no --repo, and gh resolves the target repo ` +
          `from the shell's current directory rather than a fixed default — the approval ` +
          `token cannot verify repo scope here, so failing closed.`,
      };
    } else {
      // deno task create-issue / issue:create / deno run .../create-issue.ts
      // / direct scripts/create-issue.ts really do default to
      // WebJamApps/web-jam-tools — same convention as normalizeRepo() in
      // src/create-issue/lib.ts.
      repoFull = "WebJamApps/web-jam-tools";
    }

    const check = checkTokenValidity(repoFull, sessionId, tokenPath, nowMs);
    if ("deny" in check) return check.deny;
    if (!check.token.titles.includes(title)) {
      return {
        outcome: "deny",
        reason: `"${title}" is not among the titles Josh approved in this session's plan.`,
      };
    }
    // Approved — but never "allow" on Bash (Must Fix #2). Keep scanning the
    // rest of the composed command for a further, unapproved issue-creating
    // segment; otherwise this call resolves to PASS below.
  }

  return { outcome: "pass" };
}

export function decide(
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId: string,
  tokenPath: string,
  nowMs: number,
): Decision {
  if (toolName === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    if (!command.trim()) return { outcome: "pass" };
    return decideBash(command, sessionId, tokenPath, nowMs);
  }

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
    const check = checkTokenValidity(repoFullName(toolInput), sessionId, tokenPath, nowMs);
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
    const check = checkTokenValidity(repoFullName(toolInput), sessionId, tokenPath, nowMs);
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
