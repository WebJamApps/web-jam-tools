import { assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";

const REPO_ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const START_SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "reaper-start.ts");

Deno.test("reaper:start: starts REAPER via systemd-run and waits for heartbeat when card is present and not running", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "reaper-start-test-" });
  try {
    const iniPath = path.join(tmpDir, "reaper.ini");
    const cardsPath = path.join(tmpDir, "cards");
    const claimFile = path.join(tmpDir, "claim.json");
    const lockFile = path.join(tmpDir, "session.lock");
    const heartbeatFile = path.join(tmpDir, "server.lock");
    const systemdLog = path.join(tmpDir, "systemd.log");

    await Deno.writeTextFile(iniPath, "[REAPER]\nalsa_indev=plughw:Microphone\n");
    await Deno.writeTextFile(
      cardsPath,
      ` 0 [NVidia         ]: HDA-Intel - HDA NVidia\n 1 [Microphone     ]: USB-Audio - USB Microphone\n`,
    );

    // Mock pgrep: reaper is not running (exit 1)
    const mockPgrep = path.join(tmpDir, "mock-pgrep.sh");
    await Deno.writeTextFile(mockPgrep, "#!/usr/bin/env bash\nexit 1\n");
    await Deno.chmod(mockPgrep, 0o755);

    // Mock systemd-run: logs execution and touches the heartbeat file
    const mockSystemd = path.join(tmpDir, "mock-systemd.sh");
    await Deno.writeTextFile(
      mockSystemd,
      `#!/usr/bin/env bash
echo "SYSTEMD_STARTED: $@" >> "${systemdLog}"
touch "${heartbeatFile}"
exit 0
`,
    );
    await Deno.chmod(mockSystemd, 0o755);

    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", START_SCRIPT_PATH],
      env: {
        REAPER_INI_PATH: iniPath,
        ASOUND_CARDS_PATH: cardsPath,
        REAPER_CLAIM_FILE: claimFile,
        REAPER_LOCK_FILE: lockFile,
        REAPER_HEARTBEAT_FILE: heartbeatFile,
        PGREP_CMD: mockPgrep,
        SYSTEMD_RUN_CMD: mockSystemd,
        REAPER_SESSION_NAME: "test-session-start",
        WJT_SURFACE: "codex",
      },
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    assertEquals(output.success, true);
    assertEquals(output.code, 0);

    const stdout = new TextDecoder().decode(output.stdout);
    assertStringIncludes(stdout, "REAPER is ready and recording claim recorded");

    // Check systemd was called
    const systemdContent = await Deno.readTextFile(systemdLog);
    assertStringIncludes(systemdContent, "SYSTEMD_STARTED");

    // Check claim file was recorded
    const claimContent = await Deno.readTextFile(claimFile);
    const claim = JSON.parse(claimContent);
    assertEquals(claim.session, "test-session-start");
    assertEquals(claim.surface, "codex");
    assertEquals(typeof claim.claimed_at, "string");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("reaper:start: refuses when audio interface is absent from /proc/asound/cards", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "reaper-start-test-" });
  try {
    const iniPath = path.join(tmpDir, "reaper.ini");
    const cardsPath = path.join(tmpDir, "cards");
    const claimFile = path.join(tmpDir, "claim.json");

    await Deno.writeTextFile(iniPath, "[REAPER]\nalsa_indev=plughw:Microphone\n");
    await Deno.writeTextFile(
      cardsPath,
      ` 0 [NVidia         ]: HDA-Intel - HDA NVidia\n 1 [PCH            ]: HDA-Intel - HDA Intel PCH\n`,
    );

    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", START_SCRIPT_PATH],
      env: {
        REAPER_INI_PATH: iniPath,
        ASOUND_CARDS_PATH: cardsPath,
        REAPER_CLAIM_FILE: claimFile,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    assertEquals(output.success, false);
    assertEquals(output.code, 1);

    const stderr = new TextDecoder().decode(output.stderr);
    assertStringIncludes(
      stderr,
      'Audio interface "Microphone" is not connected. Please plug the interface in before starting REAPER.',
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("reaper:start: refuses when reaper.ini is unreadable (fails closed)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "reaper-start-test-" });
  try {
    const nonexistentIni = path.join(tmpDir, "missing-reaper.ini");
    const cardsPath = path.join(tmpDir, "cards");
    await Deno.writeTextFile(cardsPath, ` 0 [NVidia ]: ...\n`);

    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", START_SCRIPT_PATH],
      env: {
        REAPER_INI_PATH: nonexistentIni,
        ASOUND_CARDS_PATH: cardsPath,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    assertEquals(output.success, false);
    assertEquals(output.code, 1);

    const stderr = new TextDecoder().decode(output.stderr);
    assertStringIncludes(stderr, "Cannot read REAPER configuration file");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("reaper:start: refuses when /proc/asound/cards is unreadable (fails closed)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "reaper-start-test-" });
  try {
    const iniPath = path.join(tmpDir, "reaper.ini");
    const nonexistentCards = path.join(tmpDir, "missing-cards");
    await Deno.writeTextFile(iniPath, "[REAPER]\nalsa_indev=plughw:Microphone\n");

    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", START_SCRIPT_PATH],
      env: {
        REAPER_INI_PATH: iniPath,
        ASOUND_CARDS_PATH: nonexistentCards,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    assertEquals(output.success, false);
    assertEquals(output.code, 1);

    const stderr = new TextDecoder().decode(output.stderr);
    assertStringIncludes(stderr, "Cannot read sound cards list");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("reaper:start: leaves REAPER alone when already running and records claim", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "reaper-start-test-" });
  try {
    const iniPath = path.join(tmpDir, "reaper.ini");
    const cardsPath = path.join(tmpDir, "cards");
    const claimFile = path.join(tmpDir, "claim.json");
    const heartbeatFile = path.join(tmpDir, "server.lock");

    await Deno.writeTextFile(iniPath, "[REAPER]\nalsa_indev=plughw:Microphone\n");
    await Deno.writeTextFile(cardsPath, ` 0 [Microphone]: USB-Audio\n`);
    // Pre-create fresh heartbeat file
    await Deno.writeTextFile(heartbeatFile, "active");

    // Mock pgrep: REAPER is already running (exit 0)
    const mockPgrep = path.join(tmpDir, "mock-pgrep.sh");
    await Deno.writeTextFile(mockPgrep, "#!/usr/bin/env bash\necho 12345\nexit 0\n");
    await Deno.chmod(mockPgrep, 0o755);

    // Mock systemd: should NEVER be called
    const mockSystemd = path.join(tmpDir, "mock-systemd.sh");
    await Deno.writeTextFile(
      mockSystemd,
      `#!/usr/bin/env bash
echo "SHOULD NOT BE CALLED" >&2
exit 1
`,
    );
    await Deno.chmod(mockSystemd, 0o755);

    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", START_SCRIPT_PATH],
      env: {
        REAPER_INI_PATH: iniPath,
        ASOUND_CARDS_PATH: cardsPath,
        REAPER_CLAIM_FILE: claimFile,
        REAPER_HEARTBEAT_FILE: heartbeatFile,
        PGREP_CMD: mockPgrep,
        SYSTEMD_RUN_CMD: mockSystemd,
        REAPER_SESSION_NAME: "already-running-session",
        WJT_SURFACE: "claude",
      },
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    assertEquals(output.success, true);
    assertEquals(output.code, 0);

    const claimContent = await Deno.readTextFile(claimFile);
    const claim = JSON.parse(claimContent);
    assertEquals(claim.session, "already-running-session");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("reaper:start: refuses when lock is already held, naming the holding session", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "reaper-start-test-" });
  try {
    const iniPath = path.join(tmpDir, "reaper.ini");
    const cardsPath = path.join(tmpDir, "cards");
    const lockFile = path.join(tmpDir, "session.lock");

    await Deno.writeTextFile(iniPath, "[REAPER]\nalsa_indev=plughw:Microphone\n");
    await Deno.writeTextFile(cardsPath, ` 0 [Microphone]: USB-Audio\n`);

    // Spawn a holder process that holds flock and writes session name
    const holderScript = path.join(tmpDir, "holder.sh");
    await Deno.writeTextFile(
      holderScript,
      `#!/usr/bin/env bash
touch "${lockFile}"
exec 200<>"${lockFile}"
flock -n 200
printf "session-locked-by-someone\\n" >&200
echo READY
sleep 2
`,
    );
    await Deno.chmod(holderScript, 0o755);

    const holderCmd = new Deno.Command(holderScript, {
      stdout: "piped",
      stderr: "piped",
    });
    const holderProcess = holderCmd.spawn();

    const reader = holderProcess.stdout.getReader();
    let readyText = "";
    while (!readyText.includes("READY")) {
      const { value, done } = await reader.read();
      if (done) break;
      readyText += new TextDecoder().decode(value);
    }
    reader.releaseLock();

    try {
      const cmd = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", START_SCRIPT_PATH],
        env: {
          REAPER_INI_PATH: iniPath,
          ASOUND_CARDS_PATH: cardsPath,
          REAPER_LOCK_FILE: lockFile,
        },
        stdout: "piped",
        stderr: "piped",
      });
      const output = await cmd.output();
      assertEquals(output.success, false);
      assertEquals(output.code, 1);

      const stderr = new TextDecoder().decode(output.stderr);
      assertStringIncludes(
        stderr,
        "REAPER lock is already held by session-locked-by-someone. Refusing to start.",
      );
    } finally {
      try {
        holderProcess.kill("SIGTERM");
      } catch {
        // ignore
      }
      await holderProcess.status;
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
