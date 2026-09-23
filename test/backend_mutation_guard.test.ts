// backend_mutation_guard.test.ts — web-jam-tools#1110
//
// Tests hooks/lib/check_backend_mutation.ts for outreach outcome updates
// (PUT /outreach/:id) across Outcomes 1, 2, and 3, and enforces that direct
// dispatch (POST /outreach/batch, POST /outreach/pitch) remains strictly blocked
// during venue-mining tasks.
//
// Designed to run under scoped permissions:
//   deno test --allow-env --allow-read --allow-write test/backend_mutation_guard.test.ts

import { assert, assertEquals } from "@std/assert";
import { checkBackendMutation, isOutreachItemPath } from "../hooks/lib/check_backend_mutation.ts";

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

const NO_TOKEN = "/nonexistent/token.json";

function futureExpiry(): string {
  return new Date(Date.now() + 3600_000).toISOString();
}

function pastExpiry(): string {
  return new Date(Date.now() - 3600_000).toISOString();
}

// ---------------------------------------------------------------------------
// Helper tests: isOutreachItemPath
// ---------------------------------------------------------------------------

Deno.test("isOutreachItemPath: recognizes item paths and excludes reserved dispatch endpoints", () => {
  assertEquals(isOutreachItemPath("/outreach/123"), true);
  assertEquals(isOutreachItemPath("/outreach/648a1234567890abcdef1234"), true);
  assertEquals(isOutreachItemPath("/outreach/outreach_campaign-1"), true);
  assertEquals(isOutreachItemPath("/outreach/123/"), true);

  assertEquals(isOutreachItemPath("/outreach/batch"), false);
  assertEquals(isOutreachItemPath("/outreach/pitch"), false);
  assertEquals(isOutreachItemPath("/outreach/preview"), false);
  assertEquals(isOutreachItemPath("/outreach/candidates"), false);
  assertEquals(isOutreachItemPath("/outreach/send"), false);
  assertEquals(isOutreachItemPath("/outreach"), false);
  assertEquals(isOutreachItemPath(undefined), false);
});

// ---------------------------------------------------------------------------
// Outcome 1 (Condition holds): PUT /outreach/:id with valid approval token ALLOWS
// ---------------------------------------------------------------------------

Deno.test("Outcome 1: PUT /outreach/:id with token covering /outreach/* ALLOWS", async () => {
  await withTempTokenFile(
    {
      session_id: "session-outreach-1",
      token: "secret-token-1",
      endpoints: ["/outreach/*"],
      expires_at: futureExpiry(),
    },
    (tokenPath) => {
      const payload = {
        tool_name: "Bash",
        session_id: "session-outreach-1",
        tool_input: {
          command:
            'curl -X PUT https://webjamsalem.herokuapp.com/outreach/648a1234567890abcdef1234 -H "Content-Type: application/json" -d \'{"status":"target-filled","targetWeekend":"2026-10-10"}\'',
        },
      };

      const res = checkBackendMutation(JSON.stringify(payload), tokenPath);
      assert(res.startsWith("ALLOW:"), `Expected ALLOW, got: ${res}`);
      assert(res.includes("Authorized outreach outcome mutation"), res);
    },
  );
});

Deno.test("Outcome 1: PUT /outreach/:id with token covering /outreach/:id pattern ALLOWS", async () => {
  await withTempTokenFile(
    {
      session_id: "session-outreach-2",
      endpoints: ["/outreach/:id"],
      expires_at: futureExpiry(),
    },
    (tokenPath) => {
      const payload = JSON.stringify({
        tool_name: "Bash",
        session_id: "session-outreach-2",
        tool_input: {
          command:
            'curl -X PUT https://webjamsalem.herokuapp.com/outreach/record123 -d \'{"status":"not-interested"}\'',
        },
      });

      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("ALLOW:"), `Expected ALLOW, got: ${res}`);
      assert(res.includes("Authorized outreach outcome mutation"), res);
    },
  );
});

