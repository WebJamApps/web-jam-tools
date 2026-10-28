import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import {
  checkAgyUntranslated,
  checkApplyPatch,
  checkFileToolWrite,
  checkShellCommand,
  DOCUMENT_EXTENSIONS,
  evaluatePayload,
  MEDIA_EXTENSIONS,
} from "../hooks/lib/check_production_media_change.ts";
import { readHookRegistrations } from "../scripts/install-codex.ts";

const REPO_ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const HOOK_SCRIPT = path.join(REPO_ROOT, "hooks", "block-production-media-change.sh");
const INSTALL_HOOKS_SCRIPT = path.join(REPO_ROOT, "scripts", "install-hooks.sh");
const INSTALL_CODEX_SCRIPT = path.join(REPO_ROOT, "scripts", "install-codex.ts");

async function runBash(script: string, env?: Record<string, string>): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const cmd = new Deno.Command("bash", {
    args: ["-c", script],
    env: env ? { ...Deno.env.toObject(), ...env } : undefined,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function createFixtureHome(): Promise<string> {
  const res = await runBash(`
    set -euo pipefail
    tmp_home="$(mktemp -d)"
    jm="$tmp_home/Dropbox/joshandmariamusic"
    mkdir -p \\
      "$jm/originals" \\
      "$jm/photos" \\
      "$jm/JoshMaria_videos-2026" \\
      "$jm/audio" \\
      "$jm/Mission" \\
      "$jm/JoshMariaMusic" \\
      "$tmp_home/Dropbox/web-jam-llms"
    printf 'mp3' > "$jm/originals/Narthex.mp3"
    printf 'png' > "$jm/photos/valhalla.png"
    printf 'png' > "$jm/photos/osbc.png"
    printf 'mp4' > "$jm/JoshMaria_videos-2026/Lodi.mp4"
    printf 'wav' > "$jm/audio/take1.wav"
    printf 'docx' > "$jm/Mission/Narthex.docx"
    printf 'pdf' > "$jm/Mission/Narthex.pdf"
    printf 'notes' > "$jm/Mission/notes.txt"
    printf 'readme' > "$jm/JoshMariaMusic/readme.txt"
    printf 'png' > "$tmp_home/Dropbox/web-jam-llms/old.png"
    printf 'os.remove("/home/joshua/Dropbox/joshandmariamusic/audio/take1.wav")\\n' > /tmp/clean.py
    printf '%s' "$tmp_home"
  `);
  assertEquals(res.code, 0, `fixture setup failed: ${res.stderr}`);
  return res.stdout.trim();
}

async function cleanupFixtureHome(tmpHome: string): Promise<void> {
  await runBash(`rm -rf "$1" /tmp/clean.py`, { 1: tmpHome });
  await runBash(`rm -rf "${tmpHome}" /tmp/clean.py`);
}

async function runHookLauncher(
  payload: string,
  home: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command(HOOK_SCRIPT, {
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: {
      ...Deno.env.toObject(),
      HOME: home,
      WJT_HOOK_SWITCH_DIR: path.join(home, "no-switches"),
      WJT_HOOK_LOG_DIR: path.join(home, "hook-logs"),
      ...extraEnv,
    },
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(payload));
  await writer.close();
  const out = await child.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

interface DesignTableCase {
  label: string;
  payload: Record<string, unknown>;
  expectedAllowed: boolean;
  expectedCheck?: 1 | 2 | 3 | 4 | 5 | 6;
}

const DESIGN_TABLE_CASES: DesignTableCase[] = [
  // 1-11: Check 1 (existing media file or media wildcard)
  {
    label: "rm ~/Dropbox/joshandmariamusic/originals/Narthex.mp3",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "rm ~/Dropbox/joshandmariamusic/originals/Narthex.mp3" },
    },
    expectedAllowed: false,
    expectedCheck: 1,
  },
  {
    label: 'rm -f "/home/joshua/Dropbox/joshandmariamusic/photos/valhalla.png"',
    payload: {
      tool_name: "Bash",
      tool_input: { command: 'rm -f "/home/joshua/Dropbox/joshandmariamusic/photos/valhalla.png"' },
    },
    expectedAllowed: false,
    expectedCheck: 1,
  },
  {
    label: "unlink ~/Dropbox/joshandmariamusic/photos/osbc.png",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "unlink ~/Dropbox/joshandmariamusic/photos/osbc.png" },
    },
    expectedAllowed: false,
    expectedCheck: 1,
  },
  {
    label:
      "mv ~/Dropbox/joshandmariamusic/photos/osbc.png ~/Dropbox/joshandmariamusic/photos/osbc-old.png",
    payload: {
      tool_name: "Bash",
      tool_input: {
        command:
          "mv ~/Dropbox/joshandmariamusic/photos/osbc.png ~/Dropbox/joshandmariamusic/photos/osbc-old.png",
      },
    },
    expectedAllowed: false,
    expectedCheck: 1,
  },
  {
    label: "mv ~/Dropbox/joshandmariamusic/photos/OSBC.PNG /tmp/",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "mv ~/Dropbox/joshandmariamusic/photos/OSBC.PNG /tmp/" },
    },
    expectedAllowed: false,
    expectedCheck: 1,
  },
  {
    label: "gio trash ~/Dropbox/joshandmariamusic/JoshMaria_videos-2026/Lodi.mp4",
    payload: {
      tool_name: "Bash",
      tool_input: {
        command: "gio trash ~/Dropbox/joshandmariamusic/JoshMaria_videos-2026/Lodi.mp4",
      },
    },
    expectedAllowed: false,
    expectedCheck: 1,
  },
  {
    label: "trash-put ~/Dropbox/joshandmariamusic/audio/take1.wav",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "trash-put ~/Dropbox/joshandmariamusic/audio/take1.wav" },
    },
    expectedAllowed: false,
    expectedCheck: 1,
  },
  {
    label: "cp /tmp/new.png ~/Dropbox/joshandmariamusic/photos/valhalla.png",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "cp /tmp/new.png ~/Dropbox/joshandmariamusic/photos/valhalla.png" },
    },
    expectedAllowed: false,
    expectedCheck: 1,
  },
  {
    label: "ffmpeg -y -i /tmp/in.wav ~/Dropbox/joshandmariamusic/audio/take1.wav",
    payload: {
      tool_name: "Bash",
      tool_input: {
        command: "ffmpeg -y -i /tmp/in.wav ~/Dropbox/joshandmariamusic/audio/take1.wav",
      },
    },
    expectedAllowed: false,
    expectedCheck: 1,
  },
  {
    label: "sed -i s/a/b/ ~/Dropbox/joshandmariamusic/photos/*.png",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "sed -i s/a/b/ ~/Dropbox/joshandmariamusic/photos/*.png" },
    },
    expectedAllowed: false,
    expectedCheck: 1,
  },
  {
    label: "cd ~/Dropbox/joshandmariamusic/originals && rm Narthex.mp3",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "cd ~/Dropbox/joshandmariamusic/originals && rm Narthex.mp3" },
    },
    expectedAllowed: false,
    expectedCheck: 1,
  },

  // 12-16: Check 2 (directory or wildcard holding media/document)
  {
    label: "rm -r ~/Dropbox/joshandmariamusic/audio",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "rm -r ~/Dropbox/joshandmariamusic/audio" },
    },
    expectedAllowed: false,
    expectedCheck: 2,
  },
  {
    label: "rm -rf ~/Dropbox/joshandmariamusic",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "rm -rf ~/Dropbox/joshandmariamusic" },
    },
    expectedAllowed: false,
    expectedCheck: 2,
  },
  {
    label: 'find ~/Dropbox/joshandmariamusic -name "*.tmp" -delete',
    payload: {
      tool_name: "Bash",
      tool_input: { command: 'find ~/Dropbox/joshandmariamusic -name "*.tmp" -delete' },
    },
    expectedAllowed: false,
    expectedCheck: 2,
  },
  {
    label: "rsync -a --delete /tmp/site/ ~/Dropbox/joshandmariamusic/photos/",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "rsync -a --delete /tmp/site/ ~/Dropbox/joshandmariamusic/photos/" },
    },
    expectedAllowed: false,
    expectedCheck: 2,
  },
  {
    label: "mv ~/Dropbox/joshandmariamusic/photos /tmp/photos",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "mv ~/Dropbox/joshandmariamusic/photos /tmp/photos" },
    },
    expectedAllowed: false,
    expectedCheck: 2,
  },

  // 17: Check 4 (script file given to python3)
  {
    label: "python3 /tmp/clean.py",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "python3 /tmp/clean.py" },
    },
    expectedAllowed: false,
    expectedCheck: 4,
  },

  // 18-19: Check 5 (Write and apply_patch on media)
  {
    label: "Write with file_path /home/joshua/Dropbox/joshandmariamusic/photos/valhalla.png",
    payload: {
      tool_name: "Write",
      tool_input: {
        file_path: "/home/joshua/Dropbox/joshandmariamusic/photos/valhalla.png",
        content: "overwrite",
      },
    },
    expectedAllowed: false,
    expectedCheck: 5,
  },
  {
    label:
      "Codex apply_patch holding *** Delete File: /home/joshua/Dropbox/joshandmariamusic/photos/osbc.png",
    payload: {
      tool_name: "apply_patch",
      tool_input: {
        command:
          "*** Begin Patch\n*** Delete File: /home/joshua/Dropbox/joshandmariamusic/photos/osbc.png\n*** End Patch",
      },
    },
    expectedAllowed: false,
    expectedCheck: 5,
  },

  // 20: Check 6 (unparseable quote)
  {
    label: 'rm ~/Dropbox/joshandmariamusic/audio/"unterminated',
    payload: {
      tool_name: "Bash",
      tool_input: { command: 'rm ~/Dropbox/joshandmariamusic/audio/"unterminated' },
    },
    expectedAllowed: false,
    expectedCheck: 6,
  },

  // 21-27: Check 3, Check 2, Check 5 on documents
  {
    label: "rm ~/Dropbox/joshandmariamusic/Mission/Narthex.docx",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "rm ~/Dropbox/joshandmariamusic/Mission/Narthex.docx" },
    },
    expectedAllowed: false,
    expectedCheck: 3,
  },
  {
    label: "gio trash ~/Dropbox/joshandmariamusic/Mission/Narthex.pdf",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "gio trash ~/Dropbox/joshandmariamusic/Mission/Narthex.pdf" },
    },
    expectedAllowed: false,
    expectedCheck: 3,
  },
  {
    label:
      "mv ~/Dropbox/joshandmariamusic/Mission/Narthex.docx ~/Dropbox/joshandmariamusic/Mission/Narthex-old.docx",
    payload: {
      tool_name: "Bash",
      tool_input: {
        command:
          "mv ~/Dropbox/joshandmariamusic/Mission/Narthex.docx ~/Dropbox/joshandmariamusic/Mission/Narthex-old.docx",
      },
    },
    expectedAllowed: false,
    expectedCheck: 3,
  },
  {
    label: "mv /tmp/Narthex.docx ~/Dropbox/joshandmariamusic/Mission/Narthex.docx",
    payload: {
      tool_name: "Bash",
      tool_input: {
        command: "mv /tmp/Narthex.docx ~/Dropbox/joshandmariamusic/Mission/Narthex.docx",
      },
    },
    expectedAllowed: false,
    expectedCheck: 3,
  },
  {
    label: "rm ~/Dropbox/joshandmariamusic/Mission/*.DOC",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "rm ~/Dropbox/joshandmariamusic/Mission/*.DOC" },
    },
    expectedAllowed: false,
    expectedCheck: 3,
  },
  {
    label: 'find ~/Dropbox/joshandmariamusic/Mission -name "*.docx" -delete',
    payload: {
      tool_name: "Bash",
      tool_input: { command: 'find ~/Dropbox/joshandmariamusic/Mission -name "*.docx" -delete' },
    },
    expectedAllowed: false,
    expectedCheck: 2,
  },
  {
    label:
      "Codex apply_patch holding *** Delete File: /home/joshua/Dropbox/joshandmariamusic/Mission/Narthex.docx",
    payload: {
      tool_name: "apply_patch",
      tool_input: {
        command:
          "*** Begin Patch\n*** Delete File: /home/joshua/Dropbox/joshandmariamusic/Mission/Narthex.docx\n*** End Patch",
      },
    },
    expectedAllowed: false,
    expectedCheck: 5,
  },

  // 28-39: Allow cases
  {
    label: "ls -l ~/Dropbox/joshandmariamusic/photos/valhalla.png",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "ls -l ~/Dropbox/joshandmariamusic/photos/valhalla.png" },
    },
    expectedAllowed: true,
  },
  {
    label: "ffprobe ~/Dropbox/joshandmariamusic/originals/Narthex.mp3",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "ffprobe ~/Dropbox/joshandmariamusic/originals/Narthex.mp3" },
    },
    expectedAllowed: true,
  },
  {
    label: "cp ~/Dropbox/joshandmariamusic/originals/Narthex.mp3 /tmp/",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "cp ~/Dropbox/joshandmariamusic/originals/Narthex.mp3 /tmp/" },
    },
    expectedAllowed: true,
  },
  {
    label: "rclone copy ~/Dropbox/joshandmariamusic/JoshMariaMusic/ gdrive:JoshMariaMusic/",
    payload: {
      tool_name: "Bash",
      tool_input: {
        command: "rclone copy ~/Dropbox/joshandmariamusic/JoshMariaMusic/ gdrive:JoshMariaMusic/",
      },
    },
    expectedAllowed: true,
  },
  {
    label:
      "ffmpeg -i /tmp/in.wav ~/Dropbox/joshandmariamusic/audio/new-take.wav (new-take.wav does not exist)",
    payload: {
      tool_name: "Bash",
      tool_input: {
        command: "ffmpeg -i /tmp/in.wav ~/Dropbox/joshandmariamusic/audio/new-take.wav",
      },
    },
    expectedAllowed: true,
  },
  {
    label: "rm ~/Dropbox/joshandmariamusic/Mission/notes.txt",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "rm ~/Dropbox/joshandmariamusic/Mission/notes.txt" },
    },
    expectedAllowed: true,
  },
  {
    label: "cp /tmp/Narthex.docx ~/Dropbox/joshandmariamusic/Mission/Narthex.docx",
    payload: {
      tool_name: "Bash",
      tool_input: {
        command: "cp /tmp/Narthex.docx ~/Dropbox/joshandmariamusic/Mission/Narthex.docx",
      },
    },
    expectedAllowed: true,
  },
  {
    label:
      "deno task sheet-music:generate --input /tmp/song-input.json --output /home/joshua/Dropbox/joshandmariamusic/Mission/Narthex.docx",
    payload: {
      tool_name: "Bash",
      tool_input: {
        command:
          "deno task sheet-music:generate --input /tmp/song-input.json --output /home/joshua/Dropbox/joshandmariamusic/Mission/Narthex.docx",
      },
    },
    expectedAllowed: true,
  },
  {
    label: "Write with file_path /home/joshua/Dropbox/joshandmariamusic/Mission/Narthex.docx",
    payload: {
      tool_name: "Write",
      tool_input: {
        file_path: "/home/joshua/Dropbox/joshandmariamusic/Mission/Narthex.docx",
        content: "revised lead sheet",
      },
    },
    expectedAllowed: true,
  },
  {
    label:
      'agy view_file {"AbsolutePath":"/home/joshua/Dropbox/joshandmariamusic/Mission/Narthex.pdf"}',
    payload: {
      tool_name: "AgyUntranslated",
      tool_input: {
        AbsolutePath: "/home/joshua/Dropbox/joshandmariamusic/Mission/Narthex.pdf",
      },
    },
    expectedAllowed: true,
  },
  {
    label: "cp /tmp/Narthex.docx ~/Dropbox/joshandmariamusic/Mission/",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "cp /tmp/Narthex.docx ~/Dropbox/joshandmariamusic/Mission/" },
    },
    expectedAllowed: true,
  },
  {
    label: "rm ~/Dropbox/web-jam-llms/old.png",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "rm ~/Dropbox/web-jam-llms/old.png" },
    },
    expectedAllowed: true,
  },
];

