import { join } from "@std/path";
import { type ClaudeRunnerOptions, runClaudeCheck } from "./claude_runner.ts";
import { type AgyRunnerOptions, runAgyCheck } from "./agy_runner.ts";
import { loadStartCheckPrompts, readSkillFirstHeading } from "./prompts.ts";
import type { CheckResult, SkillStartCheckOptions, ToolTarget } from "./types.ts";

export interface FullRunnerOptions extends SkillStartCheckOptions {
  claudeOptions?: ClaudeRunnerOptions;
  agyOptions?: AgyRunnerOptions;
}

export function formatCheckResult(result: CheckResult): string {
  const modeLabel = result.mode === "by_name" ? "by name" : "on its own";
  const base = `${result.tool}: ${result.skillName} (${modeLabel}): ${result.outcome}`;
  if (result.outcome === "FAIL" && result.reason) {
    return `${base} — ${result.reason}`;
  }
  return base;
}

export async function runSkillStartCheck(
  skillName: string,
  options: FullRunnerOptions = {},
): Promise<{ results: CheckResult[]; allPassed: boolean; formattedLines: string[] }> {
  const toolTarget: ToolTarget = options.tool ?? "all";
  const skillsDir = options.skillsDir ?? join(Deno.cwd(), "skills");

  const prompts = await loadStartCheckPrompts(skillsDir, skillName);
  const results: CheckResult[] = [];

  if (toolTarget === "claude" || toolTarget === "all") {
    const claudeOpts: ClaudeRunnerOptions = {
      workDir: options.workDir,
      timeoutMs: options.claudeTimeoutMs ?? options.timeoutMs,
      ...options.claudeOptions,
    };
    const resByName = await runClaudeCheck(skillName, "by_name", prompts.by_name, claudeOpts);
    results.push(resByName);

    const resOnItsOwn = await runClaudeCheck(
      skillName,
      "on_its_own",
      prompts.on_its_own,
      claudeOpts,
    );
    results.push(resOnItsOwn);
  }

  if (toolTarget === "agy" || toolTarget === "all") {
    const firstHeading = await readSkillFirstHeading(skillsDir, skillName);
    const agyOpts: AgyRunnerOptions = {
      timeoutMs: options.agyTimeoutMs ?? options.timeoutMs,
      ...options.agyOptions,
    };
    const resByName = await runAgyCheck(
      skillName,
      "by_name",
      prompts.by_name,
      firstHeading,
      agyOpts,
    );
    results.push(resByName);

    const resOnItsOwn = await runAgyCheck(
      skillName,
      "on_its_own",
      prompts.on_its_own,
      firstHeading,
      agyOpts,
    );
    results.push(resOnItsOwn);
  }

  const formattedLines = results.map(formatCheckResult);
  const allPassed = results.length > 0 && results.every((r) => r.outcome === "PASS");

  return {
    results,
    allPassed,
    formattedLines,
  };
}
