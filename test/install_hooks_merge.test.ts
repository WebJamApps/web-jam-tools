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
import { variedFakeBody } from "./support/varied_fake_value.ts";

const SCRIPT_PATH = new URL(
  "../scripts/merge-hooks-into-settings.ts",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runMerge(settingsPath: string, args: string[]): Promise<RunResult> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      SCRIPT_PATH,
      settingsPath,
      "--",
      ...args,
    ],
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
interface PermissionsJson {
  allow?: string[];
  ask?: string[];
  deny?: string[];
  defaultMode?: string;
}
interface StatusLineJson {
  type: string;
  command: string;
}
interface SettingsJson {
  permissions?: PermissionsJson;
  hooks: {
    SessionStart: HookEntry[];
    PreToolUse: HookEntry[];
    PostToolUse?: HookEntry[];
    Stop?: HookEntry[];
    SessionEnd?: HookEntry[];
  };
  statusLine?: StatusLineJson;
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
      "$HOME/.claude/hooks/require-issue-citation-titles.sh",
    ]);
    assertEquals(res.code, 0, res.stderr);
    const data = await readJson(path);
    assertEquals(data.hooks.Stop, [
      {
        hooks: [
          { type: "command", command: "$HOME/.claude/hooks/require-issue-citation-titles.sh" },
        ],
      },
    ]);
  });
});

Deno.test("re-running with the same --stop hook does not duplicate it", async () => {
  await withTempSettings(undefined, async (path) => {
    const args = ["--stop", "$HOME/.claude/hooks/require-issue-citation-titles.sh"];
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
        "$HOME/.claude/hooks/require-issue-citation-titles.sh",
      ]);
      assertEquals(res.code, 0, res.stderr);
      const data = await readJson(path);
      assertEquals(data.hooks.Stop?.length, 2);
      assertEquals(data.hooks.Stop?.[0].hooks[0].command, "some-other-stop-hook.sh");
      assertEquals(
        data.hooks.Stop?.[1].hooks[0].command,
        "$HOME/.claude/hooks/require-issue-citation-titles.sh",
      );
    },
  );
});

Deno.test("merges a --session-end hook into hooks.SessionEnd as a flat, no-matcher entry", async () => {
  await withTempSettings(undefined, async (path) => {
    const res = await runMerge(path, [
      "--session-end",
      "$HOME/.claude/hooks/prune-permission-allows-on-session-end.sh",
    ]);
    assertEquals(res.code, 0, res.stderr);
    const data = await readJson(path);
    assertEquals(data.hooks.SessionEnd, [
      {
        hooks: [
          {
            type: "command",
            command: "$HOME/.claude/hooks/prune-permission-allows-on-session-end.sh",
          },
        ],
      },
    ]);
  });
});

Deno.test("re-running with the same --session-end hook does not duplicate it", async () => {
  await withTempSettings(undefined, async (path) => {
    const args = [
      "--session-end",
      "$HOME/.claude/hooks/prune-permission-allows-on-session-end.sh",
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
    assertEquals(data.hooks.SessionEnd?.length, 1);
    assertEquals(data.hooks.SessionEnd?.[0].hooks.length, 1);
  });
});

Deno.test("a pre-existing SessionEnd hook (not installer-managed) is preserved when a new --session-end hook is added", async () => {
  await withTempSettings(
    {
      hooks: {
        SessionEnd: [{ hooks: [{ type: "command", command: "some-other-session-end-hook.sh" }] }],
      },
    },
    async (path) => {
      const res = await runMerge(path, [
        "--session-end",
        "$HOME/.claude/hooks/prune-permission-allows-on-session-end.sh",
      ]);
      assertEquals(res.code, 0, res.stderr);
      const data = await readJson(path);
      assertEquals(data.hooks.SessionEnd?.length, 2);
      assertEquals(data.hooks.SessionEnd?.[0].hooks[0].command, "some-other-session-end-hook.sh");
      assertEquals(
        data.hooks.SessionEnd?.[1].hooks[0].command,
        "$HOME/.claude/hooks/prune-permission-allows-on-session-end.sh",
      );
    },
  );
});

Deno.test("--stop, --session-end, --pre-tool-use and SessionStart all merge together in one invocation", async () => {
  await withTempSettings(undefined, async (path) => {
    const res = await runMerge(path, [
      "$HOME/.claude/hooks/notes-sync-reminder.sh",
      "--stop",
      "$HOME/.claude/hooks/require-issue-citation-titles.sh",
      "--session-end",
      "$HOME/.claude/hooks/prune-permission-allows-on-session-end.sh",
      "--pre-tool-use",
      "Bash::$HOME/.claude/hooks/block-secret-dumps.sh",
    ]);
    assertEquals(res.code, 0, res.stderr);
    const data = await readJson(path);
    assertEquals(data.hooks.SessionStart.length, 1);
    assertEquals(data.hooks.Stop?.length, 1);
    assertEquals(data.hooks.SessionEnd?.length, 1);
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

Deno.test("wires the gmail gate's matcher EXACTLY as-is (mcp__(gmail|claude_ai_Gmail)__.*)", async () => {
  await withTempSettings(undefined, async (path) => {
    const res = await runMerge(path, [
      "--pre-tool-use",
      "mcp__(gmail|claude_ai_Gmail)__.*::$HOME/.claude/hooks/haiku-only-gmail-gate.sh",
    ]);
    assertEquals(res.code, 0, res.stderr);
    const data = await readJson(path);
    assertEquals(data.hooks.PreToolUse[0].matcher, "mcp__(gmail|claude_ai_Gmail)__.*");
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
      "mcp__(gmail|claude_ai_Gmail)__.*::$HOME/.claude/hooks/haiku-only-gmail-gate.sh",
    ]);
    assertEquals(res.code, 0, res.stderr);
    const data = await readJson(path);
    const matchers = data.hooks.PreToolUse.map((e: HookEntry) => e.matcher).sort();
    assertEquals(matchers, ["Bash", "Edit|Write", "mcp__(gmail|claude_ai_Gmail)__.*"]);
  });
});

// --- Pruning stale matcher entries (web-jam-tools#293) ---

Deno.test("installing a hook with a new matcher removes its stale entry from the old matcher", async () => {
  await withTempSettings(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: "mcp__gmail__.*",
            hooks: [{ type: "command", command: "$HOME/.claude/hooks/haiku-only-gmail-gate.sh" }],
          },
        ],
      },
    },
    async (path) => {
      const res = await runMerge(path, [
        "--pre-tool-use",
        "mcp__(gmail|claude_ai_Gmail)__.*::$HOME/.claude/hooks/haiku-only-gmail-gate.sh",
      ]);
      assertEquals(res.code, 0, res.stderr);
      assert(
        res.stdout.includes("replaced stale matcher (mcp__gmail__.*)"),
        `expected replace message, got: ${res.stdout}`,
      );

      const data = await readJson(path);
      assertEquals(data.hooks.PreToolUse.length, 1);
      assertEquals(data.hooks.PreToolUse[0].matcher, "mcp__(gmail|claude_ai_Gmail)__.*");
      assertEquals(
        data.hooks.PreToolUse[0].hooks[0].command,
        "$HOME/.claude/hooks/haiku-only-gmail-gate.sh",
      );
    },
  );
});

Deno.test("an unrelated hand-added entry pointing outside managed hooks is preserved untouched", async () => {
  await withTempSettings(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "/some/other/hook.sh --flag" }],
          },
          {
            matcher: "Edit|Write",
            hooks: [{ type: "command", command: "$HOME/.claude/hooks/feature-branch-guard.sh" }],
          },
        ],
      },
    },
    async (path) => {
      const res = await runMerge(path, [
        "--pre-tool-use",
        "Bash::$HOME/.claude/hooks/a.sh",
        "Edit|Write::$HOME/.claude/hooks/feature-branch-guard.sh",
      ]);
      assertEquals(res.code, 0, res.stderr);

      const data = await readJson(path);
      // Should have Bash (with both the hand-added and new hook) and Edit|Write (untouched)
      assertEquals(data.hooks.PreToolUse.length, 2);
      const bashEntry = data.hooks.PreToolUse.find((e: HookEntry) => e.matcher === "Bash");
      const editEntry = data.hooks.PreToolUse.find((e: HookEntry) => e.matcher === "Edit|Write");
      assertEquals(
        bashEntry?.hooks.map((h: HookCmd) => h.command),
        ["/some/other/hook.sh --flag", "$HOME/.claude/hooks/a.sh"],
      );
      assertEquals(editEntry?.hooks.map((h: HookCmd) => h.command), [
        "$HOME/.claude/hooks/feature-branch-guard.sh",
      ]);
    },
  );
});

