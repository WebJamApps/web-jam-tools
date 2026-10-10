/**
 * check_issue_citation_on_write.ts — web-jam-tools#1056
 *
 * PreToolUse helper logic for check-issue-citation-on-write.sh.
 * Reuses hooks/lib/detect_bare_issue_refs.ts to inspect the body/comment text
 * written via:
 *   - Bash: gh pr comment, gh pr review, gh issue comment, gh issue create,
 *     gh issue edit (and guarded task/script equivalents: post-pr-comment,
 *     post-pr-review, post-issue-comment, edit-issue, create-issue)
 *   - MCP write tools: issue_write, pull_request_review_write,
 *     add_comment_to_pending_review, add_reply_to_pull_request_comment,
 *     update_issue_comment, add_issue_comment
 *
 * Design: hooks-design-2026-09-15.md D-14, D-16, D-20.
 * A workflow guard: denies when a bare issue reference is identified;
 * fails open (allowing with a note) when an input or file is unparseable.
 */

import { findBareIssueRefs } from "./detect_bare_issue_refs.ts";
import { splitOnOperators, splitShellTokens, stripHeredocs } from "./normalize_command.ts";

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

export const MCP_WRITE_TOOL_RE =
  /^(?:mcp__.*__)?(issue_write|pull_request_review_write|add_comment_to_pending_review|add_reply_to_pull_request_comment|update_issue_comment|add_issue_comment)$/;

const TARGET_TASK_NAMES = new Set([
  "post-pr-comment",
  "post-pr-review",
  "post-issue-comment",
  "edit-issue",
  "create-issue",
  "issue:create",
]);

const TARGET_SCRIPT_NAMES = new Set([
  "post-pr-comment.ts",
  "post-pr-review.ts",
  "post-issue-comment.ts",
  "edit-issue.ts",
  "create-issue.ts",
  "post-pr-comment",
  "post-pr-review",
  "post-issue-comment",
  "edit-issue",
  "create-issue",
]);

export function stripLeadingAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && ASSIGN_RE.test(tokens[i])) {
    i++;
  }
  return tokens.slice(i);
}

export function isTargetGhCli(tokens: string[]): boolean {
  if (!tokens || tokens.length < 3) return false;
  const cmdBase = tokens[0].split("/").pop();
  if (cmdBase !== "gh") return false;

  for (let i = 1; i < tokens.length - 1; i++) {
    const t1 = tokens[i];
    if (t1 === "pr") {
      for (let j = i + 1; j < tokens.length; j++) {
        const t2 = tokens[j];
        if (t2 === "comment" || t2 === "review") {
          return true;
        }
        if (!t2.startsWith("-")) {
          break;
        }
      }
    } else if (t1 === "issue") {
      for (let j = i + 1; j < tokens.length; j++) {
        const t2 = tokens[j];
        if (t2 === "comment" || t2 === "create" || t2 === "edit") {
          return true;
        }
        if (!t2.startsWith("-")) {
          break;
        }
      }
    }
  }
  return false;
}

