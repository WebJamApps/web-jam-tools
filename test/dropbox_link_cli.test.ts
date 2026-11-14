import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  createOrGetSharedLink,
  DEFAULT_KEEPASS_DB_SUFFIX,
  DEFAULT_KEEPASS_ENTRY,
  dropboxSecrets,
  main,
  parseKeepassShowOutput,
  readStdinPaths,
  refreshAccessToken,
  runCli,
  shareLinkForms,
  toAccountRelativePath,
} from "../src/dropbox-link/dropbox_link_cli.ts";

// --- mock harness: stub `fetch`, `keepassxc-cli` via `Deno.Command`, console, and env ---

type Route = { status?: number; body: string };

interface KeepassStubConfig {
  code?: number;
  stdout?: string;
  stderr?: string;
  expectedPassword?: string;
}

interface CapturedInvocation {
  cmd: string | URL;
  options?: Deno.CommandOptions;
}

interface MockResult {
  logs: string[];
  errors: string[];
  commands: CapturedInvocation[];
  requests: Array<{ url: string; headers: Headers; body: string }>;
}

const STUB_SECRETS = {
  appKey: "kp-app-key-123",
  appSecret: "kp-app-secret-456",
  refreshToken: "kp-refresh-token-789",
} as const;

const DEFAULT_KEEPASS_STDOUT = [
  `Title: ${DEFAULT_KEEPASS_ENTRY}`,
  `UserName: ${STUB_SECRETS.appKey}`,
  `Password: ${STUB_SECRETS.appSecret}`,
  "URL: ",
  `Notes: ${STUB_SECRETS.refreshToken}`,
  "Uuid: {00000000-0000-0000-0000-000000000000}",
  "Tags: ",
].join("\n");

