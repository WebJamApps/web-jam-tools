// require_approval_token_on_issue_write_hook.test.ts — web-jam-tools#502
// (extended to the Bash filing path by web-jam-tools#747)
//
// Exercises hooks/require-approval-token-on-issue-write.sh end-to-end by
// shelling out to it (Deno.Command) with mocked PreToolUse JSON on stdin —
// same pattern as test/require_model_label_on_issue_create_hook.test.ts and
// test/haiku_only_gmail_gate_hook.test.ts (re-implementing the shell/deno
// logic in TypeScript would test a copy, not the real guard).
//
// The hook reads the approval token written by the plan gate (web-jam-tools#497,
// not this change) at the path named by ISSUE_APPROVAL_TOKEN_PATH, and decides
// whether a pending mcp__*__issue_write / mcp__*__sub_issue_write call, OR a
// Bash `gh issue create` / `deno task create-issue` call, is one Josh already
// approved:
//   - approved title, same session, same repo, not expired -> ALLOW (no prompt)
//   - anything else (unapproved title / missing / other-session / expired /
//     wrong-repo token)                                     -> DENY (never queried)
//   - issue_write method other than "create", sub_issue_write method other
//     than "add", Bash `gh issue edit`, or an unrelated command/tool -> PASS
//     (untouched, the standing `ask` rule still applies)

import { assertEquals } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../hooks/require-approval-token-on-issue-write.sh",
  import.meta.url,
).pathname;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runHook(
  payload: Record<string, unknown>,
  tokenPath: string,
): Promise<RunResult> {
  const input = JSON.stringify(payload);
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject(), ISSUE_APPROVAL_TOKEN_PATH: tokenPath },
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

function issueWriteCreate(
  title: string,
  sessionId: string,
  owner = "WebJamApps",
  repo = "web-jam-tools",
): Record<string, unknown> {
  return {
    session_id: sessionId,
    tool_name: "mcp__claude_ai_GitHub_MCP__issue_write",
    tool_input: { method: "create", owner, repo, title, type: "Task", labels: ["Sonnet"] },
  };
}

function issueWriteUpdate(sessionId: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    tool_name: "mcp__claude_ai_GitHub_MCP__issue_write",
    tool_input: { method: "update", owner: "WebJamApps", repo: "web-jam-tools", issue_number: 5 },
  };
}

function subIssueWriteAdd(
  sessionId: string,
  owner = "WebJamApps",
  repo = "web-jam-tools",
): Record<string, unknown> {
  return {
    session_id: sessionId,
    tool_name: "mcp__claude_ai_GitHub_MCP__sub_issue_write",
    tool_input: { method: "add", owner, repo, issue_number: 1, sub_issue_id: 2 },
  };
}

function subIssueWriteRemove(sessionId: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    tool_name: "mcp__claude_ai_GitHub_MCP__sub_issue_write",
    tool_input: {
      method: "remove",
      owner: "WebJamApps",
      repo: "web-jam-tools",
      issue_number: 1,
      sub_issue_id: 2,
    },
  };
}

