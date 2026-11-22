import { assertEquals, assertStringIncludes } from "@std/assert";

const hook = new URL("../hooks/block-codex-gmail-write.sh", import.meta.url).pathname;

async function invokeHook(payload: string, path?: string) {
  const child = new Deno.Command(hook, {
    // A test PATH must reach the hook exactly as given. CircleCI's BASH_ENV re-exports PATH with
    // ~/.deno/bin first in every bash it starts, which would put the real deno ahead of a fake
    // one, so a call that sets PATH starts from an empty environment that has no BASH_ENV.
    clearEnv: path !== undefined,
    env: path === undefined
      ? { WJT_SURFACE: "codex" }
      : { WJT_SURFACE: "codex", PATH: path, HOME: Deno.env.get("HOME") ?? "" },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const input = child.stdin.getWriter();
  await input.write(new TextEncoder().encode(payload));
  await input.close();
  const { code, stdout, stderr } = await child.output();
  const decoder = new TextDecoder();
  return { code, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) };
}

function preToolUse(name: string, input: unknown): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: `mcp__codex_apps__gmail_${name}`,
    tool_input: input,
  });
}

Deno.test("Codex Gmail hook allows reads and denies sending or Trash on stderr with exit 2", async () => {
  assertEquals(await invokeHook(preToolUse("list_labels", {})), {
    code: 0,
    stdout: "",
    stderr: "",
  });

  for (const name of ["send_email", "send_draft", "forward_emails"]) {
    const sent = await invokeHook(preToolUse(name, {}));
    assertEquals(sent.code, 2);
    assertEquals(sent.stdout, "");
    assertStringIncludes(sent.stderr, "sending mail is prohibited");
  }

  for (
    const payload of [
      preToolUse("delete_emails", { message_ids: ["fixture-message"] }),
      preToolUse("batch_modify_email", { message_ids: ["fixture-message"], add_labels: ["TRASH"] }),
    ]
  ) {
    const trashed = await invokeHook(payload);
    assertEquals(trashed.code, 2);
    assertEquals(trashed.stdout, "");
    assertStringIncludes(trashed.stderr, "requires a verified permission prompt");
  }
});

Deno.test("Codex Gmail hook refuses malformed or missing payloads without printing input", async () => {
  for (
    const payload of [
      "",
      '{"body":"fixture text"',
      "null",
      "{}",
      preToolUse("batch_modify_email", { message_ids: ["fixture-message"], add_labels: "TRASH" }),
    ]
  ) {
    const refused = await invokeHook(payload);
    assertEquals(refused.code, 2);
    assertEquals(refused.stdout, "");
    assertStringIncludes(refused.stderr, "unclassifiable safety payload");
    assertEquals(refused.stderr.includes("fixture text"), false);
  }
});

Deno.test("Codex Gmail hook inherits the fail-closed safety runner fallback", async () => {
  const bin = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${bin}/deno`, "#!/bin/sh\nexit 70\n", { mode: 0o755 });
    const failure = await invokeHook(
      preToolUse("list_labels", {}),
      `${bin}:${Deno.env.get("PATH")}`,
    );
    assertEquals(failure.code, 2);
    assertEquals(failure.stdout, "");
    assertStringIncludes(failure.stderr, "safety guard could not run");
  } finally {
    await Deno.remove(bin, { recursive: true });
  }
});
