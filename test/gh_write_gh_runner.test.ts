// gh_write_gh_runner.test.ts — web-jam-tools#685

import { assertEquals } from "@std/assert";
import { isTransientError, runWithRetry } from "../scripts/gh-write/gh_runner.ts";

Deno.test("isTransientError recognizes an i/o timeout", () => {
  assertEquals(isTransientError('Post "https://api.github.com/graphql": i/o timeout'), true);
});

Deno.test("isTransientError recognizes a connection reset", () => {
  assertEquals(isTransientError("read: connection reset by peer"), true);
});

Deno.test("isTransientError does not flag an ordinary refusal", () => {
  assertEquals(isTransientError("HTTP 403: Resource not accessible by integration"), false);
});

Deno.test("runWithRetry does not retry a first-attempt success", async () => {
  let calls = 0;
  const result = await runWithRetry(
    () => {
      calls++;
      return Promise.resolve({ code: 0, stdout: "ok", stderr: "" });
    },
    ["gh", "pr", "review"],
    { sleep: () => Promise.resolve() },
  );
  assertEquals(calls, 1);
  assertEquals(result.attempts, 1);
  assertEquals(result.code, 0);
});

Deno.test("runWithRetry retries a transient i/o timeout and succeeds on the next attempt (simulated 2026-08-20 incident)", async () => {
  let calls = 0;
  const result = await runWithRetry(
    () => {
      calls++;
      if (calls < 3) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "i/o timeout" });
      }
      return Promise.resolve({ code: 0, stdout: "ok", stderr: "" });
    },
    ["gh", "pr", "review"],
    { sleep: () => Promise.resolve() },
  );
  assertEquals(calls, 3);
  assertEquals(result.attempts, 3);
  assertEquals(result.code, 0);
});

Deno.test("runWithRetry does NOT retry a non-transient failure — surfaces on the first attempt", async () => {
  let calls = 0;
  const result = await runWithRetry(
    () => {
      calls++;
      return Promise.resolve({ code: 1, stdout: "", stderr: "HTTP 403: not accessible" });
    },
    ["gh", "pr", "review"],
    { sleep: () => Promise.resolve() },
  );
  assertEquals(calls, 1);
  assertEquals(result.attempts, 1);
  assertEquals(result.code, 1);
});

Deno.test("runWithRetry gives up after the configured attempts and reports the last failure", async () => {
  let calls = 0;
  const result = await runWithRetry(
    () => {
      calls++;
      return Promise.resolve({ code: 1, stdout: "", stderr: "i/o timeout" });
    },
    ["gh", "pr", "review"],
    { attempts: 2, sleep: () => Promise.resolve() },
  );
  assertEquals(calls, 2);
  assertEquals(result.attempts, 2);
  assertEquals(result.code, 1);
});