Deno.test("installing an unchanged hook twice is idempotent: no duplicate, no replace message", async () => {
  await withTempSettings(undefined, async (path) => {
    const args = [
      "--pre-tool-use",
      "mcp__(gmail|claude_ai_Gmail)__.*::$HOME/.claude/hooks/haiku-only-gmail-gate.sh",
    ];
    const first = await runMerge(path, args);
    assertEquals(first.code, 0, first.stderr);
    assert(first.stdout.includes("added PreToolUse hook"));

    const second = await runMerge(path, args);
    assertEquals(second.code, 0, second.stderr);
    assert(
      second.stdout.includes("already up to date (no-op)"),
      `expected no-op message, got: ${second.stdout}`,
    );
    assert(
      !second.stdout.includes("replaced"),
      `should not print replace message on idempotent re-run, got: ${second.stdout}`,
    );

    const data = await readJson(path);
    assertEquals(data.hooks.PreToolUse.length, 1);
    assertEquals(data.hooks.PreToolUse[0].hooks.length, 1);
  });
});

Deno.test("a matcher entry holding TWO commands, only one being re-pointed, keeps the other", async () => {
  await withTempSettings(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "$HOME/.claude/hooks/foo.sh" },
              { type: "command", command: "$HOME/.claude/hooks/bar.sh" },
            ],
          },
        ],
      },
    },
    async (path) => {
      const res = await runMerge(path, [
        "--pre-tool-use",
        "Bash::$HOME/.claude/hooks/bar.sh",
        "Edit|Write::$HOME/.claude/hooks/foo.sh",
      ]);
      assertEquals(res.code, 0, res.stderr);
      assert(
        res.stdout.includes("replaced stale matcher (Bash)"),
        `expected replace message, got: ${res.stdout}`,
      );

      const data = await readJson(path);
      // Should have Bash (with only bar.sh) and Edit|Write (with foo.sh)
      assertEquals(data.hooks.PreToolUse.length, 2);
      const bashEntry = data.hooks.PreToolUse.find((e: HookEntry) => e.matcher === "Bash");
      const editEntry = data.hooks.PreToolUse.find((e: HookEntry) => e.matcher === "Edit|Write");
      assertEquals(bashEntry?.hooks.map((h: HookCmd) => h.command), [
        "$HOME/.claude/hooks/bar.sh",
      ]);
      assertEquals(editEntry?.hooks.map((h: HookCmd) => h.command), [
        "$HOME/.claude/hooks/foo.sh",
      ]);
    },
  );
});

Deno.test("pruning in PostToolUse works the same way as PreToolUse", async () => {
  await withTempSettings(
    {
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "$HOME/.claude/hooks/check-output.sh" }],
          },
        ],
      },
    },
    async (path) => {
      const res = await runMerge(path, [
        "--post-tool-use",
        "Edit|Write::$HOME/.claude/hooks/check-output.sh",
      ]);
      assertEquals(res.code, 0, res.stderr);
      assert(
        res.stdout.includes("replaced stale matcher (Bash)"),
        `expected replace message, got: ${res.stdout}`,
      );

      const data = await readJson(path);
      assert(data.hooks.PostToolUse, "PostToolUse should exist");
      assertEquals(data.hooks.PostToolUse.length, 1);
      assertEquals(data.hooks.PostToolUse[0].matcher, "Edit|Write");
      assertEquals(
        data.hooks.PostToolUse[0].hooks[0].command,
        "$HOME/.claude/hooks/check-output.sh",
      );
    },
  );
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

// --- permissions.deny (web-jam-tools#308) ---

Deno.test("--deny adds patterns to permissions.deny when absent", async () => {
  await withTempSettings(undefined, async (path) => {
    const res = await runMerge(path, [
      "--deny",
      "Bash(git push --delete *)",
      "Bash(git push --force *)",
    ]);
    assertEquals(res.code, 0, res.stderr);
    assert(res.stdout.includes("added permissions.deny rule Bash(git push --delete *)"));
    assert(res.stdout.includes("added permissions.deny rule Bash(git push --force *)"));

    const data = await readJson(path);
    assertEquals(data.permissions?.deny, [
      "Bash(git push --delete *)",
      "Bash(git push --force *)",
    ]);
  });
});

Deno.test("a second --deny run with the same patterns is a no-op", async () => {
  // Seed a pre-existing (empty) settings.json so the first run's write is a
  // genuine backup-triggering update, not a from-scratch file creation.
  await withTempSettings({}, async (path) => {
    const args = ["--deny", "Bash(git push --delete *)", "Bash(git push --force *)"];
    const first = await runMerge(path, args);
    assertEquals(first.code, 0, first.stderr);
    const second = await runMerge(path, args);
    assertEquals(second.code, 0, second.stderr);
    assert(
      second.stdout.includes("already up to date (no-op)"),
      `expected no-op message, got: ${second.stdout}`,
    );

    const data = await readJson(path);
    assertEquals(data.permissions?.deny?.length, 2);

    const dir = path.slice(0, path.lastIndexOf("/"));
    const backups = [...Deno.readDirSync(dir)].filter((e) => e.name.includes(".bak-"));
    // One backup from the first (writing) run only; the no-op second run
    // must not write (and therefore must not back up) again.
    assertEquals(backups.length, 1);
  });
});

Deno.test(
  "pre-existing permissions.allow, permissions.ask, and permissions.deny entries survive a --deny merge untouched",
  async () => {
    await withTempSettings(
      {
        permissions: {
          allow: ["Bash(ls:*)", "Bash(npm test:*)"],
          ask: ["Bash(rm -rf *)"],
          deny: ["Bash(curl *)"],
        },
      },
      async (path) => {
        const res = await runMerge(path, [
          "--deny",
          "Bash(git push --delete *)",
        ]);
        assertEquals(res.code, 0, res.stderr);

        const data = await readJson(path);
        // allow/ask are byte-for-byte untouched.
        assertEquals(data.permissions?.allow, ["Bash(ls:*)", "Bash(npm test:*)"]);
        assertEquals(data.permissions?.ask, ["Bash(rm -rf *)"]);
        // deny keeps the pre-existing entry (order preserved) and appends
        // the new one — never reordered, never removed.
        assertEquals(data.permissions?.deny, [
          "Bash(curl *)",
          "Bash(git push --delete *)",
        ]);
      },
    );
  },
);

Deno.test("--deny combined with hook sections in one invocation merges both", async () => {
  await withTempSettings(undefined, async (path) => {
    const res = await runMerge(path, [
      "$HOME/.claude/hooks/notes-sync-reminder.sh",
      "--pre-tool-use",
      "Bash::$HOME/.claude/hooks/block-secret-dumps.sh",
      "--deny",
      "Bash(git push --delete *)",
      "Bash(git push -d *)",
    ]);
    assertEquals(res.code, 0, res.stderr);

    const data = await readJson(path);
    assertEquals(data.hooks.SessionStart.length, 1);
    assertEquals(data.hooks.PreToolUse.length, 1);
    assertEquals(data.permissions?.deny, [
      "Bash(git push --delete *)",
      "Bash(git push -d *)",
    ]);
  });
});

