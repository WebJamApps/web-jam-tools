// install_hooks_merge.test.ts — web-jam-tools#265
//
// Exercises scripts/merge-hooks-into-settings.py — the settings.json merge
// logic scripts/install-hooks.sh delegates to — end-to-end via Deno.Command
// against fixture settings.json files, in isolation from the symlink step.
// install-hooks.sh itself (including that symlink step) is exercised,
// always sandboxed, in test/install_hooks_script.test.ts (web-jam-tools#273
// added --hooks-dir specifically so that could be done without risking
// Josh's LIVE ~/.claude/hooks symlinks).

import { assert, assertEquals } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../scripts/merge-hooks-into-settings.py",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runMerge(settingsPath: string, args: string[]): Promise<RunResult> {
  const cmd = new Deno.Command("python3", {
    args: [SCRIPT_PATH, settingsPath, "--", ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

async function withTempSettings(
  initial: unknown | undefined,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/settings.json`;
  try {
    if (initial !== undefined) {
      await Deno.writeTextFile(path, JSON.stringify(initial, null, 2));
    }
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

interface HookCmd {
  type: string;
  command: string;
}
interface HookEntry {
  matcher?: string;
  hooks: HookCmd[];
}
interface SettingsJson {
  permissions?: unknown;
  hooks: {
    SessionStart: HookEntry[];
    PreToolUse: HookEntry[];
    Stop?: HookEntry[];
  };
}

async function readJson(path: string): Promise<SettingsJson> {
  return JSON.parse(await Deno.readTextFile(path));
}

// --- Fresh settings.json ---

Deno.test("merge into a nonexistent settings.json creates it with SessionStart + PreToolUse", async () => {
  await withTempSettings(undefined, async (path) => {
    const res = await runMerge(path, [
      "$HOME/.claude/hooks/notes-sync-reminder.sh",
      "--pre-tool-use",
      "Bash::$HOME/.claude/hooks/block-secret-dumps.sh",
    ]);
    assertEquals(res.code, 0, res.stderr);

    const data = await readJson(path);
    assertEquals(data.hooks.SessionStart, [
      { hooks: [{ type: "command", command: "$HOME/.claude/hooks/notes-sync-reminder.sh" }] },
    ]);
    assertEquals(data.hooks.PreToolUse, [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "$HOME/.claude/hooks/block-secret-dumps.sh" }],
      },
    ]);
  });
});

// --- Stop hooks (web-jam-tools#290): flat, no-matcher shape like SessionStart ---

Deno.test("merges a --stop hook into hooks.Stop as a flat, no-matcher entry", async () => {
  await withTempSettings(undefined, async (path) => {
    const res = await runMerge(path, [
      "--stop",
      "$HOME/.claude/hooks/opus-no-delegation-warning.sh",
    ]);
    assertEquals(res.code, 0, res.stderr);
    const data = await readJson(path);
    assertEquals(data.hooks.Stop, [
      {
        hooks: [
          { type: "command", command: "$HOME/.claude/hooks/opus-no-delegation-warning.sh" },
        ],
      },
    ]);
  });
});

Deno.test("re-running with the same --stop hook does not duplicate it", async () => {
  await withTempSettings(undefined, async (path) => {
    const args = ["--stop", "$HOME/.claude/hooks/opus-no-delegation-warning.sh"];
    const first = await runMerge(path, args);
    assertEquals(first.code, 0, first.stderr);
    const second = await runMerge(path, args);
    assertEquals(second.code, 0, second.stderr);
    assert(
      second.stdout.includes("already up to date (no-op)"),
      `expected no-op message, got: ${second.stdout}`,
    );
    const data = await readJson(path);
    assertEquals(data.hooks.Stop?.length, 1);
    assertEquals(data.hooks.Stop?.[0].hooks.length, 1);
  });
});

Deno.test("a pre-existing Stop hook (not installer-managed) is preserved when a new --stop hook is added", async () => {
  await withTempSettings(
    {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "some-other-stop-hook.sh" }] }],
      },
    },
    async (path) => {
      const res = await runMerge(path, [
        "--stop",
        "$HOME/.claude/hooks/opus-no-delegation-warning.sh",
      ]);
      assertEquals(res.code, 0, res.stderr);
      const data = await readJson(path);
      assertEquals(data.hooks.Stop?.length, 2);
      assertEquals(data.hooks.Stop?.[0].hooks[0].command, "some-other-stop-hook.sh");
      assertEquals(
        data.hooks.Stop?.[1].hooks[0].command,
        "$HOME/.claude/hooks/opus-no-delegation-warning.sh",
      );
    },
  );
});

Deno.test("--stop, --pre-tool-use and SessionStart all merge together in one invocation", async () => {
  await withTempSettings(undefined, async (path) => {
    const res = await runMerge(path, [
      "$HOME/.claude/hooks/notes-sync-reminder.sh",
      "--stop",
      "$HOME/.claude/hooks/opus-no-delegation-warning.sh",
      "--pre-tool-use",
      "Bash::$HOME/.claude/hooks/block-secret-dumps.sh",
    ]);
    assertEquals(res.code, 0, res.stderr);
    const data = await readJson(path);
    assertEquals(data.hooks.SessionStart.length, 1);
    assertEquals(data.hooks.Stop?.length, 1);
    assertEquals(data.hooks.PreToolUse.length, 1);
  });
});

// --- Arbitrary matchers (the point of web-jam-tools#265) ---

Deno.test("wires an Edit|Write matcher (feature-branch-guard.sh's matcher)", async () => {
  await withTempSettings(undefined, async (path) => {
    const res = await runMerge(path, [
      "--pre-tool-use",
      "Edit|Write::$HOME/.claude/hooks/feature-branch-guard.sh",
    ]);
    assertEquals(res.code, 0, res.stderr);
    const data = await readJson(path);
    assertEquals(data.hooks.PreToolUse, [
      {
        matcher: "Edit|Write",
        hooks: [{ type: "command", command: "$HOME/.claude/hooks/feature-branch-guard.sh" }],
      },
    ]);
  });
});

Deno.test("wires the gmail gate's matcher EXACTLY as-is (mcp__gmail__.*)", async () => {
  await withTempSettings(undefined, async (path) => {
    const res = await runMerge(path, [
      "--pre-tool-use",
      "mcp__gmail__.*::$HOME/.claude/hooks/haiku-only-gmail-gate.sh",
    ]);
    assertEquals(res.code, 0, res.stderr);
    const data = await readJson(path);
    assertEquals(data.hooks.PreToolUse[0].matcher, "mcp__gmail__.*");
    assertEquals(
      data.hooks.PreToolUse[0].hooks[0].command,
      "$HOME/.claude/hooks/haiku-only-gmail-gate.sh",
    );
  });
});

Deno.test("wires the server-agnostic issue_write matcher (mcp__.*__issue_write)", async () => {
  await withTempSettings(undefined, async (path) => {
    const res = await runMerge(path, [
      "--pre-tool-use",
      "mcp__.*__issue_write::$HOME/.claude/hooks/require-model-label-on-issue-create.sh",
    ]);
    assertEquals(res.code, 0, res.stderr);
    const data = await readJson(path);
    assertEquals(data.hooks.PreToolUse[0].matcher, "mcp__.*__issue_write");
  });
});

Deno.test("multiple scripts sharing one matcher land as separate hook entries under it", async () => {
  await withTempSettings(undefined, async (path) => {
    const res = await runMerge(path, [
      "--pre-tool-use",
      "Bash::$HOME/.claude/hooks/a.sh",
      "Bash::$HOME/.claude/hooks/b.sh",
    ]);
    assertEquals(res.code, 0, res.stderr);
    const data = await readJson(path);
    assertEquals(data.hooks.PreToolUse.length, 1);
    assertEquals(data.hooks.PreToolUse[0].matcher, "Bash");
    assertEquals(data.hooks.PreToolUse[0].hooks.map((h: HookCmd) => h.command), [
      "$HOME/.claude/hooks/a.sh",
      "$HOME/.claude/hooks/b.sh",
    ]);
  });
});

Deno.test("different matchers get separate PreToolUse entries", async () => {
  await withTempSettings(undefined, async (path) => {
    const res = await runMerge(path, [
      "--pre-tool-use",
      "Bash::$HOME/.claude/hooks/a.sh",
      "Edit|Write::$HOME/.claude/hooks/feature-branch-guard.sh",
      "mcp__gmail__.*::$HOME/.claude/hooks/haiku-only-gmail-gate.sh",
    ]);
    assertEquals(res.code, 0, res.stderr);
    const data = await readJson(path);
    const matchers = data.hooks.PreToolUse.map((e: HookEntry) => e.matcher).sort();
    assertEquals(matchers, ["Bash", "Edit|Write", "mcp__gmail__.*"]);
  });
});

// --- Idempotency ---

Deno.test("re-running with the same hooks does not duplicate entries", async () => {
  await withTempSettings(undefined, async (path) => {
    const args = [
      "$HOME/.claude/hooks/notes-sync-reminder.sh",
      "--pre-tool-use",
      "Bash::$HOME/.claude/hooks/block-secret-dumps.sh",
      "Edit|Write::$HOME/.claude/hooks/feature-branch-guard.sh",
    ];
    const first = await runMerge(path, args);
    assertEquals(first.code, 0, first.stderr);
    const second = await runMerge(path, args);
    assertEquals(second.code, 0, second.stderr);
    assert(
      second.stdout.includes("already up to date (no-op)"),
      `expected no-op message, got: ${second.stdout}`,
    );

    const data = await readJson(path);
    assertEquals(data.hooks.SessionStart.length, 1);
    assertEquals(data.hooks.PreToolUse.length, 2);
    for (const entry of data.hooks.PreToolUse) {
      assertEquals(entry.hooks.length, 1);
    }
  });
});

Deno.test("a second, different hook added to an already-wired matcher appends without disturbing the first", async () => {
  await withTempSettings(undefined, async (path) => {
    const first = await runMerge(path, [
      "--pre-tool-use",
      "Bash::$HOME/.claude/hooks/a.sh",
    ]);
    assertEquals(first.code, 0, first.stderr);
    const second = await runMerge(path, [
      "--pre-tool-use",
      "Bash::$HOME/.claude/hooks/a.sh",
      "Bash::$HOME/.claude/hooks/b.sh",
    ]);
    assertEquals(second.code, 0, second.stderr);

    const data = await readJson(path);
    assertEquals(data.hooks.PreToolUse.length, 1);
    assertEquals(data.hooks.PreToolUse[0].hooks.map((h: HookCmd) => h.command), [
      "$HOME/.claude/hooks/a.sh",
      "$HOME/.claude/hooks/b.sh",
    ]);
  });
});

// --- Preserves unrelated existing content ---

Deno.test("existing unrelated settings (permissions, other hook events) are left untouched", async () => {
  await withTempSettings(
    {
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "some-stop-hook.sh" }] }],
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "pre-existing.sh" }] },
        ],
      },
    },
    async (path) => {
      const res = await runMerge(path, [
        "--pre-tool-use",
        "Bash::$HOME/.claude/hooks/block-secret-dumps.sh",
      ]);
      assertEquals(res.code, 0, res.stderr);
      const data = await readJson(path);
      assertEquals(data.permissions, { allow: ["Bash(ls:*)"] });
      assertEquals(data.hooks.Stop, [
        { hooks: [{ type: "command", command: "some-stop-hook.sh" }] },
      ]);
      // Bash matcher entry gains the new command alongside the pre-existing one.
      assertEquals(data.hooks.PreToolUse.length, 1);
      assertEquals(data.hooks.PreToolUse[0].hooks.map((h: HookCmd) => h.command), [
        "pre-existing.sh",
        "$HOME/.claude/hooks/block-secret-dumps.sh",
      ]);
    },
  );
});

// --- Backup behavior ---

Deno.test("a write backs up the previous settings.json", async () => {
  await withTempSettings({ permissions: {} }, async (path) => {
    const res = await runMerge(path, [
      "--pre-tool-use",
      "Bash::$HOME/.claude/hooks/block-secret-dumps.sh",
    ]);
    assertEquals(res.code, 0, res.stderr);
    assert(res.stdout.includes("backed up previous version"), res.stdout);

    const dir = path.slice(0, path.lastIndexOf("/"));
    const backups = [...Deno.readDirSync(dir)].filter((e) => e.name.includes(".bak-"));
    assertEquals(backups.length, 1);
  });
});

Deno.test("a true no-op (nothing to add) writes no backup", async () => {
  await withTempSettings(undefined, async (path) => {
    const args = ["--pre-tool-use", "Bash::$HOME/.claude/hooks/block-secret-dumps.sh"];
    await runMerge(path, args);
    const second = await runMerge(path, args);
    assertEquals(second.code, 0, second.stderr);

    const dir = path.slice(0, path.lastIndexOf("/"));
    const backups = [...Deno.readDirSync(dir)].filter((e) => e.name.includes(".bak-"));
    assertEquals(backups.length, 0);
  });
});

// --- Malformed input ---

Deno.test("invalid JSON in an existing settings.json is refused, not overwritten", async () => {
  await withTempSettings(undefined, async (path) => {
    await Deno.writeTextFile(path, "{ not valid json");
    const res = await runMerge(path, [
      "--pre-tool-use",
      "Bash::$HOME/.claude/hooks/block-secret-dumps.sh",
    ]);
    assertEquals(res.code, 1);
    assert(res.stderr.includes("not valid JSON"), res.stderr);
    assertEquals(await Deno.readTextFile(path), "{ not valid json");
  });
});
