// backup_claude_memory_secret_guard.test.ts — web-jam-tools#304
//
// Exercises the settings.json secret-literal guard added to
// scripts/backup-claude-memory.sh: it must REFUSE to rclone settings.json to
// Dropbox when it contains a credential-shaped literal (rather than
// faithfully replicating a leak on a schedule, as it did for ~2 months with
// a live Gemini API key), while every other backup step still runs.
//
// Sandboxed via CLAUDE_DIR / BACKUP_DST_DIR overrides (added alongside the
// guard) so this never touches Josh's real ~/.claude or ~/Dropbox — mirrors
// the --hooks-dir/--settings-path override convention in
// scripts/install-hooks.sh.
//
// Every credential string is SYNTHETIC, assembled at runtime via string
// concatenation so no complete credential-shaped literal sits in this file
// at rest.

import { assertEquals } from "@std/assert";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT_PATH = `${REPO_ROOT}scripts/backup-claude-memory.sh`;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runBackup(claudeDir: string, dstDir: string): Promise<RunResult> {
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    env: {
      ...Deno.env.toObject(),
      CLAUDE_DIR: claudeDir,
      BACKUP_DST_DIR: dstDir,
    },
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function setUpFixtureClaudeDir(settingsContents: unknown): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "wjt-claude-fixture-" });
  await Deno.mkdir(`${dir}/projects`, { recursive: true });
  await Deno.mkdir(`${dir}/shared-memory`, { recursive: true });
  await Deno.writeTextFile(`${dir}/CLAUDE.md`, "# fixture\n");
  await Deno.writeTextFile(`${dir}/settings.json`, JSON.stringify(settingsContents));
  return dir;
}

const FAKE_GOOGLE_KEY = "AIza" + "B".repeat(35);

Deno.test("refuses to copy settings.json containing a credential-shaped literal", async () => {
  const claudeDir = await setUpFixtureClaudeDir({
    permissions: {
      allow: ["Bash(ls -la)", `Bash(export GEMINI_API_KEY="${FAKE_GOOGLE_KEY}")`],
    },
  });
  const dstDir = await Deno.makeTempDir({ prefix: "wjt-dropbox-fixture-" });

  const res = await runBackup(claudeDir, dstDir);
  assertEquals(res.code, 0, res.stderr); // the script itself still exits clean

  if (await pathExists(`${dstDir}/claude-config/settings.json`)) {
    throw new Error("settings.json was copied despite containing a credential-shaped literal");
  }
  if (!res.stderr.includes("REFUSED settings.json backup")) {
    throw new Error(`expected a REFUSED message on stderr, got: ${res.stderr}`);
  }
  if (res.stderr.includes(FAKE_GOOGLE_KEY)) {
    throw new Error("the backup script echoed the secret value back into stderr");
  }

  // Everything else in the backup still ran.
  if (!(await pathExists(`${dstDir}/claude-config/CLAUDE.md`))) {
    throw new Error("CLAUDE.md backup should still have run alongside the refusal");
  }
});

Deno.test("copies settings.json normally when it has no credential-shaped literal", async () => {
  const claudeDir = await setUpFixtureClaudeDir({
    permissions: { allow: ["Bash(ls -la)", "Bash(export FOO=$BAR)"] },
  });
  const dstDir = await Deno.makeTempDir({ prefix: "wjt-dropbox-fixture-" });

  const res = await runBackup(claudeDir, dstDir);
  assertEquals(res.code, 0, res.stderr);

  if (!(await pathExists(`${dstDir}/claude-config/settings.json`))) {
    throw new Error("settings.json should have been copied — it contains no credential literal");
  }
  if (res.stderr.includes("REFUSED")) {
    throw new Error(`did not expect a refusal for a clean settings.json, got: ${res.stderr}`);
  }
});

Deno.test("backup with no settings.json at all still completes cleanly", async () => {
  const claudeDir = await Deno.makeTempDir({ prefix: "wjt-claude-fixture-" });
  await Deno.mkdir(`${claudeDir}/projects`, { recursive: true });
  await Deno.mkdir(`${claudeDir}/shared-memory`, { recursive: true });
  await Deno.writeTextFile(`${claudeDir}/CLAUDE.md`, "# fixture\n");
  const dstDir = await Deno.makeTempDir({ prefix: "wjt-dropbox-fixture-" });

  const res = await runBackup(claudeDir, dstDir);
  assertEquals(res.code, 0, res.stderr);
  if (await pathExists(`${dstDir}/claude-config/settings.json`)) {
    throw new Error("settings.json should not exist when there was no source file");
  }
});
