// issue_approval_token_multi_repo.test.ts — web-jam-tools#1858 "scripts/write_issue_approval_token:
// one approval token covers every repository of an approved plan".
//
// Builds the case table in "Recognising Josh's approval to file an issue"
// (/home/joshua/Dropbox/web-jam-llms/AI_Misbehaves/github-write-guards-design.md, revision 1.2.0)
// as written. Every row runs in a session whose token was written by the design's own command:
//
//   deno run --allow-env --allow-read --allow-write scripts/write_issue_approval_token.ts
//     --session-id S --repo WebJamApps/JaMmusic --title "Book Us form: x"
//     --repo WebJamApps/web-jam-back --title "model/inquiry: y" --title "model/inquiry: z"
//
// and is checked against all three places that decide it: the writer (the real CLI), the hook
// (hooks/lib/check_issue_approval_token.ts run with the hook's stdin payload), and
// checkApprovalToken() in src/create-issue/lib.ts. Temporary token paths only; no GitHub call.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { checkApprovalToken } from "../src/create-issue/lib.ts";
import { loadToken } from "../hooks/lib/check_issue_approval_token.ts";
import { groupApprovalArgs } from "../scripts/write_issue_approval_token.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const WRITER = `${ROOT}scripts/write_issue_approval_token.ts`;
const HOOK_LIB = `${ROOT}hooks/lib/check_issue_approval_token.ts`;
const SESSION = "S";

const DESIGN_WRITE_ARGS = [
  "--session-id",
  SESSION,
  "--repo",
  "WebJamApps/JaMmusic",
  "--title",
  "Book Us form: x",
  "--repo",
  "WebJamApps/web-jam-back",
  "--title",
  "model/inquiry: y",
  "--title",
  "model/inquiry: z",
];

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the real writer CLI, authorized by a fixture transcript opening with /design-issue. */
async function runWriter(dir: string, args: string[], tokenPath: string): Promise<Run> {
  const transcript = `${dir}/transcript.jsonl`;
  await Deno.writeTextFile(
    transcript,
    JSON.stringify({ type: "user", message: { role: "user", content: "/design-issue plan it" } }) +
      "\n",
  );
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-env", "--allow-read", "--allow-write", WRITER, ...args],
    env: {
      ...Deno.env.toObject(),
      ISSUE_APPROVAL_TOKEN_PATH: tokenPath,
      WRITE_ISSUE_APPROVAL_TOKEN_TEST_TRANSCRIPT_PATH: transcript,
      WRITE_ISSUE_APPROVAL_TOKEN_TEST_CONVERSATION_ID: "test-conv",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

/** Runs the hook's decision with the hook's stdin payload; returns PASS, ALLOW:<why> or DENY:<why>. */
async function runHook(
  toolName: string,
  toolInput: Record<string, unknown>,
  tokenPath: string,
): Promise<string> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-env", "--allow-read", HOOK_LIB],
    env: { ...Deno.env.toObject(), ISSUE_APPROVAL_TOKEN_PATH: tokenPath },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(
      JSON.stringify({ tool_name: toolName, tool_input: toolInput, session_id: SESSION }),
    ),
  );
  await writer.close();
  const { stdout } = await child.output();
  return new TextDecoder().decode(stdout).trim();
}

