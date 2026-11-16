/**
 * PreToolUse guard (Bash): refuse a git command that would change the
 * web-jam-tools canonical clone's checkout or history, on Claude Code and Codex
 * (draft-pr design 1.2.0, "Lanes never change the canonical clone", web-jam-tools#1819).
 *
 * Workflow guard: when the command or working directory cannot be read, it
 * allows the call and emits `additionalContext` saying so (the git-level
 * `reference-transaction` hook still applies underneath).
 */

import * as path from "jsr:@std/path@^1.0.0";
import {
  ASSIGN_RE,
  commandPartsInFolders,
  MAX_WRAPPER_RECURSION_DEPTH,
  resolveCommandPath,
  resolveThroughWrappers,
  splitOnOperators,
  splitShellTokens,
  stripHeredocs,
} from "./normalize_command.ts";

export const DEFAULT_CANONICAL_CLONE = "/home/joshua/WebJamApps/web-jam-tools";

const REFUSED_GIT_SUBCOMMANDS = new Set([
  "switch",
  "commit",
  "merge",
  "cherry-pick",
  "rebase",
  "reset",
  "revert",
  "am",
  "stash",
]);

const GIT_GLOBAL_OPTS_WITH_VALUE = new Set([
  "-c",
  "--namespace",
  "--config-env",
  "--exec-path",
  "--attr-source",
  "--shallow-file",
]);

const GIT_GLOBAL_OPTS_WITH_EQUALS = [
  "-c=",
  "--namespace=",
  "--config-env=",
  "--exec-path=",
  "--attr-source=",
  "--shallow-file=",
];

const GIT_GLOBAL_OPTS_NO_VALUE = new Set([
  "-p",
  "--paginate",
  "-P",
  "--no-pager",
  "--no-replace-objects",
  "--no-lazy-fetch",
  "--no-optional-locks",
  "--no-advice",
  "--bare",
  "--literal-pathspecs",
  "--no-literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
]);

const GIT_CHECKOUT_VALUE_FLAGS = new Set([
  "-b",
  "-B",
  "--orphan",
  "--conflict",
  "-U",
  "--unified",
  "--inter-hunk-context",
  "--pathspec-from-file",
]);

const GIT_CHECKOUT_REFUSE_FLAGS = new Set([
  "-b",
  "-B",
  "--orphan",
  "--detach",
]);

const GIT_PULL_VALUE_FLAGS = new Set([
  "-s",
  "--strategy",
  "-X",
  "--strategy-option",
  "-o",
  "--server-option",
  "--upload-pack",
  "--depth",
  "--deepen",
  "--shallow-since",
  "--shallow-exclude",
  "--negotiation-tip",
  "-j",
  "--jobs",
  "--cleanup",
  "--recurse-submodules",
]);

export type CanonicalCloneCheckResult =
  | { outcome: "allow" }
  | { outcome: "allow-with-note"; note: string }
  | { outcome: "refuse"; message: string; command: string; folder: string };

export interface CheckOptions {
  home?: string;
  canonicalCloneDir?: string;
}

export function getCanonicalCloneDirs(home: string, override?: string): string[] {
  if (override) return [path.resolve(override)];
  const envOverride = Deno.env.get("CANONICAL_CLONE_DIR");
  if (envOverride) return [path.resolve(envOverride)];
  const dirs = new Set<string>([
    path.resolve(path.join(home, "WebJamApps/web-jam-tools")),
    DEFAULT_CANONICAL_CLONE,
  ]);
  return [...dirs];
}

