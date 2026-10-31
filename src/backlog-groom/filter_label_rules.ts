/** Local proposal routing only: this command has no network or subprocess permission. */
import { parseArgs } from "@std/cli/parse-args";
import { dirname } from "@std/path";
import { EVERYDAY_MODEL_LABELS, loadModelLabels } from "../shared/model_label_rule.ts";
import { type FindingsFile, readFindings, validateFindings, writeFindings } from "./findings.ts";
import { readSnapshot, repositoryFacts, type Snapshot, validateSnapshot } from "./snapshot.ts";

export const FLASH_BATCH_HEADING =
  "Low and Medium on the everyday lane: nothing changes unless you approve it";

export function filterLabelRules(
  findings: FindingsFile,
  snapshot: Snapshot,
  modelLabels: ReadonlySet<string> = loadModelLabels(),
): FindingsFile {
  const file = validateFindings(findings);
  validateSnapshot(snapshot);
  const models = new Set([...modelLabels, ...EVERYDAY_MODEL_LABELS]);
  const issues = new Map(
    snapshot.repositories.flatMap(({ repo }) =>
      repositoryFacts(snapshot, repo).issues.map((issue) =>
        [`${repo}/${issue.number}`, issue] as const
      )
    ),
  );
  const result: FindingsFile = { schemaVersion: 1, items: [], flashBatch: [] };
  for (const item of [...file.items, ...file.flashBatch].sort((a, b) => a.number - b.number)) {
    const issue = issues.get(`${item.repo}/${item.issue}`);
    if (!issue) throw new Error(`Finding ${item.number} names an issue absent from the snapshot`);
    const everyday = EVERYDAY_MODEL_LABELS.filter((label) => issue.labels.includes(label));
    const onlyModelLabels = item.changes.length > 0 &&
      item.changes.every((change) =>
        change.kind === "labels" &&
        [...change.remove, ...change.add].every((label) => models.has(label))
      );
    const removesEveryday = item.changes.some((change) =>
      change.kind === "labels" &&
      change.remove.some((label) => everyday.some((name) => name === label))
    );
    const batch = (issue.priority === "Low" || issue.priority === "Medium") &&
      onlyModelLabels && removesEveryday;
    (batch ? result.flashBatch : result.items).push(item);
  }
  return result;
}

export async function runFilterLabelsCli(
  args: string[],
  options: { log?: (line: string) => void; errorLog?: (line: string) => void } = {},
): Promise<number> {
  const log = options.log ?? console.log;
  const errorLog = options.errorLog ?? console.error;
  try {
    const flags = parseArgs(args, {
      string: ["findings", "snapshot"],
      boolean: ["help"],
      alias: { h: "help" },
      unknown: (arg) => {
        throw new Error(`Unknown argument: ${arg}`);
      },
    });
    if (flags.help) {
      log(
        "Usage: deno task backlog-groom:filter-labels --findings <file> --snapshot <file>\nMoves proposals locally; applies nothing to GitHub. Both files must share a run directory under /tmp/backlog-groom.",
      );
      return 0;
    }
    if (!flags.findings || !flags.snapshot || flags._.length) {
      throw new Error("Provide --findings and --snapshot; see --help");
    }
    if (flags.findings === flags.snapshot || dirname(flags.findings) !== dirname(flags.snapshot)) {
      throw new Error("Findings and snapshot must be separate files beside each other");
    }
    const findings = await readFindings(flags.findings);
    const snapshot = await readSnapshot(flags.snapshot);
    const result = filterLabelRules(findings, snapshot);
    await writeFindings(flags.findings, result);
    log(`Main list: ${result.items.length} item(s)`);
    log(FLASH_BATCH_HEADING);
    for (const item of result.flashBatch) log(`${item.number}: ${item.reason}`);
    return 0;
  } catch (error) {
    errorLog(
      `backlog-groom:filter-labels refused: ${error instanceof Error ? error.message : error}`,
    );
    return 1;
  }
}

if (import.meta.main) Deno.exit(await runFilterLabelsCli(Deno.args));
