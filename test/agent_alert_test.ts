// test/agent_alert_test.ts — web-jam-tools#1176
//
// Drives scripts/agent-alert.sh with a fake curl on PATH and a throwaway tmux server (tmux -L).
// Verifies all 8 acceptance criteria cases and the in-pane exercise check:
// 1. alerts for session `agents` + tab `codex` + argument `codex` + first input `Run the shell command: touch x`
// 2. silent with `TMUX_PANE` unset
// 3. silent in session `other`
// 4. silent for argument `agy` in tab `claude`
// 5. silent for Codex first input `Generate a concise, single-line task title of at most 36 characters and under five words`
// 6. exits 0 when `curl` times out or fails
// 7. mark clears on tab switch
// 8. notification body is exactly `Codex is waiting for you`
// 9. exercises the change itself: run from inside a throwaway agents tmux session's codex tab

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
  stdinText?: string,
): Promise<RunResult> {
  const command = new Deno.Command(cmd, {
    args,
    stdin: stdinText !== undefined ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
    env: env ? { ...Deno.env.toObject(), ...env } : undefined,
  });

  if (stdinText !== undefined) {
    const child = command.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdinText));
    await writer.close();
    const { code, stdout, stderr } = await child.output();
    return {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  }

  const { code, stdout, stderr } = await command.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
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
while [ $# -gt 0 ]; do
  if [ "$1" = "-d" ]; then
    shift
    BODY="$1"
  fi
  shift
done
if [ -n "$BODY" ] && [ -n "\${CURL_OUT:-}" ]; then
  printf "%s" "$BODY" > "$CURL_OUT"
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

Deno.test("alerts for session 'agents' + tab 'codex' + argument 'codex' + first input 'Run the shell command: touch x'", async () => {
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
      "Run the shell command: touch x\n",
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
  });
});

Deno.test("silent with TMUX_PANE unset", async () => {
  await withThrowawayTmux(async (_socketName, tmpDir, fakeBinDir) => {
    const curlOut = `${tmpDir}/curl_unset.txt`;
    const res = await run(
      "bash",
      [ALERT_SCRIPT, "codex"],
      {
        TMUX_PANE: "",
        PATH: `${fakeBinDir}:${Deno.env.get("PATH") ?? ""}`,
        CURL_OUT: curlOut,
        HOME: tmpDir,
      },
      "Run the shell command: touch x\n",
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
      [ALERT_SCRIPT, "codex"],
      {
        TMUX_PANE: paneId,
        TMUX_SOCKET: socketName,
        TMUX_TMPDIR: tmpDir,
        PATH: `${fakeBinDir}:${Deno.env.get("PATH") ?? ""}`,
        CURL_OUT: curlOut,
        HOME: tmpDir,
      },
      "Run the shell command: touch x\n",
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
      [ALERT_SCRIPT, "agy"],
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
        "Generate a concise, single-line task title of at most 36 characters and under five words\n",
      );
      assertEquals(res.code, 0);
      assert(!(await pathExists(curlOut)), "should be silent for Codex title-writing step");

      const waitingRes = await run(
        "tmux",
        ["-L", socketName, "show", "-w", "-t", "agents:codex", "-v", "@waiting"],
        { TMUX_TMPDIR: tmpDir },
      );
      assertEquals(waitingRes.stdout.trim(), "");
    });
  },
);

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
      [ALERT_SCRIPT, "codex"],
      {
        TMUX_PANE: paneId,
        TMUX_SOCKET: socketName,
        TMUX_TMPDIR: tmpDir,
        PATH: `${fakeBinDir}:${Deno.env.get("PATH") ?? ""}`,
        FAKE_CURL_EXIT_CODE: "28",
        HOME: tmpDir,
      },
      "Run the shell command: touch x\n",
    );
    assertEquals(resTimeout.code, 0, "must exit 0 on curl timeout");

    // Test curl connection failure (exit 7)
    const resFailed = await run(
      "bash",
      [ALERT_SCRIPT, "codex"],
      {
        TMUX_PANE: paneId,
        TMUX_SOCKET: socketName,
        TMUX_TMPDIR: tmpDir,
        PATH: `${fakeBinDir}:${Deno.env.get("PATH") ?? ""}`,
        FAKE_CURL_EXIT_CODE: "7",
        HOME: tmpDir,
      },
      "Run the shell command: touch x\n",
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

Deno.test("notification body is exactly 'Codex is waiting for you'", async () => {
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
      [ALERT_SCRIPT, "claude"],
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
      [ALERT_SCRIPT, "agy"],
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
  "exercises the change itself: run scripts/agent-alert.sh codex inside agents session codex tab with fake curl",
  async () => {
    await withThrowawayTmux(async (socketName, tmpDir, fakeBinDir) => {
      // Create session using scripts/agents.sh (codex drops to shell immediately)
      const initRes = await run("bash", [AGENTS_SCRIPT, "-L", socketName, "--no-attach"], {
        TMUX_TMPDIR: tmpDir,
        AGENTS_CLAUDE_CMD: "sleep 60",
        AGENTS_CODEX_CMD: "true",
        AGENTS_AGY_CMD: "sleep 60",
        HOME: tmpDir,
      });
      assertEquals(initRes.code, 0, `agents.sh failed: ${initRes.stderr}`);

      const curlOut = `${tmpDir}/in_pane_curl.txt`;
      // Run agent-alert.sh codex directly from inside the codex tab
      const alertCmd =
        `PATH="${fakeBinDir}:$PATH" CURL_OUT="${curlOut}" HOME="${tmpDir}" bash "${ALERT_SCRIPT}" codex`;
      await run(
        "tmux",
        ["-L", socketName, "send-keys", "-t", "agents:codex", alertCmd, "C-m"],
        { TMUX_TMPDIR: tmpDir },
      );

      // Wait up to 3 seconds for curlOut to appear
      let found = false;
      for (let i = 0; i < 30; i++) {
        if (await pathExists(curlOut)) {
          found = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(found, "expected fake curl output from inside the codex tab");

      const body = await Deno.readTextFile(curlOut);
      assertEquals(body, "Codex is waiting for you");

      // Verify tab is marked in tmux
      const waitingRes = await run(
        "tmux",
        ["-L", socketName, "show", "-w", "-t", "agents:codex", "-v", "@waiting"],
        { TMUX_TMPDIR: tmpDir },
      );
      assertEquals(waitingRes.stdout.trim(), "1");
    });
  },
);
