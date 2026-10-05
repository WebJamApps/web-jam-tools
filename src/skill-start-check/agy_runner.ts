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

function captureStream(readable: ReadableStream<Uint8Array>) {
  const reader = readable.getReader();
  const output = (async () => {
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const total = chunks.reduce((acc, c) => acc + c.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(bytes);
  })();
  return { output, cancel: () => readable.locked ? reader.cancel() : Promise.resolve() };
}

async function signalGroup(child: Deno.ChildProcess, signal: "SIGTERM" | "SIGKILL") {
  // setsid isolates this check's descendants from the caller's process group.
  const result = await new Deno.Command("kill", {
    args: ["-s", signal, "--", `-${child.pid}`],
    stdout: "null",
    stderr: "null",
  }).output();
  if (!result.success) {
    try {
      child.kill(signal);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound) && !(err instanceof TypeError)) throw err;
    }
  }
}

export const defaultAgyCommandExecutor: AgyCommandExecutor = {
  async run(prompt, timeoutMs, options) {
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command("setsid", {
        args: [options?.agyPath ?? "agy", "-p", prompt],
        cwd: options?.workDir,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (err) {
      return { success: false, code: -1, stdout: "", stderr: String(err) };
    }
    const stdout = captureStream(child.stdout);
    const stderr = captureStream(child.stderr);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const execution = Promise.all([stdout.output, stderr.output, child.status]);
    try {
      const result = await Promise.race([execution, timeout]);
      if (result) {
        const [out, err, status] = result;
        return { success: status.success, code: status.code, stdout: out, stderr: err };
      }
      return {
        success: false,
        code: -1,
        stdout: "",
        stderr: `Timed out after ${timeoutMs}ms`,
        timedOut: true,
      };
    } catch (err) {
      return { success: false, code: -1, stdout: "", stderr: String(err) };
    } finally {
      clearTimeout(timer);
      // Cancel through the readers that hold the stream locks, then reap the
      // entire isolated group even if its leader exited before its descendants.
      await Promise.allSettled([stdout.cancel(), stderr.cancel()]);
      try {
        await signalGroup(child, "SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        await signalGroup(child, "SIGKILL");
        await Promise.allSettled([stdout.output, stderr.output, child.status]);
      }
    }
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
