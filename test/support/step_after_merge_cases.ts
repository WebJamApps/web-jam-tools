export const STEP_AFTER_MERGE_FIRST_REFUSED =
  "After the merge, with the canonical clone on the merged commit, one-shot sessions on Claude Code, agy and Codex each refuse `printenv PROBE_FAKE_TOKEN`, and the three results are posted on this issue.";

export interface StepAfterMergeCase {
  name: string;
  criterion: string;
  tier: string;
  labels: string[];
  isEpic?: boolean;
  expectedReason?: "step-after-merge-missing-command" | "step-after-merge-missing-josh";
  expectedError?: string;
}

export const STEP_AFTER_MERGE_CASES: StepAfterMergeCase[] = [
  {
    name: "case 01: only backtick span starts with printenv -> refused",
    criterion: STEP_AFTER_MERGE_FIRST_REFUSED,
    tier: "Sol",
    labels: ["Sol"],
    expectedReason: "step-after-merge-missing-command",
    expectedError: "command that starts the step is missing",
  },
  {
    name: "case 02: Once installed, no backtick span -> refused",
    criterion: "Once installed, the hook refuses the probe.",
    tier: "Sol",
    labels: ["Sol"],
    expectedReason: "step-after-merge-missing-command",
    expectedError: "command that starts the step is missing",
  },
  {
    name: "case 03: After merge, run the installer on the laptop -> refused",
    criterion: "After merge, run the installer on the laptop.",
    tier: "Sol",
    labels: ["Sol"],
    expectedReason: "step-after-merge-missing-command",
    expectedError: "command that starts the step is missing",
  },
  {
    name: "case 04: Post-merge: `tools:check` reports OK -> refused",
    criterion: "Post-merge: `tools:check` reports OK.",
    tier: "Sol",
    labels: ["Sol"],
    expectedReason: "step-after-merge-missing-command",
    expectedError: "command that starts the step is missing",
  },
  {
    name: "case 05: AFTER THE MERGE matches in any capitalisation -> refused",
    criterion: "AFTER THE MERGE the probe is refused.",
    tier: "Sol",
    labels: ["Sol"],
    expectedReason: "step-after-merge-missing-command",
    expectedError: "command that starts the step is missing",
  },
  {
    name: "case 06: After it merges, Codex refuses it in a one-shot session -> refused",
    criterion: "After it merges, Codex refuses it in a one-shot session.",
    tier: "Sol",
    labels: ["Sol"],
    expectedReason: "step-after-merge-missing-command",
    expectedError: "command that starts the step is missing",
  },
  {
    name: "case 07: After the merge, `deno task tools:check` -> pass",
    criterion:
      "After the merge, `deno task tools:check` reports OK for Claude Code, agy and Codex.",
    tier: "Sol / Josh",
    labels: ["Sol", "Josh"],
  },
  {
    name: "case 08: After the merge, `claude -p ...` -> pass",
    criterion:
      'After the merge, `claude -p --model haiku "Run printenv PROBE_FAKE_TOKEN"` is refused by the hook.',
    tier: "Sol / Josh",
    labels: ["Sol", "Josh"],
  },
  {
    name: "case 09: Once installed, `bash scripts/install-hooks.sh --check` -> pass",
    criterion: "Once installed, `bash scripts/install-hooks.sh --check` exits 0.",
    tier: "Sol / Josh",
    labels: ["Sol", "Josh"],
  },
  {
    name: "case 10: One-shot session: `codex exec ...` -> pass",
    criterion: 'One-shot session: `codex exec "Run printenv PROBE_FAKE_TOKEN"` is refused.',
    tier: "Sol / Josh",
    labels: ["Sol", "Josh"],
  },
  {
    name: "case 11: After the merge, `~/.local/bin/agy -p ...` -> pass",
    criterion: 'After the merge, `~/.local/bin/agy -p "Run printenv PROBE_FAKE_TOKEN"` is refused.',
    tier: "Sol / Josh",
    labels: ["Sol", "Josh"],
  },
  {
    name: "case 12: After the merge, `scripts/agents.sh --check` -> pass",
    criterion: "After the merge, `scripts/agents.sh --check` exits 0.",
    tier: "Sol / Josh",
    labels: ["Sol", "Josh"],
  },
  {
    name: "case 13: `deno task test` passes -> pass (no step-after-merge phrase)",
    criterion: "`deno task test` passes.",
    tier: "Sol",
    labels: ["Sol"],
  },
  {
    name: 'case 14: Builds "Manual Steps & Runbooks" as written -> pass',
    criterion: 'Builds "Manual Steps & Runbooks" as written.',
    tier: "Sol",
    labels: ["Sol"],
  },
  {
    name: "case 15: Builds on the merged commit `a7dd856` -> pass",
    criterion: "Builds on the merged commit `a7dd856`.",
    tier: "Sol",
    labels: ["Sol"],
  },
  {
    name: "case 16: refused first criterion on a row/issue labeled only Josh -> pass (not read)",
    criterion: STEP_AFTER_MERGE_FIRST_REFUSED,
    tier: "Josh",
    labels: ["Josh"],
  },
  {
    name: "case 17: refused first criterion on a row/issue labeled Hydrogen and Josh -> refused",
    criterion: STEP_AFTER_MERGE_FIRST_REFUSED,
    tier: "Hydrogen / Josh",
    labels: ["Hydrogen", "Josh"],
    expectedReason: "step-after-merge-missing-command",
    expectedError: "command that starts the step is missing",
  },
  {
    name: "case 18: After the merge, `deno task install-skills` on Hydrogen and Josh -> pass",
    criterion: "After the merge, `deno task install-skills` exits 0.",
    tier: "Hydrogen / Josh",
    labels: ["Hydrogen", "Josh"],
  },
  {
    name: "case 19: same criterion on Hydrogen alone -> refused naming missing Josh label",
    criterion: "After the merge, `deno task install-skills` exits 0.",
    tier: "Hydrogen",
    labels: ["Hydrogen"],
    expectedReason: "step-after-merge-missing-josh",
    expectedError: 'missing the "Josh" label',
  },
  {
    name: "case 20: Once installed, `hledger --version` on Terra and Josh -> refused",
    criterion: "Once installed, `hledger --version` prints a version.",
    tier: "Terra / Josh",
    labels: ["Terra", "Josh"],
    expectedReason: "step-after-merge-missing-command",
    expectedError: "command that starts the step is missing",
  },
  {
    name: "case 21: After the merge, `sudo apt-get install -y hledger` on Terra and Josh -> pass",
    criterion: "After the merge, `sudo apt-get install -y hledger`",
    tier: "Terra / Josh",
    labels: ["Terra", "Josh"],
  },
  {
    name: "case 22: After the merge, `apt-get install -y hledger` on Terra and Josh -> pass",
    criterion: "After the merge, `apt-get install -y hledger`",
    tier: "Terra / Josh",
    labels: ["Terra", "Josh"],
  },
  {
    name: "case 23: Closes when all child sub-issues close on an Epic -> pass (not read)",
    criterion: "Closes when all child sub-issues close.",
    tier: "Opus",
    labels: ["Opus"],
    isEpic: true,
  },
];