Deno.test(
  "install-hooks.sh's real DENY_RULES set merges cleanly and is idempotent (sandboxed CLAUDE_SETTINGS_PATH via --settings-path)",
  async () => {
    // Exercises the exact deny-pattern set install-hooks.sh ships (mirrored
    // here rather than parsed out of the shell script, to keep this test
    // independent of bash array syntax) against a real merge run, always via
    // the --settings-path override — never the live ~/.claude/settings.json.
    const DENY_RULES = [
      "Bash(git push --delete *)",
      "Bash(git push --delete)",
      "Bash(git push * --delete *)",
      "Bash(git push * --delete)",
      "Bash(git push -d *)",
      "Bash(git push -d)",
      "Bash(git push * -d *)",
      "Bash(git push * -d)",
      "Bash(git push --force *)",
      "Bash(git push --force)",
      "Bash(git push * --force *)",
      "Bash(git push * --force)",
      "Bash(git push -f *)",
      "Bash(git push -f)",
      "Bash(git push * -f *)",
      "Bash(git push * -f)",
      "Bash(git push --force-with-lease*)",
      "Bash(git push * --force-with-lease*)",
      "Bash(git branch -D remotes/*)",
      "Bash(git branch * -D remotes/*)",
      "Bash(git branch --delete --force remotes/*)",
      "Bash(git branch * --delete --force remotes/*)",
      "Bash(git push --mirror*)",
      "Bash(git push * --mirror*)",
      "Bash(git push --prune*)",
      "Bash(git push * --prune*)",
      "Read(//home/joshua/Dropbox/Apps/**)",
      "Edit(//home/joshua/Dropbox/Apps/**)",
      "Read(//home/joshua/Dropbox/BreakPoint Ministries/**)",
      "Edit(//home/joshua/Dropbox/BreakPoint Ministries/**)",
      "Read(//home/joshua/Dropbox/Camera Uploads/**)",
      "Edit(//home/joshua/Dropbox/Camera Uploads/**)",
      "Read(//home/joshua/Dropbox/Capture/**)",
      "Edit(//home/joshua/Dropbox/Capture/**)",
      "Read(//home/joshua/Dropbox/CollegeLutheran/**)",
      "Edit(//home/joshua/Dropbox/CollegeLutheran/**)",
      "Read(//home/joshua/Dropbox/DropsyncFiles/**)",
      "Edit(//home/joshua/Dropbox/DropsyncFiles/**)",
      "Read(//home/joshua/Dropbox/Galapagos/**)",
      "Edit(//home/joshua/Dropbox/Galapagos/**)",
      "Read(//home/joshua/Dropbox/InBetween SetsMusic/**)",
      "Edit(//home/joshua/Dropbox/InBetween SetsMusic/**)",
      "Read(//home/joshua/Dropbox/JoshMariaMusic_private/**)",
      "Edit(//home/joshua/Dropbox/JoshMariaMusic_private/**)",
      "Read(//home/joshua/Dropbox/Migrated Paper Docs/**)",
      "Edit(//home/joshua/Dropbox/Migrated Paper Docs/**)",
      "Read(//home/joshua/Dropbox/Other (1)/**)",
      "Edit(//home/joshua/Dropbox/Other (1)/**)",
      "Read(//home/joshua/Dropbox/ShermanHome/**)",
      "Edit(//home/joshua/Dropbox/ShermanHome/**)",
      "Read(//home/joshua/Dropbox/TimShermanMusic/**)",
      "Edit(//home/joshua/Dropbox/TimShermanMusic/**)",
      "Read(//home/joshua/Dropbox/Web Design/**)",
      "Edit(//home/joshua/Dropbox/Web Design/**)",
      "Read(//home/joshua/Dropbox/WebJamApps/**)",
      "Edit(//home/joshua/Dropbox/WebJamApps/**)",
      "Read(//home/joshua/Dropbox/web-jam-llc/**)",
      "Edit(//home/joshua/Dropbox/web-jam-llc/**)",
      "mcp__claude_ai_Dropbox__delete",
      "mcp__claude_ai_Dropbox__move",
    ];
    await withTempSettings(undefined, async (path) => {
      const first = await runMerge(path, ["--deny", ...DENY_RULES]);
      assertEquals(first.code, 0, first.stderr);
      const data = await readJson(path);
      assertEquals(data.permissions?.deny?.length, DENY_RULES.length);

      const second = await runMerge(path, ["--deny", ...DENY_RULES]);
      assertEquals(second.code, 0, second.stderr);
      assert(
        second.stdout.includes("already up to date (no-op)"),
        `expected no-op message, got: ${second.stdout}`,
      );
      const data2 = await readJson(path);
      assertEquals(data2.permissions?.deny?.length, DENY_RULES.length);
    });
  },
);

// --- permissions.allow (web-jam-tools#685, §3a) ---

Deno.test("--allow adds patterns to permissions.allow when absent", async () => {
  await withTempSettings(undefined, async (path) => {
    const res = await runMerge(path, [
      "--allow",
      "Bash(deno task post-pr-review *)",
      "Bash(deno task edit-issue *)",
    ]);
    assertEquals(res.code, 0, res.stderr);
    assert(res.stdout.includes("added permissions.allow rule Bash(deno task post-pr-review *)"));
    assert(res.stdout.includes("added permissions.allow rule Bash(deno task edit-issue *)"));

    const data = await readJson(path);
    assertEquals(data.permissions?.allow, [
      "Bash(deno task post-pr-review *)",
      "Bash(deno task edit-issue *)",
    ]);
  });
});

Deno.test("a second --allow run with the same patterns is a no-op", async () => {
  await withTempSettings({}, async (path) => {
    const args = ["--allow", "Bash(deno task post-pr-review *)"];
    const first = await runMerge(path, args);
    assertEquals(first.code, 0, first.stderr);
    const second = await runMerge(path, args);
    assertEquals(second.code, 0, second.stderr);
    assert(
      second.stdout.includes("already up to date (no-op)"),
      `expected no-op message, got: ${second.stdout}`,
    );

    const data = await readJson(path);
    assertEquals(data.permissions?.allow?.length, 1);
  });
});

Deno.test(
  "pre-existing permissions.allow, permissions.ask, and permissions.deny entries survive an --allow merge untouched",
  async () => {
    await withTempSettings(
      {
        permissions: {
          allow: ["Bash(ls:*)"],
          ask: ["Bash(rm -rf *)"],
          deny: ["Bash(curl *)"],
        },
      },
      async (path) => {
        const res = await runMerge(path, ["--allow", "Bash(deno task post-pr-review *)"]);
        assertEquals(res.code, 0, res.stderr);

        const data = await readJson(path);
        assertEquals(data.permissions?.ask, ["Bash(rm -rf *)"]);
        assertEquals(data.permissions?.deny, ["Bash(curl *)"]);
        // allow keeps the pre-existing entry (order preserved) and appends
        // the new one — never reordered, never removed.
        assertEquals(data.permissions?.allow, [
          "Bash(ls:*)",
          "Bash(deno task post-pr-review *)",
        ]);
      },
    );
  },
);

Deno.test(
  "install-hooks.sh's real ALLOW_RULES set merges cleanly and is idempotent (sandboxed CLAUDE_SETTINGS_PATH via --settings-path)",
  async () => {
    // Mirrors install-hooks.sh's ALLOW_RULES array (web-jam-tools#685, §3a)
    // rather than parsing it out of the shell script, same convention as the
    // DENY_RULES test above.
    const ALLOW_RULES = [
      "Bash(deno task post-pr-review *)",
      "Bash(deno task post-pr-comment *)",
      "Bash(deno task post-issue-comment *)",
      "Bash(deno task edit-issue *)",
      "Bash(deno task unblock-issue *)",
    ];
    await withTempSettings(undefined, async (path) => {
      const first = await runMerge(path, ["--allow", ...ALLOW_RULES]);
      assertEquals(first.code, 0, first.stderr);
      const data = await readJson(path);
      assertEquals(data.permissions?.allow, ALLOW_RULES);

      const second = await runMerge(path, ["--allow", ...ALLOW_RULES]);
      assertEquals(second.code, 0, second.stderr);
      assert(
        second.stdout.includes("already up to date (no-op)"),
        `expected no-op message, got: ${second.stdout}`,
      );
      const data2 = await readJson(path);
      assertEquals(data2.permissions?.allow?.length, ALLOW_RULES.length);
    });
  },
);

// --- permissions.ask (web-jam-tools#339) ---

Deno.test("--ask adds patterns to permissions.ask when absent", async () => {
  await withTempSettings(undefined, async (path) => {
    const res = await runMerge(path, [
      "--ask",
      "Bash(rm -rf *)",
      "Bash(dropdb *)",
    ]);
    assertEquals(res.code, 0, res.stderr);
    assert(res.stdout.includes("added permissions.ask rule Bash(rm -rf *)"));
    assert(res.stdout.includes("added permissions.ask rule Bash(dropdb *)"));

    const data = await readJson(path);
    assertEquals(data.permissions?.ask, [
      "Bash(rm -rf *)",
      "Bash(dropdb *)",
    ]);
  });
});

