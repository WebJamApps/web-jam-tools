/**
 * Helper logic for require-model-label-on-issue-create.sh (web-jam-tools#382)
 */
import { splitShellTokens } from "./normalize_command.ts";
import { findUnresolvableIssuePointers } from "./detect_unresolvable_issue_pointers.ts";

const OPERATORS = new Set(["&&", "||", ";", "|", "(", ")"]);
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

export function stripLeadingAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && ASSIGN_RE.test(tokens[i])) {
    i++;
  }
  return tokens.slice(i);
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
    if (labels.some((lbl) => typeof lbl === "string" && lbl.replace(/^['"]|['"]$/g, "").toLowerCase() === "epic")) {
      return true;
    }
  }

  if (tokens) {
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (["--type", "-t", "--label", "-l", "--add-label"].includes(tok)) {
        if (i + 1 < tokens.length && tokens[i + 1].replace(/^['"]|['"]$/g, "").toLowerCase() === "epic") {
          return true;
        }
      }
      for (const flag of ["--type=", "-t=", "--label=", "-l=", "--add-label="]) {
        if (tok.startsWith(flag)) {
          const val = tok.slice(flag.length).replace(/^['"]|['"]$/g, "");
          const parts = val.split(",").map((p) => p.replace(/^['"]|['"]$/g, "").trim().toLowerCase());
          if (parts.includes("epic")) return true;
        }
      }
    }
  }
  return false;
}

export function decide(labels: string[], modelLabels: Set<string>): string {
  const validStr = Array.from(modelLabels).sort().join(", ");
  const matched = Array.from(new Set(labels.filter((label) => modelLabels.has(label)))).sort();

  if (matched.length === 0) {
    const present = labels.length ? labels.join(", ") : "(none)";
    return `DENY:no model label (labels present: ${present}). Valid model labels: ${validStr}.`;
  }
  if (matched.length > 1) {
    const joined = matched.join(", ");
    return `DENY:${matched.length} model labels given (${joined}) — exactly one is required. Valid model labels: ${validStr}.`;
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

  if (toolName === "Bash") {
    const cmd = String(toolInput.command || "").trim();
    if (!cmd) return "PASS";
    let tokens: string[];
    try {
      tokens = splitShellTokens(cmd);
    } catch {
      if (/\bgh\b/.test(cmd) && /\bissue\b/.test(cmd) && (/\bcreate\b/.test(cmd) || /\bedit\b/.test(cmd))) {
        return "DENY:the command couldn't be parsed (unbalanced quoting) but appears to create/edit a gh issue";
      }
      return "PASS";
    }

    const simpleCommands: string[][] = [[]];
    for (const tok of tokens) {
      if (OPERATORS.has(tok)) {
        simpleCommands.push([]);
      } else {
        simpleCommands[simpleCommands.length - 1].push(tok);
      }
    }

    for (const sc of simpleCommands) {
      const scTokens = stripLeadingAssignments(sc);
      const createArgs = findGhIssueCreateArgs(scTokens);
      if (createArgs !== null) {
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
        const res = decide(labels, modelLabels);
        if (res !== "PASS") return res;
        const body = extractBodyValue(createArgs);
        if (body) {
          const pointers = findUnresolvableIssuePointers(body);
          if (pointers.length) {
            return `DENY:unresolvable pointer phrase '${pointers[0]}' in issue body. Every non-Epic issue body must stand alone without pointer phrases referring to comments or epics.`;
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
            return `DENY:unresolvable pointer phrase '${pointers[0]}' in issue body. Every non-Epic issue body must stand alone without pointer phrases referring to comments or epics.`;
          }
        }
        return "PASS";
      }
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
          return `DENY:unresolvable pointer phrase '${pointers[0]}' in issue body. Every non-Epic issue body must stand alone without pointer phrases referring to comments or epics.`;
        }
      }
      return "PASS";
    }
    if (method !== "create") {
      return `DENY:couldn't determine this issue_write call is a create/update (method=${JSON.stringify(method)})`;
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
    const res = decide(rawLabels as string[], modelLabels);
    if (res !== "PASS") return res;
    const body = toolInput.body;
    if (typeof body === "string" && body) {
      const pointers = findUnresolvableIssuePointers(body);
      if (pointers.length) {
        return `DENY:unresolvable pointer phrase '${pointers[0]}' in issue body. Every non-Epic issue body must stand alone without pointer phrases referring to comments or epics.`;
      }
    }
    return "PASS";
  }

  return "PASS";
}

if (import.meta.main) {
  const inputJson = Deno.env.get("INPUT_JSON") || "";
  const modelLabelsPath = Deno.env.get("MODEL_LABELS_JSON_PATH") || "";
  console.log(checkModelLabelOnIssueCreate(inputJson, modelLabelsPath));
}
