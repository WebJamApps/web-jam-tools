import { matchClaudeScreen } from "./matchers.ts";
import type { CheckMode, CheckResult } from "./types.ts";

export interface TmuxCommander {
  startSession(
    socket: string,
    session: string,
    workDir: string,
    command: string,
  ): Promise<{ success: boolean; stderr?: string }>;
  capturePane(
    socket: string,
    session: string,
  ): Promise<{ success: boolean; output: string; stderr?: string }>;
  sendKeys(
    socket: string,
    session: string,
    keys: string,
    literal?: boolean,
  ): Promise<{ success: boolean; stderr?: string }>;
  killServer(socket: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export const defaultTmuxCommander: TmuxCommander = {
  async startSession(socket, session, workDir, command) {
    try {
      const p = new Deno.Command("tmux", {
        args: [
          "-L",
          socket,
          "new-session",
          "-d",
          "-s",
          session,
          "-x",
          "120",
          "-y",
          "40",
          "-c",
          workDir,
          command,
        ],
        stdout: "piped",
        stderr: "piped",
      });
      const out = await p.output();
      const stderr = new TextDecoder().decode(out.stderr);
      return { success: out.success, stderr };
    } catch (err) {
      return { success: false, stderr: err instanceof Error ? err.message : String(err) };
    }
  },

  async capturePane(socket, session) {
    try {
      const p = new Deno.Command("tmux", {
        args: ["-L", socket, "capture-pane", "-p", "-t", session],
        stdout: "piped",
        stderr: "piped",
      });
      const out = await p.output();
      const output = new TextDecoder().decode(out.stdout);
      const stderr = new TextDecoder().decode(out.stderr);
      return { success: out.success, output, stderr };
    } catch (err) {
      return {
        success: false,
        output: "",
        stderr: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async sendKeys(socket, session, keys, literal = false) {
    try {
      const args = ["-L", socket, "send-keys", "-t", session];
      if (literal) {
        args.push("-l");
      }
      args.push(keys);
      const p = new Deno.Command("tmux", {
        args,
        stdout: "piped",
        stderr: "piped",
      });
      const out = await p.output();
      const stderr = new TextDecoder().decode(out.stderr);
      return { success: out.success, stderr };
    } catch (err) {
      return { success: false, stderr: err instanceof Error ? err.message : String(err) };
    }
  },

  async killServer(socket) {
    try {
      const p = new Deno.Command("tmux", {
        args: ["-L", socket, "kill-server"],
        stdout: "null",
        stderr: "null",
      });
      await p.output();
    } catch {
      // Ignore cleanup failures
    }
  },

  sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

export interface ClaudeRunnerOptions {
  workDir?: string;
  timeoutMs?: number;
  tmuxSocket?: string;
  commander?: TmuxCommander;
}

/**
 * Runs a start check for a skill under Claude Code inside a throwaway tmux server.
 *
 * Requirements:
 * - Starts `claude --model haiku --settings <temporary settings file>`
 * - Inside a throwaway tmux server (`tmux -L <name>`) started in `~/WebJamApps/web-jam-tools`
 * - Prompt text and Enter key are sent as two separate `send-keys` calls
 * - Matchers: `● Skill(<name>)` or `Use skill "<name>"?` -> PASS
 * - Timeout without matching -> FAIL
 * - Fail closed if tmux/claude cannot start or exits non-zero -> FAIL with reason
 */
export async function runClaudeCheck(
  skillName: string,
  mode: CheckMode,
  prompt: string,
  options: ClaudeRunnerOptions = {},
): Promise<CheckResult> {
  const commander = options.commander ?? defaultTmuxCommander;
  const timeoutMs = options.timeoutMs ?? 30000;
  const workDir = options.workDir ?? "/home/joshua/WebJamApps/web-jam-tools";
  const socket = options.tmuxSocket ??
    `skill-start-claude-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

  let settingsFile = "";
  try {
    settingsFile = await Deno.makeTempFile({
      prefix: "claude-start-check-",
      suffix: ".json",
    });
    await Deno.writeTextFile(settingsFile, "{}");
  } catch (err) {
    return {
      tool: "claude",
      skillName,
      mode,
      outcome: "FAIL",
      reason: `Failed to create temporary settings file: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  try {
    const claudeCmd = `claude --model haiku --settings "${settingsFile}"`;
    const startRes = await commander.startSession(socket, "check", workDir, claudeCmd);
    if (!startRes.success) {
      return {
        tool: "claude",
        skillName,
        mode,
        outcome: "FAIL",
        reason: `tmux failed to start claude session: ${startRes.stderr ?? "unknown error"}`,
      };
    }

    // Wait for Claude Code to initialize and render input prompt
    const initDeadline = Date.now() + 10000;
    let initialized = false;
    while (Date.now() < initDeadline) {
      await commander.sleep(300);
      const pane = await commander.capturePane(socket, "check");
      if (!pane.success) {
        return {
          tool: "claude",
          skillName,
          mode,
          outcome: "FAIL",
          reason: `tmux capture-pane failed during startup: ${pane.stderr ?? "session exited"}`,
        };
      }
      if (pane.output.includes("Stop and wait for limit to reset")) {
        return {
          tool: "claude",
          skillName,
          mode,
          outcome: "FAIL",
          reason: "Claude Code usage/rate limit reached",
        };
      }
      if (
        pane.output.includes("❯") ||
        pane.output.includes('Try "') ||
        pane.output.includes("manual mode on") ||
        pane.output.includes("──────")
      ) {
        initialized = true;
        break;
      }
    }

    if (!initialized) {
      return {
        tool: "claude",
        skillName,
        mode,
        outcome: "FAIL",
        reason: "Claude Code failed to initialize or display prompt within 10s",
      };
    }

    // Send prompt text and Enter key as two separate send-keys calls
    const sendPromptRes = await commander.sendKeys(socket, "check", prompt, true);
    if (!sendPromptRes.success) {
      return {
        tool: "claude",
        skillName,
        mode,
        outcome: "FAIL",
        reason: `Failed to send prompt text to tmux: ${sendPromptRes.stderr ?? "unknown error"}`,
      };
    }
    await commander.sleep(150);
    const sendEnterRes = await commander.sendKeys(socket, "check", "Enter", false);
    if (!sendEnterRes.success) {
      return {
        tool: "claude",
        skillName,
        mode,
        outcome: "FAIL",
        reason: `Failed to send Enter key to tmux: ${sendEnterRes.stderr ?? "unknown error"}`,
      };
    }

    // Poll the screen until match or timeout
    const pollDeadline = Date.now() + timeoutMs;
    while (Date.now() < pollDeadline) {
      await commander.sleep(500);
      const pane = await commander.capturePane(socket, "check");
      if (!pane.success) {
        return {
          tool: "claude",
          skillName,
          mode,
          outcome: "FAIL",
          reason: `tmux capture-pane failed: ${pane.stderr ?? "session exited prematurely"}`,
        };
      }

      const match = matchClaudeScreen(pane.output, skillName);
      if (match.matched) {
        return {
          tool: "claude",
          skillName,
          mode,
          outcome: "PASS",
          detail: match.matchedString,
        };
      }

      if (pane.output.includes("Stop and wait for limit to reset")) {
        return {
          tool: "claude",
          skillName,
          mode,
          outcome: "FAIL",
          reason: "Claude Code usage/rate limit reached during run",
        };
      }
    }

    return {
      tool: "claude",
      skillName,
      mode,
      outcome: "FAIL",
      reason:
        `Neither '● Skill(${skillName})' nor 'Use skill "${skillName}"?' appeared within ${timeoutMs}ms`,
    };
  } finally {
    await commander.killServer(socket);
    if (settingsFile) {
      await Deno.remove(settingsFile).catch(() => {});
    }
  }
}
