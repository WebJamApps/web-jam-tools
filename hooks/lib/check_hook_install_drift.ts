/**
 * check_hook_install_drift.ts — web-jam-tools#664, extended for the agy/
 * Antigravity surface in web-jam-tools#674 (Josh, 2026-08-19: anything
 * hook/skill-related must be valid for BOTH agy and Claude Code).
 *
 * Claude Code checks (unchanged from the original PR):
 * 1. Local web-jam-tools checkout vs origin/dev for hook files added, deleted, or modified.
 * 2. settings.json entries whose hook command points at a non-existent path.
 * 3. Hook files present on origin/dev that settings.json does not register.
 *
 * agy/Antigravity checks (added):
 * 4. $HOME/.gemini/config/hooks.json entries whose agy-hook-shim.sh wrapper,
 *    OR the target hook it ultimately wraps, points at a non-existent path
 *    (including a dangling symlink, since existence is checked by following
 *    it — see tryExistsSync).
 * 5. Hook files expected on that surface (scripts/install-hooks.sh's
 *    PRE_TOOL_USE_HOOKS + AGY_ONLY_PRE_TOOL_USE_HOOKS + POST_TOOL_USE_HOOKS —
 *    SessionStart/Stop are deliberately never registered there, see
 *    --forbid-lifecycle-hooks / web-jam-tools#432 finding 9) that
 *    $HOME/.gemini/config/hooks.json does not register at all — including
 *    the case where that file doesn't exist yet, which is reported
 *    explicitly rather than silently treated as "no drift" (a check that
 *    never actually inspected a surface must say so, not report all-clear).
 *
 * Check 1 (file staleness) is a single, surface-agnostic condition: both
 * hooks/hook-install-drift-reminder.sh's own symlink under
 * $HOME/.claude/hooks/ AND agy's shimmed registrations run scripts out of
 * this SAME repo checkout, so a stale checkout is stale for both surfaces at
 * once — formatDriftMessage says so rather than running the git diff twice.
 *
 * Neither check 4 nor check 5 can verify that a correctly-registered agy
 * hook actually FIRES: web-jam-tools#432 established that agy ignores its
 * own PreToolUse "matcher" field and does not honour either Claude veto
 * mechanism, so a hook registered there with a valid path can still be a
 * no-op at runtime. formatDriftMessage attaches an explicit caveat to that
 * effect whenever it has anything to report about the agy surface, so a
 * "registration looks fine" result is never misread as "agy hooks are
 * enforcing."
 *
 * Read-only: never writes to git, settings.json, or agy's hooks.json, and
 * never prints either file's contents.
 * Outputs SessionStart JSON {"systemMessage": "..."} when drift is detected; otherwise silent.
 */

import * as path from "jsr:@std/path@^1.0.0";

