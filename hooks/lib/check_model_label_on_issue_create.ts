/**
 * Helper logic for require-model-label-on-issue-create.sh (web-jam-tools#382)
 *
 * Command segmentation (splitting a Bash command into `&&`/`||`/`;`/`|`/
 * newline/bare-`&`-separated simple commands) reuses splitOnOperators() from
 * normalize_command.ts rather than a hand-rolled operator set — a
 * hand-rolled set that doesn't understand newline or bare `&` let a
 * multi-line or `&`-separated `gh issue create` walk straight past this
 * guard (web-jam-tools#788 review Must Fix #1).
 */
import { splitOnOperators, splitShellTokens, stripHeredocs } from "./normalize_command.ts";
import { findUnresolvableIssuePointers } from "./detect_unresolvable_issue_pointers.ts";

const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const MCP_ISSUE_WRITE_RE = /^mcp__.*__issue_write$/;

export function loadModelLabels(modelLabelsPath: string): Set<string> {
  const text = Deno.readTextFileSync(modelLabelsPath);
  const data = JSON.parse(text);
  const names = data.modelLabels;
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error("modelLabels field is missing or empty");
  }
  if (!names.every((n: unknown) => typeof n === "string" && n)) {
    throw new Error("modelLabels field contains a non-string/empty entry");
  }
  return new Set(names as string[]);
}

export function findGhIssueCreateArgs(tokens: string[]): string[] | null {
  if (!tokens || tokens.length === 0) return null;
  const cmdBase = tokens[0].split("/").pop();
  if (cmdBase !== "gh") return null;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === "issue" && tokens[i + 1] === "create") {
      return tokens.slice(i + 2);
    }
  }
  return null;
}

export function findGhIssueEditArgs(tokens: string[]): string[] | null {
  if (!tokens || tokens.length === 0) return null;
  const cmdBase = tokens[0].split("/").pop();
  if (cmdBase !== "gh") return null;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === "issue" && tokens[i + 1] === "edit") {
      return tokens.slice(i + 2);
    }
  }
  return null;
}

export function findCreateIssueScriptArgs(tokens: string[]): string[] | null {
  if (!tokens || tokens.length === 0) return null;
  const cmdBase = tokens[0].split("/").pop();

  // Form 1 & 2: deno task create-issue ... OR deno task issue:create ... OR deno run ... create-issue.ts ...
  if (cmdBase === "deno") {
    if (
      tokens.length >= 3 &&
      tokens[1] === "task" &&
      (tokens[2] === "create-issue" || tokens[2] === "issue:create")
    ) {
      return tokens.slice(3);
    }
    if (tokens.length >= 2 && tokens[1] === "run") {
      for (let i = 2; i < tokens.length; i++) {
        const tok = tokens[i];
        if (
          tok.endsWith("/create-issue.ts") ||
          tok === "create-issue.ts" ||
          tok.endsWith("/create-issue") ||
          tok === "create-issue"
        ) {
          return tokens.slice(i + 1);
        }
      }
    }
    return null;
  }

  // Form 3: scripts/create-issue.ts ... (or ./scripts/create-issue.ts)
  if (cmdBase === "create-issue.ts" || cmdBase === "create-issue") {
    return tokens.slice(1);
  }

  return null;
}

export function stripLeadingAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && ASSIGN_RE.test(tokens[i])) {
    i++;
  }
  return tokens.slice(i);
}

export const VALID_NATIVE_TYPES = new Set(["Task", "Bug", "Feature", "Epic"]);
const VALID_NATIVE_TYPES_LOWER = new Set(["task", "bug", "feature", "epic"]);

export function extractTypeValue(args: string[]): string | null {
  let j = 0;
  while (j < args.length) {
    const a = args[j];
    if (a === "--type" || a === "-t") {
      if (j + 1 < args.length) {
        const val = args[j + 1].trim();
        if (val && !val.startsWith("-")) {
          return val;
        }
      }
      return null;
    }
    if (a.startsWith("--type=")) {
      const val = a.slice("--type=".length).trim();
      return val || null;
    }
    if (a.startsWith("-t=")) {
      const val = a.slice("-t=".length).trim();
      return val || null;
    }
    j += 1;
  }
  return null;
}

