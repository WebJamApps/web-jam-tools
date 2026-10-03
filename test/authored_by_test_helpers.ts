/**
 * Test helpers for the Authored-by footer roster probe (web-jam-tools#1205).
 * The probe is `create-draft-pr.sh --check-author <author>`; tests fake it so
 * no test starts a real subprocess for the roster check.
 */
export const TEST_AUTHOR = "Claude Code — Opus";

export interface ProbeResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** True when the command is the roster probe. */
export function isProbeCall(cmd: string[]): boolean {
  return cmd[1] === "--check-author";
}

/** Wraps a deps object so roster-probe calls are answered "on the roster" and not forwarded. */
export function withPassingProbe<
  T extends { runCmd: (cmd: string[], stdin?: string) => Promise<ProbeResult> },
>(deps: T): T {
  const inner = deps.runCmd;
  return {
    ...deps,
    runCmd: (cmd: string[], stdin?: string) =>
      isProbeCall(cmd)
        ? Promise.resolve({
          code: 0,
          stdout: `OK: '${cmd[2]}' names a model on the roster.`,
          stderr: "",
        })
        : inner(cmd, stdin),
  };
}
