// test/permission_wildcard_drift_reminder_hook.test.ts — web-jam-tools#784
//
// Exercises hooks/permission-wildcard-drift-reminder.sh and its helper
// hooks/lib/check_permission_wildcard_drift.ts:
// 1. Quiet case: target files absent or clean -> silent no-op.
// 2. Offender detection: catches non-trailing wildcard rules across multiple target files.
// 3. Trailing wildcards: rules like Bash(git *), Read(//dev/pts/**) survive and are not flagged.
// 4. Read-only immutability: never mutates settings.local.json files.
// 5. Bash execution: confirms hook script runs end-to-end and exits 0 in all states.

import { assert, assertEquals } from "@std/assert";
import * as path from "jsr:@std/path@^1.0.0";
import {
  checkFileForWildcardDrift,
  detectWildcardDrift,
  formatWildcardDriftMessage,
  getDefaultTargetFiles,
  isNonTrailingWildcardRule,
} from "../hooks/lib/check_permission_wildcard_drift.ts";

const REPO_ROOT = path.resolve(
  path.dirname(path.fromFileUrl(import.meta.url)),
  "..",
);
const HOOK_SCRIPT = path.join(
  REPO_ROOT,
  "hooks/permission-wildcard-drift-reminder.sh",
);

interface Sandbox {
  dir: string;
  homeDir: string;
  targetFiles: string[];
  cleanup: () => Promise<void>;
}

