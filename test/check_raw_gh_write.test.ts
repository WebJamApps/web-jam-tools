// check_raw_gh_write.test.ts — web-jam-tools#685

import { assertEquals } from "@std/assert";
import { checkRawGhWrite, VERB_PATTERNS } from "../hooks/lib/check_raw_gh_write.ts";

Deno.test("checkRawGhWrite denies a raw `gh pr review` and names the guarded equivalent", () => {
  const message = checkRawGhWrite(
    "gh pr review WebJamApps/JaMmusic#1324 --comment --body-file /tmp/r.md",
  );
  assertEquals(message !== null, true);
  assertEquals(message!.includes("deno task post-pr-review"), true);
});

Deno.test("checkRawGhWrite denies a raw `gh pr comment`", () => {
  const message = checkRawGhWrite("gh pr comment 42 --body-file /tmp/c.md");
  assertEquals(message !== null, true);
  assertEquals(message!.includes("deno task post-pr-comment"), true);
});

Deno.test("checkRawGhWrite denies a raw `gh issue comment`", () => {
  const message = checkRawGhWrite("gh issue comment 685 --body-file /tmp/c.md");
  assertEquals(message !== null, true);
  assertEquals(message!.includes("deno task post-issue-comment"), true);
});

Deno.test("checkRawGhWrite denies a raw `gh issue edit`", () => {
  const message = checkRawGhWrite("gh issue edit 685 --remove-label Blocked");
  assertEquals(message !== null, true);
  assertEquals(message!.includes("deno task edit-issue"), true);
});

Deno.test("checkRawGhWrite allows the guarded `deno task post-pr-review` command itself", () => {
  const message = checkRawGhWrite(
    "deno task post-pr-review --repo WebJamApps/JaMmusic --pr 1324 --body-file /tmp/r.md",
  );
  assertEquals(message, null);
});

Deno.test("checkRawGhWrite allows an unrelated gh read command", () => {
  const message = checkRawGhWrite("gh pr view 1324 --repo WebJamApps/JaMmusic --json state");
  assertEquals(message, null);
});

Deno.test("checkRawGhWrite does not false-positive on a similarly-prefixed subcommand", () => {
  // "gh pr reviewers" is not a real gh subcommand, but this pins the word-boundary
  // behavior so a hypothetical future verb sharing the "review" prefix isn't swept in.
  const message = checkRawGhWrite("gh pr reviewers list WebJamApps/JaMmusic#1324");
  assertEquals(message, null);
});

Deno.test("checkRawGhWrite matches regardless of surrounding whitespace variation", () => {
  const message = checkRawGhWrite("gh   pr   review 1 --comment --body-file x");
  assertEquals(message !== null, true);
});

Deno.test("checkRawGhWrite allows prose that merely names gated commands", () => {
  for (
    const command of [
      "cat <<'EOF' > notes.md\nrun gh pr review to approve Josh's change\nEOF",
      'printf "%s\\n" "gh issue comment"',
      'git commit -m "Mention gh issue edit in the documentation"',
      "git status # Josh's note: gh pr comment; gh issue edit",
      "# gh pr review\ngh pr view 42",
      'printf "%s" "# gh issue comment; gh pr review"',
      "printf '%s' gh pr review",
      "rg 'gh issue edit' hooks/",
      "echo '$(gh issue edit)'",
      "echo '`gh pr review`'",
      'echo "\\$(gh issue edit)"',
      "",
    ]
  ) {
    assertEquals(checkRawGhWrite(command), null, command);
  }
});

Deno.test("checkRawGhWrite identifies execution across operators and wrappers", () => {
  for (
    const command of [
      "git status;gh pr review 42",
      "true&&gh pr comment 42",
      "false||gh issue comment 42",
      "printf x|gh issue edit 42",
      "git status & gh issue edit 42",
      "git status\ngh pr review 42",
      "(gh pr comment 42)",
      "if true; then gh pr review 42; fi",
      'for n in 42; do gh issue edit "$n"; done',
      "! gh issue comment 42",
      "GH_HOST=github.com gh issue comment 42",
      "env GH_HOST=github.com command gh issue edit 42",
      "/usr/bin/gh pr review 42",
      'bash -c "gh pr review 42"',
      'eval "gh issue edit 42"',
      "bash <<'EOF'\ngh issue comment 42\nEOF",
      "cat <<'EOF' > notes.md\ngh pr review is prose\nEOF\ngh issue edit 42",
      "git status # Josh's note: gh pr comment\ngh issue edit 42",
      "gh pr review 42 # Josh's note",
      'echo "$(gh issue edit 42)"',
      "echo `gh pr review 42`",
    ]
  ) {
    assertEquals(checkRawGhWrite(command) !== null, true, command);
  }
});

Deno.test("checkRawGhWrite allows prose passed through a shell wrapper", () => {
  assertEquals(checkRawGhWrite("bash -c 'echo \"gh issue edit\"'"), null);
});

Deno.test("checkRawGhWrite retains the raw fallback on malformed quoting", () => {
  for (const { verb } of VERB_PATTERNS) {
    assertEquals(checkRawGhWrite(`echo "${verb}`), checkRawGhWrite(verb));
  }
  assertEquals(checkRawGhWrite('echo "unrelated'), null);
});

Deno.test("checkRawGhWrite retains the raw fallback at wrapper recursion limits", () => {
  assertEquals(
    checkRawGhWrite("sudo ".repeat(26) + "gh pr review"),
    checkRawGhWrite("gh pr review"),
  );
  assertEquals(
    checkRawGhWrite("eval ".repeat(8) + "gh pr review"),
    checkRawGhWrite("gh pr review"),
  );
});

Deno.test("checkRawGhWrite preserves the denial text for all four gated verbs", () => {
  for (const { verb, guardedEquivalent } of VERB_PATTERNS) {
    assertEquals(
      checkRawGhWrite(verb),
      [
        `BLOCKED (raw gh write guard): \`${verb}\` is denied.`,
        "The four GitHub write verbs this repo gates (gh pr review, gh pr comment, gh issue " +
        "comment, gh issue edit) are only reachable through their guarded `deno task` " +
        "commands, so a dispatched subagent — with no human present to answer a permission " +
        "prompt — completes its own write instead of dead-ending (web-jam-tools#685).",
        `Use instead: ${guardedEquivalent}`,
      ].join("\n"),
    );
  }
});
