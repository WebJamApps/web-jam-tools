// test/agents_test.ts — web-jam-tools#1174
//
// Drives scripts/agents.sh against throwaway tmux servers (tmux -L) to verify:
// 1. Session `agents` is created with tabs `claude`, `codex`, `agy` (tab indices 1, 2, 3) in $HOME.
// 2. Session settings (window-size latest, base-index 1) are applied to the agents session only.
// 3. Tab names stay fixed (automatic-rename is off).
// 4. A second run attaches instead of creating a second session.
// 5. A tab drops to a plain shell prompt when its agent exits instead of closing.
// 6. The update command runs before a new session is created, never on attach, and a failure only warns.
// 7. CLI flags (-L, -S, --no-attach, --help, unknown args) behave correctly.

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
    // Default the laptop-window step to a stub so an SSH_CONNECTION inherited from the
    // caller can never open a real gnome-terminal window.
    env: { ...Deno.env.toObject(), AGENTS_LAPTOP_WINDOW_CMD: "true", ...(env ?? {}) },
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
      AGENTS_UPDATE_CMD: "true",
      AGENTS_LAPTOP_WINDOW_CMD: "true",
    });
    assertEquals(res.code, 0, `agents.sh failed: ${res.stdout}\n${res.stderr}`);

    // Verify session existence
    const hasSession = await run("tmux", ["-L", socketName, "has-session", "-t", "agents"], {
      TMUX_TMPDIR: tmpDir,
    });
    assertEquals(hasSession.code, 0, "session 'agents' should exist");

    // Verify windows: index, name, pane_current_path.
    // A pane just created with `-c "$HOME"` briefly reports the directory the
    // tmux server was started from, until its process has changed directory.
    // Poll until the paths settle (bounded), then assert, so a read that lands
    // in that window does not fail the test.
    const homeDir = Deno.env.get("HOME")!;
    const expectedWindows = [
      `1:claude:${homeDir}`,
      `2:codex:${homeDir}`,
      `3:agy:${homeDir}`,
    ];
    let actualWindows: string[] = [];
    for (let attempt = 0; attempt < 50; attempt++) {
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
      actualWindows = listWindows.stdout.trim().split("\n");
      if (actualWindows.join("\n") === expectedWindows.join("\n")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
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
      AGENTS_UPDATE_CMD: "true",
      AGENTS_LAPTOP_WINDOW_CMD: "true",
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
      AGENTS_UPDATE_CMD: "true",
      AGENTS_LAPTOP_WINDOW_CMD: "true",
    });
    assertEquals(res1.code, 0);

    // Second run targets the same socket
    const res2 = await run("bash", [AGENTS_SCRIPT, "-L", socketName], {
      TMUX_TMPDIR: tmpDir,
      AGENTS_UPDATE_CMD: "true",
      AGENTS_LAPTOP_WINDOW_CMD: "true",
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

Deno.test("agents.sh started twice at the same moment never fails with duplicate session", async () => {
  // The laptop and the tablet connecting at once must both succeed and share one session.
  for (let trial = 0; trial < 5; trial++) {
    await withThrowawayTmux(async (socketName, tmpDir) => {
      const env = {
        TMUX_TMPDIR: tmpDir,
        AGENTS_CLAUDE_CMD: "sleep 60",
        AGENTS_CODEX_CMD: "sleep 60",
        AGENTS_AGY_CMD: "sleep 60",
        AGENTS_UPDATE_CMD: "true",
        AGENTS_LAPTOP_WINDOW_CMD: "true",
      };
      const [first, second] = await Promise.all([
        run("bash", [AGENTS_SCRIPT, "-L", socketName, "--no-attach"], env),
        run("bash", [AGENTS_SCRIPT, "-L", socketName, "--no-attach"], env),
      ]);
      assertEquals(first.code, 0, `first run failed: ${first.stderr}`);
      assertEquals(second.code, 0, `second run failed: ${second.stderr}`);

      const sessions = await run("tmux", [
        "-L",
        socketName,
        "list-sessions",
        "-F",
        "#{session_name}",
      ], {
        TMUX_TMPDIR: tmpDir,
      });
      assertEquals(sessions.stdout.trim().split("\n"), ["agents"]);

      const windows = await run(
        "tmux",
        ["-L", socketName, "list-windows", "-t", "agents", "-F", "#{window_index}:#{window_name}"],
        { TMUX_TMPDIR: tmpDir },
      );
      assertEquals(windows.stdout.trim().split("\n"), ["1:claude", "2:codex", "3:agy"]);
    });
  }
});

Deno.test("agents.sh drops a tab to a plain shell when its agent exits instead of closing the tab", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    // Configure the claude tab to run an agent that exits immediately
    const res = await run("bash", [AGENTS_SCRIPT, "-L", socketName], {
      TMUX_TMPDIR: tmpDir,
      AGENTS_CLAUDE_CMD: "sh -c 'exit 0'",
      AGENTS_CODEX_CMD: "sleep 60",
      AGENTS_AGY_CMD: "sleep 60",
      AGENTS_UPDATE_CMD: "true",
      AGENTS_LAPTOP_WINDOW_CMD: "true",
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

Deno.test("agents run through its ~/.local/bin symlink passes the repo's claude-settings.json to claude (web-jam-tools#1176)", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    // install-hooks.sh links scripts/agents.sh as ~/.local/bin/agents; run it the same way.
    const binDir = `${tmpDir}/bin`;
    await Deno.mkdir(binDir);
    await Deno.symlink(AGENTS_SCRIPT, `${binDir}/agents`);
    // A fake claude that records the arguments it was started with.
    const argsOut = `${tmpDir}/claude-args.txt`;
    await Deno.writeTextFile(
      `${binDir}/claude`,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argsOut}"\n`,
    );
    await Deno.chmod(`${binDir}/claude`, 0o755);

    const res = await run(`${binDir}/agents`, ["-L", socketName, "--no-attach"], {
      TMUX_TMPDIR: tmpDir,
      PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
      AGENTS_CODEX_CMD: "sleep 60",
      AGENTS_AGY_CMD: "sleep 60",
      AGENTS_UPDATE_CMD: "true",
      AGENTS_LAPTOP_WINDOW_CMD: "true",
    });
    assertEquals(res.code, 0, res.stderr);

    let args = "";
    for (let i = 0; i < 30 && !args; i++) {
      try {
        args = await Deno.readTextFile(argsOut);
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assertEquals(args.trim().split("\n"), [
      "--settings",
      `${REPO_ROOT}scripts/claude-settings.json`,
    ]);
  });
});

Deno.test("agents started over SSH starts every tab without SSH_* variables, so agy keeps its keyring login", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    // Each tab records the SSH variables its agent command sees.
    const probe = (name: string) =>
      `echo "[$SSH_CONNECTION|$SSH_CLIENT|$SSH_TTY]" > ${tmpDir}/${name}.env; sleep 60`;
    const res = await run("bash", [AGENTS_SCRIPT, "-L", socketName, "--no-attach"], {
      TMUX_TMPDIR: tmpDir,
      SSH_CONNECTION: "100.85.167.74 43414 100.66.248.113 22",
      SSH_CLIENT: "100.85.167.74 43414 22",
      SSH_TTY: "/dev/pts/0",
      AGENTS_CLAUDE_CMD: probe("claude"),
      AGENTS_CODEX_CMD: probe("codex"),
      AGENTS_AGY_CMD: probe("agy"),
      AGENTS_UPDATE_CMD: "true",
      AGENTS_LAPTOP_WINDOW_CMD: "true",
    });
    assertEquals(res.code, 0, res.stderr);

    for (const name of ["claude", "codex", "agy"]) {
      let seen = "";
      for (let i = 0; i < 30 && !seen; i++) {
        try {
          seen = (await Deno.readTextFile(`${tmpDir}/${name}.env`)).trim();
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      assertEquals(seen, "[||]", `${name} tab saw SSH variables: ${seen}`);
    }
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
      AGENTS_UPDATE_CMD: "true",
      AGENTS_LAPTOP_WINDOW_CMD: "true",
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

Deno.test("agents.sh runs the update command before the new session exists, and not when it only attaches", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    const marker = `${tmpDir}/update-ran.txt`;
    // Records whether the `agents` session existed at the moment the update ran.
    const updateCmd = `sh -c 'if tmux -L ${socketName} has-session -t agents 2>/dev/null; ` +
      `then echo session-existed; else echo no-session-yet; fi >> "${marker}"'`;
    const env = {
      TMUX_TMPDIR: tmpDir,
      AGENTS_CLAUDE_CMD: "sleep 60",
      AGENTS_CODEX_CMD: "sleep 60",
      AGENTS_AGY_CMD: "sleep 60",
      AGENTS_UPDATE_CMD: updateCmd,
      AGENTS_LAPTOP_WINDOW_CMD: "true",
    };
    const res1 = await run("bash", [AGENTS_SCRIPT, "-L", socketName, "--no-attach"], env);
    assertEquals(res1.code, 0, res1.stderr);
    assertEquals((await Deno.readTextFile(marker)).trim().split("\n"), ["no-session-yet"]);

    // Second run only attaches, so the update command must not run again.
    const res2 = await run("bash", [AGENTS_SCRIPT, "-L", socketName, "--no-attach"], env);
    assertEquals(res2.code, 0, res2.stderr);
    assertEquals((await Deno.readTextFile(marker)).trim().split("\n"), ["no-session-yet"]);
  });
});

Deno.test("agents.sh still creates the session and exits 0, with a warning, when the update command fails", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    const res = await run("bash", [AGENTS_SCRIPT, "-L", socketName, "--no-attach"], {
      TMUX_TMPDIR: tmpDir,
      AGENTS_CLAUDE_CMD: "sleep 60",
      AGENTS_CODEX_CMD: "sleep 60",
      AGENTS_AGY_CMD: "sleep 60",
      AGENTS_UPDATE_CMD: "exit 1",
      AGENTS_LAPTOP_WINDOW_CMD: "true",
    });
    assertEquals(res.code, 0, res.stderr);
    assert(res.stderr.includes("warning: update-all failed"), `no warning in: ${res.stderr}`);
    const has = await run("tmux", ["-L", socketName, "has-session", "-t", "agents"], {
      TMUX_TMPDIR: tmpDir,
    });
    assertEquals(has.code, 0);
  });
});

