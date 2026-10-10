// test/agy_prompt_watch_test.ts — web-jam-tools#1212
//
// Drives scripts/agy-prompt-watch.sh against throwaway tmux servers (tmux -L) to verify:
// 1. The hook returns immediately before the first look.
// 2. The 13 closed cases for the marker text:
//    - 4 must alert (one call each)
//    - 9 must NOT alert (0 calls)
// 3. The four timing cases:
//    - present at look 1 -> 1 call
//    - absent at look 1 and present at look 2 -> 1 call
//    - present at both looks -> 1 call
//    - absent at both looks -> 0 calls
// 4. The three silent cases:
//    - $TMUX_PANE unset -> no look, 0 calls
//    - session named anything but "agents" -> no look, 0 calls
//    - tab named "claude" or "codex" -> no look, 0 calls

import { assert, assertEquals } from "@std/assert";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const PROMPT_WATCH_SCRIPT = `${REPO_ROOT}scripts/agy-prompt-watch.sh`;

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
    env: { ...Deno.env.toObject(), ...(env ?? {}) },
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
  const tmpDir = await Deno.makeTempDir({ prefix: "agy-prompt-watch-test-" });
  const socketName = `test-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await fn(socketName, tmpDir);
  } finally {
    await run("tmux", ["-L", socketName, "kill-server"], { TMUX_TMPDIR: tmpDir });
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  }
}

async function setupStubAlert(tmpDir: string): Promise<string> {
  const binDir = `${tmpDir}/bin`;
  await Deno.mkdir(binDir, { recursive: true });
  const logFile = `${tmpDir}/alert.log`;
  await Deno.writeTextFile(
    `${binDir}/agent-alert.sh`,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${logFile}"\n`,
  );
  await Deno.chmod(`${binDir}/agent-alert.sh`, 0o755);
  return logFile;
}

async function readAlertLog(logFile: string): Promise<string[]> {
  try {
    const text = await Deno.readTextFile(logFile);
    return text.trim().split("\n").filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

async function setPaneText(socketName: string, tmpDir: string, paneId: string, text: string) {
  // Clear the pane, then print the literal line
  await run("tmux", ["-L", socketName, "send-keys", "-t", paneId, "clear", "Enter"], {
    TMUX_TMPDIR: tmpDir,
  });
  await new Promise((r) => setTimeout(r, 100));
  if (text.length > 0) {
    const escaped = text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    await run("tmux", [
      "-L",
      socketName,
      "send-keys",
      "-t",
      paneId,
      `printf '%s\\n' "${escaped}"`,
      "Enter",
    ], {
      TMUX_TMPDIR: tmpDir,
    });
    await new Promise((r) => setTimeout(r, 150));
  }
}

// 1. Hook returns before first look
Deno.test("agy-prompt-watch returns immediately before first look and alerts once", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    const logFile = await setupStubAlert(tmpDir);
    await run(
      "tmux",
      [
        "-L",
        socketName,
        "new-session",
        "-d",
        "-s",
        "agents",
        "-n",
        "agy",
        "bash --norc --noprofile",
      ],
      { TMUX_TMPDIR: tmpDir },
    );
    const paneRes = await run(
      "tmux",
      ["-L", socketName, "display-message", "-p", "-t", "agents:agy", "#{pane_id}"],
      { TMUX_TMPDIR: tmpDir },
    );
    const paneId = paneRes.stdout.trim();

    await setPaneText(socketName, tmpDir, paneId, "  ↑/↓ Navigate · tab Amend");

    const t0 = performance.now();
    const res = await run("bash", [PROMPT_WATCH_SCRIPT], {
      TMUX_TMPDIR: tmpDir,
      TMUX_SOCKET: socketName,
      TMUX_PANE: paneId,
      PATH: `${tmpDir}/bin:${Deno.env.get("PATH") ?? ""}`,
      AGY_PROMPT_WATCH_DELAY1: "0.25",
      AGY_PROMPT_WATCH_DELAY2: "0.25",
    });
    const elapsed = performance.now() - t0;

    assertEquals(res.code, 0, res.stderr);
    assertEquals(res.stdout, "");
    assert(elapsed < 200, `hook took ${elapsed}ms; must return before first look (250ms)`);

    // Immediately after return, alert has not fired yet
    let calls = await readAlertLog(logFile);
    assertEquals(calls, [], "alert should not have fired before first look");

    // Wait until look 1 has completed
    await new Promise((r) => setTimeout(r, 300));
    calls = await readAlertLog(logFile);
    assertEquals(calls, ["agy prompt"], "alert should have fired once after look 1");

    // Wait past look 2 to confirm no duplicate alert
    await new Promise((r) => setTimeout(r, 250));
    calls = await readAlertLog(logFile);
    assertEquals(calls, ["agy prompt"], "alert must not be called a second time");
  });
});

