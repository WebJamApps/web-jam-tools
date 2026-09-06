// test/prune_permission_allows_on_session_end_hook.test.ts — web-jam-tools#818
//
// Exercises hooks/prune-permission-allows-on-session-end.sh:
// 1. Clean / absent state: exits 0 with no error when files are clean or absent.
// 2. Offender pruning: removes offending non-trailing wildcard rules, preserves safe rules byte-identical.
// 3. Backup creation: writes .bak-<stamp> backup file upon pruning.
// 4. Invalid JSON resilience: exits 0 safely without failing session exit.
// 5. Stdin safety: handles piped stdin payload safely without error.
// 6. Direct execution / CLI arguments: passes through custom --target-file args.
// 7. Backup rotation (web-jam-tools#934): keeps only the newest PRUNE_BACKUP_RETAIN
//    (default 10) ".bak-*" siblings per target, deletes older ones, leaves
//    non-".bak-" siblings and the target itself untouched, and honors a
//    smaller PRUNE_BACKUP_RETAIN override.

import { assert, assertEquals } from "@std/assert";
import * as path from "jsr:@std/path@^1.0.0";

const REPO_ROOT = path.resolve(
  path.dirname(path.fromFileUrl(import.meta.url)),
  "..",
);
const HOOK_SCRIPT = path.join(
  REPO_ROOT,
  "hooks/prune-permission-allows-on-session-end.sh",
);

interface Sandbox {
  dir: string;
  homeDir: string;
  settingsPath: string;
  cleanup: () => Promise<void>;
}

