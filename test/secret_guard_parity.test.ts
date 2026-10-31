import { assertEquals, assertStringIncludes } from "@std/assert";

const hooks = new URL("../hooks/", import.meta.url);
const surfaces = ["claude", "agy", "codex"] as const;
type Surface = typeof surfaces[number];

// Literal rows from the hooks design, "The same refusals on each tool".
// These are payload data only. No shell ever executes the supplied command.
const refusals: Array<[string, string]> = [
  ["ps aux", "block-secret-dumps"],
  ["ps -ef", "block-secret-dumps"],
  ["set", "block-secret-dumps"],
  ["export -p", "block-secret-dumps"],
  ["declare -x", "block-secret-dumps"],
  ["cat /proc/self/environ", "block-secret-dumps"],
  ["docker inspect 3f2a", "block-secret-dumps"],
  ["pgrep -fa github", "block-secret-dumps"],
  ["gh auth token", "block-irreversible-operations"],
  ["env", "block-secret-dumps"],
  ["echo $GH_TOKEN", "block-secret-dumps"],
  ["printenv GH_TOKEN", "block-secret-dumps"],
];

async function runGuard(surface: Surface, guard: string, command: string) {
  const target = new URL(`${guard}.sh`, hooks).pathname;
  const payload = surface === "agy"
    ? { toolCall: { name: "run_command", args: { CommandLine: command } } }
    : { tool_name: "Bash", tool_input: { command } };
  const child = new Deno.Command("bash", {
    args: surface === "agy"
      ? [new URL("agy-hook-shim.sh", hooks).pathname, "PreToolUse", btoa("Bash"), target]
      : [target],
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      AGY_HOOK_RECORD_PATH: "off",
      ...(surface === "codex" ? { WJT_SURFACE: "codex" } : {}),
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
  await writer.close();
  const result = await child.output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function assertDecision(
  surface: Surface,
  result: Awaited<ReturnType<typeof runGuard>>,
  blocked: boolean,
  guard: string,
) {
  let reason = result.stderr;
  if (surface === "agy") {
    // agy's hook protocol returns exit 0 with a native JSON denial.
    assertEquals(result.code, 0, result.stderr);
    const reply = JSON.parse(result.stdout);
    assertEquals(reply.decision, blocked ? "deny" : "allow");
    reason = reply.reason ?? "";
  } else {
    assertEquals(result.code, blocked ? 2 : 0, result.stderr);
    assertEquals(result.stdout, "");
  }
  if (blocked) {
    const name = guard === "block-secret-dumps" ? "secret-dump" : "irreversible operation";
    // A runner crash or missing Deno must not masquerade as the intended refusal.
    assertStringIncludes(reason, `BLOCKED (${name} guard)`);
  }
}

for (const surface of surfaces) {
  Deno.test(`secret guard design refusals through ${surface}`, async (t) => {
    for (const [command, guard] of refusals) {
      await t.step(command, async () => {
        assertDecision(surface, await runGuard(surface, guard, command), true, guard);
      });
    }
  });

  Deno.test(`secret guard safe controls through ${surface}`, async (t) => {
    for (
      const [command, guard] of [
        ["printenv PATH HOME", "block-secret-dumps"],
        ["true", "block-irreversible-operations"],
      ]
    ) {
      await t.step(command, async () => {
        assertDecision(surface, await runGuard(surface, guard, command), false, guard);
      });
    }
  });

  Deno.test(`harmless fake-token probe through ${surface}`, async () => {
    const guard = "block-secret-dumps";
    assertDecision(
      surface,
      await runGuard(surface, guard, "printenv PROBE_FAKE_TOKEN"),
      true,
      guard,
    );
  });
}
