// post_pr_comment.test.ts — web-jam-tools#685

import { assertEquals } from "@std/assert";
import { type Deps, run } from "../scripts/post-pr-comment.ts";
import { variedFakeBody } from "./support/varied_fake_value.ts";

function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    readFileText: () => Promise.resolve("thanks, looks good"),
    runCmd: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}

const ARGS = [
  "--repo",
  "WebJamApps/JaMmusic",
  "--pr",
  "1324",
  "--body-file",
  "/tmp/example-comment.md",
];

Deno.test("post-pr-comment: missing required args prints usage and exits 1", async () => {
  const code = await run([], fakeDeps());
  assertEquals(code, 1);
});

Deno.test("post-pr-comment: an empty body file is REFUSED", async () => {
  const code = await run(ARGS, fakeDeps({ readFileText: () => Promise.resolve("   ") }));
  assertEquals(code, 1);
});

Deno.test("post-pr-comment: a body with no review header is still ALLOWED (header check binds the review verb only)", async () => {
  const code = await run(ARGS, fakeDeps());
  assertEquals(code, 0);
});

Deno.test("post-pr-comment: a body carrying a credential-shaped literal is REFUSED", async () => {
  const fake = "AIza" + variedFakeBody(35, 50);
  const code = await run(
    ARGS,
    fakeDeps({ readFileText: () => Promise.resolve(`leaked: ${fake}`) }),
  );
  assertEquals(code, 1);
});

Deno.test("post-pr-comment: --dry-run resolves without posting", async () => {
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

Deno.test("post-pr-comment: a transient failure is retried and succeeds", async () => {
  let attempts = 0;
  const code = await run(
    ARGS,
    fakeDeps({
      runCmd: () => {
        attempts++;
        if (attempts < 2) return Promise.resolve({ code: 1, stdout: "", stderr: "i/o timeout" });
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(attempts, 2);
});

Deno.test("post-pr-comment: builds gh argv with bare pr id and --repo flag (regression web-jam-tools#781)", async () => {
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
    "pr",
    "comment",
    "1324",
    "--repo",
    "WebJamApps/JaMmusic",
    "--body-file",
    "/tmp/example-comment.md",
  ]);
});