// 2. Closed case list for the marker text
const MUST_ALERT_CASES = [
  {
    name: "command prompt key-hint line",
    line: "  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command",
  },
  {
    name: "file outside workspace key-hint line",
    line: "  ↑/↓ Navigate · tab Amend · f full diff",
  },
  {
    name: "web page key-hint line",
    line: "  ↑/↓ Navigate · tab Amend",
  },
  {
    name: "tab Amend in arbitrary line",
    line: "the words tab Amend appear here",
  },
];

for (const tc of MUST_ALERT_CASES) {
  Deno.test(`agy-prompt-watch closed case (must alert): ${tc.name}`, async () => {
    await withThrowawayTmux(async (socketName, tmpDir) => {
      const logFile = await setupStubAlert(tmpDir);
      await run(
        "tmux",
        [
          "-L",
          socketName,
          "new-session",
          "-d",
          "-s",
          "agents",
          "-n",
          "agy",
          "bash --norc --noprofile",
        ],
        { TMUX_TMPDIR: tmpDir },
      );
      const paneRes = await run(
        "tmux",
        ["-L", socketName, "display-message", "-p", "-t", "agents:agy", "#{pane_id}"],
        { TMUX_TMPDIR: tmpDir },
      );
      const paneId = paneRes.stdout.trim();

      await setPaneText(socketName, tmpDir, paneId, tc.line);

      const res = await run("bash", [PROMPT_WATCH_SCRIPT], {
        TMUX_TMPDIR: tmpDir,
        TMUX_SOCKET: socketName,
        TMUX_PANE: paneId,
        PATH: `${tmpDir}/bin:${Deno.env.get("PATH") ?? ""}`,
        AGY_PROMPT_WATCH_DELAY1: "0.08",
        AGY_PROMPT_WATCH_DELAY2: "0.08",
      });
      assertEquals(res.code, 0, res.stderr);

      await new Promise((r) => setTimeout(r, 220));
      const calls = await readAlertLog(logFile);
      assertEquals(calls, ["agy prompt"], `expected exactly one call for: ${tc.line}`);
    });
  });
}

const MUST_NOT_ALERT_CASES = [
  {
    name: "working footer",
    line: "esc to cancel                                    Gemini 3.8 Flash · medium",
  },
  {
    name: "idle footer",
    line: "? for shortcuts                                  Gemini 3.8 Flash · medium",
  },
  {
    name: "settings list",
    line: "Keyboard: ↑/↓ Navigate  enter Select  esc Clear Search/Exit",
  },
  {
    name: "settings choice list",
    line: "Keyboard: ↑/↓ Navigate  enter Save  esc Cancel",
  },
  {
    name: "interrupted prompt",
    line: "  ⎿  Interrupted · What should Antigravity CLI do instead?",
  },
  {
    name: "Tab Amend (capital T)",
    line: "Tab Amend",
  },
  {
    name: "tab amend (lower-case a)",
    line: "tab amend",
  },
  {
    name: "tabAmend (no space)",
    line: "tabAmend",
  },
  {
    name: "empty tab",
    line: "",
  },
];

