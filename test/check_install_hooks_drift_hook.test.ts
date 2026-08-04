// check_install_hooks_drift_hook.test.ts — web-jam-tools#339
//
// Exercises hooks/check-install-hooks-drift.sh — the SessionStart drift check hook
// that delegates to scripts/install-hooks.sh --check.

import { assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/check-install-hooks-drift.sh",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runHook(env?: Record<string, string>): Promise<RunResult> {
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env,
  });
  const child = cmd.spawn();
  await child.stdin.close();
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

Deno.test("check-install-hooks-drift.sh runs install-hooks.sh --check", async () => {
  const hooksDir = await Deno.makeTempDir();
  const settingsDir = await Deno.makeTempDir();
  const settingsPath = `${settingsDir}/settings.json`;
  const repoRoot = new URL("..", import.meta.url).pathname;

  try {
    // First install hooks cleanly in sandboxed dir
    const installCmd = new Deno.Command("bash", {
      args: [
        `${repoRoot}scripts/install-hooks.sh`,
        "--hooks-dir",
        hooksDir,
        "--settings-path",
        settingsPath,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const { code: installCode } = await installCmd.output();
    assertEquals(installCode, 0);

    // Now run the hook with overridden CLAUDE_SETTINGS_PATH and CLAUDE_HOOKS_DIR
    const res = await runHook({
      CLAUDE_SETTINGS_PATH: settingsPath,
      CLAUDE_HOOKS_DIR: hooksDir,
    });
    assertEquals(res.code, 0, res.stdout + res.stderr);
    assertStringIncludes(res.stdout, "check passed (no drift)");
  } finally {
    await Deno.remove(hooksDir, { recursive: true });
    await Deno.remove(settingsDir, { recursive: true });
  }
});
