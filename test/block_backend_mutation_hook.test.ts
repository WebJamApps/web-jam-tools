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

async function withTempScript(
  contents: string,
  extension: string,
  fn: (path: string) => Promise<void> | void,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/script.${extension}`;
  try {
    await Deno.writeTextFile(path, contents);
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const VALID_TOKEN_FILE = {
  session_id: "test-session-123",
  token: "expected-approved-token",
  endpoints: ["/venue*"],
};

function futureExpiry(): string {
  return new Date(Date.now() + 3600_000).toISOString();
}

function pastExpiry(): string {
  return new Date(Date.now() - 3600_000).toISOString();
}

// --- 1. FIX 1: token must MATCH the approval file, not merely be present ---

Deno.test("check_backend_mutation: curl bearer token with NO approval file is DENIED", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        'curl -X POST https://webjamsalem.herokuapp.com/venue -H "Authorization: Bearer arbitrary-throwaway-value" -d \'{"name":"Test"}\'',
    },
  });
  const res = checkBackendMutation(payload, "/nonexistent/token.json");
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
  assert(res.includes("No session approval token found"), res);
});

Deno.test("check_backend_mutation: curl DELETE with arbitrary bearer token is DENIED", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        'curl -X DELETE https://webjamsalem.herokuapp.com/venue/123 -H "Authorization: Bearer whatever"',
    },
  });
  const res = checkBackendMutation(payload, "/nonexistent/token.json");
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
});

Deno.test("check_backend_mutation: deno task venue:create --token bogus with NO approval file is DENIED", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: 'deno task venue:create --name "Test Venue" --address "123 Main St" --token bogus',
    },
  });
  const res = checkBackendMutation(payload, "/nonexistent/token.json");
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
});

Deno.test("check_backend_mutation: presented token MATCHING the approval file is ALLOWED", async () => {
  await withTempTokenFile(
    { ...VALID_TOKEN_FILE, expires_at: futureExpiry() },
    (tokenPath) => {
      const payload = JSON.stringify({
        session_id: "test-session-123",
        tool_name: "Bash",
        tool_input: {
          command:
            'curl -X POST https://webjamsalem.herokuapp.com/venue -H "Authorization: Bearer expected-approved-token" -d \'{"name":"Test"}\'',
        },
      });
      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("ALLOW:"), `Expected ALLOW, got: ${res}`);
    },
  );
});

Deno.test("check_backend_mutation: presented token that does NOT match the approval file is DENIED", async () => {
  await withTempTokenFile(
    { ...VALID_TOKEN_FILE, expires_at: futureExpiry() },
    (tokenPath) => {
      const payload = JSON.stringify({
        session_id: "test-session-123",
        tool_name: "Bash",
        tool_input: {
          command:
            'curl -X POST https://webjamsalem.herokuapp.com/venue -H "Authorization: Bearer wrong-value" -d \'{"name":"Test"}\'',
        },
      });
      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
      assert(res.includes("does not match the approval token file"), res);
    },
  );
});

Deno.test("check_backend_mutation: deno task venue:create --token matching approval file is ALLOWED", async () => {
  await withTempTokenFile(
    { ...VALID_TOKEN_FILE, expires_at: futureExpiry() },
    (tokenPath) => {
      const payload = JSON.stringify({
        session_id: "test-session-123",
        tool_name: "Bash",
        tool_input: {
          command:
            'deno task venue:create --name "Test Venue" --address "123 Main St" --token expected-approved-token',
        },
      });
      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("ALLOW:"), `Expected ALLOW, got: ${res}`);
    },
  );
});

Deno.test("check_backend_mutation: valid approval file with NO token presented still authorizes", async () => {
  await withTempTokenFile(
    { ...VALID_TOKEN_FILE, expires_at: futureExpiry() },
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

Deno.test("check_backend_mutation: expired approval file is DENIED even with matching presented token", async () => {
  await withTempTokenFile(
    { ...VALID_TOKEN_FILE, expires_at: pastExpiry() },
    (tokenPath) => {
      const payload = JSON.stringify({
        session_id: "test-session-123",
        tool_name: "Bash",
        tool_input: {
          command:
            'curl -X POST https://webjamsalem.herokuapp.com/venue -H "Authorization: Bearer expected-approved-token" -d \'{"name":"Test"}\'',
        },
      });
      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
      assert(res.includes("expired"), res);
    },
  );
});

Deno.test("check_backend_mutation: wrong-session approval file is DENIED even with matching presented token", async () => {
  await withTempTokenFile(
    { ...VALID_TOKEN_FILE, session_id: "different-session-456", expires_at: futureExpiry() },
    (tokenPath) => {
      const payload = JSON.stringify({
        session_id: "test-session-123",
        tool_name: "Bash",
        tool_input: {
          command:
            'curl -X POST https://webjamsalem.herokuapp.com/venue -H "Authorization: Bearer expected-approved-token" -d \'{"name":"Test"}\'',
        },
      });
      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
      assert(res.includes("different session"), res);
    },
  );
});

Deno.test("check_backend_mutation: endpoint not covered by approval file is DENIED", async () => {
  await withTempTokenFile(
    {
      session_id: "test-session-123",
      token: "expected-approved-token",
      endpoints: ["/outreach*"],
      expires_at: futureExpiry(),
    },
    (tokenPath) => {
      const payload = JSON.stringify({
        session_id: "test-session-123",
        tool_name: "Bash",
        tool_input: {
          command:
            'curl -X POST https://webjamsalem.herokuapp.com/venue -H "Authorization: Bearer expected-approved-token" -d \'{"name":"Test"}\'',
        },
      });
      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
      assert(res.includes("does not cover endpoint"), res);
    },
  );
});

Deno.test("check_backend_mutation: corrupt token file fails closed (DENIED) even with a presented token", async () => {
  await withTempTokenFile("not valid json {", (tokenPath) => {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command:
          'curl -X POST https://webjamsalem.herokuapp.com/venue -H "Authorization: Bearer whatever" -d \'{"name":"Test"}\'',
      },
    });
    const res = checkBackendMutation(payload, tokenPath);
    assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
  });
});

// --- 2. FIX 2: script FILES are inspected, not just inline eval code ---

Deno.test("check_backend_mutation: deno run <file> POSTing to backend is DENIED without approval", async () => {
  await withTempScript(
    'await fetch("https://webjamsalem.herokuapp.com/venue", {method: "POST", body: "{}"});',
    "ts",
    (path) => {
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: `deno run -A ${path}` },
      });
      const res = checkBackendMutation(payload, "/nonexistent/token.json");
      assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
    },
  );
});

Deno.test("check_backend_mutation: deno run <file> POSTing to backend is ALLOWED with a valid approval file", async () => {
  await withTempTokenFile(
    { session_id: "test-session-123", expires_at: futureExpiry() },
    async (tokenPath) => {
      await withTempScript(
        'await fetch("https://webjamsalem.herokuapp.com/venue", {method: "POST", body: "{}"});',
        "ts",
        (path) => {
          const payload = JSON.stringify({
            session_id: "test-session-123",
            tool_name: "Bash",
            tool_input: { command: `deno run -A ${path}` },
          });
          const res = checkBackendMutation(payload, tokenPath);
          assert(res.startsWith("ALLOW:"), `Expected ALLOW, got: ${res}`);
        },
      );
    },
  );
});

Deno.test("check_backend_mutation: node <file> POSTing to backend is DENIED", async () => {
  await withTempScript(
    'fetch("https://webjamsalem.herokuapp.com/venue", {method: "POST"});',
    "js",
    (path) => {
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: `node ${path}` },
      });
      const res = checkBackendMutation(payload, "/nonexistent/token.json");
      assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
    },
  );
});

Deno.test("check_backend_mutation: python3 <file> POSTing to backend is DENIED", async () => {
  await withTempScript(
    'import requests\nrequests.post("https://webjamsalem.herokuapp.com/venue")\n',
    "py",
    (path) => {
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: `python3 ${path}` },
      });
      const res = checkBackendMutation(payload, "/nonexistent/token.json");
      assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
    },
  );
});

Deno.test("check_backend_mutation: bash <file> curling a backend POST is DENIED", async () => {
  await withTempScript(
    'curl -X POST https://webjamsalem.herokuapp.com/venue -d \'{"name":"Test"}\'\n',
    "sh",
    (path) => {
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: `bash ${path}` },
      });
      const res = checkBackendMutation(payload, "/nonexistent/token.json");
      assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
    },
  );
});

Deno.test("check_backend_mutation: unreadable/missing script file PASSES rather than denying", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "deno run -A /tmp/does-not-exist-1021.ts" },
  });
  const res = checkBackendMutation(payload, "/nonexistent/token.json");
  assertEquals(res, "PASS");
});

// --- 3. FIX 3: venue-mining context is narrow and command-scoped only ---

Deno.test("check_backend_mutation: venue-mining context is NOT inferred from transcript_path content", async () => {
  const dir = await Deno.makeTempDir();
  const transcriptPath = `${dir}/transcript.jsonl`;
  try {
    await Deno.writeTextFile(
      transcriptPath,
      "let's look at skills/venue-mining/SKILL.md\n",
    );
    const payload = JSON.stringify({
      tool_name: "Bash",
      transcript_path: transcriptPath,
      tool_input: { command: "deno task book-gig 2026-10-10" },
    });
    const res = checkBackendMutation(payload);
    assertEquals(res, "PASS");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("check_backend_mutation: grep for /outreach substring outside real invocation PASSES even with a mention-only transcript", async () => {
  const dir = await Deno.makeTempDir();
  const transcriptPath = `${dir}/transcript.jsonl`;
  try {
    await Deno.writeTextFile(
      transcriptPath,
      "let's look at skills/venue-mining/SKILL.md\n",
    );
    const payload = JSON.stringify({
      tool_name: "Bash",
      transcript_path: transcriptPath,
      tool_input: { command: "grep -rn '/outreach' src/" },
    });
    const res = checkBackendMutation(payload);
    assertEquals(res, "PASS");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("check_backend_mutation: cat docs/book-gig.md PASSES even inside real venue-mining context", () => {
  Deno.env.set("ACTIVE_SKILL", "venue-mining");
  try {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "cat docs/book-gig.md" },
    });
    const res = checkBackendMutation(payload);
    assertEquals(res, "PASS");
  } finally {
    Deno.env.delete("ACTIVE_SKILL");
  }
});

Deno.test("check_backend_mutation: grep -rn '/outreach' src/ PASSES even inside real venue-mining context", () => {
  Deno.env.set("ACTIVE_SKILL", "venue-mining");
  try {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "grep -rn '/outreach' src/" },
    });
    const res = checkBackendMutation(payload);
    assertEquals(res, "PASS");
  } finally {
    Deno.env.delete("ACTIVE_SKILL");
  }
});

Deno.test("check_backend_mutation: deno task book-gig is DENIED when ACTIVE_SKILL=venue-mining, citing web-jam-tools#1021", () => {
  Deno.env.set("ACTIVE_SKILL", "venue-mining");
  try {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "deno task book-gig 2026-10-10" },
    });
    const res = checkBackendMutation(payload);
    assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
    assert(
      res.includes(
        'web-jam-tools#1021 "hooks/backend-guard: guard production backend mutations and enforce venue-mining skill boundaries"',
      ),
      `Expected citation in reason, got: ${res}`,
    );
  } finally {
    Deno.env.delete("ACTIVE_SKILL");
  }
});

Deno.test("check_backend_mutation: real outreach curl during venue-mining is BLOCKED citing web-jam-tools#1021", () => {
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
      'web-jam-tools#1021 "hooks/backend-guard: guard production backend mutations and enforce venue-mining skill boundaries"',
    ),
    `Expected citation in reason, got: ${res}`,
  );
});

Deno.test("check_backend_mutation: /venue-mining skill invocation as a command token is venue-mining context", () => {
  Deno.env.set("SKILL_NAME", "");
  try {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "deno task book-gig --send" },
    });
    // Not venue-mining context here (no /venue-mining token in THIS command) — sanity check PASS.
    assertEquals(checkBackendMutation(payload), "PASS");

    const payload2 = {
      tool_name: "Bash",
      tool_input: {
        command: "/venue-mining roanoke && deno task book-gig --send",
      },
    };
    const res2 = checkBackendMutation(JSON.stringify(payload2));
    assert(res2.startsWith("DENY:"), `Expected DENY, got: ${res2}`);
  } finally {
    Deno.env.delete("SKILL_NAME");
  }
});

// --- 4. FIX 4: sanctioned remediation names the approval-token file, not a nonexistent task ---

Deno.test("check_backend_mutation: deny reason for unauthorized venue mutation names the approval token file, not a fictional deno task", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: 'curl -X POST https://webjamsalem.herokuapp.com/venue -d \'{"name":"Test"}\'',
    },
  });
  const res = checkBackendMutation(payload, "/nonexistent/token.json");
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
  assert(res.includes("session approval token file"), res);
  assert(res.includes("approved by Josh"), res);
  assert(!res.includes("deno task venue:create"), res);
});

// --- 5. Pre-existing behaviors that must keep working ---

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

Deno.test("check_backend_mutation: inline script evaluation with backend POST is DENIED", () => {
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

Deno.test("check_backend_mutation: bare WEB_JAM_BACK_URL identifier alone is NOT treated as production host", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: "echo 'this script reads WEB_JAM_BACK_URL from the environment'",
    },
  });
  const res = checkBackendMutation(payload);
  assertEquals(res, "PASS");
});

Deno.test("check_backend_mutation: $WEB_JAM_BACK_URL expansion IS treated as production host", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: 'curl -X POST "$WEB_JAM_BACK_URL/venue" -d \'{"name":"Test"}\'',
    },
  });
  const res = checkBackendMutation(payload, "/nonexistent/token.json");
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
});

// --- 6. Coverage: remaining branches in loadBackendToken / checkSessionToken /
// parseCurl / script-file helpers / wrapper resolution / top-level payload
// validation that the tests above don't otherwise exercise. ---

Deno.test("check_backend_mutation: token path pointing at a directory fails closed (read error, not NotFound)", () => {
  const dir = Deno.makeTempDirSync();
  try {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: 'curl -X POST https://webjamsalem.herokuapp.com/venue -d \'{"name":"Test"}\'',
      },
    });
    const res = checkBackendMutation(payload, dir);
    assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
    assert(res.includes("Cannot read token file"), res);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("check_backend_mutation: token file that is valid JSON but not an object is corrupt (DENIED)", async () => {
  await withTempTokenFile("42", (tokenPath) => {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: 'curl -X POST https://webjamsalem.herokuapp.com/venue -d \'{"name":"Test"}\'',
      },
    });
    const res = checkBackendMutation(payload, tokenPath);
    assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
    assert(res.includes("is not a JSON object"), res);
  });
});

Deno.test("check_backend_mutation: token file missing expires_at is corrupt (DENIED)", async () => {
  await withTempTokenFile({ session_id: "x", token: "y" }, (tokenPath) => {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: 'curl -X POST https://webjamsalem.herokuapp.com/venue -d \'{"name":"Test"}\'',
      },
    });
    const res = checkBackendMutation(payload, tokenPath);
    assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
    assert(res.includes("lacks valid expires_at"), res);
  });
});

Deno.test("check_backend_mutation: unparseable expires_at timestamp is treated as expired (fails closed)", async () => {
  await withTempTokenFile(
    { session_id: "x", token: "y", expires_at: "not-a-real-date" },
    (tokenPath) => {
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: {
          command: 'curl -X POST https://webjamsalem.herokuapp.com/venue -d \'{"name":"Test"}\'',
        },
      });
      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
      assert(res.includes("expired"), res);
    },
  );
});

Deno.test("check_backend_mutation: exact (non-wildcard) endpoint pattern match ALLOWS", async () => {
  await withTempTokenFile(
    { session_id: "s1", token: "t1", endpoints: ["/venue/42"], expires_at: futureExpiry() },
    (tokenPath) => {
      const payload = JSON.stringify({
        session_id: "s1",
        tool_name: "Bash",
        tool_input: {
          command:
            "curl -X PATCH https://webjamsalem.herokuapp.com/venue/42 -H \"Authorization: Bearer t1\" -d '{}'",
        },
      });
      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("ALLOW:"), `Expected ALLOW, got: ${res}`);
    },
  );
});

Deno.test("check_backend_mutation: deno task venue:patch --token=value (attached form) matching approval file ALLOWS", async () => {
  await withTempTokenFile(
    { session_id: "s1", token: "attached-token", expires_at: futureExpiry() },
    (tokenPath) => {
      const payload = JSON.stringify({
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: "deno task venue:patch --id 123 --token=attached-token" },
      });
      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("ALLOW:"), `Expected ALLOW, got: ${res}`);
    },
  );
});

Deno.test("check_backend_mutation: deno task venue:create with NO --token flag and a valid approval file ALLOWS", async () => {
  await withTempTokenFile(
    { session_id: "s1", expires_at: futureExpiry() },
    (tokenPath) => {
      const payload = JSON.stringify({
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: 'deno task venue:create --name "Test Venue"' },
      });
      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("ALLOW:"), `Expected ALLOW, got: ${res}`);
      assert(res.includes("with active session approval token"), res);
    },
  );
});

Deno.test("check_backend_mutation: a leading VAR=value assignment prefix is skipped to find the real command", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "METRO=roanoke deno task venue-mining:record-sweep --metro roanoke" },
  });
  const res = checkBackendMutation(payload);
  assert(res.startsWith("ALLOW:"), `Expected ALLOW, got: ${res}`);
});

Deno.test("check_backend_mutation: deno run against a directory path (not a file) PASSES", () => {
  const dir = Deno.makeTempDirSync();
  try {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: `deno run -A ${dir}` },
    });
    const res = checkBackendMutation(payload, "/nonexistent/token.json");
    assertEquals(res, "PASS");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("check_backend_mutation: deno run with only flags and no script positional PASSES", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "deno run -A --unstable-temporal" },
  });
  const res = checkBackendMutation(payload);
  assertEquals(res, "PASS");
});

Deno.test("check_backend_mutation: script file mentioning the backend but not mutating it PASSES", async () => {
  await withTempScript(
    'const res = await fetch("https://webjamsalem.herokuapp.com/venue");\nconsole.log(await res.json());\n',
    "ts",
    (path) => {
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: `deno run -A ${path}` },
      });
      const res = checkBackendMutation(payload);
      assertEquals(res, "PASS");
    },
  );
});

Deno.test("check_backend_mutation: script file with no backend mention at all PASSES", async () => {
  await withTempScript("console.log('hello world');\n", "js", (path) => {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: `node ${path}` },
    });
    const res = checkBackendMutation(payload);
    assertEquals(res, "PASS");
  });
});

Deno.test("check_backend_mutation: script file hitting an outreach endpoint outside venue-mining is DENIED (direct outreach)", async () => {
  await withTempScript(
    'await fetch("https://webjamsalem.herokuapp.com/outreach/send", {method: "POST"});\n',
    "ts",
    (path) => {
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: `deno run -A ${path}` },
      });
      const res = checkBackendMutation(payload);
      assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
      assert(res.includes("Direct outreach mutations against the production backend"), res);
    },
  );
});

Deno.test("check_backend_mutation: script file hitting an outreach endpoint during venue-mining is DENIED (skill boundary)", async () => {
  Deno.env.set("ACTIVE_SKILL", "venue-mining");
  try {
    await withTempScript(
      'await fetch("https://webjamsalem.herokuapp.com/outreach/send", {method: "POST"});\n',
      "ts",
      (path) => {
        const payload = JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: `deno run -A ${path}` },
        });
        const res = checkBackendMutation(payload);
        assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
        assert(
          res.includes(
            'web-jam-tools#1021 "hooks/backend-guard: guard production backend mutations and enforce venue-mining skill boundaries"',
          ),
          res,
        );
      },
    );
  } finally {
    Deno.env.delete("ACTIVE_SKILL");
  }
});

Deno.test("check_backend_mutation: curl attached -X / --url= / -d flag forms are parsed the same as their spaced forms", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: "curl -XPOST --url=https://webjamsalem.herokuapp.com/venue -dfoo=bar",
    },
  });
  const res = checkBackendMutation(payload, "/nonexistent/token.json");
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
  assert(res.includes("Unauthorized venue mutation"), res);
});

Deno.test("check_backend_mutation: curl attached --header= and --token= flag forms are parsed", async () => {
  await withTempTokenFile(
    { session_id: "s1", token: "attached-curl-token", expires_at: futureExpiry() },
    (tokenPath) => {
      const payload = JSON.stringify({
        session_id: "s1",
        tool_name: "Bash",
        tool_input: {
          command:
            "curl -X POST https://webjamsalem.herokuapp.com/venue --token=attached-curl-token -d '{}'",
        },
      });
      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("ALLOW:"), `Expected ALLOW, got: ${res}`);
    },
  );

  const denyPayload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        "curl -X POST https://webjamsalem.herokuapp.com/venue \"--header=Authorization: Bearer combo-token\" -d '{}'",
    },
  });
  const denyRes = checkBackendMutation(denyPayload, "/nonexistent/token.json");
  assert(denyRes.startsWith("DENY:"), `Expected DENY, got: ${denyRes}`);
});

Deno.test("check_backend_mutation: curl -G/--get treats the request as read-only even with -d present", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: 'curl -G -d "search=1" https://webjamsalem.herokuapp.com/venue',
    },
  });
  const res = checkBackendMutation(payload);
  assertEquals(res, "PASS");
});

Deno.test("check_backend_mutation: curl --request=, --url (spaced) and --token (spaced) flag forms are parsed", async () => {
  await withTempTokenFile(
    { session_id: "s1", token: "spaced-token", expires_at: futureExpiry() },
    (tokenPath) => {
      const payload = JSON.stringify({
        session_id: "s1",
        tool_name: "Bash",
        tool_input: {
          command:
            "curl --request=PATCH --url https://webjamsalem.herokuapp.com/venue/5 --token spaced-token",
        },
      });
      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("ALLOW:"), `Expected ALLOW, got: ${res}`);
    },
  );
});

Deno.test("check_backend_mutation: a read-only (GET) request to an outreach endpoint PASSES", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: "curl https://webjamsalem.herokuapp.com/outreach/preview",
    },
  });
  const res = checkBackendMutation(payload);
  assertEquals(res, "PASS");
});

Deno.test("check_backend_mutation: an unterminated quote that does NOT reference the backend PASSES rather than failing closed", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "echo 'unterminated" },
  });
  const res = checkBackendMutation(payload);
  assertEquals(res, "PASS");
});

Deno.test("check_backend_mutation: backend mutation outside /venue and /outreach is DENIED generically", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: "curl -X POST https://webjamsalem.herokuapp.com/some-other-endpoint -d '{}'",
    },
  });
  const res = checkBackendMutation(payload);
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
  assert(res.includes("Unauthorized HTTP mutation against production backend"), res);
});

Deno.test("check_backend_mutation: curl to a non-backend host PASSES", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "curl https://example.com/foo" },
  });
  const res = checkBackendMutation(payload);
  assertEquals(res, "PASS");
});

Deno.test("check_backend_mutation: a malformed backend URL (invalid port) still fails closed as a venue mutation", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: "curl -X POST https://webjamsalem.herokuapp.com:bad-port/venue -d '{}'",
    },
  });
  const res = checkBackendMutation(payload, "/nonexistent/token.json");
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
});

Deno.test("check_backend_mutation: an empty segment between operators is skipped without error", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "git status;;git log" },
  });
  const res = checkBackendMutation(payload);
  assertEquals(res, "PASS");
});

Deno.test("check_backend_mutation: exceeding the wrapper recursion depth (nested eval chain) fails closed", () => {
  const command = "eval ".repeat(8) + "true";
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
  });
  const res = checkBackendMutation(payload);
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
  assert(res.includes("recursion depth"), res);
});

Deno.test("check_backend_mutation: exceeding the wrapper ITERATION cap (long prefix-wrapper chain) fails closed", () => {
  const command = "sudo ".repeat(30) + "true";
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
  });
  const res = checkBackendMutation(payload);
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
  assert(res.includes("iteration cap"), res);
});

Deno.test("check_backend_mutation: an ALLOW from a nested bash -c command bubbles up through the outer segment", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command: 'bash -c "deno task venue-mining:record-sweep --metro roanoke"',
    },
  });
  const res = checkBackendMutation(payload);
  assert(res.startsWith("ALLOW:"), `Expected ALLOW, got: ${res}`);
});

Deno.test("check_backend_mutation: top-level payload that parses to a non-object JSON value fails closed", () => {
  assert(checkBackendMutation("42").startsWith("DENY:"));
  assert(checkBackendMutation("42").includes("not an object"));
});

Deno.test("check_backend_mutation: tool_input that is a non-object (string) fails closed", () => {
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: "oops" });
  const res = checkBackendMutation(payload);
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
  assert(res.includes("tool_input is not an object"), res);
});

Deno.test("check_backend_mutation: tool_input with neither command nor CommandLine fails closed", () => {
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: {} });
  const res = checkBackendMutation(payload);
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
  assert(res.includes("command is missing or not a string"), res);
});

Deno.test("check_backend_mutation: a whitespace-only command PASSES", () => {
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "   " } });
  const res = checkBackendMutation(payload);
  assertEquals(res, "PASS");
});

// --- 2. End-to-end hook script tests (hooks/block-backend-mutation.sh) ---

Deno.test("hooks/block-backend-mutation.sh: ALLOWED invocation exits 0 with JSON allow", async () => {
  const payload = {
    tool_name: "Bash",
    tool_input: {
      command: 'curl -X POST https://webjamsalem.herokuapp.com/venue -d \'{"name":"Test"}\'',
    },
  };
  await withTempTokenFile(
    { session_id: "e2e-session", expires_at: futureExpiry() },
    async (tokenPath) => {
      const res = await runHook(
        { ...payload, session_id: "e2e-session" },
        tokenPath,
      );
      assertEquals(res.code, 0, res.stderr);
      const parsed = JSON.parse(res.stdout);
      assertEquals(parsed.hookSpecificOutput.permissionDecision, "allow");
    },
  );
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
