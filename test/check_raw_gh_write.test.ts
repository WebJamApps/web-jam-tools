// check_raw_gh_write.test.ts — web-jam-tools#685

import { assertEquals } from "@std/assert";
import { checkRawGhWrite } from "../hooks/lib/check_raw_gh_write.ts";

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
