// edit_issue.test.ts — web-jam-tools#685

import { assertEquals } from "@std/assert";
import { type Deps, run } from "../scripts/edit-issue.ts";
import { variedFakeBody } from "./support/varied_fake_value.ts";

function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    readFileText: () => Promise.resolve("some body text"),
    runCmd: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("edit-issue: missing required args prints usage and exits 1", async () => {
  const code = await run(["--repo", "WebJamApps/web-jam-tools", "--issue", "685"], fakeDeps());
  assertEquals(code, 1);
});

Deno.test("edit-issue: a label edit with no body passes through untouched", async () => {
  let seenArgs: string[] = [];
  const code = await run(
    ["--repo", "WebJamApps/web-jam-tools", "--issue", "685", "--remove-label", "Blocked"],
    fakeDeps({
      runCmd: (cmd) => {
        seenArgs = cmd;
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(seenArgs, [
    "gh",
    "issue",
    "edit",
    "WebJamApps/web-jam-tools#685",
    "--remove-label",
    "Blocked",
  ]);
});

Deno.test("edit-issue: an inline --body value is REFUSED when empty", async () => {
  const code = await run(
    ["--repo", "WebJamApps/web-jam-tools", "--issue", "685", "--body", ""],
    fakeDeps(),
  );
  assertEquals(code, 1);
});

Deno.test("edit-issue: a --body-file pointing at an empty file is REFUSED", async () => {
  const code = await run(
    ["--repo", "WebJamApps/web-jam-tools", "--issue", "685", "--body-file", "/tmp/empty.md"],
    fakeDeps({ readFileText: () => Promise.resolve("") }),
  );
  assertEquals(code, 1);
});

Deno.test("edit-issue: a credential-shaped literal in any argument value is REFUSED", async () => {
  const fake = "AIza" + variedFakeBody(35, 70);
  const code = await run(
    ["--repo", "WebJamApps/web-jam-tools", "--issue", "685", "--title", `leak ${fake}`],
    fakeDeps(),
  );
  assertEquals(code, 1);
});

Deno.test("edit-issue: --dry-run resolves without editing", async () => {
  let called = false;
  const code = await run(
    ["--repo", "WebJamApps/web-jam-tools", "--issue", "685", "--add-label", "Sonnet", "--dry-run"],
    fakeDeps({
      runCmd: () => {
        called = true;
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(called, false);
});
