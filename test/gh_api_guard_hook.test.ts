import { assertEquals } from "@std/assert";

const HOOK_PATH = new URL("../hooks/gh-api-guard.sh", import.meta.url).pathname;

async function runHook(cmd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const input = JSON.stringify({ tool_input: { command: cmd } });
  const process = new Deno.Command("bash", {
    args: [HOOK_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = process.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();

  const output = await child.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
}

Deno.test("gh api DELETE is blocked (exit 2)", async () => {
  const res1 = await runHook("gh api -X DELETE repos/owner/repo");
  assertEquals(res1.code, 2);
  assertEquals(res1.stderr.includes("BLOCKED (gh api guard)"), true);

  const res2 = await runHook("gh api --method DELETE repos/owner/repo");
  assertEquals(res2.code, 2);
  assertEquals(res2.stderr.includes("BLOCKED (gh api guard)"), true);
});

// Regression: web-jam-tools#425 post-approval finding — quoting the method
// value defeated the DELETE match (and, symmetrically, the POST/PUT/PATCH
// ask match) because the regexes only recognized unquoted literals.
Deno.test("gh api DELETE is blocked regardless of quoting or = joining", async () => {
  const deleteForms = [
    "gh api -X DELETE repos/owner/repo",
    `gh api -X 'DELETE' repos/owner/repo`,
    `gh api -X "DELETE" repos/owner/repo`,
    "gh api --method DELETE repos/owner/repo",
    `gh api --method='DELETE' repos/owner/repo`,
    `gh api --method="DELETE" repos/owner/repo`,
    "gh api -XDELETE repos/owner/repo",
    `gh api -X'DELETE' repos/owner/repo`,
    "gh api --method=DELETE repos/owner/repo",
  ];
  for (const cmd of deleteForms) {
    const res = await runHook(cmd);
    assertEquals(res.code, 2, `expected exit 2 for: ${cmd}`);
    assertEquals(
      res.stderr.includes("BLOCKED (gh api guard)"),
      true,
      `expected block message for: ${cmd}`,
    );
  }
});

Deno.test("gh api POST/PUT/PATCH triggers ask regardless of quoting", async () => {
  const askForms = [
    `gh api -X 'POST' repos/o/r/issues`,
    `gh api --method="PUT" repos/o/r/issues/1`,
    `gh api -X'PATCH' repos/o/r/issues/1`,
  ];
  for (const cmd of askForms) {
    const res = await runHook(cmd);
    assertEquals(res.code, 0, `expected exit 0 for: ${cmd}`);
    const parsed = JSON.parse(res.stdout);
    assertEquals(
      parsed.hookSpecificOutput?.permissionDecision,
      "ask",
      `expected ask decision for: ${cmd}`,
    );
  }
});

Deno.test("gh api POST/PUT/PATCH or field flags trigger ask decision", async () => {
  const res1 = await runHook("gh api -X POST repos/owner/repo/issues");
  assertEquals(res1.code, 0);
  const parsed1 = JSON.parse(res1.stdout);
  assertEquals(parsed1.hookSpecificOutput?.permissionDecision, "ask");

  const res2 = await runHook("gh api repos/owner/repo/issues -f title='test'");
  assertEquals(res2.code, 0);
  const parsed2 = JSON.parse(res2.stdout);
  assertEquals(parsed2.hookSpecificOutput?.permissionDecision, "ask");
});

// web-jam-tools: narrow carve-out — removing an issue dependency
// (`.../issues/<N>/dependencies/blocked_by/<ID>`) is reversible (the
// dependency can be re-added with the corresponding POST), so it is the
// one DELETE form allowed to pass through cleanly.
Deno.test("gh api DELETE blocked_by dependency removal is allowed through", async () => {
  const allowedForms = [
    "gh api --method DELETE repos/owner/repo/issues/1/dependencies/blocked_by/2",
    "gh api -X DELETE repos/owner/repo/issues/1/dependencies/blocked_by/2",
    `gh api -X 'DELETE' repos/owner/repo/issues/1/dependencies/blocked_by/2`,
    `gh api -X "DELETE" repos/owner/repo/issues/1/dependencies/blocked_by/2`,
    `gh api --method='DELETE' repos/owner/repo/issues/1/dependencies/blocked_by/2`,
    `gh api --method="DELETE" repos/owner/repo/issues/1/dependencies/blocked_by/2`,
    "gh api --method=DELETE repos/owner/repo/issues/1/dependencies/blocked_by/2",
    "gh api -XDELETE repos/owner/repo/issues/1/dependencies/blocked_by/2",
  ];
  for (const cmd of allowedForms) {
    const res = await runHook(cmd);
    assertEquals(res.code, 0, `expected exit 0 for: ${cmd}`);
    assertEquals(res.stdout, "", `expected no stdout (no ask/prompt) for: ${cmd}`);
    assertEquals(res.stderr, "", `expected no block message for: ${cmd}`);
  }
});

Deno.test("gh api DELETE to a different path is still denied", async () => {
  const deniedForms = [
    "gh api --method DELETE repos/owner/repo",
    "gh api --method DELETE repos/owner/repo/issues/1",
    "gh api --method DELETE repos/owner/repo/issues/1/dependencies/blocking/2",
    "gh api -X DELETE user/repos/some-repo",
  ];
  for (const cmd of deniedForms) {
    const res = await runHook(cmd);
    assertEquals(res.code, 2, `expected exit 2 for: ${cmd}`);
    assertEquals(
      res.stderr.includes("BLOCKED (gh api guard)"),
      true,
      `expected block message for: ${cmd}`,
    );
  }
});

// Regression: requirement is a path-shape match, anchored — not a bare
// substring search for "blocked_by" anywhere in the command.
Deno.test("gh api DELETE with blocked_by only as a trailing comment is denied", async () => {
  const res = await runHook("gh api --method DELETE repos/o/r/issues/1 # blocked_by");
  assertEquals(res.code, 2);
  assertEquals(res.stderr.includes("BLOCKED (gh api guard)"), true);
});

// Regression: a compound/chained command must not smuggle a second,
// disallowed DELETE past the guard just because the allowed form also
// appears somewhere in the string.
Deno.test("gh api DELETE inside a compound command is denied even with an allowed form present", async () => {
  const compoundForms = [
    "gh api --method DELETE repos/o/r/issues/1/dependencies/blocked_by/2 && " +
    "gh api --method DELETE repos/o/r/issues/3",
    "gh api --method DELETE repos/o/r/issues/1/dependencies/blocked_by/2; " +
    "gh api --method DELETE repos/o/r/issues/3",
    "gh api --method DELETE repos/o/r/issues/1/dependencies/blocked_by/2 | cat",
    "gh api --method DELETE repos/o/r/issues/1/dependencies/blocked_by/2 extra-arg",
    "gh api --method DELETE repos/o/r/issues/1/dependencies/blocked_by/2\necho hi",
    "gh api --method DELETE repos/o/r/issues/1/dependencies/blocked_by/$(echo 2)",
    "gh api --method DELETE repos/o/r/issues/1/dependencies/blocked_by/`echo 2`",
  ];
  for (const cmd of compoundForms) {
    const res = await runHook(cmd);
    assertEquals(res.code, 2, `expected exit 2 for: ${cmd}`);
    assertEquals(
      res.stderr.includes("BLOCKED (gh api guard)"),
      true,
      `expected block message for: ${cmd}`,
    );
  }
});

Deno.test("gh api GET passes through silently", async () => {
  const res = await runHook("gh api repos/owner/repo");
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "");
  assertEquals(res.stderr, "");

  // Regression test: -f substring in repo name must NOT trip field flag ask decision
  const res2 = await runHook("gh api repos/owner/my-first-repo");
  assertEquals(res2.code, 0);
  assertEquals(res2.stdout, "");
  assertEquals(res2.stderr, "");
});