Deno.test("production-media guard: all 39 literal cases from the hooks design table", async (t) => {
  const tmpHome = await createFixtureHome();
  try {
    for (const tc of DESIGN_TABLE_CASES) {
      await t.step(tc.label, () => {
        const decision = evaluatePayload(JSON.stringify(tc.payload), REPO_ROOT, tmpHome);
        assertEquals(
          decision.allowed,
          tc.expectedAllowed,
          `Expected allowed=${tc.expectedAllowed} for '${tc.label}', got ${
            JSON.stringify(decision)
          }`,
        );
        if (!tc.expectedAllowed && tc.expectedCheck !== undefined && !decision.allowed) {
          assertEquals(
            decision.check,
            tc.expectedCheck,
            `Expected check ${tc.expectedCheck} for '${tc.label}', got check ${decision.check} (${decision.reason})`,
          );
        }
      });
    }
  } finally {
    await cleanupFixtureHome(tmpHome);
  }
});

Deno.test("production-media guard: additional Check 4, Check 5, Check 6, and AgyUntranslated edge cases", async () => {
  const tmpHome = await createFixtureHome();
  try {
    // AgyUntranslated naming an existing media file refuses (Check 5)
    const agyMedia = checkAgyUntranslated(
      { AbsolutePath: "/home/joshua/Dropbox/joshandmariamusic/originals/Narthex.mp3" },
      REPO_ROOT,
      tmpHome,
    );
    assertEquals(agyMedia.allowed, false);
    if (!agyMedia.allowed) assertEquals(agyMedia.check, 5);

    // Edit and NotebookEdit on existing media refuse (Check 5)
    const editMedia = checkFileToolWrite(
      { file_path: "/home/joshua/Dropbox/joshandmariamusic/originals/Narthex.mp3" },
      REPO_ROOT,
      tmpHome,
    );
    assertEquals(editMedia.allowed, false);
    if (!editMedia.allowed) assertEquals(editMedia.check, 5);

    const notebookMedia = evaluatePayload(
      JSON.stringify({
        tool_name: "NotebookEdit",
        tool_input: { notebook_path: "~/Dropbox/joshandmariamusic/audio/take1.wav" },
      }),
      REPO_ROOT,
      tmpHome,
    );
    assertEquals(notebookMedia.allowed, false);
    if (!notebookMedia.allowed) assertEquals(notebookMedia.check, 5);

    // Codex apply_patch moving an existing document refuses (Check 5)
    const patchMoveDoc = checkApplyPatch(
      "*** Begin Patch\n*** Update File: /home/joshua/Dropbox/joshandmariamusic/Mission/Narthex.docx\n*** Move to: /home/joshua/Dropbox/joshandmariamusic/Mission/Narthex-renamed.docx\n*** End Patch",
      REPO_ROOT,
      tmpHome,
    );
    assertEquals(patchMoveDoc.allowed, false);
    if (!patchMoveDoc.allowed) assertEquals(patchMoveDoc.check, 5);

    // Codex apply_patch updating an existing document in place is allowed
    const patchUpdateDoc = checkApplyPatch(
      "*** Begin Patch\n*** Update File: /home/joshua/Dropbox/joshandmariamusic/Mission/Narthex.docx\n@@\n-old\n+new\n*** End Patch",
      REPO_ROOT,
      tmpHome,
    );
    assertEquals(patchUpdateDoc.allowed, true);

    // Heredoc passed to python3 referencing existing media refuses (Check 4)
    const heredocMedia = checkShellCommand(
      `python3 - <<'PY'\nimport os\nos.unlink("${tmpHome}/Dropbox/joshandmariamusic/originals/Narthex.mp3")\nPY`,
      REPO_ROOT,
      tmpHome,
    );
    assertEquals(heredocMedia.allowed, false);
    if (!heredocMedia.allowed) assertEquals(heredocMedia.check, 4);

    // Unparseable JSON payload refuses (Check 6)
    const badJson = evaluatePayload("{not-valid-json", REPO_ROOT, tmpHome);
    assertEquals(badJson.allowed, false);
    if (!badJson.allowed) assertEquals(badJson.check, 6);

    // Unparseable apply_patch refuses (Check 6)
    const badPatch = checkApplyPatch("not a valid patch", REPO_ROOT, tmpHome);
    assertEquals(badPatch.allowed, false);
    if (!badPatch.allowed) assertEquals(badPatch.check, 6);
  } finally {
    await cleanupFixtureHome(tmpHome);
  }
});