export function extractLabelValues(args: string[]): [string[], boolean] {
  const labels: string[] = [];
  let j = 0;
  while (j < args.length) {
    const a = args[j];
    if (a === "--label" || a === "-l") {
      if (j + 1 >= args.length) {
        return [labels, false];
      }
      labels.push(...args[j + 1].split(",").map((v) => v.trim()).filter(Boolean));
      j += 2;
      continue;
    }
    if (a.startsWith("--label=")) {
      labels.push(...a.slice("--label=".length).split(",").map((v) => v.trim()).filter(Boolean));
      j += 1;
      continue;
    }
    if (a.startsWith("-l=")) {
      labels.push(...a.slice("-l=".length).split(",").map((v) => v.trim()).filter(Boolean));
      j += 1;
      continue;
    }
    j += 1;
  }
  return [labels, true];
}

export function extractEscalationReason(args: string[]): string | null {
  let reason: string | null = null;
  let j = 0;
  while (j < args.length) {
    const a = args[j];
    if (a === "--escalation-reason") {
      if (j + 1 < args.length) {
        const val = args[j + 1].trim();
        if (val && !val.startsWith("--")) {
          reason = val;
          j += 2;
          continue;
        }
      }
      j += 1;
      continue;
    }
    if (a.startsWith("--escalation-reason=")) {
      const val = a.slice("--escalation-reason=".length).trim();
      if (val) {
        reason = val;
      }
      j += 1;
      continue;
    }
    j += 1;
  }
  return reason;
}

export function extractBodyValue(args: string[]): string | null {
  const bodyParts: string[] = [];
  let j = 0;
  while (j < args.length) {
    const a = args[j];
    if (a === "--body" || a === "-b") {
      if (j + 1 < args.length) {
        bodyParts.push(args[j + 1]);
        j += 2;
        continue;
      }
    } else if (a.startsWith("--body=")) {
      bodyParts.push(a.slice("--body=".length));
      j += 1;
      continue;
    } else if (a.startsWith("-b=")) {
      bodyParts.push(a.slice("-b=".length));
      j += 1;
      continue;
    } else if (a === "--body-file" || a === "-F") {
      if (j + 1 < args.length) {
        const filepath = args[j + 1];
        try {
          bodyParts.push(Deno.readTextFileSync(filepath));
        } catch {
          // file read failure ignored
        }
        j += 2;
        continue;
      }
    } else if (a.startsWith("--body-file=")) {
      const filepath = a.slice("--body-file=".length);
      try {
        bodyParts.push(Deno.readTextFileSync(filepath));
      } catch {
        // ignored
      }
      j += 1;
      continue;
    } else if (a.startsWith("-F=")) {
      const filepath = a.slice("-F=".length);
      try {
        bodyParts.push(Deno.readTextFileSync(filepath));
      } catch {
        // ignored
      }
      j += 1;
      continue;
    }
    j += 1;
  }
  return bodyParts.length ? bodyParts.join("\n") : null;
}

