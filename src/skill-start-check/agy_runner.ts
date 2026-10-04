import { matchAgyOutput } from "./matchers.ts";
import type { CheckMode, CheckResult } from "./types.ts";

export interface AgyCommandExecutor {
  run(
    prompt: string,
    timeoutMs: number,
  ): Promise<{
    success: boolean;
    code: number;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
  }>;
}

export const defaultAgyCommandExecutor: AgyCommandExecutor = {
  async run(prompt: string, timeoutMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abortController = new AbortController();
    try {
      timer = setTimeout(() => abortController.abort(), timeoutMs);
      const cmd = new Deno.Command("agy", {
        args: ["-p", prompt],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        signal: abortController.signal,
      });
      const out = await cmd.output();
      clearTimeout(timer);
      if (abortController.signal.aborted) {
        return {
          success: false,
          code: -1,
          stdout: "",
          stderr: `Timed out after ${timeoutMs}ms`,
          timedOut: true,
        };
      }
      const stdout = new TextDecoder().decode(out.stdout);
      const stderr = new TextDecoder().decode(out.stderr);
      return {
        success: out.success,
        code: out.code,
        stdout,
        stderr,
      };
    } catch (err) {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (
        abortController.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return {
          success: false,
          code: -1,
          stdout: "",
          stderr: `Timed out after ${timeoutMs}ms`,
          timedOut: true,
        };
      }
      return {
        success: false,
        code: -1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

export interface AgyRunnerOptions {
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

  const res = await executor.run(prompt, timeoutMs);
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
}
