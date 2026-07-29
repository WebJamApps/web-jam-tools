// fmt_push_guard_hook.test.ts — web-jam-tools#285
//
// hooks/fmt-push-guard.sh had NO behaviour test before #285. It is a
// PreToolUse guard (Bash) that blocks `git push` when `deno task fmt:check`
// fails in the current repo. Notably it derives the repo root from the
// CURRENT WORKING DIRECTORY of the hook process itself (`dir="."`), not from
// anything in the command string — so each case below spawns the hook with
// `cwd` pointed at a real throwaway Deno project (never the real
// web-jam-tools checkout), exercising the actual `deno task fmt:check` run.

import { assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/fmt-push-guard.sh",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stderr: string;
}

async function runHook(command: string, cwd: string): Promise<RunResult> {
  const input = JSON.stringify({ tool_input: { command } });
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    cwd,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code, stderr } = await child.output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

async function withDenoProject(
  formatted: boolean,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    // The hook derives the repo root via `git -C "." rev-parse
    // --show-toplevel` (its cwd), and no-ops if that fails — so the temp
    // project must actually be a git repo, not just a directory with a
    // deno.json.
    const init = new Deno.Command("git", { args: ["-C", dir, "init", "-q"] });
    await init.output();
    // `deno fmt --check .` also formats deno.json itself, so this literal
    // must already be in deno fmt's own JSON style — otherwise the
    // "formatted" case would still fail fmt:check on deno.json alone.
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      `{ "tasks": { "fmt:check": "deno fmt --check ." } }\n`,
    );
    await Deno.writeTextFile(
      `${dir}/main.ts`,
      formatted ? `export const value = 1;\n` : `export const value=1\nconst   x = {a:1,b:2}\n`,
    );
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// --- fires: git push blocked when fmt:check fails ---

Deno.test("git push is blocked when fmt:check fails in a Deno project", async () => {
  await withDenoProject(false, async (dir) => {
    const res = await runHook("git push origin claude/285-hook-behaviour-tests", dir);
    assertEquals(res.code, 2);
    assertStringIncludes(res.stderr, "BLOCKED");
    assertStringIncludes(res.stderr, "fmt-push-guard");
  });
});

// --- passes through ---

Deno.test("git push is allowed when fmt:check passes in a Deno project", async () => {
  await withDenoProject(true, async (dir) => {
    const res = await runHook("git push origin claude/285-hook-behaviour-tests", dir);
    assertEquals(res.code, 0, res.stderr);
  });
});

Deno.test("a non-push command is allowed even in a badly-formatted Deno project", async () => {
  await withDenoProject(false, async (dir) => {
    const res = await runHook("git status", dir);
    assertEquals(res.code, 0, res.stderr);
  });
});

Deno.test("git push is allowed outside any git repo (no repo root found)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const res = await runHook("git push origin main", dir);
    assertEquals(res.code, 0, res.stderr);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("git push is allowed in a git repo with no deno.json (not a Deno project)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const init = new Deno.Command("git", { args: ["-C", dir, "init", "-q"] });
    await init.output();
    const res = await runHook("git push origin main", dir);
    assertEquals(res.code, 0, res.stderr);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