export interface DriftOptions {
  settingsPath?: string;
  repoDir?: string;
  remoteRef?: string;
  homeDir?: string;
  agyHooksPath?: string;
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

export interface AgyDriftResult {
  configPath: string;
  configFound: boolean;
  deadHooks: DeadHookPath[];
  unregisteredHooks: string[];
}

export interface DriftResult {
  remoteDiff: RemoteHookDiff;
  deadHooks: DeadHookPath[];
  unregisteredHooks: string[];
  agy: AgyDriftResult;
  // web-jam-tools#691: the statusLine surface is checked separately from
  // deadHooks/unregisteredHooks above (it is not a hooks.<Event>[] bucket) —
  // see checkStatusLineDeadPath/checkStatusLineUnregistered.
  statusLineDead: DeadHookPath[];
  statusLineUnregistered: boolean;
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
  // Inline multi-statement bash hooks (e.g. `M="$HOME/..."; T=$(date ...); ...`)
  // have a first token that is a variable assignment or shell keyword, not a
  // script invocation — only a token that actually names a `.sh` file is a
  // hook script path worth dead-path checking.
  if (!firstToken.endsWith(".sh")) return "";
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

// --- Status-line surface (web-jam-tools#688, web-jam-tools#691) ---
//
// settings.json's "statusLine" key is a single { type, command } object, not
// a hooks.<Event>[].hooks[] bucket, so it needs its own dead-path check
// rather than reusing checkDeadHookPaths — but it reuses the SAME
// extractScriptPathFromCommand/resolveScriptPath helpers, since the value
// shape (a bare path ending in .sh) is identical.

export function checkStatusLineDeadPath(
  settingsPath: string,
  homeDir: string,
): DeadHookPath[] {
  const dead: DeadHookPath[] = [];
  if (!tryExistsSync(settingsPath)) return dead;

  try {
    const raw = Deno.readTextFileSync(settingsPath);
    if (!raw.trim()) return dead;
    const data = JSON.parse(raw);
    if (!data.statusLine || typeof data.statusLine !== "object") return dead;
    const cmd = data.statusLine.command;
    if (typeof cmd !== "string") return dead;

    const scriptToken = extractScriptPathFromCommand(cmd);
    if (scriptToken) {
      const resolved = resolveScriptPath(scriptToken, homeDir);
      if (!tryExistsSync(resolved)) {
        dead.push({ event: "statusLine", command: cmd, resolvedPath: resolved });
      }
    }
  } catch {
    // Malformed JSON or read error: ignore or report as safe
  }

  return dead;
}

// Mirrors checkUnregisteredHooks below, but for the single statusLine entry:
// true when scripts/statusline.sh exists on remoteRef (or locally, as a
// fallback) but settings.json has no statusLine.command registered at all.
export async function checkStatusLineUnregistered(
  repoDir: string,
  remoteRef: string,
  settingsPath: string,
): Promise<boolean> {
  let statusLineScriptExists = false;
  const gitShowStatusLine = await runGit(
    ["cat-file", "-e", `${remoteRef}:scripts/statusline.sh`],
    repoDir,
  );
  if (gitShowStatusLine.success) {
    statusLineScriptExists = true;
  } else {
    statusLineScriptExists = tryExistsSync(
      path.join(repoDir, "scripts/statusline.sh"),
    );
  }
  if (!statusLineScriptExists) return false;

  if (!tryExistsSync(settingsPath)) return true;
  try {
    const raw = Deno.readTextFileSync(settingsPath);
    if (!raw.trim()) return true;
    const data = JSON.parse(raw);
    return !(data.statusLine && typeof data.statusLine.command === "string" &&
      data.statusLine.command.trim() !== "");
  } catch {
    return true;
  }
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

// --- agy/Antigravity surface (web-jam-tools#674) ---
//
// agy's $HOME/.gemini/config/hooks.json has the same {hooks: {PreToolUse:
// [...], PostToolUse: [...]}} shape as Claude's settings.json, but every
// command is wrapped by scripts/install-hooks.sh's agy_shim_arg() as:
//   $HOME/.claude/hooks/agy-hook-shim.sh <event> <base64-matcher> $HOME/.claude/hooks/<name>.sh
// — the FIRST token is the shim, the LAST token is the actual target hook.
// Both live in the same $HOME/.claude/hooks/ directory as the Claude Code
// symlinks (there is no separate agy hooks directory), so resolution reuses
// resolveScriptPath/tryExistsSync exactly as the Claude Code check does.

export function checkAgyDeadHookPaths(
  agyHooksPath: string,
  homeDir: string,
): DeadHookPath[] {
  const dead: DeadHookPath[] = [];
  if (!tryExistsSync(agyHooksPath)) return dead;

  try {
    const raw = Deno.readTextFileSync(agyHooksPath);
    if (!raw.trim()) return dead;
    const data = JSON.parse(raw);
    if (!data.hooks || typeof data.hooks !== "object") return dead;

    for (const [eventName, bucket] of Object.entries(data.hooks)) {
      if (!Array.isArray(bucket)) continue;
      for (const entry of bucket) {
        if (!entry || !Array.isArray(entry.hooks)) continue;
        for (const hook of entry.hooks) {
          if (!hook || typeof hook.command !== "string") continue;
          const cmd = hook.command;
          const tokens = cmd.trim().split(/\s+/).filter(Boolean);
          if (tokens.length === 0) continue;
          const shimToken = tokens[0];
          const targetToken = tokens[tokens.length - 1];

          const shimResolved = resolveScriptPath(shimToken, homeDir);
          if (!tryExistsSync(shimResolved)) {
            dead.push({
              event: `${eventName} [agy shim]`,
              command: cmd,
              resolvedPath: shimResolved,
            });
          }

          if (targetToken !== shimToken) {
            const targetResolved = resolveScriptPath(targetToken, homeDir);
            if (!tryExistsSync(targetResolved)) {
              dead.push({
                event: `${eventName} [agy target]`,
                command: cmd,
                resolvedPath: targetResolved,
              });
            }
          }
        }
      }
    }
  } catch {
    // Malformed JSON or read error: ignore
  }

  return dead;
}

export function extractExpectedAgyHooksFromInstaller(
  installerContent: string,
): Set<string> {
  const expected = new Set<string>();

  // Same-event coverage as install-hooks.sh's merge_agy_pre_tool_use_args /
  // merge_agy_post_tool_use_args: PRE_TOOL_USE_HOOKS + AGY_ONLY_PRE_TOOL_USE_HOOKS
  // + POST_TOOL_USE_HOOKS. SESSION_START_HOOKS/STOP_HOOKS are intentionally
  // excluded — agy's hooks.json never gets a SessionStart or Stop entry
  // (--forbid-lifecycle-hooks, web-jam-tools#432 finding 9).
  const arrayNames = [
    "PRE_TOOL_USE_HOOKS",
    "AGY_ONLY_PRE_TOOL_USE_HOOKS",
    "POST_TOOL_USE_HOOKS",
  ];

  for (const arrayName of arrayNames) {
    const re = new RegExp(`${arrayName}=\\(([\\s\\S]*?)\\n\\)`);
    const m = installerContent.match(re);
    if (!m) continue;
    for (const line of m[1].split("\n")) {
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

export function getRegisteredAgyHookBasenames(agyHooksPath: string): Set<string> {
  const registered = new Set<string>();
  if (!tryExistsSync(agyHooksPath)) return registered;

  try {
    const raw = Deno.readTextFileSync(agyHooksPath);
    if (!raw.trim()) return registered;
    const data = JSON.parse(raw);
    if (!data.hooks || typeof data.hooks !== "object") return registered;

    for (const bucket of Object.values(data.hooks)) {
      if (!Array.isArray(bucket)) continue;
      for (const entry of bucket) {
        if (!entry || !Array.isArray(entry.hooks)) continue;
        for (const hook of entry.hooks) {
          if (hook && typeof hook.command === "string") {
            const tokens = hook.command.trim().split(/\s+/).filter(Boolean);
            if (tokens.length === 0) continue;
            // Identity is the TARGET hook (last token) — the shim
            // (first token) is the same file for every entry and never the
            // thing being registered.
            const last = tokens[tokens.length - 1];
            const base = path.basename(last);
            if (base.endsWith(".sh")) {
              registered.add(base);
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

export async function checkAgyUnregisteredHooks(
  repoDir: string,
  remoteRef: string,
  agyHooksPath: string,
): Promise<string[]> {
  const expectedHooks = new Set<string>();

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
    for (const h of extractExpectedAgyHooksFromInstaller(installerContent)) {
      expectedHooks.add(h);
    }
  }

  const registered = getRegisteredAgyHookBasenames(agyHooksPath);
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

  const agyHooksPath = options.agyHooksPath ||
    Deno.env.get("AGY_HOOKS_PATH") ||
    path.join(homeDir, ".gemini/config/hooks.json");

  const remoteDiff = await checkRemoteDiff(repoDir, remoteRef);
  const deadHooks = checkDeadHookPaths(settingsPath, homeDir);
  const unregisteredHooks = await checkUnregisteredHooks(
    repoDir,
    remoteRef,
    settingsPath,
  );
  const statusLineDead = checkStatusLineDeadPath(settingsPath, homeDir);
  const statusLineUnregistered = await checkStatusLineUnregistered(
    repoDir,
    remoteRef,
    settingsPath,
  );

  const agyConfigFound = tryExistsSync(agyHooksPath);
  const agyDeadHooks = checkAgyDeadHookPaths(agyHooksPath, homeDir);
  const agyUnregisteredHooks = await checkAgyUnregisteredHooks(
    repoDir,
    remoteRef,
    agyHooksPath,
  );

  return {
    remoteDiff,
    deadHooks,
    unregisteredHooks,
    statusLineDead,
    statusLineUnregistered,
    agy: {
      configPath: agyHooksPath,
      configFound: agyConfigFound,
      deadHooks: agyDeadHooks,
      unregisteredHooks: agyUnregisteredHooks,
    },
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
      "- Local checkout is behind origin/dev for hook files (affects BOTH surfaces — " +
      "Claude Code's symlinked hooks and agy/Antigravity's shimmed hooks run scripts " +
      "out of this same checkout):",
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

  // --- Status-line surface (web-jam-tools#691) ---
  if (result.statusLineDead.length > 0) {
    const dead = result.statusLineDead[0];
    sections.push(
      `- Dead statusLine path in settings.json (file does not exist): ${dead.command}`,
    );
  }

  if (result.statusLineUnregistered) {
    sections.push(
      "- scripts/statusline.sh exists on origin/dev but settings.json has no " +
        "statusLine registered.",
    );
  }

  // --- agy/Antigravity surface (web-jam-tools#674) ---
  const agyLines: string[] = [];

  if (!result.agy.configFound) {
    agyLines.push(
      `- agy hooks.json not found at ${result.agy.configPath} — the agy/Antigravity ` +
        "install step (scripts/install-hooks.sh) has not been run on this machine, " +
        "or agy is not set up here, so every hook this repo expects on that surface " +
        "is effectively unregistered there. This is reported explicitly rather than " +
        "as silence, because a surface that was never inspected must never be reported clean.",
    );
  } else {
    if (result.agy.deadHooks.length > 0) {
      agyLines.push(
        "- Dead hook paths in agy hooks.json (shim or target file does not exist):",
      );
      for (const h of result.agy.deadHooks) {
        agyLines.push(`  • ${h.event}: ${h.command}`);
      }
    }

    if (result.agy.unregisteredHooks.length > 0) {
      agyLines.push(
        "- Hooks on origin/dev not registered in agy hooks.json:",
      );
      for (const h of result.agy.unregisteredHooks) {
        agyLines.push(`  • ${h}`);
      }
    }
  }

  if (agyLines.length > 0) {
    agyLines.push(
      "- Note (web-jam-tools#432): agy does not currently enforce hooks at runtime " +
        "even when hooks.json is fully and correctly registered — a Stop/SessionStart " +
        "entry silently disables its ENTIRE hooks config, and PreToolUse verdicts are " +
        "not honoured the way Claude Code honours them. This check verifies agy's " +
        "registration/file state only; it cannot verify that a correctly-registered " +
        "agy hook actually fires.",
    );
    sections.push(agyLines.join("\n"));
  }

  if (sections.length === 0) return "";

  return [
    "WARNING: Installed hooks drift detected (Claude Code and/or agy/Antigravity):",
    ...sections,
    "Run 'git pull origin dev && bash scripts/install-hooks.sh' in ~/WebJamApps/web-jam-tools " +
    "to update — it merges both settings.json and agy's hooks.json.",
  ].join("\n");
}

if (import.meta.main) {
  const result = await detectDrift();
  const message = formatDriftMessage(result);
  if (message) {
    console.log(JSON.stringify({ systemMessage: message }));
  }
}
