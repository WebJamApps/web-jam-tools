/** Model-label policy for the filing tools. The tier-order design owns the rule;
 * the frozen issue-create guard is checked against this implementation by parity tests. */
export const DEFAULT_MODEL_LABELS_PATH = new URL(
  "../../skills/fix-labels/model-labels.json",
  import.meta.url,
);

/** Any non-empty subset permits the shared logic-and-safety lane. */
export const SHARED_MODEL_LABELS = ["Argon", "Hydrogen"] as const;

/** Either label permits either model on the everyday coding lane. */
export const EVERYDAY_MODEL_LABELS = ["Terra", "Sonnet"] as const;

/** Either label permits either model on the top lane. */
export const TOP_MODEL_LABELS = ["Sol", "Opus"] as const;

const CODING_LANES: readonly (readonly string[])[] = [
  SHARED_MODEL_LABELS,
  EVERYDAY_MODEL_LABELS,
  TOP_MODEL_LABELS,
];

export function loadModelLabels(file: string | URL = DEFAULT_MODEL_LABELS_PATH): Set<string> {
  try {
    const data = JSON.parse(Deno.readTextFileSync(file));
    if (
      !Array.isArray(data.modelLabels) || data.modelLabels.length === 0 ||
      data.modelLabels.some((name: unknown) => typeof name !== "string" || !name.trim())
    ) {
      throw new Error("modelLabels must be a non-empty array of label names");
    }
    return new Set(data.modelLabels);
  } catch (error) {
    throw new Error(
      `Cannot read model labels from ${file}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/** Undefined means pass. Plan-table linting checks labels without a reason column. */
export function modelLabelViolation(
  labels: readonly string[],
  modelLabels: ReadonlySet<string>,
  escalationReason?: string | null,
  checkEscalationReason = true,
): string | undefined {
  const matched = [...new Set(labels.filter((label) => modelLabels.has(label)))].sort();
  if (matched.length === 0) {
    return labels.includes("Josh") ? undefined : "no model label";
  }
  const hasFable = matched.includes("Fable");
  const inSingleLane = matched.length === 1 ||
    CODING_LANES.some((lane) => matched.every((label) => lane.includes(label)));
  if (!hasFable && !inSingleLane) {
    return `forbidden model-label combination (${matched.join(", ")})`;
  }
  if (checkEscalationReason && hasFable && !escalationReason?.trim()) {
    return "Fable needs an escalation reason";
  }
}

/** Check eligibility after the issue’s label set has passed the label rule. */
export function canWorkModelLabels(label: string, matched: readonly string[]): boolean {
  return matched.includes(label) ||
    CODING_LANES.some((lane) =>
      lane.includes(label) && matched.some((value) => lane.includes(value))
    );
}

/** Read a Markdown Model tier cell. Names remain case sensitive, just like GitHub labels. */
export function readPlanModelLabels(cell: string, modelLabels: ReadonlySet<string>): string[] {
  const value = cell.replace(/[`*_]/g, "").trim();
  if (!value) throw new Error("Model tier is missing");
  return value.split("/").map((part) => {
    const name = part.trim();
    if (!name) throw new Error("Model tier contains an empty name");
    if (name !== "Josh" && !modelLabels.has(name)) {
      throw new Error(`Unknown model tier "${name}"`);
    }
    return name;
  });
}
