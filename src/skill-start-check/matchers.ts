export interface ClaudeMatchResult {
  matched: boolean;
  status: "started" | "started_and_waiting" | "not_started";
  matchedString?: string;
}

/**
 * Checks whether the captured Claude Code tmux screen indicates the skill has started.
 *
 * Literal strings:
 * - Started: `● Skill(<name>)`
 * - Started and waiting (manual permission mode): `Use skill "<name>"?`
 * - Not started: neither string appears
 */
export function matchClaudeScreen(screenText: string, skillName: string): ClaudeMatchResult {
  const startedMarker = `● Skill(${skillName})`;
  const waitingMarker = `Use skill "${skillName}"?`;

  if (screenText.includes(startedMarker)) {
    return {
      matched: true,
      status: "started",
      matchedString: startedMarker,
    };
  }
  if (screenText.includes(waitingMarker)) {
    return {
      matched: true,
      status: "started_and_waiting",
      matchedString: waitingMarker,
    };
  }
  return {
    matched: false,
    status: "not_started",
  };
}

export interface AgyMatchResult {
  matched: boolean;
  firstHeading: string;
}

/**
 * Checks whether the output of `agy -p "<prompt>"` contains the first `# ` heading line
 * of that skill's `SKILL.md`.
 */
export function matchAgyOutput(output: string, firstHeading: string): AgyMatchResult {
  const matched = output.includes(firstHeading);
  return {
    matched,
    firstHeading,
  };
}