async function withMocks(
  opts: {
    routes?: Record<string, Route | Route[]>;
    env?: Record<string, string | undefined>;
    keepass?: KeepassStubConfig;
  },
  fn: (ctx: MockResult) => void | Promise<void>,
): Promise<MockResult> {
  const savedFetch = globalThis.fetch;
  const SavedCommand = Deno.Command;
  const savedLog = console.log;
  const savedError = console.error;
  const envKeys = Object.keys(opts.env ?? {});
  const savedEnv = new Map(envKeys.map((k) => [k, Deno.env.get(k)]));
  const callCounts = new Map<string, number>();

  const ctx: MockResult = {
    logs: [],
    errors: [],
    commands: [],
    requests: [],
  };

  console.log = (...args: unknown[]) => {
    ctx.logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    ctx.errors.push(args.map(String).join(" "));
  };

  const kpConfig: Required<KeepassStubConfig> = {
    code: opts.keepass?.code ?? 0,
    stdout: opts.keepass?.stdout ?? DEFAULT_KEEPASS_STDOUT,
    stderr: opts.keepass?.stderr ?? "",
    expectedPassword: opts.keepass?.expectedPassword ?? "",
  };

  Deno.Command = class StubCommand extends SavedCommand {
    constructor(cmd: string | URL, options?: Deno.CommandOptions) {
      ctx.commands.push({ cmd, options });
      if (String(cmd) === "keepassxc-cli") {
        const checkPw = kpConfig.expectedPassword.length > 0;
        super("sh", {
          args: [
            "-c",
            checkPw
              ? 'IFS= read -r pw; if [ "$pw" != "$KP_EXPECTED_PW" ]; then exit 1; fi; exit "$KP_STUB_CODE"'
              : "exit $KP_STUB_CODE",
          ],
          env: {
            KP_STUB_CODE: String(kpConfig.code),
            KP_EXPECTED_PW: kpConfig.expectedPassword,
          },
          stdin: checkPw && typeof options?.stdin === "number" ? options.stdin : "null",
          stdout: "piped",
          stderr: "piped",
        });
        return;
      }
      super(cmd, options);
    }

    override async output(): Promise<Deno.CommandOutput> {
      const real = await super.output();
      const code = kpConfig.expectedPassword.length > 0 ? real.code : kpConfig.code;
      return {
        success: code === 0 && real.success,
        code,
        signal: null,
        stdout: new TextEncoder().encode(code === 0 ? kpConfig.stdout : ""),
        stderr: new TextEncoder().encode(
          code === 0 ? kpConfig.stderr : (kpConfig.stderr ||
            "Error while reading the database: Invalid credentials were provided"),
        ),
      };
    }
  } as typeof Deno.Command;

  try {
    if (opts.routes) {
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const headers = new Headers(init?.headers);
        const body = init?.body ? String(init.body) : "";
        ctx.requests.push({ url, headers, body });

        const entry = opts.routes![url];
        if (!entry) return Promise.resolve(new Response("not found", { status: 404 }));
        if (Array.isArray(entry)) {
          const n = callCounts.get(url) ?? 0;
          callCounts.set(url, n + 1);
          const r = entry[Math.min(n, entry.length - 1)];
          return Promise.resolve(new Response(r.body, { status: r.status ?? 200 }));
        }
        return Promise.resolve(new Response(entry.body, { status: entry.status ?? 200 }));
      }) as typeof fetch;
    }
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await fn(ctx);
  } finally {
    globalThis.fetch = savedFetch;
    Deno.Command = SavedCommand;
    console.log = savedLog;
    console.error = savedError;
    for (const [k, v] of savedEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
  return ctx;
}

function assertNoSecretsPrinted(ctx: MockResult, secrets = STUB_SECRETS): void {
  const combined = [...ctx.logs, ...ctx.errors].join("\n");
  for (const val of [secrets.appKey, secrets.appSecret, secrets.refreshToken]) {
    assert(
      !combined.includes(val),
      `Expected output not to contain secret "${val}", but got:\n${combined}`,
    );
  }
}

async function withTempPasswordFile(
  password: string,
  fn: (ttyFile: string) => Promise<void>,
): Promise<void> {
  const { stdout } = await new Deno.Command("sh", {
    args: ["-c", 'f=$(mktemp); printf "%s\\n" "$1" > "$f"; printf "%s" "$f"', "sh", password],
    stdout: "piped",
  }).output();
  const ttyFile = new TextDecoder().decode(stdout).trim();
  try {
    await fn(ttyFile);
  } finally {
    await new Deno.Command("rm", { args: ["-f", ttyFile] }).output().catch(() => {});
  }
}

// --- dropboxSecrets: KeePass runtime lookup via keepassxc-cli ---

Deno.test("dropboxSecrets reads appKey, appSecret, and refreshToken via keepassxc-cli and ignores shell env vars", async () => {
  await withTempPasswordFile("synth-master-pass", async (ttyFile) => {
    await withMocks({
      env: {
        HOME: "/home/testuser",
        DROPBOX_APP_KEY: "env-ignored-key",
        DROPBOX_APP_SECRET: "env-ignored-secret",
        DROPBOX_REFRESH_TOKEN: "env-ignored-token",
      },
      keepass: { expectedPassword: "synth-master-pass" },
    }, async (ctx) => {
      const secrets = await dropboxSecrets({ ttyPath: ttyFile });
      assertEquals(secrets, STUB_SECRETS);
      assertEquals(ctx.commands.length, 1);
      assertEquals(ctx.commands[0].cmd, "keepassxc-cli");
      assertEquals(ctx.commands[0].options?.args, [
        "show",
        "--show-protected",
        "--all",
        `/home/testuser${DEFAULT_KEEPASS_DB_SUFFIX}`,
        DEFAULT_KEEPASS_ENTRY,
      ]);
      assertEquals(typeof ctx.commands[0].options?.stdin, "number");
      assertEquals(ctx.commands[0].options?.stdout, "piped");
      assertEquals(ctx.commands[0].options?.stderr, "inherit");
      assertNoSecretsPrinted(ctx);
    });
  });
});

Deno.test("parseKeepassShowOutput parses explicit DROPBOX_* key-value lines in Notes or attributes", () => {
  const stdout = [
    "Title: webjam-setlist-links",
    "UserName: ",
    "Password: ",
    "Notes: DROPBOX_APP_KEY=explicit-key-1",
    "DROPBOX_APP_SECRET=explicit-secret-2",
    "export DROPBOX_REFRESH_TOKEN='explicit-refresh-3'",
    "KPH: APP_KEY: explicit-key-override",
  ].join("\n");
  assertEquals(parseKeepassShowOutput(stdout), {
    appKey: "explicit-key-override",
    appSecret: "explicit-secret-2",
    refreshToken: "explicit-refresh-3",
  });
});

Deno.test("dropboxSecrets stops and prints nothing secret when the entry is missing or the master password is wrong", async () => {
  await withMocks({
    keepass: {
      code: 1,
      stdout: DEFAULT_KEEPASS_STDOUT,
      stderr: "Error while reading the database: Invalid credentials were provided",
    },
  }, async (ctx) => {
    const err = await assertRejects(
      () => dropboxSecrets({ dbPath: "/tmp/test.kdbx", entry: "webjam-setlist-links" }),
      Error,
      "keepassxc-cli failed to read KeePass entry",
    );
    for (const secret of Object.values(STUB_SECRETS)) {
      assert(!err.message.includes(secret));
    }
    assertNoSecretsPrinted(ctx);
  });
});

Deno.test("dropboxSecrets throws without leaking partial secrets when a field is missing from the entry", async () => {
  const partialStdout = [
    "Title: webjam-setlist-links",
    `UserName: ${STUB_SECRETS.appKey}`,
    `Password: ${STUB_SECRETS.appSecret}`,
    "Notes: ",
  ].join("\n");
  await withMocks({ keepass: { code: 0, stdout: partialStdout } }, async (ctx) => {
    const err = await assertRejects(
      () => dropboxSecrets(),
      Error,
      "Missing Dropbox OAuth secrets in KeePass entry",
    );
    assert(!err.message.includes(STUB_SECRETS.appKey));
    assert(!err.message.includes(STUB_SECRETS.appSecret));
    assertNoSecretsPrinted(ctx);
  });
});

// --- refreshAccessToken: OAuth refresh-token grant (HTTP Basic auth) ---

Deno.test("refreshAccessToken exchanges the KeePass-sourced secrets for an access token", async () => {
  await withMocks({
    routes: {
      "https://api.dropboxapi.com/oauth2/token": {
        body: JSON.stringify({ access_token: "AT123" }),
      },
    },
  }, async (ctx) => {
    assertEquals(await refreshAccessToken(), "AT123");
    assertEquals(ctx.requests.length, 1);
    assertEquals(
      ctx.requests[0].headers.get("Authorization"),
      `Basic ${btoa(`${STUB_SECRETS.appKey}:${STUB_SECRETS.appSecret}`)}`,
    );
    assertStringIncludes(ctx.requests[0].body, `refresh_token=${STUB_SECRETS.refreshToken}`);
    assertNoSecretsPrinted(ctx);
  });
});

Deno.test("refreshAccessToken throws and redacts secrets on a non-OK token response", async () => {
  await withMocks({
    routes: {
      "https://api.dropboxapi.com/oauth2/token": {
        status: 400,
        body: `bad_grant ${STUB_SECRETS.refreshToken}`,
      },
    },
  }, async (ctx) => {
    const err = await assertRejects(() => refreshAccessToken(), Error, "dropbox token refresh");
    assert(!err.message.includes(STUB_SECRETS.refreshToken));
    assertNoSecretsPrinted(ctx);
  });
});

Deno.test("refreshAccessToken throws when the response has no access_token", async () => {
  await withMocks({
    routes: { "https://api.dropboxapi.com/oauth2/token": { body: JSON.stringify({}) } },
  }, async () => {
    await assertRejects(() => refreshAccessToken(), Error, "returned no access_token");
  });
});

// --- toAccountRelativePath: input auto-detection ---

Deno.test("toAccountRelativePath keeps an account-relative path as-is", () => {
  assertEquals(
    toAccountRelativePath("/joshandmariamusic/song.mp3"),
    "/joshandmariamusic/song.mp3",
  );
});

Deno.test("toAccountRelativePath maps a /home/joshua/Dropbox/... local path", () => {
  assertEquals(
    toAccountRelativePath("/home/joshua/Dropbox/joshandmariamusic/song.mp3"),
    "/joshandmariamusic/song.mp3",
  );
});

Deno.test("toAccountRelativePath expands ~ using the injected home dir and maps it", () => {
  assertEquals(
    toAccountRelativePath("~/Dropbox/joshandmariamusic/song.mp3", "/home/joshua"),
    "/joshandmariamusic/song.mp3",
  );
});

Deno.test("toAccountRelativePath trims surrounding whitespace (e.g. from stdin lines)", () => {
  assertEquals(toAccountRelativePath("  /a/b.mp3  "), "/a/b.mp3");
});

Deno.test("toAccountRelativePath throws for input it can't classify", () => {
  assertThrows(
    () => toAccountRelativePath("relative/no/leading/slash.mp3"),
    Error,
    "Cannot determine Dropbox path type",
  );
});

// --- shareLinkForms: single shared-link URL -> both labeled output forms ---

Deno.test("shareLinkForms produces the setlist (dl=0) and widget (dl=1) forms, preserving rlkey", () => {
  const forms = shareLinkForms(
    "https://www.dropbox.com/scl/fi/abc123/song.mp3?rlkey=xyz789&dl=0",
  );
  assertEquals(
    forms.setlistUrl,
    "https://www.dropbox.com/scl/fi/abc123/song.mp3?rlkey=xyz789&dl=0",
  );
  assertEquals(
    forms.widgetUrl,
    "https://dl.dropboxusercontent.com/scl/fi/abc123/song.mp3?rlkey=xyz789&dl=1",
  );
});

Deno.test("shareLinkForms forces dl regardless of the source link's dl value", () => {
  const forms = shareLinkForms(
    "https://www.dropbox.com/scl/fi/abc123/song.mp3?rlkey=xyz789&dl=1",
  );
  assertStringIncludes(forms.setlistUrl, "dl=0");
  assertStringIncludes(forms.widgetUrl, "dl=1");
});

Deno.test("shareLinkForms omits rlkey from the query when the source link has none", () => {
  const forms = shareLinkForms("https://www.dropbox.com/scl/fi/abc123/song.mp3?dl=0");
  assertEquals(forms.setlistUrl, "https://www.dropbox.com/scl/fi/abc123/song.mp3?dl=0");
  assertEquals(forms.widgetUrl, "https://dl.dropboxusercontent.com/scl/fi/abc123/song.mp3?dl=1");
});

// --- createOrGetSharedLink: create, or 409 fallback to list (idempotent) ---

Deno.test("createOrGetSharedLink returns the URL from a fresh create", async () => {
  await withMocks({
    routes: {
      "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings": {
        body: JSON.stringify({ url: "https://www.dropbox.com/scl/fi/new/song.mp3?rlkey=k&dl=0" }),
      },
    },
  }, async () => {
    assertEquals(
      await createOrGetSharedLink("AT", "/a/song.mp3"),
      "https://www.dropbox.com/scl/fi/new/song.mp3?rlkey=k&dl=0",
    );
  });
});

Deno.test("createOrGetSharedLink falls back to list_shared_links on 409 shared_link_already_exists (idempotent re-run)", async () => {
  await withMocks({
    routes: {
      "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings": {
        status: 409,
        body: JSON.stringify({
          error_summary: "shared_link_already_exists/...",
          error: { ".tag": "shared_link_already_exists" },
        }),
      },
      "https://api.dropboxapi.com/2/sharing/list_shared_links": {
        body: JSON.stringify({
          links: [{ url: "https://www.dropbox.com/scl/fi/existing/song.mp3?rlkey=k&dl=0" }],
        }),
      },
    },
  }, async () => {
    assertEquals(
      await createOrGetSharedLink("AT", "/a/song.mp3"),
      "https://www.dropbox.com/scl/fi/existing/song.mp3?rlkey=k&dl=0",
    );
  });
});

Deno.test("createOrGetSharedLink rethrows a 409 that is NOT shared_link_already_exists", async () => {
  await withMocks({
    routes: {
      "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings": {
        status: 409,
        body: JSON.stringify({ error_summary: "some_other_conflict/..." }),
      },
    },
  }, async () => {
    await assertRejects(
      () => createOrGetSharedLink("AT", "/a/song.mp3"),
      Error,
      "dropbox create shared link: 409",
    );
  });
});

Deno.test("createOrGetSharedLink throws when the list fallback finds no existing link", async () => {
  await withMocks({
    routes: {
      "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings": {
        status: 409,
        body: JSON.stringify({ error: { ".tag": "shared_link_already_exists" } }),
      },
      "https://api.dropboxapi.com/2/sharing/list_shared_links": {
        body: JSON.stringify({ links: [] }),
      },
    },
  }, async () => {
    await assertRejects(
      () => createOrGetSharedLink("AT", "/a/song.mp3"),
      Error,
      "no existing link found",
    );
  });
});

Deno.test("createOrGetSharedLink throws on a non-409 error status", async () => {
  await withMocks({
    routes: {
      "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings": {
        status: 500,
        body: "boom",
      },
    },
  }, async () => {
    await assertRejects(() => createOrGetSharedLink("AT", "/a/song.mp3"), Error, "500");
  });
});

// --- main: batch mode end-to-end (KeePass read + token refresh once, then per-path resolve) ---

Deno.test("main reads the stubbed KeePass key at run time, resolves paths, and never prints any secret", async () => {
  await withMocks({
    routes: {
      "https://api.dropboxapi.com/oauth2/token": { body: JSON.stringify({ access_token: "AT" }) },
      "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings": {
        body: JSON.stringify({ url: "https://www.dropbox.com/scl/fi/x/song.mp3?rlkey=k&dl=0" }),
      },
    },
  }, async (ctx) => {
    const code = await main([
      "/joshandmariamusic/a.mp3",
      "/home/joshua/Dropbox/joshandmariamusic/b.mp3",
    ]);
    assertEquals(code, 0);
    assertEquals(ctx.commands.length, 1);
    assertEquals(ctx.commands[0].cmd, "keepassxc-cli");
    assertStringIncludes(ctx.logs.join("\n"), "setlist: https://www.dropbox.com/scl/fi/x/song.mp3");
    assertStringIncludes(
      ctx.logs.join("\n"),
      "widget:  https://dl.dropboxusercontent.com/scl/fi/x/song.mp3",
    );
    assertNoSecretsPrinted(ctx);
  });
});

Deno.test("main stops with exit 1 and prints nothing secret when the KeePass entry is missing or the master password is wrong", async () => {
  await withMocks({
    keepass: { code: 1, stdout: DEFAULT_KEEPASS_STDOUT },
    routes: {},
  }, async (ctx) => {
    const code = await main(["/joshandmariamusic/a.mp3"]);
    assertEquals(code, 1);
    assertEquals(ctx.requests.length, 0);
    assertNoSecretsPrinted(ctx);
  });
});

Deno.test("main returns 1 and reports per-path when one path fails but others succeed", async () => {
  await withMocks({
    routes: {
      "https://api.dropboxapi.com/oauth2/token": { body: JSON.stringify({ access_token: "AT" }) },
      "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings": {
        body: JSON.stringify({ url: "https://www.dropbox.com/scl/fi/x/song.mp3?rlkey=k&dl=0" }),
      },
    },
  }, async (ctx) => {
    const code = await main(["/ok.mp3", "unclassifiable/path.mp3"]);
    assertEquals(code, 1);
    assertNoSecretsPrinted(ctx);
  });
});

Deno.test("main returns 1 without a network or KeePass call when no paths are given", async () => {
  await withMocks({ routes: {} }, async (ctx) => {
    assertEquals(await main([]), 1);
    assertEquals(ctx.commands.length, 0);
    assertEquals(ctx.requests.length, 0);
  });
});

Deno.test("main returns 1 and prints nothing secret when the token refresh itself fails", async () => {
  await withMocks({
    routes: {
      "https://api.dropboxapi.com/oauth2/token": {
        status: 401,
        body: `invalid_grant ${STUB_SECRETS.refreshToken}`,
      },
    },
  }, async (ctx) => {
    assertEquals(await main(["/a.mp3"]), 1);
    assertNoSecretsPrinted(ctx);
  });
});

Deno.test("readStdinPaths returns empty array when stdin is a terminal and parses newline-delimited paths when piped", async () => {
  const terminalStdin = {
    isTerminal: () => true,
    readable: ReadableStream.from([new TextEncoder().encode("/ignored.mp3\n")]),
  };
  assertEquals(await readStdinPaths(terminalStdin), []);

  const pipedStdin = {
    isTerminal: () => false,
    readable: ReadableStream.from([new TextEncoder().encode(" /a.mp3 \n\n /b.mp3 \n")]),
  };
  assertEquals(await readStdinPaths(pipedStdin), ["/a.mp3", "/b.mp3"]);
});

Deno.test("runCli preserves piped stdin paths while reading KeePass master password from independent ttyPath", async () => {
  await withTempPasswordFile("synth-master-pass", async (ttyFile) => {
    await withMocks({
      keepass: { expectedPassword: "synth-master-pass" },
      routes: {
        "https://api.dropboxapi.com/oauth2/token": {
          body: JSON.stringify({ access_token: "AT-BATCH" }),
        },
        "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings": [
          { body: JSON.stringify({ url: "https://www.dropbox.com/scl/fi/1/a.mp3?rlkey=ka&dl=0" }) },
          { body: JSON.stringify({ url: "https://www.dropbox.com/scl/fi/2/b.mp3?rlkey=kb&dl=0" }) },
        ],
      },
    }, async (ctx) => {
      const pipedStdin = {
        isTerminal: () => false,
        readable: ReadableStream.from([new TextEncoder().encode("/a.mp3\n/b.mp3\n")]),
      };
      const code = await runCli(["--"], pipedStdin, { ttyPath: ttyFile });
      assertEquals(code, 0);
      assertStringIncludes(ctx.logs.join("\n"), "/a.mp3 -> /a.mp3");
      assertStringIncludes(ctx.logs.join("\n"), "/b.mp3 -> /b.mp3");
      assertNoSecretsPrinted(ctx);
    });
  });
});

Deno.test("CLI entry point with piped batch paths reads master password from /dev/tty in a PTY instead of exhausted stdin", async () => {
  const cliUrl = new URL("../src/dropbox-link/dropbox_link_cli.ts", import.meta.url).pathname;
  const pyScript = [
    "import fcntl, os, pty, select, stat, subprocess, sys, tempfile, termios",
    "with tempfile.TemporaryDirectory() as temp_dir:",
    "    fake_bin_dir = os.path.join(temp_dir, 'bin')",
    "    os.mkdir(fake_bin_dir)",
    "    fake_keepass = os.path.join(fake_bin_dir, 'keepassxc-cli')",
    "    with open(fake_keepass, 'w', encoding='utf-8') as f:",
    "        f.write('\\n'.join([",
    "            '#!/bin/sh',",
    '            \'printf "Enter password to unlock %s: " "$4" >&2\',',
    "            'IFS= read -r pw',",
    '            \'if [ "$pw" != "synth-pty-pass" ]; then\',',
    "            '  printf \"Error while reading the database: Invalid credentials were provided\\\\n\" >&2',",
    "            '  exit 1',",
    "            'fi',",
    "            'printf \"Title: webjam-setlist-links\\\\nUserName: kp-app-key-123\\\\nPassword: kp-app-secret-456\\\\nNotes: kp-refresh-token-789\\\\n\"',",
    "        ]) + '\\n')",
    "    os.chmod(fake_keepass, stat.S_IRWXU)",
    "    preload_path = os.path.join(temp_dir, 'preload_fetch.ts')",
    "    with open(preload_path, 'w', encoding='utf-8') as f:",
    "        f.write('\\n'.join([",
    '            "globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {",',
    "            \"  const url = typeof input === 'string' ? input : input.toString();\",",
    "            \"  if (url.endsWith('/oauth2/token')) {\",",
    "            \"    return Promise.resolve(new Response(JSON.stringify({ access_token: 'AT-PTY' }), { status: 200 }));\",",
    '            "  }",',
    "            \"  if (url.endsWith('/create_shared_link_with_settings')) {\",",
    '            "    const body = init?.body ? JSON.parse(String(init.body)) : {};",',
    "            \"    const name = String(body.path || '/song.mp3').replace(/^\\\\/+/, '');\",",
    '            "    return Promise.resolve(new Response(JSON.stringify({ url: `https://www.dropbox.com/scl/fi/id/${name}?rlkey=rk&dl=0` }), { status: 200 }));",',
    '            "  }",',
    "            \"  return Promise.resolve(new Response('not found', { status: 404 }));\",",
    '            "}) as typeof fetch;",',
    "        ]) + '\\n')",
    "    master, slave = pty.openpty()",
    "    def setup_ctty():",
    "        os.setsid()",
    "        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)",
    "    env = dict(os.environ)",
    "    env['PATH'] = fake_bin_dir + ':' + env.get('PATH', '')",
    "    env['DROPBOX_KEEPASS_DB'] = os.path.join(temp_dir, 'synth.kdbx')",
    "    proc = subprocess.Popen(",
    "        [sys.argv[1], 'run', '--preload', preload_path, '--allow-net=api.dropboxapi.com', '--allow-env=HOME,DROPBOX_KEEPASS_DB,DROPBOX_KEEPASS_ENTRY', '--allow-read=/dev/tty', '--allow-run=keepassxc-cli', sys.argv[2], '--'],",
    "        stdin=subprocess.PIPE,",
    "        stdout=subprocess.PIPE,",
    "        stderr=slave,",
    "        env=env,",
    "        preexec_fn=setup_ctty,",
    "        close_fds=True,",
    "    )",
    "    os.close(slave)",
    "    assert proc.stdin is not None",
    "    proc.stdin.write(b'/a.mp3\\n/b.mp3\\n')",
    "    proc.stdin.close()",
    "    proc.stdin = None",
    "    prompt_buf = b''",
    "    while b'Enter password to unlock' not in prompt_buf:",
    "        rlist, _, _ = select.select([master], [], [], 10)",
    "        if not rlist:",
    "            break",
    "        chunk = os.read(master, 1024)",
    "        if not chunk:",
    "            break",
    "        prompt_buf += chunk",
    "    os.write(master, b'synth-pty-pass\\n')",
    "    out, _ = proc.communicate(timeout=10)",
    "    os.close(master)",
    "    sys.stdout.write(out.decode())",
    "    sys.exit(proc.returncode)",
  ].join("\n");

  const { code, stdout, stderr } = await new Deno.Command("python3", {
    args: [
      "-c",
      pyScript,
      Deno.execPath(),
      cliUrl,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const outText = new TextDecoder().decode(stdout);
  const errText = new TextDecoder().decode(stderr);
  assertEquals(code, 0, `Expected exit 0, got ${code}. stderr: ${errText}\nstdout: ${outText}`);
  assertStringIncludes(outText, "/a.mp3 -> /a.mp3");
  assertStringIncludes(outText, "/b.mp3 -> /b.mp3");
  assertStringIncludes(outText, "setlist: https://www.dropbox.com/scl/fi/id/a.mp3?rlkey=rk&dl=0");
  assertStringIncludes(outText, "setlist: https://www.dropbox.com/scl/fi/id/b.mp3?rlkey=rk&dl=0");
  assert(!outText.includes("kp-app-key-123"));
  assert(!outText.includes("kp-app-secret-456"));
  assert(!outText.includes("kp-refresh-token-789"));
});