for (const tc of MUST_NOT_ALERT_CASES) {
  Deno.test(`agy-prompt-watch closed case (must NOT alert): ${tc.name}`, async () => {
    await withThrowawayTmux(async (socketName, tmpDir) => {
      const logFile = await setupStubAlert(tmpDir);
      await run(
        "tmux",
        [
          "-L",
          socketName,
          "new-session",
          "-d",
          "-s",
          "agents",
          "-n",
          "agy",
          "bash --norc --noprofile",
        ],
        { TMUX_TMPDIR: tmpDir },
      );
      const paneRes = await run(
        "tmux",
        ["-L", socketName, "display-message", "-p", "-t", "agents:agy", "#{pane_id}"],
        { TMUX_TMPDIR: tmpDir },
      );
      const paneId = paneRes.stdout.trim();

      await setPaneText(socketName, tmpDir, paneId, tc.line);

      const res = await run("bash", [PROMPT_WATCH_SCRIPT], {
        TMUX_TMPDIR: tmpDir,
        TMUX_SOCKET: socketName,
        TMUX_PANE: paneId,
        PATH: `${tmpDir}/bin:${Deno.env.get("PATH") ?? ""}`,
        AGY_PROMPT_WATCH_DELAY1: "0.08",
        AGY_PROMPT_WATCH_DELAY2: "0.08",
      });
      assertEquals(res.code, 0, res.stderr);

      await new Promise((r) => setTimeout(r, 220));
      const calls = await readAlertLog(logFile);
      assertEquals(calls, [], `expected no alert calls for: ${tc.line}`);
    });
  });
}

// 3. Timing cases
Deno.test("timing case: marker absent at look 1 and present at look 2 gives one alert call", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    const logFile = await setupStubAlert(tmpDir);
    await run(
      "tmux",
      [
        "-L",
        socketName,
        "new-session",
        "-d",
        "-s",
        "agents",
        "-n",
        "agy",
        "bash --norc --noprofile",
      ],
      { TMUX_TMPDIR: tmpDir },
    );
    const paneRes = await run(
      "tmux",
      ["-L", socketName, "display-message", "-p", "-t", "agents:agy", "#{pane_id}"],
      { TMUX_TMPDIR: tmpDir },
    );
    const paneId = paneRes.stdout.trim();

    // Start with empty pane
    await setPaneText(socketName, tmpDir, paneId, "");

    const res = await run("bash", [PROMPT_WATCH_SCRIPT], {
      TMUX_TMPDIR: tmpDir,
      TMUX_SOCKET: socketName,
      TMUX_PANE: paneId,
      PATH: `${tmpDir}/bin:${Deno.env.get("PATH") ?? ""}`,
      AGY_PROMPT_WATCH_DELAY1: "0.10",
      AGY_PROMPT_WATCH_DELAY2: "0.15",
    });
    assertEquals(res.code, 0, res.stderr);

    // Wait 120ms (look 1 has completed and found nothing)
    await new Promise((r) => setTimeout(r, 120));
    let calls = await readAlertLog(logFile);
    assertEquals(calls, [], "no alert after look 1 on empty pane");

    // Introduce marker before look 2 (which fires 150ms after look 1, around 250ms total)
    await setPaneText(socketName, tmpDir, paneId, "  ↑/↓ Navigate · tab Amend");

    // Wait until look 2 has completed (around 320ms total)
    await new Promise((r) => setTimeout(r, 180));
    calls = await readAlertLog(logFile);
    assertEquals(calls, ["agy prompt"], "alert should have fired after look 2");
  });
});

