/** Model-label policy for the filing tools. The tier-order design owns the rule;
 * the frozen issue-create guard is checked against this implementation by parity tests. */
export const DEFAULT_MODEL_LABELS_PATH = new URL(
  "../../skills/fix-labels/model-labels.json",
  import.meta.url,
);

/** Any non-empty subset permits the shared logic-and-safety lane. */
export const SHARED_MODEL_LABELS = ["Sol", "Argon", "Hydrogen"] as const;

/** Either label permits either model on the everyday coding lane. */
export const EVERYDAY_MODEL_LABELS = ["Terra", "Sonnet"] as const;

/** Either label permits either model on the top lane. */
export const TOP_MODEL_LABELS = ["Opus", "Fable"] as const;

/** Model labels that require an explicit escalation reason. */
export const ESCALATION_MODEL_LABELS = ["Opus", "Fable"] as const;

const ALLOWED_MULTI_LABEL_LANES: readonly (readonly string[])[] = [
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
  const inSingleLane = matched.length === 1 ||
    ALLOWED_MULTI_LABEL_LANES.some((lane) => matched.every((label) => lane.includes(label)));
  if (!inSingleLane) {
    return `forbidden model-label combination (${matched.join(", ")})`;
  }
  const escalated = matched.find((label) =>
    (ESCALATION_MODEL_LABELS as readonly string[]).includes(label)
  );
  if (checkEscalationReason && escalated && !escalationReason?.trim()) {
    return `${escalated} needs an escalation reason`;
  }
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