Deno.test("a second --ask run with the same patterns is a no-op", async () => {
  await withTempSettings({}, async (path) => {
    const args = ["--ask", "Bash(rm -rf *)"];
    const first = await runMerge(path, args);
    assertEquals(first.code, 0, first.stderr);
    const second = await runMerge(path, args);
    assertEquals(second.code, 0, second.stderr);
    assert(
      second.stdout.includes("already up to date (no-op)"),
      `expected no-op message, got: ${second.stdout}`,
    );

    const data = await readJson(path);
    assertEquals(data.permissions?.ask?.length, 1);
  });
});

Deno.test(
  "pre-existing permissions.allow and permissions.deny entries survive an --ask merge untouched",
  async () => {
    await withTempSettings(
      {
        permissions: {
          allow: ["Bash(ls:*)"],
          deny: ["Bash(git push --delete *)"],
        },
      },
      async (path) => {
        const res = await runMerge(path, [
          "--ask",
          "Bash(rm -rf *)",
        ]);
        assertEquals(res.code, 0, res.stderr);

        const data = await readJson(path);
        assertEquals(data.permissions?.allow, ["Bash(ls:*)"]);
        assertEquals(data.permissions?.deny, ["Bash(git push --delete *)"]);
        assertEquals(data.permissions?.ask, ["Bash(rm -rf *)"]);
      },
    );
  },
);

// --- --status-line (web-jam-tools#688) ---

Deno.test("--status-line adds statusLine when absent", async () => {
  await withTempSettings(undefined, async (path) => {
    const res = await runMerge(path, [
      "--status-line",
      "/home/joshua/WebJamApps/web-jam-tools/scripts/statusline.sh",
    ]);
    assertEquals(res.code, 0, res.stderr);
    assert(
      res.stdout.includes(
        "added statusLine /home/joshua/WebJamApps/web-jam-tools/scripts/statusline.sh",
      ),
    );

    const data = await readJson(path);
    assertEquals(data.statusLine, {
      type: "command",
      command: "/home/joshua/WebJamApps/web-jam-tools/scripts/statusline.sh",
    });
  });
});

Deno.test("a second --status-line run with the same command is a no-op", async () => {
  await withTempSettings({}, async (path) => {
    const args = ["--status-line", "/repo/scripts/statusline.sh"];
    const first = await runMerge(path, args);
    assertEquals(first.code, 0, first.stderr);
    const second = await runMerge(path, args);
    assertEquals(second.code, 0, second.stderr);
    assert(
      second.stdout.includes("already up to date (no-op)"),
      `expected no-op message, got: ${second.stdout}`,
    );

    const data = await readJson(path);
    assertEquals(data.statusLine, { type: "command", command: "/repo/scripts/statusline.sh" });

    const dir = path.slice(0, path.lastIndexOf("/"));
    const backups = [...Deno.readDirSync(dir)].filter((e) => e.name.includes(".bak-"));
    // One backup from the first (writing) run only; the no-op second run
    // must not write (and therefore must not back up) again.
    assertEquals(backups.length, 1);
  });
});

Deno.test("--status-line with a different command value updates the existing one", async () => {
  await withTempSettings(
    { statusLine: { type: "command", command: "/old/path/statusline.sh" } },
    async (path) => {
      const res = await runMerge(path, [
        "--status-line",
        "/repo/scripts/statusline.sh",
      ]);
      assertEquals(res.code, 0, res.stderr);
      assert(res.stdout.includes("updated statusLine to /repo/scripts/statusline.sh"));

      const data = await readJson(path);
      assertEquals(data.statusLine, {
        type: "command",
        command: "/repo/scripts/statusline.sh",
      });
    },
  );
});

Deno.test(
  "--status-line combined with a --pre-tool-use hook in one invocation merges both",
  async () => {
    await withTempSettings(undefined, async (path) => {
      const res = await runMerge(path, [
        "--pre-tool-use",
        "Bash::$HOME/.claude/hooks/block-secret-dumps.sh",
        "--status-line",
        "/repo/scripts/statusline.sh",
      ]);
      assertEquals(res.code, 0, res.stderr);

      const data = await readJson(path);
      assertEquals(data.hooks.PreToolUse.length, 1);
      assertEquals(data.statusLine, {
        type: "command",
        command: "/repo/scripts/statusline.sh",
      });
    });
  },
);

Deno.test(
  "existing unrelated settings (permissions, other hook events) survive a --status-line-only merge untouched",
  async () => {
    await withTempSettings(
      {
        permissions: { allow: ["Bash(ls:*)"], deny: ["Bash(curl *)"] },
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "/hand/added/stop.sh" }] },
          ],
        },
      },
      async (path) => {
        const res = await runMerge(path, [
          "--status-line",
          "/repo/scripts/statusline.sh",
        ]);
        assertEquals(res.code, 0, res.stderr);

        const data = await readJson(path);
        assertEquals(data.permissions?.allow, ["Bash(ls:*)"]);
        assertEquals(data.permissions?.deny, ["Bash(curl *)"]);
        assertEquals(data.hooks?.Stop?.[0]?.hooks?.[0]?.command, "/hand/added/stop.sh");
        assertEquals(data.statusLine, {
          type: "command",
          command: "/repo/scripts/statusline.sh",
        });
      },
    );
  },
);

Deno.test(
  "--check with --status-line returns 0 when the stored value already matches",
  async () => {
    await withTempSettings(undefined, async (path) => {
      const args = ["--status-line", "/repo/scripts/statusline.sh"];
      await runMerge(path, args);
      const checkRes = await runMerge(path, ["--check", ...args]);
      assertEquals(checkRes.code, 0, checkRes.stderr);
      assert(checkRes.stdout.includes("already up to date (no-op)"));
    });
  },
);

Deno.test(
  "--check with --status-line returns non-zero and mentions statusLine when the stored value is absent",
  async () => {
    await withTempSettings({}, async (path) => {
      const checkRes = await runMerge(path, [
        "--check",
        "--status-line",
        "/repo/scripts/statusline.sh",
      ]);
      assertEquals(checkRes.code, 1);
      assert(checkRes.stderr.includes("missing statusLine /repo/scripts/statusline.sh"));
    });
  },
);

Deno.test(
  "--check with --status-line returns non-zero and mentions statusLine when the stored value differs",
  async () => {
    await withTempSettings(
      { statusLine: { type: "command", command: "/old/path/statusline.sh" } },
      async (path) => {
        const checkRes = await runMerge(path, [
          "--check",
          "--status-line",
          "/repo/scripts/statusline.sh",
        ]);
        assertEquals(checkRes.code, 1);
        assert(checkRes.stderr.includes("statusLine differs from desired"));
        assert(checkRes.stderr.includes("/repo/scripts/statusline.sh"));
      },
    );
  },
);

// --- --check mode in merge-hooks-into-settings.ts (web-jam-tools#339) ---

Deno.test("--check returns 0 on an up-to-date settings file", async () => {
  await withTempSettings(undefined, async (path) => {
    const args = ["--ask", "Bash(rm -rf *)"];
    await runMerge(path, args);
    const checkRes = await runMerge(path, ["--check", ...args]);
    assertEquals(checkRes.code, 0, checkRes.stderr);
    assert(checkRes.stdout.includes("already up to date (no-op)"));
  });
});

Deno.test("--check returns non-zero and reports missing rules when drift exists", async () => {
  await withTempSettings({ permissions: { ask: [] } }, async (path) => {
    const checkRes = await runMerge(path, ["--check", "--ask", "Bash(rm -rf *)"]);
    assertEquals(checkRes.code, 1);
    assert(checkRes.stderr.includes("missing permissions.ask rule Bash(rm -rf *)"));
  });
});

// --- Secret-scan gate in merge-hooks-into-settings.ts (web-jam-tools#339) ---

Deno.test("secret-scan gate refuses to merge when synthetic JWT secret fixture is in permissions", async () => {
  // Varied per-segment, not repeated — the credential detector's
  // synthetic-value heuristic would otherwise auto-suppress an 8+ run of
  // the same character, defeating this "must fail closed" fixture.
  const jwtSecret = "eyJ" + variedFakeBody(20, 60) + "." + variedFakeBody(20, 61) + "." +
    variedFakeBody(20, 62);
  await withTempSettings(
    {
      permissions: {
        allow: [`Bash(export TOKEN="${jwtSecret}")`],
      },
    },
    async (path) => {
      const res = await runMerge(path, ["--ask", "Bash(rm -rf *)"]);
      assertEquals(res.code, 1);
      assert(res.stderr.includes("SECRET DETECTED"), res.stderr);
      assert(res.stderr.includes("JWT token"), res.stderr);
      assert(!res.stderr.includes(jwtSecret), "secret value must not be printed");
    },
  );
});