Deno.test("timing case: marker present at both looks gives exactly one alert call", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    const logFile = await setupStubAlert(tmpDir);
    await run(
      "tmux",
      [
        "-L",
        socketName,
        "new-session",
        "-d",
        "-s",
        "agents",
        "-n",
        "agy",
        "bash --norc --noprofile",
      ],
      { TMUX_TMPDIR: tmpDir },
    );
    const paneRes = await run(
      "tmux",
      ["-L", socketName, "display-message", "-p", "-t", "agents:agy", "#{pane_id}"],
      { TMUX_TMPDIR: tmpDir },
    );
    const paneId = paneRes.stdout.trim();

    await setPaneText(socketName, tmpDir, paneId, "  ↑/↓ Navigate · tab Amend");

    const res = await run("bash", [PROMPT_WATCH_SCRIPT], {
      TMUX_TMPDIR: tmpDir,
      TMUX_SOCKET: socketName,
      TMUX_PANE: paneId,
      PATH: `${tmpDir}/bin:${Deno.env.get("PATH") ?? ""}`,
      AGY_PROMPT_WATCH_DELAY1: "0.08",
      AGY_PROMPT_WATCH_DELAY2: "0.08",
    });
    assertEquals(res.code, 0, res.stderr);

    await new Promise((r) => setTimeout(r, 220));
    const calls = await readAlertLog(logFile);
    assertEquals(calls, ["agy prompt"], "expected exactly one alert call across both looks");
  });
});

Deno.test("timing case: marker absent at both looks gives no call", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    const logFile = await setupStubAlert(tmpDir);
    await run(
      "tmux",
      [
        "-L",
        socketName,
        "new-session",
        "-d",
        "-s",
        "agents",
        "-n",
        "agy",
        "bash --norc --noprofile",
      ],
      { TMUX_TMPDIR: tmpDir },
    );
    const paneRes = await run(
      "tmux",
      ["-L", socketName, "display-message", "-p", "-t", "agents:agy", "#{pane_id}"],
      { TMUX_TMPDIR: tmpDir },
    );
    const paneId = paneRes.stdout.trim();

    await setPaneText(socketName, tmpDir, paneId, "esc to cancel");

    const res = await run("bash", [PROMPT_WATCH_SCRIPT], {
      TMUX_TMPDIR: tmpDir,
      TMUX_SOCKET: socketName,
      TMUX_PANE: paneId,
      PATH: `${tmpDir}/bin:${Deno.env.get("PATH") ?? ""}`,
      AGY_PROMPT_WATCH_DELAY1: "0.08",
      AGY_PROMPT_WATCH_DELAY2: "0.08",
    });
    assertEquals(res.code, 0, res.stderr);

    await new Promise((r) => setTimeout(r, 220));
    const calls = await readAlertLog(logFile);
    assertEquals(calls, [], "expected no alert calls when marker is absent");
  });
});

// 4. Silent cases
Deno.test("silent case: $TMUX_PANE unset gives no look and no call", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    const logFile = await setupStubAlert(tmpDir);
    const res = await run("bash", [PROMPT_WATCH_SCRIPT], {
      TMUX_TMPDIR: tmpDir,
      TMUX_SOCKET: socketName,
      TMUX_PANE: "",
      PATH: `${tmpDir}/bin:${Deno.env.get("PATH") ?? ""}`,
      AGY_PROMPT_WATCH_DELAY1: "0.05",
      AGY_PROMPT_WATCH_DELAY2: "0.05",
    });
    assertEquals(res.code, 0, res.stderr);
    await new Promise((r) => setTimeout(r, 150));
    const calls = await readAlertLog(logFile);
    assertEquals(calls, []);
  });
});