// ---- Laptop window over SSH (web-jam-tools#1128) ----

const SSH_ENV = { SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22" };

function stubEnv(tmpDir: string, windowCmd: string, extra: Record<string, string> = {}) {
  return {
    TMUX_TMPDIR: tmpDir,
    AGENTS_CLAUDE_CMD: "sleep 60",
    AGENTS_CODEX_CMD: "sleep 60",
    AGENTS_AGY_CMD: "sleep 60",
    AGENTS_UPDATE_CMD: "true",
    AGENTS_LAPTOP_WINDOW_CMD: windowCmd,
    ...extra,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("agents.sh over SSH opens the laptop window when it creates the session", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    const marker = `${tmpDir}/window-ran.txt`;
    const res = await run(
      "bash",
      [AGENTS_SCRIPT, "-L", socketName, "--no-attach"],
      stubEnv(tmpDir, `touch "${marker}"`, SSH_ENV),
    );
    assertEquals(res.code, 0, res.stderr);
    assert(await exists(marker), "laptop-window stub did not run");
  });
});

Deno.test("agents.sh runs the laptop-window command without SSH_* variables so the window is not counted as an SSH client", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    const marker = `${tmpDir}/window-env.txt`;
    const cmd =
      `echo "\${SSH_CONNECTION:-none}:\${SSH_CLIENT:-none}:\${SSH_TTY:-none}" > "${marker}"`;
    const res = await run("bash", [AGENTS_SCRIPT, "-L", socketName, "--no-attach"], {
      ...stubEnv(tmpDir, cmd, SSH_ENV),
      SSH_CLIENT: "192.0.2.1 50000 22",
      SSH_TTY: "/dev/pts/9",
    });
    assertEquals(res.code, 0, res.stderr);
    assertEquals((await Deno.readTextFile(marker)).trim(), "none:none:none");
  });
});