export function isEpicType(toolInput: Record<string, any>, tokens?: string[]): boolean {
  if (!toolInput || typeof toolInput !== "object") toolInput = {};
  for (const key of ["type", "issue_type", "type_name"]) {
    const val = toolInput[key];
    if (typeof val === "string" && val.replace(/^['"]|['"]$/g, "").toLowerCase() === "epic") {
      return true;
    }
  }
  const labels = toolInput.labels;
  if (Array.isArray(labels)) {
    if (
      labels.some((lbl) =>
        typeof lbl === "string" && lbl.replace(/^['"]|['"]$/g, "").toLowerCase() === "epic"
      )
    ) {
      return true;
    }
  }

  if (tokens) {
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (["--type", "-t", "--label", "-l", "--add-label"].includes(tok)) {
        if (
          i + 1 < tokens.length &&
          tokens[i + 1].replace(/^['"]|['"]$/g, "").toLowerCase() === "epic"
        ) {
          return true;
        }
      }
      for (const flag of ["--type=", "-t=", "--label=", "-l=", "--add-label="]) {
        if (tok.startsWith(flag)) {
          const val = tok.slice(flag.length).replace(/^['"]|['"]$/g, "");
          const parts = val.split(",").map((p) =>
            p.replace(/^['"]|['"]$/g, "").trim().toLowerCase()
          );
          if (parts.includes("epic")) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Model tiers that require an explicit escalation justification (web-jam-tools#709).
 *
 * NOTE: The guard checks ONLY presence of non-empty justification text,
 * NEVER quality or task complexity. Do not add complexity classification here.
 */
export const ESCALATION_LABELS = new Set(["Sonnet", "Opus"]);

export function decide(
  labels: string[],
  modelLabels: Set<string>,
  escalationReason?: string | null,
  cmd?: string,
  mode: "cli" | "mcp" = "cli",
): string {
  const validStr = Array.from(modelLabels).sort().join(", ");
  const matched = Array.from(new Set(labels.filter((label) => modelLabels.has(label)))).sort();

  if (matched.length === 0) {
    if (labels.includes("Josh")) {
      return "PASS";
    }
    const present = labels.length ? labels.join(", ") : "(none)";
    return `DENY:no model label (labels present: ${present}). Valid model labels: ${validStr}.`;
  }
  if (matched.length > 1) {
    const joined = matched.join(", ");
    return `DENY:${matched.length} model labels given (${joined}) — exactly one is required. Valid model labels: ${validStr}.`;
  }

  const matchedTier = matched[0];
  if (ESCALATION_LABELS.has(matchedTier)) {
    const reason = escalationReason?.trim();
    if (!reason) {
      if (mode === "mcp") {
        return `DENY:Creating an issue labeled '${matchedTier}' requires an explicit escalation justification.\nFlash High is the default model tier for implementation work and bills a separate Google budget, whereas ${matchedTier} bills the constrained Anthropic budget.\nTo proceed with ${matchedTier}, supply an 'escalation_reason' property (e.g. escalation_reason: "<why ${matchedTier} is genuinely the right tier>") in the tool input.`;
      }
      const commandToRun = cmd?.trim()
        ? `${cmd.trim()} --escalation-reason "<why ${matchedTier} is genuinely the right tier>"`
        : `gh issue create ... --label ${matchedTier} --escalation-reason "<why ${matchedTier} is genuinely the right tier>"`;
      return `DENY:Creating an issue labeled '${matchedTier}' requires an explicit escalation justification.\nFlash High is the default model tier for implementation work and bills a separate Google budget, whereas ${matchedTier} bills the constrained Anthropic budget.\nTo proceed with ${matchedTier}, re-run with an escalation reason:\n${commandToRun}`;
    }
  }

  return "PASS";
}

/**
 * Cheap, deliberately approximate "does this raw command plausibly
 * create/edit a gh issue" test, used only on the ambiguous-parse (unbalanced
 * quoting) path — a real, parseable command is always evaluated by the full
 * segment scan in `scanIssueCommandSegments()` instead. Must cover every
 * form the parseable scan below treats as issue-creating, or the
 * ambiguous-parse path fails OPEN on the form it misses.
 */
function looksLikeIssueCreatingOrEditingCommand(cmd: string): boolean {
  return (
    (/\bgh\b/.test(cmd) && /\bissue\b/.test(cmd) &&
      (/\bcreate\b/.test(cmd) || /\bedit\b/.test(cmd))) ||
    /\bcreate-issue\b/.test(cmd) ||
    /\bissue:create\b/.test(cmd)
  );
}

/**
 * Scans already-segmented simple commands for a `gh issue create` /
 * `create-issue` script call or a `gh issue edit` call, and applies the
 * model-label / native-type / unresolvable-pointer checks to whichever it
 * finds. `cmdForMessage` is the raw command text used only to build the
 * human-facing "re-run with an escalation reason" suggestion — see
 * `decide()` — and is deliberately independent of what was scanned (it
 * should reflect what the user actually typed, not a heredoc-stripped
 * rewrite of it).
 */
function scanIssueCommandSegments(
  segments: string[],
  toolInput: Record<string, any>,
  modelLabelsPath: string,
  cmdForMessage: string,
): string {
  for (const segment of segments) {
    const scTokens = stripLeadingAssignments(splitShellTokens(segment));
    const createArgs = findGhIssueCreateArgs(scTokens) ?? findCreateIssueScriptArgs(scTokens);
    if (createArgs !== null) {
      const typeVal = extractTypeValue(createArgs);
      if (!typeVal || !VALID_NATIVE_TYPES_LOWER.has(typeVal.toLowerCase())) {
        return "DENY:missing native issue type (--type/-t). Valid native types: Task, Bug, Feature, Epic.";
      }
      let modelLabels: Set<string>;
      try {
        modelLabels = loadModelLabels(modelLabelsPath);
      } catch (e) {
        return `DENY:couldn't load valid model labels from model-labels.json (${e})`;
      }
      const [labels, ok] = extractLabelValues(createArgs);
      if (!ok) {
        return "DENY:a --label/-l flag was given with no value";
      }
      const escalationReason = extractEscalationReason(createArgs);
      const res = decide(labels, modelLabels, escalationReason, cmdForMessage, "cli");
      if (res !== "PASS") return res;
      const body = extractBodyValue(createArgs);
      if (body && !isEpicType(toolInput, createArgs)) {
        const pointers = findUnresolvableIssuePointers(body);
        if (pointers.length) {
          return `DENY:unresolvable pointer phrase '${
            pointers[0]
          }' in issue body. Every non-Epic issue body must stand alone without pointer phrases referring to comments or epics.`;
        }
      }
      return "PASS";
    }

    const editArgs = findGhIssueEditArgs(scTokens);
    if (editArgs !== null) {
      if (isEpicType(toolInput, scTokens)) {
        return "PASS";
      }
      const body = extractBodyValue(editArgs);
      if (body) {
        const pointers = findUnresolvableIssuePointers(body);
        if (pointers.length) {
          return `DENY:unresolvable pointer phrase '${
            pointers[0]
          }' in issue body. Every non-Epic issue body must stand alone without pointer phrases referring to comments or epics.`;
        }
      }
      return "PASS";
    }
  }

  return "PASS";
}

export function checkModelLabelOnIssueCreate(inputJson: string, modelLabelsPath: string): string {
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(inputJson);
  } catch {
    return "PASS";
  }

  const toolName = String(payload.tool_name || "");
  const toolInputRaw = payload.tool_input || {};
  const toolInput = typeof toolInputRaw === "object" && toolInputRaw !== null
    ? (toolInputRaw as Record<string, any>)
    : {};

  if (
    toolName === "Bash" || toolName === "bash" || toolName === "" || toolInput.command ||
    toolInput.CommandLine
  ) {
    const cmd = String(toolInput.command || "").trim();
    if (!cmd) return "PASS";

    const { segments, unterminated } = splitOnOperators(cmd);
    if (!unterminated) {
      return scanIssueCommandSegments(segments, toolInput, modelLabelsPath, cmd);
    }

    // Ambiguous parse (web-jam-tools#813): a heredoc body redirected into a
    // FILE (`cat > f <<'EOF' ... EOF`, a review body, a design document) is
    // prose, not code — a stray apostrophe in it is exactly what leaves the
    // quote state above unbalanced. Retry once with stripHeredocs(), which
    // drops a data-redirected heredoc body but keeps one fed to an
    // interpreter (`bash <<EOF ... EOF`) in scope, since that body genuinely
    // executes. It also already handles every case this fix must cover: all
    // four delimiter spellings, multiple heredocs in one command, an
    // unterminated heredoc (kept in scope rather than crashing), and a
    // delimiter word appearing mid-body rather than as its own line.
    const stripped = stripHeredocs(cmd);
    const reparsed = splitOnOperators(stripped);
    if (!reparsed.unterminated) {
      // The stripped data body was the sole source of the ambiguity — no
      // longer ambiguous at all. Fall through to the normal segment scan
      // over the heredoc-stripped text: an issue-creating mention that
      // lived only in the removed data body is gone, while a real call
      // elsewhere (outside any heredoc, or inside an executed one) is still
      // found and evaluated on its own.
      return scanIssueCommandSegments(reparsed.segments, toolInput, modelLabelsPath, cmd);
    }

    // Still ambiguous after stripping data heredoc bodies (an executed
    // heredoc's body itself has unbalanced quoting, or the command is
    // malformed for an unrelated reason) — fall back to the blunt
    // whole-string test, scored against the heredoc-stripped text so a
    // stripped data body can never contribute a false match.
    if (looksLikeIssueCreatingOrEditingCommand(stripped)) {
      return "DENY:the command couldn't be parsed (unbalanced quoting) but appears to create/edit a gh issue";
    }
    return "PASS";
  }

  if (MCP_ISSUE_WRITE_RE.test(toolName)) {
    const method = toolInput.method;
    if (method === "update" || method === "edit") {
      if (isEpicType(toolInput)) return "PASS";
      const body = toolInput.body;
      if (typeof body === "string" && body) {
        const pointers = findUnresolvableIssuePointers(body);
        if (pointers.length) {
          return `DENY:unresolvable pointer phrase '${
            pointers[0]
          }' in issue body. Every non-Epic issue body must stand alone without pointer phrases referring to comments or epics.`;
        }
      }
      return "PASS";
    }
    if (method !== "create") {
      return `DENY:couldn't determine this issue_write call is a create/update (method=${
        JSON.stringify(method)
      })`;
    }
    const typeVal = typeof toolInput.type === "string" ? toolInput.type.trim() : "";
    if (!typeVal || !VALID_NATIVE_TYPES_LOWER.has(typeVal.toLowerCase())) {
      return "DENY:missing native issue type (--type/-t). Valid native types: Task, Bug, Feature, Epic.";
    }
    let modelLabels: Set<string>;
    try {
      modelLabels = loadModelLabels(modelLabelsPath);
    } catch (e) {
      return `DENY:couldn't load valid model labels from model-labels.json (${e})`;
    }
    const rawLabels = toolInput.labels;
    if (!Array.isArray(rawLabels) || !rawLabels.every((x) => typeof x === "string")) {
      return "DENY:the labels field is missing or not a JSON array of strings";
    }
    const rawEscalation = typeof toolInput.escalation_reason === "string"
      ? toolInput.escalation_reason
      : (typeof toolInput.escalationReason === "string"
        ? toolInput.escalationReason
        : (typeof toolInput.escalation_justification === "string"
          ? toolInput.escalation_justification
          : (typeof toolInput.justification === "string"
            ? toolInput.justification
            : (typeof toolInput.reason === "string" ? toolInput.reason : null))));
    const escalationReason = rawEscalation ? rawEscalation.trim() : null;
    const res = decide(rawLabels as string[], modelLabels, escalationReason, undefined, "mcp");
    if (res !== "PASS") return res;
    const body = toolInput.body;
    if (typeof body === "string" && body && !isEpicType(toolInput)) {
      const pointers = findUnresolvableIssuePointers(body);
      if (pointers.length) {
        return `DENY:unresolvable pointer phrase '${
          pointers[0]
        }' in issue body. Every non-Epic issue body must stand alone without pointer phrases referring to comments or epics.`;
      }
    }
    return "PASS";
  }

  return "PASS";
}

if (import.meta.main) {
  let inputJson = Deno.env.get("INPUT_JSON") || "";
  if (!inputJson) {
    try {
      inputJson = await new Response(Deno.stdin.readable).text();
    } catch {
      // ignore
    }
  }
  const modelLabelsPath = Deno.env.get("MODEL_LABELS_JSON_PATH") || "";
  console.log(checkModelLabelOnIssueCreate(inputJson, modelLabelsPath));
}