// --- Pruning retired/orphaned hook entries (web-jam-tools#430) ---

Deno.test(
  "prunes orphaned hook entries from SessionStart, SessionEnd, Stop, PreToolUse, and PostToolUse",
  async () => {
    await withTempSettings(
      {
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "$HOME/.claude/hooks/retired-start.sh" }] },
            { hooks: [{ type: "command", command: "$HOME/.claude/hooks/active-start.sh" }] },
          ],
          Stop: [
            { hooks: [{ type: "command", command: "$HOME/.claude/hooks/retired-stop.sh" }] },
            { hooks: [{ type: "command", command: "$HOME/.claude/hooks/active-stop.sh" }] },
          ],
          SessionEnd: [
            { hooks: [{ type: "command", command: "$HOME/.claude/hooks/retired-end.sh" }] },
            { hooks: [{ type: "command", command: "$HOME/.claude/hooks/active-end.sh" }] },
          ],
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: "$HOME/.claude/hooks/retired-pre.sh" },
                { type: "command", command: "$HOME/.claude/hooks/active-pre.sh" },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: "$HOME/.claude/hooks/retired-post.sh" },
                { type: "command", command: "$HOME/.claude/hooks/active-post.sh" },
              ],
            },
          ],
        },
      },
      async (path) => {
        const res = await runMerge(path, [
          "$HOME/.claude/hooks/active-start.sh",
          "--stop",
          "$HOME/.claude/hooks/active-stop.sh",
          "--session-end",
          "$HOME/.claude/hooks/active-end.sh",
          "--pre-tool-use",
          "Bash::$HOME/.claude/hooks/active-pre.sh",
          "--post-tool-use",
          "Bash::$HOME/.claude/hooks/active-post.sh",
        ]);
        assertEquals(res.code, 0, res.stderr);
        assert(
          res.stdout.includes(
            "removed retired SessionStart hook $HOME/.claude/hooks/retired-start.sh",
          ),
        );
        assert(
          res.stdout.includes("removed retired Stop hook $HOME/.claude/hooks/retired-stop.sh"),
        );
        assert(
          res.stdout.includes(
            "removed retired SessionEnd hook $HOME/.claude/hooks/retired-end.sh",
          ),
        );
        assert(res.stdout.includes("removed retired hook (Bash)"));

        const data = await readJson(path);
        assertEquals(data.hooks.SessionStart.length, 1);
        assertEquals(
          data.hooks.SessionStart[0].hooks[0].command,
          "$HOME/.claude/hooks/active-start.sh",
        );
        assertEquals(data.hooks.Stop?.length, 1);
        assertEquals(
          data.hooks.Stop?.[0].hooks[0].command,
          "$HOME/.claude/hooks/active-stop.sh",
        );
        assertEquals(data.hooks.SessionEnd?.length, 1);
        assertEquals(
          data.hooks.SessionEnd?.[0].hooks[0].command,
          "$HOME/.claude/hooks/active-end.sh",
        );
        assertEquals(data.hooks.PreToolUse.length, 1);
        assertEquals(data.hooks.PreToolUse[0].hooks.map((h: HookCmd) => h.command), [
          "$HOME/.claude/hooks/active-pre.sh",
        ]);
        assertEquals(data.hooks.PostToolUse?.length, 1);
        assertEquals(data.hooks.PostToolUse?.[0].hooks.map((h: HookCmd) => h.command), [
          "$HOME/.claude/hooks/active-post.sh",
        ]);
      },
    );
  },
);

Deno.test(
  "prunes orphaned entry from agy hooks.json target",
  async () => {
    await withTempSettings(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: "$HOME/.claude/hooks/retired-agy.sh" },
                { type: "command", command: "$HOME/.claude/hooks/active-agy.sh" },
              ],
            },
          ],
        },
      },
      async (path) => {
        const res = await runMerge(path, [
          "--pre-tool-use",
          "Bash::$HOME/.claude/hooks/active-agy.sh",
        ]);
        assertEquals(res.code, 0, res.stderr);
        const data = await readJson(path);
        assertEquals(data.hooks.PreToolUse.length, 1);
        assertEquals(data.hooks.PreToolUse[0].hooks.map((h: HookCmd) => h.command), [
          "$HOME/.claude/hooks/active-agy.sh",
        ]);
      },
    );
  },
);

Deno.test(
  "prunes and replaces managed flat hooks with the same script but different arguments (web-jam-tools#1211)",
  async () => {
    // 1. Claude settings.json nested shape (mergeFlatHooks)
    await withTempSettings(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "$HOME/.claude/hooks/my-hook.sh old-arg",
                },
              ],
            },
          ],
        },
      },
      async (path) => {
        // --check reports drift for the old argument
        const check = await runMerge(path, [
          "--check",
          "--stop",
          "$HOME/.claude/hooks/my-hook.sh new-arg",
        ]);
        assertEquals(check.code, 1);
        assert(
          check.stderr.includes(
            "has retired Stop hook $HOME/.claude/hooks/my-hook.sh old-arg",
          ),
          check.stderr,
        );
        assert(
          check.stderr.includes(
            "missing Stop hook $HOME/.claude/hooks/my-hook.sh new-arg",
          ),
          check.stderr,
        );

        // Merge prunes old argument and replaces with new argument
        const res = await runMerge(path, [
          "--stop",
          "$HOME/.claude/hooks/my-hook.sh new-arg",
        ]);
        assertEquals(res.code, 0, res.stderr);
        assert(
          res.stdout.includes(
            "removed retired Stop hook $HOME/.claude/hooks/my-hook.sh old-arg",
          ),
          res.stdout,
        );
        assert(
          res.stdout.includes(
            "added Stop hook $HOME/.claude/hooks/my-hook.sh new-arg",
          ),
          res.stdout,
        );

        const data = await readJson(path);
        assertEquals(data.hooks.Stop?.length, 1);
        assertEquals(
          data.hooks.Stop?.[0].hooks[0].command,
          "$HOME/.claude/hooks/my-hook.sh new-arg",
        );
      },
    );

    // 2. Agy hooks.json flat shape (mergeAgyFlatHooks)
    await withTempSettings(
      {
        hooks: {
          Stop: [
            {
              type: "command",
              command: "$HOME/.claude/hooks/my-hook.sh old-arg",
            },
          ],
        },
      },
      async (path) => {
        // --check reports drift for the old argument
        const check = await runMerge(path, [
          "--check",
          "--forbid-lifecycle-hooks",
          "--stop",
          "$HOME/.claude/hooks/my-hook.sh new-arg",
        ]);
        assertEquals(check.code, 1);
        assert(
          check.stderr.includes(
            "has retired Stop hook $HOME/.claude/hooks/my-hook.sh old-arg",
          ),
          check.stderr,
        );
        assert(
          check.stderr.includes(
            "missing Stop hook $HOME/.claude/hooks/my-hook.sh new-arg",
          ),
          check.stderr,
        );

        // Merge prunes old argument and replaces with new argument
        const res = await runMerge(path, [
          "--forbid-lifecycle-hooks",
          "--stop",
          "$HOME/.claude/hooks/my-hook.sh new-arg",
        ]);
        assertEquals(res.code, 0, res.stderr);
        assert(
          res.stdout.includes(
            "removed retired Stop hook $HOME/.claude/hooks/my-hook.sh old-arg",
          ),
          res.stdout,
        );
        assert(
          res.stdout.includes(
            "added Stop hook $HOME/.claude/hooks/my-hook.sh new-arg",
          ),
          res.stdout,
        );

        const raw = JSON.parse(await Deno.readTextFile(path));
        assertEquals(raw.hooks.Stop, [
          {
            type: "command",
            command: "$HOME/.claude/hooks/my-hook.sh new-arg",
          },
        ]);
      },
    );
  },
);

// --- Cross-list retraction: a rule that moved between DENY_RULES and
// ASK_RULES must not survive as a stale copy in the array it left
// (web-jam-tools#525) ---

