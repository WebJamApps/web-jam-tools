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