Deno.test("production-media guard launcher: end-to-end shell script execution, Codex surface, and fail-closed safety default", async () => {
  const tmpHome = await createFixtureHome();
  try {
    // 1. Refusal via shell entry point
    const refuseRes = await runHookLauncher(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "rm ~/Dropbox/joshandmariamusic/originals/Narthex.mp3" },
      }),
      tmpHome,
    );
    assertEquals(refuseRes.code, 2);
    assertStringIncludes(refuseRes.stderr, "BLOCKED (production-media guard — check 1)");

    // 2. Allow via shell entry point
    const allowRes = await runHookLauncher(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "ls -l ~/Dropbox/joshandmariamusic/photos/valhalla.png" },
      }),
      tmpHome,
    );
    assertEquals(allowRes.code, 0);

    // 3. Codex surface (WJT_SURFACE=codex) emits no stdout on allow
    const codexAllow = await runHookLauncher(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "ffprobe ~/Dropbox/joshandmariamusic/originals/Narthex.mp3" },
      }),
      tmpHome,
      { WJT_SURFACE: "codex" },
    );
    assertEquals(codexAllow.code, 0);
    assertEquals(codexAllow.stdout.trim(), "");

    // 4. Malformed JSON payload refuses via shell entry point (Check 6)
    const malformedRes = await runHookLauncher(
      "{malformed-unparseable-json",
      tmpHome,
    );
    assertEquals(malformedRes.code, 2);
    assertStringIncludes(malformedRes.stderr, "BLOCKED (production-media guard — check 6)");

    // 5. When Deno is unavailable on PATH, run_hook.sh fails closed (safety group default)
    const noDenoRes = await runHookLauncher(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "ls -l ~/Dropbox/joshandmariamusic/photos/valhalla.png" },
      }),
      tmpHome,
      { PATH: "/usr/bin:/bin" },
    );
    assertEquals(noDenoRes.code, 2);
    assertStringIncludes(noDenoRes.stderr, "BLOCKED (block-production-media-change)");
  } finally {
    await cleanupFixtureHome(tmpHome);
  }
});