async function withTokenFile(
  token: Record<string, unknown> | null,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/issue-approval-token.json`;
  try {
    if (token !== null) {
      await Deno.writeTextFile(path, JSON.stringify(token));
    }
    // token === null -> file deliberately not written, simulating "missing token"
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function futureIso(hoursFromNow = 4): string {
  return new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
}

function pastIso(hoursAgo = 1): string {
  return new Date(Date.now() - hoursAgo * 3600_000).toISOString();
}

function assertAllow(res: RunResult, titleFragment?: string) {
  assertEquals(res.code, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assertEquals(parsed.hookSpecificOutput.permissionDecision, "allow");
  if (titleFragment) {
    assertEquals(
      typeof parsed.hookSpecificOutput.permissionDecisionReason === "string" &&
        parsed.hookSpecificOutput.permissionDecisionReason.includes(titleFragment),
      true,
    );
  }
}

function assertDeny(res: RunResult) {
  assertEquals(res.code, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assertEquals(parsed.hookSpecificOutput.permissionDecision, "deny");
  assertEquals(typeof parsed.hookSpecificOutput.permissionDecisionReason, "string");
  assertEquals(parsed.hookSpecificOutput.permissionDecisionReason.length > 0, true);
}

function assertPass(res: RunResult) {
  assertEquals(res.code, 0, res.stderr);
  assertEquals(res.stdout.trim(), "");
}

// --- issue_write create: the four required decision paths ---

Deno.test("issue_write create with an approved title in this session's token is ALLOWED (no prompt)", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor", "Rename the widget"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        issueWriteCreate("Fix the flux capacitor", "session-A"),
        tokenPath,
      );
      assertAllow(res, "Fix the flux capacitor");
    },
  );
});

Deno.test("issue_write create with a title NOT in the token is DENIED, not queried", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        issueWriteCreate("An issue nobody approved", "session-A"),
        tokenPath,
      );
      assertDeny(res);
    },
  );
});

Deno.test("issue_write create with NO token file at all is DENIED", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(issueWriteCreate("Any title", "session-A"), tokenPath);
    assertDeny(res);
  });
});

Deno.test("issue_write create with a token from ANOTHER session does not apply and is DENIED", async () => {
  await withTokenFile(
    {
      session_id: "session-OTHER",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        issueWriteCreate("Fix the flux capacitor", "session-A"),
        tokenPath,
      );
      assertDeny(res);
    },
  );
});

// --- extra decision paths named in the acceptance criteria ---

Deno.test("issue_write create with an EXPIRED token is DENIED", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: pastIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        issueWriteCreate("Fix the flux capacitor", "session-A"),
        tokenPath,
      );
      assertDeny(res);
    },
  );
});

Deno.test("issue_write create with a token scoped to a DIFFERENT repo is DENIED", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/JaMmusic",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        issueWriteCreate("Fix the flux capacitor", "session-A"),
        tokenPath,
      );
      assertDeny(res);
    },
  );
});

Deno.test("issue_write create with a malformed token (missing titles field) is DENIED (fail closed)", async () => {
  await withTokenFile(
    { session_id: "session-A", repo: "WebJamApps/web-jam-tools", expires_at: futureIso() },
    async (tokenPath) => {
      const res = await runHook(
        issueWriteCreate("Fix the flux capacitor", "session-A"),
        tokenPath,
      );
      assertDeny(res);
    },
  );
});

Deno.test("issue_write create with invalid JSON in the token file is DENIED (fail closed)", async () => {
  const dir = await Deno.makeTempDir();
  const tokenPath = `${dir}/issue-approval-token.json`;
  try {
    await Deno.writeTextFile(tokenPath, "not valid json{{{");
    const res = await runHook(issueWriteCreate("Fix the flux capacitor", "session-A"), tokenPath);
    assertDeny(res);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- issue_write update: out of scope, passes through untouched ---

Deno.test("issue_write update passes through untouched even with no token", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(issueWriteUpdate("session-A"), tokenPath);
    assertPass(res);
  });
});

// --- sub_issue_write: no title field, so only session/repo/expiry gate it ---

Deno.test("sub_issue_write add with a valid same-session token is ALLOWED", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(subIssueWriteAdd("session-A"), tokenPath);
      assertAllow(res);
    },
  );
});

Deno.test("sub_issue_write add with NO token is DENIED", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(subIssueWriteAdd("session-A"), tokenPath);
    assertDeny(res);
  });
});

Deno.test("sub_issue_write add with a token from ANOTHER session is DENIED", async () => {
  await withTokenFile(
    {
      session_id: "session-OTHER",
      repo: "WebJamApps/web-jam-tools",
      titles: [],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(subIssueWriteAdd("session-A"), tokenPath);
      assertDeny(res);
    },
  );
});

Deno.test("sub_issue_write remove (not add) passes through untouched even with no token", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(subIssueWriteRemove("session-A"), tokenPath);
    assertPass(res);
  });
});

// --- other tools / server prefixes ---

Deno.test("a different MCP server prefix is still gated (server-agnostic matcher)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      {
        session_id: "session-A",
        tool_name: "mcp__github__issue_write",
        tool_input: { method: "create", owner: "WebJamApps", repo: "web-jam-tools", title: "T" },
      },
      tokenPath,
    );
    assertDeny(res);
  });
});

Deno.test("a non-issue_write MCP tool call passes through untouched", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      {
        session_id: "session-A",
        tool_name: "mcp__claude_ai_GitHub_MCP__pull_request_read",
        tool_input: { method: "get" },
      },
      tokenPath,
    );
    assertPass(res);
  });
});

Deno.test("a Bash tool call passes through untouched", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      { session_id: "session-A", tool_name: "Bash", tool_input: { command: "ls -la" } },
      tokenPath,
    );
    assertPass(res);
  });
});

// --- Bash surface: gh issue create / deno task create-issue (web-jam-tools#747) ---

function bashCall(command: string, sessionId = "session-A"): Record<string, unknown> {
  return { session_id: sessionId, tool_name: "Bash", tool_input: { command } };
}

Deno.test("Bash gh issue create with an approved title and --repo is silently passed through (never allow on Bash)", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        bashCall(
          `gh issue create --repo WebJamApps/web-jam-tools --title "Fix the flux capacitor" --body B --type Task`,
        ),
        tokenPath,
      );
      // web-jam-tools#788 review Must Fix #2: Bash never gets `allow` — an
      // approved, correctly-scoped title resolves to silent PASS so the
      // settings permission layer still evaluates the whole call.
      assertPass(res);
    },
  );
});

Deno.test("Bash gh issue create with NO token file at all is DENIED (AC3)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(`gh issue create --title "Untokenized test title" --body B --type Task`),
      tokenPath,
    );
    assertDeny(res);
  });
});

Deno.test("Bash gh issue create with a title NOT in the token is DENIED", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        bashCall(`gh issue create --title "An issue nobody approved" --body B --type Task`),
        tokenPath,
      );
      assertDeny(res);
    },
  );
});

Deno.test("Bash gh issue create with --repo pointing at a different repo than the token is DENIED", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/JaMmusic",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        bashCall(
          `gh issue create --repo WebJamApps/web-jam-tools --title "Fix the flux capacitor" --body B --type Task`,
        ),
        tokenPath,
      );
      assertDeny(res);
    },
  );
});

Deno.test("Bash gh issue create with no --title at all is DENIED (fail closed)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(bashCall(`gh issue create --body B --type Task`), tokenPath);
    assertDeny(res);
  });
});

Deno.test("Bash deno task create-issue with an approved title is silently passed through (never allow on Bash)", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        bashCall(
          `deno task create-issue --title "Fix the flux capacitor" --body-file /tmp/b.md --type Task --label "Flash High"`,
        ),
        tokenPath,
      );
      assertPass(res);
    },
  );
});

Deno.test("Bash deno task create-issue with NO token file at all is DENIED (AC4)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `deno task create-issue --title "Untokenized test title" --body-file /tmp/b.md --type Task --label Haiku`,
      ),
      tokenPath,
    );
    assertDeny(res);
  });
});

Deno.test("Bash direct scripts/create-issue.ts invocation with an approved title is silently passed through (never allow on Bash)", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        bashCall(
          `scripts/create-issue.ts --title "Fix the flux capacitor" --body-file /tmp/b.md --type Task --label Haiku`,
        ),
        tokenPath,
      );
      assertPass(res);
    },
  );
});

Deno.test("Bash gh issue edit (not create) passes through untouched even with no token", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(bashCall(`gh issue edit 5 --add-label bug`), tokenPath);
    assertPass(res);
  });
});

Deno.test("Bash gh issue create with a token from ANOTHER session does not apply and is DENIED", async () => {
  await withTokenFile(
    {
      session_id: "session-OTHER",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        bashCall(`gh issue create --title "Fix the flux capacitor" --body B --type Task`),
        tokenPath,
      );
      assertDeny(res);
    },
  );
});

Deno.test("Bash gh issue create chained after another command (&&) is still gated", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(`echo hi && gh issue create --title "Untokenized test title" --body B --type Task`),
      tokenPath,
    );
    assertDeny(res);
  });
});

// --- web-jam-tools#788 review Must Fix #1: newline / bare-& segmentation ---

Deno.test("Bash gh issue create chained after another command with a NEWLINE (not &&) is still gated", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(`echo hi\ngh issue create --title "Untokenized test title" --body B --type Task`),
      tokenPath,
    );
    assertDeny(res);
  });
});

Deno.test("Bash gh issue create chained after another command with a bare & (not &&) is still gated", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(`echo hi & gh issue create --title "Untokenized test title" --body B --type Task`),
      tokenPath,
    );
    assertDeny(res);
  });
});

// --- web-jam-tools#788 review Must Fix #2: no `allow` on Bash for a composed call ---

Deno.test("Bash gh issue create with an approved title chained with an unrelated dangerous command does NOT allow", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Approved title"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        bashCall(
          `gh issue create --repo WebJamApps/web-jam-tools --title "Approved title" --body B --type Task && git push origin --delete some-branch`,
        ),
        tokenPath,
      );
      assertEquals(res.code, 0, res.stderr);
      const stdout = res.stdout.trim();
      if (stdout) {
        const parsed = JSON.parse(stdout);
        assertEquals(
          parsed.hookSpecificOutput?.permissionDecision === "allow",
          false,
        );
      }
      // No output at all (silent pass) is the correct, safe outcome here —
      // it means the settings permission layer still evaluates the
      // `git push origin --delete` segment untouched.
    },
  );
});

// --- web-jam-tools#788 review Must Fix #3: gh issue create with no --repo ---

Deno.test("Bash gh issue create with NO --repo is NOT silently treated as web-jam-tools (fails closed)", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Fix the flux capacitor"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        bashCall(`gh issue create --title "Fix the flux capacitor" --body B --type Task`),
        tokenPath,
      );
      // Even though the token covers WebJamApps/web-jam-tools and the
      // title is approved, `gh issue create` with no --repo resolves the
      // target repo from the shell's cwd, not a fixed default — this must
      // never be silently assumed to be web-jam-tools. It must NOT be
      // "allow", and it should be denied (fail closed) rather than passed.
      assertDeny(res);
    },
  );
});

// --- web-jam-tools#788 re-review regressions in commit 3afdf03 ---

Deno.test("Bash command with an apostrophe in a # comment above an unrelated command passes through silently (not hard-denied)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(`# Josh's note\ngit status`),
      tokenPath,
    );
    // splitOnOperators() does not strip # comments, so the apostrophe
    // opens an unterminated single-quote state. That must NOT hard-deny
    // an unrelated command — only an unparseable command that plausibly
    // files an issue should fail closed.
    assertPass(res);
  });
});

