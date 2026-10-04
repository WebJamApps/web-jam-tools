import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { parse } from "@std/toml";
import { updateConfig } from "../src/install-codex/config.ts";
import { main } from "../src/install-codex/cli.ts";
import { EVENTS, hookCommand, readHookRegistrations } from "../src/install-codex/hooks.ts";
import { installCodex } from "../src/install-codex/install.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const HOOKS = Deno.readTextFileSync(join(ROOT, "scripts/install-hooks.sh"));
const RULES = Deno.readTextFileSync(join(ROOT, "codex/rules/web-jam-tools.rules"));
const PRESERVED = `model = "gpt-6.1-sol"
model_reasoning_effort = "high"
personality = "pragmatic"
sandbox_mode = "workspace-write"
[projects."/x"]
trust_level = "trusted"
[tui]
notifications = true
[tui.status_line]
enabled = true
[hooks.state."/home/u/.codex/hooks.json:session_start:0:0"]
trusted_hash = "sha256:abc"
[mcp_servers.example]
command = "/opt/mcp"
[[hooks.PreToolUse]]
matcher = "Bash"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "/opt/other/hook.sh"
`;

function snapshot(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(directory: string): void {
    for (const entry of Deno.readDirSync(directory)) {
      const file = join(directory, entry.name);
      const key = file.slice(path.length + 1);
      if (entry.isSymlink) result[key] = `link:${Deno.readLinkSync(file)}`;
      else if (entry.isDirectory) {
        result[key] = "directory";
        walk(file);
      } else result[key] = Deno.readTextFileSync(file);
    }
  }
  walk(path);
  return result;
}

function fixture(run: (home: string, repo: string) => void): void {
  const temporary = Deno.makeTempDirSync({ prefix: "install-codex-test-" });
  const home = join(temporary, "home");
  const repo = join(temporary, "repo");
  try {
    for (
      const dir of [home, join(repo, "scripts"), join(repo, "codex/rules"), join(repo, "skills")]
    ) {
      Deno.mkdirSync(dir, { recursive: true });
    }
    Deno.writeTextFileSync(join(repo, "scripts/install-hooks.sh"), HOOKS);
    Deno.writeTextFileSync(join(repo, "codex/rules/web-jam-tools.rules"), RULES);
    for (const entry of Deno.readDirSync(join(ROOT, "skills"))) {
      if (entry.isDirectory) Deno.mkdirSync(join(repo, "skills", entry.name));
    }
    Deno.mkdirSync(join(home, ".claude/hooks"), { recursive: true });
    for (const groups of Object.values(readHookRegistrations(HOOKS, home))) {
      for (const group of groups) {
        const name = group.hooks[0].command.split("/").at(-1)!.slice(0, -1);
        Deno.writeTextFileSync(join(home, ".claude/hooks", name), "#!/bin/sh\nexit 0\n");
      }
    }
    run(home, repo);
  } finally {
    Deno.removeSync(temporary, { recursive: true });
  }
}

function putConfig(home: string, text: string): string {
  const path = join(home, ".codex/config.toml");
  Deno.mkdirSync(dirname(path), { recursive: true });
  Deno.writeTextFileSync(path, text);
  return path;
}