export function isCanonicalCloneFolder(folder: string, canonicalDirs: string[]): string | null {
  const resolved = path.resolve(folder);
  for (const canonical of canonicalDirs) {
    if (resolved === canonical) return canonical;
    const worktreesPrefix = `${canonical}/.claude/worktrees`;
    if (
      resolved.startsWith(`${canonical}/`) &&
      resolved !== worktreesPrefix &&
      !resolved.startsWith(`${worktreesPrefix}/`)
    ) {
      return canonical;
    }
  }
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function formatRefusalMessage(command: string, folder: string): string {
  return [
    `BLOCKED (block-canonical-clone-change): refusing \`git ${command}\` in the canonical web-jam-tools clone (${folder}).`,
    "The canonical clone stays on dev at origin/dev; lanes must work in their own worktree via scripts/new-agent-worktree.sh.",
    "This guard is working as designed. Stop, and do not make the same change through another tool or command; report `block-canonical-clone-change` and this message, and if Josh already asked for this, say so so he can switch it off.",
  ].join("\n");
}

function formatNoteMessage(reason: string): string {
  return `canonical-clone guard: ${reason}; proceeding. Verify no git command changes ${DEFAULT_CANONICAL_CLONE} (git's reference-transaction hook still applies).`;
}

function isCheckoutOfBranchOrCommit(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      return false;
    }
    if (GIT_CHECKOUT_REFUSE_FLAGS.has(arg)) {
      return true;
    }
    if (arg.startsWith("-b") || arg.startsWith("-B") || arg.startsWith("--orphan=")) {
      return true;
    }
    if (arg.startsWith("-")) {
      if (!arg.includes("=") && GIT_CHECKOUT_VALUE_FLAGS.has(arg)) {
        i++;
      }
      continue;
    }
    return true;
  }
  return false;
}

function isPullOfNonDev(args: string[]): boolean {
  const positionals: string[] = [];
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!afterDoubleDash) {
      if (arg === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (arg.startsWith("-")) {
        if (!arg.includes("=") && GIT_PULL_VALUE_FLAGS.has(arg)) {
          i++;
        }
        continue;
      }
    }
    positionals.push(arg);
  }
  if (positionals.length === 0) return false;
  if (positionals.length === 1) {
    return !["origin", "dev", "refs/heads/dev"].includes(positionals[0]);
  }
  if (positionals.length === 2) {
    const [remote, refspec] = positionals;
    if (remote !== "origin") return true;
    return !["dev", "refs/heads/dev", "dev:dev", "dev:refs/heads/dev"].includes(refspec);
  }
  return true;
}

function isRefusedGitSubcommand(subcommand: string, subArgs: string[]): boolean {
  if (REFUSED_GIT_SUBCOMMANDS.has(subcommand)) return true;
  if (subcommand === "checkout") return isCheckoutOfBranchOrCommit(subArgs);
  if (subcommand === "pull") return isPullOfNonDev(subArgs);
  return false;
}

/** Extract `env -C <dir>` / `--chdir=<dir>` overrides ahead of wrapper peeling. */
function applyEnvChdir(tokens: string[], cwd: string | null, home: string): string | null {
  let i = 0;
  while (i < tokens.length && ASSIGN_RE.test(tokens[i])) i++;
  if (i >= tokens.length) return cwd;
  const name = tokens[i].split("/").pop();
  if (name !== "env") return cwd;
  let current = cwd;
  for (let j = i + 1; j < tokens.length; j++) {
    const tok = tokens[j];
    if (tok === "--") break;
    if (!tok.startsWith("-")) break;
    if (tok === "-C" || tok === "--chdir") {
      current = tokens[j + 1] ? resolveCommandPath(tokens[j + 1], current, home) : null;
      j++;
      continue;
    }
    if (tok.startsWith("--chdir=")) {
      current = resolveCommandPath(tok.slice("--chdir=".length), current, home);
      continue;
    }
    if (["-u", "--unset", "-S", "--split-string", "--argv0"].includes(tok)) {
      j++;
    }
  }
  return current;
}