Deno.test("Bash heredoc body containing an apostrophe passes through silently (not hard-denied)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(`echo "note" --body-file - <<EOF\nJosh's change\nEOF`),
      tokenPath,
    );
    // Same as above: splitOnOperators() does not strip heredoc bodies, so
    // the apostrophe inside the heredoc opens an unterminated quote — an
    // unrelated command (no gh/create-issue anywhere in it) must stay
    // silent.
    assertPass(res);
  });
});

Deno.test("Bash subshell-wrapped gh issue create ( ... ) is still gated (parens are segment boundaries)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `( gh issue create --repo WebJamApps/web-jam-tools --title "Nobody approved this" --body B )`,
      ),
      tokenPath,
    );
    assertDeny(res);
  });
});

Deno.test("Bash brace-grouped gh issue create { ...; } is still gated (braces are segment boundaries)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `{ gh issue create --repo WebJamApps/web-jam-tools --title "Nobody approved this" --body B; }`,
      ),
      tokenPath,
    );
    assertDeny(res);
  });
});

// --- web-jam-tools#788 third review: unterminated-quote path must cover
// every create form the parseable path covers ---

Deno.test("unterminated-quote 'deno task issue:create' fails closed (task name carries no gh token)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(`deno task issue:create --title 'Nobody approved this`),
      tokenPath,
    );
    // Regression guard: looksLikeIssueCreatingCommand()'s first alternative
    // requires a `gh` token, and `issue:create` has none — so without its own
    // alternative this fell through to a silent pass while the SAME command
    // with balanced quotes was correctly denied. An ambiguous parse must
    // never be more permissive than a clean one.
    assertDeny(res);
  });
});

