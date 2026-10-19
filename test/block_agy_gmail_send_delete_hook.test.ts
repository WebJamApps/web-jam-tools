// Isolated shell, shim and installer proofs; never invokes a Gmail server.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runShim } from "../hooks/lib/agy_hook_shim.ts";
import {
  GMAIL_FENCE_CASES,
  GMAIL_SCHEMA_INPUTS,
  IRREVERSIBLE_GMAIL_TOOLS,
} from "./support/gmail_fence_fixtures.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const HOOK_PATH = `${ROOT}hooks/block-agy-gmail-send-delete.sh`;
const installer = await Deno.readTextFile(`${ROOT}scripts/install-hooks.sh`);
const MATCHER = installer.match(/"([^"\n]+)::block-agy-gmail-send-delete\.sh"/)![1];

async function runShell(args: string[], input: string, env: Record<string, string> = {}) {
  const child = new Deno.Command("bash", {
    args,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: { AGY_HOOK_RECORD_PATH: "off", ...env },
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const result = await child.output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

Deno.test("Gmail fence: shell entry point classifies literal fixtures and denies unreadable input", async () => {
  for (const fixture of GMAIL_FENCE_CASES) {
    const result = await runShell(
      [HOOK_PATH],
      JSON.stringify({ tool_name: fixture.tool, tool_input: fixture.input }),
    );
    assertEquals(result.code, fixture.decision === "allow" ? 0 : 2, JSON.stringify(fixture));
    if (fixture.decision === "trash") assertStringIncludes(result.stderr, "prompt is unverified");
  }
  for (const input of ["", "{", "null", "[]", "{}"]) {
    assertEquals((await runShell([HOOK_PATH], input)).code, 2);
  }
});

for (const prefix of ["", "mcp__gmail__"]) {
  Deno.test(`Gmail fence: shim preserves raw/prefixed safety arguments (${prefix || "raw"})`, async () => {
    for (const fixture of GMAIL_FENCE_CASES) {
      const verdict = await runShim(
        "PreToolUse",
        MATCHER,
        HOOK_PATH,
        JSON.stringify({ toolCall: { name: prefix + fixture.tool, args: fixture.input } }),
      );
      assertEquals(
        verdict.decision,
        fixture.decision === "allow" ? "allow" : "deny",
        JSON.stringify(fixture),
      );
    }
  });
}

Deno.test("Gmail fence: malformed shim inputs refuse instead of normalizing to an empty object", async () => {
  for (
    const raw of [
      "",
      "{",
      "null",
      "[]",
      "{}",
      '{"toolCall":{"name":1}}',
      '{"toolCall":{"name":"modify_email"}}',
      '{"toolCall":{"name":"modify_email","args":[]}}',
    ]
  ) {
    assertEquals((await runShim("PreToolUse", MATCHER, HOOK_PATH, raw)).decision, "deny");
  }
  for (const name of ["run_command", "mcp__other__delete_label", "mcp__gmail_extra__send_email"]) {
    assertEquals(
      (await runShim(
        "PreToolUse",
        MATCHER,
        HOOK_PATH,
        JSON.stringify({ toolCall: { name, args: {} } }),
      )).decision,
      "allow",
    );
  }
  assertEquals(
    (await runShim(
      "PreToolUse",
      MATCHER,
      HOOK_PATH,
      JSON.stringify({ toolCall: { name: "mcp__gmail__unknown", args: {} } }),
    )).decision,
    "deny",
  );
});

Deno.test("Gmail fence: missing, crashing and empty classifiers fail closed through installed symlinks", async () => {
  const sandbox = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${sandbox}/hooks/lib`, { recursive: true });
    const hook = `${sandbox}/hooks/block-agy-gmail-send-delete.sh`;
    await Deno.copyFile(HOOK_PATH, hook);
    await Deno.symlink(hook, `${sandbox}/installed.sh`);
    for (
      const source of [
        undefined,
        'throw new Error("fixture failure");',
        "Deno.exit(0);",
        'console.log("invalid");',
      ]
    ) {
      if (source !== undefined) {
        await Deno.writeTextFile(`${sandbox}/hooks/lib/check_gmail_write.ts`, source);
      }
      const result = await runShell(
        [`${sandbox}/installed.sh`],
        JSON.stringify({ tool_name: "list_email_labels", tool_input: {} }),
      );
      assertEquals(result.code, 2);
    }
  } finally {
    await Deno.remove(sandbox, { recursive: true });
  }
});

Deno.test("Gmail fence: probe recording retains identity without arguments or mailbox contents", async () => {
  const sandbox = await Deno.makeTempDir();
  try {
    const path = `${sandbox}/probe.jsonl`;
    await runShim(
      "PreToolUse",
      MATCHER,
      HOOK_PATH,
      JSON.stringify({
        toolCall: {
          name: "draft_email",
          args: { to: [], subject: "private-fixture-subject", body: "private-fixture-body" },
        },
      }),
      path,
    );
    const record = await Deno.readTextFile(path);
    assertStringIncludes(record, "draft_email");
    assert(!record.includes("private-fixture"));
    assert(!record.includes("rawInput"));
    assert(!record.includes('"args"'));
  } finally {
    await Deno.remove(sandbox, { recursive: true });
  }
});

Deno.test("Gmail fence: scripts/install-hooks.sh installs only the agy adapter and its matcher executes through the shim", async () => {
  const home = await Deno.makeTempDir();
  try {
    const hooksDir = `${home}/.claude/hooks`;
    const settingsPath = `${home}/.claude/settings.json`;
    const result = await runShell(
      [
        `${ROOT}scripts/install-hooks.sh`,
        "--hooks-dir",
        hooksDir,
        "--settings-path",
        settingsPath,
        "--agy-hooks-path",
        `${home}/.claude/hooks.json`,
        "--agy-settings-path",
        `${home}/agy-settings.json`,
        "--codex-hooks-path",
        `${home}/codex-hooks.json`,
        "--agents-md-path",
        `${home}/agents/AGENTS.md`,
        "--agy-safety-rules-path",
        `${home}/agy/AGENTS.md`,
        "--codex-safety-rules-path",
        `${home}/codex/AGENTS.md`,
        "--bin-dir",
        `${home}/bin`,
      ],
      "",
      {
        HOME: home,
        CODEX_HOME: "",
        CODEX_HOOKS_PATH: "",
        PATH: `${Deno.execPath().slice(0, Deno.execPath().lastIndexOf("/"))}:/usr/bin:/bin`,
      },
    );
    assertEquals(result.code, 0, result.stdout + result.stderr);
    const settings = JSON.parse(await Deno.readTextFile(settingsPath));
    const hooks = JSON.parse(await Deno.readTextFile(`${home}/.claude/hooks.json`));
    const claudeCommands: string[] = settings.hooks.PreToolUse.flatMap((
      entry: { hooks: Array<{ command: string }> },
    ) => entry.hooks.map((h) => h.command));
    assert(claudeCommands.every((command) => !command.includes("block-agy-gmail-send-delete.sh")));
    const entry = hooks.hooks.PreToolUse.find((entry: { hooks: Array<{ command: string }> }) =>
      entry.hooks.some((h) => h.command.includes("block-agy-gmail-send-delete.sh"))
    );
    assert(entry);
    assertEquals(entry.matcher, ".*");
    const command: string = entry.hooks.find((hook: { command: string }) =>
      hook.command.includes("block-agy-gmail-send-delete.sh")
    ).command;
    assertStringIncludes(command, "$HOME/.claude/hooks/agy-hook-shim.sh PreToolUse");
    assertStringIncludes(command, "$HOME/.claude/hooks/block-agy-gmail-send-delete.sh");
    assertStringIncludes(command, btoa(MATCHER));
    assertEquals(await Deno.realPath(`${hooksDir}/block-agy-gmail-send-delete.sh`), HOOK_PATH);
    // No invented installed lib directory: the shell resolves its own canonical symlink.
    await assertMissing(`${hooksDir}/lib`);
    for (const [name, args] of Object.entries(GMAIL_SCHEMA_INPUTS)) {
      const call = await runShell(["-c", command], JSON.stringify({ toolCall: { name, args } }), {
        HOME: home,
      });
      assertEquals(call.code, 0, call.stderr);
      assertEquals(
        JSON.parse(call.stdout).decision,
        IRREVERSIBLE_GMAIL_TOOLS.includes(name) ? "deny" : "allow",
        name,
      );
    }
    const trash = await runShell(
      ["-c", command],
      JSON.stringify({
        toolCall: {
          name: "modify_email",
          args: { messageId: "design-probe-nonexistent", labelIds: ["TRASH"] },
        },
      }),
      { HOME: home },
    );
    assertEquals(JSON.parse(trash.stdout).decision, "deny");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

async function assertMissing(path: string) {
  let missing = false;
  try {
    await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) missing = true;
    else throw error;
  }
  assert(missing, `${path} must not exist`);
}