function evaluateGitInvocation(
  argv: string[],
  partCwd: string | null,
  canonicalDirs: string[],
  home: string,
): CanonicalCloneCheckResult {
  let effectiveDir = partCwd;
  let unrecognisedOption = false;
  let subcommand: string | null = null;
  let subArgs: string[] = [];

  for (let idx = 1; idx < argv.length; idx++) {
    const tok = argv[idx];
    if (tok === "-C") {
      const dirArg = argv[idx + 1];
      if (dirArg === undefined) break;
      effectiveDir = resolveCommandPath(dirArg, effectiveDir, home);
      idx++;
      continue;
    }
    if (tok.startsWith("-C") && tok.length > 2) {
      effectiveDir = resolveCommandPath(tok.slice(2), effectiveDir, home);
      continue;
    }
    if (tok === "--work-tree" || tok.startsWith("--work-tree=")) {
      const val = tok === "--work-tree" ? argv[++idx] : tok.slice("--work-tree=".length);
      const resolved = val !== undefined ? resolveCommandPath(val, effectiveDir, home) : null;
      if (resolved === null || isCanonicalCloneFolder(resolved, canonicalDirs)) {
        effectiveDir = resolved;
      }
      continue;
    }
    if (tok === "--git-dir" || tok.startsWith("--git-dir=")) {
      const val = tok === "--git-dir" ? argv[++idx] : tok.slice("--git-dir=".length);
      const resolved = val !== undefined ? resolveCommandPath(val, effectiveDir, home) : null;
      if (resolved === null) {
        effectiveDir = null;
      } else {
        const parent = path.dirname(resolved);
        if (path.basename(resolved) === ".git" && isCanonicalCloneFolder(parent, canonicalDirs)) {
          effectiveDir = parent;
        }
      }
      continue;
    }
    if (tok === "--version" || tok === "-v" || tok === "--help" || tok === "-h") {
      return { outcome: "allow" };
    }
    if (GIT_GLOBAL_OPTS_WITH_VALUE.has(tok)) {
      idx++;
      continue;
    }
    if (
      GIT_GLOBAL_OPTS_NO_VALUE.has(tok) ||
      GIT_GLOBAL_OPTS_WITH_EQUALS.some((prefix) => tok.startsWith(prefix))
    ) {
      continue;
    }
    if (tok.startsWith("-")) {
      unrecognisedOption = true;
      break;
    }
    subcommand = tok;
    subArgs = argv.slice(idx + 1);
    break;
  }

  const matchedCanonical = effectiveDir !== null
    ? isCanonicalCloneFolder(effectiveDir, canonicalDirs)
    : null;

  if (unrecognisedOption) {
    if (effectiveDir === null || matchedCanonical !== null) {
      return { outcome: "allow-with-note", note: "the command could not be read" };
    }
    return { outcome: "allow" };
  }

  if (!subcommand) {
    return { outcome: "allow" };
  }

  if (/[$`]/.test(subcommand)) {
    if (effectiveDir === null || matchedCanonical !== null) {
      return { outcome: "allow-with-note", note: "the command could not be read" };
    }
    return { outcome: "allow" };
  }

  if (!isRefusedGitSubcommand(subcommand, subArgs)) {
    return { outcome: "allow" };
  }

  if (effectiveDir === null) {
    return {
      outcome: "allow-with-note",
      note: "the folder the command runs in could not be determined",
    };
  }

  if (matchedCanonical !== null) {
    return {
      outcome: "refuse",
      command: subcommand,
      folder: matchedCanonical,
      message: formatRefusalMessage(subcommand, matchedCanonical),
    };
  }

  return { outcome: "allow" };
}

export function checkCanonicalCloneCommand(
  command: string,
  initialCwd: string | null,
  options: CheckOptions = {},
  depth = 0,
): CanonicalCloneCheckResult {
  if (!command.trim()) return { outcome: "allow" };
  if (depth > MAX_WRAPPER_RECURSION_DEPTH) {
    return { outcome: "allow-with-note", note: "the command could not be read" };
  }

  const home = options.home ?? Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ??
    "/home/joshua";
  const canonicalDirs = getCanonicalCloneDirs(home, options.canonicalCloneDir);

  let stripped: string;
  try {
    stripped = stripHeredocs(command);
  } catch {
    return { outcome: "allow-with-note", note: "the command could not be read" };
  }
  const { unterminated } = splitOnOperators(stripped);
  if (unterminated) {
    return { outcome: "allow-with-note", note: "the command could not be read" };
  }

  const notes: string[] = [];
  for (const part of commandPartsInFolders(command, initialCwd, home)) {
    if (part.script) continue;
    const tokens = splitShellTokens(part.text).filter((t) => t !== "{" && t !== "}");
    while (["if", "then", "else", "elif", "while", "until", "do", "!"].includes(tokens[0])) {
      tokens.shift();
    }
    if (tokens.length === 0) continue;

    const partCwd = applyEnvChdir(tokens, part.cwd, home);
    const resolved = resolveThroughWrappers(tokens);
    if (resolved.kind === "cap-exceeded") {
      notes.push("the command could not be read");
      continue;
    }
    if (resolved.kind === "nested") {
      const nested = checkCanonicalCloneCommand(resolved.command, partCwd, options, depth + 1);
      if (nested.outcome === "refuse") return nested;
      if (nested.outcome === "allow-with-note") notes.push(nested.note);
      continue;
    }

    const argv = resolved.argv;
    let i = 0;
    while (i < argv.length && ASSIGN_RE.test(argv[i])) i++;
    if (i >= argv.length) continue;

    const cmdToken = argv[i];
    if (/[$`]/.test(cmdToken)) {
      notes.push("the command could not be read");
      continue;
    }
    const cmdName = cmdToken.split("/").pop() ?? "";
    if (cmdName !== "git") continue;

    const verdict = evaluateGitInvocation(argv.slice(i), partCwd, canonicalDirs, home);
    if (verdict.outcome === "refuse") return verdict;
    if (verdict.outcome === "allow-with-note") notes.push(verdict.note);
  }

  if (notes.length > 0) {
    return { outcome: "allow-with-note", note: [...new Set(notes)].join("; ") };
  }
  return { outcome: "allow" };
}

