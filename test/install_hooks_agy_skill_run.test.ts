// install_hooks_agy_skill_run.test.ts — web-jam-tools#1320
//
// Exercises the installation of agy-skill-run-hook.sh and scripts/agy-skill-run.sh:
// - Registering hooks/agy-skill-run-hook.sh directly under PreToolUse (matcher ".*") as the LAST entry in agy's hooks file.
// - Linking scripts/agy-skill-run.sh as $HOOKS_DEST/agy-skill-run.sh (with backup on conflict).
// - Adding command(/home/joshua/.claude/hooks/agy-skill-run.sh) to permissions.allow in agy settings.json when missing.
// - Ensuring hooks/agy-skill-run-hook.sh is NEVER registered in Claude Code's settings.json.
// - Idempotency (running twice produces exactly one allow-list entry and one hook registration, last).
// - Re-ordering to last if other PreToolUse hooks are added or registered after it.
// - Flag and env var support: --agy-settings-path and AGY_SETTINGS_PATH.
// - Drift detection in --check mode: missing allow-list entry, missing hook, hook not last, missing symlink.
// - Fail-closed behavior on unparseable JSON or agy command errors.

import { assert, assertEquals } from "@std/assert";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const INSTALL_SCRIPT = `${REPO_ROOT}scripts/install-hooks.sh`;
const AGY_SKILL_RUN_ALLOW_ENTRY = "command(/home/joshua/.claude/hooks/agy-skill-run.sh)";
const AGY_SKILL_RUN_HOOK_COMMAND = "$HOME/.claude/hooks/agy-skill-run-hook.sh";

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
    env: { ...Deno.env.toObject(), CODEX_HOME: "", CODEX_HOOKS_PATH: "", ...env },
  });
  const { code, stdout, stderr } = await command.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

interface Sandbox {
  dir: string;
  hooksDir: string;
  settingsPath: string;
  agyHooksPath: string;
  agySettingsPath: string;
}

async function withSandbox(
  fn: (sandbox: Sandbox) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const hooksDir = `${dir}/hooks`;
  const settingsPath = `${dir}/claude-settings.json`;
  const agyHooksPath = `${dir}/agy-hooks.json`;
  const agySettingsPath = `${dir}/agy-settings.json`;
  try {
    await fn({ dir, hooksDir, settingsPath, agyHooksPath, agySettingsPath });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("install-hooks.sh registers agy-skill-run-hook.sh as the last PreToolUse entry and creates symlink", async () => {
  await withSandbox(async ({ hooksDir, settingsPath, agyHooksPath, agySettingsPath }) => {
    const res = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
      "--agy-settings-path",
      agySettingsPath,
    ]);
    assertEquals(res.code, 0, res.stdout + res.stderr);

    // Verify scripts/agy-skill-run.sh is symlinked
    const symlinkPath = `${hooksDir}/agy-skill-run.sh`;
    const stat = await Deno.lstat(symlinkPath);
    assert(stat.isSymlink, "expected agy-skill-run.sh to be a symlink");
    const target = await Deno.readLink(symlinkPath);
    assert(target.endsWith("scripts/agy-skill-run.sh"), `unexpected link target: ${target}`);

    // Verify agy hooks.json PreToolUse has agy-skill-run-hook.sh registered as the LAST hook
    const agyHooks = JSON.parse(await Deno.readTextFile(agyHooksPath));
    const preToolUse = agyHooks.hooks?.PreToolUse;
    assert(
      Array.isArray(preToolUse) && preToolUse.length > 0,
      "expected PreToolUse array in agy hooks",
    );
    const allHooks: string[] = [];
    for (const entry of preToolUse) {
      for (const h of entry.hooks || []) {
        if (h && typeof h.command === "string") {
          allHooks.push(h.command);
        }
      }
    }
    assert(allHooks.length > 0, "expected at least one hook in agy PreToolUse");
    assertEquals(
      allHooks[allHooks.length - 1],
      AGY_SKILL_RUN_HOOK_COMMAND,
      "agy-skill-run-hook.sh must be the very last hook in PreToolUse",
    );

    // Verify Claude Code's settings.json NEVER registers agy-skill-run-hook.sh
    const claudeSettings = JSON.parse(await Deno.readTextFile(settingsPath));
    const claudePreHooks = (claudeSettings.hooks?.PreToolUse || []).flatMap(
      (entry: { hooks?: Array<{ command?: string }> }) => entry.hooks ?? [],
    );
    assert(
      !claudePreHooks.some((h: { command?: string }) =>
        h.command?.includes("agy-skill-run-hook.sh")
      ),
      "agy-skill-run-hook.sh must never be registered in Claude Code's settings.json",
    );
    assert(
      !(claudeSettings.permissions?.allow || []).includes(AGY_SKILL_RUN_ALLOW_ENTRY),
      "agy allow-list entry must never appear in Claude Code's settings.json",
    );
  });
});

