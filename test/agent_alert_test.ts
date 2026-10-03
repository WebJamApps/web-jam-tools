// test/agent_alert_test.ts — web-jam-tools#1176, web-jam-tools#1211
//
// Drives scripts/agent-alert.sh with a fake curl on PATH and a throwaway tmux server (tmux -L).
// Verifies all acceptance criteria cases and the in-pane exercise check:
// 1. alerts for session `agents` + tab `codex` + argument `codex` + moment `prompt`
// 2. marks tab silently and sends no notification for moment `finished`
// 3. defaults to `finished`, marks tab, sends no notification, and warns on stderr when moment is missing or unknown
// 4. silent with `TMUX_PANE` unset
// 5. silent in session `other`
// 6. silent for argument `agy` in tab `claude`
// 7. silent for Codex first input `Generate a concise, single-line task title of at most 36 characters and under five words`
// 8. exits 0 when `curl` times out or fails
// 9. mark clears on tab switch
// 10. notification body is exactly `<Agent> is waiting for you`
// 11. exercises the change itself: run claude finished and prompt inside agents session claude tab

import { assert, assertEquals } from "@std/assert";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const ALERT_SCRIPT = `${REPO_ROOT}scripts/agent-alert.sh`;
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
    stdin: "null",
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

// Codex's `notify` appends its agent-turn-complete JSON as the final argv
// argument with stdin set to null (codex-rs/hooks/src/legacy_notify.rs).
function codexNotifyJson(...inputMessages: string[]): string {
  return JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "test-thread",
    "turn-id": "1",
    cwd: "/tmp",
    "input-messages": inputMessages,
    "last-assistant-message": "done",
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function withThrowawayTmux(
  fn: (socketName: string, tmpDir: string, fakeBinDir: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: "agent-alert-test-" });
  const fakeBinDir = `${tmpDir}/bin`;
  await Deno.mkdir(fakeBinDir, { recursive: true });
  const socketName = `test-${crypto.randomUUID().slice(0, 8)}`;

  // Fake curl recording arguments and payload to a file specified by CURL_OUT.
  const fakeCurl = `${fakeBinDir}/curl`;
  await Deno.writeTextFile(
    fakeCurl,
    `#!/usr/bin/env bash
if [ -n "\${FAKE_CURL_EXIT_CODE:-}" ]; then
  exit "\$FAKE_CURL_EXIT_CODE"
fi
BODY=""
HEADERS=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-d" ]; then
    shift
    BODY="$1"
  elif [ "$1" = "-H" ]; then
    shift
    HEADERS="\${HEADERS} -H $1"
  fi
  shift
done
if [ -n "\${CURL_OUT:-}" ]; then
  printf "%s" "$BODY" > "$CURL_OUT"
fi
if [ -n "\${CURL_ARGS_OUT:-}" ]; then
  printf "%s" "\${HEADERS# }" > "$CURL_ARGS_OUT"
fi
exit 0
`,
  );
  await Deno.chmod(fakeCurl, 0o755);

  try {
    await fn(socketName, tmpDir, fakeBinDir);
  } finally {
    await run("tmux", ["-L", socketName, "kill-server"], { TMUX_TMPDIR: tmpDir });
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

Deno.test("alerts for session 'agents' + tab 'codex' + argument 'codex' + moment 'prompt' + first input 'Run the shell command: touch x'", async () => {
  await withThrowawayTmux(async (socketName, tmpDir, fakeBinDir) => {
    // Start agents session with tabs claude (1) and codex (2)
    await run("tmux", [
      "-L",
      socketName,
      "new-session",
      "-d",
      "-s",
      "agents",
      "-n",
      "claude",
      "sleep 60",
    ], {
      TMUX_TMPDIR: tmpDir,
    });
    await run("tmux", ["-L", socketName, "set", "-t", "agents", "base-index", "1"], {
      TMUX_TMPDIR: tmpDir,
    });
    await run(
      "tmux",
      ["-L", socketName, "new-window", "-t", "agents:2", "-n", "codex", "sleep 60"],
      {
        TMUX_TMPDIR: tmpDir,
      },
    );
    await run("tmux", ["-L", socketName, "select-window", "-t", "agents:1"], {
      TMUX_TMPDIR: tmpDir,
    });

    const paneRes = await run(
      "tmux",
      ["-L", socketName, "list-panes", "-t", "agents:codex", "-F", "#{pane_id}"],
      { TMUX_TMPDIR: tmpDir },
    );
    const paneId = paneRes.stdout.trim();
    assert(paneId.length > 0, "expected valid pane ID");

    const curlOut = `${tmpDir}/curl_alert.txt`;
    const curlArgsOut = `${tmpDir}/curl_args.txt`;
    const res = await run(
      "bash",
      [ALERT_SCRIPT, "codex", "prompt", codexNotifyJson("Run the shell command: touch x")],
      {
        TMUX_PANE: paneId,
        TMUX_SOCKET: socketName,
        TMUX_TMPDIR: tmpDir,
        PATH: `${fakeBinDir}:${Deno.env.get("PATH") ?? ""}`,
        CURL_OUT: curlOut,
        CURL_ARGS_OUT: curlArgsOut,
        HOME: tmpDir,
      },
    );
    assertEquals(res.code, 0, `agent-alert.sh failed: ${res.stderr}`);

    // Verify tab mark in tmux: @waiting is 1
    const waitingRes = await run(
      "tmux",
      ["-L", socketName, "show", "-w", "-t", "agents:codex", "-v", "@waiting"],
      { TMUX_TMPDIR: tmpDir },
    );
    assertEquals(waitingRes.stdout.trim(), "1");

    // Verify notification was sent
    assert(await pathExists(curlOut), "curl should have been called");
    const body = await Deno.readTextFile(curlOut);
    assertEquals(body, "Codex is waiting for you");

    // Verify Priority header is included
    assert(await pathExists(curlArgsOut), "curl args should have been captured");
    const args = await Deno.readTextFile(curlArgsOut);
    assert(args.includes("-H Priority: high"), "curl should include Priority: high header");

    // The generated ntfy topic file is private to the user.
    const topicInfo = await Deno.stat(`${tmpDir}/.config/agent-alerts/ntfy-topic`);
    assertEquals(
      (topicInfo.mode ?? 0) & 0o077,
      0,
      "topic file must not be readable by group/others",
    );
  });
});

Deno.test("marks tab silently and sends no notification for moment 'finished'", async () => {
  await withThrowawayTmux(async (socketName, tmpDir, fakeBinDir) => {
    await run("tmux", [
      "-L",
      socketName,
      "new-session",
      "-d",
      "-s",
      "agents",
      "-n",
      "claude",
      "sleep 60",
    ], { TMUX_TMPDIR: tmpDir });
    await run("tmux", ["-L", socketName, "set", "-t", "agents", "base-index", "1"], {
      TMUX_TMPDIR: tmpDir,
    });
    await run(
      "tmux",
      ["-L", socketName, "new-window", "-t", "agents:2", "-n", "codex", "sleep 60"],
      { TMUX_TMPDIR: tmpDir },
    );
    const paneRes = await run(
      "tmux",
      ["-L", socketName, "list-panes", "-t", "agents:codex", "-F", "#{pane_id}"],
      { TMUX_TMPDIR: tmpDir },
    );
    const paneId = paneRes.stdout.trim();

    const curlOut = `${tmpDir}/curl_finished.txt`;
    const res = await run(
      "bash",
      [ALERT_SCRIPT, "codex", "finished", codexNotifyJson("Run the shell command: touch x")],
      {
        TMUX_PANE: paneId,
        TMUX_SOCKET: socketName,
        TMUX_TMPDIR: tmpDir,
        PATH: `${fakeBinDir}:${Deno.env.get("PATH") ?? ""}`,
        CURL_OUT: curlOut,
        HOME: tmpDir,
      },
    );
    assertEquals(res.code, 0, `agent-alert.sh failed: ${res.stderr}`);
    assertEquals(res.stderr, "");

    // Verify tab mark in tmux: @waiting is 1
    const waitingRes = await run(
      "tmux",
      ["-L", socketName, "show", "-w", "-t", "agents:codex", "-v", "@waiting"],
      { TMUX_TMPDIR: tmpDir },
    );
    assertEquals(waitingRes.stdout.trim(), "1");

    // Verify notification was NOT sent
    assert(!(await pathExists(curlOut)), "curl should not have been called for finished moment");
  });
});

Deno.test("defaults to 'finished', marks tab, sends no notification, and warns on stderr when moment is missing", async () => {
  await withThrowawayTmux(async (socketName, tmpDir, fakeBinDir) => {
    await run("tmux", [
      "-L",
      socketName,
      "new-session",
      "-d",
      "-s",
      "agents",
      "-n",
      "codex",
      "sleep 60",
    ], { TMUX_TMPDIR: tmpDir });
    const paneId = (await run(
      "tmux",
      ["-L", socketName, "list-panes", "-t", "agents:codex", "-F", "#{pane_id}"],
      { TMUX_TMPDIR: tmpDir },
    )).stdout.trim();

    const curlOut = `${tmpDir}/curl_missing.txt`;
    const res = await run(
      "bash",
      [ALERT_SCRIPT, "codex"],
      {
        TMUX_PANE: paneId,
        TMUX_SOCKET: socketName,
        TMUX_TMPDIR: tmpDir,
        PATH: `${fakeBinDir}:${Deno.env.get("PATH") ?? ""}`,
        CURL_OUT: curlOut,
        HOME: tmpDir,
      },
    );
    assertEquals(res.code, 0);
    assertEquals(
      res.stderr,
      "warning: agent-alert.sh: missing or unknown moment '' (expected 'prompt' or 'finished') — defaulting to finished\n",
    );

    const waitingRes = await run(
      "tmux",
      ["-L", socketName, "show", "-w", "-t", "agents:codex", "-v", "@waiting"],
      { TMUX_TMPDIR: tmpDir },
    );
    assertEquals(waitingRes.stdout.trim(), "1");
    assert(
      !(await pathExists(curlOut)),
      "curl should not have been called when defaulting to finished",
    );
  });
});

Deno.test("defaults to 'finished', marks tab, sends no notification, and warns on stderr when moment is unknown", async () => {
  await withThrowawayTmux(async (socketName, tmpDir, fakeBinDir) => {
    await run("tmux", [
      "-L",
      socketName,
      "new-session",
      "-d",
      "-s",
      "agents",
      "-n",
      "codex",
      "sleep 60",
    ], { TMUX_TMPDIR: tmpDir });
    const paneId = (await run(
      "tmux",
      ["-L", socketName, "list-panes", "-t", "agents:codex", "-F", "#{pane_id}"],
      { TMUX_TMPDIR: tmpDir },
    )).stdout.trim();

    const curlOut = `${tmpDir}/curl_unknown.txt`;
    const res = await run(
      "bash",
      [ALERT_SCRIPT, "codex", "unexpected"],
      {
        TMUX_PANE: paneId,
        TMUX_SOCKET: socketName,
        TMUX_TMPDIR: tmpDir,
        PATH: `${fakeBinDir}:${Deno.env.get("PATH") ?? ""}`,
        CURL_OUT: curlOut,
        HOME: tmpDir,
      },
    );
    assertEquals(res.code, 0);
    assertEquals(
      res.stderr,
      "warning: agent-alert.sh: missing or unknown moment 'unexpected' (expected 'prompt' or 'finished') — defaulting to finished\n",
    );

    const waitingRes = await run(
      "tmux",
      ["-L", socketName, "show", "-w", "-t", "agents:codex", "-v", "@waiting"],
      { TMUX_TMPDIR: tmpDir },
    );
    assertEquals(waitingRes.stdout.trim(), "1");
    assert(
      !(await pathExists(curlOut)),
      "curl should not have been called when defaulting to finished",
    );
  });
});

Deno.test("silent with TMUX_PANE unset", async () => {
  await withThrowawayTmux(async (_socketName, tmpDir, fakeBinDir) => {
    const curlOut = `${tmpDir}/curl_unset.txt`;
    const res = await run(
      "bash",
      [ALERT_SCRIPT, "codex", "prompt", codexNotifyJson("Run the shell command: touch x")],
      {
        TMUX_PANE: "",
        PATH: `${fakeBinDir}:${Deno.env.get("PATH") ?? ""}`,
        CURL_OUT: curlOut,
        HOME: tmpDir,
      },
    );
    assertEquals(res.code, 0);
    assert(!(await pathExists(curlOut)), "should be silent when TMUX_PANE is unset");
  });
});

Deno.test("silent in session 'other'", async () => {
  await withThrowawayTmux(async (socketName, tmpDir, fakeBinDir) => {
    await run("tmux", [
      "-L",
      socketName,
      "new-session",
      "-d",
      "-s",
      "other",
      "-n",
      "codex",
      "sleep 60",
    ], {
      TMUX_TMPDIR: tmpDir,
    });
    const paneRes = await run(
      "tmux",
      ["-L", socketName, "list-panes", "-t", "other:codex", "-F", "#{pane_id}"],
      { TMUX_TMPDIR: tmpDir },
    );
    const paneId = paneRes.stdout.trim();

    const curlOut = `${tmpDir}/curl_other.txt`;
    const res = await run(
      "bash",
      [ALERT_SCRIPT, "codex", "prompt", codexNotifyJson("Run the shell command: touch x")],
      {
        TMUX_PANE: paneId,
        TMUX_SOCKET: socketName,
        TMUX_TMPDIR: tmpDir,
        PATH: `${fakeBinDir}:${Deno.env.get("PATH") ?? ""}`,
        CURL_OUT: curlOut,
        HOME: tmpDir,
      },
    );
    assertEquals(res.code, 0);
    assert(!(await pathExists(curlOut)), "should be silent for session other");

    const waitingRes = await run(
      "tmux",
      ["-L", socketName, "show", "-w", "-t", "other:codex", "-v", "@waiting"],
      { TMUX_TMPDIR: tmpDir },
    );
    assertEquals(waitingRes.stdout.trim(), "");
  });
});

Deno.test("silent for argument 'agy' in tab 'claude'", async () => {
  await withThrowawayTmux(async (socketName, tmpDir, fakeBinDir) => {
    await run("tmux", [
      "-L",
      socketName,
      "new-session",
      "-d",
      "-s",
      "agents",
      "-n",
      "claude",
      "sleep 60",
    ], {
      TMUX_TMPDIR: tmpDir,
    });
    const paneRes = await run(
      "tmux",
      ["-L", socketName, "list-panes", "-t", "agents:claude", "-F", "#{pane_id}"],
      { TMUX_TMPDIR: tmpDir },
    );
    const paneId = paneRes.stdout.trim();

    const curlOut = `${tmpDir}/curl_mismatch.txt`;
    const res = await run(
      "bash",
      [ALERT_SCRIPT, "agy", "prompt"],
      {
        TMUX_PANE: paneId,
        TMUX_SOCKET: socketName,
        TMUX_TMPDIR: tmpDir,
        PATH: `${fakeBinDir}:${Deno.env.get("PATH") ?? ""}`,
        CURL_OUT: curlOut,
        HOME: tmpDir,
      },
    );
    assertEquals(res.code, 0);
    assert(!(await pathExists(curlOut)), "should be silent when tab name does not match argument");

    const waitingRes = await run(
      "tmux",
      ["-L", socketName, "show", "-w", "-t", "agents:claude", "-v", "@waiting"],
      { TMUX_TMPDIR: tmpDir },
    );
    assertEquals(waitingRes.stdout.trim(), "");
  });
});

Deno.test(
  "silent for Codex first input 'Generate a concise, single-line task title of at most 36 characters and under five words'",
  async () => {
    await withThrowawayTmux(async (socketName, tmpDir, fakeBinDir) => {
      await run("tmux", [
        "-L",
        socketName,
        "new-session",
        "-d",
        "-s",
        "agents",
        "-n",
        "codex",
        "sleep 60",
      ], {
        TMUX_TMPDIR: tmpDir,
      });
      const paneRes = await run(
        "tmux",
        ["-L", socketName, "list-panes", "-t", "agents:codex", "-F", "#{pane_id}"],
        { TMUX_TMPDIR: tmpDir },
      );
      const paneId = paneRes.stdout.trim();

      const curlOut = `${tmpDir}/curl_codex_title.txt`;
      const titleJson = codexNotifyJson(
        "Generate a concise, single-line task title of at most 36 characters and under five words",
      );

      // Verify finished moment is silent
      const resFinished = await run(
        "bash",
        [ALERT_SCRIPT, "codex", "finished", titleJson],
        {
          TMUX_PANE: paneId,
          TMUX_SOCKET: socketName,
          TMUX_TMPDIR: tmpDir,
          PATH: `${fakeBinDir}:${Deno.env.get("PATH") ?? ""}`,
          CURL_OUT: curlOut,
          HOME: tmpDir,
        },
      );
      assertEquals(resFinished.code, 0);
      assert(
        !(await pathExists(curlOut)),
        "should be silent for Codex title-writing step on finished moment",
      );

      let waitingRes = await run(
        "tmux",
        ["-L", socketName, "show", "-w", "-t", "agents:codex", "-v", "@waiting"],
        { TMUX_TMPDIR: tmpDir },
      );
      assertEquals(waitingRes.stdout.trim(), "");

      // Verify prompt moment is also silent
      const resPrompt = await run(
        "bash",
        [ALERT_SCRIPT, "codex", "prompt", titleJson],
        {
          TMUX_PANE: paneId,
          TMUX_SOCKET: socketName,
          TMUX_TMPDIR: tmpDir,
          PATH: `${fakeBinDir}:${Deno.env.get("PATH") ?? ""}`,
          CURL_OUT: curlOut,
          HOME: tmpDir,
        },
      );
      assertEquals(resPrompt.code, 0);
      assert(
        !(await pathExists(curlOut)),
        "should be silent for Codex title-writing step on prompt moment",
      );

      waitingRes = await run(
        "tmux",
        ["-L", socketName, "show", "-w", "-t", "agents:codex", "-v", "@waiting"],
        { TMUX_TMPDIR: tmpDir },
      );
      assertEquals(waitingRes.stdout.trim(), "");
    });
  },
);

Deno.test("alerts when the title text is not Codex's first input message", async () => {
  await withThrowawayTmux(async (socketName, tmpDir, fakeBinDir) => {
    await run("tmux", [
      "-L",
      socketName,
      "new-session",
      "-d",
      "-s",
      "agents",
      "-n",
      "codex",
      "sleep 60",
    ], {
      TMUX_TMPDIR: tmpDir,
    });
    const paneId = (await run(
      "tmux",
      ["-L", socketName, "list-panes", "-t", "agents:codex", "-F", "#{pane_id}"],
      { TMUX_TMPDIR: tmpDir },
    )).stdout.trim();

    const curlOut = `${tmpDir}/curl_codex_later.txt`;
    const res = await run(
      "bash",
      [
        ALERT_SCRIPT,
        "codex",
        "prompt",
        codexNotifyJson(
          "Run the shell command: touch x",
          "Generate a concise, single-line task title",
        ),
      ],
      {
        TMUX_PANE: paneId,
        TMUX_SOCKET: socketName,
        TMUX_TMPDIR: tmpDir,
        PATH: `${fakeBinDir}:${Deno.env.get("PATH") ?? ""}`,
        CURL_OUT: curlOut,
        HOME: tmpDir,
      },
    );
    assertEquals(res.code, 0);
    assertEquals(await Deno.readTextFile(curlOut), "Codex is waiting for you");
  });
});

Deno.test("exits 0 when curl times out or fails", async () => {
  await withThrowawayTmux(async (socketName, tmpDir, fakeBinDir) => {
    await run("tmux", [
      "-L",
      socketName,
      "new-session",
      "-d",
      "-s",
      "agents",
      "-n",
      "codex",
      "sleep 60",
    ], {
      TMUX_TMPDIR: tmpDir,
    });
    const paneRes = await run(
      "tmux",
      ["-L", socketName, "list-panes", "-t", "agents:codex", "-F", "#{pane_id}"],
      { TMUX_TMPDIR: tmpDir },
    );
    const paneId = paneRes.stdout.trim();

    // Test curl timeout (exit 28)
    const resTimeout = await run(
      "bash",
      [ALERT_SCRIPT, "codex", "prompt", codexNotifyJson("Run the shell command: touch x")],
      {
        TMUX_PANE: paneId,
        TMUX_SOCKET: socketName,
        TMUX_TMPDIR: tmpDir,
        PATH: `${fakeBinDir}:${Deno.env.get("PATH") ?? ""}`,
        FAKE_CURL_EXIT_CODE: "28",
        HOME: tmpDir,
      },
    );
    assertEquals(resTimeout.code, 0, "must exit 0 on curl timeout");

    // Test curl connection failure (exit 7)
    const resFailed = await run(
      "bash",
      [ALERT_SCRIPT, "codex", "prompt", codexNotifyJson("Run the shell command: touch x")],
      {
        TMUX_PANE: paneId,
        TMUX_SOCKET: socketName,
        TMUX_TMPDIR: tmpDir,
        PATH: `${fakeBinDir}:${Deno.env.get("PATH") ?? ""}`,
        FAKE_CURL_EXIT_CODE: "7",
        HOME: tmpDir,
      },
    );
    assertEquals(resFailed.code, 0, "must exit 0 on curl failure");
  });
});

Deno.test("mark clears on tab switch", async () => {
  await withThrowawayTmux(async (socketName, tmpDir, _fakeBinDir) => {
    await run("tmux", [
      "-L",
      socketName,
      "new-session",
      "-d",
      "-s",
      "agents",
      "-n",
      "claude",
      "sleep 60",
    ], {
      TMUX_TMPDIR: tmpDir,
    });
    await run("tmux", ["-L", socketName, "set", "-t", "agents", "base-index", "1"], {
      TMUX_TMPDIR: tmpDir,
    });
    await run(
      "tmux",
      ["-L", socketName, "new-window", "-t", "agents:2", "-n", "codex", "sleep 60"],
      {
        TMUX_TMPDIR: tmpDir,
      },
    );
    await run("tmux", ["-L", socketName, "select-window", "-t", "agents:1"], {
      TMUX_TMPDIR: tmpDir,
    });
    await run("tmux", [
      "-L",
      socketName,
      "set-hook",
      "-t",
      "agents",
      "after-select-window",
      "set -w -u @waiting",
    ], {
      TMUX_TMPDIR: tmpDir,
    });

    // Mark tab 2 (codex)
    await run("tmux", ["-L", socketName, "set", "-w", "-t", "agents:2", "@waiting", "1"], {
      TMUX_TMPDIR: tmpDir,
    });
    const beforeRes = await run(
      "tmux",
      ["-L", socketName, "show", "-w", "-t", "agents:2", "-v", "@waiting"],
      { TMUX_TMPDIR: tmpDir },
    );
    assertEquals(beforeRes.stdout.trim(), "1");

    // Switch to tab 2 (codex)
    await run("tmux", ["-L", socketName, "select-window", "-t", "agents:2"], {
      TMUX_TMPDIR: tmpDir,
    });

    // Verify @waiting is cleared
    const afterRes = await run(
      "tmux",
      ["-L", socketName, "show", "-w", "-t", "agents:2", "-v", "@waiting"],
      { TMUX_TMPDIR: tmpDir },
    );
    assertEquals(afterRes.stdout.trim(), "");
  });
});

Deno.test("notification body is exactly '<Agent> is waiting for you'", async () => {
  await withThrowawayTmux(async (socketName, tmpDir, fakeBinDir) => {
    await run("tmux", [
      "-L",
      socketName,
      "new-session",
      "-d",
      "-s",
      "agents",
      "-n",
      "codex",
      "sleep 60",
    ], {
      TMUX_TMPDIR: tmpDir,
    });
    const paneRes = await run(
      "tmux",
      ["-L", socketName, "list-panes", "-t", "agents:codex", "-F", "#{pane_id}"],
      { TMUX_TMPDIR: tmpDir },
    );
    const paneId = paneRes.stdout.trim();

    const curlOut = `${tmpDir}/curl_body.txt`;
    const res = await run(
      "bash",
      [ALERT_SCRIPT, "codex", "prompt"],
      {
        TMUX_PANE: paneId,
        TMUX_SOCKET: socketName,
        TMUX_TMPDIR: tmpDir,
        PATH: `${fakeBinDir}:${Deno.env.get("PATH") ?? ""}`,
        CURL_OUT: curlOut,
        HOME: tmpDir,
      },
    );
    assertEquals(res.code, 0);
    const body = await Deno.readTextFile(curlOut);
    assertEquals(body, "Codex is waiting for you");

    // Also verify claude and agy body forms
    await run(
      "tmux",
      ["-L", socketName, "new-window", "-t", "agents", "-n", "claude", "sleep 60"],
      {
        TMUX_TMPDIR: tmpDir,
      },
    );
    const claudePane = (await run(
      "tmux",
      ["-L", socketName, "list-panes", "-t", "agents:claude", "-F", "#{pane_id}"],
      { TMUX_TMPDIR: tmpDir },
    )).stdout.trim();
    const claudeCurlOut = `${tmpDir}/curl_claude.txt`;
    await run(
      "bash",
      [ALERT_SCRIPT, "claude", "prompt"],
      {
        TMUX_PANE: claudePane,
        TMUX_SOCKET: socketName,
        TMUX_TMPDIR: tmpDir,
        PATH: `${fakeBinDir}:${Deno.env.get("PATH") ?? ""}`,
        CURL_OUT: claudeCurlOut,
        HOME: tmpDir,
      },
    );
    assertEquals(await Deno.readTextFile(claudeCurlOut), "Claude is waiting for you");

    await run("tmux", ["-L", socketName, "new-window", "-t", "agents", "-n", "agy", "sleep 60"], {
      TMUX_TMPDIR: tmpDir,
    });
    const agyPane = (await run(
      "tmux",
      ["-L", socketName, "list-panes", "-t", "agents:agy", "-F", "#{pane_id}"],
      { TMUX_TMPDIR: tmpDir },
    )).stdout.trim();
    const agyCurlOut = `${tmpDir}/curl_agy.txt`;
    await run(
      "bash",
      [ALERT_SCRIPT, "agy", "prompt"],
      {
        TMUX_PANE: agyPane,
        TMUX_SOCKET: socketName,
        TMUX_TMPDIR: tmpDir,
        PATH: `${fakeBinDir}:${Deno.env.get("PATH") ?? ""}`,
        CURL_OUT: agyCurlOut,
        HOME: tmpDir,
      },
    );
    assertEquals(await Deno.readTextFile(agyCurlOut), "agy is waiting for you");
  });
});

Deno.test(
  "exercises the change itself: run scripts/agent-alert.sh claude finished and prompt inside agents session claude tab",
  async () => {
    await withThrowawayTmux(async (socketName, tmpDir, fakeBinDir) => {
      // Create session using scripts/agents.sh (claude drops to shell immediately)
      const initRes = await run("bash", [AGENTS_SCRIPT, "-L", socketName, "--no-attach"], {
        TMUX_TMPDIR: tmpDir,
        AGENTS_CLAUDE_CMD: "true",
        AGENTS_CODEX_CMD: "sleep 60",
        AGENTS_AGY_CMD: "sleep 60",
        AGENTS_UPDATE_CMD: "true",
        AGENTS_LAPTOP_WINDOW_CMD: "true",
        HOME: tmpDir,
      });
      assertEquals(initRes.code, 0, `agents.sh failed: ${initRes.stderr}`);

      // Ensure tab mark is cleared before test
      await run("tmux", ["-L", socketName, "set", "-w", "-t", "agents:claude", "-u", "@waiting"], {
        TMUX_TMPDIR: tmpDir,
      });

      const curlOutFinished = `${tmpDir}/in_pane_curl_finished.txt`;
      // 1. Run agent-alert.sh claude finished directly from inside the claude tab
      const finishedCmd =
        `PATH="${fakeBinDir}:$PATH" CURL_OUT="${curlOutFinished}" HOME="${tmpDir}" bash "${ALERT_SCRIPT}" claude finished; echo finished-done > "${tmpDir}/finished-done.txt"`;
      await run(
        "tmux",
        ["-L", socketName, "send-keys", "-t", "agents:claude", finishedCmd, "C-m"],
        { TMUX_TMPDIR: tmpDir },
      );

      // Wait up to 3 seconds for finished command to complete
      let finishedDone = false;
      for (let i = 0; i < 30; i++) {
        if (await pathExists(`${tmpDir}/finished-done.txt`)) {
          finishedDone = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(finishedDone, "expected finished command to complete");

      // Verify tab is marked
      const waitingFinished = await run(
        "tmux",
        ["-L", socketName, "show", "-w", "-t", "agents:claude", "-v", "@waiting"],
        { TMUX_TMPDIR: tmpDir },
      );
      assertEquals(waitingFinished.stdout.trim(), "1");

      // Verify no ntfy request was sent
      assert(!(await pathExists(curlOutFinished)), "finished moment must not make ntfy request");

      // Clear the tab mark
      await run("tmux", ["-L", socketName, "set", "-w", "-t", "agents:claude", "-u", "@waiting"], {
        TMUX_TMPDIR: tmpDir,
      });

      // 2. Run agent-alert.sh claude prompt directly from inside the claude tab
      const curlOutPrompt = `${tmpDir}/in_pane_curl_prompt.txt`;
      const curlArgsPrompt = `${tmpDir}/in_pane_curl_args_prompt.txt`;
      const promptCmd =
        `PATH="${fakeBinDir}:$PATH" CURL_OUT="${curlOutPrompt}" CURL_ARGS_OUT="${curlArgsPrompt}" HOME="${tmpDir}" bash "${ALERT_SCRIPT}" claude prompt`;
      await run(
        "tmux",
        ["-L", socketName, "send-keys", "-t", "agents:claude", promptCmd, "C-m"],
        { TMUX_TMPDIR: tmpDir },
      );

      // Wait up to 3 seconds for curlOutPrompt to appear
      let foundPrompt = false;
      for (let i = 0; i < 30; i++) {
        if (await pathExists(curlOutPrompt)) {
          foundPrompt = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(foundPrompt, "expected fake curl output from inside the claude tab for prompt moment");

      const body = await Deno.readTextFile(curlOutPrompt);
      assertEquals(body, "Claude is waiting for you");

      const args = await Deno.readTextFile(curlArgsPrompt);
      assert(args.includes("-H Priority: high"), "prompt curl must include Priority: high header");

      // Verify tab is marked
      const waitingPrompt = await run(
        "tmux",
        ["-L", socketName, "show", "-w", "-t", "agents:claude", "-v", "@waiting"],
        { TMUX_TMPDIR: tmpDir },
      );
      assertEquals(waitingPrompt.stdout.trim(), "1");
    });
  },
);
