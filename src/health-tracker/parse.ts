// src/health-tracker/parse.ts
// Parsing and input validation for daily health report (web-jam-tools#1660).

export interface HealthReportParsed {
  weight?: number;
  exercise?: Record<string, number>;
}

export type ParseResult =
  | { type: "save"; data: HealthReportParsed }
  | { type: "skip" }
  | { type: "refusal"; reason: string };

/**
 * Parses a single typed report line against the allowed activities map.
 * Enforces the validation rules from health-wellness-design.md ("What he types"):
 * - Empty line or whitespace-only -> skip
 * - Weight (if first token is a number) must be between 50 and 700
 * - Activities must match an allowed activity (case-insensitive, saved lower-case)
 * - Each activity must be followed by a positive number (decimals allowed)
 * - Repeated activities or negative numbers or missing numbers are refused
 */
export function parseReportLine(
  line: string,
  allowedActivities: Record<string, string>,
): ParseResult {
  const trimmed = line.trim();
  if (trimmed === "") {
    return { type: "skip" };
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 0) {
    return { type: "skip" };
  }

  // Normalize allowed activity keys to lower-case
  const allowedKeysLower = new Map<string, string>();
  for (const key of Object.keys(allowedActivities)) {
    allowedKeysLower.set(key.toLowerCase(), key.toLowerCase());
  }
  const allowedListStr = Array.from(allowedKeysLower.keys()).sort().join(", ");

  let weight: number | undefined;
  let tokenIndex = 0;

  // Determine if token 0 is a number (weight)
  const firstToken = tokens[0];
  const isFirstTokenNumeric = /^-?\d+(\.\d+)?$/.test(firstToken);

  if (isFirstTokenNumeric) {
    const parsedWeight = parseFloat(firstToken);
    if (parsedWeight < 50 || parsedWeight > 700) {
      return {
        type: "refusal",
        reason: `Weight ${firstToken} is outside 50 to 700 (taken as typo).`,
      };
    }
    weight = parsedWeight;
    tokenIndex = 1;
  }

  // If only weight was entered
  if (tokenIndex >= tokens.length) {
    return {
      type: "save",
      data: { weight },
    };
  }

  const exercise: Record<string, number> = {};

  while (tokenIndex < tokens.length) {
    const actToken = tokens[tokenIndex];
    const actLower = actToken.toLowerCase();

    // Verify activity is known
    if (!allowedKeysLower.has(actLower)) {
      return {
        type: "refusal",
        reason: `Unknown activity "${actToken}". Available activities: ${allowedListStr}.`,
      };
    }

    // Verify activity is not repeated
    if (Object.prototype.hasOwnProperty.call(exercise, actLower)) {
      return {
        type: "refusal",
        reason: `Activity "${actToken}" is repeated.`,
      };
    }

    // Verify number token is present
    if (tokenIndex + 1 >= tokens.length) {
      return {
        type: "refusal",
        reason: `Activity "${actToken}" is missing its number.`,
      };
    }

    const numToken = tokens[tokenIndex + 1];
    const isNumValid = /^-?\d+(\.\d+)?$/.test(numToken);
    const parsedNum = parseFloat(numToken);

    if (!isNumValid || parsedNum < 0) {
      return {
        type: "refusal",
        reason: `Invalid number "${numToken}". Numbers must be positive.`,
      };
    }

    exercise[actLower] = parsedNum;
    tokenIndex += 2;
  }

  const result: HealthReportParsed = {};
  if (weight !== undefined) {
    result.weight = weight;
  }
  if (Object.keys(exercise).length > 0) {
    result.exercise = exercise;
  }

  return {
    type: "save",
    data: result,
  };
}