export function evaluatePayload(
  rawInput: string,
  options: CheckOptions = {},
): CanonicalCloneCheckResult {
  if (!rawInput.trim()) return { outcome: "allow" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    return { outcome: "allow-with-note", note: "the hook payload could not be parsed" };
  }

  const data = record(parsed);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { outcome: "allow-with-note", note: "the hook payload could not be parsed" };
  }

  const toolName = typeof data.tool_name === "string" ? data.tool_name.trim() : "";
  if (toolName && toolName.toLowerCase() !== "bash") {
    return { outcome: "allow" };
  }

  const toolInput = record(data.tool_input ?? data.input ?? data.arguments);
  const rawCommand = toolInput.command ?? data.command;
  if (rawCommand === undefined) {
    return { outcome: "allow" };
  }
  if (typeof rawCommand !== "string") {
    return { outcome: "allow-with-note", note: "the command could not be read" };
  }

  const baseCwd = typeof data.cwd === "string" && path.isAbsolute(data.cwd)
    ? path.resolve(data.cwd)
    : null;
  const explicitDir = toolInput.cwd ?? toolInput.workdir ?? data.workdir;
  let initialCwd: string | null = baseCwd;
  if (explicitDir !== undefined) {
    if (typeof explicitDir !== "string" || !explicitDir.trim()) {
      initialCwd = null;
    } else {
      const trimmed = explicitDir.trim();
      if (path.isAbsolute(trimmed)) {
        initialCwd = path.resolve(trimmed);
      } else if (baseCwd) {
        initialCwd = path.resolve(baseCwd, trimmed);
      } else {
        initialCwd = null;
      }
    }
  }

  return checkCanonicalCloneCommand(rawCommand, initialCwd, options);
}

if (import.meta.main) {
  const rawInput = await new Response(Deno.stdin.readable).text();
  const result = evaluatePayload(rawInput);
  if (result.outcome === "refuse") {
    console.error(result.message);
    Deno.exit(2);
  }
  if (result.outcome === "allow-with-note") {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: formatNoteMessage(result.note),
      },
    }));
  }
  Deno.exit(0);
}