/** Writes the design's token through the real writer, then hands its path to `fn`. */
async function withDesignToken(
  fn: (dir: string, tokenPath: string) => void | Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const tokenPath = `${dir}/token.json`;
    const res = await runWriter(dir, DESIGN_WRITE_ARGS, tokenPath);
    assertEquals(res.code, 0, res.stderr);
    await fn(dir, tokenPath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const createCommand = (repo: string, title: string, label: string) =>
  `deno task create-issue --repo ${repo} --title "${title}" --type Task --label ${label}`;

// The design's create-issue rows: repository, title, label, and the expected result. `refuse` holds
// the reason text the refusal must carry; undefined means the filing is allowed.
const CREATE_ROWS: { repo: string; title: string; label: string; refuse?: string }[] = [
  { repo: "WebJamApps/JaMmusic", title: "Book Us form: x", label: "Terra" },
  { repo: "WebJamApps/web-jam-back", title: "model/inquiry: y", label: "Sol" },
  { repo: "WebJamApps/web-jam-back", title: "model/inquiry: z", label: "Sol" },
  {
    repo: "WebJamApps/web-jam-back",
    title: "Book Us form: x",
    label: "Terra",
    refuse: "is approved in WebJamApps/JaMmusic only",
  },
  {
    repo: "WebJamApps/web-jam-tools",
    title: "model/inquiry: y",
    label: "Sol",
    refuse: "No approval in WebJamApps/web-jam-tools",
  },
  {
    repo: "WebJamApps/JaMmusic",
    title: "Book Us form: other",
    label: "Terra",
    refuse: "not among the titles approved",
  },
];

Deno.test("writer: the design's command writes one token listing both repositories with their titles", async () => {
  await withDesignToken((_dir, tokenPath) => {
    const token = loadToken(tokenPath);
    assert(token);
    assertEquals(token.session_id, SESSION);
    assertEquals(token.approvals, [
      { repo: "WebJamApps/JaMmusic", titles: ["Book Us form: x"] },
      { repo: "WebJamApps/web-jam-back", titles: ["model/inquiry: y", "model/inquiry: z"] },
    ]);
  });
});

for (const row of CREATE_ROWS) {
  const label = `${createCommand(row.repo, row.title, row.label)} -> ${
    row.refuse ? `refuse (${row.refuse})` : "allow"
  }`;

  Deno.test(`hook: ${label}`, async () => {
    await withDesignToken(async (_dir, tokenPath) => {
      const out = await runHook(
        "Bash",
        { command: createCommand(row.repo, row.title, row.label) },
        tokenPath,
      );
      if (row.refuse) {
        assert(out.startsWith("DENY:"), out);
        assertStringIncludes(out, row.refuse);
      } else {
        // An approved Bash filing is never "allow" (it would bypass the settings layer for the
        // rest of the command); it passes silently instead.
        assertEquals(out, "PASS");
      }
    });
  });

  Deno.test(`checkApprovalToken: ${label}`, async () => {
    await withDesignToken((_dir, tokenPath) => {
      const res = checkApprovalToken(row.repo, row.title, tokenPath);
      if (row.refuse) {
        assertEquals(res.ok, false);
        assertStringIncludes(res.reason ?? "", row.refuse);
      } else {
        assertEquals(res, { ok: true });
      }
    });
  });

  Deno.test(`checkApprovalToken (per-session directory scan): ${label}`, async () => {
    const home = await Deno.makeTempDir();
    const savedHome = Deno.env.get("HOME");
    const savedOverride = Deno.env.get("ISSUE_APPROVAL_TOKEN_PATH");
    const savedCodexThread = Deno.env.get("CODEX_THREAD_ID");
    const savedCodexHome = Deno.env.get("CODEX_HOME");
    const savedSurface = Deno.env.get("WJT_SURFACE");
    try {
      const tokenDir = `${home}/.claude/state/issue-approval-tokens`;
      await Deno.mkdir(tokenDir, { recursive: true });
      const res = await runWriter(home, DESIGN_WRITE_ARGS, `${tokenDir}/${SESSION}.json`);
      assertEquals(res.code, 0, res.stderr);
      Deno.env.set("HOME", home);
      Deno.env.delete("ISSUE_APPROVAL_TOKEN_PATH");
      Deno.env.delete("CODEX_THREAD_ID");
      Deno.env.delete("CODEX_HOME");
      Deno.env.delete("WJT_SURFACE");
      const check = checkApprovalToken(row.repo, row.title);
      if (row.refuse) {
        assertEquals(check.ok, false);
        assertStringIncludes(check.reason ?? "", row.refuse);
      } else {
        assertEquals(check, { ok: true });
      }
    } finally {
      if (savedHome === undefined) Deno.env.delete("HOME");
      else Deno.env.set("HOME", savedHome);
      if (savedOverride === undefined) Deno.env.delete("ISSUE_APPROVAL_TOKEN_PATH");
      else Deno.env.set("ISSUE_APPROVAL_TOKEN_PATH", savedOverride);
      if (savedCodexThread === undefined) Deno.env.delete("CODEX_THREAD_ID");
      else Deno.env.set("CODEX_THREAD_ID", savedCodexThread);
      if (savedCodexHome === undefined) Deno.env.delete("CODEX_HOME");
      else Deno.env.set("CODEX_HOME", savedCodexHome);
      if (savedSurface === undefined) Deno.env.delete("WJT_SURFACE");
      else Deno.env.set("WJT_SURFACE", savedSurface);
      await Deno.remove(home, { recursive: true });
    }
  });
}

Deno.test("hook: sub_issue_write add in web-jam-back -> allow: a token repository", async () => {
  await withDesignToken(async (_dir, tokenPath) => {
    const out = await runHook(
      "mcp__claude_ai_GitHub_MCP__sub_issue_write",
      {
        method: "add",
        owner: "WebJamApps",
        repo: "web-jam-back",
        issue_number: 973,
        sub_issue_id: 1,
      },
      tokenPath,
    );
    assert(out.startsWith("ALLOW:"), out);
  });
});

Deno.test("hook: sub_issue_write add in web-jam-tools -> refuse: not a token repository", async () => {
  await withDesignToken(async (_dir, tokenPath) => {
    const out = await runHook(
      "mcp__claude_ai_GitHub_MCP__sub_issue_write",
      {
        method: "add",
        owner: "WebJamApps",
        repo: "web-jam-tools",
        issue_number: 1507,
        sub_issue_id: 1,
      },
      tokenPath,
    );
    assert(out.startsWith("DENY:"), out);
    assertStringIncludes(out, "No approval in WebJamApps/web-jam-tools");
  });
});

Deno.test("the same three allowed creates after the token's expiry -> refuse: expired", async () => {
  await withDesignToken(async (_dir, tokenPath) => {
    const token = JSON.parse(await Deno.readTextFile(tokenPath));
    token.expires_at = new Date(Date.now() - 60_000).toISOString();
    await Deno.writeTextFile(tokenPath, JSON.stringify(token));
    for (const row of CREATE_ROWS.filter((r) => !r.refuse)) {
      const out = await runHook(
        "Bash",
        { command: createCommand(row.repo, row.title, row.label) },
        tokenPath,
      );
      assert(out.startsWith("DENY:"), out);
      assertStringIncludes(out, "expired");
      const res = checkApprovalToken(row.repo, row.title, tokenPath);
      assertEquals(res.ok, false);
      assertStringIncludes(res.reason ?? "", "expired");
    }
  });
});

Deno.test("a token in the earlier shape is read as a list of one approval -> allow", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const tokenPath = `${dir}/token.json`;
    await Deno.writeTextFile(
      tokenPath,
      JSON.stringify({
        session_id: SESSION,
        repo: "WebJamApps/web-jam-tools",
        titles: ["a"],
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    );
    const command = createCommand("WebJamApps/web-jam-tools", "a", "Terra");
    assertEquals(await runHook("Bash", { command }, tokenPath), "PASS");
    assertEquals(checkApprovalToken("WebJamApps/web-jam-tools", "a", tokenPath), { ok: true });
    assertEquals(loadToken(tokenPath)?.approvals, [
      { repo: "WebJamApps/web-jam-tools", titles: ["a"] },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writer: equals-form short aliases -r= and -t= write the same single-repository token", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const tokenPath = `${dir}/token.json`;
    const res = await runWriter(
      dir,
      ["--session-id", SESSION, "-r=WebJamApps/web-jam-tools", "-t=Title A", "-t", "Title B"],
      tokenPath,
    );
    assertEquals(res.code, 0, res.stderr);
    assertEquals(loadToken(tokenPath)?.approvals, [
      { repo: "WebJamApps/web-jam-tools", titles: ["Title A", "Title B"] },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writer: arguments after -- are not read as a --repo or --title", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const tokenPath = `${dir}/token.json`;
    const res = await runWriter(
      dir,
      [
        "--session-id",
        SESSION,
        "-r",
        "WebJamApps/web-jam-tools",
        "-t",
        "Title A",
        "--",
        "--title",
        "Title B",
      ],
      tokenPath,
    );
    assertEquals(res.code, 0, res.stderr);
    assertEquals(loadToken(tokenPath)?.approvals, [
      { repo: "WebJamApps/web-jam-tools", titles: ["Title A"] },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("groupApprovalArgs reads mixed long, short and equals forms in order", () => {
  assertEquals(
    groupApprovalArgs([
      "-r=WebJamApps/JaMmusic",
      "-t=Book Us form: x",
      "--repo=WebJamApps/web-jam-back",
      "-t",
      "model/inquiry: y",
    ]),
    {
      approvals: [
        { repo: "WebJamApps/JaMmusic", titles: ["Book Us form: x"] },
        { repo: "WebJamApps/web-jam-back", titles: ["model/inquiry: y"] },
      ],
    },
  );
});

Deno.test("groupApprovalArgs reads -t - as the title - and -tRelease 2 as the title Release 2", () => {
  assertEquals(
    groupApprovalArgs(["-r", "WebJamApps/JaMmusic", "-t", "-", "-tRelease 2"]),
    { approvals: [{ repo: "WebJamApps/JaMmusic", titles: ["-", "Release 2"] }] },
  );
});

Deno.test("groupApprovalArgs reads -r - as the repository -, as parseArgs does", () => {
  assertEquals(
    groupApprovalArgs(["-r", "-", "-t", "a"]),
    { approvals: [{ repo: "-", titles: ["a"] }] },
  );
});

Deno.test("groupApprovalArgs orders a grouped -tr by its letters", () => {
  assertEquals(
    groupApprovalArgs([
      "-r",
      "WebJamApps/JaMmusic",
      "-t",
      "a",
      "-tr",
      "WebJamApps/web-jam-back",
      "-t",
      "b",
    ]),
    {
      approvals: [
        { repo: "WebJamApps/JaMmusic", titles: ["a", ""] },
        { repo: "WebJamApps/web-jam-back", titles: ["b"] },
      ],
    },
  );
});

Deno.test("writer: -t - and -tRelease 2 are written as approved titles", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const tokenPath = `${dir}/token.json`;
    const res = await runWriter(
      dir,
      ["--session-id", SESSION, "-r", "WebJamApps/web-jam-tools", "-t", "-", "-tRelease 2"],
      tokenPath,
    );
    assertEquals(res.code, 0, res.stderr);
    assertEquals(loadToken(tokenPath)?.approvals, [
      { repo: "WebJamApps/web-jam-tools", titles: ["-", "Release 2"] },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writer refuses: a title before any --repo", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const tokenPath = `${dir}/token.json`;
    const res = await runWriter(
      dir,
      ["--session-id", SESSION, "--title", "a", "--repo", "WebJamApps/JaMmusic"],
      tokenPath,
    );
    assertEquals(res.code, 1);
    assertStringIncludes(res.stderr, "comes before any --repo");
    assertEquals(loadToken(tokenPath), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writer refuses: a repository with no title", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const tokenPath = `${dir}/token.json`;
    const res = await runWriter(
      dir,
      ["--session-id", SESSION, "--repo", "WebJamApps/JaMmusic"],
      tokenPath,
    );
    assertEquals(res.code, 1);
    assertStringIncludes(res.stderr, "has no --title");
    assertEquals(loadToken(tokenPath), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writer: a later write in the same session replaces the whole token", async () => {
  await withDesignToken(async (dir, tokenPath) => {
    const res = await runWriter(
      dir,
      ["--session-id", SESSION, "--repo", "WebJamApps/web-jam-tools", "--title", "only this"],
      tokenPath,
    );
    assertEquals(res.code, 0, res.stderr);
    assertEquals(loadToken(tokenPath)?.approvals, [
      { repo: "WebJamApps/web-jam-tools", titles: ["only this"] },
    ]);
    assertEquals(checkApprovalToken("WebJamApps/JaMmusic", "Book Us form: x", tokenPath).ok, false);
  });
});

Deno.test("writer refuses positionless titles that cannot say which of several repositories they belong to", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const tokenPath = `${dir}/token.json`;
    const res = await runWriter(
      dir,
      [
        "--session-id",
        SESSION,
        "--repo",
        "WebJamApps/JaMmusic",
        "--title",
        "a",
        "--repo",
        "WebJamApps/web-jam-back",
        "--title",
        "b",
        "--titles",
        "c,d",
      ],
      tokenPath,
    );
    assertEquals(res.code, 1);
    assertStringIncludes(res.stderr, "cannot say which --repo they belong to");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
