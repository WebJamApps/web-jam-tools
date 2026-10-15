// ubuntu_health.test.ts — web-jam-tools#1426
//
// Exercises scripts/ubuntu-health.sh (the frame: WSL detection, root-owned copies, the weekly
// timer, the --check drift check) and the weekly job's Gmail send-only sender, without touching the
// real system: UBUNTU_HEALTH_ROOT points at a temporary folder standing in for "/", and the first
// folder on PATH holds stub commands that log each call and return what the case needs.
// Every credential here is a synthetic placeholder.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = `${REPO_ROOT}scripts/ubuntu-health.sh`;
const LIB = "/usr/local/lib/ubuntu-health";
const UNIT_DIR = "/etc/systemd/system";
const ENV_PATH = "/etc/ubuntu-health/gmail-send.env";
const ENV_BODY = "GMAIL_CLIENT_ID=fake-client-id\nGMAIL_CLIENT_SECRET=fake-client-secret\n" +
  "GMAIL_REFRESH_TOKEN=fake-refresh-token\n";

// Each stub appends "<name> <args...>" to $STUB_LOG. Behavior comes from STUB_* variables.
const STUBS: Record<string, string> = {
  "systemd-detect-virt": `case "$STUB_VIRT" in
  FAIL) exit 127 ;;
  none) echo none; exit 1 ;;
  *) echo "$STUB_VIRT" ;;
esac`,
  // Stateful like the real thing: "enable" is what makes is-enabled / is-active answer yes.
  systemctl: `case "$1" in
  enable) touch "$STUB_STATE/timer-enabled" ;;
  is-enabled) [ -e "$STUB_STATE/timer-enabled" ] && echo enabled || { echo disabled; exit 1; } ;;
  is-active) [ -e "$STUB_STATE/timer-enabled" ] && echo active || { echo inactive; exit 3; } ;;
esac`,
  chown: "",
  "apt-get": "",
  dpkg: "",
  snap: "",
  flatpak: "",
  docker: "",
  ufw: "",
  "ubuntu-drivers": "",
  "powershell.exe": "",
  // curl reads the secrets from stdin (-K -); the stub keeps them out of the logged arguments.
  curl: `cat >> "$STUB_STATE/curl-stdin"
for a in "$@"; do
  prev_is_data=\${prev_is_data:-0}
  if [ "$prev_is_data" = 1 ]; then cp "\${a#@}" "$STUB_STATE/sent.json"; fi
  prev_is_data=0
  [ "$a" = "--data-binary" ] && prev_is_data=1
done
case "$*" in
  *oauth2.googleapis.com/token*)
    if [ "$STUB_CURL_REFRESH" = error ]; then
      printf '{\\n  "error": "invalid_grant",\\n  "error_description": "Bad Request"\\n}\\n'
    else
      printf '{\\n  "access_token": "fake-access-token",\\n  "expires_in": 3599\\n}\\n'
    fi ;;
  *messages/send*) printf '{\\n  "id": "fake-message-id"\\n}\\n' ;;
esac`,
};