Deno.test("balanced-quote 'deno task issue:create' is gated too (the form the check above must match)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(`deno task issue:create --title "Nobody approved this" --body B`),
      tokenPath,
    );
    // Pins the premise of the test above: this form really is one the
    // parseable path gates, so the unterminated path is obliged to match it.
    assertDeny(res);
  });
});

// --- web-jam-tools#813: the ambiguous-parse branch retries with heredoc
// bodies stripped before falling back to the blunt whole-string test, so a
// heredoc body redirected into a file (data, not code) no longer trips the
// guard just because its prose mentions issue tooling. Every heredoc body
// below deliberately carries exactly one unescaped apostrophe so the raw
// command is genuinely ambiguous (unterminated quote) before the fix even
// gets a chance to run — a heredoc with no such apostrophe stays on the
// already-parseable fast path this issue is a Non-goal to touch.

Deno.test("web-jam-tools#813: heredoc body redirected to a file mentioning 'gh issue create' passes (data, not code)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `cat > /tmp/design-notes.md <<'EOF'\n` +
          `This document explains why gh issue create shouldn't run unless approved.\n` +
          `EOF`,
      ),
      tokenPath,
    );
    assertPass(res);
  });
});

Deno.test("web-jam-tools#813: heredoc body redirected via 'tee' mentioning 'create-issue' passes (data, not code)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `tee /tmp/design-notes.md <<"EOF"\n` +
          `This reviews the create-issue script's own doc — nothing here isn't already explained.\n` +
          `EOF`,
      ),
      tokenPath,
    );
    assertPass(res);
  });
});

