// post_issue_comment.test.ts — web-jam-tools#685

import { assertEquals } from "@std/assert";
import { type Deps, run } from "../scripts/post-issue-comment.ts";
import { variedFakeBody } from "./support/varied_fake_value.ts";

function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    readFileText: () => Promise.resolve("this is now resolved"),
    runCmd: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}

const ARGS = [
  "--repo",
  "WebJamApps/web-jam-tools",
  "--issue",
  "685",
  "--body-file",
  "/tmp/example.md",
];

Deno.test("post-issue-comment: missing required args prints usage and exits 1", async () => {
  const code = await run([], fakeDeps());
  assertEquals(code, 1);
});

Deno.test("post-issue-comment: an empty body file is REFUSED", async () => {
  const code = await run(ARGS, fakeDeps({ readFileText: () => Promise.resolve("") }));
  assertEquals(code, 1);
});

Deno.test("post-issue-comment: a body carrying a credential-shaped literal is REFUSED", async () => {
  const fake = "AIza" + variedFakeBody(35, 60);
  const code = await run(ARGS, fakeDeps({ readFileText: () => Promise.resolve(`token: ${fake}`) }));
  assertEquals(code, 1);
});

Deno.test("post-issue-comment: --dry-run resolves without posting", async () => {
  let called = false;
  const code = await run(
    [...ARGS, "--dry-run"],
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

Deno.test("post-issue-comment: a well-formed body posts successfully", async () => {
  const code = await run(ARGS, fakeDeps());
  assertEquals(code, 0);
});

Deno.test("post-issue-comment: builds gh argv with bare issue id and --repo flag (regression web-jam-tools#781)", async () => {
  let seenCommentArgs: string[] = [];
  const code = await run(
    ARGS,
    fakeDeps({
      runCmd: (cmd) => {
        seenCommentArgs = cmd;
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(seenCommentArgs, [
    "gh",
    "issue",
    "comment",
    "685",
    "--repo",
    "WebJamApps/web-jam-tools",
    "--body-file",
    "/tmp/example.md",
  ]);
});
