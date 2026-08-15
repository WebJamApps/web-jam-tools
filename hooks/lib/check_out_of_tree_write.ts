/**
 * PreToolUse guard (Write|Edit|NotebookEdit) module (web-jam-tools#511).
 *
 * COVERAGE LIMIT:
 * This hook fences Claude Code sessions and subagents only. It does not fence agy.
 * agy internal file writes are not seen by Claude Code PreToolUse hooks.
 * Full coverage of agy is blocked on web-jam-tools#432 "agy hooks do not enforce — all 12 are inert on Flash, and a Stop/SessionStart entry kills the whole config; fix that, then give Antigravity Gmail MCP fenced by a working hook".
 *
 * Denies Write/Edit/NotebookEdit calls targeting paths outside the current repository working tree,
 * allowlisting /tmp and session scratchpad directories.
 */

import * as path from "jsr:@std/path@^1.0.0";

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

export function isInsideTree(targetPath: string, repoRoot: string | null, cwd?: string): boolean {
  const baseDir = cwd ? path.resolve(cwd) : Deno.cwd();
  const expanded = expandHome(targetPath);
  const resolvedTarget = path.resolve(baseDir, expanded);

  if (isAllowlisted(resolvedTarget)) {
    return true;
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
    Deno.exit(0);
  }

  if (!rawInput.trim()) {
    Deno.exit(0);
  }

  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(rawInput);
  } catch {
    Deno.exit(0);
  }

  const toolInputRaw = data.tool_input ?? data.input ?? data.arguments ?? {};
  const toolInput = typeof toolInputRaw === "object" && toolInputRaw !== null
    ? (toolInputRaw as Record<string, unknown>)
    : {};

  const targetPath = String(
    toolInput.file_path ??
      toolInput.notebook_path ??
      toolInput.path ??
      toolInput.TargetFile ??
      toolInput.target_file ??
      "",
  ).trim();

  if (!targetPath) {
    Deno.exit(0);
  }

  const cwd = Deno.cwd();
  const repoRoot = getRepoRoot(cwd);

  if (!isInsideTree(targetPath, repoRoot, cwd)) {
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

  Deno.exit(0);
}

if (import.meta.main) {
  main();
}