Deno.test("web-jam-tools#813: unquoted <<EOF heredoc body mentioning 'gh issue create' passes (data, not code)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `cat > /tmp/design-notes.md <<EOF\n` +
          `Explains why gh issue create isn't run from this file.\n` +
          `EOF`,
      ),
      tokenPath,
    );
    assertPass(res);
  });
});

Deno.test("web-jam-tools#813: <<-EOF heredoc body mentioning 'create-issue' passes (data, not code)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `cat > /tmp/e.md <<-EOF\n` +
          `A note on why deno task create-issue shouldn't be run here either.\n` +
          `\tEOF`,
      ),
      tokenPath,
    );
    assertPass(res);
  });
});

Deno.test("web-jam-tools#813: multiple data heredocs in one command are each classified independently", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `cat > /tmp/a.md <<'EOF1'\n` +
          `First note mentions gh issue create for context.\n` +
          `EOF1\n` +
          `cat > /tmp/b.md <<'EOF2'\n` +
          `Second note explains why it wasn't run.\n` +
          `EOF2`,
      ),
      tokenPath,
    );
    assertPass(res);
  });
});

Deno.test("web-jam-tools#813: an unterminated heredoc (no closing delimiter) fails closed without crashing", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `cat > /tmp/c.md <<'EOF'\n` +
          `Notes about gh issue create that don't get closed.`,
      ),
      tokenPath,
    );
    // No matching closing delimiter — stripHeredocs() conservatively keeps
    // the body in scope rather than discarding it, so the ambiguous parse
    // remains ambiguous and the blunt fallback still sees the mention. The
    // defined, tested fallback is "fail closed, don't crash" — not "pass".
    assertDeny(res);
  });
});