export function isTargetTaskOrScript(tokens: string[]): boolean {
  if (!tokens || tokens.length === 0) return false;
  const cmdBase = tokens[0].split("/").pop();

  if (cmdBase === "deno") {
    if (tokens.length >= 3 && tokens[1] === "task") {
      return TARGET_TASK_NAMES.has(parseTaskInvocation(tokens).name ?? "");
    }
    if (tokens.length >= 2 && tokens[1] === "run") {
      for (let i = 2; i < tokens.length; i++) {
        const tok = tokens[i];
        if (!tok.startsWith("-")) {
          const scriptBase = tok.split("/").pop();
          if (scriptBase && TARGET_SCRIPT_NAMES.has(scriptBase)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  if (cmdBase && TARGET_SCRIPT_NAMES.has(cmdBase)) {
    return true;
  }

  return false;
}

const TASK_VALUE_FLAGS = new Set([
  "--config",
  "-c",
  "--cwd",
  "--filter",
  "-f",
  "--jobs",
  "--concurrency",
  "-j",
]);

/** Runner flags end at the task name; later flags belong to the publishing task. */
function parseTaskInvocation(tokens: string[]): {
  name?: string;
  args: string[];
  cwd?: string;
  config?: string;
} {
  const result: { name?: string; args: string[]; cwd?: string; config?: string } = { args: [] };
  for (let i = 2; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") {
      result.name = tokens[++i];
      result.args = tokens.slice(i + 1);
      break;
    }
    if (!token.startsWith("-")) {
      result.name = token;
      result.args = tokens.slice(i + 1);
      break;
    }
    const equal = token.indexOf("=");
    const flag = equal < 0 ? token : token.slice(0, equal);
    const value = equal >= 0
      ? token.slice(equal + 1)
      : TASK_VALUE_FLAGS.has(flag)
      ? tokens[++i]
      : undefined;
    if (flag === "--cwd") result.cwd = value;
    if (flag === "--config" || flag === "-c") result.config = value;
  }
  return result;
}

/** Deno tasks default to the configuration directory unless --cwd overrides it. */
function taskWorkingDirectory(tokens: string[], cwd?: string): string | undefined {
  const task = parseTaskInvocation(tokens);
  if (task.cwd) return resolveBodyFilePath(task.cwd, cwd);
  if (task.config) {
    const configPath = resolveBodyFilePath(task.config, cwd);
    return configPath.slice(0, configPath.lastIndexOf("/")) || ".";
  }
  if (!cwd) return undefined;
  let directory = cwd.replace(/\/+$/, "") || "/";
  while (true) {
    for (const filename of ["deno.json", "deno.jsonc", "package.json"]) {
      try {
        if (Deno.statSync(`${directory}/${filename}`).isFile) return directory;
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
    }
    const parent = directory.slice(0, directory.lastIndexOf("/")) || "/";
    if (parent === directory) return cwd;
    directory = parent;
  }
}

/** Normalize URL citations to the shared detector's repo#number input format. */
function findBareWriteRefs(body: string): string[] {
  const urls = new Map<string, string>();
  const normalized = body
    .replace(
      /\[([^\]\n]+)\]\((https:\/\/github\.com\/[^/\s]+\/([\w.-]+)\/(?:issues|pull)\/(\d+))\)/g,
      (_match, label: string, url: string, repo: string, number: string) => {
        const token = `${repo}#${number}`;
        urls.set(token, url);
        // A URL used as its own label supplies no title.
        return label === url ? token : `${token} "${label.replaceAll('"', "'")}"`;
      },
    )
    .replace(
      /https:\/\/github\.com\/[^/\s]+\/([\w.-]+)\/(?:issues|pull)\/(\d+)(?:[?#][^\s<>)]*)?/g,
      (url: string, repo: string, number: string) => {
        const token = `${repo}#${number}`;
        urls.set(token, url);
        return token;
      },
    );
  return findBareIssueRefs(normalized).map((token) => urls.get(token) ?? token);
}

export function isTargetGhWriteCommand(tokens: string[]): boolean {
  return isTargetGhCli(tokens) || isTargetTaskOrScript(tokens);
}

export function resolveBodyFilePath(filepath: string, cwd?: string): string {
  if (filepath.startsWith("~/")) {
    const home = Deno.env.get("HOME");
    if (home) {
      return `${home.replace(/\/+$/, "")}/${filepath.slice(2)}`;
    }
  }
  if (!cwd || filepath.startsWith("/") || filepath.startsWith("~") || filepath.includes("$")) {
    return filepath;
  }
  return `${cwd.replace(/\/+$/, "")}/${filepath}`;
}

export interface ExtractedBodyDetails {
  body: string | null;
  readError?: string;
}

export function extractBodyDetails(args: string[], cwd?: string): ExtractedBodyDetails {
  const bodyParts: string[] = [];
  let readError: string | undefined;

  const readBodyFile = (filepath: string) => {
    try {
      if (!cwd && !filepath.startsWith("/") && !filepath.startsWith("~/")) {
        throw new Error("command working directory is unknown");
      }
      bodyParts.push(Deno.readTextFileSync(resolveBodyFilePath(filepath, cwd)));
    } catch (err) {
      readError = `could not read body file '${filepath}': ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  };

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
        readBodyFile(args[j + 1]);
        j += 2;
        continue;
      }
    } else if (a.startsWith("--body-file=")) {
      readBodyFile(a.slice("--body-file=".length));
      j += 1;
      continue;
    } else if (a.startsWith("-F=")) {
      readBodyFile(a.slice("-F=".length));
      j += 1;
      continue;
    }
    j += 1;
  }

  return {
    body: bodyParts.length ? bodyParts.join("\n") : null,
    readError,
  };
}

export function formatCitationDenial(offenders: string[]): string {
  const lines = [
    "BLOCKED (issue-citation guard): this message cites an issue/PR without its title.",
    "Offending token(s):",
    ...offenders.map((tok) => `  - ${tok}`),
    "",
    'Every issue/PR mention needs the full form: repo#number "title" — e.g.:',
    '  web-jam-tools#299 "Delete replaced labels org-wide, after migration"',
    "If you don't know the title, look it up first: gh issue view N --repo OWNER/REPO --json title",
    "",
    'Milestone/ordinal references like "(#2)" are ALSO flagged — rewrite without a',
    'bare #, e.g. "milestone 2" or "the 2nd point above"; only a full',
    'repo#number "title" citation is exempt.',
    "(rule: cite-issues-with-title-repo-number — do not retry with the same bare number)",
  ];
  return lines.join("\n");
}

export interface ScanResult {
  offenders: string[];
  readErrors: string[];
}

export function scanBashCommandSegments(
  segments: string[],
  cwd?: string,
): ScanResult {
  const offendersSet = new Set<string>();
  const readErrors: string[] = [];
  let effectiveCwd = cwd;
  let previousCwd: string | undefined;

  for (const segment of segments) {
    const rawTokens = splitShellTokens(segment);
    if (!rawTokens || rawTokens.length === 0) continue;
    const tokens = stripLeadingAssignments(rawTokens);
    if (tokens.length === 0) continue;

    if (tokens[0] === "cd") {
      const destination = tokens[1] === "--" ? tokens[2] : tokens[1];
      try {
        const nextCwd = destination === "-" ? previousCwd : resolveBodyFilePath(
          destination || Deno.env.get("HOME") || "",
          effectiveCwd,
        );
        if (!nextCwd || nextCwd.includes("$") || !Deno.statSync(nextCwd).isDirectory) {
          throw new Error("directory cannot be determined");
        }
        previousCwd = effectiveCwd;
        effectiveCwd = nextCwd;
      } catch {
        effectiveCwd = undefined;
        readErrors.push("could not determine working directory after cd");
      }
      continue;
    }

    if (isTargetGhWriteCommand(tokens)) {
      const isTask = tokens[0].split("/").pop() === "deno" && tokens[1] === "task";
      let bodyCwd = effectiveCwd;
      try {
        if (isTask) bodyCwd = taskWorkingDirectory(tokens, effectiveCwd);
      } catch (err) {
        bodyCwd = undefined;
        readErrors.push(`could not determine task working directory: ${err}`);
      }
      const details = extractBodyDetails(
        isTask ? parseTaskInvocation(tokens).args : tokens,
        bodyCwd,
      );
      if (details.readError) {
        readErrors.push(details.readError);
      }
      if (details.body) {
        try {
          for (const tok of findBareWriteRefs(details.body)) {
            offendersSet.add(tok);
          }
        } catch (err) {
          readErrors.push(`citation detector error: ${err}`);
        }
      }
    }
  }

  return {
    offenders: Array.from(offendersSet),
    readErrors,
  };
}

export function checkIssueCitationOnWrite(inputJson: string): string {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(inputJson);
  } catch {
    return "PASS: hook payload could not be parsed as JSON";
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "PASS: hook payload is not an object";
  }

  const toolCall = payload.toolCall && typeof payload.toolCall === "object"
    ? (payload.toolCall as Record<string, unknown>)
    : undefined;
  const toolName = String(payload.tool_name || toolCall?.name || "");
  const toolInputRaw = payload.tool_input || toolCall?.args || {};
  if (typeof toolInputRaw !== "object" || toolInputRaw === null || Array.isArray(toolInputRaw)) {
    return "PASS: tool input is not an object";
  }
  const toolInput = typeof toolInputRaw === "object" && toolInputRaw !== null
    ? (toolInputRaw as Record<string, unknown>)
    : {};

  if (
    toolName === "Bash" || toolName === "bash" || toolName === "run_command" || toolName === "" ||
    toolInput.command || toolInput.CommandLine
  ) {
    const cmd = String(toolInput.command || toolInput.CommandLine || "").trim();
    if (!cmd) return "PASS";
    const cwd = typeof payload.cwd === "string" && payload.cwd
      ? payload.cwd
      : (typeof toolInput.cwd === "string" && toolInput.cwd
        ? toolInput.cwd
        : (typeof toolInput.Cwd === "string" && toolInput.Cwd ? toolInput.Cwd : undefined));

    let { segments, unterminated } = splitOnOperators(cmd);
    if (unterminated) {
      const stripped = stripHeredocs(cmd);
      const reparsed = splitOnOperators(stripped);
      if (!reparsed.unterminated) {
        segments = reparsed.segments;
        unterminated = false;
      }
    }

    if (unterminated) {
      return "PASS: command could not be parsed (unbalanced quotes or heredoc)";
    }

    const { offenders, readErrors } = scanBashCommandSegments(segments, cwd);
    if (offenders.length > 0) {
      return `DENY:${formatCitationDenial(offenders)}`;
    }
    if (readErrors.length > 0) {
      return `PASS: ${readErrors.join("; ")}`;
    }
    return "PASS";
  }

  if (MCP_WRITE_TOOL_RE.test(toolName)) {
    const rawBody = toolInput.body;
    const offendersSet = new Set<string>();
    const readErrors: string[] = [];

    if (rawBody !== undefined && rawBody !== null) {
      if (typeof rawBody !== "string") {
        return "PASS: tool_input.body is not a string";
      }
      try {
        for (const tok of findBareWriteRefs(rawBody)) {
          offendersSet.add(tok);
        }
      } catch (err) {
        readErrors.push(`citation detector error: ${err}`);
      }
    }

    const rawComments = toolInput.comments;
    if (Array.isArray(rawComments)) {
      for (const item of rawComments) {
        if (item && typeof item === "object" && typeof item.body === "string") {
          try {
            for (const tok of findBareWriteRefs(item.body)) {
              offendersSet.add(tok);
            }
          } catch (err) {
            readErrors.push(`citation detector error: ${err}`);
          }
        }
      }
    }

    const offenders = Array.from(offendersSet);
    if (offenders.length > 0) {
      return `DENY:${formatCitationDenial(offenders)}`;
    }
    if (readErrors.length > 0) {
      return `PASS: ${readErrors.join("; ")}`;
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
  console.log(checkIssueCitationOnWrite(inputJson));
}
