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
  // Stateful like the real thing: each change lands in the file ufw keeps it in, which is what the
  // script reads back (ufw.conf, /etc/default/ufw, user.rules) under UBUNTU_HEALTH_ROOT.
  ufw: `r="$UBUNTU_HEALTH_ROOT"
case "$*" in
  "default deny incoming")
    mkdir -p "$r/etc/default"
    printf 'DEFAULT_INPUT_POLICY="DROP"\\n' > "$r/etc/default/ufw" ;;
  "allow in on tailscale0")
    mkdir -p "$r/etc/ufw"
    printf '### tuple ### allow any any 0.0.0.0/0 any 0.0.0.0/0 in_tailscale0\\n' >> "$r/etc/ufw/user.rules" ;;
  enable)
    mkdir -p "$r/etc/ufw"
    printf 'ENABLED=yes\\n' > "$r/etc/ufw/ufw.conf" ;;
esac`,
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

// A stock Ubuntu sshd_config: its first line reads the drop-in folder, then the commented default.
const SSHD_CONFIG_BODY = "Include /etc/ssh/sshd_config.d/*.conf\n#PasswordAuthentication yes\n" +
  "KbdInteractiveAuthentication no\nUsePAM yes\n";

async function seedSshdConfig(h: Harness, body = SSHD_CONFIG_BODY): Promise<void> {
  await Deno.mkdir(`${h.root}/etc/ssh/sshd_config.d`, { recursive: true });
  await Deno.writeTextFile(`${h.root}/etc/ssh/sshd_config`, body);
}

