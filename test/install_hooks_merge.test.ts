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
}
interface SettingsJson {
  permissions?: PermissionsJson;
  hooks: {
    SessionStart: HookEntry[];
    PreToolUse: HookEntry[];
    PostToolUse?: HookEntry[];
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
      "Bash(git push * :*)",
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
  const jwtSecret = "eyJ" + "A".repeat(20) + "." + "B".repeat(20) + "." + "C".repeat(20);
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
  "prunes orphaned hook entries from SessionStart, Stop, PreToolUse, and PostToolUse",
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
  "--check mode in merge-hooks-into-settings.ts reports drift on stale/retired hook entries",
  async () => {
    await withTempSettings(
      {
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "$HOME/.claude/hooks/retired-start.sh" }] },
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
          "--pre-tool-use",
          "Bash::$HOME/.claude/hooks/active-pre.sh",
        ]);
        assertEquals(checkRes.code, 1);
        assert(checkRes.stderr.includes("has retired SessionStart hook"));
        assert(checkRes.stderr.includes("has retired hook (Bash)"));
      },
    );
  },
);
