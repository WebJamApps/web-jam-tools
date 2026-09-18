// block_backend_mutation_hook.test.ts — web-jam-tools#1021
//
// Tests hooks/block-backend-mutation.sh and hooks/lib/check_backend_mutation.ts
// across both unit-level decision paths and end-to-end hook script invocations.

import { assert, assertEquals } from "@std/assert";
import { checkBackendMutation } from "../hooks/lib/check_backend_mutation.ts";

const SCRIPT_PATH = new URL(
  "../hooks/block-backend-mutation.sh",
  import.meta.url,
).pathname;

interface HookRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runHook(
  payload: Record<string, unknown> | string,
  tokenPath?: string,
  extraEnv?: Record<string, string>,
): Promise<HookRunResult> {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    ...extraEnv,
  };
  if (tokenPath) {
    env.BACKEND_APPROVAL_TOKEN_PATH = tokenPath;
  }

  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env,
  });

  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();

  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

async function withTempTokenFile(
  tokenData: Record<string, unknown> | string | null,
  fn: (tokenPath: string) => Promise<void> | void,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/backend-approval-token.json`;
  try {
    if (tokenData !== null) {
      const content = typeof tokenData === "string" ? tokenData : JSON.stringify(tokenData);
      await Deno.writeTextFile(tokenPath, content);
    }
    await fn(tokenPath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// --- 1. Unit tests for check_backend_mutation.ts ---

Deno.test("check_backend_mutation: deno task venue:create with --token is ALLOWED", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        'deno task venue:create --name "Test Venue" --address "123 Main St" --city "Salem" --state "VA" --token approved-test-token',
    },
  });
  const res = checkBackendMutation(payload);
  assert(res.startsWith("ALLOW:"), `Expected ALLOW, got: ${res}`);
});

Deno.test("check_backend_mutation: deno task venue:patch with --token=value is ALLOWED", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: "deno task venue:patch --id 123 --token=approved-test-token",
    },
  });
  const res = checkBackendMutation(payload);
  assert(res.startsWith("ALLOW:"), `Expected ALLOW, got: ${res}`);
});

Deno.test("check_backend_mutation: venue-mining:record-sweep is ALLOWED", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: "deno task venue-mining:record-sweep --metro roanoke --swept-at 2026-09-18",
    },
  });
  const res = checkBackendMutation(payload);
  assert(res.startsWith("ALLOW:"), `Expected ALLOW, got: ${res}`);
});

Deno.test("check_backend_mutation: deno task venue:create without --token and without token file is DENIED", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: 'deno task venue:create --name "Test Venue" --address "123 Main St"',
    },
  });
  const res = checkBackendMutation(payload, "/nonexistent/token.json");
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
});

Deno.test("check_backend_mutation: curl -X POST to production backend venue is DENIED without token", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: 'curl -X POST https://webjamsalem.herokuapp.com/venue -d \'{"name":"Test"}\'',
    },
  });
  const res = checkBackendMutation(payload, "/nonexistent/token.json");
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
  assert(res.includes("Unauthorized venue mutation"), res);
});

Deno.test("check_backend_mutation: curl -X PATCH to production backend venue is DENIED without token", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: 'curl -X PATCH https://webjamsalem.herokuapp.com/venue/123 -d \'{"name":"Test"}\'',
    },
  });
  const res = checkBackendMutation(payload, "/nonexistent/token.json");
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
});

Deno.test("check_backend_mutation: curl -X DELETE to production backend venue is DENIED without token", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: "curl -X DELETE https://webjamsalem.herokuapp.com/venue/123",
    },
  });
  const res = checkBackendMutation(payload, "/nonexistent/token.json");
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
});

Deno.test("check_backend_mutation: curl implicit POST (-d) to production backend is DENIED without token", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: 'curl https://webjamsalem.herokuapp.com/venue -d \'{"name":"Test"}\'',
    },
  });
  const res = checkBackendMutation(payload, "/nonexistent/token.json");
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
});

Deno.test("check_backend_mutation: curl -X POST https://webjamsalem.herokuapp.com/outreach/check-replies is DENIED", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: "curl -X POST https://webjamsalem.herokuapp.com/outreach/check-replies",
    },
  });
  const res = checkBackendMutation(payload);
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
  assert(res.includes("Direct outreach mutations against the production backend"), res);
});

Deno.test("check_backend_mutation: outreach during venue-mining task is BLOCKED citing web-jam-tools#208", () => {
  const payload = {
    tool_name: "Bash",
    cwd: "/home/joshua/WebJamApps/web-jam-tools/skills/venue-mining",
    tool_input: {
      command: "curl https://webjamsalem.herokuapp.com/outreach/preview",
    },
  };
  const res = checkBackendMutation(JSON.stringify(payload));
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
  assert(
    res.includes(
      'web-jam-tools#208 "venue-mining: require a mandatory street address for every venue create"',
    ),
    `Expected citation in reason, got: ${res}`,
  );
});

Deno.test("check_backend_mutation: deno task book-gig during venue-mining task is BLOCKED citing web-jam-tools#208", () => {
  Deno.env.set("ACTIVE_SKILL", "venue-mining");
  try {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: "deno task book-gig --send",
      },
    });
    const res = checkBackendMutation(payload);
    assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
    assert(
      res.includes(
        'web-jam-tools#208 "venue-mining: require a mandatory street address for every venue create"',
      ),
      `Expected citation in reason, got: ${res}`,
    );
  } finally {
    Deno.env.delete("ACTIVE_SKILL");
  }
});

Deno.test("check_backend_mutation: read-only queries (GET /venue) outside venue-mining PASS", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: "curl https://webjamsalem.herokuapp.com/venue",
    },
  });
  const res = checkBackendMutation(payload);
  assertEquals(res, "PASS");
});

Deno.test("check_backend_mutation: read-only query with GET flag PASS", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: "curl -X GET https://webjamsalem.herokuapp.com/venue/123",
    },
  });
  const res = checkBackendMutation(payload);
  assertEquals(res, "PASS");
});

Deno.test("check_backend_mutation: unrelated shell commands PASS", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: "git status && deno test test/manifest.test.ts",
    },
  });
  const res = checkBackendMutation(payload);
  assertEquals(res, "PASS");
});

Deno.test("check_backend_mutation: non-Bash tools PASS", () => {
  const payload = JSON.stringify({
    tool_name: "Edit",
    tool_input: {
      file_path: "/tmp/foo.txt",
    },
  });
  const res = checkBackendMutation(payload);
  assertEquals(res, "PASS");
});

Deno.test("check_backend_mutation: valid session approval token allows venue mutation", async () => {
  await withTempTokenFile(
    {
      session_id: "test-session-123",
      endpoints: ["/venue*"],
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    },
    (tokenPath) => {
      const payload = JSON.stringify({
        session_id: "test-session-123",
        tool_name: "Bash",
        tool_input: {
          command: 'curl -X POST https://webjamsalem.herokuapp.com/venue -d \'{"name":"Test"}\'',
        },
      });
      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("ALLOW:"), `Expected ALLOW, got: ${res}`);
    },
  );
});

Deno.test("check_backend_mutation: expired session approval token is DENIED", async () => {
  await withTempTokenFile(
    {
      session_id: "test-session-123",
      endpoints: ["/venue*"],
      expires_at: new Date(Date.now() - 3600_000).toISOString(),
    },
    (tokenPath) => {
      const payload = JSON.stringify({
        session_id: "test-session-123",
        tool_name: "Bash",
        tool_input: {
          command: 'curl -X POST https://webjamsalem.herokuapp.com/venue -d \'{"name":"Test"}\'',
        },
      });
      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
    },
  );
});

Deno.test("check_backend_mutation: token from different session is DENIED", async () => {
  await withTempTokenFile(
    {
      session_id: "different-session-456",
      endpoints: ["/venue*"],
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    },
    (tokenPath) => {
      const payload = JSON.stringify({
        session_id: "test-session-123",
        tool_name: "Bash",
        tool_input: {
          command: 'curl -X POST https://webjamsalem.herokuapp.com/venue -d \'{"name":"Test"}\'',
        },
      });
      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
      assert(res.includes("different session"), res);
    },
  );
});

Deno.test("check_backend_mutation: corrupt token file fails closed (DENIED)", async () => {
  await withTempTokenFile("not valid json {", (tokenPath) => {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: 'curl -X POST https://webjamsalem.herokuapp.com/venue -d \'{"name":"Test"}\'',
      },
    });
    const res = checkBackendMutation(payload, tokenPath);
    assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
  });
});

Deno.test("check_backend_mutation: indeterminate conditions fail closed (DENIED)", () => {
  // null tool_input
  const nullInput = JSON.stringify({ tool_name: "Bash", tool_input: null });
  assert(checkBackendMutation(nullInput).startsWith("DENY:"));

  // unparseable JSON
  assert(checkBackendMutation("invalid json {").startsWith("DENY:"));

  // unterminated quote on backend command
  const unterm = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: "curl -X POST https://webjamsalem.herokuapp.com/venue -d 'unterminated",
    },
  });
  assert(checkBackendMutation(unterm).startsWith("DENY:"));
});

Deno.test("check_backend_mutation: script evaluation with backend POST is DENIED", () => {
  const denoEval = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        'deno eval \'fetch("https://webjamsalem.herokuapp.com/venue", {method: "POST", body: "{}"})\'',
    },
  });
  assert(checkBackendMutation(denoEval).startsWith("DENY:"));

  const nodeEval = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: 'node -e \'fetch("https://webjamsalem.herokuapp.com/venue", {method: "POST"})\'',
    },
  });
  assert(checkBackendMutation(nodeEval).startsWith("DENY:"));

  const pyEval = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        "python3 -c 'import requests; requests.post(\"https://webjamsalem.herokuapp.com/venue\")'",
    },
  });
  assert(checkBackendMutation(pyEval).startsWith("DENY:"));
});

Deno.test("check_backend_mutation: commands resolved through wrappers are DENIED", () => {
  const wrapped = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        'sudo timeout 10 curl -X POST https://webjamsalem.herokuapp.com/venue -d \'{"name":"Test"}\'',
    },
  });
  assert(checkBackendMutation(wrapped).startsWith("DENY:"));

  const nested = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        'bash -c "curl -X POST https://webjamsalem.herokuapp.com/venue -d \\"{\\\\\\"name\\\\\\":\\\\\\"Test\\\\\\"}\\""',
    },
  });
  assert(checkBackendMutation(nested).startsWith("DENY:"));
});

// --- 2. End-to-end hook script tests (hooks/block-backend-mutation.sh) ---

Deno.test("hooks/block-backend-mutation.sh: ALLOWED invocation exits 0 with JSON allow", async () => {
  const payload = {
    tool_name: "Bash",
    tool_input: {
      command:
        'deno task venue:create --name "Test Venue" --address "123 Main St" --city "Salem" --state "VA" --token approved-test-token',
    },
  };
  const res = await runHook(payload);
  assertEquals(res.code, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assertEquals(parsed.hookSpecificOutput.permissionDecision, "allow");
});

Deno.test("hooks/block-backend-mutation.sh: DENIED invocation exits 2 with BLOCKED in stderr and JSON deny in stdout", async () => {
  const payload = {
    tool_name: "Bash",
    tool_input: {
      command: 'curl -X POST https://webjamsalem.herokuapp.com/venue -d \'{"name":"Test"}\'',
    },
  };
  const res = await runHook(payload, "/nonexistent/token.json");
  assertEquals(res.code, 2);
  assert(res.stderr.includes("BLOCKED (backend mutation guard):"), res.stderr);
  const parsed = JSON.parse(res.stdout);
  assertEquals(parsed.hookSpecificOutput.permissionDecision, "deny");
});

Deno.test("hooks/block-backend-mutation.sh: tool_input: null exits 2 failing closed", async () => {
  const payload = '{"tool_name":"Bash","tool_input":null}';
  const res = await runHook(payload);
  assertEquals(res.code, 2);
  assert(res.stderr.includes("BLOCKED (backend mutation guard):"), res.stderr);
});

Deno.test("hooks/block-backend-mutation.sh: empty stdin exits 2 failing closed", async () => {
  const res = await runHook("");
  assertEquals(res.code, 2);
  assert(res.stderr.includes("BLOCKED (backend mutation guard):"), res.stderr);
});

Deno.test("hooks/block-backend-mutation.sh: unrelated command exits 0 with empty output (PASS)", async () => {
  const payload = {
    tool_name: "Bash",
    tool_input: {
      command: "git status",
    },
  };
  const res = await runHook(payload);
  assertEquals(res.code, 0);
  assertEquals(res.stdout.trim(), "");
});