Deno.test("silent case: session named anything but agents gives no look and no call", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    const logFile = await setupStubAlert(tmpDir);
    await run(
      "tmux",
      [
        "-L",
        socketName,
        "new-session",
        "-d",
        "-s",
        "other-session",
        "-n",
        "agy",
        "bash --norc --noprofile",
      ],
      { TMUX_TMPDIR: tmpDir },
    );
    const paneRes = await run(
      "tmux",
      ["-L", socketName, "display-message", "-p", "-t", "other-session:agy", "#{pane_id}"],
      { TMUX_TMPDIR: tmpDir },
    );
    const paneId = paneRes.stdout.trim();

    await setPaneText(socketName, tmpDir, paneId, "  ↑/↓ Navigate · tab Amend");

    const res = await run("bash", [PROMPT_WATCH_SCRIPT], {
      TMUX_TMPDIR: tmpDir,
      TMUX_SOCKET: socketName,
      TMUX_PANE: paneId,
      PATH: `${tmpDir}/bin:${Deno.env.get("PATH") ?? ""}`,
      AGY_PROMPT_WATCH_DELAY1: "0.05",
      AGY_PROMPT_WATCH_DELAY2: "0.05",
    });
    assertEquals(res.code, 0, res.stderr);
    await new Promise((r) => setTimeout(r, 150));
    const calls = await readAlertLog(logFile);
    assertEquals(calls, []);
  });
});

Deno.test("silent case: tab named claude or codex gives no look and no call", async () => {
  await withThrowawayTmux(async (socketName, tmpDir) => {
    const logFile = await setupStubAlert(tmpDir);
    await run(
      "tmux",
      [
        "-L",
        socketName,
        "new-session",
        "-d",
        "-s",
        "agents",
        "-n",
        "claude",
        "bash --norc --noprofile",
      ],
      { TMUX_TMPDIR: tmpDir },
    );
    await run(
      "tmux",
      ["-L", socketName, "new-window", "-t", "agents:2", "-n", "codex", "bash --norc --noprofile"],
      { TMUX_TMPDIR: tmpDir },
    );

    // Test claude tab
    const claudePaneRes = await run(
      "tmux",
      ["-L", socketName, "display-message", "-p", "-t", "agents:claude", "#{pane_id}"],
      { TMUX_TMPDIR: tmpDir },
    );
    const claudePaneId = claudePaneRes.stdout.trim();
    await setPaneText(socketName, tmpDir, claudePaneId, "  ↑/↓ Navigate · tab Amend");

    const resClaude = await run("bash", [PROMPT_WATCH_SCRIPT], {
      TMUX_TMPDIR: tmpDir,
      TMUX_SOCKET: socketName,
      TMUX_PANE: claudePaneId,
      PATH: `${tmpDir}/bin:${Deno.env.get("PATH") ?? ""}`,
      AGY_PROMPT_WATCH_DELAY1: "0.05",
      AGY_PROMPT_WATCH_DELAY2: "0.05",
    });
    assertEquals(resClaude.code, 0, resClaude.stderr);

    // Test codex tab
    const codexPaneRes = await run(
      "tmux",
      ["-L", socketName, "display-message", "-p", "-t", "agents:codex", "#{pane_id}"],
      { TMUX_TMPDIR: tmpDir },
    );
    const codexPaneId = codexPaneRes.stdout.trim();
    await setPaneText(socketName, tmpDir, codexPaneId, "  ↑/↓ Navigate · tab Amend");

    const resCodex = await run("bash", [PROMPT_WATCH_SCRIPT], {
      TMUX_TMPDIR: tmpDir,
      TMUX_SOCKET: socketName,
      TMUX_PANE: codexPaneId,
      PATH: `${tmpDir}/bin:${Deno.env.get("PATH") ?? ""}`,
      AGY_PROMPT_WATCH_DELAY1: "0.05",
      AGY_PROMPT_WATCH_DELAY2: "0.05",
    });
    assertEquals(resCodex.code, 0, resCodex.stderr);

    await new Promise((r) => setTimeout(r, 150));
    const calls = await readAlertLog(logFile);
    assertEquals(calls, [], "no alert calls for claude or codex tabs");
  });
});