Deno.test("install-hooks.sh adds allow-list entry to agy settings.json and is idempotent", async () => {
  await withSandbox(async ({ hooksDir, settingsPath, agyHooksPath, agySettingsPath }) => {
    // Seed agy settings.json with pre-existing settings
    const initialSettings = {
      userCustom: "preserve-me",
      permissions: {
        allow: ["command(echo hello)"],
        deny: ["command(rm -rf /)"],
      },
    };
    await Deno.writeTextFile(agySettingsPath, JSON.stringify(initialSettings, null, 2));

    const res1 = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
      "--agy-settings-path",
      agySettingsPath,
    ]);
    assertEquals(res1.code, 0, res1.stdout + res1.stderr);

    const agySettings1 = JSON.parse(await Deno.readTextFile(agySettingsPath));
    assertEquals(agySettings1.userCustom, "preserve-me");
    assertEquals(agySettings1.permissions.deny, ["command(rm -rf /)"]);
    assert(
      agySettings1.permissions.allow.includes("command(echo hello)"),
      "pre-existing allow entry must be preserved",
    );
    assert(
      agySettings1.permissions.allow.includes(AGY_SKILL_RUN_ALLOW_ENTRY),
      "agy allow-list entry must be added",
    );
    const allowCount1 = agySettings1.permissions.allow.filter(
      (e: string) => e === AGY_SKILL_RUN_ALLOW_ENTRY,
    ).length;
    assertEquals(allowCount1, 1, "expected exactly 1 instance of allow entry");

    // Run again to verify idempotency
    const res2 = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
      "--agy-settings-path",
      agySettingsPath,
    ]);
    assertEquals(res2.code, 0, res2.stdout + res2.stderr);

    const agySettings2 = JSON.parse(await Deno.readTextFile(agySettingsPath));
    const allowCount2 = agySettings2.permissions.allow.filter(
      (e: string) => e === AGY_SKILL_RUN_ALLOW_ENTRY,
    ).length;
    assertEquals(allowCount2, 1, "running again must not duplicate allow entry");
  });
});

Deno.test("install-hooks.sh moves agy-skill-run-hook.sh to end if existing hooks are registered after it", async () => {
  await withSandbox(async ({ hooksDir, settingsPath, agyHooksPath, agySettingsPath }) => {
    // Seed agy hooks with agy-prompt-watch.sh AFTER agy-skill-run-hook.sh
    const initialHooks = {
      hooks: {
        PreToolUse: [
          {
            matcher: ".*",
            hooks: [
              { type: "command", command: AGY_SKILL_RUN_HOOK_COMMAND },
              { type: "command", command: "$HOME/.claude/hooks/agy-prompt-watch.sh" },
            ],
          },
        ],
      },
    };
    await Deno.writeTextFile(agyHooksPath, JSON.stringify(initialHooks, null, 2));

    const res = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
      "--agy-settings-path",
      agySettingsPath,
    ]);
    assertEquals(res.code, 0, res.stdout + res.stderr);

    const agyHooks = JSON.parse(await Deno.readTextFile(agyHooksPath));
    const preToolUse = agyHooks.hooks?.PreToolUse;
    const allHooks: string[] = [];
    for (const entry of preToolUse) {
      for (const h of entry.hooks || []) {
        if (h && typeof h.command === "string") {
          allHooks.push(h.command);
        }
      }
    }
    assertEquals(
      allHooks[allHooks.length - 1],
      AGY_SKILL_RUN_HOOK_COMMAND,
      "agy-skill-run-hook.sh must be moved to the end",
    );
    const agyHookCount = allHooks.filter((c) => c === AGY_SKILL_RUN_HOOK_COMMAND).length;
    assertEquals(agyHookCount, 1, "agy-skill-run-hook.sh must appear exactly once in PreToolUse");
    assert(
      allHooks.includes("$HOME/.claude/hooks/agy-prompt-watch.sh"),
      "other hook must be preserved",
    );
  });
});

