import { parseArgs } from "@std/cli/parse-args";
import { type CommandRunner } from "../shared/repos.ts";
import { readRepository } from "./github.ts";
import { type Judgment, rankIssues, type RankResult } from "./rank.ts";
import { readSnapshot, repositoryFacts } from "./snapshot.ts";

interface CliOptions {
  runner?: CommandRunner;
  readTextFile?: (path: string) => Promise<string>;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
}

function parseJudgments(value: unknown): Record<string, Judgment> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Judgments must be a JSON object keyed by issue number");
  }
  // rankIssues validates every judgment used, including absence and non-boolean answers.
  return value as Record<string, Judgment>;
}

export function formatReport(result: RankResult): string {
  const lines = [
    `Priority proposals for ${result.repo} (${result.count} open non-Epics)`,
    ...result.notices,
    result.shares
      ? `Target shares: ${JSON.stringify(result.shares)}`
      : "Below 20: caller level tests only",
    "Issue | Current | Proposed | Reason",
  ];
  for (const move of result.moves) {
    lines.push(
      `${result.repo}#${move.number} "${move.title.replace(/[\r\n]/g, " ")}" | ${
        move.from ?? "unset"
      } | ${move.to} | ${move.reason}`,
    );
  }
  if (!result.moves.length) lines.push("No Priority moves proposed.");
  return lines.join("\n");
}

export async function runRankCli(args: string[], options: CliOptions = {}): Promise<number> {
  const log = options.log ?? console.log;
  const errorLog = options.errorLog ?? console.error;
  try {
    const flags = parseArgs(args, {
      string: ["repo", "judgments", "focus", "snapshot"],
      boolean: ["help", "json"],
      alias: { h: "help" },
      unknown: (arg) => {
        throw new Error(`Unknown argument: ${arg}`);
      },
    });
    if (flags.help) {
      log(
        `Usage: deno task backlog-groom:rank --repo <active-repo> --judgments <file.json> [--snapshot <file.json>] [--focus <milestone>] [--json]

Read-only: ranks one repository and proposes Priority moves.
Judgments are keyed by issue number, each with liveBroken and costlyDefect booleans
and a one-line reason. Below 20 non-Epics, also supply levelFromTests using file-issue.
The task reads inputs only from /tmp/backlog-groom. With --snapshot it makes no GitHub reads;
snapshots must be complete, match the active repos, and be under one hour old.`,
      );
      return 0;
    }
    if (!flags.repo || !flags.judgments || flags._.length) {
      throw new Error("Provide --repo and --judgments; see --help");
    }
    const input = await (options.readTextFile ?? Deno.readTextFile)(flags.judgments);
    const judgments = parseJudgments(JSON.parse(input));
    const { issues, milestones } = flags.snapshot
      ? repositoryFacts(await readSnapshot(flags.snapshot, options.readTextFile), flags.repo)
      : await readRepository(flags.repo, options.runner);
    const result = rankIssues(flags.repo, issues, judgments, milestones, flags.focus);
    log(flags.json ? JSON.stringify(result, null, 2) : formatReport(result));
    return 0;
  } catch (error) {
    errorLog(
      `backlog-groom:rank refused: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (import.meta.main) Deno.exit(await runRankCli(Deno.args));