Deno.test(
  "a pattern moved from --deny to --ask is removed from permissions.deny on install",
  async () => {
    await withTempSettings(
      { permissions: { deny: ["Bash(git push --force-with-lease*)"] } },
      async (path) => {
        const res = await runMerge(path, [
          "--ask",
          "Bash(git push --force-with-lease*)",
        ]);
        assertEquals(res.code, 0, res.stderr);
        assert(
          res.stdout.includes(
            "removed permissions.deny rule Bash(git push --force-with-lease*) (now owned by permissions.ask)",
          ),
          res.stdout,
        );

        const data = await readJson(path);
        assertEquals(data.permissions?.deny, []);
        assertEquals(data.permissions?.ask, ["Bash(git push --force-with-lease*)"]);
      },
    );
  },
);

Deno.test(
  "a pattern moved from --ask to --deny is removed from permissions.ask on install",
  async () => {
    await withTempSettings(
      { permissions: { ask: ["Bash(rm -rf *)"] } },
      async (path) => {
        const res = await runMerge(path, [
          "--deny",
          "Bash(rm -rf *)",
        ]);
        assertEquals(res.code, 0, res.stderr);
        assert(
          res.stdout.includes(
            "removed permissions.ask rule Bash(rm -rf *) (now owned by permissions.deny)",
          ),
          res.stdout,
        );

        const data = await readJson(path);
        assertEquals(data.permissions?.ask, []);
        assertEquals(data.permissions?.deny, ["Bash(rm -rf *)"]);
      },
    );
  },
);

Deno.test(
  "a pattern present in neither versioned array is never removed from permissions.ask or permissions.deny",
  async () => {
    await withTempSettings(
      {
        permissions: {
          deny: ["Bash(some-unowned-deny-rule *)"],
          ask: ["Bash(some-unowned-ask-rule *)"],
        },
      },
      async (path) => {
        const res = await runMerge(path, [
          "--deny",
          "Bash(git push --force *)",
          "--ask",
          "Bash(rm -rf *)",
        ]);
        assertEquals(res.code, 0, res.stderr);

        const data = await readJson(path);
        assertEquals(data.permissions?.deny, [
          "Bash(some-unowned-deny-rule *)",
          "Bash(git push --force *)",
        ]);
        assertEquals(data.permissions?.ask, [
          "Bash(some-unowned-ask-rule *)",
          "Bash(rm -rf *)",
        ]);
      },
    );
  },
);

Deno.test(
  "--check reports a pattern present in both permissions.deny and permissions.ask as drift",
  async () => {
    await withTempSettings(
      {
        permissions: {
          deny: ["Bash(git push --force-with-lease*)"],
          ask: ["Bash(git push --force-with-lease*)"],
        },
      },
      async (path) => {
        const checkRes = await runMerge(path, [
          "--check",
          "--ask",
          "Bash(git push --force-with-lease*)",
        ]);
        assertEquals(checkRes.code, 1);
        assert(
          checkRes.stderr.includes(
            "permissions.deny rule Bash(git push --force-with-lease*) is also in permissions.ask (stale copy)",
          ),
          checkRes.stderr,
        );
      },
    );
  },
);

Deno.test(
  "--check still passes (exit 0) on a settings file with no cross-listed patterns",
  async () => {
    await withTempSettings(
      { permissions: { deny: [], ask: ["Bash(rm -rf *)"] } },
      async (path) => {
        const checkRes = await runMerge(path, ["--check", "--ask", "Bash(rm -rf *)"]);
        assertEquals(checkRes.code, 0, checkRes.stderr);
      },
    );
  },
);

Deno.test(
  "re-running the installer after a cross-list retraction is idempotent and reports no changes",
  async () => {
    await withTempSettings(
      { permissions: { deny: ["Bash(git push --force-with-lease*)"] } },
      async (path) => {
        const args = ["--ask", "Bash(git push --force-with-lease*)"];
        const first = await runMerge(path, args);
        assertEquals(first.code, 0, first.stderr);
        const second = await runMerge(path, args);
        assertEquals(second.code, 0, second.stderr);
        assert(
          second.stdout.includes("already up to date (no-op)"),
          `expected no-op message, got: ${second.stdout}`,
        );

        const data = await readJson(path);
        assertEquals(data.permissions?.deny, []);
        assertEquals(data.permissions?.ask, ["Bash(git push --force-with-lease*)"]);
      },
    );
  },
);

Deno.test(
  "a pattern moved to --ask is removed from permissions.allow on install (R-39, R-43, web-jam-tools#448)",
  async () => {
    await withTempSettings(
      {
        permissions: {
          allow: [
            "mcp__google-drive__deleteItem",
            "mcp__google-drive__addPermission",
            "mcp__google-drive__updatePermission",
            "mcp__google-drive__listFolder",
          ],
        },
      },
      async (path) => {
        const res = await runMerge(path, [
          "--ask",
          "mcp__google-drive__deleteItem",
          "mcp__google-drive__addPermission",
          "mcp__google-drive__updatePermission",
        ]);
        assertEquals(res.code, 0, res.stderr);
        assert(
          res.stdout.includes(
            "removed permissions.allow rule mcp__google-drive__deleteItem (now owned by permissions.ask)",
          ),
          res.stdout,
        );
        assert(
          res.stdout.includes(
            "removed permissions.allow rule mcp__google-drive__addPermission (now owned by permissions.ask)",
          ),
          res.stdout,
        );
        assert(
          res.stdout.includes(
            "removed permissions.allow rule mcp__google-drive__updatePermission (now owned by permissions.ask)",
          ),
          res.stdout,
        );

        const data = await readJson(path);
        assertEquals(data.permissions?.allow, ["mcp__google-drive__listFolder"]);
        assertEquals(data.permissions?.ask, [
          "mcp__google-drive__deleteItem",
          "mcp__google-drive__addPermission",
          "mcp__google-drive__updatePermission",
        ]);
      },
    );
  },
);

Deno.test(
  "a pattern moved to --deny is removed from permissions.allow on install (R-40, web-jam-tools#448)",
  async () => {
    await withTempSettings(
      {
        permissions: {
          allow: ["mcp__gmail__send_email", "mcp__gmail__read_email"],
        },
      },
      async (path) => {
        const res = await runMerge(path, [
          "--deny",
          "mcp__gmail__send_email",
        ]);
        assertEquals(res.code, 0, res.stderr);
        assert(
          res.stdout.includes(
            "removed permissions.allow rule mcp__gmail__send_email (now owned by permissions.deny)",
          ),
          res.stdout,
        );

        const data = await readJson(path);
        assertEquals(data.permissions?.allow, ["mcp__gmail__read_email"]);
        assertEquals(data.permissions?.deny, ["mcp__gmail__send_email"]);
      },
    );
  },
);

Deno.test(
  "--check reports a pattern present in both permissions.allow and permissions.ask or permissions.deny as drift (web-jam-tools#448)",
  async () => {
    await withTempSettings(
      {
        permissions: {
          allow: [
            "mcp__google-drive__deleteItem",
            "mcp__google-drive__addPermission",
            "mcp__google-drive__updatePermission",
            "mcp__gmail__send_email",
          ],
        },
      },
      async (path) => {
        const checkRes = await runMerge(path, [
          "--check",
          "--ask",
          "mcp__google-drive__deleteItem",
          "mcp__google-drive__addPermission",
          "mcp__google-drive__updatePermission",
          "--deny",
          "mcp__gmail__send_email",
        ]);
        assertEquals(checkRes.code, 1);
        assert(
          checkRes.stderr.includes(
            "permissions.allow rule mcp__google-drive__deleteItem is also in permissions.ask (stale copy)",
          ),
          checkRes.stderr,
        );
        assert(
          checkRes.stderr.includes(
            "permissions.allow rule mcp__google-drive__addPermission is also in permissions.ask (stale copy)",
          ),
          checkRes.stderr,
        );
        assert(
          checkRes.stderr.includes(
            "permissions.allow rule mcp__google-drive__updatePermission is also in permissions.ask (stale copy)",
          ),
          checkRes.stderr,
        );
        assert(
          checkRes.stderr.includes(
            "permissions.allow rule mcp__gmail__send_email is also in permissions.deny (stale copy)",
          ),
          checkRes.stderr,
        );
      },
    );
  },
);