Deno.test("install-hooks.sh honors AGY_SETTINGS_PATH environment variable", async () => {
  await withSandbox(async ({ hooksDir, settingsPath, agyHooksPath, agySettingsPath }) => {
    const res = await run(
      "bash",
      [
        INSTALL_SCRIPT,
        "--hooks-dir",
        hooksDir,
        "--settings-path",
        settingsPath,
        "--agy-hooks-path",
        agyHooksPath,
      ],
      { AGY_SETTINGS_PATH: agySettingsPath },
    );
    assertEquals(res.code, 0, res.stdout + res.stderr);

    const agySettings = JSON.parse(await Deno.readTextFile(agySettingsPath));
    assert(
      agySettings.permissions?.allow?.includes(AGY_SKILL_RUN_ALLOW_ENTRY),
      "allow entry must be added to AGY_SETTINGS_PATH target",
    );
  });
});

Deno.test("install-hooks.sh backs up conflicting non-symlink file at agy-skill-run destination", async () => {
  await withSandbox(async ({ hooksDir, settingsPath, agyHooksPath, agySettingsPath }) => {
    await Deno.mkdir(hooksDir, { recursive: true });
    const targetPath = `${hooksDir}/agy-skill-run.sh`;
    await Deno.writeTextFile(targetPath, "pre-existing-content");

    const res = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
      "--agy-settings-path",
      agySettingsPath,
    ]);
    assertEquals(res.code, 0, res.stdout + res.stderr);

    const stat = await Deno.lstat(targetPath);
    assert(stat.isSymlink, "expected target to become a symlink");

    const entries = [...Deno.readDirSync(hooksDir)];
    const backupEntry = entries.find((e) => e.name.startsWith("agy-skill-run.sh.bak-"));
    assert(backupEntry, "expected backup file for previous agy-skill-run.sh");
    const backupContent = await Deno.readTextFile(`${hooksDir}/${backupEntry.name}`);
    assertEquals(backupContent, "pre-existing-content");
  });
});

Deno.test("install-hooks.sh --check passes on clean installation", async () => {
  await withSandbox(async ({ hooksDir, settingsPath, agyHooksPath, agySettingsPath }) => {
    const installRes = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
      "--agy-settings-path",
      agySettingsPath,
    ]);
    assertEquals(installRes.code, 0, installRes.stdout + installRes.stderr);

    const checkRes = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
      "--agy-settings-path",
      agySettingsPath,
      "--check",
    ]);
    assertEquals(checkRes.code, 0, checkRes.stdout + checkRes.stderr);
    assert(checkRes.stdout.includes("check passed (no drift)"));
  });
});

Deno.test("install-hooks.sh --check reports drift when agy allow-list entry is missing", async () => {
  await withSandbox(async ({ hooksDir, settingsPath, agyHooksPath, agySettingsPath }) => {
    const installRes = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
      "--agy-settings-path",
      agySettingsPath,
    ]);
    assertEquals(installRes.code, 0, installRes.stdout + installRes.stderr);

    // Strip allow entry from agy settings
    const settings = JSON.parse(await Deno.readTextFile(agySettingsPath));
    settings.permissions.allow = settings.permissions.allow.filter(
      (e: string) => e !== AGY_SKILL_RUN_ALLOW_ENTRY,
    );
    await Deno.writeTextFile(agySettingsPath, JSON.stringify(settings, null, 2));

    const checkRes = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
      "--agy-settings-path",
      agySettingsPath,
      "--check",
    ]);
    assertEquals(checkRes.code, 1, checkRes.stdout + checkRes.stderr);
    assert(
      checkRes.stderr.includes(
        `drift: agy allow-list entry ${AGY_SKILL_RUN_ALLOW_ENTRY} is missing`,
      ),
    );
  });
});

