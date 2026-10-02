#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
import * as path from "@std/path";

export interface ReaperDoneOptions {
  claimFile?: string;
  surface?: string;
  codexMcpCmd?: string[];
  agyMcpCmd?: string[];
}

export async function reaperDone(options: ReaperDoneOptions = {}): Promise<void> {
  const home = Deno.env.get("HOME") ?? "";
  const stateDir = Deno.env.get("CLAUDE_STATE_DIR") ??
    (home ? path.join(home, ".claude", "state") : "");
  const claimFile = options.claimFile ?? Deno.env.get("REAPER_CLAIM_FILE") ??
    (stateDir ? path.join(stateDir, "reaper-recording-claim.json") : "");

  let claimContent: string | null = null;
  if (claimFile) {
    try {
      claimContent = await Deno.readTextFile(claimFile);
    } catch {
      claimContent = null;
    }
  }

  // If no claim exists (already cleared, or never set): no-op, exits 0
  if (!claimContent || claimContent.trim() === "") {
    console.log("No active REAPER recording claim found. Nothing to do.");
    return;
  }

  let claimData: { session?: string; surface?: string } = {};
  try {
    claimData = JSON.parse(claimContent);
  } catch {
    // Malformed claim content, proceed with clearing
  }

  const surface = options.surface ?? Deno.env.get("WJT_SURFACE") ?? claimData.surface ?? "claude";

  // 1. Clear recording claim
  try {
    await Deno.remove(claimFile);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      console.error(`Warning: Could not remove claim file ${claimFile}: ${e}`);
    }
  }

  // 2. Surface-specific unregistration
  if (surface === "codex") {
    const codexCmd = options.codexMcpCmd ??
      (Deno.env.get("CODEX_MCP_CMD")
        ? Deno.env.get("CODEX_MCP_CMD")!.split(" ")
        : ["codex", "mcp", "remove", "reaper"]);
    try {
      const cmd = new Deno.Command(codexCmd[0], {
        args: codexCmd.slice(1),
        stdout: "piped",
        stderr: "piped",
      });
      const res = await cmd.output();
      if (!res.success) {
        const err = new TextDecoder().decode(res.stderr).trim();
        console.error(`Warning: ${codexCmd.join(" ")} failed: ${err}`);
      }
    } catch (e) {
      console.error(`Warning: Could not run ${codexCmd.join(" ")}: ${e}`);
    }
  } else if (surface === "agy") {
    const agyCmd = options.agyMcpCmd ??
      (Deno.env.get("AGY_MCP_CMD")
        ? Deno.env.get("AGY_MCP_CMD")!.split(" ")
        : ["agy", "mcp", "disable", "reaper"]);
    try {
      const cmd = new Deno.Command(agyCmd[0], {
        args: agyCmd.slice(1),
        stdout: "piped",
        stderr: "piped",
      });
      const res = await cmd.output();
      if (!res.success) {
        const err = new TextDecoder().decode(res.stderr).trim();
        console.error(`Warning: ${agyCmd.join(" ")} failed: ${err}`);
      }
    } catch (e) {
      console.error(`Warning: Could not run ${agyCmd.join(" ")}: ${e}`);
    }
  } else {
    // Claude Code: clearing the claim is the whole job
  }

  console.log(`REAPER recording claim cleared for surface: ${surface}.`);
}

if (import.meta.main) {
  await reaperDone();
}
