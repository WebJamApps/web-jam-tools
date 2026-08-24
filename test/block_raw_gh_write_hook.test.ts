// block_raw_gh_write_hook.test.ts — web-jam-tools#685
//
// Exercises hooks/block-raw-gh-write.sh end-to-end (Claude Code shape) AND,
// per the design's "both surfaces — a standing requirement" (§3b), through
// hooks/agy-hook-shim.sh unmodified — the same generic translation every
// other PreToolUse hook already goes through — proving the agy deny comes
// back as {"decision":"deny","reason":"..."} with exit 0, verified
// independently rather than inferred from the Claude Code result.

import { assertEquals } from "@std/assert";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const HOOK_SCRIPT = `${REPO_ROOT}hooks/block-raw-gh-write.sh`;
const AGY_SHIM = `${REPO_ROOT}hooks/agy-hook-shim.sh`;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runClaude(command: string): Promise<RunResult> {
  const input = JSON.stringify({ tool_input: { command } });
  const cmd = new Deno.Command("bash", {
    args: [HOOK_SCRIPT],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

async function runAgy(commandLine: string): Promise<RunResult> {
  const matcherB64 = btoa("Bash");
  const input = JSON.stringify({
    toolCall: { name: "run_command", args: { CommandLine: commandLine } },
  });
  const cmd = new Deno.Command("bash", {
    args: [AGY_SHIM, "PreToolUse", matcherB64, HOOK_SCRIPT],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

// --- Claude Code surface: each raw verb DENIED (exit 2), the guarded command ALLOWED (exit 0) ---

Deno.test("Claude Code: raw `gh pr review` is DENIED with the guarded equivalent named", async () => {
  const res = await runClaude(
    "gh pr review WebJamApps/JaMmusic#1324 --comment --body-file /tmp/r.md",
  );
  assertEquals(res.code, 2);
  assertEquals(res.stderr.includes("BLOCKED (raw gh write guard)"), true);
  assertEquals(res.stderr.includes("deno task post-pr-review"), true);
});

Deno.test("Claude Code: raw `gh pr comment` is DENIED with the guarded equivalent named", async () => {
  const res = await runClaude("gh pr comment 1324 --body-file /tmp/c.md");
  assertEquals(res.code, 2);
  assertEquals(res.stderr.includes("deno task post-pr-comment"), true);
});

Deno.test("Claude Code: raw `gh issue comment` is DENIED with the guarded equivalent named", async () => {
  const res = await runClaude("gh issue comment 685 --body-file /tmp/c.md");
  assertEquals(res.code, 2);
  assertEquals(res.stderr.includes("deno task post-issue-comment"), true);
});

Deno.test("Claude Code: raw `gh issue edit` is DENIED with the guarded equivalent named", async () => {
  const res = await runClaude("gh issue edit 685 --remove-label Blocked");
  assertEquals(res.code, 2);
  assertEquals(res.stderr.includes("deno task edit-issue"), true);
});

Deno.test("Claude Code: the guarded `deno task post-pr-review` command is ALLOWED", async () => {
  const res = await runClaude(
    "deno task post-pr-review --repo WebJamApps/JaMmusic --pr 1324 --body-file /tmp/r.md",
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("Claude Code: an unrelated command is ALLOWED", async () => {
  const res = await runClaude("ls -la src/");
  assertEquals(res.code, 0, res.stderr);
});

// --- agy surface, via the unmodified translation shim (§3b) ---

Deno.test('agy: raw `gh pr review` DENIED as {"decision":"deny","reason":"..."} with exit 0', async () => {
  const res = await runAgy("gh pr review WebJamApps/JaMmusic#1324 --comment --body-file /tmp/r.md");
  assertEquals(res.code, 0, res.stderr);
  const verdict = JSON.parse(res.stdout.trim());
  assertEquals(verdict.decision, "deny");
  assertEquals(typeof verdict.reason, "string");
  assertEquals(verdict.reason.includes("deno task post-pr-review"), true);
});

Deno.test('agy: raw `gh issue edit` DENIED as {"decision":"deny","reason":"..."} with exit 0', async () => {
  const res = await runAgy("gh issue edit 685 --remove-label Blocked");
  assertEquals(res.code, 0, res.stderr);
  const verdict = JSON.parse(res.stdout.trim());
  assertEquals(verdict.decision, "deny");
  assertEquals(verdict.reason.includes("deno task edit-issue"), true);
});

Deno.test("agy: the guarded `deno task post-pr-review` command is ALLOWED", async () => {
  const res = await runAgy(
    "deno task post-pr-review --repo WebJamApps/JaMmusic --pr 1324 --body-file /tmp/r.md",
  );
  assertEquals(res.code, 0, res.stderr);
  const verdict = JSON.parse(res.stdout.trim());
  assertEquals(verdict.decision, "allow");
});
