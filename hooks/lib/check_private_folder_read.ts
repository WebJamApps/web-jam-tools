/**
 * Shared private-folder read guard (web-jam-tools#1141).
 *
 * Inspects a Bash command's text for any of the 16 private Dropbox folders
 * covered by Claude Code's Read/Edit deny rules in ~/.claude/settings.json.
 *
 * One list, read once from settings.json — never duplicated into the repo.
 *
 * Three outcomes:
 *   - Allow: command text names no folder from the list (passes, exit 0).
 *   - Deny: command text names one of the listed folders (refused, exit 2, reason on stderr).
 *   - Refused (fails closed): ~/.claude/settings.json is missing, unreadable, or unparseable (exit 2).
 *
 * Used across Claude Code, agy (via hooks/agy-hook-shim.sh), and Codex (WJT_SURFACE=codex).
 */

import * as path from "jsr:@std/path@^1.0.0";

export interface FolderListResult {
  ok: boolean;
  folders: string[];
  error?: string;
}

export function getPrivateDropboxFolders(settingsPath?: string): FolderListResult {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "/home/joshua";
  const targetPath = settingsPath ||
    Deno.env.get("CLAUDE_SETTINGS_PATH") ||
    path.join(home, ".claude/settings.json");

  let content: string;
  try {
    content = Deno.readTextFileSync(targetPath);
  } catch (err) {
    return {
      ok: false,
      folders: [],
      error: `cannot read settings file at '${targetPath}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      ok: false,
      folders: [],
      error: `cannot parse JSON in settings file at '${targetPath}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return {
      ok: false,
      folders: [],
      error: `settings file at '${targetPath}' is not an object`,
    };
  }

  const permissions = (parsed as Record<string, unknown>).permissions;
  if (typeof permissions !== "object" || permissions === null) {
    return {
      ok: false,
      folders: [],
      error: `settings file at '${targetPath}' missing permissions object`,
    };
  }

  const deny = (permissions as Record<string, unknown>).deny;
  if (!Array.isArray(deny)) {
    return {
      ok: false,
      folders: [],
      error: `settings file at '${targetPath}' permissions.deny is not an array`,
    };
  }

  const folders: string[] = [];
  for (const rule of deny) {
    if (typeof rule === "string") {
      const match = rule.match(/^Read\(.*?[/\\]Dropbox[/\\]([^/\\]+)[/\\]\*\*\)$/);
      if (match && !folders.includes(match[1])) {
        folders.push(match[1]);
      }
    }
  }

  if (folders.length === 0) {
    return {
      ok: false,
      folders: [],
      error: `no private Dropbox folders found in permissions.deny in '${targetPath}'`,
    };
  }

  return {
    ok: true,
    folders,
  };
}

export function folderToRegexPattern(folder: string): string {
  let pattern = "";
  for (let i = 0; i < folder.length; i++) {
    const ch = folder[i];
    if (ch === " ") {
      pattern += "(?:\\\\?\\s|['\"]\\s*['\"])";
    } else if (ch === "(") {
      pattern += "(?:\\\\?\\()";
    } else if (ch === ")") {
      pattern += "(?:\\\\?\\))";
    } else if (/[a-zA-Z0-9_-]/.test(ch)) {
      pattern += ch;
    } else {
      pattern += "\\" + ch;
    }
  }
  return pattern;
}

export function buildFolderPattern(folder: string): RegExp {
  const folderPattern = folderToRegexPattern(folder);
  // Match Dropbox followed by the folder name
  // Preceded by: start of string, or common delimiters/path separators
  // Then optional path before Dropbox (e.g. /home/joshua/, ~/, $HOME/, ${HOME}/, etc.)
  // Then Dropbox/
  // Then optional quote around folder name
  // Then folderPattern
  // Then optional quote
  // Then lookahead: end of string, or path separator (/ or \), or quotes, or whitespace, or shell delimiters
  const prefix =
    "(?:^|[\\s\"'`=:(</\\\\])(?:[~a-zA-Z0-9_./$}{@\\-]*[\\\\/])?[Dd]ropbox[\\\\/]+['\"]?";
  const suffix = "['\"]?(?=$|[\\\\/'\"`\\s;&|),>\\]])";
  return new RegExp(prefix + folderPattern + suffix);
}

export function checkCommandForPrivateFolder(command: string, folders: string[]): string | null {
  for (const f of folders) {
    const regex = buildFolderPattern(f);
    if (regex.test(command)) {
      return f;
    }
  }
  return null;
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = Deno.stdin.readable.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } catch {
    // Stdin closed or empty
  }
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const full = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    full.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(full);
}

export async function main(): Promise<void> {
  let command = Deno.env.get("CMD_FOR_PY") || "";
  let toolName = "";

  if (!command && Deno.args.length > 0) {
    command = Deno.args.join(" ");
  }

  const rawInput = await readStdin();
  if (rawInput.trim()) {
    try {
      const data = JSON.parse(rawInput);
      if (typeof data === "object" && data !== null) {
        if (typeof data.tool_name === "string") {
          toolName = data.tool_name;
        }
        const toolInputRaw = data.tool_input ?? data.input ?? data.arguments ?? {};
        const toolInput = typeof toolInputRaw === "object" && toolInputRaw !== null
          ? (toolInputRaw as Record<string, unknown>)
          : {};
        const cmdFromTool = String(toolInput.command ?? data.command ?? "").trim();
        if (cmdFromTool) {
          command = cmdFromTool;
        }
      }
    } catch {
      if (!command) {
        command = rawInput.trim();
      }
    }
  }

  // If tool name is explicitly provided and is not Bash, allow (exit 0)
  if (toolName && toolName !== "Bash" && toolName !== "bash") {
    Deno.exit(0);
  }

  // If no command text was passed, allow (exit 0)
  if (!command || !command.trim()) {
    Deno.exit(0);
  }

  // Load private folders list from settings.json
  const folderResult = getPrivateDropboxFolders();
  if (!folderResult.ok) {
    console.error(
      `BLOCKED (private-folder read guard): failed to establish private Dropbox folder list: ${folderResult.error}`,
    );
    console.error(
      "~/.claude/settings.json must exist, be valid JSON, and define permissions.deny with Read(//home/joshua/Dropbox/<folder>/**) rules.",
    );
    console.error("(rule: web-jam-tools#1141 — shared private-folder read guard)");
    Deno.exit(2);
  }

  const matchedFolder = checkCommandForPrivateFolder(command, folderResult.folders);
  if (matchedFolder) {
    console.error(
      `BLOCKED (private-folder read guard): command names private Dropbox folder '${matchedFolder}'.`,
    );
    console.error(
      "Private Dropbox folders are protected from shell inspection across Claude Code, agy, and Codex.",
    );
    console.error("(rule: web-jam-tools#1141 — shared private-folder read guard)");
    Deno.exit(2);
  }

  Deno.exit(0);
}

if (import.meta.main) {
  await main();
}
