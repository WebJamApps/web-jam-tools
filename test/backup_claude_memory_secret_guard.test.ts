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
// rclone itself is NOT installed on the CircleCI test image, so the real
// binary is never invoked here — a stub `rclone` executable is put on PATH
// instead. The stub logs every invocation's subcommand + args (unit-separator
// delimited, one line per call) to a file this test controls, and always
// exits 0. Asserting against that log is *stronger* than asserting against
// real copied files: it proves the actual acceptance criterion from #304 —
// no rclone invocation ever targets settings.json when it holds a
// credential-shaped literal, while the other backup steps (CLAUDE.md,
// shared-memory sync, ...) still run — rather than only checking the
// script's own exit code.
//
// Every credential string is SYNTHETIC, assembled at runtime via string
// concatenation so no complete credential-shaped literal sits in this file
// at rest.

import { assert, assertEquals } from "@std/assert";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT_PATH = `${REPO_ROOT}scripts/backup-claude-memory.sh`;

const ARG_SEP = ""; // unit separator — safe even if a path contains a space

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  invocations: string[][]; // one entry per rclone call: [subcommand, ...args]
}

// Writes an executable `rclone` stub into binDir that appends every
// invocation ($1 = subcommand, rest = args) to logPath and always exits 0 —
// never touches the network or the real filesystem beyond that log.
async function installRcloneStub(binDir: string, logPath: string): Promise<void> {
  const stub = `#!/usr/bin/env bash
{
  printf '%s' "$1"
  shift
  for a in "$@"; do
    printf '${ARG_SEP}%s' "$a"
  done
  printf '\\n'
} >> "${logPath}"
exit 0
`;
  const stubPath = `${binDir}/rclone`;
  await Deno.writeTextFile(stubPath, stub);
  await Deno.chmod(stubPath, 0o755);
}

async function readInvocations(logPath: string): Promise<string[][]> {
  let content = "";
  try {
    content = await Deno.readTextFile(logPath);
  } catch {
    return []; // stub never ran (e.g. no calls at all) — treat as no invocations
  }
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(ARG_SEP));
}

async function runBackup(claudeDir: string, dstDir: string): Promise<RunResult> {
  const binDir = await Deno.makeTempDir({ prefix: "wjt-rclone-stub-bin-" });
  const logPath = `${binDir}/rclone-invocations.log`;
  await installRcloneStub(binDir, logPath);

  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    env: {
      ...Deno.env.toObject(),
      CLAUDE_DIR: claudeDir,
      BACKUP_DST_DIR: dstDir,
      PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  const invocations = await readInvocations(logPath);
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    invocations,
  };
}

async function setUpFixtureClaudeDir(settingsContents: unknown): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "wjt-claude-fixture-" });
  await Deno.mkdir(`${dir}/projects`, { recursive: true });
  await Deno.mkdir(`${dir}/shared-memory`, { recursive: true });
  await Deno.writeTextFile(`${dir}/CLAUDE.md`, "# fixture\n");
  await Deno.writeTextFile(`${dir}/settings.json`, JSON.stringify(settingsContents));
  return dir;
}

function hasInvocation(
  invocations: string[][],
  subcommand: string,
  mustIncludeArg: string,
): boolean {
  return invocations.some((inv) => inv[0] === subcommand && inv.includes(mustIncludeArg));
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

  if (hasInvocation(res.invocations, "copyto", `${claudeDir}/settings.json`)) {
    throw new Error(
      `rclone was invoked against settings.json despite it containing a credential-shaped literal: ${
        JSON.stringify(res.invocations)
      }`,
    );
  }
  if (!res.stderr.includes("REFUSED settings.json backup")) {
    throw new Error(`expected a REFUSED message on stderr, got: ${res.stderr}`);
  }
  if (res.stderr.includes(FAKE_GOOGLE_KEY)) {
    throw new Error("the backup script echoed the secret value back into stderr");
  }

  // Everything else in the backup still ran — the refusal is scoped to
  // settings.json only.
  if (!hasInvocation(res.invocations, "copyto", `${claudeDir}/CLAUDE.md`)) {
    throw new Error(
      `CLAUDE.md backup should still have run alongside the refusal, got: ${
        JSON.stringify(res.invocations)
      }`,
    );
  }
  if (!res.invocations.some((inv) => inv[0] === "sync")) {
    throw new Error(
      `shared-memory sync should still have run alongside the refusal, got: ${
        JSON.stringify(res.invocations)
      }`,
    );
  }
});