async function createSandbox(): Promise<Sandbox> {
  const dir = await Deno.makeTempDir({ prefix: "session_end_prune_test_" });
  const homeDir = path.join(dir, "home");
  const settingsPath = path.join(homeDir, ".claude/settings.local.json");

  await Deno.mkdir(path.dirname(settingsPath), { recursive: true });

  return {
    dir,
    homeDir,
    settingsPath,
    cleanup: async () => {
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function runHookScript(
  args: string[] = [],
  env?: Record<string, string>,
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("bash", {
    args: [HOOK_SCRIPT, ...args],
    env: env ? { ...Deno.env.toObject(), ...env } : undefined,
    stdin: stdin !== undefined ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const out = await child.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

Deno.test("SessionEnd hook exits 0 when target files are absent", async () => {
  const sb = await createSandbox();
  try {
    const res = await runHookScript([], { HOME: sb.homeDir });
    assertEquals(res.code, 0, res.stderr);
  } finally {
    await sb.cleanup();
  }
});

Deno.test("SessionEnd hook exits 0 and leaves clean target file unmodified", async () => {
  const sb = await createSandbox();
  try {
    const initial = {
      permissions: {
        allow: ["Bash(git *)", "Read(//dev/pts/**)"],
      },
    };
    await Deno.writeTextFile(sb.settingsPath, JSON.stringify(initial, null, 2) + "\n");
    const res = await runHookScript([], { HOME: sb.homeDir });
    assertEquals(res.code, 0, res.stderr);

    const after = JSON.parse(await Deno.readTextFile(sb.settingsPath));
    assertEquals(after, initial);

    // Verify no backup was created
    const parent = path.dirname(sb.settingsPath);
    const files = [...Deno.readDirSync(parent)].map((e) => e.name);
    assert(files.every((f) => !f.includes(".bak-")), "no backup should be created for clean file");
  } finally {
    await sb.cleanup();
  }
});

Deno.test("SessionEnd hook prunes non-trailing wildcard offenders, preserves safe rules, and writes backup", async () => {
  const sb = await createSandbox();
  try {
    const offendingRule = "Bash(deno task --config * test)";
    const safeRule1 = "Bash(git *)";
    const safeRule2 = "Read(//dev/pts/**)";
    const initial = {
      permissions: {
        allow: [safeRule1, offendingRule, safeRule2],
      },
    };
    const initialContent = JSON.stringify(initial, null, 2) + "\n";
    await Deno.writeTextFile(sb.settingsPath, initialContent);

    const res = await runHookScript([], { HOME: sb.homeDir });
    assertEquals(res.code, 0, res.stderr);

    const afterRaw = await Deno.readTextFile(sb.settingsPath);
    const after = JSON.parse(afterRaw);
    assertEquals(after.permissions.allow, [safeRule1, safeRule2]);

    // Verify backup was created with original content
    const parent = path.dirname(sb.settingsPath);
    const backupFiles = [...Deno.readDirSync(parent)]
      .map((e) => e.name)
      .filter((f) => f.startsWith("settings.local.json.bak-"));
    assertEquals(backupFiles.length, 1);

    const backupContent = await Deno.readTextFile(path.join(parent, backupFiles[0]));
    assertEquals(backupContent, initialContent);
  } finally {
    await sb.cleanup();
  }
});

Deno.test("SessionEnd hook exits 0 safely when target file contains invalid JSON", async () => {
  const sb = await createSandbox();
  try {
    await Deno.writeTextFile(sb.settingsPath, "{ invalid json content: [");
    const res = await runHookScript([], { HOME: sb.homeDir });
    assertEquals(res.code, 0, "must exit 0 even on corrupted JSON so teardown never fails");
  } finally {
    await sb.cleanup();
  }
});

Deno.test("SessionEnd hook exits 0 safely when payload is piped on stdin", async () => {
  const sb = await createSandbox();
  try {
    const res = await runHookScript([], { HOME: sb.homeDir }, '{"event":"SessionEnd"}');
    assertEquals(res.code, 0, res.stderr);
  } finally {
    await sb.cleanup();
  }
});

// Creates `count` fake ".bak-<stamp>" siblings for `targetPath`, each with a
// distinct mtime strictly before "now" (index 0 is oldest). The stamp itself
// is a fixed placeholder — only the mtime governs rotation order — so the
// stamps never collide with the real hook run's own generateTimestamp() output.
async function createDummyBackups(
  targetPath: string,
  count: number,
): Promise<string[]> {
  const created: string[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const stamp = `19990101-${String(i).padStart(6, "0")}`;
    const p = `${targetPath}.bak-${stamp}`;
    await Deno.writeTextFile(p, `dummy-backup-${i}`);
    // 1 minute apart, oldest (i=0) furthest in the past.
    const mtime = new Date(now - (count - i) * 60_000);
    await Deno.utime(p, mtime, mtime);
    created.push(p);
  }
  return created;
}

function listBakSiblings(settingsPath: string): string[] {
  const parent = path.dirname(settingsPath);
  const base = path.basename(settingsPath);
  return [...Deno.readDirSync(parent)]
    .map((e) => e.name)
    .filter((f) => f.startsWith(`${base}.bak-`))
    .sort();
}

Deno.test("SessionEnd hook rotation: keeps only the newest 10 backups by default, deletes the rest, keeps the run's own new backup, and leaves non-.bak- siblings untouched", async () => {
  const sb = await createSandbox();
  try {
    const dummies = await createDummyBackups(sb.settingsPath, 13);

    const decoyPath = `${sb.settingsPath}.other`;
    await Deno.writeTextFile(decoyPath, "not a backup, leave me alone");

    const offendingRule = "Bash(deno task --config * test)";
    const initial = { permissions: { allow: [offendingRule, "Bash(git *)"] } };
    await Deno.writeTextFile(sb.settingsPath, JSON.stringify(initial, null, 2) + "\n");

    const res = await runHookScript([], { HOME: sb.homeDir });
    assertEquals(res.code, 0, res.stderr);

    const survivors = listBakSiblings(sb.settingsPath);
    assertEquals(survivors.length, 10, `expected 10 survivors, got: ${survivors.join(", ")}`);

    // Oldest 4 dummies (13 dummies + 1 fresh backup = 14, minus 10 kept = 4 deleted).
    for (let i = 0; i < 4; i++) {
      const name = path.basename(dummies[i]);
      assert(!survivors.includes(name), `oldest dummy backup should be deleted: ${name}`);
    }
    // Newest 9 dummies survive.
    for (let i = 4; i < 13; i++) {
      const name = path.basename(dummies[i]);
      assert(survivors.includes(name), `newer dummy backup should survive: ${name}`);
    }

    // The backup this run itself created is among the survivors.
    const freshBackups = survivors.filter((f) => !f.includes("19990101-"));
    assertEquals(freshBackups.length, 1, "exactly one fresh backup from this run");

    // Non-.bak- sibling is untouched.
    const decoyStillPresent = await Deno.readTextFile(decoyPath);
    assertEquals(decoyStillPresent, "not a backup, leave me alone");

    // Target file itself is untouched by rotation.
    assert((await Deno.stat(sb.settingsPath)).isFile);
  } finally {
    await sb.cleanup();
  }
});

Deno.test("SessionEnd hook rotation: honors a smaller PRUNE_BACKUP_RETAIN override", async () => {
  const sb = await createSandbox();
  try {
    const dummies = await createDummyBackups(sb.settingsPath, 5);

    // Clean target file: this run creates no new backup, isolating the
    // override's effect on the pre-existing backups.
    const clean = { permissions: { allow: ["Bash(git *)"] } };
    await Deno.writeTextFile(sb.settingsPath, JSON.stringify(clean, null, 2) + "\n");

    const res = await runHookScript([], { HOME: sb.homeDir, PRUNE_BACKUP_RETAIN: "3" });
    assertEquals(res.code, 0, res.stderr);

    const survivors = listBakSiblings(sb.settingsPath);
    assertEquals(survivors.length, 3, `expected 3 survivors, got: ${survivors.join(", ")}`);

    for (let i = 0; i < 2; i++) {
      assert(!survivors.includes(path.basename(dummies[i])), "oldest backups should be deleted");
    }
    for (let i = 2; i < 5; i++) {
      assert(survivors.includes(path.basename(dummies[i])), "newest backups should survive");
    }
  } finally {
    await sb.cleanup();
  }
});

Deno.test("SessionEnd hook rotation: an invalid PRUNE_BACKUP_RETAIN falls back to the default of 10", async () => {
  const sb = await createSandbox();
  try {
    await createDummyBackups(sb.settingsPath, 12);

    const clean = { permissions: { allow: ["Bash(git *)"] } };
    await Deno.writeTextFile(sb.settingsPath, JSON.stringify(clean, null, 2) + "\n");

    const res = await runHookScript([], { HOME: sb.homeDir, PRUNE_BACKUP_RETAIN: "not-a-number" });
    assertEquals(res.code, 0, res.stderr);

    const survivors = listBakSiblings(sb.settingsPath);
    assertEquals(
      survivors.length,
      10,
      `expected fallback to default 10, got: ${survivors.join(", ")}`,
    );
  } finally {
    await sb.cleanup();
  }
});

Deno.test("SessionEnd hook rotation: fewer than the retain count leaves every backup untouched", async () => {
  const sb = await createSandbox();
  try {
    const dummies = await createDummyBackups(sb.settingsPath, 2);

    const clean = { permissions: { allow: ["Bash(git *)"] } };
    await Deno.writeTextFile(sb.settingsPath, JSON.stringify(clean, null, 2) + "\n");

    const res = await runHookScript([], { HOME: sb.homeDir });
    assertEquals(res.code, 0, res.stderr);

    const survivors = listBakSiblings(sb.settingsPath);
    assertEquals(survivors.length, 2);
    for (const d of dummies) {
      assert(survivors.includes(path.basename(d)), `backup should survive untouched: ${d}`);
    }
  } finally {
    await sb.cleanup();
  }
});

Deno.test("SessionEnd hook accepts explicit --target-file argument", async () => {
  const sb = await createSandbox();
  try {
    const customFile = path.join(sb.dir, "custom_settings.json");
    const offending = "Bash(echo * | cat)";
    const safe = "Bash(ls *)";
    await Deno.writeTextFile(
      customFile,
      JSON.stringify({ permissions: { allow: [offending, safe] } }, null, 2) + "\n",
    );

    const res = await runHookScript(["--target-file", customFile]);
    assertEquals(res.code, 0, res.stderr);

    const after = JSON.parse(await Deno.readTextFile(customFile));
    assertEquals(after.permissions.allow, [safe]);
  } finally {
    await sb.cleanup();
  }
});
