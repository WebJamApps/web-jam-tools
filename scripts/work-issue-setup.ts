/** Record the working model before handle-agy-tasks creates or resumes a branch. */
import { resolveSetupAuthor, type RunningModelOptions } from "../src/shared/codex_running_model.ts";
import {
  EVERYDAY_MODEL_LABELS,
  loadModelLabels,
  modelLabelViolation,
  SHARED_MODEL_LABELS,
} from "../src/shared/model_label_rule.ts";

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SetupDeps {
  run?: (args: string[]) => Promise<Result>;
  signing?: RunningModelOptions;
}

async function runCommand(args: string[]): Promise<Result> {
  const result = await new Deno.Command(args[0], {
    args: args.slice(1),
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function readLabels(stdout: string): string[] {
  const data: unknown = JSON.parse(stdout);
  if (typeof data !== "object" || data === null || !("labels" in data)) {
    throw new Error("issue labels could not be read");
  }
  const labels = data.labels;
  if (!Array.isArray(labels)) throw new Error("issue labels could not be read");
  return labels.map((label: unknown) => {
    if (
      typeof label !== "object" || label === null || !("name" in label) ||
      typeof label.name !== "string" || !label.name.trim()
    ) throw new Error("issue label has no name");
    return label.name;
  });
}

export async function recordWorkingModel(
  repo: string,
  issue: string,
  typedAuthor?: string,
  deps: SetupDeps = {},
): Promise<string> {
  const target = `${repo}#${issue}`;
  try {
    if (!/^[\w.-]+$/.test(repo) || !/^[1-9]\d*$/.test(issue)) {
      throw new Error("expected a repository and positive issue number");
    }
    const run = deps.run ?? runCommand;
    const checked = async (args: string[]) => {
      const result = await run(args);
      if (result.code !== 0) throw new Error(result.stderr || `command failed: ${args[0]}`);
      return result.stdout;
    };
    const author = await resolveSetupAuthor(typedAuthor, deps.signing);
    if (!author?.trim()) {
      throw new Error("setup requires a roster author (--author on Claude Code)");
    }
    const root = new URL("../", import.meta.url).pathname;
    const label = (await checked([
      "bash",
      `${root}scripts/create-draft-pr.sh`,
      "--author-label",
      author,
    ])).trim();
    const models = loadModelLabels();
    if (!models.has(label)) throw new Error("the author has no known model label");
    const view = ["gh", "issue", "view", issue, "--repo", `WebJamApps/${repo}`, "--json", "labels"];
    const labels = readLabels(await checked(view));
    const violation = modelLabelViolation(labels, models, undefined, false);
    if (violation) throw new Error(violation);
    const matched = labels.filter((value) => models.has(value));
    const eligible = matched.includes(label) || [SHARED_MODEL_LABELS, EVERYDAY_MODEL_LABELS]
      .some((lane: readonly string[]) =>
        lane.includes(label) && matched.length > 0 &&
        matched.every((value) => lane.includes(value))
      );
    if (!eligible) {
      throw new Error(
        `${author} cannot take labels [${
          matched.join(", ")
        }]; ask Josh before overriding the lane, then use edit-issue to record his approved model`,
      );
    }
    const remove = [...new Set(matched.filter((value) => value !== label))];
    if (!labels.includes(label) || remove.length > 0) {
      await checked([
        "deno",
        "task",
        "--config",
        `${root}deno.json`,
        "edit-issue",
        "--repo",
        `WebJamApps/${repo}`,
        "--issue",
        issue,
        "--add-label",
        label,
        ...remove.flatMap((value) => ["--remove-label", value]),
      ]);
      const actual = readLabels(await checked(view)).sort();
      const expected = [...new Set([...labels.filter((value) => !models.has(value)), label])]
        .sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          "working-model label update could not be verified (including non-model labels)",
        );
      }
    }
    return author;
  } catch (error) {
    throw new Error(
      `Refused setup for ${target}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

if (import.meta.main) {
  try {
    console.log(await recordWorkingModel(Deno.args[0] ?? "", Deno.args[1] ?? "", Deno.args[2]));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