Deno.test("agents.sh over SSH opens the laptop window when the session exists with no attached clients", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    const marker = `${tmpDir}/window-ran.txt`;
    const first = await run(
      "bash",
      [AGENTS_SCRIPT, "-L", socketName, "--no-attach"],
      stubEnv(tmpDir, "true"),
    );
    assertEquals(first.code, 0, first.stderr);
    assert(!(await exists(marker)));
    const res = await run(
      "bash",
      [AGENTS_SCRIPT, "-L", socketName, "--no-attach"],
      stubEnv(tmpDir, `touch "${marker}"`, SSH_ENV),
    );
    assertEquals(res.code, 0, res.stderr);
    assert(await exists(marker), "laptop-window stub did not run on the attach path");
  });
});

Deno.test("agents.sh without SSH_CONNECTION does not open the laptop window", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    const marker = `${tmpDir}/window-ran.txt`;
    const res = await run(
      "bash",
      ["-c", `unset SSH_CONNECTION; exec bash "${AGENTS_SCRIPT}" -L ${socketName} --no-attach`],
      stubEnv(tmpDir, `touch "${marker}"`),
    );
    assertEquals(res.code, 0, res.stderr);
    assert(!(await exists(marker)), "laptop-window stub ran without SSH_CONNECTION");
  });
});