Deno.test("installers: Claude Code, agy, and Codex register block-production-media-change.sh and the 10 Edit deny rules", async () => {
  assertEquals(MEDIA_EXTENSIONS.length, 10);
  assertEquals(DOCUMENT_EXTENSIONS.length, 3);

  const tmpHome = await createFixtureHome();
  try {
    const hooksDir = path.join(tmpHome, ".claude", "hooks");
    const settingsPath = path.join(tmpHome, ".claude", "settings.json");
    const agyHooksPath = path.join(tmpHome, ".gemini", "config", "hooks.json");
    const agySettingsPath = path.join(tmpHome, ".gemini", "antigravity-cli", "settings.json");
    const codexHooksPath = path.join(tmpHome, ".codex", "hooks.json");
    const agentsMdPath = path.join(tmpHome, ".agents", "AGENTS.md");
    const binDir = path.join(tmpHome, ".local", "bin");
    const denoBinDir = path.dirname(Deno.execPath());
    const cleanPath = `${denoBinDir}:/usr/bin:/bin`;

    await runBash(
      `mkdir -p "$(dirname "${settingsPath}")" "$(dirname "${agyHooksPath}")" "$(dirname "${agySettingsPath}")" "$(dirname "${codexHooksPath}")" "$(dirname "${agentsMdPath}")" "${binDir}"`,
    );

    // 1. Run scripts/install-hooks.sh into isolated paths
    const installRes = await runBash(
      `"${INSTALL_HOOKS_SCRIPT}" \\
        --hooks-dir "${hooksDir}" \\
        --settings-path "${settingsPath}" \\
        --agy-hooks-path "${agyHooksPath}" \\
        --agy-settings-path "${agySettingsPath}" \\
        --codex-hooks-path "${codexHooksPath}" \\
        --agents-md-path "${agentsMdPath}" \\
        --bin-dir "${binDir}"`,
      { HOME: tmpHome, PATH: cleanPath, CODEX_HOME: "", CODEX_HOOKS_PATH: "" },
    );
    assertEquals(
      installRes.code,
      0,
      `install-hooks.sh failed: ${installRes.stderr}\n${installRes.stdout}`,
    );

    // Verify Claude Code settings.json has the PreToolUse registration and all 10 Edit deny rules
    const claudeSettings = JSON.parse(await Deno.readTextFile(settingsPath));
    const preToolGroups = claudeSettings?.hooks?.PreToolUse ?? [];
    const prodMediaGroup = preToolGroups.find((
      g: { matcher?: string; hooks?: { command?: string }[] },
    ) =>
      g.matcher === "Bash|Edit|Write|NotebookEdit" &&
      g.hooks?.some((h) => h.command === "$HOME/.claude/hooks/block-production-media-change.sh")
    );
    assert(
      prodMediaGroup,
      "Expected block-production-media-change.sh under matcher 'Bash|Edit|Write|NotebookEdit' in Claude settings.json",
    );

    const denyList: string[] = claudeSettings?.permissions?.deny ?? [];
    for (const ext of MEDIA_EXTENSIONS) {
      const rule = `Edit(//home/joshua/Dropbox/joshandmariamusic/**/*.${ext})`;
      assert(
        denyList.includes(rule),
        `Expected Claude Code permissions.deny to include '${rule}'`,
      );
    }

    // Verify agy hooks.json registers block-production-media-change.sh through agy-hook-shim.sh
    const agyHooks = JSON.parse(await Deno.readTextFile(agyHooksPath));
    const agyPreToolGroups = agyHooks?.hooks?.PreToolUse ?? [];
    const expectedB64 = btoa("Bash|Edit|Write|NotebookEdit");
    const expectedAgyCmd =
      `$HOME/.claude/hooks/agy-hook-shim.sh PreToolUse ${expectedB64} $HOME/.claude/hooks/block-production-media-change.sh`;
    const hasAgyRegistration = agyPreToolGroups.some(
      (g: { matcher?: string; hooks?: { command?: string }[] }) =>
        g.matcher === ".*" && g.hooks?.some((h) => h.command === expectedAgyCmd),
    );
    assert(
      hasAgyRegistration,
      `Expected agy hooks.json to contain '${expectedAgyCmd}'`,
    );

    // 2. Verify Codex installer (scripts/install-codex.ts) registers block-production-media-change.sh in config.toml
    const installHooksSource = await Deno.readTextFile(INSTALL_HOOKS_SCRIPT);
    const regs = readHookRegistrations(installHooksSource, tmpHome);
    const expectedCodexCommand =
      `WJT_SURFACE=codex '${tmpHome}/.claude/hooks/block-production-media-change.sh'`;
    assert(
      regs.PreToolUse.some((r) =>
        r.matcher === "Bash|Edit|Write|NotebookEdit" &&
        r.hooks.some((h) => h.command === expectedCodexCommand)
      ),
      "Expected readHookRegistrations to include Bash|Edit|Write|NotebookEdit::block-production-media-change.sh",
    );

    const codexRes = await runBash(
      `deno run -A "${INSTALL_CODEX_SCRIPT}" --home "${tmpHome}"`,
      { HOME: tmpHome },
    );
    assertEquals(
      codexRes.code,
      0,
      `install-codex.ts failed: ${codexRes.stderr}\n${codexRes.stdout}`,
    );

    const codexConfig = await Deno.readTextFile(path.join(tmpHome, ".codex", "config.toml"));
    assertStringIncludes(codexConfig, 'matcher = "Bash|Edit|Write|NotebookEdit"');
    assertStringIncludes(codexConfig, expectedCodexCommand);
  } finally {
    await cleanupFixtureHome(tmpHome);
  }
});