Deno.test("copies settings.json normally when it has no credential-shaped literal", async () => {
  const claudeDir = await setUpFixtureClaudeDir({
    permissions: { allow: ["Bash(ls -la)", "Bash(export FOO=$BAR)"] },
  });
  const dstDir = await Deno.makeTempDir({ prefix: "wjt-dropbox-fixture-" });

  const res = await runBackup(claudeDir, dstDir);
  assertEquals(res.code, 0, res.stderr);

  if (!hasInvocation(res.invocations, "copyto", `${claudeDir}/settings.json`)) {
    throw new Error(
      `expected an rclone copyto of settings.json (no credential literal present), got: ${
        JSON.stringify(res.invocations)
      }`,
    );
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

  if (res.invocations.some((inv) => inv.some((arg) => arg.includes("settings.json")))) {
    throw new Error(
      `no rclone invocation should reference settings.json when there was no source file, got: ${
        JSON.stringify(res.invocations)
      }`,
    );
  }
  if (!hasInvocation(res.invocations, "copyto", `${claudeDir}/CLAUDE.md`)) {
    throw new Error("CLAUDE.md backup should still have run");
  }
});

// --- Refusal state file & minimal PATH tests (web-jam-tools#456) ---

async function runBackupWithEnv(
  claudeDir: string,
  dstDir: string,
  envOverride: Record<string, string>,
): Promise<RunResult> {
  const binDir = await Deno.makeTempDir({ prefix: "wjt-rclone-stub-bin-" });
  const logPath = `${binDir}/rclone-invocations.log`;
  await installRcloneStub(binDir, logPath);

  const baseEnv = Deno.env.toObject();
  const pathEnv = envOverride.PATH
    ? `${binDir}:${envOverride.PATH}`
    : `${binDir}:${baseEnv.PATH ?? ""}`;

  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    env: {
      ...baseEnv,
      CLAUDE_DIR: claudeDir,
      BACKUP_DST_DIR: dstDir,
      ...envOverride,
      PATH: pathEnv,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  const invocations = await readInvocations(logPath);
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    invocations,
  };
}

Deno.test("creates SETTINGS_BACKUP_REFUSAL_FILE on refusal and deletes it on successful backup", async () => {
  const claudeDir = await setUpFixtureClaudeDir({
    permissions: {
      allow: ["Bash(ls -la)", `Bash(export GEMINI_API_KEY="${FAKE_GOOGLE_KEY}")`],
    },
  });
  const dstDir = await Deno.makeTempDir({ prefix: "wjt-dropbox-fixture-" });
  const refusalFile = `${claudeDir}/settings-backup-refusal.txt`;

  // 1. Secret present -> refusal file created
  const res1 = await runBackupWithEnv(claudeDir, dstDir, {
    SETTINGS_BACKUP_REFUSAL_FILE: refusalFile,
  });
  assertEquals(res1.code, 0, res1.stderr);
  const refusalText = await Deno.readTextFile(refusalFile);
  assert(refusalText.includes("REFUSED settings.json backup"), refusalText);

  // 2. Secret removed -> refusal file removed & settings.json backed up
  await Deno.writeTextFile(
    `${claudeDir}/settings.json`,
    JSON.stringify({ permissions: { allow: ["Bash(ls -la)"] } }),
  );
  const res2 = await runBackupWithEnv(claudeDir, dstDir, {
    SETTINGS_BACKUP_REFUSAL_FILE: refusalFile,
  });
  assertEquals(res2.code, 0, res2.stderr);
  let fileExists = true;
  try {
    await Deno.stat(refusalFile);
  } catch {
    fileExists = false;
  }
  assertEquals(fileExists, false, "refusal file should have been deleted after clean backup");
});

Deno.test("backup-claude-memory.sh succeeds under minimal cron PATH", async () => {
  const claudeDir = await setUpFixtureClaudeDir({
    permissions: { allow: ["Bash(ls -la)"] },
  });
  const dstDir = await Deno.makeTempDir({ prefix: "wjt-dropbox-fixture-" });
  const res = await runBackupWithEnv(claudeDir, dstDir, { PATH: "/usr/bin:/bin" });
  assertEquals(res.code, 0, res.stderr);
  assert(
    hasInvocation(res.invocations, "copyto", `${claudeDir}/settings.json`),
    "expected copyto of settings.json under minimal PATH",
  );
});