Deno.test("Outcome 1: PUT /outreach/:id with token covering exact endpoint ALLOWS", async () => {
  await withTempTokenFile(
    {
      endpoints: ["/outreach/record123"],
      expires_at: futureExpiry(),
    },
    (tokenPath) => {
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: {
          command:
            'curl -X PUT https://webjamsalem.herokuapp.com/outreach/record123 -d \'{"status":"booked"}\'',
        },
      });

      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("ALLOW:"), `Expected ALLOW, got: ${res}`);
      assert(res.includes("Authorized outreach outcome mutation"), res);
    },
  );
});

Deno.test("Outcome 1: PUT /outreach/:id presenting matching --token / bearer header ALLOWS", async () => {
  await withTempTokenFile(
    {
      token: "secret-bearer-xyz",
      endpoints: ["/outreach/*"],
      expires_at: futureExpiry(),
    },
    (tokenPath) => {
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: {
          command:
            'curl -X PUT https://webjamsalem.herokuapp.com/outreach/item456 -H "Authorization: Bearer secret-bearer-xyz" -d \'{"status":"target-filled"}\'',
        },
      });

      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("ALLOW:"), `Expected ALLOW, got: ${res}`);
      assert(res.includes("presented token matches"), res);
    },
  );
});

Deno.test("Outcome 1: PUT /outreach/:id inside venue-mining context with valid token ALLOWS", async () => {
  await withTempTokenFile(
    {
      endpoints: ["/venue/*", "/outreach/*"],
      expires_at: futureExpiry(),
    },
    (tokenPath) => {
      Deno.env.set("ACTIVE_SKILL", "venue-mining");
      try {
        const payload = JSON.stringify({
          tool_name: "Bash",
          cwd: "/home/joshua/WebJamApps/web-jam-tools/skills/venue-mining",
          tool_input: {
            command:
              'curl -X PUT https://webjamsalem.herokuapp.com/outreach/648a123 -d \'{"status":"target-filled","targetWeekend":"2026-10-10"}\'',
          },
        });

        const res = checkBackendMutation(payload, tokenPath);
        assert(res.startsWith("ALLOW:"), `Expected ALLOW inside venue-mining context, got: ${res}`);
      } finally {
        Deno.env.delete("ACTIVE_SKILL");
      }
    },
  );
});

Deno.test("Outcome 1: Script doing PUT /outreach/:id with valid token ALLOWS", async () => {
  await withTempTokenFile(
    {
      endpoints: ["/outreach/*"],
      expires_at: futureExpiry(),
    },
    (tokenPath) => {
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: {
          command:
            'deno eval \'await fetch("https://webjamsalem.herokuapp.com/outreach/648a123", {method: "PUT", body: JSON.stringify({status: "booked"})});\'',
        },
      });

      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("ALLOW:"), `Expected ALLOW for script PUT, got: ${res}`);
    },
  );
});

// ---------------------------------------------------------------------------
// Outcome 2 (Condition does not hold): PUT /outreach/:id without valid token DENIES
// ---------------------------------------------------------------------------

Deno.test("Outcome 2: PUT /outreach/:id with missing approval token DENIES", () => {
  const payload = {
    tool_name: "Bash",
    tool_input: {
      command:
        'curl -X PUT https://webjamsalem.herokuapp.com/outreach/123 -d \'{"status":"target-filled"}\'',
    },
  };

  const res = checkBackendMutation(JSON.stringify(payload), NO_TOKEN);
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
  assert(res.includes("No session approval token found"), res);
});

Deno.test("Outcome 2: PUT /outreach/:id with expired token DENIES", async () => {
  await withTempTokenFile(
    {
      endpoints: ["/outreach/*"],
      expires_at: pastExpiry(),
    },
    (tokenPath) => {
      const payload = {
        tool_name: "Bash",
        tool_input: {
          command:
            'curl -X PUT https://webjamsalem.herokuapp.com/outreach/123 -d \'{"status":"not-interested"}\'',
        },
      };

      const res = checkBackendMutation(JSON.stringify(payload), tokenPath);
      assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
      assert(res.includes("Approval token expired at"), res);
    },
  );
});