// The system after a clean run: ssh and the firewall set by apply, the login file in place.
async function applyAndSettle(h: Harness): Promise<void> {
  await seedSshdConfig(h);
  await apply(h);
  await writeEnvFile(h, 0o600);
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
  await applyAndSettle(h);
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

// The weekly job runs the INSTALLED checker, whose own copies are the only files beside it, so these
// cases invoke that copy (not the repository's) the way weekly.sh does.
const installedCheck = (h: Harness) => run(h, installed(h, "ubuntu-health.sh"), ["--check"]);

Deno.test("frame: the installed --check with nothing drifted -> exit 0", async () => {
  const h = await makeHarness();
  await applyAndSettle(h);
  const before = await snapshot(h.root);

  const r = await installedCheck(h);

  assertEquals(r.code, 0, r.stdout);
  assertStringIncludes(r.stdout, "no drift");
  assertEquals(await snapshot(h.root), before);
});

Deno.test("frame: the installed --check names a changed weekly.sh or gmail-send.sh, as the repository check does", async () => {
  for (const name of ["weekly.sh", "gmail-send.sh", "ubuntu-health.sh"]) {
    const h = await makeHarness();
    await apply(h);
    await writeEnvFile(h, 0o600);
    const path = installed(h, name);
    await Deno.writeTextFile(path, `${await Deno.readTextFile(path)}# appended\n`);

    for (const r of [await check(h), await installedCheck(h)]) {
      assert(r.code !== 0, `${name} change went unreported:\n${r.stdout}`);
      assertStringIncludes(r.stdout, "DRIFT job-files");
      assertStringIncludes(r.stdout, path);
    }
  }
});

Deno.test("frame: the installed --check names a changed unit file", async () => {
  const h = await makeHarness();
  await apply(h);
  await writeEnvFile(h, 0o600);
  const unit = `${h.root}${UNIT_DIR}/ubuntu-health-weekly.service`;
  await Deno.writeTextFile(unit, `${await Deno.readTextFile(unit)}# appended\n`);

  const r = await installedCheck(h);

  assert(r.code !== 0);
  assertStringIncludes(r.stdout, "DRIFT unit-files");
});

Deno.test("frame: the installed --check reports a missing or loosened checksum manifest", async () => {
  const h = await makeHarness();
  await apply(h);
  await writeEnvFile(h, 0o600);
  const manifest = installed(h, "manifest.sha256");

  await Deno.chmod(manifest, 0o666);
  const loose = await installedCheck(h);
  assert(loose.code !== 0);
  assertStringIncludes(loose.stdout, "DRIFT job-files");
  assertStringIncludes(loose.stdout, "expected 644");

  await Deno.remove(manifest);
  const missing = await installedCheck(h);
  assert(missing.code !== 0);
  assertStringIncludes(missing.stdout, "DRIFT job-files");
  assertStringIncludes(missing.stdout, "manifest.sha256 is missing");
});

Deno.test("frame: apply refuses to run from the installed copy, which would bless its own files", async () => {
  const h = await makeHarness();
  await apply(h);
  const before = await snapshot(h.root);

  const r = await run(h, installed(h, "ubuntu-health.sh"));

  assertEquals(r.code, 2);
  assertStringIncludes(r.stderr, "from the repository");
  assertEquals(await snapshot(h.root), before);
});

Deno.test("frame: apply records a checksum for every installed file", async () => {
  const h = await makeHarness();
  await apply(h);

  const manifest = await Deno.readTextFile(installed(h, "manifest.sha256"));
  for (
    const path of [
      `${LIB}/ubuntu-health.sh`,
      `${LIB}/weekly.sh`,
      `${LIB}/gmail-send.sh`,
      `${LIB}/ubuntu-health-weekly.service`,
      `${LIB}/ubuntu-health-weekly.timer`,
      `${UNIT_DIR}/ubuntu-health-weekly.service`,
      `${UNIT_DIR}/ubuntu-health-weekly.timer`,
    ]
  ) {
    assertStringIncludes(manifest, `  ${path}\n`);
  }
  assertEquals(manifest.includes(h.root), false, "the manifest must not hold the test root");
});

Deno.test("frame: the weekly job emails when a job file changes, found by the installed checker", async () => {
  const h = await makeHarness();
  await apply(h);
  await writeEnvFile(h, 0o600);
  const sender = installed(h, "gmail-send.sh");
  await Deno.writeTextFile(sender, `${await Deno.readTextFile(sender)}# appended\n`);

  await run(h, installed(h, "weekly.sh"));

  assertStringIncludes(await readLog(h), "DRIFT job-files");
  assert((await curlCalls(h)).length > 0, "the findings were not emailed");
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
  await applyAndSettle(h);

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

// --- SSH by key only, and a firewall that admits only Tailscale (web-jam-tools#1427) -------------

const SSH_DROPIN = "/etc/ssh/sshd_config.d/00-ubuntu-health.conf";
const UFW_CONF = "/etc/ufw/ufw.conf";
const UFW_RULES = "/etc/ufw/user.rules";

const ufwChanges = async (h: Harness) =>
  (await calls(h)).filter((l) => /^ufw (default|allow|enable|deny|delete|reset)/.test(l));
const sshRestarts = async (h: Harness) =>
  (await calls(h)).filter((l) => l.startsWith("systemctl restart"));

// A user.rules holding one tuple line, the way ufw writes it.
async function writeUfwRules(h: Harness, ...tuples: string[]): Promise<void> {
  await Deno.mkdir(`${h.root}/etc/ufw`, { recursive: true });
  await Deno.writeTextFile(
    `${h.root}${UFW_RULES}`,
    tuples.map((t) => `### tuple ### ${t}\n`).join(""),
  );
}

Deno.test("ssh: apply sets the firewall, the key-only login, and restarts ssh.service", async () => {
  const h = await makeHarness();
  const r = await apply(h);
  assertEquals(r.code, 0, r.stderr);

  const all = await calls(h);
  assert(all.includes("ufw default deny incoming"), all.join("\n"));
  assert(all.includes("ufw allow in on tailscale0"), all.join("\n"));
  assert(all.includes("ufw enable"), all.join("\n"));
  assert(all.includes("systemctl restart ssh.service"), all.join("\n"));
  const dropin = await Deno.readTextFile(`${h.root}${SSH_DROPIN}`);
  assertStringIncludes(dropin, "PasswordAuthentication no\n");
  // Allowing Tailscale comes before the firewall is switched on, so enabling it cuts nothing off.
  assert(all.indexOf("ufw allow in on tailscale0") < all.indexOf("ufw enable"));
  const owned = all.filter((l) => l.startsWith("chown root:root "));
  assert(owned.includes(`chown root:root ${h.root}${SSH_DROPIN}`));
});

Deno.test("ssh: a second apply with both already set makes no ufw or ssh change", async () => {
  const h = await makeHarness();
  await apply(h);
  const before = await snapshot(h.root);
  const callsBefore = (await calls(h)).length;

  const r = await apply(h);

  assertEquals(r.code, 0, r.stderr);
  assertEquals(await snapshot(h.root), before);
  assertEquals((await ufwChanges(h)).length, 3);
  assertEquals((await sshRestarts(h)).length, 1);
  const later = (await calls(h)).slice(callsBefore);
  assertEquals(later.filter((l) => l.startsWith("ufw ")), []);
  assertEquals(later.filter((l) => l.startsWith("systemctl restart")), []);
});

Deno.test("ssh: apply changes only what is not already right", async () => {
  const h = await makeHarness();
  await Deno.mkdir(`${h.root}/etc/ufw`, { recursive: true });
  await Deno.mkdir(`${h.root}/etc/default`, { recursive: true });
  await Deno.writeTextFile(`${h.root}${UFW_CONF}`, "ENABLED=yes\n");
  await Deno.writeTextFile(`${h.root}/etc/default/ufw`, 'DEFAULT_INPUT_POLICY="DROP"\n');
  await writeUfwRules(h, "allow any any 0.0.0.0/0 any 0.0.0.0/0 in_tailscale0");

  await apply(h);

  assertEquals(await ufwChanges(h), []);
});

Deno.test("ssh: --check after a clean apply -> no drift", async () => {
  const h = await makeHarness();
  await applyAndSettle(h);

  const r = await check(h);

  assertEquals(r.code, 0, r.stdout);
  assertStringIncludes(r.stdout, "no drift");
});

Deno.test("ssh: --check with ENABLED=no in ufw.conf -> firewall off", async () => {
  const h = await makeHarness();
  await applyAndSettle(h);
  await Deno.writeTextFile(`${h.root}${UFW_CONF}`, "ENABLED=no\n");

  const r = await check(h);

  assert(r.code !== 0);
  assertStringIncludes(r.stdout, "DRIFT firewall: firewall off");
});

Deno.test("ssh: --check with a rule for port 22 on another interface -> that interface is named", async () => {
  const h = await makeHarness();
  await applyAndSettle(h);
  const tailscale = "allow any any 0.0.0.0/0 any 0.0.0.0/0 in_tailscale0";
  await writeUfwRules(h, tailscale, "allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 in_wlp3s0");

  const r = await check(h);

  assert(r.code !== 0);
  assertStringIncludes(r.stdout, "DRIFT firewall: port 22 is admitted on wlp3s0");
});

Deno.test("ssh: --check names every way a rule can admit port 22 off Tailscale", async () => {
  const tailscale = "allow any any 0.0.0.0/0 any 0.0.0.0/0 in_tailscale0";
  const cases: [string, string][] = [
    ["a rule for every interface", "allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 in"],
    ["an application profile", "allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 OpenSSH - in"],
    ["a rate-limited rule", "limit tcp 22 0.0.0.0/0 any 0.0.0.0/0 in_eth0"],
    ["a port range", "allow tcp 20:30 0.0.0.0/0 any 0.0.0.0/0 in_eth0"],
    ["a port list", "allow tcp 22,80 0.0.0.0/0 any 0.0.0.0/0 in_eth0"],
    ["every port on another interface", "allow any any 0.0.0.0/0 any 0.0.0.0/0 in_eth0"],
    ["a rule carrying a comment", "allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 in_eth0 comment=73736820"],
  ];
  for (const [label, tuple] of cases) {
    const h = await makeHarness();
    await applyAndSettle(h);
    await writeUfwRules(h, tailscale, tuple);

    const r = await check(h);

    assert(r.code !== 0, `${label} went unreported`);
    assertStringIncludes(r.stdout, "port 22 is admitted");
  }
});

Deno.test("ssh: --check leaves alone rules that do not admit port 22 off Tailscale", async () => {
  const h = await makeHarness();
  await applyAndSettle(h);
  await writeUfwRules(
    h,
    "allow any any 0.0.0.0/0 any 0.0.0.0/0 in_tailscale0",
    "allow tcp 80 0.0.0.0/0 any 0.0.0.0/0 in_eth0",
    "allow udp 22 0.0.0.0/0 any 0.0.0.0/0 in_eth0",
    "allow tcp 1714:1764 0.0.0.0/0 any 0.0.0.0/0 in_eth0",
    "deny tcp 22 0.0.0.0/0 any 0.0.0.0/0 in_eth0",
    "allow any any 0.0.0.0/0 any 0.0.0.0/0 in_lo",
    "route:allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 in_eth0_out_eth1",
  );

  const r = await check(h);

  assertEquals(r.code, 0, r.stdout);
});

Deno.test("ssh: --check with no rule for tailscale0, or no default deny -> drift named", async () => {
  const h = await makeHarness();
  await applyAndSettle(h);
  await writeUfwRules(h);
  await Deno.writeTextFile(`${h.root}/etc/default/ufw`, 'DEFAULT_INPUT_POLICY="ACCEPT"\n');

  const r = await check(h);

  assert(r.code !== 0);
  assertStringIncludes(r.stdout, "DRIFT firewall: no rule allows incoming traffic on tailscale0");
  assertStringIncludes(r.stdout, "DRIFT firewall: incoming traffic is not denied by default");
});

Deno.test("ssh: --check with PasswordAuthentication yes effective -> drift named", async () => {
  // A later drop-in cannot override ours, but a setting read BEFORE the Include line can.
  const before = "PasswordAuthentication yes\nInclude /etc/ssh/sshd_config.d/*.conf\n";
  const h = await makeHarness();
  await seedSshdConfig(h, before);
  await apply(h);
  await writeEnvFile(h, 0o600);

  const r = await check(h);

  assert(r.code !== 0);
  assertStringIncludes(r.stdout, 'DRIFT ssh: PasswordAuthentication is effectively "yes"');
  assertStringIncludes(r.stdout, "/etc/ssh/sshd_config");
});

Deno.test("ssh: --check with our drop-in changed to yes -> drift named", async () => {
  const h = await makeHarness();
  await applyAndSettle(h);
  await Deno.writeTextFile(`${h.root}${SSH_DROPIN}`, "PasswordAuthentication yes\n");

  const r = await check(h);

  assert(r.code !== 0);
  assertStringIncludes(r.stdout, 'DRIFT ssh: PasswordAuthentication is effectively "yes"');
  assertStringIncludes(r.stdout, "DRIFT ssh: ");
});

Deno.test("ssh: the first value sshd reads wins, so our 00- drop-in beats a later one", async () => {
  const h = await makeHarness();
  await applyAndSettle(h);
  await Deno.writeTextFile(
    `${h.root}/etc/ssh/sshd_config.d/50-cloud-init.conf`,
    "PasswordAuthentication yes\n",
  );

  const r = await check(h);

  assertEquals(r.code, 0, r.stdout);
});

Deno.test("ssh: --check reports an sshd_config that never reads the drop-in folder", async () => {
  const h = await makeHarness();
  await seedSshdConfig(h, "#PasswordAuthentication yes\nUsePAM yes\n");
  await apply(h);
  await writeEnvFile(h, 0o600);

  const r = await check(h);

  assert(r.code !== 0);
  assertStringIncludes(r.stdout, 'DRIFT ssh: PasswordAuthentication is effectively "yes"');
});

Deno.test("ssh: --check reports a missing sshd_config and a missing firewall setup", async () => {
  const h = await makeHarness();
  await apply(h);
  await Deno.remove(`${h.root}${UFW_CONF}`);

  const r = await check(h);

  assert(r.code !== 0);
  assertStringIncludes(r.stdout, "DRIFT ssh: ");
  assertStringIncludes(r.stdout, "sshd_config is missing");
  assertStringIncludes(r.stdout, "DRIFT firewall: firewall off");
});

Deno.test("ssh: --check reports a changed or missing drop-in as a job-file style drift", async () => {
  const h = await makeHarness();
  await applyAndSettle(h);
  await Deno.remove(`${h.root}${SSH_DROPIN}`);

  const r = await check(h);

  assert(r.code !== 0);
  assertStringIncludes(r.stdout, `DRIFT ssh: ${h.root}${SSH_DROPIN} is missing`);
});

Deno.test("ssh: the installed --check catches a changed drop-in too", async () => {
  const h = await makeHarness();
  await applyAndSettle(h);
  await Deno.writeTextFile(`${h.root}${SSH_DROPIN}`, "PasswordAuthentication no\n# edited\n");

  const r = await installedCheck(h);

  assert(r.code !== 0);
  assertStringIncludes(r.stdout, "differs from the checksum recorded at install");
});

Deno.test("ssh: a firewall file only root can read is reported as not checked, not as drift", async () => {
  const h = await makeHarness();
  await applyAndSettle(h);
  await Deno.chmod(`${h.root}${UFW_RULES}`, 0o000);

  // Run as root, the file stays readable and there is nothing to report: the case needs a user.
  let readable = true;
  try {
    await Deno.readTextFile(`${h.root}${UFW_RULES}`);
  } catch {
    readable = false;
  }
  const r = await check(h);
  await Deno.chmod(`${h.root}${UFW_RULES}`, 0o600);

  if (!readable) {
    assertEquals(r.code, 0, r.stdout);
    assertStringIncludes(r.stdout, "not checked without sudo");
  }
});

Deno.test("ssh: WSL mode skips the step, says so, and touches no ssh or firewall file", async () => {
  const h = await makeHarness({ STUB_VIRT: "wsl" });

  const applied = await apply(h);
  assertEquals(applied.code, 0, applied.stderr);
  assertStringIncludes(applied.stdout, "skipped: SSH and firewall");
  assertEquals(await ufwChanges(h), []);
  assertEquals(await sshRestarts(h), []);
  for (const path of ["/etc/ssh", "/etc/ufw", "/etc/default"]) {
    let found = true;
    try {
      await Deno.stat(`${h.root}${path}`);
    } catch {
      found = false;
    }
    assertEquals(found, false, `${path} exists`);
  }

  await writeEnvFile(h, 0o600);
  const checked = await check(h);
  assertEquals(checked.code, 0, checked.stdout);
  assertStringIncludes(checked.stdout, "skipped: SSH and firewall");
  assertStringIncludes(checked.stdout, "no drift");
});

Deno.test("ssh: docs/scripts.md describes the key-only login and the Tailscale-only firewall", async () => {
  const docs = await Deno.readTextFile(`${REPO_ROOT}docs/scripts.md`);
  assertStringIncludes(docs, "PasswordAuthentication no");
  assertStringIncludes(docs, "tailscale0");
});
