// scan_settings_for_secrets_script.test.ts — web-jam-tools#304
//
// Exercises scripts/scan-settings-for-secrets.sh end to end against fixture
// settings.json files (never Josh's real ~/.claude/settings.json), via
// --settings-path. This is the "catch anything that slipped through before
// the block-secret-literals.sh hook existed" layer — the actual discovery
// was a live Gemini API key sitting as permissions.allow rule #104 for ~2
// months, undetected.
//
// Every credential string below is SYNTHETIC, assembled at runtime via string
// concatenation so no complete credential-shaped literal sits in this file at
// rest.

import { assertEquals } from "@std/assert";

const SCRIPT_PATH = new URL("../scripts/scan-settings-for-secrets.sh", import.meta.url).pathname;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runScan(settingsPath: string): Promise<RunResult> {
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH, "--settings-path", settingsPath],
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

async function writeFixture(name: string, contents: unknown): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "wjt-settings-scan-" });
  const path = `${dir}/${name}`;
  await Deno.writeTextFile(path, JSON.stringify(contents));
  return path;
}

const FAKE_GOOGLE_KEY = "AIza" + "B".repeat(35);

Deno.test("a clean settings.json (no secrets) passes", async () => {
  const path = await writeFixture("settings.json", {
    permissions: { allow: ["Bash(ls -la)", "Bash(export FOO=$BAR)"] },
  });
  const res = await runScan(path);
  assertEquals(res.code, 0, res.stderr);
  if (!res.stdout.includes("no credential-shaped literals found")) {
    throw new Error(`expected a clean report, got: ${res.stdout}`);
  }
});

Deno.test("a settings.json with a credential-shaped literal in permissions.allow is detected", async () => {
  const path = await writeFixture("settings.json", {
    permissions: {
      allow: ["Bash(ls -la)", `Bash(export GEMINI_API_KEY="${FAKE_GOOGLE_KEY}")`],
    },
  });
  const res = await runScan(path);
  assertEquals(res.code, 1);
  if (!res.stderr.includes("CREDENTIAL-SHAPED LITERAL")) {
    throw new Error(`expected a loud report, got: ${res.stderr}`);
  }
  if (!res.stderr.includes("permissions.allow[1]")) {
    throw new Error(`expected the rule index to be named, got: ${res.stderr}`);
  }
  if (res.stderr.includes(FAKE_GOOGLE_KEY)) {
    throw new Error("the scanner echoed the secret value back into stderr");
  }
});

Deno.test("a credential-shaped literal in permissions.deny is also detected", async () => {
  const path = await writeFixture("settings.json", {
    permissions: {
      allow: [],
      deny: [`Bash(export GEMINI_API_KEY="${FAKE_GOOGLE_KEY}")`],
    },
  });
  const res = await runScan(path);
  assertEquals(res.code, 1);
  if (!res.stderr.includes("permissions.deny[0]")) {
    throw new Error(`expected the section+index to be named, got: ${res.stderr}`);
  }
});

Deno.test("a missing settings.json file is a no-op (exit 0)", async () => {
  const res = await runScan("/tmp/wjt-settings-scan-does-not-exist/settings.json");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("a settings.json with no permissions key at all passes", async () => {
  const path = await writeFixture("settings.json", { hooks: {} });
  const res = await runScan(path);
  assertEquals(res.code, 0, res.stderr);
});

// --- settings.local.json support (web-jam-tools#434) ---

Deno.test("a settings.local.json with a credential-shaped literal in permissions.allow is detected", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wjt-settings-local-scan-" });
  const settingsJson = `${dir}/settings.json`;
  const settingsLocalJson = `${dir}/settings.local.json`;
  await Deno.writeTextFile(
    settingsJson,
    JSON.stringify({ permissions: { allow: ["Bash(ls -la)"] } }),
  );
  await Deno.writeTextFile(
    settingsLocalJson,
    JSON.stringify({
      permissions: {
        allow: [`Bash(curl "https://circleci.com/api/output?token=${FAKE_GOOGLE_KEY}")`],
      },
    }),
  );

  const res = await runScan(settingsJson);
  assertEquals(res.code, 1);
  if (!res.stderr.includes("settings.local.json")) {
    throw new Error(`expected settings.local.json to be named in report, got: ${res.stderr}`);
  }
  if (!res.stderr.includes("permissions.allow[0]")) {
    throw new Error(`expected the rule index to be named, got: ${res.stderr}`);
  }
});

Deno.test("clean settings.json and settings.local.json pass silently", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wjt-settings-local-clean-" });
  const settingsJson = `${dir}/settings.json`;
  const settingsLocalJson = `${dir}/settings.local.json`;
  await Deno.writeTextFile(
    settingsJson,
    JSON.stringify({ permissions: { allow: ["Bash(ls -la)"] } }),
  );
  await Deno.writeTextFile(
    settingsLocalJson,
    JSON.stringify({ permissions: { allow: ["Bash(git status)"] } }),
  );

  const res = await runScan(settingsJson);
  assertEquals(res.code, 0, res.stderr);
});
