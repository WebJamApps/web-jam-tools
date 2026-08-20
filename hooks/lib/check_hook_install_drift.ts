/**
 * check_hook_install_drift.ts — web-jam-tools#664
 *
 * Checks:
 * 1. Local web-jam-tools checkout vs origin/dev for hook files added, deleted, or modified.
 * 2. settings.json entries whose hook command points at a non-existent path.
 * 3. Hook files present on origin/dev that settings.json does not register.
 *
 * Read-only: never writes to git or settings.json, never prints settings.json contents.
 * Outputs SessionStart JSON {"systemMessage": "..."} when drift is detected; otherwise silent.
 */

import * as path from "jsr:@std/path@^1.0.0";

export interface DriftOptions {
  settingsPath?: string;
  repoDir?: string;
  remoteRef?: string;
  homeDir?: string;
}

export interface RemoteHookDiff {
  added: string[];
  deleted: string[];
  modified: string[];
}

export interface DeadHookPath {
  event: string;
  command: string;
  resolvedPath: string;
}

export interface DriftResult {
  remoteDiff: RemoteHookDiff;
  deadHooks: DeadHookPath[];
  unregisteredHooks: string[];
}

export function tryExistsSync(p: string): boolean {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
}

export async function runGit(
  args: string[],
  cwd: string,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  try {
    const cmd = new Deno.Command("git", {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    return {
      success: output.success,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  } catch (err) {
    return {
      success: false,
      stdout: "",
      stderr: String(err),
    };
  }
}

export function resolveScriptPath(rawPath: string, home: string): string {
  let p = rawPath.trim();
  if (p === "$HOME" || p === "~") {
    p = home;
  } else if (p.startsWith("$HOME/")) {
    p = path.join(home, p.slice(6));
  } else if (p.startsWith("~/")) {
    p = path.join(home, p.slice(2));
  }
  return path.resolve(p);
}

export function extractScriptPathFromCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";
  const firstToken = trimmed.split(/\s+/)[0];
  return firstToken;
}

export async function checkRemoteDiff(
  repoDir: string,
  remoteRef: string,
): Promise<RemoteHookDiff> {
  const result: RemoteHookDiff = { added: [], deleted: [], modified: [] };
  if (!tryExistsSync(path.join(repoDir, ".git"))) {
    const gitDirCheck = await runGit(["rev-parse", "--git-dir"], repoDir);
    if (!gitDirCheck.success) return result;
  }

  const verifyRef = await runGit(
    ["rev-parse", "--verify", `${remoteRef}^{commit}`],
    repoDir,
  );
  if (!verifyRef.success) {
    return result;
  }

  // Diff HEAD against remoteRef for files in hooks/
  // In `git diff HEAD remoteRef`:
  // 'A' means added in remoteRef (present in remoteRef, absent in HEAD)
  // 'D' means deleted in remoteRef (present in HEAD, absent in remoteRef)
  // 'M' means modified in remoteRef
  const diffOutput = await runGit(
    ["diff", "--name-status", "HEAD", remoteRef, "--", "hooks/"],
    repoDir,
  );
  if (!diffOutput.success) return result;

  for (const line of diffOutput.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    const statusCode = parts[0];
    const filePath = parts[1];

    if (!filePath || !filePath.startsWith("hooks/")) continue;

    if (statusCode.startsWith("A")) {
      result.added.push(filePath);
    } else if (statusCode.startsWith("D")) {
      result.deleted.push(filePath);
    } else if (statusCode.startsWith("M")) {
      result.modified.push(filePath);
    } else if (statusCode.startsWith("R")) {
      result.deleted.push(parts[1]);
      if (parts[2]?.startsWith("hooks/")) {
        result.added.push(parts[2]);
      }
    }
  }

  result.added.sort();
  result.deleted.sort();
  result.modified.sort();
  return result;
}

export function checkDeadHookPaths(
  settingsPath: string,
  homeDir: string,
): DeadHookPath[] {
  const dead: DeadHookPath[] = [];
  if (!tryExistsSync(settingsPath)) return dead;

  try {
    const raw = Deno.readTextFileSync(settingsPath);
    if (!raw.trim()) return dead;
    const data = JSON.parse(raw);
    if (!data.hooks || typeof data.hooks !== "object") return dead;

    for (const [eventName, bucket] of Object.entries(data.hooks)) {
      if (!Array.isArray(bucket)) continue;
      for (const entry of bucket) {
        if (!entry || !Array.isArray(entry.hooks)) continue;
        for (const hook of entry.hooks) {
          if (hook && typeof hook.command === "string") {
            const cmd = hook.command;
            const scriptToken = extractScriptPathFromCommand(cmd);
            if (scriptToken) {
              const resolved = resolveScriptPath(scriptToken, homeDir);
              if (!tryExistsSync(resolved)) {
                dead.push({
                  event: eventName,
                  command: cmd,
                  resolvedPath: resolved,
                });
              }
            }
          }
        }
      }
    }
  } catch {
    // Malformed JSON or read error: ignore or report as safe
  }

  return dead;
}

export function extractExpectedHooksFromInstaller(
  installerContent: string,
): Set<string> {
  const expected = new Set<string>();

  const sessionMatch = installerContent.match(/SESSION_START_HOOKS=\(([^)]+)\)/);
  if (sessionMatch) {
    for (const token of sessionMatch[1].trim().split(/\s+/)) {
      if (token.endsWith(".sh")) expected.add(token);
    }
  }

  const stopMatch = installerContent.match(/STOP_HOOKS=\(([^)]+)\)/);
  if (stopMatch) {
    for (const token of stopMatch[1].trim().split(/\s+/)) {
      if (token.endsWith(".sh")) expected.add(token);
    }
  }

  const preMatch = installerContent.match(/PRE_TOOL_USE_HOOKS=\(([\s\S]*?)\n\)/);
  if (preMatch) {
    const lines = preMatch[1].split("\n");
    for (const line of lines) {
      const clean = line.replace(/#.*$/, "").trim().replace(/^["']|["']$/g, "");
      const sep = clean.indexOf("::");
      if (sep !== -1) {
        const scriptName = clean.slice(sep + 2).trim();
        if (scriptName.endsWith(".sh")) expected.add(scriptName);
      }
    }
  }

  const postMatch = installerContent.match(
    /POST_TOOL_USE_HOOKS=\(([\s\S]*?)\n\)/,
  );
  if (postMatch) {
    const lines = postMatch[1].split("\n");
    for (const line of lines) {
      const clean = line.replace(/#.*$/, "").trim().replace(/^["']|["']$/g, "");
      const sep = clean.indexOf("::");
      if (sep !== -1) {
        const scriptName = clean.slice(sep + 2).trim();
        if (scriptName.endsWith(".sh")) expected.add(scriptName);
      }
    }
  }

  return expected;
}

export function getRegisteredHookBasenames(settingsPath: string): Set<string> {
  const registered = new Set<string>();
  if (!tryExistsSync(settingsPath)) return registered;

  try {
    const raw = Deno.readTextFileSync(settingsPath);
    if (!raw.trim()) return registered;
    const data = JSON.parse(raw);
    if (!data.hooks || typeof data.hooks !== "object") return registered;

    for (const bucket of Object.values(data.hooks)) {
      if (!Array.isArray(bucket)) continue;
      for (const entry of bucket) {
        if (!entry || !Array.isArray(entry.hooks)) continue;
        for (const hook of entry.hooks) {
          if (hook && typeof hook.command === "string") {
            const tokens = hook.command.trim().split(/\s+/);
            for (const token of tokens) {
              const base = path.basename(token);
              if (base.endsWith(".sh")) {
                registered.add(base);
              }
            }
          }
        }
      }
    }
  } catch {
    // Malformed JSON or read error
  }

  return registered;
}

export async function checkUnregisteredHooks(
  repoDir: string,
  remoteRef: string,
  settingsPath: string,
): Promise<string[]> {
  const expectedHooks = new Set<string>();

  // 1. Try to read scripts/install-hooks.sh from remoteRef, or fall back to local
  let installerContent = "";
  const gitShowInstaller = await runGit(
    ["show", `${remoteRef}:scripts/install-hooks.sh`],
    repoDir,
  );
  if (gitShowInstaller.success) {
    installerContent = gitShowInstaller.stdout;
  } else {
    const localInstaller = path.join(repoDir, "scripts/install-hooks.sh");
    if (tryExistsSync(localInstaller)) {
      installerContent = Deno.readTextFileSync(localInstaller);
    }
  }

  if (installerContent) {
    const fromInstaller = extractExpectedHooksFromInstaller(installerContent);
    for (const h of fromInstaller) expectedHooks.add(h);
  }

  // 2. Also check hooks on remoteRef (excluding agy-only hooks)
  const gitLsHooks = await runGit(
    ["ls-tree", "--name-only", remoteRef, "hooks/"],
    repoDir,
  );
  if (gitLsHooks.success) {
    for (const line of gitLsHooks.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.endsWith(".sh")) continue;
      const base = path.basename(trimmed);
      if (
        base.startsWith("agy-") ||
        base === "block-agy-gmail-send-delete.sh"
      ) {
        continue;
      }
      expectedHooks.add(base);
    }
  } else {
    // Fall back to local hooks dir if git ls-tree fails
    const localHooksDir = path.join(repoDir, "hooks");
    if (tryExistsSync(localHooksDir)) {
      for (const entry of Deno.readDirSync(localHooksDir)) {
        if (entry.isFile && entry.name.endsWith(".sh")) {
          if (
            entry.name.startsWith("agy-") ||
            entry.name === "block-agy-gmail-send-delete.sh"
          ) {
            continue;
          }
          expectedHooks.add(entry.name);
        }
      }
    }
  }

  const registered = getRegisteredHookBasenames(settingsPath);
  const unregistered: string[] = [];

  for (const expected of expectedHooks) {
    if (!registered.has(expected)) {
      unregistered.push(expected);
    }
  }

  unregistered.sort();
  return unregistered;
}

export async function detectDrift(
  options: DriftOptions = {},
): Promise<DriftResult> {
  const homeDir = options.homeDir ||
    Deno.env.get("CLAUDE_HOME") ||
    Deno.env.get("HOME") ||
    "/";

  const settingsPath = options.settingsPath ||
    Deno.env.get("CLAUDE_SETTINGS_PATH") ||
    path.join(homeDir, ".claude/settings.json");

  const repoDir = options.repoDir ||
    Deno.env.get("CLAUDE_HOOKS_REPO_DIR") ||
    Deno.env.get("WEB_JAM_TOOLS_DIR") ||
    path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "../..");

  const remoteRef = options.remoteRef ||
    Deno.env.get("HOOKS_REMOTE_REF") ||
    Deno.env.get("GIT_REMOTE_REF") ||
    "origin/dev";

  const remoteDiff = await checkRemoteDiff(repoDir, remoteRef);
  const deadHooks = checkDeadHookPaths(settingsPath, homeDir);
  const unregisteredHooks = await checkUnregisteredHooks(
    repoDir,
    remoteRef,
    settingsPath,
  );

  return {
    remoteDiff,
    deadHooks,
    unregisteredHooks,
  };
}

