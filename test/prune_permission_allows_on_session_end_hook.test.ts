// test/prune_permission_allows_on_session_end_hook.test.ts — web-jam-tools#818
//
// Exercises hooks/prune-permission-allows-on-session-end.sh:
// 1. Clean / absent state: exits 0 with no error when files are clean or absent.
// 2. Offender pruning: removes offending non-trailing wildcard rules, preserves safe rules byte-identical.
// 3. Backup creation: writes .bak-<stamp> backup file upon pruning.
// 4. Invalid JSON resilience: exits 0 safely without failing session exit.
// 5. Stdin safety: handles piped stdin payload safely without error.
// 6. Direct execution / CLI arguments: passes through custom --target-file args.

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
