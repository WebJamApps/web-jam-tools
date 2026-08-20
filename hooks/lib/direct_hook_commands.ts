/**
 * direct_hook_commands.ts — web-jam-tools#683
 *
 * Resolves the set of hook scripts registered as direct commands in
 * scripts/install-hooks.sh across both execution surfaces:
 *
 * 1. Claude Code surface (settings.json):
 *    - SESSION_START_HOOKS (direct invocation: $HOME/.claude/hooks/<name>)
 *    - STOP_HOOKS (direct invocation: $HOME/.claude/hooks/<name>)
 *    - PRE_TOOL_USE_HOOKS (direct invocation: $HOME/.claude/hooks/<name>)
 *    - POST_TOOL_USE_HOOKS (direct invocation: $HOME/.claude/hooks/<name>)
 *
 * 2. agy / Antigravity surface (hooks.json):
 *    - Direct command invoked by agy: hooks/agy-hook-shim.sh (via agy_shim_arg)
 *
 * Deliberately excludes scripts invoked via `bash <path>` (such as the target hooks
 * wrapped by agy-hook-shim.sh: agy-model-guard.sh, block-agy-gmail-send-delete.sh),
 * as well as TypeScript modules (hooks/lib/*.ts) and data files (hooks/*.yaml),
 * which do not require the OS executable bit.
 */

import * as path from "jsr:@std/path@^1.0.0";

/**
 * Parse scripts/install-hooks.sh to extract the set of hook script basenames
 * that are registered as direct commands on either Claude Code or agy surfaces.
 */
export function extractDirectCommandHookScripts(
  installerContent: string,
): Set<string> {
  const directHooks = new Set<string>();

  // 1. Claude Code SessionStart hooks
  const sessionMatch = installerContent.match(
    /SESSION_START_HOOKS=\(([\s\S]*?)\)/,
  );
  if (sessionMatch) {
    for (const token of sessionMatch[1].trim().split(/\s+/)) {
      const clean = token.replace(/#.*$/, "").trim().replace(/^["']|["']$/g, "");
      if (clean.endsWith(".sh")) directHooks.add(clean);
    }
  }

  // 2. Claude Code Stop hooks
  const stopMatch = installerContent.match(/STOP_HOOKS=\(([\s\S]*?)\)/);
  if (stopMatch) {
    for (const token of stopMatch[1].trim().split(/\s+/)) {
      const clean = token.replace(/#.*$/, "").trim().replace(/^["']|["']$/g, "");
      if (clean.endsWith(".sh")) directHooks.add(clean);
    }
  }

  // 3. Claude Code PreToolUse hooks
  const preMatch = installerContent.match(
    /PRE_TOOL_USE_HOOKS=\(([\s\S]*?)\n\)/,
  );
  if (preMatch) {
    const lines = preMatch[1].split("\n");
    for (const line of lines) {
      const clean = line.replace(/#.*$/, "").trim().replace(/^["']|["']$/g, "");
      const sep = clean.indexOf("::");
      if (sep !== -1) {
        const scriptName = clean.slice(sep + 2).trim();
        if (scriptName.endsWith(".sh")) directHooks.add(scriptName);
      }
    }
  }

  // 4. Claude Code PostToolUse hooks
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
        if (scriptName.endsWith(".sh")) directHooks.add(scriptName);
      }
    }
  }

  // Deliberately not scanned: AGY_ONLY_PRE_TOOL_USE_HOOKS (agy-model-guard.sh,
  // block-agy-gmail-send-delete.sh). Both entries are wired only into the agy
  // surface via agy_shim_arg, which always invokes them as the shim's trailing
  // "$name" argument — never as a literal direct command — so they land in the
  // shim's own bash-invoked target list below, not this hook set. That is an
  // invariant of how agy_shim_arg builds its argument, not something this
  // parser checks; if a future entry in that array were ever wired as a direct
  // command instead, it would need to be added here explicitly.

  // 5. agy surface direct command: extract the wrapper executable from agy_shim_arg
  const shimMatch = installerContent.match(
    /agy_shim_arg\(\)\s*\{([\s\S]*?)\n\}/,
  );
  if (shimMatch) {
    // Look for $HOME/.claude/hooks/<name>.sh as the direct command token
    const matches = shimMatch[1].matchAll(
      /\$HOME\/\.claude\/hooks\/([a-zA-Z0-9_-]+\.sh)/g,
    );
    for (const m of matches) {
      const scriptName = m[1];
      // In agy_shim_arg, the first command is the shim executable (agy-hook-shim.sh)
      // and target hook is passed as argument ($name). Only the shim is a direct command.
      if (scriptName.startsWith("agy-hook-shim")) {
        directHooks.add(scriptName);
      }
    }
  }

  return directHooks;
}

/**
 * Query git index for tracked file modes in the hooks/ directory.
 * Returns a Map of hook filename (e.g. "agy-hook-shim.sh") -> git mode (e.g. "100755").
 */
export async function getGitTrackedModes(
  repoDir: string,
): Promise<Map<string, string>> {
  const cmd = new Deno.Command("git", {
    args: ["ls-files", "-s", "hooks/"],
    cwd: repoDir,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    throw new Error(
      `git ls-files failed: ${new TextDecoder().decode(output.stderr)}`,
    );
  }
  const stdout = new TextDecoder().decode(output.stdout);
  const modes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+[a-f0-9]+\s+\d+\t(.*)$/);
    if (match) {
      const mode = match[1];
      const filePath = match[2];
      const filename = path.basename(filePath);
      modes.set(filename, mode);
    }
  }
  return modes;
}
