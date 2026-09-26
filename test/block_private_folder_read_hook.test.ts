// block_private_folder_read_hook.test.ts — web-jam-tools#1141
//
// Tests for hooks/block-private-folder-read.sh and hooks/lib/check_private_folder_read.ts
//
// Verifies:
//   1. All 16 private Dropbox folders are refused across the 4 literal command shapes:
//      - cat ~/Dropbox/<folder>/x
//      - ls /home/joshua/Dropbox/<folder>
//      - rg foo ~/Dropbox/<folder>
//      - python3 -c "open('/home/joshua/Dropbox/<folder>/x')"
//   2. Allowed cases:
//      - Folder outside the list (cat ~/Dropbox/OutsideTheList/x) -> allowed
//      - Prefix-sharing name (ls ~/Dropbox/WebJamAppsExtra) -> allowed
//      - Non-Dropbox project paths (cd /home/joshua/WebJamApps/CollegeLutheran) -> allowed
//   3. Three outcomes:
//      - Allow: exit 0, empty stderr
//      - Deny: exit 2, reason on stderr naming the folder
//      - Refused (fails closed): exit 2 when settings.json is missing, corrupt, or has no folders
//   4. Cross-surface parity:
//      - Claude Code-shaped payload: refused with exit 2
//      - Codex-shaped payload (WJT_SURFACE=codex): refused with exit 2, reason on stderr, no JSON on stdout
//      - Registration via scripts/install-hooks.sh in PRE_TOOL_USE_HOOKS (Claude Code & agy)

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "jsr:@std/path@^1.0.0";
import {
  buildFolderPattern,
  checkCommandForPrivateFolder,
  folderToRegexPattern,
  getPrivateDropboxFolders,
} from "../hooks/lib/check_private_folder_read.ts";

const SCRIPT_PATH = new URL(
  "../hooks/block-private-folder-read.sh",
  import.meta.url,
).pathname;

const INSTALL_SCRIPT_PATH = new URL(
  "../scripts/install-hooks.sh",
  import.meta.url,
).pathname;

