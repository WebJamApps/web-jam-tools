import { dirname, join } from "@std/path";
import { withCandidateSkill } from "./candidate.ts";
import { matchAgyOutput } from "./matchers.ts";
import type { CheckMode, CheckResult } from "./types.ts";

export interface AgyCommandExecutor {
  run(
    prompt: string,
    timeoutMs: number,
    options?: { workDir?: string; agyPath?: string },
  ): Promise<{
    success: boolean;
    code: number;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
  }>;
}

async function readStream(readable: ReadableStream<Uint8Array>): Promise<string> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch {
    // Pipe closed or cancelled
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore release error
    }
  }
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const res = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    res.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(res);
}

export const defaultAgyCommandExecutor: AgyCommandExecutor = {
  async run(prompt: string, timeoutMs: number, options?: { workDir?: string; agyPath?: string }) {
    const agyBin = options?.agyPath ?? "agy";
    const cmd = new Deno.Command(agyBin, {
      args: ["-p", prompt],
      cwd: options?.workDir,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    let child: Deno.ChildProcess;
    try {
      child = cmd.spawn();
    } catch (err) {
      return {
        success: false,
        code: -1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });

    const executionPromise = Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      child.status,
    ]).then(([stdout, stderr, status]) => ({
      timedOut: false as const,
      stdout,
      stderr,
      code: status.code,
      success: status.success,
    }));

    const res = await Promise.race([executionPromise, timeoutPromise]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }

    if (res.timedOut) {
      // Pipe cleanup: cancel streams so readers unblock and pipes close
      await Promise.allSettled([
        child.stdout.cancel(),
        child.stderr.cancel(),
      ]);

      // Bounded termination escalation:
      // 1. Send SIGTERM
      try {
        child.kill("SIGTERM");
      } catch {
        // Child already exited
      }

      // Grace period before escalating to SIGKILL
      const graceMs = 100;
      const exited = await Promise.race([
        child.status.then(() => true).catch(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
      ]);

      // 2. Escalate to SIGKILL if still running
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Child already exited
        }
      }

      return {
        success: false,
        code: -1,
        stdout: "",
        stderr: `Timed out after ${timeoutMs}ms`,
        timedOut: true,
      };
    }

    return {
      success: res.success,
      code: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
    };
  },
};

export interface AgyRunnerOptions {
  workDir?: string;
  skillsDir?: string;
  agySkillsDir?: string;
  timeoutMs?: number;
  executor?: AgyCommandExecutor;
}

/**
 * Runs a start check for a skill under agy via `agy -p "<prompt>"`.
 *
 * Requirements:
 * - Calls `agy -p "<prompt>"`
 * - Output contains first `# ` heading line of that skill's `SKILL.md` -> PASS
 * - Heading absent from output -> FAIL
 * - Fails closed if agy fails to start, exits non-zero, or output unparseable -> FAIL with reason
 */
export async function runAgyCheck(
  skillName: string,
  mode: CheckMode,
  prompt: string,
  firstHeading: string,
  options: AgyRunnerOptions = {},
): Promise<CheckResult> {
  const executor = options.executor ?? defaultAgyCommandExecutor;
  const timeoutMs = options.timeoutMs ?? 180000;
  const workDir = options.workDir ??
    (options.skillsDir ? dirname(options.skillsDir) : undefined);

  const executeCheck = async (): Promise<CheckResult> => {
    const res = await executor.run(prompt, timeoutMs, { workDir });
    if (res.timedOut) {
      return {
        tool: "agy",
        skillName,
        mode,
        outcome: "FAIL",
        reason: `Timed out waiting for agy response (${timeoutMs}ms)`,
      };
    }

    if (!res.success) {
      return {
        tool: "agy",
        skillName,
        mode,
        outcome: "FAIL",
        reason: `agy exited with code ${res.code}: ${res.stderr || "process execution failed"}`,
      };
    }

    const combinedOutput = `${res.stdout}\n${res.stderr}`;
    const match = matchAgyOutput(combinedOutput, firstHeading);
    if (match.matched) {
      return {
        tool: "agy",
        skillName,
        mode,
        outcome: "PASS",
        detail: firstHeading,
      };
    }

    return {
      tool: "agy",
      skillName,
      mode,
      outcome: "FAIL",
      reason: `First heading line '${firstHeading}' absent from agy output`,
    };
  };

  if (options.skillsDir) {
    const agySkillsDir = options.agySkillsDir ??
      join(Deno.env.get("HOME") ?? "", ".gemini", "config", "plugins", "webjam-tasks", "skills");
    try {
      return await withCandidateSkill({
        skillName,
        candidateSkillsDir: options.skillsDir,
        installedSkillsDir: agySkillsDir,
      }, executeCheck);
    } catch (err) {
      return {
        tool: "agy",
        skillName,
        mode,
        outcome: "FAIL",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return await executeCheck();
}