Deno.test("web-jam-tools#813: a delimiter word appearing mid-body does not end the heredoc early", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `cat > /tmp/d.md <<'EOF'\n` +
          `The word EOF appears in this sentence but doesn't end anything here.\n` +
          `A real gh issue create mention happens down here too, still data.\n` +
          `EOF`,
      ),
      tokenPath,
    );
    // If "EOF" mid-sentence were mistaken for the closing line, everything
    // after it (including the apostrophe and the gh mention) would spill
    // out as ordinary command text instead of being dropped as data.
    assertPass(res);
  });
});

Deno.test("web-jam-tools#813: a heredoc piped to an interpreter is executed code and stays gated", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `bash <<'EOF'\n` +
          `gh issue create --title "Nobody's approved title" --body B --type Task\n` +
          `EOF`,
      ),
      tokenPath,
    );
    // Unlike a file-redirected heredoc, this body genuinely executes — it
    // must stay in scope for the scan, not be treated as data.
    assertDeny(res);
  });
});

Deno.test("web-jam-tools#813: a data heredoc mention and a real, approved gh issue create in the same command are decided independently (approved outer call passes silently)", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Real approved title"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        bashCall(
          `cat > /tmp/notes.md <<'EOF1'\n` +
            `This documents why gh issue create shouldn't be used carelessly.\n` +
            `EOF1\n` +
            `gh issue create --repo WebJamApps/web-jam-tools --title "Real approved title" --body B --type Task`,
        ),
        tokenPath,
      );
      // The data body's mention is excluded; the real, outside-heredoc call
      // is still scanned and, being approved, resolves to a silent pass
      // (never "allow" on Bash — see the Must Fix #2 note above).
      assertPass(res);
    },
  );
});

Deno.test("web-jam-tools#813: a data heredoc mention and a real, unapproved gh issue create in the same command are decided independently (unapproved outer call still denied)", async () => {
  await withTokenFile(
    {
      session_id: "session-A",
      repo: "WebJamApps/web-jam-tools",
      titles: ["Some other approved title"],
      expires_at: futureIso(),
    },
    async (tokenPath) => {
      const res = await runHook(
        bashCall(
          `cat > /tmp/notes.md <<'EOF1'\n` +
            `This documents why gh issue create shouldn't be used carelessly.\n` +
            `EOF1\n` +
            `gh issue create --repo WebJamApps/web-jam-tools --title "Nobody approved this" --body B --type Task`,
        ),
        tokenPath,
      );
      // Same data body as above, but this time the real outer call's title
      // is not in the token — it must still be denied on its OWN merits,
      // proving the fix doesn't just blanket-pass once a data heredoc is
      // seen.
      assertDeny(res);
    },
  );
});

// --- web-jam-tools#813 Must Fix #1: INTERPRETER must recognize a
// path-qualified or `source`/`.` spelling of an interpreter, not just the
// bare word — otherwise the ambiguous-parse retry's stripHeredocs() call
// misclassifies these forms as a data (file-redirected) heredoc, strips the
// body, and a real `gh issue create` inside it never gets scanned. Every
// body below carries exactly one unescaped apostrophe (matching the
// convention above) so the raw command is genuinely ambiguous before the
// fix gets a chance to run.

Deno.test("web-jam-tools#813: a heredoc piped to a path-qualified interpreter (/bin/bash) is executed code and stays gated", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `cat <<'EOF' | /bin/bash\n` +
          `This heredoc contains a gh issue create call, and it shouldn't slip past.\n` +
          `EOF`,
      ),
      tokenPath,
    );
    assertDeny(res);
  });
});

Deno.test("web-jam-tools#813: a heredoc fed directly to a path-qualified interpreter (/bin/sh) is executed code and stays gated", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `/bin/sh <<'EOF'\n` +
          `This heredoc contains a gh issue create call, and it shouldn't slip past.\n` +
          `EOF`,
      ),
      tokenPath,
    );
    assertDeny(res);
  });
});