interface Harness {
  root: string;
  state: string;
  log: string;
  env: Record<string, string>;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function makeHarness(
  vars: Record<string, string> = {},
): Promise<Harness> {
  const root = await Deno.makeTempDir({ prefix: "wjt-uh-root-" });
  const state = await Deno.makeTempDir({ prefix: "wjt-uh-state-" });
  const bin = `${state}/bin`;
  await Deno.mkdir(bin);
  const log = `${state}/calls.log`;
  for (const [name, behavior] of Object.entries(STUBS)) {
    const body = `#!/usr/bin/env bash
printf '%s' "$(basename "$0")" >> "$STUB_LOG"
for a in "$@"; do printf ' %s' "$a" >> "$STUB_LOG"; done
echo >> "$STUB_LOG"
${behavior}
exit 0
`;
    // `exit 0` is reached only when a stub case does not exit on its own.
    await Deno.writeTextFile(`${bin}/${name}`, body);
    await Deno.chmod(`${bin}/${name}`, 0o755);
  }
  return {
    root,
    state,
    log,
    env: {
      PATH: `${bin}:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
      UBUNTU_HEALTH_ROOT: root,
      STUB_LOG: log,
      STUB_STATE: state,
      STUB_VIRT: "none",
      STUB_CURL_REFRESH: "ok",
      ...vars,
    },
  };
}

async function run(h: Harness, script: string, args: string[] = []): Promise<Run> {
  const out = await new Deno.Command("bash", {
    args: [script, ...args],
    env: h.env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
}

const apply = (h: Harness) => run(h, SCRIPT);
const check = (h: Harness) => run(h, SCRIPT, ["--check"]);
const installed = (h: Harness, name: string) => `${h.root}${LIB}/${name}`;

async function calls(h: Harness): Promise<string[]> {
  try {
    return (await Deno.readTextFile(h.log)).split("\n").filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

async function writeEnvFile(h: Harness, mode: number): Promise<void> {
  await Deno.mkdir(`${h.root}/etc/ubuntu-health`, { recursive: true });
  await Deno.writeTextFile(`${h.root}${ENV_PATH}`, ENV_BODY);
  await Deno.chmod(`${h.root}${ENV_PATH}`, mode);
}

// Every file under dir with its content and modification time.
async function snapshot(dir: string): Promise<Record<string, string>> {
  const seen: Record<string, string> = {};
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) Object.assign(seen, await snapshot(path));
    else {
      const info = await Deno.stat(path);
      seen[path] = `${info.mtime?.getTime()} ${await Deno.readTextFile(path)}`;
    }
  }
  return seen;
}

async function readLog(h: Harness): Promise<string> {
  return await Deno.readTextFile(`${h.root}/var/log/ubuntu-health.log`);
}

const curlCalls = async (h: Harness) => (await calls(h)).filter((l) => l.startsWith("curl "));

Deno.test("frame: systemd-detect-virt none -> laptop mode", async () => {
  const h = await makeHarness({ STUB_VIRT: "none" });
  const r = await check(h);
  assertStringIncludes(r.stdout, "mode: laptop");
});

Deno.test("frame: systemd-detect-virt wsl -> WSL mode", async () => {
  const h = await makeHarness({ STUB_VIRT: "wsl" });
  const r = await check(h);
  assertStringIncludes(r.stdout, "mode: wsl");
});

Deno.test("frame: systemd-detect-virt failing -> refuses, names the command, writes nothing", async () => {
  const h = await makeHarness({ STUB_VIRT: "FAIL" });
  const r = await apply(h);
  assert(r.code !== 0);
  assertStringIncludes(r.stderr, "systemd-detect-virt");
  assertEquals(Object.keys(await snapshot(h.root)), []);
});

Deno.test("frame: apply writes root-owned job, units and sender; nothing runs from repo or home", async () => {
  const h = await makeHarness();
  const r = await apply(h);
  assertEquals(r.code, 0, r.stderr);

  const owned = (await calls(h)).filter((l) => l.startsWith("chown root:root "));
  const jobFiles = [
    "ubuntu-health.sh",
    "weekly.sh",
    "gmail-send.sh",
    "ubuntu-health-weekly.service",
    "ubuntu-health-weekly.timer",
  ];
  const expected = [
    ...jobFiles.map((f) => `${h.root}${LIB}/${f}`),
    `${h.root}${UNIT_DIR}/ubuntu-health-weekly.service`,
    `${h.root}${UNIT_DIR}/ubuntu-health-weekly.timer`,
  ];
  for (const path of expected) {
    assert(owned.includes(`chown root:root ${path}`), `${path} was not chowned to root`);
  }

  const timer = await Deno.readTextFile(`${h.root}${UNIT_DIR}/ubuntu-health-weekly.timer`);
  assertStringIncludes(timer, "OnCalendar=Sun 03:00");
  assertStringIncludes(timer, "Persistent=true");
  const service = await Deno.readTextFile(`${h.root}${UNIT_DIR}/ubuntu-health-weekly.service`);
  assertStringIncludes(service, `ExecStart=${LIB}/weekly.sh\n`);
  assertStringIncludes(service, "IOSchedulingClass=idle");

  for (const path of expected) {
    const text = await Deno.readTextFile(path);
    for (const forbidden of [REPO_ROOT.replace(/\/$/, ""), "/home/", "$HOME", "~/"]) {
      assert(!text.includes(forbidden), `${path} refers to ${forbidden}`);
    }
  }
  assert((await Deno.stat(installed(h, "weekly.sh"))).mode! & 0o111, "weekly.sh is not executable");
  assertStringIncludes(r.stdout, "NOTE:"); // no email login yet
});

Deno.test("frame: a second apply changes nothing", async () => {
  const h = await makeHarness();
  await apply(h);
  const before = await snapshot(h.root);
  const callsBefore = (await calls(h)).length;

  const r = await apply(h);

  assertEquals(r.code, 0, r.stderr);
  assertEquals(await snapshot(h.root), before);
  assert(!r.stdout.includes("wrote "));
  const later = (await calls(h)).slice(callsBefore);
  assertEquals(later.filter((l) => /^systemctl (enable|daemon-reload)/.test(l)), []);
});

Deno.test("frame: --check with nothing drifted -> exit 0, nothing written", async () => {
  const h = await makeHarness();
  await apply(h);
  await writeEnvFile(h, 0o600);
  const before = await snapshot(h.root);

  const r = await check(h);

  assertEquals(r.code, 0, r.stdout);
  assertStringIncludes(r.stdout, "no drift");
  assertEquals(await snapshot(h.root), before);
});

Deno.test("frame: --check with one step drifted -> exit non-zero, the step named", async () => {
  const h = await makeHarness();
  await apply(h);
  await writeEnvFile(h, 0o600);
  await Deno.writeTextFile(installed(h, "weekly.sh"), "#!/usr/bin/env bash\necho tampered\n");

  const r = await check(h);

  assert(r.code !== 0);
  assertStringIncludes(r.stdout, "DRIFT job-files");
  for (const other of ["unit-files", "timer", "email-login"]) {
    assert(!r.stdout.includes(`DRIFT ${other}`), `${other} should not be reported:\n${r.stdout}`);
  }
});

Deno.test("frame: --check names the timer and unit files when they drift", async () => {
  const h = await makeHarness();
  await apply(h);
  await writeEnvFile(h, 0o600);
  await Deno.remove(`${h.state}/timer-enabled`);
  await Deno.remove(`${h.root}${UNIT_DIR}/ubuntu-health-weekly.timer`);

  const r = await check(h);

  assert(r.code !== 0);
  assertStringIncludes(r.stdout, "DRIFT timer");
  assertStringIncludes(r.stdout, "DRIFT unit-files");
});

Deno.test("frame: --check reports the email login missing", async () => {
  const h = await makeHarness();
  await apply(h);

  const r = await check(h);

  assert(r.code !== 0);
  assertStringIncludes(r.stdout, "DRIFT email-login");
  assertStringIncludes(r.stdout, "missing");
});

Deno.test("frame: --check reports a login file wider than 0600", async () => {
  const h = await makeHarness();
  await apply(h);
  await writeEnvFile(h, 0o640);

  const r = await check(h);

  assert(r.code !== 0);
  assertStringIncludes(r.stdout, "DRIFT email-login");
  assertStringIncludes(r.stdout, "wider than 600");
});

// Makes one thing drift so the weekly job has something to email about.
async function setUpWeeklyWithFinding(mode: number | null): Promise<Harness> {
  const h = await makeHarness();
  await apply(h);
  if (mode !== null) await writeEnvFile(h, mode);
  await Deno.remove(`${h.state}/timer-enabled`);
  return h;
}

Deno.test("email: login present at 0600 -> curl refreshes the token, then sends", async () => {
  const h = await setUpWeeklyWithFinding(0o600);

  const r = await run(h, installed(h, "weekly.sh"));

  assertEquals(r.code, 0, r.stderr);
  const curl = await curlCalls(h);
  assertEquals(curl.length, 2);
  assertStringIncludes(curl[0], "https://oauth2.googleapis.com/token");
  assertStringIncludes(curl[1], "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  const stdinSeen = await Deno.readTextFile(`${h.state}/curl-stdin`);
  assertStringIncludes(stdinSeen, "fake-refresh-token");
  for (const line of curl) {
    for (const secret of ["fake-refresh-token", "fake-client-secret", "fake-access-token"]) {
      assert(!line.includes(secret), `${secret} reached curl's command line`);
    }
  }

  const raw = (JSON.parse(await Deno.readTextFile(`${h.state}/sent.json`)) as { raw: string }).raw;
  const message = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
  assertStringIncludes(message, "To: joshua.v.sherman@gmail.com");
  const bodyBase64 = message.split("\r\n\r\n")[1].replace(/\s/g, "");
  const body = new TextDecoder().decode(Uint8Array.from(atob(bodyBase64), (c) => c.charCodeAt(0)));
  assertStringIncludes(body, "DRIFT timer");
  assertStringIncludes(body, "the laptop");
  assertStringIncludes(body, "sudo scripts/ubuntu-health.sh");
  assertStringIncludes(await readLog(h), "email sent");
});