Deno.test(
  "--check mode in merge-hooks-into-settings.ts reports drift on stale/retired hook entries",
  async () => {
    await withTempSettings(
      {
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "$HOME/.claude/hooks/retired-start.sh" }] },
          ],
          SessionEnd: [
            { hooks: [{ type: "command", command: "$HOME/.claude/hooks/retired-end.sh" }] },
          ],
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "$HOME/.claude/hooks/retired-pre.sh" }],
            },
          ],
        },
      },
      async (path) => {
        const checkRes = await runMerge(path, [
          "--check",
          "$HOME/.claude/hooks/active-start.sh",
          "--session-end",
          "$HOME/.claude/hooks/active-end.sh",
          "--pre-tool-use",
          "Bash::$HOME/.claude/hooks/active-pre.sh",
        ]);
        assertEquals(checkRes.code, 1);
        assert(checkRes.stderr.includes("has retired SessionStart hook"));
        assert(checkRes.stderr.includes("has retired SessionEnd hook"));
        assert(checkRes.stderr.includes("has retired hook (Bash)"));
      },
    );
  },
);

Deno.test(
  "--check mode in merge-hooks-into-settings.ts reports drift when SessionEnd hook is missing",
  async () => {
    await withTempSettings(
      {
        hooks: {
          SessionEnd: [],
        },
      },
      async (path) => {
        const checkRes = await runMerge(path, [
          "--check",
          "--session-end",
          "$HOME/.claude/hooks/prune-permission-allows-on-session-end.sh",
        ]);
        assertEquals(checkRes.code, 1);
        assert(
          checkRes.stderr.includes(
            "missing SessionEnd hook $HOME/.claude/hooks/prune-permission-allows-on-session-end.sh",
          ),
        );
      },
    );
  },
);

// --- --auto-mode: whole-object autoMode section ---

interface SettingsWithAutoMode {
  autoMode?: unknown;
  permissions?: { allow?: string[]; defaultMode?: string };
  model?: string;
}
const readSettings = async (p: string): Promise<SettingsWithAutoMode> =>
  JSON.parse(await Deno.readTextFile(p));

const AUTO_MODE = {
  environment: ["**Trusted repo**: every git repo under /home/joshua/WebJamApps/"],
  allow: ["$defaults", "Agent PR branches: plain pushes are ordinary delegated work."],
  soft_deny: ["$defaults", "Bash(rclone purge*)"],
};
const AUTO_MODE_ARGS = ["--auto-mode", JSON.stringify(AUTO_MODE)];

Deno.test("--auto-mode installs autoMode when absent", async () => {
  await withTempSettings(undefined, async (path) => {
    const res = await runMerge(path, AUTO_MODE_ARGS);
    assertEquals(res.code, 0, res.stderr);
    assert(res.stdout.includes("added autoMode section"));
    assertEquals((await readSettings(path)).autoMode, AUTO_MODE);
  });
});

Deno.test("a second --auto-mode run is a no-op and writes no second backup", async () => {
  await withTempSettings({}, async (path) => {
    assertEquals((await runMerge(path, AUTO_MODE_ARGS)).code, 0);
    const second = await runMerge(path, AUTO_MODE_ARGS);
    assertEquals(second.code, 0, second.stderr);
    assert(second.stdout.includes("already up to date (no-op)"));
    const dir = path.slice(0, path.lastIndexOf("/"));
    const backups = [...Deno.readDirSync(dir)].filter((e) => e.name.includes(".bak-"));
    assertEquals(backups.length, 1);
  });
});

Deno.test("--auto-mode leaves every other key alone and replaces a differing autoMode", async () => {
  await withTempSettings(
    {
      permissions: { allow: ["Bash(ls:*)"], defaultMode: "auto" },
      model: "opus",
      autoMode: { environment: ["stale"] },
    },
    async (path) => {
      const res = await runMerge(path, AUTO_MODE_ARGS);
      assertEquals(res.code, 0, res.stderr);
      assert(res.stdout.includes("updated autoMode"));
      const data = await readSettings(path);
      assertEquals(data.autoMode, AUTO_MODE);
      assertEquals(data.permissions?.allow, ["Bash(ls:*)"]);
      assertEquals(data.permissions?.defaultMode, "auto");
      assertEquals(data.model, "opus");
    },
  );
});

Deno.test("--check with --auto-mode flags a missing or differing autoMode and passes when equal", async () => {
  await withTempSettings({}, async (path) => {
    const missing = await runMerge(path, ["--check", ...AUTO_MODE_ARGS]);
    assertEquals(missing.code, 1);
    assert(missing.stderr.includes("missing autoMode section"));
    await Deno.writeTextFile(path, JSON.stringify({ autoMode: { allow: ["x"] } }));
    const differs = await runMerge(path, ["--check", ...AUTO_MODE_ARGS]);
    assertEquals(differs.code, 1);
    assert(differs.stderr.includes("autoMode differs"));
    // --check never writes.
    assertEquals((await readSettings(path)).autoMode, { allow: ["x"] });
    // Key order alone is not drift.
    const reordered = {
      soft_deny: AUTO_MODE.soft_deny,
      allow: AUTO_MODE.allow,
      environment: AUTO_MODE.environment,
    };
    await Deno.writeTextFile(path, JSON.stringify({ autoMode: reordered }));
    assertEquals((await runMerge(path, ["--check", ...AUTO_MODE_ARGS])).code, 0);
  });
});

// A hand edit is how autoMode has been changed so far, and a replace discards
// it, so both --check and the replace have to name what differs.
const HAND_EDITED_AUTO_MODE = {
  environment: AUTO_MODE.environment,
  allow: ["$defaults", "hand edit"],
  extra: true,
};
const AUTO_MODE_DIFF_LINES = [
  'autoMode.allow: entry not in the versioned config: "hand edit"',
  'autoMode.allow: versioned entry missing: "Agent PR branches: plain pushes are ordinary delegated work."',
  "autoMode.extra: key is not in the versioned config",
  "autoMode.soft_deny: key is missing",
];

Deno.test("--check with --auto-mode names the keys and entries that differ", async () => {
  await withTempSettings({ autoMode: HAND_EDITED_AUTO_MODE }, async (path) => {
    const res = await runMerge(path, ["--check", ...AUTO_MODE_ARGS]);
    assertEquals(res.code, 1);
    for (const line of AUTO_MODE_DIFF_LINES) {
      assert(res.stderr.includes(line), `missing "${line}" in:\n${res.stderr}`);
    }
    assert(!res.stderr.includes("autoMode.environment"), res.stderr);
  });
});

Deno.test("replacing a differing autoMode prints what the replaced value had", async () => {
  await withTempSettings({ autoMode: HAND_EDITED_AUTO_MODE }, async (path) => {
    const res = await runMerge(path, AUTO_MODE_ARGS);
    assertEquals(res.code, 0, res.stderr);
    for (const line of AUTO_MODE_DIFF_LINES) {
      assert(res.stdout.includes(line), `missing "${line}" in:\n${res.stdout}`);
    }
    assertEquals((await readSettings(path)).autoMode, AUTO_MODE);
  });
});

Deno.test("the autoMode drift report covers reordered lists, non-list values, long entries and a non-object", async () => {
  const longEntry = "x".repeat(300);
  await withTempSettings(
    {
      autoMode: {
        environment: "not a list",
        allow: [...AUTO_MODE.allow].reverse(),
        soft_deny: [...AUTO_MODE.soft_deny, longEntry],
      },
    },
    async (path) => {
      const res = await runMerge(path, ["--check", ...AUTO_MODE_ARGS]);
      assertEquals(res.code, 1);
      assert(res.stderr.includes("autoMode.environment: value differs"), res.stderr);
      assert(
        res.stderr.includes("autoMode.allow: same entries in a different order or count"),
        res.stderr,
      );
      assert(
        res.stderr.includes(
          `autoMode.soft_deny: entry not in the versioned config: "${"x".repeat(116)}...`,
        ),
        res.stderr,
      );
      assert(!res.stderr.includes(longEntry), "a long entry must be cut short");

      await Deno.writeTextFile(path, JSON.stringify({ autoMode: "on" }));
      const notObject = await runMerge(path, ["--check", ...AUTO_MODE_ARGS]);
      assertEquals(notObject.code, 1);
      assert(
        notObject.stderr.includes("autoMode: the installed value is not an object"),
        notObject.stderr,
      );
    },
  );
});