async function createSandbox(): Promise<Sandbox> {
  const dir = await Deno.makeTempDir({ prefix: "wildcard_drift_test_" });
  const homeDir = path.join(dir, "home");

  const targetFiles = [
    path.join(homeDir, ".claude/settings.local.json"),
    path.join(homeDir, "WebJamApps/JaMmusic/.claude/settings.local.json"),
    path.join(homeDir, "WebJamApps/WebJamSocketCluster/.claude/settings.local.json"),
    path.join(homeDir, "WebJamApps/web-jam-back/.claude/settings.local.json"),
  ];

  for (const f of targetFiles) {
    await Deno.mkdir(path.dirname(f), { recursive: true });
  }

  return {
    dir,
    homeDir,
    targetFiles,
    cleanup: async () => {
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function runHookScript(env: Record<string, string>): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const cmd = new Deno.Command("bash", {
    args: [HOOK_SCRIPT],
    env,
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

Deno.test("getDefaultTargetFiles returns 4 default paths under given home dir", () => {
  const files = getDefaultTargetFiles("/tmp/fakehome");
  assertEquals(files.length, 4);
  assertEquals(files[0], "/tmp/fakehome/.claude/settings.local.json");
  assertEquals(files[1], "/tmp/fakehome/WebJamApps/JaMmusic/.claude/settings.local.json");
  assertEquals(
    files[2],
    "/tmp/fakehome/WebJamApps/WebJamSocketCluster/.claude/settings.local.json",
  );
  assertEquals(files[3], "/tmp/fakehome/WebJamApps/web-jam-back/.claude/settings.local.json");
});

Deno.test("checkFileForWildcardDrift returns empty array for missing or clean file", async () => {
  const sb = await createSandbox();
  try {
    assertEquals(checkFileForWildcardDrift(sb.targetFiles[0]), []);

    const cleanContent = JSON.stringify({
      permissions: { allow: ["Bash(git *)"] },
    });
    await Deno.writeTextFile(sb.targetFiles[0], cleanContent);
    assertEquals(checkFileForWildcardDrift(sb.targetFiles[0]), []);
  } finally {
    await sb.cleanup();
  }
});

// --- Test 1: Quiet case (files absent or clean) ---

Deno.test("detectWildcardDrift returns empty result when target files are absent", async () => {
  const sb = await createSandbox();
  try {
    const result = detectWildcardDrift({
      homeDir: sb.homeDir,
      targetFiles: sb.targetFiles,
    });

    assertEquals(result.hasDrift, false);
    assertEquals(result.files, []);
    assertEquals(formatWildcardDriftMessage(result), "");
  } finally {
    await sb.cleanup();
  }
});

Deno.test("detectWildcardDrift returns empty result when target files have only safe rules", async () => {
  const sb = await createSandbox();
  try {
    const cleanContent = JSON.stringify({
      permissions: {
        allow: [
          "Bash(git status)",
          "Bash(git *)",
          "Bash(curl *)",
          "Read(//dev/pts/**)",
          "Bash(npm run *)",
        ],
      },
    });

    for (const f of sb.targetFiles) {
      await Deno.writeTextFile(f, cleanContent);
    }

    const result = detectWildcardDrift({
      homeDir: sb.homeDir,
      targetFiles: sb.targetFiles,
    });

    assertEquals(result.hasDrift, false);
    assertEquals(result.files, []);
    assertEquals(formatWildcardDriftMessage(result), "");
  } finally {
    await sb.cleanup();
  }
});

// --- Test 2: Offender detection ---

Deno.test("detectWildcardDrift catches non-trailing wildcard rules across target files", async () => {
  const sb = await createSandbox();
  try {
    const file1Content = JSON.stringify({
      permissions: {
        allow: [
          "Bash(git status)",
          'Bash(find . -maxdepth 1 -name "*.env*")',
          "Bash(git *)",
        ],
      },
    });

    const file2Content = JSON.stringify({
      permissions: {
        allow: [
          "Bash(shellcheck hooks/*.sh scripts/install-hooks.sh)",
          "Read(//dev/pts/**)",
        ],
      },
    });

    await Deno.writeTextFile(sb.targetFiles[0], file1Content);
    await Deno.writeTextFile(sb.targetFiles[1], file2Content);

    const result = detectWildcardDrift({
      homeDir: sb.homeDir,
      targetFiles: sb.targetFiles,
    });

    assertEquals(result.hasDrift, true);
    assertEquals(result.files.length, 2);
    assertEquals(result.files[0].filePath, sb.targetFiles[0]);
    assertEquals(result.files[0].offenders, [
      'Bash(find . -maxdepth 1 -name "*.env*")',
    ]);
    assertEquals(result.files[1].filePath, sb.targetFiles[1]);
    assertEquals(result.files[1].offenders, [
      "Bash(shellcheck hooks/*.sh scripts/install-hooks.sh)",
    ]);

    const msg = formatWildcardDriftMessage(result);
    assert(
      msg.includes(
        "WARNING: Over-broad permission allow rules with non-trailing wildcards detected:",
      ),
      msg,
    );
    assert(msg.includes('find . -maxdepth 1 -name "*.env*"'), msg);
    assert(msg.includes("shellcheck hooks/*.sh scripts/install-hooks.sh"), msg);
    assert(
      msg.includes(
        "Run 'scripts/prune-local-permission-allows.sh --apply' in ~/WebJamApps/web-jam-tools to prune them.",
      ),
      msg,
    );
  } finally {
    await sb.cleanup();
  }
});

// --- Test 3: Trailing wildcard rules survive ---

Deno.test("isNonTrailingWildcardRule correctly classifies trailing vs non-trailing wildcards", () => {
  assertEquals(isNonTrailingWildcardRule("Bash(git *)"), false);
  assertEquals(isNonTrailingWildcardRule("Bash(curl *)"), false);
  assertEquals(isNonTrailingWildcardRule("Read(//dev/pts/**)"), false);
  assertEquals(isNonTrailingWildcardRule('Bash(find . -maxdepth 1 -name "*.env*")'), true);
  assertEquals(isNonTrailingWildcardRule('Bash(find . -name "*.env*" *)'), true);
  assertEquals(
    isNonTrailingWildcardRule("Bash(shellcheck hooks/*.sh scripts/install-hooks.sh)"),
    true,
  );
  assertEquals(
    isNonTrailingWildcardRule("Bash(python3 -c \"...print('='*40); print(d['body'])\")"),
    true,
  );
  assertEquals(isNonTrailingWildcardRule("Bash(git status)"), false);
});

// --- Test 4: Read-only immutability ---

Deno.test("detectWildcardDrift is strictly read-only and leaves target files untouched", async () => {
  const sb = await createSandbox();
  try {
    const dirtyContent = JSON.stringify({
      permissions: {
        allow: [
          'Bash(find . -maxdepth 1 -name "*.env*")',
          "Bash(git *)",
        ],
      },
    });

    await Deno.writeTextFile(sb.targetFiles[0], dirtyContent);
    const statBefore = await Deno.stat(sb.targetFiles[0]);

    detectWildcardDrift({
      homeDir: sb.homeDir,
      targetFiles: sb.targetFiles,
    });
    detectWildcardDrift({
      homeDir: sb.homeDir,
      targetFiles: sb.targetFiles,
    });

    const statAfter = await Deno.stat(sb.targetFiles[0]);
    const contentAfter = await Deno.readTextFile(sb.targetFiles[0]);

    assertEquals(dirtyContent, contentAfter);
    assertEquals(statBefore.mtime?.getTime(), statAfter.mtime?.getTime());
  } finally {
    await sb.cleanup();
  }
});

// --- Test 5: Bash hook execution end-to-end ---

Deno.test("hooks/permission-wildcard-drift-reminder.sh executes end-to-end and exits 0 in all states", async () => {
  const sb = await createSandbox();
  try {
    // State 1: target files absent -> silent, exit 0
    const absentRes = await runHookScript({
      CLAUDE_HOME: sb.homeDir,
      HOME: sb.homeDir,
    });
    assertEquals(absentRes.code, 0, absentRes.stderr);
    assertEquals(absentRes.stdout.trim(), "");

    // State 2: target files clean -> silent, exit 0
    const cleanContent = JSON.stringify({
      permissions: {
        allow: ["Bash(git *)", "Read(//dev/pts/**)"],
      },
    });
    await Deno.writeTextFile(sb.targetFiles[0], cleanContent);

    const cleanRes = await runHookScript({
      CLAUDE_HOME: sb.homeDir,
      HOME: sb.homeDir,
    });
    assertEquals(cleanRes.code, 0, cleanRes.stderr);
    assertEquals(cleanRes.stdout.trim(), "");

    // State 3: target files dirty -> emits JSON systemMessage, exit 0
    const dirtyContent = JSON.stringify({
      permissions: {
        allow: [
          'Bash(find . -maxdepth 1 -name "*.env*")',
          "Bash(git *)",
        ],
      },
    });
    await Deno.writeTextFile(sb.targetFiles[0], dirtyContent);

    const dirtyRes = await runHookScript({
      CLAUDE_HOME: sb.homeDir,
      HOME: sb.homeDir,
    });
    assertEquals(dirtyRes.code, 0, dirtyRes.stderr);
    assert(dirtyRes.stdout.includes("systemMessage"), dirtyRes.stdout);

    const parsed = JSON.parse(dirtyRes.stdout);
    assert(typeof parsed.systemMessage === "string");
    assert(parsed.systemMessage.includes("WARNING: Over-broad permission allow rules"));
    assert(parsed.systemMessage.includes('find . -maxdepth 1 -name "*.env*"'));
  } finally {
    await sb.cleanup();
  }
});
