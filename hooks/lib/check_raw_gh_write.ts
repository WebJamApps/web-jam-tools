/**
 * check_raw_gh_write.ts — web-jam-tools#685
 *
 * Identifies the four executed `gh` write verbs this repo gates behind guarded
 * `deno task` commands: `gh pr review`, `gh pr comment`, `gh issue comment`,
 * `gh issue edit`. Used by hooks/block-raw-gh-write.sh (PreToolUse, Bash
 * matcher) on both Claude Code and — via hooks/agy-hook-shim.sh, unmodified
 * — agy.
 *
 * The guarded `deno task` commands never contain any of these four literal
 * phrases in the Bash command text an agent asks to run (the raw `gh`
 * invocation happens INSIDE the Deno subprocess the task spawns, not as a
 * separate Bash tool call), so this hook never needs to special-case or
 * exempt them.
 */

import {
  ASSIGN_RE,
  MAX_WRAPPER_RECURSION_DEPTH,
  resolveThroughWrappers,
  splitOnOperators,
  splitShellTokens,
  stripHeredocs,
} from "./normalize_command.ts";

export interface VerbMatch {
  verb: string;
  guardedEquivalent: string;
}

export const VERB_PATTERNS: VerbMatch[] = [
  {
    verb: "gh pr review",
    guardedEquivalent: "deno task post-pr-review --repo <owner/repo> --pr <n> --body-file <path>",
  },
  {
    verb: "gh pr comment",
    guardedEquivalent: "deno task post-pr-comment --repo <owner/repo> --pr <n> --body-file <path>",
  },
  {
    verb: "gh issue comment",
    guardedEquivalent:
      "deno task post-issue-comment --repo <owner/repo> --issue <n> --body-file <path>",
  },
  {
    verb: "gh issue edit",
    guardedEquivalent:
      "deno task edit-issue --repo <owner/repo> --issue <n> [gh issue edit flags...]",
  },
];

/** Remove shell comments before their quotes or operators can affect parsing. */
function stripComments(cmd: string): string {
  let result = "";
  let quote = "";
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "\\" && quote !== "'") {
      result += ch + (cmd[++i] ?? "");
      continue;
    }
    // The shared tokenizer does not parse expansions inside double quotes or
    // backticks. Keep the legacy check for executable substitutions rather
    // than treating them as quoted prose. Single-quoted/escaped mentions stay data.
    if (quote !== "'" && (ch === "`" || (ch === "$" && cmd[i + 1] === "("))) {
      throw new Error("Unsupported command substitution");
    }
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /[\s;&|()<>]/.test(cmd[i - 1]))) {
      while (i < cmd.length && cmd[i] !== "\n") i++;
      if (i === cmd.length) break;
      result += "\n";
      continue;
    }
    result += ch;
  }
  return result;
}

function commandVerbs(cmd: string, depth = 0): Set<string> {
  if (depth > MAX_WRAPPER_RECURSION_DEPTH) throw new Error("Wrapper recursion cap exceeded");
  const { segments, unterminated } = splitOnOperators(stripComments(stripHeredocs(cmd)));
  if (unterminated) throw new Error("Unterminated quote");

  const verbs = new Set<string>();
  for (const segment of segments) {
    const tokens = splitShellTokens(segment);
    // These shell keywords introduce another command, rather than consume argv as data.
    while (["if", "then", "else", "elif", "while", "until", "do", "!"].includes(tokens[0])) {
      tokens.shift();
    }
    const resolved = resolveThroughWrappers(tokens);
    if (resolved.kind === "cap-exceeded") throw new Error("Wrapper iteration cap exceeded");
    if (resolved.kind === "nested") {
      for (const verb of commandVerbs(resolved.command, depth + 1)) verbs.add(verb);
      continue;
    }
    const argv = resolved.argv;
    let i = 0;
    while (i < argv.length && ASSIGN_RE.test(argv[i])) i++;
    if (argv[i]?.split("/").pop() === "gh") {
      verbs.add(["gh", argv[i + 1], argv[i + 2]].join(" "));
    }
  }
  return verbs;
}

/** Returns the deny message if `cmd` invokes a raw gated verb, else null. */
export function checkRawGhWrite(cmd: string): string | null {
  let verbs: Set<string> | null;
  try {
    verbs = commandVerbs(cmd);
  } catch {
    // Preserve the original raw check when the shared parser cannot judge the command.
    verbs = null;
  }
  for (const { verb, guardedEquivalent } of VERB_PATTERNS) {
    const re = new RegExp(`\\b${verb.replace(/ /g, "\\s+")}\\b`);
    if (verbs ? verbs.has(verb) : re.test(cmd)) {
      return [
        `BLOCKED (raw gh write guard): \`${verb}\` is denied.`,
        "The four GitHub write verbs this repo gates (gh pr review, gh pr comment, gh issue " +
        "comment, gh issue edit) are only reachable through their guarded `deno task` " +
        "commands, so a dispatched subagent — with no human present to answer a permission " +
        "prompt — completes its own write instead of dead-ending (web-jam-tools#685).",
        `Use instead: ${guardedEquivalent}`,
      ].join("\n");
    }
  }
  return null;
}

if (import.meta.main) {
  const raw = Deno.env.get("CMD_FOR_PY") || Deno.args[0] || "";
  const message = checkRawGhWrite(raw);
  if (message) {
    console.log(message);
  }
}