Deno.test("secret-scan gate refuses an autoMode that carries a credential literal", async () => {
  // Varied per-segment, as in the permissions fixture above.
  const jwtSecret = "eyJ" + variedFakeBody(20, 63) + "." + variedFakeBody(20, 64) + "." +
    variedFakeBody(20, 65);
  const withSecret = { ...AUTO_MODE, environment: [`token ${jwtSecret}`] };
  await withTempSettings({ model: "opus" }, async (path) => {
    const res = await runMerge(path, ["--auto-mode", JSON.stringify(withSecret)]);
    assertEquals(res.code, 1);
    assert(res.stderr.includes("SECRET DETECTED"), res.stderr);
    assert(res.stderr.includes("autoMode.environment[0]: JWT token"), res.stderr);
    assert(!res.stderr.includes(jwtSecret), "secret value must not be printed");
    assertEquals(await readSettings(path), { model: "opus" });
  });
});

// --- --skill-overrides: whole-object skillOverrides section (web-jam-tools#1240) ---

interface SettingsWithSkillOverrides {
  skillOverrides?: unknown;
  permissions?: { allow?: string[]; defaultMode?: string };
  model?: string;
}
const readSettingsWithSkillOverrides = async (p: string): Promise<SettingsWithSkillOverrides> =>
  JSON.parse(await Deno.readTextFile(p));

const SAMPLE_SKILL_OVERRIDES = {
  "anthropic-skills:pdf": "name-only",
  "keybindings-help": "name-only",
};
const SAMPLE_SKILL_OVERRIDES_ARGS = ["--skill-overrides", JSON.stringify(SAMPLE_SKILL_OVERRIDES)];

Deno.test("--skill-overrides installs skillOverrides when absent", async () => {
  await withTempSettings(undefined, async (path) => {
    const res = await runMerge(path, SAMPLE_SKILL_OVERRIDES_ARGS);
    assertEquals(res.code, 0, res.stderr);
    assert(res.stdout.includes("added skillOverrides section"));
    assertEquals(
      (await readSettingsWithSkillOverrides(path)).skillOverrides,
      SAMPLE_SKILL_OVERRIDES,
    );
  });
});

Deno.test("a second --skill-overrides run is a no-op and writes no second backup", async () => {
  await withTempSettings({}, async (path) => {
    assertEquals((await runMerge(path, SAMPLE_SKILL_OVERRIDES_ARGS)).code, 0);
    const second = await runMerge(path, SAMPLE_SKILL_OVERRIDES_ARGS);
    assertEquals(second.code, 0, second.stderr);
    assert(second.stdout.includes("already up to date (no-op)"));
    const dir = path.slice(0, path.lastIndexOf("/"));
    const backups = [...Deno.readDirSync(dir)].filter((e) => e.name.includes(".bak-"));
    assertEquals(backups.length, 1);
  });
});

Deno.test("--skill-overrides leaves every other key alone and replaces a differing skillOverrides", async () => {
  await withTempSettings(
    {
      permissions: { allow: ["Bash(ls:*)"], defaultMode: "auto" },
      model: "opus",
      skillOverrides: { "keybindings-help": "full" },
    },
    async (path) => {
      const res = await runMerge(path, SAMPLE_SKILL_OVERRIDES_ARGS);
      assertEquals(res.code, 0, res.stderr);
      assert(res.stdout.includes("updated skillOverrides"));
      const data = await readSettingsWithSkillOverrides(path);
      assertEquals(data.skillOverrides, SAMPLE_SKILL_OVERRIDES);
      assertEquals(data.permissions?.allow, ["Bash(ls:*)"]);
      assertEquals(data.permissions?.defaultMode, "auto");
      assertEquals(data.model, "opus");
    },
  );
});

Deno.test("--check with --skill-overrides flags a missing or differing skillOverrides and passes when equal", async () => {
  await withTempSettings({}, async (path) => {
    const missing = await runMerge(path, ["--check", ...SAMPLE_SKILL_OVERRIDES_ARGS]);
    assertEquals(missing.code, 1);
    assert(missing.stderr.includes("missing skillOverrides section"));
    await Deno.writeTextFile(
      path,
      JSON.stringify({ skillOverrides: { "keybindings-help": "name-only" } }),
    );
    const differs = await runMerge(path, ["--check", ...SAMPLE_SKILL_OVERRIDES_ARGS]);
    assertEquals(differs.code, 1);
    assert(differs.stderr.includes("skillOverrides differs"));
    // --check never writes.
    assertEquals((await readSettingsWithSkillOverrides(path)).skillOverrides, {
      "keybindings-help": "name-only",
    });
    // Key order alone is not drift.
    const reordered = {
      "keybindings-help": "name-only",
      "anthropic-skills:pdf": "name-only",
    };
    await Deno.writeTextFile(path, JSON.stringify({ skillOverrides: reordered }));
    assertEquals((await runMerge(path, ["--check", ...SAMPLE_SKILL_OVERRIDES_ARGS])).code, 0);
  });
});

const HAND_EDITED_SKILL_OVERRIDES = {
  "anthropic-skills:pdf": "name-only",
  "keybindings-help": "full",
  "extra-skill": "name-only",
};
const SKILL_OVERRIDES_DIFF_LINES = [
  "skillOverrides.extra-skill: key is not in the versioned config",
  "skillOverrides.keybindings-help: value differs",
];

Deno.test("--check with --skill-overrides names the keys and entries that differ", async () => {
  await withTempSettings({ skillOverrides: HAND_EDITED_SKILL_OVERRIDES }, async (path) => {
    const res = await runMerge(path, ["--check", ...SAMPLE_SKILL_OVERRIDES_ARGS]);
    assertEquals(res.code, 1);
    for (const line of SKILL_OVERRIDES_DIFF_LINES) {
      assert(res.stderr.includes(line), `missing "${line}" in:\n${res.stderr}`);
    }
    assert(!res.stderr.includes("anthropic-skills:pdf"), res.stderr);
  });
});

Deno.test("replacing a differing skillOverrides prints what the replaced value had", async () => {
  await withTempSettings({ skillOverrides: HAND_EDITED_SKILL_OVERRIDES }, async (path) => {
    const res = await runMerge(path, SAMPLE_SKILL_OVERRIDES_ARGS);
    assertEquals(res.code, 0, res.stderr);
    for (const line of SKILL_OVERRIDES_DIFF_LINES) {
      assert(res.stdout.includes(line), `missing "${line}" in:\n${res.stdout}`);
    }
    assertEquals(
      (await readSettingsWithSkillOverrides(path)).skillOverrides,
      SAMPLE_SKILL_OVERRIDES,
    );
  });
});

Deno.test("the skillOverrides drift report covers non-object and missing keys", async () => {
  await withTempSettings(
    {
      skillOverrides: "not-an-object",
    },
    async (path) => {
      const res = await runMerge(path, ["--check", ...SAMPLE_SKILL_OVERRIDES_ARGS]);
      assertEquals(res.code, 1);
      assert(
        res.stderr.includes("skillOverrides: the installed value is not an object"),
        res.stderr,
      );

      await Deno.writeTextFile(path, JSON.stringify({ skillOverrides: {} }));
      const missing = await runMerge(path, ["--check", ...SAMPLE_SKILL_OVERRIDES_ARGS]);
      assertEquals(missing.code, 1);
      assert(
        missing.stderr.includes("skillOverrides.anthropic-skills:pdf: key is missing"),
        missing.stderr,
      );
      assert(
        missing.stderr.includes("skillOverrides.keybindings-help: key is missing"),
        missing.stderr,
      );
    },
  );
});

Deno.test("secret-scan gate refuses a skillOverrides that carries a credential literal", async () => {
  const jwtSecret = "eyJ" + variedFakeBody(20, 63) + "." + variedFakeBody(20, 64) + "." +
    variedFakeBody(20, 65);
  const withSecret = { ...SAMPLE_SKILL_OVERRIDES, "bad-skill": jwtSecret };
  await withTempSettings({ model: "opus" }, async (path) => {
    const res = await runMerge(path, ["--skill-overrides", JSON.stringify(withSecret)]);
    assertEquals(res.code, 1);
    assert(res.stderr.includes("SECRET DETECTED"), res.stderr);
    assert(res.stderr.includes("skillOverrides.bad-skill: JWT token"), res.stderr);
    assert(!res.stderr.includes(jwtSecret), "secret value must not be printed");
    assertEquals(await readSettingsWithSkillOverrides(path), { model: "opus" });
  });
});
