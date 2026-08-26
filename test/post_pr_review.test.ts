// post_pr_review.test.ts — web-jam-tools#685

import { assertEquals } from "@std/assert";
import { type Deps, run } from "../scripts/post-pr-review.ts";
import { variedFakeBody } from "./support/varied_fake_value.ts";
import { REVIEW_SUMMARY_HEADER } from "../scripts/gh-write/guard.ts";

function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    readFileText: () => Promise.resolve(`${REVIEW_SUMMARY_HEADER}\n**Approved**`),
    runCmd: () => Promise.resolve({ code: 0, stdout: "{}", stderr: "" }),
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
  "/tmp/example-review.md",
];

Deno.test("post-pr-review: missing required args prints usage and exits 1", async () => {
  const code = await run([], fakeDeps());
  assertEquals(code, 1);
});

Deno.test("post-pr-review: an empty body file is REFUSED", async () => {
  const code = await run(ARGS, fakeDeps({ readFileText: () => Promise.resolve("") }));
  assertEquals(code, 1);
});

Deno.test('post-pr-review: a body missing the "## PR Review Summary" header is REFUSED', async () => {
  const code = await run(
    ARGS,
    fakeDeps({ readFileText: () => Promise.resolve("**Approved** — no header here.") }),
  );
  assertEquals(code, 1);
});

Deno.test("post-pr-review: a body carrying a credential-shaped literal is REFUSED", async () => {
  const fake = "AIza" + variedFakeBody(35, 40);
  const code = await run(
    ARGS,
    fakeDeps({
      readFileText: () => Promise.resolve(`${REVIEW_SUMMARY_HEADER}\nleaked: ${fake}`),
    }),
  );
  assertEquals(code, 1);
});

Deno.test("post-pr-review: a PR already reviewed at the current head SHA is SKIPPED, not double-posted", async () => {
  let ghReviewCalled = false;
  const code = await run(
    ARGS,
    fakeDeps({
      runCmd: (cmd) => {
        if (cmd.includes("review") && cmd.includes("--comment")) ghReviewCalled = true;
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ last_review_sha: "abc", head_sha: "abc" }),
          stderr: "",
        });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(ghReviewCalled, false);
});

Deno.test("post-pr-review: --dry-run resolves and reports without posting", async () => {
  let ghReviewCalled = false;
  const code = await run(
    [...ARGS, "--dry-run"],
    fakeDeps({
      runCmd: (cmd) => {
        if (cmd.includes("--comment")) ghReviewCalled = true;
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ last_review_sha: null, head_sha: "abc" }),
          stderr: "",
        });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(ghReviewCalled, false);
});

Deno.test("post-pr-review: never exposes --approve or --request-changes on the underlying gh call", async () => {
  let seenArgs: string[] = [];
  await run(
    ARGS,
    fakeDeps({
      runCmd: (cmd) => {
        if (cmd.includes("--comment")) seenArgs = cmd;
        if (cmd[1] === "pr" && cmd[2] === "view") {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify({ last_review_sha: null, head_sha: "abc" }),
            stderr: "",
          });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(seenArgs.includes("--approve"), false);
  assertEquals(seenArgs.includes("--request-changes"), false);
  assertEquals(seenArgs.includes("--comment"), true);
});

Deno.test("post-pr-review: a transient failure is retried and succeeds", async () => {
  let reviewAttempts = 0;
  const code = await run(
    ARGS,
    fakeDeps({
      runCmd: (cmd) => {
        if (cmd[1] === "pr" && cmd[2] === "view") {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify({ last_review_sha: null, head_sha: "abc" }),
            stderr: "",
          });
        }
        reviewAttempts++;
        if (reviewAttempts < 2) {
          return Promise.resolve({ code: 1, stdout: "", stderr: "i/o timeout" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(reviewAttempts, 2);
});

Deno.test("post-pr-review: a well-formed, not-yet-reviewed body posts successfully", async () => {
  const code = await run(
    ARGS,
    fakeDeps({
      runCmd: (cmd) => {
        if (cmd[1] === "pr" && cmd[2] === "view") {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify({ last_review_sha: null, head_sha: "abc" }),
            stderr: "",
          });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 0);
});

Deno.test("post-pr-review: builds gh argv with bare pr id and --repo flag (regression web-jam-tools#781)", async () => {
  let seenReviewArgs: string[] = [];
  const code = await run(
    ARGS,
    fakeDeps({
      runCmd: (cmd) => {
        if (cmd[1] === "pr" && cmd[2] === "view") {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify({ last_review_sha: null, head_sha: "abc" }),
            stderr: "",
          });
        }
        if (cmd[1] === "pr" && cmd[2] === "review") {
          seenReviewArgs = cmd;
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(seenReviewArgs, [
    "gh",
    "pr",
    "review",
    "1324",
    "--repo",
    "WebJamApps/JaMmusic",
    "--comment",
    "--body-file",
    "/tmp/example-review.md",
  ]);
});