Deno.test("install-hooks.sh --check reports drift when agy-skill-run hook is not last or missing", async () => {
  await withSandbox(async ({ hooksDir, settingsPath, agyHooksPath, agySettingsPath }) => {
    const installRes = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
      "--agy-settings-path",
      agySettingsPath,
    ]);
    assertEquals(installRes.code, 0, installRes.stdout + installRes.stderr);

    // Append another hook after agy-skill-run-hook.sh in agy hooks.json
    const hooksData = JSON.parse(await Deno.readTextFile(agyHooksPath));
    hooksData.hooks.PreToolUse.push({
      matcher: ".*",
      hooks: [{ type: "command", command: "$HOME/.claude/hooks/trailing-hook.sh" }],
    });
    await Deno.writeTextFile(agyHooksPath, JSON.stringify(hooksData, null, 2));

    const checkResNotLast = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
      "--agy-settings-path",
      agySettingsPath,
      "--check",
    ]);
    assertEquals(checkResNotLast.code, 1, checkResNotLast.stdout + checkResNotLast.stderr);
    assert(checkResNotLast.stderr.includes("drift: agy-skill-run hook is not last"));

    // Remove agy-skill-run-hook.sh entirely
    hooksData.hooks.PreToolUse = hooksData.hooks.PreToolUse.filter(
      (entry: { hooks?: Array<{ command?: string }> }) =>
        !entry.hooks?.some((h) => h.command === AGY_SKILL_RUN_HOOK_COMMAND),
    );
    await Deno.writeTextFile(agyHooksPath, JSON.stringify(hooksData, null, 2));

    const checkResMissing = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
      "--agy-settings-path",
      agySettingsPath,
      "--check",
    ]);
    assertEquals(checkResMissing.code, 1, checkResMissing.stdout + checkResMissing.stderr);
    assert(checkResMissing.stderr.includes("drift: agy-skill-run hook is missing"));
  });
});

Deno.test("install-hooks.sh --check reports drift when agy-skill-run.sh symlink is missing", async () => {
  await withSandbox(async ({ hooksDir, settingsPath, agyHooksPath, agySettingsPath }) => {
    const installRes = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
      "--agy-settings-path",
      agySettingsPath,
    ]);
    assertEquals(installRes.code, 0, installRes.stdout + installRes.stderr);

    // Remove the symlink
    await Deno.remove(`${hooksDir}/agy-skill-run.sh`);

    const checkRes = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
      "--agy-settings-path",
      agySettingsPath,
      "--check",
    ]);
    assertEquals(checkRes.code, 1, checkRes.stdout + checkRes.stderr);
    assert(checkRes.stderr.includes("drift: agy-skill-run script is not linked"));
  });
});

Deno.test("install-hooks.sh fails closed when agy hooks or settings JSON is unparseable", async () => {
  await withSandbox(async ({ hooksDir, settingsPath, agyHooksPath, agySettingsPath }) => {
    // Corrupt agy hooks JSON
    await Deno.writeTextFile(agyHooksPath, "not-valid-json{{{");

    const checkResHooks = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
      "--agy-settings-path",
      agySettingsPath,
      "--check",
    ]);
    assert(checkResHooks.code !== 0, "must fail closed on unparseable hooks file");
    assert(checkResHooks.stderr.includes("error: cannot parse agy hooks file"));

    // Valid hooks JSON, corrupted settings JSON
    await Deno.writeTextFile(agyHooksPath, JSON.stringify({ hooks: {} }));
    await Deno.writeTextFile(agySettingsPath, "{ unparseable settings JSON");

    const checkResSettings = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
      "--agy-settings-path",
      agySettingsPath,
      "--check",
    ]);
    assert(checkResSettings.code !== 0, "must fail closed on unparseable settings file");
    assert(checkResSettings.stderr.includes("cannot read agy permissions"));

    // Normal install mode must also fail closed on unparseable settings JSON
    const installResSettings = await run("bash", [
      INSTALL_SCRIPT,
      "--hooks-dir",
      hooksDir,
      "--settings-path",
      settingsPath,
      "--agy-hooks-path",
      agyHooksPath,
      "--agy-settings-path",
      agySettingsPath,
    ]);
    assert(
      installResSettings.code !== 0,
      "normal install mode must fail closed on unparseable settings file",
    );
    assert(installResSettings.stderr.includes("cannot read agy permissions"));
  });
});