Deno.test("Outcome 2: PUT /outreach/:id with session ID mismatch DENIES", async () => {
  await withTempTokenFile(
    {
      session_id: "expected-session",
      endpoints: ["/outreach/*"],
      expires_at: futureExpiry(),
    },
    (tokenPath) => {
      const payload = {
        tool_name: "Bash",
        session_id: "other-session",
        tool_input: {
          command:
            'curl -X PUT https://webjamsalem.herokuapp.com/outreach/123 -d \'{"status":"booked"}\'',
        },
      };

      const res = checkBackendMutation(JSON.stringify(payload), tokenPath);
      assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
      assert(res.includes("Approval token belongs to a different session"), res);
    },
  );
});

Deno.test("Outcome 2: PUT /outreach/:id with token covering only /venue/* DENIES", async () => {
  await withTempTokenFile(
    {
      endpoints: ["/venue/*"],
      expires_at: futureExpiry(),
    },
    (tokenPath) => {
      const payload = {
        tool_name: "Bash",
        tool_input: {
          command:
            'curl -X PUT https://webjamsalem.herokuapp.com/outreach/123 -d \'{"status":"target-filled"}\'',
        },
      };

      const res = checkBackendMutation(JSON.stringify(payload), tokenPath);
      assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
      assert(res.includes("Approval token does not cover endpoint /outreach/123"), res);
    },
  );
});

Deno.test("Outcome 2: PUT /outreach/:id with mismatched presented token DENIES", async () => {
  await withTempTokenFile(
    {
      token: "correct-token",
      endpoints: ["/outreach/*"],
      expires_at: futureExpiry(),
    },
    (tokenPath) => {
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: {
          command:
            'curl -X PUT https://webjamsalem.herokuapp.com/outreach/123 --token wrong-token -d \'{"status":"target-filled"}\'',
        },
      });

      const res = checkBackendMutation(payload, tokenPath);
      assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
      assert(res.includes("Presented token does not match"), res);
    },
  );
});

Deno.test("Outcome 2: Direct dispatch POST /outreach/batch during venue-mining remains BLOCKED", async () => {
  await withTempTokenFile(
    {
      endpoints: ["/outreach/*"],
      expires_at: futureExpiry(),
    },
    (tokenPath) => {
      Deno.env.set("ACTIVE_SKILL", "venue-mining");
      try {
        const payload = {
          tool_name: "Bash",
          tool_input: {
            command:
              'curl -X POST https://webjamsalem.herokuapp.com/outreach/batch -d \'{"targetWeekend":"2026-10-10"}\'',
          },
        };

        const res = checkBackendMutation(JSON.stringify(payload), tokenPath);
        assert(res.startsWith("DENY:"), `Expected DENY for batch dispatch, got: ${res}`);
        assert(
          res.includes("Outreach operations (/outreach/*, book-gig, outreach:*) are forbidden"),
          res,
        );
      } finally {
        Deno.env.delete("ACTIVE_SKILL");
      }
    },
  );
});

Deno.test("Outcome 2: Direct dispatch POST /outreach/pitch during venue-mining remains BLOCKED", async () => {
  await withTempTokenFile(
    {
      endpoints: ["/outreach/*"],
      expires_at: futureExpiry(),
    },
    (tokenPath) => {
      Deno.env.set("ACTIVE_SKILL", "venue-mining");
      try {
        const payload = {
          tool_name: "Bash",
          tool_input: {
            command:
              'curl -X POST https://webjamsalem.herokuapp.com/outreach/pitch -d \'{"venueId":"123"}\'',
          },
        };

        const res = checkBackendMutation(JSON.stringify(payload), tokenPath);
        assert(res.startsWith("DENY:"), `Expected DENY for pitch dispatch, got: ${res}`);
        assert(
          res.includes("Outreach operations (/outreach/*, book-gig, outreach:*) are forbidden"),
          res,
        );
      } finally {
        Deno.env.delete("ACTIVE_SKILL");
      }
    },
  );
});

