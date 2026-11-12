// block_agy_non_flash_model_hook.test.ts — web-jam-tools#267
//
// Exercises hooks/block-agy-non-flash-model.sh end-to-end by actually
// shelling out to it (Deno.Command) with mocked PreToolUse JSON on stdin,
// the same shape Claude Code's hook runner feeds it — same pattern as
// test/block_secret_dumps_hook.test.ts (re-implementing the shell/python
// logic in TypeScript would test a copy, not the real guard).

import { assertEquals } from "@std/assert";

const SCRIPT_PATH = new URL("../hooks/block-agy-non-flash-model.sh", import.meta.url).pathname;

interface RunResult {
  code: number;
  stderr: string;
}

async function runHook(command: string): Promise<RunResult> {
  const input = JSON.stringify({ tool_input: { command } });
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
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

function assertBlocked(stderr: string) {
  if (!stderr.includes("BLOCKED (agy-model guard)")) {
    throw new Error(`expected BLOCKED message in stderr, got: ${stderr}`);
  }
}

// --- allowed: bare agy, no --model ---

Deno.test("bare agy (no --model) is allowed", async () => {
  const res = await runHook("agy");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("agy -i 'prompt' with no --model is allowed", async () => {
  const res = await runHook(`agy -i "do the thing"`);
  assertEquals(res.code, 0, res.stderr);
});

// --- allowed: Flash models at 3.7 floor or newer ---

Deno.test("agy --model gemini-3.8-flash-medium is blocked (the medium level is retired, web-jam-tools#1202)", async () => {
  const res = await runHook("agy --model gemini-3.8-flash-medium");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model gemini-3.8-flash-high is allowed", async () => {
  const res = await runHook("agy --model gemini-3.8-flash-high");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("agy --model=gemini-3.8-flash-high (single-token form) is allowed", async () => {
  const res = await runHook("agy --model=gemini-3.8-flash-high -i hi");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("agy --model gemini-3.8-flash-high --dangerously-skip-permissions -p 'x' is allowed", async () => {
  const res = await runHook(
    `agy --model gemini-3.8-flash-high --dangerously-skip-permissions -p "reply with: ok"`,
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("agy --model gemini-3.8-flash-tiered is allowed", async () => {
  const res = await runHook("agy --model gemini-3.8-flash-tiered");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("agy --model=gemini-3.8-flash-tiered (single-token form) is allowed", async () => {
  const res = await runHook("agy --model=gemini-3.8-flash-tiered -i hi");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("Flash 3.7 models are allowed (>= 3.7 floor)", async () => {
  const res37 = await runHook("agy --model gemini-3.7-flash-high"); // 3.7 floor
  assertEquals(res37.code, 0, res37.stderr);

  const res37Tiered = await runHook("agy --model gemini-3.7-flash-tiered"); // 3.7 floor
  assertEquals(res37Tiered.code, 0, res37Tiered.stderr);
});

Deno.test("future Flash 4.0 models (>= 3.7 floor) are allowed at high effort, not medium", async () => {
  const res40 = await runHook("agy --model gemini-4.0-flash-high");
  assertEquals(res40.code, 0, res40.stderr);
  const res40Med = await runHook("agy --model gemini-4.0-flash-medium");
  assertEquals(res40Med.code, 2);
});

// --- blocked: models below the 3.7 floor and non-Flash slugs ---

Deno.test("agy --model gemini-3.6-flash-medium is blocked (below 3.7 floor)", async () => {
  const res = await runHook("agy --model gemini-3.6-flash-medium");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model gemini-3.6-flash-high is blocked (below 3.7 floor)", async () => {
  const res = await runHook("agy --model gemini-3.6-flash-high");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model gemini-3.6-flash-tiered is blocked (below 3.7 floor)", async () => {
  const res = await runHook("agy --model gemini-3.6-flash-tiered");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model gemini-3.6-flash-low is blocked", async () => {
  const res = await runHook("agy --model gemini-3.6-flash-low");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model gemini-3.7-flash-low is blocked (non-medium/high tier, 3.7 floor)", async () => {
  const res = await runHook("agy --model gemini-3.7-flash-low"); // 3.7 floor
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model claude-sonnet-4-6 is blocked", async () => {
  const res = await runHook("agy --model claude-sonnet-4-6");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model claude-opus-4-6-thinking is blocked", async () => {
  const res = await runHook("agy --model claude-opus-4-6-thinking");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model gpt-oss-120b-medium is blocked", async () => {
  const res = await runHook("agy --model gpt-oss-120b-medium");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model gemini-3.1-pro-high is blocked", async () => {
  const res = await runHook("agy --model gemini-3.1-pro-high");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model gemini-3.1-pro-low is blocked", async () => {
  const res = await runHook("agy --model gemini-3.1-pro-low");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model gemini-3.5-flash-high is blocked (old Flash generation)", async () => {
  const res = await runHook("agy --model gemini-3.5-flash-high");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model gemini-3.5-flash-medium is blocked (old Flash generation)", async () => {
  const res = await runHook("agy --model gemini-3.5-flash-medium");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("agy --model gemini-3.5-flash-low is blocked (old Flash generation)", async () => {
  const res = await runHook("agy --model gemini-3.5-flash-low");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("block message names permitted slugs", async () => {
  const res = await runHook("agy --model claude-sonnet-4-6");
  assertEquals(res.code, 2);
  for (
    const slug of [
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-tiered",
      "gemini-4-argon-high",
      "claude-sonnet-5-5-high",
    ]
  ) {
    if (!res.stderr.includes(slug)) {
      throw new Error(`expected block message to name ${slug}, got: ${res.stderr}`);
    }
  }
  assertEquals(res.stderr.includes("flash-medium"), false, res.stderr);
});

// --- Gemini 4 Argon at high, and agy behind another command (tier-order design 1.5.0) ---

Deno.test("Argon at high is allowed, by slug and by display name", async () => {
  for (
    const cmd of [
      `agy --model gemini-4-argon-high -p="x"`,
      `agy --model "Gemini 4 Argon (High)" -p="x"`,
      `AGY_MODELS='Gemini 4 Argon (High)' agy -p="x"`,
      `AGY_MODELS='Gemini 4 Argon (High)' handle-agy-tasks.sh --headless "JaMmusic#1"`,
    ]
  ) {
    const res = await runHook(cmd);
    assertEquals(res.code, 0, `${cmd}: ${res.stderr}`);
  }
});

Deno.test("Argon at medium or low, and a Claude model, are blocked", async () => {
  for (
    const cmd of [
      `agy --model gemini-4-argon-medium -p="x"`,
      `agy --model gemini-4-argon-low -p="x"`,
      `agy --model "Gemini 4 Argon (Medium)" -p="x"`,
      `agy --model "Claude Opus 5.5 (High)" -p="x"`,
    ]
  ) {
    const res = await runHook(cmd);
    assertEquals(res.code, 2, cmd);
    assertBlocked(res.stderr);
  }
});

Deno.test("agy behind a wrapper or a shell payload is checked, whatever the wrapper", async () => {
  for (
    const cmd of [
      `timeout 180 agy --model "Claude Opus 5.5 (High)" -p="x"`,
      `cd /tmp && timeout 180 agy --model gemini-4-argon-low -p="x"`,
      `nice agy --model gemini-3.8-flash-medium -p="x"`,
      `nohup agy --model "Claude Sonnet 5.5 (Medium)" -p="x"`,
      `env FOO=1 agy --model gemini-4-argon-low -p="x"`,
      `command agy --model gemini-4-argon-low -p="x"`,
      `exec agy --model gemini-4-argon-low -p="x"`,
      `time agy --model gemini-4-argon-low -p="x"`,
      `sudo agy --model gemini-4-argon-low -p="x"`,
      `bash -c 'agy --model gemini-4-argon-low -p="x"'`,
      `sh -c "agy --model gemini-4-argon-low -p=x"`,
      `/home/joshua/.local/bin/agy --model gemini-4-argon-low -p="x"`,
    ]
  ) {
    const res = await runHook(cmd);
    assertEquals(res.code, 2, cmd);
    assertBlocked(res.stderr);
  }
});

Deno.test("agy behind a wrapper with an allowed model is allowed", async () => {
  const res = await runHook(`timeout 180 agy --model gemini-4-argon-high -p="x"`);
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("a command that runs agy but cannot be parsed is refused (fails closed)", async () => {
  const res = await runHook(`agy --model "gemini-3.8-flash-high -p=x`);
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
  assertEquals(res.stderr.includes("could not be parsed"), true, res.stderr);
});

Deno.test("an unparseable command that never mentions agy still passes through", async () => {
  const res = await runHook(`echo "it's unterminated`);
  assertEquals(res.code, 0, res.stderr);
});

// --- blocked: AGY_MODELS= env prefix bypassing --model ---

Deno.test("AGY_MODELS=claude-opus-4-6-thinking agy is blocked", async () => {
  const res = await runHook("AGY_MODELS=claude-opus-4-6-thinking agy");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("AGY_MODELS='gemini-3.5-flash-high' agy -i x is blocked (old Flash generation)", async () => {
  const res = await runHook(`AGY_MODELS='gemini-3.5-flash-high' agy -i x`);
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("AGY_MODELS='gemini-3.6-flash-high' agy is blocked (below 3.7 floor)", async () => {
  const res = await runHook(`AGY_MODELS='gemini-3.6-flash-high' agy`);
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("AGY_MODELS with one good and one bad slug (pipe-separated) is blocked", async () => {
  const res = await runHook("AGY_MODELS='gemini-3.8-flash-medium|claude-sonnet-4-6' agy");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- allowed: AGY_MODELS= env prefix naming only permitted slugs ---

Deno.test("AGY_MODELS=gemini-3.8-flash-high agy is allowed", async () => {
  const res = await runHook("AGY_MODELS=gemini-3.8-flash-high agy");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("AGY_MODELS naming the retired medium slug is blocked, alone or beside high (web-jam-tools#1202)", async () => {
  for (
    const value of [
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-high|gemini-3.8-flash-medium",
    ]
  ) {
    const res = await runHook(`AGY_MODELS='${value}' agy`);
    assertEquals(res.code, 2, value);
    assertBlocked(res.stderr);
  }
});

// --- out of scope: wrapper scripts that merely mention/invoke agy internally ---

Deno.test(
  "handle-agy-tasks.sh invocation is untouched (not a literal agy command)",
  async () => {
    const res = await runHook("handle-agy-tasks.sh --headless Repo#123");
    assertEquals(res.code, 0, res.stderr);
  },
);

Deno.test(
  "AGY_MODELS prefix on a non-agy command (the wrapper script) is untouched — only a literal agy invocation is in scope",
  async () => {
    const res = await runHook(
      "AGY_MODELS='claude-opus-4-6-thinking' ~/WebJamApps/web-jam-tools/scripts/handle-agy-tasks.sh --headless Repo#123",
    );
    assertEquals(res.code, 0, res.stderr);
  },
);

Deno.test("a command with no agy reference at all passes through untouched", async () => {
  const res = await runHook("ls -la src/");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("agy invoked via a path ending in /agy is still recognized", async () => {
  const res = await runHook("$HOME/.local/bin/agy --model claude-sonnet-4-6");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- Outcome 3: cannot be determined -> proceeds (fails open) ---

Deno.test("Outcome 3: missing command field proceeds (fails open)", async () => {
  const input = JSON.stringify({ tool_input: {} });
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code, stderr } = await child.output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
});

Deno.test("Outcome 3: unparseable / empty JSON payload proceeds (fails open)", async () => {
  const input = JSON.stringify({});
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code, stderr } = await child.output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
});

Deno.test("Outcome 3: unparseable non-JSON input proceeds (fails open)", async () => {
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode("this is not valid json"));
  await writer.close();
  const { code, stderr } = await child.output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
});

Deno.test("Outcome 3: failed helper subprocess proceeds (fails open)", async () => {
  // Run with PATH pointing to a dir with a broken deno binary to simulate helper failure
  const tempDir = await Deno.makeTempDir({ prefix: "broken-deno-" });
  try {
    const fakeDeno = `${tempDir}/deno`;
    await Deno.writeTextFile(fakeDeno, "#!/usr/bin/env bash\nexit 1\n");
    await Deno.chmod(fakeDeno, 0o755);

    const input = JSON.stringify({
      tool_input: { command: "agy --model claude-opus-4-6-thinking" },
    });
    const cmd = new Deno.Command("bash", {
      args: [SCRIPT_PATH],
      env: {
        PATH: `${tempDir}:${Deno.env.get("PATH") ?? ""}`,
        BASH_ENV: "",
      },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const child = cmd.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
    const { code, stderr } = await child.output();
    assertEquals(code, 0, new TextDecoder().decode(stderr));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Sonnet high and reviewed wrapper bypasses are enforced by the shell hook", async () => {
  for (
    const [cmd, code] of [
      [`agy --model "Claude Sonnet 5.5 (High)" -p=x`, 0],
      [`nohup agy --model "Claude Sonnet 5.5 (High)" -p=x`, 0],
      [`time -p agy --model claude-sonnet-5-5-high -p=x`, 0],
      [`exec -a worker agy --model claude-sonnet-5-5-high -p=x`, 0],
      [`env AGY_MODELS=claude-sonnet-5-5-high timeout 180 agy -p=x`, 0],
      [`env AGY_MODELS=claude-sonnet-5-5-high bash -c "agy -p=x"`, 0],
      [`agy --model claude-sonnet-5-5-medium -p=x`, 2],
      [`time -p agy --model gemini-4-argon-low -p=x`, 2],
      [`exec -a worker agy --model gemini-4-argon-low -p=x`, 2],
      [`env AGY_MODELS=gemini-4-argon-low timeout 180 agy -p=x`, 2],
      [`env AGY_MODELS=gemini-4-argon-low bash -c "agy -p=x"`, 2],
      [`time --unrecognized agy --model claude-sonnet-5-5-high`, 2],
    ] as const
  ) {
    const res = await runHook(cmd);
    assertEquals(res.code, code, `${cmd}: ${res.stderr}`);
    if (code === 2) assertBlocked(res.stderr);
  }
});