Deno.test("web-jam-tools#813: a heredoc fed to 'source /dev/stdin' is executed code and stays gated", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `source /dev/stdin <<'EOF'\n` +
          `This heredoc contains a gh issue create call, and it shouldn't slip past.\n` +
          `EOF`,
      ),
      tokenPath,
    );
    assertDeny(res);
  });
});

Deno.test("web-jam-tools#813: a heredoc fed to '. /dev/stdin' (dot form of source) is executed code and stays gated", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `. /dev/stdin <<'EOF'\n` +
          `This heredoc contains a gh issue create call, and it shouldn't slip past.\n` +
          `EOF`,
      ),
      tokenPath,
    );
    assertDeny(res);
  });
});

// --- web-jam-tools#813 Must Fix #2: the Must Fix #1 widening over-corrected.
// `(\S*/)?` consumes any run ending in `/`, so with only a `\b` after the
// interpreter name the name could run straight into the rest of a FILENAME
// and an ordinary DATA heredoc was denied whenever its redirect target had a
// path component starting with an interpreter name. The tests above cover
// only the executed direction, which is exactly why that gap shipped — these
// pin the data direction for the same regex. Same apostrophe convention: each
// body carries one unescaped apostrophe so the raw command really is
// unterminated and the ambiguous-parse retry is what's being exercised.

Deno.test("web-jam-tools#813: a data heredoc redirected to a path whose filename starts with an interpreter name then '-' (/tmp/deno-notes.md) passes", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `cat > /tmp/deno-notes.md <<'EOF'\n` +
          `A note on why gh issue create shouldn't be run from these notes.\n` +
          `EOF`,
      ),
      tokenPath,
    );
    assertPass(res);
  });
});

Deno.test("web-jam-tools#813: a data heredoc teed to a path whose filename starts with an interpreter name then '.' (tee /tmp/perl.md) passes", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `tee /tmp/perl.md <<'EOF'\n` +
          `A note on why gh issue create shouldn't be run from these notes.\n` +
          `EOF`,
      ),
      tokenPath,
    );
    assertPass(res);
  });
});

Deno.test("web-jam-tools#813: a data heredoc appended via '>>' to a path with an interpreter-prefixed filename (/home/j/bash-x.md) passes", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `cat >> /home/j/bash-x.md <<'EOF'\n` +
          `A note on why gh issue create shouldn't be run from these notes.\n` +
          `EOF`,
      ),
      tokenPath,
    );
    assertPass(res);
  });
});

Deno.test("web-jam-tools#813: a data heredoc redirected to a relative path with an interpreter-prefixed component (docs/sh-notes.md) passes", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `cat > docs/sh-notes.md <<'EOF'\n` +
          `A note on why gh issue create shouldn't be run from these notes.\n` +
          `EOF`,
      ),
      tokenPath,
    );
    assertPass(res);
  });
});

Deno.test("web-jam-tools#813: a data heredoc redirected to a non-.md interpreter-prefixed filename (/tmp/awk-output.txt) passes", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const res = await runHook(
      bashCall(
        `cat > /tmp/awk-output.txt <<'EOF'\n` +
          `A note on why gh issue create shouldn't be run from these notes.\n` +
          `EOF`,
      ),
      tokenPath,
    );
    assertPass(res);
  });
});

Deno.test("invalid JSON on stdin passes through (nothing this hook can act on)", async () => {
  await withTokenFile(null, async (tokenPath) => {
    const cmd = new Deno.Command("bash", {
      args: [SCRIPT_PATH],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: { ...Deno.env.toObject(), ISSUE_APPROVAL_TOKEN_PATH: tokenPath },
    });
    const child = cmd.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode("not valid json{{{"));
    await writer.close();
    const { code, stdout } = await child.output();
    assertEquals(code, 0);
    assertEquals(new TextDecoder().decode(stdout).trim(), "");
  });
});