Deno.test("agents.sh exits 0 and prints nothing when the laptop-window command fails", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    const res = await run(
      "bash",
      [AGENTS_SCRIPT, "-L", socketName, "--no-attach"],
      stubEnv(tmpDir, "exit 1", SSH_ENV),
    );
    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stderr, "");
  });
});

async function attachClient(socketName: string, tmpDir: string, ssh: boolean) {
  const proc = new Deno.Command("script", {
    args: ["-qc", `tmux -L ${socketName} attach -t agents`, "/dev/null"],
    stdin: "piped",
    stdout: "null",
    stderr: "null",
    env: { ...Deno.env.toObject(), TMUX_TMPDIR: tmpDir, TERM: "xterm", ...(ssh ? SSH_ENV : {}) },
    clearEnv: false,
  });
  // Deno cannot unset an inherited variable through `env`, so strip it through `env -u`.
  const wrapped = ssh ? proc : new Deno.Command("env", {
    args: [
      "-u",
      "SSH_CONNECTION",
      "script",
      "-qc",
      `tmux -L ${socketName} attach -t agents`,
      "/dev/null",
    ],
    stdin: "piped",
    stdout: "null",
    stderr: "null",
    env: { ...Deno.env.toObject(), TMUX_TMPDIR: tmpDir, TERM: "xterm" },
  });
  const child = wrapped.spawn();
  for (let i = 0; i < 50; i++) {
    const l = await run("tmux", ["-L", socketName, "list-clients", "-t", "agents"], {
      TMUX_TMPDIR: tmpDir,
    });
    if (l.stdout.trim()) return child;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error("throwaway tmux client never attached");
}

Deno.test("agents.sh skips the laptop window when a non-SSH tmux client is attached, and opens it when only an SSH client is", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    const first = await run(
      "bash",
      [AGENTS_SCRIPT, "-L", socketName, "--no-attach"],
      stubEnv(tmpDir, "true"),
    );
    assertEquals(first.code, 0, first.stderr);

    const sshClient = await attachClient(socketName, tmpDir, true);
    try {
      const marker = `${tmpDir}/ssh-only.txt`;
      const res = await run(
        "bash",
        [AGENTS_SCRIPT, "-L", socketName, "--no-attach"],
        stubEnv(tmpDir, `touch "${marker}"`, SSH_ENV),
      );
      assertEquals(res.code, 0, res.stderr);
      assert(await exists(marker), "stub should run when only an SSH client is attached");
    } finally {
      try {
        sshClient.kill();
      } catch { /* already gone */ }
      await run("tmux", ["-L", socketName, "detach-client", "-a"], { TMUX_TMPDIR: tmpDir });
    }
    await new Promise((r) => setTimeout(r, 300));

    const laptopClient = await attachClient(socketName, tmpDir, false);
    try {
      const marker = `${tmpDir}/laptop-present.txt`;
      const res = await run(
        "bash",
        [AGENTS_SCRIPT, "-L", socketName, "--no-attach"],
        stubEnv(tmpDir, `touch "${marker}"`, SSH_ENV),
      );
      assertEquals(res.code, 0, res.stderr);
      assert(!(await exists(marker)), "stub ran although a laptop client is attached");
    } finally {
      try {
        laptopClient.kill();
      } catch { /* already gone */ }
    }
  });
});

