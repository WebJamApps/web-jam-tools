#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
import * as path from "@std/path";

export interface ReaperStartOptions {
  iniPath?: string;
  cardsPath?: string;
  claimFile?: string;
  lockFile?: string;
  heartbeatFile?: string;
  sessionName?: string;
  surface?: string;
  timeoutMs?: number;
  pgrepCmd?: string[];
  systemdCmd?: string[];
}

export async function reaperStart(options: ReaperStartOptions = {}): Promise<void> {
  const home = Deno.env.get("HOME") ?? "";
  const stateDir = Deno.env.get("CLAUDE_STATE_DIR") ??
    (home ? path.join(home, ".claude", "state") : "");

  const iniPath = options.iniPath ?? Deno.env.get("REAPER_INI_PATH") ??
    (home ? path.join(home, ".config", "REAPER", "reaper.ini") : "");
  const cardsPath = options.cardsPath ?? Deno.env.get("ASOUND_CARDS_PATH") ?? "/proc/asound/cards";
  const claimFile = options.claimFile ?? Deno.env.get("REAPER_CLAIM_FILE") ??
    (stateDir ? path.join(stateDir, "reaper-recording-claim.json") : "");
  const lockFile = options.lockFile ?? Deno.env.get("REAPER_LOCK_FILE") ??
    (stateDir ? path.join(stateDir, "reaper-session.lock") : "");
  const heartbeatFile = options.heartbeatFile ?? Deno.env.get("REAPER_HEARTBEAT_FILE") ??
    "/tmp/reaper_mcp/server.lock";

  const sessionName = options.sessionName ?? Deno.env.get("REAPER_SESSION_NAME") ??
    Deno.env.get("SESSION_NAME") ?? Deno.env.get("CLAUDE_SESSION_ID") ??
    Deno.env.get("CODEX_SESSION_ID") ?? `session-${Date.now()}`;
  const surface = options.surface ?? Deno.env.get("WJT_SURFACE") ?? "claude";
  const timeoutMs = options.timeoutMs ??
    (Deno.env.get("REAPER_START_TIMEOUT_MS")
      ? parseInt(Deno.env.get("REAPER_START_TIMEOUT_MS")!, 10)
      : 15000);

  // 1. Check lock file
  if (lockFile) {
    try {
      const lockStat = await Deno.stat(lockFile);
      if (lockStat.isFile) {
        // Try flock non-blocking check
        const flockCmd = new Deno.Command("flock", {
          args: ["-n", lockFile, "true"],
          stdout: "piped",
          stderr: "piped",
        });
        const flockRes = await flockCmd.output();
        if (!flockRes.success) {
          let holder = "another session";
          try {
            const content = (await Deno.readTextFile(lockFile)).trim();
            if (content) holder = content;
          } catch {
            // ignore read error
          }
          console.error(`REAPER lock is already held by ${holder}. Refusing to start.`);
          Deno.exit(1);
        }
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        // Ignore if lock file simply does not exist yet
      }
    }
  }

  // 2. Read and parse reaper.ini
  if (!iniPath) {
    console.error("Error: REAPER ini path is not configured.");
    Deno.exit(1);
  }
  let iniContent = "";
  try {
    iniContent = await Deno.readTextFile(iniPath);
  } catch (e) {
    console.error(`Error: Cannot read REAPER configuration file at ${iniPath}: ${e}`);
    Deno.exit(1);
  }

  const indevMatch = iniContent.match(/^alsa_indev\s*=\s*(.+)$/m);
  if (!indevMatch) {
    console.error(`Error: No alsa_indev audio interface configured in ${iniPath}`);
    Deno.exit(1);
  }

  const rawIndev = indevMatch[1].trim();
  const cardName = rawIndev.includes(":") ? rawIndev.split(":").pop()!.trim() : rawIndev;
  if (!cardName) {
    console.error(`Error: Invalid alsa_indev configuration in ${iniPath}: ${rawIndev}`);
    Deno.exit(1);
  }

  // 3. Read and check /proc/asound/cards
  let cardsContent = "";
  try {
    cardsContent = await Deno.readTextFile(cardsPath);
  } catch (e) {
    // Deno blocks direct readTextFile on /proc unless --allow-all is given; fallback to cat
    try {
      const catCmd = new Deno.Command("cat", {
        args: [cardsPath],
        stdout: "piped",
        stderr: "piped",
      });
      const catRes = await catCmd.output();
      if (catRes.success) {
        cardsContent = new TextDecoder().decode(catRes.stdout);
      } else {
        throw e;
      }
    } catch {
      console.error(`Error: Cannot read sound cards list at ${cardsPath}: ${e}`);
      Deno.exit(1);
    }
  }

  if (!cardsContent.includes(cardName)) {
    console.error(
      `Audio interface "${cardName}" is not connected. Please plug the interface in before starting REAPER.`,
    );
    Deno.exit(1);
  }

  // 4. Check if REAPER is already running
  const pgrepArgs = options.pgrepCmd ??
    (Deno.env.get("PGREP_CMD") ? Deno.env.get("PGREP_CMD")!.split(" ") : ["pgrep", "-x", "reaper"]);
  let isRunning = false;
  try {
    const pgrep = new Deno.Command(pgrepArgs[0], {
      args: pgrepArgs.slice(1),
      stdout: "piped",
      stderr: "piped",
    });
    const pgrepRes = await pgrep.output();
    isRunning = pgrepRes.success;
  } catch (e) {
    console.error(`Warning: Failed to execute pgrep command (${pgrepArgs.join(" ")}): ${e}`);
  }

  // 5. Start REAPER if not running
  if (!isRunning) {
    const systemdArgs = options.systemdCmd ??
      (Deno.env.get("SYSTEMD_RUN_CMD")
        ? Deno.env.get("SYSTEMD_RUN_CMD")!.split(" ")
        : ["systemd-run", "--user", "--unit=wjt-reaper", "--collect", "reaper"]);
    try {
      const runCmd = new Deno.Command(systemdArgs[0], {
        args: systemdArgs.slice(1),
        stdout: "piped",
        stderr: "piped",
      });
      const runRes = await runCmd.output();
      if (!runRes.success) {
        const errText = new TextDecoder().decode(runRes.stderr).trim();
        console.error(`Error starting REAPER via systemd-run: ${errText}`);
        Deno.exit(1);
      }
    } catch (e) {
      console.error(`Error executing systemd-run command: ${e}`);
      Deno.exit(1);
    }
  }

  // 6. Wait for fresh heartbeat file
  const startTime = Date.now();
  let heartbeatFresh = false;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const hbStat = await Deno.stat(heartbeatFile);
      if (hbStat.isFile) {
        const mtime = hbStat.mtime ? hbStat.mtime.getTime() : 0;
        // Fresh if modified within last 30s or after start time - 5s
        if (Date.now() - mtime < 30000 || mtime >= startTime - 5000) {
          heartbeatFresh = true;
          break;
        }
      }
    } catch {
      // File not found yet, keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (!heartbeatFresh) {
    console.error(`Error: Timed out waiting for fresh REAPER bridge heartbeat at ${heartbeatFile}`);
    Deno.exit(1);
  }

  // 7. Record recording claim
  if (claimFile) {
    await Deno.mkdir(path.dirname(claimFile), { recursive: true });
    const claimData = {
      session: sessionName,
      surface,
      claimed_at: new Date().toISOString(),
    };
    await Deno.writeTextFile(claimFile, JSON.stringify(claimData, null, 2) + "\n");
  }

  console.log(`REAPER is ready and recording claim recorded for ${sessionName} (${surface}).`);
}

if (import.meta.main) {
  await reaperStart();
}