export function formatDriftMessage(result: DriftResult): string {
  const sections: string[] = [];

  if (
    result.remoteDiff.added.length > 0 ||
    result.remoteDiff.deleted.length > 0 ||
    result.remoteDiff.modified.length > 0
  ) {
    const diffLines: string[] = [
      "- Local checkout is behind origin/dev for hook files:",
    ];
    for (const file of result.remoteDiff.added) {
      diffLines.push(`  • Added on origin/dev: ${file}`);
    }
    for (const file of result.remoteDiff.deleted) {
      diffLines.push(`  • Deleted on origin/dev: ${file}`);
    }
    for (const file of result.remoteDiff.modified) {
      diffLines.push(`  • Modified on origin/dev: ${file}`);
    }
    sections.push(diffLines.join("\n"));
  }

  if (result.deadHooks.length > 0) {
    const deadLines: string[] = [
      "- Dead hook paths in settings.json (file does not exist):",
    ];
    for (const h of result.deadHooks) {
      deadLines.push(`  • ${h.event}: ${h.command}`);
    }
    sections.push(deadLines.join("\n"));
  }

  if (result.unregisteredHooks.length > 0) {
    const unregLines: string[] = [
      "- Hooks on origin/dev not registered in settings.json:",
    ];
    for (const h of result.unregisteredHooks) {
      unregLines.push(`  • ${h}`);
    }
    sections.push(unregLines.join("\n"));
  }

  if (sections.length === 0) return "";

  return [
    "WARNING: Installed Claude hooks drift detected:",
    ...sections,
    "Run 'git pull origin dev && bash scripts/install-hooks.sh' in ~/WebJamApps/web-jam-tools to update.",
  ].join("\n");
}

if (import.meta.main) {
  const result = await detectDrift();
  const message = formatDriftMessage(result);
  if (message) {
    console.log(JSON.stringify({ systemMessage: message }));
  }
}
