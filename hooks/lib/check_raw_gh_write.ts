/**
 * check_raw_gh_write.ts — web-jam-tools#685
 *
 * Matches the four raw `gh` write verbs this repo gates behind guarded
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
    guardedEquivalent: "deno task post-issue-comment --repo <owner/repo> --issue <n> --body-file <path>",
  },
  {
    verb: "gh issue edit",
    guardedEquivalent: "deno task edit-issue --repo <owner/repo> --issue <n> [gh issue edit flags...]",
  },
];

/** Returns the deny message if `cmd` invokes a raw gated verb, else null. */
export function checkRawGhWrite(cmd: string): string | null {
  for (const { verb, guardedEquivalent } of VERB_PATTERNS) {
    const re = new RegExp(`\\b${verb.replace(/ /g, "\\s+")}\\b`);
    if (re.test(cmd)) {
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