const EXPECTED_16_FOLDERS = [
  "Apps",
  "BreakPoint Ministries",
  "Camera Uploads",
  "Capture",
  "CollegeLutheran",
  "DropsyncFiles",
  "Galapagos",
  "InBetween SetsMusic",
  "JoshMariaMusic_private",
  "Migrated Paper Docs",
  "Other (1)",
  "ShermanHome",
  "TimShermanMusic",
  "Web Design",
  "WebJamApps",
  "web-jam-llc",
];

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runHook(
  payload: Record<string, unknown> | string,
  env?: Record<string, string>,
): Promise<RunResult> {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: env ? { ...Deno.env.toObject(), ...env } : undefined,
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

// --- 1. Library unit tests ---

Deno.test("getPrivateDropboxFolders extracts all 16 private folders from live settings.json", () => {
  const result = getPrivateDropboxFolders();
  assertEquals(result.ok, true, `Expected ok: true, got: ${result.error}`);
  assertEquals(result.folders.length, 16);
  for (const expected of EXPECTED_16_FOLDERS) {
    assert(
      result.folders.includes(expected),
      `Expected folders to include '${expected}'`,
    );
  }
});

Deno.test("getPrivateDropboxFolders fails closed on missing settings file", () => {
  const result = getPrivateDropboxFolders("/tmp/nonexistent-settings-12345.json");
  assertEquals(result.ok, false);
  assertStringIncludes(result.error ?? "", "cannot read settings file");
});

Deno.test("getPrivateDropboxFolders fails closed on corrupt JSON", async () => {
  const tempDir = await Deno.makeTempDir();
  const tempFile = path.join(tempDir, "corrupt.json");
  try {
    await Deno.writeTextFile(tempFile, "{ not valid json");
    const result = getPrivateDropboxFolders(tempFile);
    assertEquals(result.ok, false);
    assertStringIncludes(result.error ?? "", "cannot parse JSON");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("getPrivateDropboxFolders fails closed when permissions.deny is missing", async () => {
  const tempDir = await Deno.makeTempDir();
  const tempFile = path.join(tempDir, "no_deny.json");
  try {
    await Deno.writeTextFile(tempFile, JSON.stringify({ permissions: {} }));
    const result = getPrivateDropboxFolders(tempFile);
    assertEquals(result.ok, false);
    assertStringIncludes(result.error ?? "", "permissions.deny is not an array");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("getPrivateDropboxFolders fails closed when no Dropbox folders are found in deny rules", async () => {
  const tempDir = await Deno.makeTempDir();
  const tempFile = path.join(tempDir, "empty_deny.json");
  try {
    await Deno.writeTextFile(
      tempFile,
      JSON.stringify({ permissions: { deny: ["Bash(git push -f *)"] } }),
    );
    const result = getPrivateDropboxFolders(tempFile);
    assertEquals(result.ok, false);
    assertStringIncludes(result.error ?? "", "no private Dropbox folders found");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("folderToRegexPattern handles spaces, parentheses, dashes, and underscores", () => {
  const p1 = folderToRegexPattern("BreakPoint Ministries");
  assert(new RegExp(`^${p1}$`).test("BreakPoint Ministries"));
  assert(new RegExp(`^${p1}$`).test("BreakPoint\\ Ministries"));

  const p2 = folderToRegexPattern("Other (1)");
  assert(new RegExp(`^${p2}$`).test("Other (1)"));
  assert(new RegExp(`^${p2}$`).test("Other\\ \\(1\\)"));
  assert(new RegExp(`^${p2}$`).test("Other (1\\)"));

  const p3 = folderToRegexPattern("JoshMariaMusic_private");
  assert(new RegExp(`^${p3}$`).test("JoshMariaMusic_private"));

  const p4 = folderToRegexPattern("web-jam-llc");
  assert(new RegExp(`^${p4}$`).test("web-jam-llc"));
});

Deno.test("buildFolderPattern enforces boundary so prefix-sharing names do not match", () => {
  const regex = buildFolderPattern("WebJamApps");
  assert(regex.test("cat ~/Dropbox/WebJamApps/x"));
  assert(regex.test("ls /home/joshua/Dropbox/WebJamApps"));
  assert(regex.test("ls ~/Dropbox/WebJamApps/"));
  assertEquals(regex.test("ls ~/Dropbox/WebJamAppsExtra"), false);
  assertEquals(regex.test("ls ~/Dropbox/WebJamApps-backup"), false);
  assertEquals(regex.test("ls ~/Dropbox/WebJamApps_old"), false);
});

Deno.test("checkCommandForPrivateFolder identifies matched folder name or returns null", () => {
  assertEquals(
    checkCommandForPrivateFolder("cat ~/Dropbox/Capture/x", EXPECTED_16_FOLDERS),
    "Capture",
  );
  assertEquals(
    checkCommandForPrivateFolder("cat ~/Dropbox/OutsideTheList/x", EXPECTED_16_FOLDERS),
    null,
  );
  assertEquals(
    checkCommandForPrivateFolder("ls ~/Dropbox/WebJamAppsExtra", EXPECTED_16_FOLDERS),
    null,
  );
});

// --- 2. End-to-end hook script tests: all 16 folders across 4 literal shapes ---

for (const folder of EXPECTED_16_FOLDERS) {
  Deno.test(`hook refuses literal shape 1: cat ~/Dropbox/${folder}/x`, async () => {
    const cmd = `cat ~/Dropbox/${folder}/x`;
    const res = await runHook({ tool_name: "Bash", tool_input: { command: cmd } });
    assertEquals(res.code, 2);
    assertStringIncludes(res.stderr, "BLOCKED (private-folder read guard)");
    assertStringIncludes(res.stderr, folder);
  });

  Deno.test(`hook refuses literal shape 2: ls /home/joshua/Dropbox/${folder}`, async () => {
    const cmd = `ls /home/joshua/Dropbox/${folder}`;
    const res = await runHook({ tool_name: "Bash", tool_input: { command: cmd } });
    assertEquals(res.code, 2);
    assertStringIncludes(res.stderr, "BLOCKED (private-folder read guard)");
    assertStringIncludes(res.stderr, folder);
  });

  Deno.test(`hook refuses literal shape 3: rg foo ~/Dropbox/${folder}`, async () => {
    const cmd = `rg foo ~/Dropbox/${folder}`;
    const res = await runHook({ tool_name: "Bash", tool_input: { command: cmd } });
    assertEquals(res.code, 2);
    assertStringIncludes(res.stderr, "BLOCKED (private-folder read guard)");
    assertStringIncludes(res.stderr, folder);
  });

  Deno.test(`hook refuses literal shape 4: python3 -c "open('/home/joshua/Dropbox/${folder}/x')"`, async () => {
    const cmd = `python3 -c "open('/home/joshua/Dropbox/${folder}/x')"`;
    const res = await runHook({ tool_name: "Bash", tool_input: { command: cmd } });
    assertEquals(res.code, 2);
    assertStringIncludes(res.stderr, "BLOCKED (private-folder read guard)");
    assertStringIncludes(res.stderr, folder);
  });
}

// --- 3. End-to-end hook script tests: allowed cases ---

Deno.test("hook allows folder outside the list: cat ~/Dropbox/OutsideTheList/x", async () => {
  const cmd = "cat ~/Dropbox/OutsideTheList/x";
  const res = await runHook({ tool_name: "Bash", tool_input: { command: cmd } });
  assertEquals(res.code, 0);
  assertEquals(res.stderr, "");
});

Deno.test("hook allows prefix-sharing name: ls ~/Dropbox/WebJamAppsExtra", async () => {
  const cmd = "ls ~/Dropbox/WebJamAppsExtra";
  const res = await runHook({ tool_name: "Bash", tool_input: { command: cmd } });
  assertEquals(res.code, 0);
  assertEquals(res.stderr, "");
});

Deno.test("hook allows prefix-sharing name: ls ~/Dropbox/AppsExtra", async () => {
  const cmd = "ls ~/Dropbox/AppsExtra";
  const res = await runHook({ tool_name: "Bash", tool_input: { command: cmd } });
  assertEquals(res.code, 0);
  assertEquals(res.stderr, "");
});

Deno.test("hook allows non-Dropbox project paths sharing folder names", async () => {
  const commands = [
    "cd /home/joshua/WebJamApps/CollegeLutheran && npm test",
    "git -C /home/joshua/WebJamApps status",
    "ls /home/joshua/WebJamApps/TimShermanMusic",
    "git checkout dev",
  ];
  for (const cmd of commands) {
    const res = await runHook({ tool_name: "Bash", tool_input: { command: cmd } });
    assertEquals(res.code, 0, `Expected 0 for '${cmd}', got ${res.code}`);
    assertEquals(res.stderr, "");
  }
});

Deno.test("hook allows non-Bash tool calls", async () => {
  const res = await runHook({
    tool_name: "Read",
    tool_input: { file_path: "/home/joshua/Dropbox/Apps/x" },
  });
  assertEquals(res.code, 0);
  assertEquals(res.stderr, "");
});

Deno.test("hook allows empty or missing command", async () => {
  const res1 = await runHook({ tool_name: "Bash", tool_input: {} });
  assertEquals(res1.code, 0);

  const res2 = await runHook({ tool_name: "Bash", tool_input: { command: "   " } });
  assertEquals(res2.code, 0);
});

// --- 4. Escaping and quoting variations for multi-word folders ---

Deno.test("hook refuses multi-word folder with shell backslash escaping: BreakPoint\\ Ministries", async () => {
  const cmd = "cat ~/Dropbox/BreakPoint\\ Ministries/notes.md";
  const res = await runHook({ tool_name: "Bash", tool_input: { command: cmd } });
  assertEquals(res.code, 2);
  assertStringIncludes(res.stderr, "BreakPoint Ministries");
});

Deno.test("hook refuses multi-word folder with single quotes: 'BreakPoint Ministries'", async () => {
  const cmd = "cat ~/Dropbox/'BreakPoint Ministries'/notes.md";
  const res = await runHook({ tool_name: "Bash", tool_input: { command: cmd } });
  assertEquals(res.code, 2);
  assertStringIncludes(res.stderr, "BreakPoint Ministries");
});

Deno.test('hook refuses multi-word folder with double quotes: "BreakPoint Ministries"', async () => {
  const cmd = 'cat "~/Dropbox/BreakPoint Ministries/notes.md"';
  const res = await runHook({ tool_name: "Bash", tool_input: { command: cmd } });
  assertEquals(res.code, 2);
  assertStringIncludes(res.stderr, "BreakPoint Ministries");
});

Deno.test("hook refuses folder with parentheses and backslash escaping: Other\\ \\(1\\)", async () => {
  const cmd = "ls ~/Dropbox/Other\\ \\(1\\)/doc.pdf";
  const res = await runHook({ tool_name: "Bash", tool_input: { command: cmd } });
  assertEquals(res.code, 2);
  assertStringIncludes(res.stderr, "Other (1)");
});

Deno.test("hook refuses folder with parentheses inside quotes: 'Other (1)'", async () => {
  const cmd = "ls ~/Dropbox/'Other (1)'";
  const res = await runHook({ tool_name: "Bash", tool_input: { command: cmd } });
  assertEquals(res.code, 2);
  assertStringIncludes(res.stderr, "Other (1)");
});

Deno.test("hook refuses env variable path: $HOME/Dropbox/Apps/x and ${HOME}/Dropbox/Apps/x", async () => {
  const cmd1 = "cat $HOME/Dropbox/Apps/x";
  const res1 = await runHook({ tool_name: "Bash", tool_input: { command: cmd1 } });
  assertEquals(res1.code, 2);
  assertStringIncludes(res1.stderr, "Apps");

  const cmd2 = "cat ${HOME}/Dropbox/Apps/x";
  const res2 = await runHook({ tool_name: "Bash", tool_input: { command: cmd2 } });
  assertEquals(res2.code, 2);
  assertStringIncludes(res2.stderr, "Apps");
});

// --- 5. Codex surface compatibility (WJT_SURFACE=codex) ---

Deno.test("Codex payload (WJT_SURFACE=codex) is refused with exit 2, reason on stderr, and no stdout", async () => {
  const codexPayload = {
    tool_name: "Bash",
    tool_input: { command: "cat ~/Dropbox/Capture/x" },
    hook_event_name: "PreToolUse",
  };
  const res = await runHook(codexPayload, { WJT_SURFACE: "codex" });
  assertEquals(res.code, 2);
  assertStringIncludes(res.stderr, "BLOCKED (private-folder read guard)");
  assertStringIncludes(res.stderr, "Capture");
  // Codex requirement: hook that blocks never both prints JSON on stdout and exits nonzero
  assertEquals(res.stdout, "");
});

Deno.test("Codex payload (WJT_SURFACE=codex) passes allowed command with exit 0 and no output", async () => {
  const codexPayload = {
    tool_name: "Bash",
    tool_input: { command: "cat ~/Dropbox/WebJamAppsExtra" },
    hook_event_name: "PreToolUse",
  };
  const res = await runHook(codexPayload, { WJT_SURFACE: "codex" });
  assertEquals(res.code, 0);
  assertEquals(res.stderr, "");
  assertEquals(res.stdout, "");
});

// --- 6. Fail-closed refusal when settings.json cannot be established ---

Deno.test("hook fails closed with exit 2 when settings.json is missing", async () => {
  const cmd = "cat ~/Dropbox/OutsideTheList/x";
  const res = await runHook(
    { tool_name: "Bash", tool_input: { command: cmd } },
    { CLAUDE_SETTINGS_PATH: "/tmp/nonexistent-settings-9999.json" },
  );
  assertEquals(res.code, 2);
  assertStringIncludes(res.stderr, "BLOCKED (private-folder read guard)");
  assertStringIncludes(res.stderr, "failed to establish private Dropbox folder list");
});

Deno.test("hook fails closed with exit 2 when settings.json is corrupt", async () => {
  const tempDir = await Deno.makeTempDir();
  const corruptFile = path.join(tempDir, "corrupt.json");
  try {
    await Deno.writeTextFile(corruptFile, "invalid json content");
    const cmd = "ls /tmp";
    const res = await runHook(
      { tool_name: "Bash", tool_input: { command: cmd } },
      { CLAUDE_SETTINGS_PATH: corruptFile },
    );
    assertEquals(res.code, 2);
    assertStringIncludes(res.stderr, "BLOCKED (private-folder read guard)");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// --- 7. scripts/install-hooks.sh registration check ---

Deno.test("scripts/install-hooks.sh registers block-private-folder-read.sh in PRE_TOOL_USE_HOOKS under Bash", () => {
  const installerText = Deno.readTextFileSync(INSTALL_SCRIPT_PATH);
  assert(
    installerText.includes('"Bash::block-private-folder-read.sh"'),
    "Expected install-hooks.sh to register 'Bash::block-private-folder-read.sh' in PRE_TOOL_USE_HOOKS",
  );
});

Deno.test("install-hooks.sh sandboxed run merges hook into Claude settings and agy hooks.json", async () => {
  const hooksDir = await Deno.makeTempDir();
  const settingsDir = await Deno.makeTempDir();
  const agyHooksDir = await Deno.makeTempDir();
  const settingsPath = path.join(settingsDir, "settings.json");
  const agyHooksPath = path.join(agyHooksDir, "hooks.json");

  try {
    const cmd = new Deno.Command("bash", {
      args: [
        INSTALL_SCRIPT_PATH,
        "--hooks-dir",
        hooksDir,
        "--settings-path",
        settingsPath,
        "--agy-hooks-path",
        agyHooksPath,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    assertEquals(code, 0, `install-hooks.sh failed: ${new TextDecoder().decode(stderr)}`);

    // 1. Symlink created in hooks dir
    const hookSymlink = path.join(hooksDir, "block-private-folder-read.sh");
    const stat = await Deno.lstat(hookSymlink);
    assert(stat.isSymlink, "Expected block-private-folder-read.sh to be a symlink");
    const target = await Deno.readLink(hookSymlink);
    assertStringIncludes(target, "hooks/block-private-folder-read.sh");

    // 2. Merged into Claude Code settings.json
    const settingsContent = await Deno.readTextFile(settingsPath);
    const settingsData = JSON.parse(settingsContent);
    const preToolUse = settingsData.hooks?.PreToolUse || [];
    const bashEntry = preToolUse.find(
      (e: { matcher: string; hooks: { command: string }[] }) => e.matcher === "Bash",
    );
    assert(bashEntry, "Expected PreToolUse entry with matcher Bash");
    const hasCommand = bashEntry.hooks.some((h: { command: string }) =>
      h.command.includes("block-private-folder-read.sh")
    );
    assert(
      hasCommand,
      "Expected settings.json PreToolUse hooks to include block-private-folder-read.sh",
    );

    // 3. Merged into agy hooks.json
    const agyContent = await Deno.readTextFile(agyHooksPath);
    const agyData = JSON.parse(agyContent);
    const agyPre = agyData.hooks?.PreToolUse || [];
    const agyHasHook = agyPre.some((e: { matcher: string; hooks: { command: string }[] }) =>
      e.hooks.some((h) =>
        h.command.includes("agy-hook-shim.sh") &&
        h.command.includes("block-private-folder-read.sh")
      )
    );
    assert(
      agyHasHook,
      "Expected agy hooks.json to include block-private-folder-read.sh via agy-hook-shim.sh",
    );
  } finally {
    await Deno.remove(hooksDir, { recursive: true });
    await Deno.remove(settingsDir, { recursive: true });
    await Deno.remove(agyHooksDir, { recursive: true });
  }
});
