/**
 * PreToolUse guard (Write|Edit|NotebookEdit) module (web-jam-tools#511).
 *
 * Denies Write/Edit/NotebookEdit calls targeting paths outside the current repository working tree,
 * allowlisting /tmp and session scratchpad directories. agy reaches this guard through the shim;
 * its payload's artifactDirectoryPath also allows that conversation's own plan and task files.
 */

import * as path from "jsr:@std/path@^1.0.0";
import { parseApplyPatchFilePaths } from "./parse_apply_patch.ts";

export function expandHome(filePath: string): string {
  if (filePath === "~" || filePath.startsWith("~/")) {
    const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "/home/joshua";
    return filePath === "~" ? home : path.join(home, filePath.slice(2));
  }
  return filePath;
}

export function isAllowlisted(resolvedPath: string): boolean {
  if (
    resolvedPath === "/tmp" ||
    resolvedPath.startsWith("/tmp/") ||
    resolvedPath === "/private/tmp" ||
    resolvedPath.startsWith("/private/tmp/") ||
    resolvedPath === "/var/tmp" ||
    resolvedPath.startsWith("/var/tmp/")
  ) {
    return true;
  }

  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "/home/joshua";

  // Allowlist ~/Dropbox/web-jam-llms/
  const dropboxTree = path.join(home, "Dropbox/web-jam-llms");
  if (resolvedPath === dropboxTree || resolvedPath.startsWith(dropboxTree + "/")) {
    return true;
  }

  // Allowlist ~/.claude/shared-memory/
  const sharedMemoryTree = path.join(home, ".claude/shared-memory");
  if (resolvedPath === sharedMemoryTree || resolvedPath.startsWith(sharedMemoryTree + "/")) {
    return true;
  }

  // Allowlist Markdown files directly inside ~/.claude/ (web-jam-tools#551 follow-up).
  // Deliberately NOT recursive: only a file whose parent directory is exactly ~/.claude/
  // qualifies. ~/.claude/hooks/notes.md, ~/.claude/projects/*/some-file.md, and any
  // non-.md file directly in ~/.claude/ (settings.json, settings.local.json) stay blocked.
  const claudeDir = path.join(home, ".claude");
  if (path.dirname(resolvedPath) === claudeDir && resolvedPath.endsWith(".md")) {
    return true;
  }

  // Allowlist ~/.claude/projects/*/memory/
  const projectsPrefix = path.join(home, ".claude/projects");
  if (resolvedPath.startsWith(projectsPrefix + "/")) {
    const rel = resolvedPath.slice(projectsPrefix.length + 1);
    const parts = rel.split("/");
    if (parts.length >= 2 && parts[1] === "memory") {
      return true;
    }
  }

  return false;
}

export function getRepoRoot(startDir: string): string | null {
  try {
    const command = new Deno.Command("git", {
      args: ["-C", startDir, "rev-parse", "--show-toplevel"],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = command.outputSync();
    if (code === 0) {
      const top = new TextDecoder().decode(stdout).trim();
      if (top) return path.resolve(top);
    }
  } catch {
    // fallback
  }
  return null;
}

export function isInsideTree(
  targetPath: string,
  repoRoot: string | null,
  cwd?: string,
  artifactDirectoryPath?: string,
): boolean {
  const baseDir = cwd ? path.resolve(cwd) : Deno.cwd();
  const expanded = expandHome(targetPath);
  const resolvedTarget = path.resolve(baseDir, expanded);

  if (isAllowlisted(resolvedTarget)) {
    return true;
  }

  if (artifactDirectoryPath && path.isAbsolute(artifactDirectoryPath)) {
    const artifactRoot = path.resolve(artifactDirectoryPath);
    if (resolvedTarget === artifactRoot || resolvedTarget.startsWith(artifactRoot + "/")) {
      return true;
    }
  }

  if (!repoRoot) {
    return false;
  }

  const resolvedRepo = path.resolve(repoRoot);
  if (resolvedTarget === resolvedRepo || resolvedTarget.startsWith(resolvedRepo + "/")) {
    return true;
  }

  return false;
}

export function main(): void {
  let rawInput = "";
  try {
    const decoder = new TextDecoder();
    const buf = new Uint8Array(65536);
    while (true) {
      const n = Deno.stdin.readSync(buf);
      if (n === null || n === 0) break;
      rawInput += decoder.decode(buf.subarray(0, n));
    }
  } catch {
    allowWithNote("hook payload could not be read");
    return;
  }

  if (!rawInput.trim()) {
    allowWithNote("hook payload is empty");
    return;
  }

  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(rawInput);
  } catch {
    allowWithNote("hook payload could not be parsed");
    return;
  }

  const toolName = String(data.tool_name ?? data.name ?? "").trim();
  const toolInputRaw = data.tool_input ?? data.input ?? data.arguments ?? {};
  const toolInput = typeof toolInputRaw === "object" && toolInputRaw !== null
    ? (toolInputRaw as Record<string, unknown>)
    : {};

  let targetPaths: string[] = [];
  if (toolName === "apply_patch") {
    const command = String(toolInput.command ?? "");
    targetPaths = parseApplyPatchFilePaths(command);
    if (targetPaths.length === 0) {
      console.error(
        "BLOCKED (out-of-tree write guard): apply_patch contains no parseable file paths (malformed or unrecognized patch text).",
      );
      console.error(
        "An out-of-repo write is invisible to gh pr diff, is not undone by closing the PR, and is covered by no test or CI gate.",
      );
      console.error("(rule: web-jam-tools#511 — fence Write/Edit to repo working tree)");
      Deno.exit(2);
    }
  } else {
    const singlePath = String(
      toolInput.file_path ??
        toolInput.notebook_path ??
        toolInput.path ??
        toolInput.TargetFile ??
        toolInput.target_file ??
        "",
    ).trim();

    if (!singlePath) {
      Deno.exit(0);
    }
    targetPaths = [singlePath];
  }

  const cwd = typeof data.cwd === "string" && path.isAbsolute(data.cwd) ? data.cwd : undefined;
  if (!cwd) {
    allowWithNote("cwd is missing or is not an absolute path");
    return;
  }
  const repoRoot = getRepoRoot(cwd);
  if (!repoRoot) {
    allowWithNote("repository root could not be resolved from payload cwd");
    return;
  }

  const artifactDirectoryPath = typeof data.artifactDirectoryPath === "string"
    ? data.artifactDirectoryPath
    : undefined;

  for (const targetPath of targetPaths) {
    if (!isInsideTree(targetPath, repoRoot, cwd, artifactDirectoryPath)) {
      const expanded = expandHome(targetPath);
      const resolvedTarget = path.resolve(cwd, expanded);
      const repoInfo = repoRoot ? `'${repoRoot}'` : "none (not inside a git repository)";
      console.error(
        `BLOCKED (out-of-tree write guard): attempted write to '${targetPath}' (resolved: '${resolvedTarget}') outside the repository working tree (${repoInfo}).`,
      );
      console.error(
        "An out-of-repo write is invisible to gh pr diff, is not undone by closing the PR, and is covered by no test or CI gate.",
      );
      console.error("(rule: web-jam-tools#511 — fence Write/Edit to repo working tree)");
      Deno.exit(2);
    }
  }

  Deno.exit(0);
}

if (import.meta.main) {
  main();
}

function allowWithNote(field: string): void {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        `out-of-tree write guard: ${field}; proceeding. Verify the target is in the intended repository working tree or an allowed scratch/document path before writing.`,
    },
  }));
}
