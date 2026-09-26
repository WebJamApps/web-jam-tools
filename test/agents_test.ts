// test/agents_test.ts — web-jam-tools#1174
//
// Drives scripts/agents.sh against throwaway tmux servers (tmux -L) to verify:
// 1. Session `agents` is created with tabs `claude`, `codex`, `agy` (tab indices 1, 2, 3) in $HOME.
// 2. Session settings (window-size latest, base-index 1) are applied to the agents session only.
// 3. Tab names stay fixed (automatic-rename is off).
// 4. A second run attaches instead of creating a second session.
// 5. A tab drops to a plain shell prompt when its agent exits instead of closing.
// 6. CLI flags (-L, -S, --no-attach, --help, unknown args) behave correctly.

import { assert, assertEquals } from "@std/assert";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const AGENTS_SCRIPT = `${REPO_ROOT}scripts/agents.sh`;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  cmd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<RunResult> {
  const command = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
    env: env ? { ...Deno.env.toObject(), ...env } : undefined,
  });
  const { code, stdout, stderr } = await command.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

async function withThrowawayTmux(
  fn: (socketName: string, tmpDir: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: "agents-test-" });
  const socketName = `test-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await fn(socketName, tmpDir);
  } finally {
    // Kill the throwaway server if it is running
    await run("tmux", ["-L", socketName, "kill-server"], { TMUX_TMPDIR: tmpDir });
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

Deno.test("agents.sh creates session 'agents' with tabs claude, codex, agy (indices 1, 2, 3) in $HOME", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    const res = await run("bash", [AGENTS_SCRIPT, "-L", socketName], {
      TMUX_TMPDIR: tmpDir,
      AGENTS_CLAUDE_CMD: "sleep 60",
      AGENTS_CODEX_CMD: "sleep 60",
      AGENTS_AGY_CMD: "sleep 60",
    });
    assertEquals(res.code, 0, `agents.sh failed: ${res.stdout}\n${res.stderr}`);

    // Verify session existence
    const hasSession = await run("tmux", ["-L", socketName, "has-session", "-t", "agents"], {
      TMUX_TMPDIR: tmpDir,
    });
    assertEquals(hasSession.code, 0, "session 'agents' should exist");

    // Verify windows: index, name, pane_current_path
    const listWindows = await run(
      "tmux",
      [
        "-L",
        socketName,
        "list-windows",
        "-t",
        "agents",
        "-F",
        "#{window_index}:#{window_name}:#{pane_current_path}",
      ],
      { TMUX_TMPDIR: tmpDir },
    );
    assertEquals(listWindows.code, 0);
    const homeDir = Deno.env.get("HOME")!;
    const expectedWindows = [
      `1:claude:${homeDir}`,
      `2:codex:${homeDir}`,
      `3:agy:${homeDir}`,
    ];
    const actualWindows = listWindows.stdout.trim().split("\n");
    assertEquals(actualWindows, expectedWindows);

    // Verify active window is tab 1 (claude)
    const activeWindow = await run(
      "tmux",
      ["-L", socketName, "list-windows", "-t", "agents", "-F", "#{window_index}:#{window_active}"],
      { TMUX_TMPDIR: tmpDir },
    );
    assertEquals(activeWindow.code, 0);
    const activeLines = activeWindow.stdout.trim().split("\n");
    assertEquals(activeLines, ["1:1", "2:0", "3:0"]);

    // Verify session settings: window-size latest
    const windowSize = await run(
      "tmux",
      ["-L", socketName, "show", "-t", "agents", "-v", "window-size"],
      { TMUX_TMPDIR: tmpDir },
    );
    assertEquals(windowSize.code, 0);
    assertEquals(windowSize.stdout.trim(), "latest");

    // Verify session settings: base-index 1
    const baseIndex = await run(
      "tmux",
      ["-L", socketName, "show", "-t", "agents", "-v", "base-index"],
      { TMUX_TMPDIR: tmpDir },
    );
    assertEquals(baseIndex.code, 0);
    assertEquals(baseIndex.stdout.trim(), "1");
  });
});

Deno.test("agents.sh turns off automatic-rename so tab names stay fixed", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    const res = await run("bash", [AGENTS_SCRIPT, "-L", socketName], {
      TMUX_TMPDIR: tmpDir,
      AGENTS_CLAUDE_CMD: "sleep 60",
      AGENTS_CODEX_CMD: "sleep 60",
      AGENTS_AGY_CMD: "sleep 60",
    });
    assertEquals(res.code, 0);

    // Verify automatic-rename is 0 for all windows
    const autoRename = await run(
      "tmux",
      [
        "-L",
        socketName,
        "list-windows",
        "-t",
        "agents",
        "-F",
        "#{window_name}:#{automatic-rename}",
      ],
      { TMUX_TMPDIR: tmpDir },
    );
    assertEquals(autoRename.code, 0);
    const renameLines = autoRename.stdout.trim().split("\n");
    assertEquals(renameLines, ["claude:0", "codex:0", "agy:0"]);

    // Run a command in the pane and ensure window name does not rename
    await run("tmux", [
      "-L",
      socketName,
      "send-keys",
      "-t",
      "agents:claude",
      "echo renamed-test",
      "C-m",
    ], {
      TMUX_TMPDIR: tmpDir,
    });
    await new Promise((r) => setTimeout(r, 200));

    const checkWindow = await run(
      "tmux",
      ["-L", socketName, "display-message", "-t", "agents:1", "-p", "#{window_name}"],
      { TMUX_TMPDIR: tmpDir },
    );
    assertEquals(checkWindow.stdout.trim(), "claude");
  });
});

Deno.test("agents.sh second run attaches to existing session without creating a duplicate", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    // First run creates the session
    const res1 = await run("bash", [AGENTS_SCRIPT, "-L", socketName], {
      TMUX_TMPDIR: tmpDir,
      AGENTS_CLAUDE_CMD: "sleep 60",
      AGENTS_CODEX_CMD: "sleep 60",
      AGENTS_AGY_CMD: "sleep 60",
    });
    assertEquals(res1.code, 0);

    // Second run targets the same socket
    const res2 = await run("bash", [AGENTS_SCRIPT, "-L", socketName], {
      TMUX_TMPDIR: tmpDir,
    });
    assertEquals(res2.code, 0, `Second run failed: ${res2.stdout}\n${res2.stderr}`);

    // Verify there is still only one session named 'agents'
    const listSessions = await run("tmux", [
      "-L",
      socketName,
      "list-sessions",
      "-F",
      "#{session_name}",
    ], {
      TMUX_TMPDIR: tmpDir,
    });
    assertEquals(listSessions.code, 0);
    const sessions = listSessions.stdout.trim().split("\n");
    assertEquals(sessions, ["agents"]);
  });
});

Deno.test("agents.sh drops a tab to a plain shell when its agent exits instead of closing the tab", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    // Configure the claude tab to run an agent that exits immediately
    const res = await run("bash", [AGENTS_SCRIPT, "-L", socketName], {
      TMUX_TMPDIR: tmpDir,
      AGENTS_CLAUDE_CMD: "sh -c 'exit 0'",
      AGENTS_CODEX_CMD: "sleep 60",
      AGENTS_AGY_CMD: "sleep 60",
    });
    assertEquals(res.code, 0);

    // Wait briefly for the exit command to finish and exec to shell
    await new Promise((r) => setTimeout(r, 200));

    // The claude tab must still exist and be open
    const listWindows = await run(
      "tmux",
      ["-L", socketName, "list-windows", "-t", "agents", "-F", "#{window_index}:#{window_name}"],
      { TMUX_TMPDIR: tmpDir },
    );
    assertEquals(listWindows.code, 0);
    const windows = listWindows.stdout.trim().split("\n");
    assert(
      windows.includes("1:claude"),
      `claude window should still exist, got: ${windows.join(", ")}`,
    );

    // Verify the command currently running in the pane is a shell (bash/sh)
    const currentCmd = await run(
      "tmux",
      ["-L", socketName, "list-panes", "-t", "agents:claude", "-F", "#{pane_current_command}"],
      { TMUX_TMPDIR: tmpDir },
    );
    assertEquals(currentCmd.code, 0);
    const runningCmd = currentCmd.stdout.trim();
    assert(
      runningCmd === "bash" || runningCmd === "sh",
      `expected pane to drop to a shell (bash or sh), got: ${runningCmd}`,
    );
  });
});

Deno.test("agents.sh supports -S socket path and --no-attach", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "agents-test-sock-" });
  const socketPath = `${tmpDir}/custom_socket`;
  try {
    const res = await run("bash", [AGENTS_SCRIPT, "-S", socketPath, "--no-attach"], {
      AGENTS_CLAUDE_CMD: "sleep 60",
      AGENTS_CODEX_CMD: "sleep 60",
      AGENTS_AGY_CMD: "sleep 60",
    });
    assertEquals(res.code, 0, res.stderr);

    const hasSession = await run("tmux", ["-S", socketPath, "has-session", "-t", "agents"]);
    assertEquals(hasSession.code, 0, "session should exist on custom socket path");
  } finally {
    await run("tmux", ["-S", socketPath, "kill-server"]);
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  }
});

Deno.test("agents.sh --help prints usage and exits 0", async () => {
  const res = await run("bash", [AGENTS_SCRIPT, "--help"]);
  assertEquals(res.code, 0);
  assert(res.stdout.includes("Usage:"));
  assert(res.stdout.includes("[-L socket]"));
});

Deno.test("agents.sh refuses unknown arguments", async () => {
  const res = await run("bash", [AGENTS_SCRIPT, "--invalid-flag"]);
  assertEquals(res.code, 1);
  assert(res.stderr.includes("error: unknown argument: --invalid-flag"));
});