Deno.test("email: the system is named as the desktop's WSL in WSL mode", async () => {
  const h = await setUpWeeklyWithFinding(0o600);
  h.env.STUB_VIRT = "wsl";

  await run(h, installed(h, "weekly.sh"));

  const raw = (JSON.parse(await Deno.readTextFile(`${h.state}/sent.json`)) as { raw: string }).raw;
  const message = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
  assertStringIncludes(message, "Subject: ubuntu-health: the desktop's WSL needs attention");
});

Deno.test("email: login file missing -> no email, and the job log says why", async () => {
  const h = await setUpWeeklyWithFinding(null);

  const r = await run(h, installed(h, "weekly.sh"));

  assert(r.code !== 0);
  assertEquals(await curlCalls(h), []);
  const log = await readLog(h);
  assertStringIncludes(log, "DRIFT email-login");
  assertStringIncludes(log, "email login missing");
});

Deno.test("email: login file wider than 0600 -> refused, never read, reason logged", async () => {
  const h = await setUpWeeklyWithFinding(0o640);

  const r = await run(h, installed(h, "weekly.sh"));

  assert(r.code !== 0);
  assertEquals(await curlCalls(h), []);
  assertStringIncludes(await readLog(h), "mode is 640, wider than 600");
});

Deno.test("email: token refresh error -> no send, error written to the job's log", async () => {
  const h = await setUpWeeklyWithFinding(0o600);
  h.env.STUB_CURL_REFRESH = "error";

  const r = await run(h, installed(h, "weekly.sh"));

  assert(r.code !== 0);
  const curl = await curlCalls(h);
  assertEquals(curl.length, 1);
  assertStringIncludes(curl[0], "oauth2.googleapis.com/token");
  const log = await readLog(h);
  assertStringIncludes(log, "token refresh");
  assertStringIncludes(log, "invalid_grant");
  assert(!log.includes("fake-refresh-token"));
});

Deno.test("frame: a week with no findings -> no curl call", async () => {
  const h = await makeHarness();
  await apply(h);
  await writeEnvFile(h, 0o600);

  const r = await run(h, installed(h, "weekly.sh"));

  assertEquals(r.code, 0, r.stderr);
  assertEquals(await curlCalls(h), []);
  assertStringIncludes(await readLog(h), "nothing to report");
});

Deno.test("frame: docs/scripts.md describes the script and --check", async () => {
  const docs = await Deno.readTextFile(`${REPO_ROOT}docs/scripts.md`);
  assertStringIncludes(docs, "scripts/ubuntu-health.sh");
  assertStringIncludes(docs, "--check");
});