function capture(run: () => number): { code: number; output: string } {
  const messages: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = console.error = (...args: unknown[]) => messages.push(args.join(" "));
  try {
    return { code: run(), output: messages.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

Deno.test("fresh home: exact 27 nested registrations, matcher fidelity, sandbox and regular rules", () => {
  fixture((home, repo) => {
    assertEquals(installCodex({ home, repo }), 0);
    const text = Deno.readTextFileSync(join(home, ".codex/config.toml"));
    const config = parse(text);
    assertEquals(config.sandbox_mode, "danger-full-access");
    const expected = {
      SessionStart: [
        "notes-sync-reminder.sh",
        "memory-cleanup-reminder.sh",
        "backlog-groom-reminder.sh",
        "backup-refusal-reminder.sh",
        "hook-install-drift-reminder.sh",
        "permission-wildcard-drift-reminder.sh",
      ].map((name) => ["startup|resume", name]),
      PreToolUse: [
        ["Bash", "semver-push-reminder.sh"],
        ["Bash", "block-secret-dumps.sh"],
        ["Bash", "block-secret-literals.sh"],
        ["Bash", "block-dangerous-git-deploy.sh"],
        ["Bash", "gh-api-guard.sh"],
        ["Bash|mcp__.*", "block-irreversible-operations.sh"],
        ["Bash", "fmt-push-guard.sh"],
        ["Bash", "block-agy-non-flash-model.sh"],
        ["Bash|Edit|Write", "block-human-only-credentials.sh"],
        ["Edit|Write", "feature-branch-guard.sh"],
        ["mcp__(gmail|claude_ai_Gmail)__.*", "haiku-only-gmail-gate.sh"],
        ["Bash|mcp__.*__issue_write", "require-model-label-on-issue-create.sh"],
        ["Write|Edit|NotebookEdit", "block-out-of-tree-write.sh"],
        ["Bash|Write|Edit|NotebookEdit", "opus-delegation-gate.sh"],
        ["Bash|mcp__.*__(issue_write|sub_issue_write)", "require-approval-token-on-issue-write.sh"],
        ["Bash", "block-raw-gh-write.sh"],
        ["Bash", "block-backend-mutation.sh"],
        ["Bash", "block-private-folder-read.sh"],
      ],
      PostToolUse: [["Bash", "scan-output-for-secrets.sh"]],
      Stop: [[undefined, "require-issue-citation-titles.sh"], [
        undefined,
        "require-clear-communication.sh",
      ]],
    };
    const hooks = config.hooks as Record<string, { matcher?: string; hooks: unknown[] }[]>;
    for (const event of EVENTS) {
      assertStringIncludes(text, `[[hooks.${event}.hooks]]`);
      assertEquals(
        hooks[event],
        expected[event].map(([matcher, name]) => ({
          ...(matcher === undefined ? {} : { matcher }),
          hooks: [{ type: "command", command: hookCommand(join(home, ".claude/hooks", name!)) }],
        })),
      );
    }
    assertEquals(hooks.SessionEnd, undefined);
    const path = join(home, ".codex/rules/web-jam-tools.rules");
    assert(Deno.lstatSync(path).isFile);
    assertEquals(Deno.readTextFileSync(path), RULES);
  });
});

Deno.test("unmanaged values and files survive; repeat install/check preserve every byte", () => {
  fixture((home, repo) => {
    const path = putConfig(home, PRESERVED);
    const originals = parse(PRESERVED);
    const protectedFiles = [
      ".codex/hooks.json",
      ".codex/rules/default.rules",
      ".codex/skills/.system/keep",
      ".agents/AGENTS.md",
    ];
    for (const file of protectedFiles) {
      Deno.mkdirSync(dirname(join(home, file)), { recursive: true });
      Deno.writeTextFileSync(
        join(home, file),
        file === ".codex/hooks.json"
          ? '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"reaper-check"}]}]}}'
          : "keep me\n",
      );
    }
    const protectedBefore = snapshot(home);
    assertEquals(installCodex({ home, repo }), 0);
    const installed = parse(Deno.readTextFileSync(path));
    for (
      const key of [
        "model",
        "model_reasoning_effort",
        "personality",
        "projects",
        "tui",
        "mcp_servers",
      ]
    ) {
      assertEquals(installed[key], originals[key]);
    }
    const hooks = installed.hooks as Record<string, unknown>;
    assertEquals(hooks.state, (originals.hooks as Record<string, unknown>).state);
    assertEquals(
      (hooks.PreToolUse as unknown[])[0],
      (originals.hooks as Record<string, unknown[]>).PreToolUse[0],
    );
    assertEquals(Deno.readTextFileSync(path).match(/^sandbox_mode\s*=/gm)?.length, 1);
    const before = snapshot(home);
    assertEquals(installCodex({ home, repo }), 0);
    assertEquals(installCodex({ home, repo, check: true }), 0);
    assertEquals(snapshot(home), before);
    for (const file of protectedFiles) assertEquals(protectedBefore[file], snapshot(home)[file]);
  });
});

Deno.test("invalid TOML, missing hook, missing rules and unreadable arrays refuse before any writes", () => {
  for (const problem of ["toml", "hook", "rules", "array"]) {
    fixture((home, repo) => {
      if (problem === "toml") putConfig(home, "model = ");
      if (problem === "hook") Deno.removeSync(join(home, ".claude/hooks/block-raw-gh-write.sh"));
      if (problem === "rules") Deno.removeSync(join(repo, "codex/rules/web-jam-tools.rules"));
      if (problem === "array") {
        Deno.writeTextFileSync(join(repo, "scripts/install-hooks.sh"), "# no arrays\n");
      }
      const before = snapshot(home);
      for (const check of [false, true]) {
        const result = capture(() => installCodex({ home, repo, check }));
        assertEquals(result.code, 1);
        assertStringIncludes(result.output, "REFUSED:");
        if (problem === "toml") {
          assertStringIncludes(result.output, join(home, ".codex/config.toml"));
        }
        if (problem === "hook") {
          assertStringIncludes(result.output, "block-raw-gh-write.sh");
          assertStringIncludes(result.output, "run scripts/install-hooks.sh first");
        }
        assertEquals(snapshot(home), before);
      }
    });
  }
});

Deno.test("links every shared skill except Gmail; no agents folder; conflicted skill is skipped", () => {
  for (const conflict of [false, true]) {
    fixture((home, repo) => {
      if (conflict) Deno.mkdirSync(join(home, ".codex/skills/pr-review"), { recursive: true });
      const result = capture(() => installCodex({ home, repo }));
      assertEquals(result.code, conflict ? 1 : 0);
      const files = snapshot(home);
      assert(!Object.keys(files).some((path) => path.startsWith(".agents")));
      assertEquals(files[".codex/skills/handle-gmails"], undefined);
      for (const entry of Deno.readDirSync(join(repo, "skills"))) {
        if (!entry.isDirectory || entry.name === "handle-gmails") continue;
        const target = join(home, ".codex/skills", entry.name);
        if (conflict && entry.name === "pr-review") {
          assert(Deno.lstatSync(target).isDirectory);
          assertStringIncludes(result.output, `SKIPPED: ${target}`);
        } else assertEquals(Deno.readLinkSync(target), join(repo, "skills", entry.name));
      }
      assert(Deno.lstatSync(join(home, ".codex/rules/web-jam-tools.rules")).isFile);
      assertEquals(
        parse(Deno.readTextFileSync(join(home, ".codex/config.toml"))).sandbox_mode,
        "danger-full-access",
      );
    });
  }
});

Deno.test("rules source changes: check reports drift without writing; install replaces copied bytes", () => {
  fixture((home, repo) => {
    assertEquals(installCodex({ home, repo }), 0);
    const updated = RULES + "\n# updated source\n";
    Deno.writeTextFileSync(join(repo, "codex/rules/web-jam-tools.rules"), updated);
    const before = snapshot(home);
    const result = capture(() => installCodex({ home, repo, check: true }));
    assertEquals(result.code, 1);
    assertStringIncludes(result.output, "DRIFT: rules file");
    assertEquals(snapshot(home), before);
    assertEquals(installCodex({ home, repo }), 0);
    assertEquals(Deno.readTextFileSync(join(home, ".codex/rules/web-jam-tools.rules")), updated);
  });
});

Deno.test("check on empty home names all missing components and creates nothing", () => {
  fixture((home, repo) => {
    const empty = Deno.makeTempDirSync({ prefix: "codex-empty-" });
    try {
      // Required hooks are fixtures at a separate home; no Codex file exists there.
      const before = snapshot(home);
      const result = capture(() => installCodex({ home, repo, check: true }));
      assertEquals(result.code, 1);
      for (const name of ["rules file", "hook registration", "sandbox_mode", "skill"]) {
        assertStringIncludes(result.output, name);
      }
      assertEquals(snapshot(home), before);
      // A literally empty home has missing prerequisites: refusal creates nothing.
      const emptyResult = capture(() => installCodex({ home: empty, repo, check: true }));
      assertEquals(emptyResult.code, 1);
      for (
        const name of ["rules file", "hook registration", "sandbox_mode", "skill", "missing hook"]
      ) {
        assertStringIncludes(emptyResult.output, name);
      }
      assertEquals(snapshot(empty), {});
    } finally {
      Deno.removeSync(empty, { recursive: true });
    }
  });
});

Deno.test("array additions, changed and removed registrations flow through without installer edits", () => {
  fixture((home, repo) => {
    assertEquals(installCodex({ home, repo }), 0);
    const changed = HOOKS.replace(
      "PRE_TOOL_USE_HOOKS=(",
      'PRE_TOOL_USE_HOOKS=(\n  "Read|Bash::extra.sh"',
    )
      .replace('"Bash::block-secret-dumps.sh"', '"Bash|Read::block-secret-dumps.sh"')
      .replace('  "Bash::block-secret-literals.sh"\n', "");
    Deno.writeTextFileSync(join(repo, "scripts/install-hooks.sh"), changed);
    Deno.writeTextFileSync(join(home, ".claude/hooks/extra.sh"), "exit 0\n");
    const before = snapshot(home);
    assertEquals(capture(() => installCodex({ home, repo, check: true })).code, 1);
    assertEquals(snapshot(home), before);
    assertEquals(installCodex({ home, repo }), 0);
    const hooks = parse(Deno.readTextFileSync(join(home, ".codex/config.toml"))).hooks as Record<
      string,
      unknown
    >;
    assertEquals(hooks.PreToolUse, readHookRegistrations(changed, home).PreToolUse);
    assertEquals(installCodex({ home, repo, check: true }), 0);
  });
});

Deno.test("mixed hook groups retain unrelated handlers; quotes in home are shell-safe", () => {
  const home = "/home/o'brien";
  const wanted = readHookRegistrations(HOOKS, home);
  const source =
    `[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ${
      JSON.stringify(hookCommand(join(home, ".claude/hooks/old.sh")))
    }\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "/opt/other/hook.sh"\n`;
  const result = updateConfig(source, wanted, home);
  const hooks = parse(result.text).hooks as Record<
    string,
    { hooks: { type: string; command: string }[] }[]
  >;
  assertEquals(hooks.PreToolUse[0].hooks, [{ type: "command", command: "/opt/other/hook.sh" }]);
  assertEquals(updateConfig(result.text, wanted, home).text, result.text);
  assertStringIncludes(wanted.Stop[0].hooks[0].command, "'\\''");
});

Deno.test("literal array reader rejects shell expansion, malformed entries and missing arrays", () => {
  for (
    const replacement of [
      '"Bash::$(command).sh"',
      '"Bash::bad/name.sh"',
      '"::extra.sh"',
      '"Bash::one.sh::two.sh"',
    ]
  ) {
    let failed = false;
    try {
      readHookRegistrations(
        HOOKS.replace('"Bash::semver-push-reminder.sh"', replacement),
        "/tmp/home",
      );
    } catch {
      failed = true;
    }
    assert(failed, replacement);
  }
  const start = HOOKS.slice(HOOKS.indexOf("SESSION_START_HOOKS=("));
  assertEquals(readHookRegistrations(start, "/tmp/home").SessionStart.length, 6);
  assertEquals(
    readHookRegistrations(
      HOOKS.replace("PRE_TOOL_USE_HOOKS=(", "PRE_TOOL_USE_HOOKS=(\n# comment"),
      "/tmp/home",
    ).PreToolUse.length,
    18,
  );
});

Deno.test("non-regular config and directory targets refuse without writes; rules symlink becomes regular", () => {
  for (const path of [".codex/config.toml", ".codex/rules/web-jam-tools.rules", ".codex/skills"]) {
    fixture((home, repo) => {
      Deno.mkdirSync(dirname(join(home, path)), { recursive: true });
      if (path.endsWith("skills")) Deno.writeTextFileSync(join(home, path), "conflict");
      else Deno.mkdirSync(join(home, path));
      const before = snapshot(home);
      assertEquals(capture(() => installCodex({ home, repo })).code, 1);
      assertEquals(snapshot(home), before);
    });
  }
  fixture((home, repo) => {
    Deno.mkdirSync(join(home, ".codex/rules"), { recursive: true });
    const target = join(home, ".codex/rules/web-jam-tools.rules");
    Deno.symlinkSync(join(repo, "codex/rules/web-jam-tools.rules"), target);
    assertEquals(installCodex({ home, repo }), 0);
    assert(Deno.lstatSync(target).isFile);
  });
});

Deno.test("CLI handles help, invalid arguments and isolated --home install/check; worktree links target clone", () => {
  assertEquals(capture(() => main(["--help"])).code, 0);
  assertEquals(capture(() => main(["--unknown"])).code, 1);
  assertEquals(capture(() => main(["--home"])).code, 1);
  fixture((home) => {
    assertEquals(main(["--home", home]), 0);
    assertEquals(main(["--check", "--home", home]), 0);
    let canonical = ROOT.replace(/\/$/, "");
    if (Deno.lstatSync(join(ROOT, ".git")).isFile) {
      const git = Deno.readTextFileSync(join(ROOT, ".git")).trim().slice(8);
      const common = Deno.readTextFileSync(join(git, "commondir")).trim();
      canonical = dirname(resolve(git, common));
    }
    assertEquals(
      Deno.readLinkSync(join(home, ".codex/skills/pr-review")),
      join(canonical, "skills/pr-review"),
    );
  });
});

// Review fixes: config.toml is edited in place, so nothing the installer does not manage can
// change in form or meaning.

const COMMENTED = `# my settings
model = "gpt-6.1-sol"
last_checked = 2026-10-01T07:32:00-04:00
ratio = 1.0
released = 1979-05-27

# projects I trust
[projects."/x"]
trust_level = "trusted" # inline note
`;
const SANDBOX = 'sandbox_mode = "danger-full-access"\n';
const OTHER_HOOK = `
# note for my hook
[[hooks.PreToolUse]]
matcher = "Bash"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "/opt/other/hook.sh"
`;

Deno.test("unmanaged text survives byte for byte: comments, an offset date-time, a float and a plain date", () => {
  fixture((home, repo) => {
    const path = putConfig(home, COMMENTED);
    assertEquals(installCodex({ home, repo }), 0);
    const installed = Deno.readTextFileSync(path);
    assert(installed.startsWith(SANDBOX + COMMENTED));
    assertEquals(
      (parse(installed).hooks as Record<string, unknown>).PreToolUse,
      readHookRegistrations(HOOKS, home).PreToolUse,
    );
    assertEquals(installCodex({ home, repo }), 0);
    assertEquals(installCodex({ home, repo, check: true }), 0);
    assertEquals(Deno.readTextFileSync(path), installed);
  });
});

Deno.test("an update replaces only the installer's own tables; an unrelated table and its comment stay as written", () => {
  fixture((home, repo) => {
    const path = putConfig(home, COMMENTED);
    assertEquals(installCodex({ home, repo }), 0);
    Deno.writeTextFileSync(path, Deno.readTextFileSync(path) + OTHER_HOOK);
    const changed = HOOKS.replace(
      "PRE_TOOL_USE_HOOKS=(",
      'PRE_TOOL_USE_HOOKS=(\n  "Read|Bash::extra.sh"',
    ).replace(
      "STOP_HOOKS=(require-issue-citation-titles.sh require-clear-communication.sh)",
      "STOP_HOOKS=(require-clear-communication.sh)",
    );
    Deno.writeTextFileSync(join(repo, "scripts/install-hooks.sh"), changed);
    Deno.writeTextFileSync(join(home, ".claude/hooks/extra.sh"), "exit 0\n");
    assertEquals(installCodex({ home, repo }), 0);
    const updated = Deno.readTextFileSync(path);
    assert(updated.startsWith(SANDBOX + COMMENTED));
    assertStringIncludes(updated, OTHER_HOOK);
    const wanted = readHookRegistrations(changed, home);
    const hooks = parse(updated).hooks as Record<string, { hooks: unknown[] }[]>;
    assertEquals(hooks.PreToolUse[0].hooks, [{ type: "command", command: "/opt/other/hook.sh" }]);
    assertEquals(hooks.PreToolUse.slice(1), wanted.PreToolUse);
    assertEquals(hooks.Stop, wanted.Stop);
    assertEquals(updated.match(/require-issue-citation-titles\.sh/g), null);
    assertEquals(installCodex({ home, repo, check: true }), 0);
    assertEquals(Deno.readTextFileSync(path), updated);
  });
});

Deno.test("sandbox_mode is set on its own line: replaced where it stands, quoted key and CRLF included", () => {
  const home = "/tmp/home";
  const wanted = readHookRegistrations(HOOKS, home);
  for (
    const source of [
      '# top\nmodel = "m"\nsandbox_mode = "workspace-write"\n\n[tui]\nnotifications = true\n',
      '"sandbox_mode" = "read-only"\n[tui]\nnotifications = true\n',
      'model = "m"\r\nsandbox_mode = "workspace-write"\r\n[tui]\r\nnotifications = true\r\n',
    ]
  ) {
    const { text } = updateConfig(source, wanted, home);
    const result = parse(text);
    assertEquals(result.sandbox_mode, "danger-full-access");
    assertEquals(result.tui, { notifications: true });
    assertEquals(text.match(/sandbox_mode/g)?.length, 1);
    for (const line of source.split("\n")) {
      if (!line.includes("sandbox_mode")) assertStringIncludes(text, line);
    }
    assertEquals(updateConfig(text, wanted, home).text, text);
  }
});

Deno.test("installer hook tables that cannot be edited in place are refused and nothing is written", () => {
  const home = "/tmp/home";
  const wanted = readHookRegistrations(HOOKS, home);
  const old = JSON.stringify(hookCommand(join(home, ".claude/hooks/old.sh")));
  for (
    const source of [
      // The whole event written as an inline array.
      `[hooks]\nPreToolUse = [{ matcher = "Bash", hooks = [{ type = "command", command = ${old} }] }]\n`,
      // The handlers written as an inline array.
      `[[hooks.PreToolUse]]\nmatcher = "Bash"\nhooks = [{ type = "command", command = ${old} }]\n`,
      // A comment inside the installer's own table.
      `[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\n# stray\ntype = "command"\ncommand = ${old}\n`,
    ]
  ) {
    assertThrows(
      () => updateConfig(source, wanted, home),
      Error,
      "cannot update the file in place",
    );
  }
  fixture((fixtureHome, repo) => {
    const inline = `[hooks]\nStop = [{ hooks = [{ type = "command", command = ${
      JSON.stringify(hookCommand(join(fixtureHome, ".claude/hooks/old.sh")))
    } }] }]\n`;
    putConfig(fixtureHome, inline);
    const before = snapshot(fixtureHome);
    for (const check of [false, true]) {
      const result = capture(() => installCodex({ home: fixtureHome, repo, check }));
      assertEquals(result.code, 1);
      assertStringIncludes(result.output, "REFUSED:");
      assertStringIncludes(result.output, join(fixtureHome, ".codex/config.toml"));
      assertEquals(snapshot(fixtureHome), before);
    }
  });
});

Deno.test("a skipped skill is reported with the same message by --check and by an install", () => {
  fixture((home, repo) => {
    Deno.mkdirSync(join(home, ".codex/skills/pr-review"), { recursive: true });
    const message = `SKIPPED: ${
      join(home, ".codex/skills/pr-review")
    }: existing path is not the canonical skill link`;
    const checked = capture(() => installCodex({ home, repo, check: true }));
    assertEquals(checked.code, 1);
    assertStringIncludes(checked.output, message);
    const installed = capture(() => installCodex({ home, repo }));
    assertEquals(installed.code, 1);
    assertStringIncludes(installed.output, message);
    // Everything else is in place, so only the skipped skill is left to report.
    const again = capture(() => installCodex({ home, repo, check: true }));
    assertEquals(again.code, 1);
    assertEquals(again.output, message);
  });
});