Deno.test("claude-settings.json configures prompt moment for permission_prompt and finished moment for Stop (web-jam-tools#1211)", async () => {
  const settingsText = await Deno.readTextFile(`${REPO_ROOT}scripts/claude-settings.json`);
  const settings = JSON.parse(settingsText);

  // Notification (permission_prompt) hook passes prompt moment
  const notificationHooks = settings.hooks?.Notification;
  assert(Array.isArray(notificationHooks), "expected hooks.Notification array");
  const promptEntry = notificationHooks.find((e: { matcher?: string }) =>
    e.matcher === "permission_prompt"
  );
  assert(promptEntry, "expected permission_prompt matcher entry in Notification");
  assertEquals(
    promptEntry.hooks?.[0]?.command,
    "$HOME/.claude/hooks/agent-alert.sh claude prompt",
  );

  // Stop hook passes finished moment
  const stopHooks = settings.hooks?.Stop;
  assert(Array.isArray(stopHooks), "expected hooks.Stop array");
  assertEquals(
    stopHooks[0]?.hooks?.[0]?.command,
    "$HOME/.claude/hooks/agent-alert.sh claude finished",
  );
});

Deno.test("agents starts codex with overrides passing prompt moment for PermissionRequest and finished moment for notify (web-jam-tools#1211)", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    const binDir = `${tmpDir}/bin`;
    await Deno.mkdir(binDir);
    // A fake codex that records the arguments it was started with.
    const argsOut = `${tmpDir}/codex-args.txt`;
    await Deno.writeTextFile(
      `${binDir}/codex`,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argsOut}"\n`,
    );
    await Deno.chmod(`${binDir}/codex`, 0o755);

    const res = await run("bash", [AGENTS_SCRIPT, "-L", socketName, "--no-attach"], {
      TMUX_TMPDIR: tmpDir,
      PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
      AGENTS_CLAUDE_CMD: "sleep 60",
      AGENTS_AGY_CMD: "sleep 60",
      AGENTS_UPDATE_CMD: "true",
      AGENTS_LAPTOP_WINDOW_CMD: "true",
    });
    assertEquals(res.code, 0, res.stderr);

    let args = "";
    for (let i = 0; i < 30 && !args; i++) {
      try {
        args = await Deno.readTextFile(argsOut);
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const lines = args.trim().split("\n");
    const home = Deno.env.get("HOME")!;
    assert(
      lines.includes("-c") && lines.includes(
        `hooks.PermissionRequest=[{matcher=".*",hooks=[{type="command",command="${home}/.claude/hooks/agent-alert.sh codex prompt"}]}]`,
      ),
      `expected PermissionRequest override with prompt moment in: ${args}`,
    );
    assert(
      lines.includes("-c") && lines.includes(
        `notify=["${home}/.claude/hooks/agent-alert.sh", "codex", "finished"]`,
      ),
      `expected notify override with finished moment in: ${args}`,
    );
  });
});