Deno.test("Outcome 2: Direct outreach POST /outreach/batch outside venue-mining is BLOCKED", () => {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: {
      command:
        'curl -X POST https://webjamsalem.herokuapp.com/outreach/batch -d \'{"targetWeekend":"2026-10-10"}\'',
    },
  });

  const res = checkBackendMutation(payload, NO_TOKEN);
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
  assert(res.includes("Direct outreach mutations against the production backend"), res);
});

// ---------------------------------------------------------------------------
// Outcome 3 (Indeterminate condition): Parser failure, corrupt token, unreadable token fails closed (DENY)
// ---------------------------------------------------------------------------

Deno.test("Outcome 3: Unparseable JSON input payload fails closed (DENY)", () => {
  const res = checkBackendMutation("not json at all", NO_TOKEN);
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
  assert(res.includes("Invalid JSON payload"), res);
});

Deno.test("Outcome 3: Non-object top-level payload fails closed (DENY)", () => {
  const res = checkBackendMutation('"string instead of object"', NO_TOKEN);
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
  assert(res.includes("Indeterminate payload"), res);
});

Deno.test("Outcome 3: Missing tool_input fails closed (DENY)", () => {
  const res = checkBackendMutation(JSON.stringify({ tool_name: "Bash" }), NO_TOKEN);
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
  assert(res.includes("tool_input is null or missing"), res);
});

Deno.test("Outcome 3: Corrupt token file (invalid JSON) fails closed (DENY)", async () => {
  await withTempTokenFile("not valid json {", (tokenPath) => {
    const payload = {
      tool_name: "Bash",
      tool_input: {
        command:
          'curl -X PUT https://webjamsalem.herokuapp.com/outreach/123 -d \'{"status":"target-filled"}\'',
      },
    };

    const res = checkBackendMutation(JSON.stringify(payload), tokenPath);
    assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
    assert(res.includes("is invalid JSON"), res);
  });
});

Deno.test("Outcome 3: Corrupt token file (valid JSON but not an object) fails closed (DENY)", async () => {
  await withTempTokenFile("42", (tokenPath) => {
    const payload = {
      tool_name: "Bash",
      tool_input: {
        command:
          'curl -X PUT https://webjamsalem.herokuapp.com/outreach/123 -d \'{"status":"target-filled"}\'',
      },
    };

    const res = checkBackendMutation(JSON.stringify(payload), tokenPath);
    assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
    assert(res.includes("is not a JSON object"), res);
  });
});

Deno.test("Outcome 3: Corrupt token file (missing expires_at) fails closed (DENY)", async () => {
  await withTempTokenFile(
    { session_id: "s", endpoints: ["/outreach/*"] },
    (tokenPath) => {
      const payload = {
        tool_name: "Bash",
        tool_input: {
          command:
            'curl -X PUT https://webjamsalem.herokuapp.com/outreach/123 -d \'{"status":"target-filled"}\'',
        },
      };

      const res = checkBackendMutation(JSON.stringify(payload), tokenPath);
      assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
      assert(res.includes("lacks valid expires_at timestamp"), res);
    },
  );
});

Deno.test("Outcome 3: Filesystem read failure (tokenPath is a directory) fails closed (DENY)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const payload = {
      tool_name: "Bash",
      tool_input: {
        command:
          'curl -X PUT https://webjamsalem.herokuapp.com/outreach/123 -d \'{"status":"target-filled"}\'',
      },
    };

    const res = checkBackendMutation(JSON.stringify(payload), dir);
    assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
    assert(res.includes("Cannot read token file"), res);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Outcome 3: Unterminated quote on command referencing backend fails closed (DENY)", () => {
  const payload = {
    tool_name: "Bash",
    tool_input: {
      command:
        'curl -X PUT "https://webjamsalem.herokuapp.com/outreach/123 -d \'{"status":"target-filled"}',
    },
  };

  const res = checkBackendMutation(JSON.stringify(payload), NO_TOKEN);
  assert(res.startsWith("DENY:"), `Expected DENY, got: ${res}`);
  assert(res.includes("could not be parsed (unterminated quote)"), res);
});
