// block_agy_gmail_send_delete_hook.test.ts — web-jam-tools#432 scope item 3
//
// hooks/block-agy-gmail-send-delete.sh unconditionally denies once it runs —
// the matcher (enforced by hooks/agy-hook-shim.sh, since agy ignores its own
// matcher field) is what scopes it to send_email/delete_email/
// batch_delete_emails. Both layers are exercised here: the hook alone
// (always denies, any input), and end-to-end through the shim with the
// installer's real matcher pattern, proving read/label/archive tools are
// unaffected while the three write verbs are denied.

import { assert, assertEquals } from "@std/assert";

const HOOK_PATH = new URL("../hooks/block-agy-gmail-send-delete.sh", import.meta.url).pathname;
const SHIM_PATH = new URL("../hooks/agy-hook-shim.sh", import.meta.url).pathname;

// Matches the matcher registered in scripts/install-hooks.sh's
// AGY_ONLY_PRE_TOOL_USE_HOOKS for this hook.
const SEND_DELETE_MATCHER = "send_email|delete_email|batch_delete_emails";

async function runDirect(): Promise<{ code: number; stderr: string }> {
  const cmd = new Deno.Command("bash", {
    args: [HOOK_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify({ anything: "at all" })));
  await writer.close();
  const { code, stderr } = await child.output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

async function runViaShim(toolName: string): Promise<{ decision: string }> {
  const matcherB64 = btoa(SEND_DELETE_MATCHER);
  const cmd = new Deno.Command("bash", {
    args: [SHIM_PATH, "PreToolUse", matcherB64, HOOK_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: {
      ...Deno.env.toObject(),
      AGY_HOOK_RECORD_PATH: "off",
    },
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(JSON.stringify({ toolCall: { name: toolName, args: {} } })),
  );
  await writer.close();
  const { stdout } = await child.output();
  return JSON.parse(new TextDecoder().decode(stdout).trim());
}

Deno.test("block-agy-gmail-send-delete.sh always denies (matcher-scoped, not payload-dependent)", async () => {
  const res = await runDirect();
  assertEquals(res.code, 2);
  assert(res.stderr.includes("BLOCKED (agy gmail send/delete fence)"), res.stderr);
});

for (const verb of ["send_email", "delete_email", "batch_delete_emails"]) {
  Deno.test(`send/delete fence: ${verb} is denied on the agy surface`, async () => {
    const verdict = await runViaShim(verb);
    assertEquals(verdict.decision, "deny");
  });
}

for (const verb of ["search_emails", "read_email", "list_email_labels", "modify_email"]) {
  Deno.test(`send/delete fence: ${verb} (read/label/archive) is NOT matched, allowed`, async () => {
    const verdict = await runViaShim(verb);
    assertEquals(verdict.decision, "allow");
  });
}
