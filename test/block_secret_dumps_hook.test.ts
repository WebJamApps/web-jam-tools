// block_secret_dumps_hook.test.ts — web-jam-tools#257
//
// Exercises hooks/block-secret-dumps.sh's cp/test exception end-to-end by
// actually shelling out to it (Deno.Command) with mocked PreToolUse JSON on
// stdin, the same shape Claude Code's hook runner feeds it. This is the only
// reliable way to test a bash script's behavior — re-implementing its
// regexes in TypeScript would test a copy, not the real guard.
//
// A secret-file substring (".env") appears throughout this file's fixture
// commands, which is exactly what the guard matches on. Because this file is
// executed via `deno test`/`deno task test` (a Deno subprocess), not as a
// Claude Code Bash tool call, it never passes through the *installed*
// PreToolUse hook itself — only through the copy of the script under test.

import { assertEquals } from "@std/assert";

const SCRIPT_PATH = new URL("../hooks/block-secret-dumps.sh", import.meta.url).pathname;

interface RunResult {
  code: number;
  stderr: string;
}

async function runHook(command: string): Promise<RunResult> {
  const input = JSON.stringify({ tool_input: { command } });
  const cmd = new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code, stderr } = await child.output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

// --- newly allowed: cp ---

Deno.test("cp .env <dest> is allowed", async () => {
  const res = await runHook("cp .env /tmp/worktree/.env");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("cp .env.test <dest> is allowed", async () => {
  const res = await runHook("cp .env.test /tmp/worktree/.env.test");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("cp credentials.json <dest> is allowed (exception applies to the whole secret-file match, not just .env)", async () => {
  const res = await runHook("cp credentials.json /tmp/worktree/credentials.json");
  assertEquals(res.code, 0, res.stderr);
});

// --- newly allowed: test / [ existence checks ---

Deno.test("test -f .env is allowed", async () => {
  const res = await runHook("test -f .env");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("test -e .env is allowed", async () => {
  const res = await runHook("test -e .env");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("[ -f .env ] is allowed", async () => {
  const res = await runHook("[ -f .env ]");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("[ -e .env ] is allowed", async () => {
  const res = await runHook("[ -e .env ]");
  assertEquals(res.code, 0, res.stderr);
});

// --- still blocked: content-dumping forms ---

Deno.test("cat .env is still blocked", async () => {
  const res = await runHook("cat .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("head .env is still blocked", async () => {
  const res = await runHook("head .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("grep foo .env is still blocked", async () => {
  const res = await runHook("grep foo .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("cat .env.test is still blocked (suffixed secret file, not just bare .env)", async () => {
  const res = await runHook("cat .env.test");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("cat .env.local is still blocked (suffixed secret file)", async () => {
  const res = await runHook("cat .env.local");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("echo $(cat .env) is still blocked (command substitution dump)", async () => {
  const res = await runHook("echo $(cat .env)");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- still blocked: cp/test forms that can still exfiltrate ---

Deno.test("cp .env /dev/stdout is still blocked (writes contents to stdout)", async () => {
  const res = await runHook("cp .env /dev/stdout");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("cp .env /proc/self/fd/1 is still blocked (proc fd alias for stdout)", async () => {
  const res = await runHook("cp .env /proc/self/fd/1");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("cp .env /proc/1234/fd/2 is still blocked (proc fd alias for another process' stderr)", async () => {
  const res = await runHook("cp .env /proc/1234/fd/2");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("cp .env /dev/tty is still blocked (writes contents to the terminal)", async () => {
  const res = await runHook("cp .env /dev/tty");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("cp .env /tmp/seed.env is still allowed (plain destination, not a proc fd or tty)", async () => {
  const res = await runHook("cp .env /tmp/seed.env");
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("cp .env - | cat is still blocked (piped)", async () => {
  const res = await runHook("cp .env - | cat");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("test -f .env && cat .env is still blocked (chained dump)", async () => {
  const res = await runHook("test -f .env && cat .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- web-jam-tools#272: narrowed SHELL_OP — quoted <, > and | are literal ---
//
// These characters reach the matcher only AFTER shlex has consumed the quoting,
// so one still present inside a token proves it was quoted and cannot act as a
// shell operator. Keeping prose in scope because it contained a markdown table
// was pure false-positive. `$(` and backticks still keep a value in scope.

Deno.test("a prose flag whose value has a markdown table pipe is still treated as prose", async () => {
  const res = await runHook(
    `gh issue create --title "rotate creds" --body "| file | status |"`,
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("a prose value naming a secret file alongside a table pipe is allowed", async () => {
  const res = await runHook(
    `gh issue create --body "| ~/.bashrc | needs rotating |"`,
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("a prose value with a blockquote > naming a secret file is allowed", async () => {
  const res = await runHook(
    `gh issue create --body "> the .env file holds the key"`,
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("but a prose value with real command substitution stays IN SCOPE and is blocked", async () => {
  const res = await runHook('gh issue create --body "$(cat .env)"');
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- web-jam-tools#272: echoing a credential-NAMED variable ---
//
// The 2026-07-26 leak was not a file dump at all — it was a presence check:
//   echo "${TOK:+SET (value hidden)}${TOK:-NOT SET}"
// `:+` fires when SET and expands to the LITERAL; `:-` fires when UNSET but
// expands to the VALUE whenever the var IS set. Writing both halves on one
// line always prints the secret. No rule in this guard covered that shape,
// so it was allowed — correctly, per the rules as written.

Deno.test("the exact 2026-07-26 leak — :+ and :- on one line — is blocked", async () => {
  const res = await runHook(
    `bash -ic 'echo "\${DENO_DEPLOY_TOKEN:+SET (value hidden)}\${DENO_DEPLOY_TOKEN:-NOT SET}"'`,
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("plain echo of a *_TOKEN variable is blocked", async () => {
  const res = await runHook('echo "$GH_TOKEN"');
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("unbraced echo of a token variable is blocked", async () => {
  const res = await runHook("echo $DROPBOX_REFRESH_TOKEN");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("printf of a *_SECRET_* variable is blocked", async () => {
  const res = await runHook('printf "%s" "${AWS_SECRET_ACCESS_KEY}"');
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("a :- default on an API key is blocked (that is the value-expanding half)", async () => {
  const res = await runHook('echo "key=${GOOGLE_API_KEY:-none}"');
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("PASSWORD-named variables are covered too", async () => {
  const res = await runHook('echo "${DB_PASSWORD}"');
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- must stay allowed: CONSUMING a secret is normal work; only OUTPUT is barred ---

Deno.test("passing a token to curl -u still works (documented CircleCI idiom)", async () => {
  const res = await runHook(
    'curl -s -u "$CIRCLECI_TOKEN:" https://circleci.com/api/v1.1/me',
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test('the safe presence check [ -n "$VAR" ] && echo SET is allowed', async () => {
  const res = await runHook(
    '[ -n "$DENO_DEPLOY_TOKEN" ] && echo SET || echo "NOT SET"',
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("${VAR:+SET} alone is allowed — :+ expands to the literal, never the value", async () => {
  const res = await runHook('echo "${DENO_DEPLOY_TOKEN:+SET}"');
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("${#VAR} length check is allowed", async () => {
  const res = await runHook('echo "${#GH_TOKEN}"');
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("echoing a non-credential variable is untouched", async () => {
  const res = await runHook('echo "$HOME/$USER"');
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("a plain echo with no expansion is untouched", async () => {
  const res = await runHook('echo "hello world"');
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("test -f .env; cat .env is still blocked (chained via semicolon)", async () => {
  const res = await runHook("test -f .env; cat .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("cp .env $(mktemp) is still blocked (command substitution)", async () => {
  const res = await runHook("cp .env $(mktemp)");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- still blocked: other ops on secret files (not just cp/test) ---

Deno.test("ln -s .env /tmp/x is still blocked", async () => {
  const res = await runHook("ln -s .env /tmp/x");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("mv .env /tmp/x is still blocked", async () => {
  const res = await runHook("mv .env /tmp/x");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("stat .env is still blocked", async () => {
  const res = await runHook("stat .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("rm .env is still blocked", async () => {
  const res = await runHook("rm .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- still blocked: whole-environment / whole-config dumps (unrelated to
// the filename-match branch, but must remain intact) ---

Deno.test("bare env is still blocked (whole-environment dump)", async () => {
  const res = await runHook("env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("bare printenv is still blocked (whole-environment dump)", async () => {
  const res = await runHook("printenv");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("bare heroku config is still blocked (whole-config dump)", async () => {
  const res = await runHook("heroku config -a myapp");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("rclone config show is still blocked", async () => {
  const res = await runHook("rclone config show gdrive");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- web-jam-tools#261: prose mentions are allowed, operations still block ---

Deno.test("gh issue create --body naming .env / rclone config show as examples is allowed", async () => {
  const res = await runHook(
    `gh issue create --title "hook over-fires" --body "This documents examples like cat .env, rclone config show, and heroku config that stay blocked."`,
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("gh issue create --body-file, fed by a heredoc mentioning secrets in prose, is allowed", async () => {
  const res = await runHook(
    [
      "cat > /tmp/note.md <<'EOF'",
      "Examples of blocked commands: cat .env, rclone config show gdrive, heroku config -a myapp.",
      "EOF",
      'gh issue create --title "x" --body-file /tmp/note.md',
    ].join("\n"),
  );
  assertEquals(res.code, 0, res.stderr);
});

// BEHAVIOUR CHANGE (web-jam-tools#272). This previously asserted `code, 0`:
// heredoc bodies were stripped unconditionally, so a python payload mentioning
// .env was allowed. That was a bypass — a heredoc fed to an INTERPRETER is
// executed, so `python3 <<EOF / print(open('.env').read()) / EOF` was invisible
// to every rule in this guard. The normalizer now keeps interpreter-fed bodies
// in scope, which necessarily also catches a benign mention like this one.
// Blocking prose inside an executable payload is the safe direction; rephrase
// or write the note to a file instead.
Deno.test("a mention of a secret file inside an EXECUTED python heredoc is blocked", async () => {
  const res = await runHook(
    [
      "python3 <<'EOF'",
      'note = "remember: .env holds secrets, back it up safely"',
      "print(note)",
      "EOF",
    ].join("\n"),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("the real bypass — reading a secret file inside a bash heredoc — is blocked", async () => {
  const res = await runHook(
    ["bash <<'EOF'", "cat .env", "EOF"].join("\n"),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("a NON-executed heredoc body (gh issue --body-file -) is still allowed to mention a secret file", async () => {
  const res = await runHook(
    [
      "gh issue create --body-file - <<'EOF'",
      "the .env file needs rotating",
      "EOF",
    ].join("\n"),
  );
  assertEquals(res.code, 0, res.stderr);
});

// --- web-jam-tools#272 Layer 1: shell rc / profile / netrc / npmrc etc ---

Deno.test("tail ~/.bashrc is blocked (the 2026-07-25 Dropbox token leak)", async () => {
  const res = await runHook("tail -15 ~/.bashrc");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("cat ~/.zshrc is blocked", async () => {
  const res = await runHook("cat ~/.zshrc");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("grep in ~/.netrc is blocked", async () => {
  const res = await runHook("grep machine ~/.netrc");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("cat ~/.npmrc is blocked", async () => {
  const res = await runHook("cat ~/.npmrc");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("cat gh hosts.yml is blocked", async () => {
  const res = await runHook("cat ~/.config/gh/hosts.yml");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("cat agy settings.json is blocked (the 2026-07-25 Google key leak)", async () => {
  const res = await runHook("cat ~/.gemini/antigravity-cli/settings.json");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- must stay allowed: WRITING to an rc file is normal work ---

Deno.test("appending an export to ~/.bashrc with >> is allowed", async () => {
  const res = await runHook(`echo 'export FOO=1' >> ~/.bashrc`);
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("appending a shell function to ~/.bashrc via heredoc is allowed", async () => {
  const res = await runHook(
    ["cat >> ~/.bashrc <<'EOF'", "myfunc() { echo hi; }", "EOF"].join("\n"),
  );
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("redirecting a secret file INTO something else is still blocked", async () => {
  const res = await runHook("cat .env > /tmp/copy");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("git commit -m mentioning a secret filename in prose is allowed", async () => {
  const res = await runHook('git commit -m "document .env.example handling for onboarding"');
  assertEquals(res.code, 0, res.stderr);
});

Deno.test("--body=<prose> single-token form is allowed", async () => {
  const res = await runHook(
    `gh issue create --title "x" --body="This documents examples like cat .env, rclone config show, and heroku config that stay blocked."`,
  );
  assertEquals(res.code, 0, res.stderr);
});

// --- regression: a quoted -c payload must not be treated as prose just
// because it contains whitespace (it's a real command, not a note being
// authored). An earlier version of the flag-value drop rule keyed on
// "does this quoted token contain whitespace" rather than "is this the
// value of a known prose flag", which silently let bash -c/sh -c/etc.
// payloads bypass the guard entirely. ---

Deno.test("bash -c reading a secret file is still blocked (not a prose flag)", async () => {
  const res = await runHook(`bash -c "cat .env"`);
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("sh -c running a whole-config dump is still blocked (not a prose flag)", async () => {
  const res = await runHook(`sh -c 'heroku config -a myapp'`);
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("a non-shell interpreter's -c payload naming a secret file is still blocked", async () => {
  const res = await runHook(
    `python3 -c "data = open('.env').read(); print(data)"`,
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("a command-substitution read wrapped in double quotes is still blocked (not treated as prose)", async () => {
  const res = await runHook(`printf '%s' "$(< .env)"`);
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("source .env is still blocked", async () => {
  const res = await runHook("source .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test(". .env is still blocked (dot-source form)", async () => {
  const res = await runHook(". .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("echo .env is still blocked (command-position token, not prose)", async () => {
  const res = await runHook("echo .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("sed -n 1p .env is still blocked", async () => {
  const res = await runHook("sed -n 1p .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("awk '{print}' .env is still blocked", async () => {
  const res = await runHook("awk '{print}' .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("tee .env is still blocked", async () => {
  const res = await runHook("tee .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("cat < .env (input redirect) is still blocked", async () => {
  const res = await runHook("cat < .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("x=$(cat .env) (command substitution assignment) is still blocked", async () => {
  const res = await runHook("x=$(cat .env)");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("ls; cat .env (semicolon chain) is still blocked", async () => {
  const res = await runHook("ls; cat .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("ls && cat .env (chain) is still blocked", async () => {
  const res = await runHook("ls && cat .env");
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

Deno.test("a literal '<<' inside quoted prose on one line doesn't swallow a real dump on the next line", async () => {
  // If the quoted "<<" in line 1 were mistaken for a real heredoc marker, the
  // scanner would go hunting for a terminator and could consume line 2 (the
  // actual dangerous command) as "heredoc body" — silently hiding it from
  // every check below. It must not: dquote-tracking means "<<" inside quotes
  // is never treated as a marker, so line 2 stays intact and still blocks.
  const res = await runHook(
    ['echo "use << as a marker inside prose"', "cat .env"].join("\n"),
  );
  assertEquals(res.code, 2);
  assertBlocked(res.stderr);
});

// --- unrelated commands pass through untouched ---

Deno.test("a command with no secret-file reference is allowed", async () => {
  const res = await runHook("ls -la src/");
  assertEquals(res.code, 0, res.stderr);
});

function assertBlocked(stderr: string) {
  if (!stderr.includes("BLOCKED (secret-dump guard)")) {
    throw new Error(`expected BLOCKED message in stderr, got: ${stderr}`);
  }
}
