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
//   2. Only the three allowed Dropbox folders pass; unknown and prefix-sharing
//      top-level names are refused, even when absent from the private list.
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
  checkPrivateFolderCommand,
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

// The documented suite grants --allow-run, not --allow-write. Keep fixture writes
// in a fixed child program; the guard itself only receives command text and never runs it.
function fixtureIO(action: string, args: unknown[]): string {
  const code = `
    const [action, json] = Deno.args;
    const args = JSON.parse(json);
    if (action === "temp") console.log(Deno.makeTempDirSync(args[0]));
    else if (action === "write") Deno.writeTextFileSync(args[0], args[1]);
    else if (action === "mkdir") Deno.mkdirSync(args[0], { recursive: true });
    else if (action === "symlink") Deno.symlinkSync(args[0], args[1]);
    else if (action === "remove") Deno.removeSync(args[0], { recursive: true });
    else throw new Error("unknown fixture action");
  `;
  const result = new Deno.Command(Deno.execPath(), {
    args: ["eval", code, action, JSON.stringify(args)],
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function createFixtureDir(options: Deno.MakeTempOptions = {}): string {
  return fixtureIO("temp", [options]);
}

function writeFixture(filename: string, text: string): void {
  fixtureIO("write", [filename, text]);
}

function removeFixture(filename: string, _options?: Deno.RemoveOptions): void {
  fixtureIO("remove", [filename]);
}

// Fixture Claude settings file so no test depends on the real one of whoever runs them.
const FIXTURE_DIR = createFixtureDir({ prefix: "private-folder-guard-" });
const FIXTURE_SETTINGS_PATH = path.join(FIXTURE_DIR, "settings.json");
writeFixture(
  FIXTURE_SETTINGS_PATH,
  JSON.stringify({
    permissions: {
      deny: EXPECTED_16_FOLDERS.map((f) => `Read(//home/joshua/Dropbox/${f}/**)`),
    },
  }),
);
globalThis.addEventListener("unload", () => {
  try {
    removeFixture(FIXTURE_DIR, { recursive: true });
  } catch {
    // already gone
  }
});

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
    env: { ...Deno.env.toObject(), CLAUDE_SETTINGS_PATH: FIXTURE_SETTINGS_PATH, ...env },
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

Deno.test("getPrivateDropboxFolders extracts all 16 private folders from a fixture settings file", () => {
  const result = getPrivateDropboxFolders(FIXTURE_SETTINGS_PATH);
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
  const tempDir = await createFixtureDir();
  const tempFile = path.join(tempDir, "corrupt.json");
  try {
    await writeFixture(tempFile, "{ not valid json");
    const result = getPrivateDropboxFolders(tempFile);
    assertEquals(result.ok, false);
    assertStringIncludes(result.error ?? "", "cannot parse JSON");
  } finally {
    await removeFixture(tempDir, { recursive: true });
  }
});

Deno.test("getPrivateDropboxFolders fails closed when permissions.deny is missing", async () => {
  const tempDir = await createFixtureDir();
  const tempFile = path.join(tempDir, "no_deny.json");
  try {
    await writeFixture(tempFile, JSON.stringify({ permissions: {} }));
    const result = getPrivateDropboxFolders(tempFile);
    assertEquals(result.ok, false);
    assertStringIncludes(result.error ?? "", "permissions.deny is not an array");
  } finally {
    await removeFixture(tempDir, { recursive: true });
  }
});

Deno.test("getPrivateDropboxFolders fails closed when no Dropbox folders are found in deny rules", async () => {
  const tempDir = await createFixtureDir();
  const tempFile = path.join(tempDir, "empty_deny.json");
  try {
    await writeFixture(
      tempFile,
      JSON.stringify({ permissions: { deny: ["Bash(git push -f *)"] } }),
    );
    const result = getPrivateDropboxFolders(tempFile);
    assertEquals(result.ok, false);
    assertStringIncludes(result.error ?? "", "no private Dropbox folders found");
  } finally {
    await removeFixture(tempDir, { recursive: true });
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
    const cmd = `cat ~/Dropbox/'${folder}'/x`;
    const res = await runHook({ tool_name: "Bash", tool_input: { command: cmd } });
    assertEquals(res.code, 2);
    assertStringIncludes(res.stderr, "BLOCKED (private-folder read guard)");
    assertStringIncludes(res.stderr, folder);
  });

  Deno.test(`hook refuses literal shape 2: ls /home/joshua/Dropbox/${folder}`, async () => {
    const cmd = `ls '/home/joshua/Dropbox/${folder}'`;
    const res = await runHook({ tool_name: "Bash", tool_input: { command: cmd } });
    assertEquals(res.code, 2);
    assertStringIncludes(res.stderr, "BLOCKED (private-folder read guard)");
    assertStringIncludes(res.stderr, folder);
  });

  Deno.test(`hook refuses literal shape 3: rg foo ~/Dropbox/${folder}`, async () => {
    const cmd = `rg foo ~/Dropbox/'${folder}'`;
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

Deno.test("hook refuses a Dropbox folder absent from the private list", async () => {
  const cmd = "cat ~/Dropbox/OutsideTheList/x";
  const res = await runHook({ tool_name: "Bash", tool_input: { command: cmd } });
  assertEquals(res.code, 2);
  assertStringIncludes(res.stderr, "OutsideTheList");
});

Deno.test("hook refuses an unapproved prefix-sharing folder: WebJamAppsExtra", async () => {
  const cmd = "ls ~/Dropbox/WebJamAppsExtra";
  const res = await runHook({ tool_name: "Bash", tool_input: { command: cmd } });
  assertEquals(res.code, 2);
});

Deno.test("hook refuses an unapproved prefix-sharing folder: AppsExtra", async () => {
  const cmd = "ls ~/Dropbox/AppsExtra";
  const res = await runHook({ tool_name: "Bash", tool_input: { command: cmd } });
  assertEquals(res.code, 2);
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
    tool_input: { command: "cat ~/Dropbox/web-jam-llms/notes.md" },
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
  const tempDir = await createFixtureDir();
  const corruptFile = path.join(tempDir, "corrupt.json");
  try {
    await writeFixture(corruptFile, "invalid json content");
    const cmd = "ls /tmp";
    const res = await runHook(
      { tool_name: "Bash", tool_input: { command: cmd } },
      { CLAUDE_SETTINGS_PATH: corruptFile },
    );
    assertEquals(res.code, 2);
    assertStringIncludes(res.stderr, "BLOCKED (private-folder read guard)");
  } finally {
    await removeFixture(tempDir, { recursive: true });
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
  const hooksDir = await createFixtureDir();
  const settingsDir = await createFixtureDir();
  const agyHooksDir = await createFixtureDir();
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
        "--codex-hooks-path",
        path.join(settingsDir, "codex-hooks.json"),
      ],
      stdout: "piped",
      stderr: "piped",
      env: {
        ...Deno.env.toObject(),
        PATH: `${Deno.execPath().slice(0, Deno.execPath().lastIndexOf("/"))}:/usr/bin:/bin`,
      },
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
    await removeFixture(hooksDir, { recursive: true });
    await removeFixture(settingsDir, { recursive: true });
    await removeFixture(agyHooksDir, { recursive: true });
  }
});

// Every row of the private-folder design's literal command table. The two
// /tmp/s.py fixtures live in this suite's unique temp directory, never shared /tmp/s.py.
const DESIGN_CASES: Array<{ command: string; deny: boolean; source?: string }> = [
  { command: "cat ~/Dropbox/ShermanHome/notes.txt", deny: true },
  { command: 'ls "/home/joshua/Dropbox/Camera Uploads"', deny: true },
  { command: "ls ~/Dropbox", deny: true },
  { command: "ls ~/Dropbox/", deny: true },
  { command: "ls /home/joshua/Dropbox/W?bJamApps", deny: true },
  { command: "cat ~/Dropbox/Web*/notes.txt", deny: true },
  { command: "cat ~/Dropbox/*/notes.txt", deny: true },
  { command: 'D=~/Dropbox; ls "$D/Capture"', deny: true },
  { command: 'ls "$HOME/Dropbox/"', deny: true },
  { command: "cd ~/Dropbox && ls Apps", deny: true },
  { command: "cd ~/Dropbox; cat CollegeLutheran/notes.md", deny: true },
  { command: "rg -l invoice ~", deny: true },
  { command: "grep -r invoice $HOME", deny: true },
  { command: "grep -R invoice ${HOME}", deny: true },
  { command: 'find /home/joshua -name "*.kdbx"', deny: true },
  { command: "tar czf /tmp/home.tgz ~", deny: true },
  { command: "rsync -a ~ /tmp/copy", deny: true },
  { command: "cp -r ~ /tmp/copy", deny: true },
  { command: "du -sh ~", deny: true },
  { command: "ls -R ~", deny: true },
  {
    command: "python3 /tmp/s.py",
    source: 'open("/home/joshua/Dropbox/web-jam-llc/a.txt")',
    deny: true,
  },
  { command: "bash -s <<'EOF'\nls ~/Dropbox/Galapagos\nEOF", deny: true },
  { command: "ls ~/Dropbox/web-jam-llms/Access_Controls", deny: false },
  { command: "cat ~/Dropbox/joshandmariamusic/JoshMariaMusic/notes.md", deny: false },
  { command: "du -sm ~/Dropbox/mark_henrickson", deny: false },
  { command: "rg -l invoice ~/WebJamApps", deny: false },
  { command: 'find ~/WebJamApps/web-jam-tools -name "*.ts"', deny: false },
  { command: 'echo "the private folders live in Dropbox"', deny: false },
  { command: "dropbox sharelink ~/Dropbox/joshandmariamusic/audio/take1.wav", deny: true },
  { command: "dropbox status", deny: true },
  { command: "/usr/bin/dropbox filestatus ~/Dropbox/web-jam-llms", deny: true },
  { command: "python3 /usr/bin/dropbox puburl a.txt", deny: true },
  { command: "env dropbox exclude add ~/Dropbox/web-jam-llms", deny: true },
  { command: "cd /usr/bin && ./dropbox stop", deny: true },
  { command: 'bash -c "dropbox sharelink a.txt"', deny: true },
  {
    command: "python3 /tmp/s.py",
    source: 'subprocess.run(["/usr/bin/dropbox", "sharelink", "a.txt"])',
    deny: true,
  },
  { command: "deno task dropbox:link", deny: false },
  { command: "grep dropbox README.md", deny: false },
  { command: "ls ~/.dropbox-dist", deny: false },
  { command: "echo dropbox", deny: false },
];

for (const [index, entry] of DESIGN_CASES.entries()) {
  Deno.test(`design literal ${index + 1}: ${entry.command} (${entry.deny ? "refuse" : "allow"})`, async () => {
    let command = entry.command;
    if (entry.source) {
      const filename = path.join(FIXTURE_DIR, `script-${index}.py`);
      writeFixture(filename, entry.source);
      command = command.replace("/tmp/s.py", filename);
    }
    const result = await runHook({ tool_name: "Bash", tool_input: { command } });
    assertEquals(result.code, entry.deny ? 2 : 0, result.stderr);
    assertEquals(result.stdout, "");
  });
}

Deno.test("private-folder policy refuses relative paths from Dropbox cwd on every surface", async () => {
  for (const surface of ["claude", "agy", "codex"]) {
    const result = await runHook({
      tool_name: "Bash",
      cwd: "/home/joshua/Dropbox",
      tool_input: { command: "cat Apps/notes.txt" },
    }, { WJT_SURFACE: surface });
    assertEquals(result.code, 2, surface);
    assertEquals(result.stdout, "");
  }
});

Deno.test("private-folder policy covers remaining recursive flags and wrappers", () => {
  for (
    const command of [
      "cp -R ~ /tmp/copy",
      "sudo dropbox status",
      "nohup dropbox status",
      "exec dropbox status",
      "exec sudo dropbox status",
      "env sudo nohup /opt/dropbox status",
      'sh -c "dropbox status"',
      'python -c \'subprocess.run(["dropbox", "status"])\'',
      'node -e \'require("child_process").spawn("dropbox", ["status"])\'',
      "python3 - <<'PY'\nsubprocess.run(['dropbox', 'status'])\nPY",
      "node <<'JS'\nnew Deno.Command('/usr/bin/dropbox', {args: ['status']})\nJS",
      "find /home/joshua/.",
      'bash -lc "dropbox status"',
      "deno eval 'new Deno.Command(\"/usr/bin/dropbox\")'",
    ]
  ) {
    assert(checkPrivateFolderCommand(command, EXPECTED_16_FOLDERS) !== null, command);
  }
});

Deno.test("private-folder policy inspects each supported script interpreter without executing the file", async () => {
  const filename = path.join(FIXTURE_DIR, "private-script");
  writeFixture(filename, 'open("/home/joshua/Dropbox/web-jam-llc/a.txt")');
  for (const interpreter of ["python3", "python", "deno run", "node", "bash", "sh"]) {
    const result = await runHook({
      tool_name: "Bash",
      tool_input: { command: `${interpreter} ${filename}` },
    });
    assertEquals(result.code, 2, interpreter);
  }
  writeFixture(filename, "echo dropbox");
  const allowed = await runHook({ tool_name: "Bash", tool_input: { command: `bash ${filename}` } });
  assertEquals(allowed.code, 0, allowed.stderr);
});

Deno.test("private-folder policy fails closed on unreadable scripts and unresolvable paths", () => {
  for (
    const command of [
      "python3 /missing/script.py",
      'cat "$UNRESOLVED/Dropbox/notes"',
      'ls "unterminated',
    ]
  ) {
    assert(checkPrivateFolderCommand(command, EXPECTED_16_FOLDERS) !== null, command);
  }
});

Deno.test("private-folder policy resolves symlinks and parent traversal before allowing a path", () => {
  const home = createFixtureDir();
  try {
    const allowed = path.join(home, "Dropbox/web-jam-llms");
    const privateDir = path.join(home, "Dropbox/Private");
    fixtureIO("mkdir", [allowed]);
    fixtureIO("mkdir", [privateDir]);
    fixtureIO("symlink", [privateDir, path.join(allowed, "alias")]);
    fixtureIO("symlink", [path.join(home, "missing"), path.join(allowed, "dangling")]);
    for (
      const command of [
        "cat ~/Dropbox/web-jam-llms/../Private/file",
        "cat ~/Dropbox/web-jam-llms/alias/file",
        "cat ~/Dropbox/web-jam-llms/alias/../Private/file",
        "cat ~/Dropbox/web-jam-llms/dangling/file",
        "cat ~/Dropbox/web-jam-llms-extra/file",
      ]
    ) {
      assert(checkPrivateFolderCommand(command, EXPECTED_16_FOLDERS, home, home) !== null, command);
    }
    assertEquals(
      checkPrivateFolderCommand(
        "cat ~/Dropbox/web-jam-llms/new-file",
        EXPECTED_16_FOLDERS,
        home,
        home,
      ),
      null,
    );
  } finally {
    removeFixture(home);
  }
});

Deno.test("private-folder policy ignores comments and data heredocs", () => {
  for (
    const command of [
      "echo ok # cat ~/Dropbox/Apps/x",
      "python3 - <<'PY'\nprint('dropbox')\nPY",
      'bash -lc "echo dropbox"',
      "cat > /tmp/guard-notes <<'EOF'\ncat ~/Dropbox/Apps/x\ndropbox status\nEOF",
    ]
  ) assertEquals(checkPrivateFolderCommand(command, EXPECTED_16_FOLDERS), null, command);
});

Deno.test("private-folder hook refuses malformed command and cwd payloads", async () => {
  for (
    const payload of [
      '{"tool_name":"Bash",',
      { tool_name: "Bash", tool_input: { command: { unknown: true } } },
      { tool_name: "Bash", tool_input: { command: "pwd", cwd: 42 } },
    ]
  ) {
    const result = await runHook(payload);
    assertEquals(result.code, 2, result.stderr);
    assertEquals(result.stdout, "");
  }
});

Deno.test("private-folder policy refuses untracked directory changes", async () => {
  for (
    const command of [
      "pushd ~/Dropbox/web-jam-llms >/dev/null; pushd .. >/dev/null; ls",
      "cd ~/Dropbox/web-jam-llms; pushd /tmp; popd; cd ..; ls",
      "popd; ls",
      "cd ~/Dropbox/web-jam-llms; cd /tmp; cd -; cd ..; ls",
      "cd -P /tmp; ls",
      "cd ~/Dropbox/web-jam-llms; cd /tmp; cd ~-; cd ..; ls",
      "cd /tmp/*; ls",
      'cd "$UNKNOWN_DIRECTORY"; ls',
      "command pushd /tmp; ls",
      "cd ~/Dropbox/web-jam-llms; builtin cd ..; ls",
      "cd ~/Dropbox/web-jam-llms; eval 'cd ..'; ls",
      "cd ~/Dropbox/web-jam-llms; source /tmp/step.sh; ls",
      "cd ~/Dropbox/web-jam-llms; . /tmp/step.sh; ls",
      "command builtin cd /tmp; ls",
      "command eval 'cd /tmp'; ls",
    ]
  ) {
    assert(checkPrivateFolderCommand(command, EXPECTED_16_FOLDERS) !== null, command);
    const result = await runHook({ tool_name: "Bash", tool_input: { command } });
    assertEquals(result.code, 2, command);
    assertEquals(result.stdout, "", command);
    assertStringIncludes(result.stderr, "cannot resolve", command);
  }
  assertEquals(checkPrivateFolderCommand("cd -- /tmp; ls", EXPECTED_16_FOLDERS), null);
});

Deno.test("private-folder path variables come only from real assignments in the current shell", () => {
  for (
    const command of [
      'echo D=~/Dropbox/web-jam-llms; cat "$D/file"',
      'D=~/Dropbox/web-jam-llms echo ok; cat "$D/file"',
      'D=~/Dropbox/web-jam-llms cat "$D/file"',
      'bash -c "D=~/Dropbox/web-jam-llms"; cat "$D/file"',
    ]
  ) assert(checkPrivateFolderCommand(command, EXPECTED_16_FOLDERS) !== null, command);
  assertEquals(
    checkPrivateFolderCommand('D=~/Dropbox/web-jam-llms; cat "$D/file"', EXPECTED_16_FOLDERS),
    null,
  );
});
