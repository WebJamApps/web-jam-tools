/**
 * Check that Claude Code, agy, and Codex match the canonical clone.
 *
 * Implements "Each tool's live setup" in
 * ~/Dropbox/web-jam-llms/Token_Savings/design-issue-file-issue-design-2026-08-23.md
 * by running each installer's own check mode, which writes no file and installs nothing. The one
 * thing this check changes: it deletes a temporary approved copy under the Gate 1 state folder
 * whose design document no longer exists.
 */
import { join, resolve } from "@std/path";
import {
  type PruneApprovedCopiesResult,
  pruneOrphanedApprovedCopies,
} from "../design-issue/gate1_record.ts";

export type CheckOutcome = "ok" | "drifted" | "could-not-tell";
export type ToolName = "Claude Code" | "agy" | "Codex";
export type ToolFilter = "claude" | "agy" | "codex" | "all";

export interface ToolsCheckRow {
  tool: ToolName;
  item: string;
  through: string;
  outcome: CheckOutcome;
  details: string[];
  remediation?: string;
}

export interface ToolsCheckReport {
  ok: boolean;
  status: CheckOutcome;
  repoDir: string;
  homeDir: string;
  rows: ToolsCheckRow[];
  prunedApprovedCopies?: string[];
  approvedCopyErrors?: Array<{ path: string; reason: string }>;
}

export interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

export interface ToolsCheckDeps {
  runCmd: (
    cmd: string[],
    options?: { cwd?: string; env?: Record<string, string> },
  ) => Promise<CommandOutput>;
  getEnv: (key: string) => string | undefined;
  denoExecPath: string;
  pruneApprovedCopies?: (options: {
    homeDir: string;
    stateDir?: string;
    dropboxDir?: string;
  }) => Promise<PruneApprovedCopiesResult>;
}

export interface ToolsCheckOptions {
  homeDir?: string;
  repoDir?: string;
  tool?: ToolFilter;
  env?: Record<string, string>;
  stateDir?: string;
  dropboxDir?: string;
}

const OVERRIDE_ENV_KEYS = [
  "CLAUDE_SETTINGS_PATH",
  "AGY_HOOKS_PATH",
  "AGY_SETTINGS_PATH",
  "CLAUDE_HOOKS_DIR",
  "CLAUDE_SKILLS_DEST",
  "AGY_SKILLS_DEST",
  "AGY_MCP_CONFIG_PATH",
  "AGY_MCP_SRC_CONFIG",
  "CODEX_HOME",
  "CODEX_HOOKS_PATH",
  "AGENTS_MD_PATH",
  "AGY_SAFETY_RULES_PATH",
  "CODEX_SAFETY_RULES_PATH",
  "BIN_DIR",
] as const;

export const defaultToolsCheckDeps: ToolsCheckDeps = {
  async runCmd(
    cmd: string[],
    options?: { cwd?: string; env?: Record<string, string> },
  ): Promise<CommandOutput> {
    try {
      const command = new Deno.Command(cmd[0], {
        args: cmd.slice(1),
        cwd: options?.cwd,
        env: options?.env,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      });
      const out = await command.output();
      return {
        code: out.code,
        stdout: new TextDecoder().decode(out.stdout),
        stderr: new TextDecoder().decode(out.stderr),
      };
    } catch (err) {
      return {
        code: 1,
        stdout: "",
        stderr: "",
        spawnError: err instanceof Error ? err.message : String(err),
      };
    }
  },
  getEnv(key: string): string | undefined {
    try {
      return Deno.env.get(key);
    } catch {
      return undefined;
    }
  },
  denoExecPath: Deno.execPath(),
  pruneApprovedCopies(options) {
    return pruneOrphanedApprovedCopies(options);
  },
};

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * Classifies `scripts/install-hooks.sh --check` output into Claude Code hooks/settings,
 * agy hooks.json, and any Codex hook/rules findings emitted by that script.
 */
export function classifyInstallHooksOutput(
  result: CommandOutput,
  repoDir: string,
): {
  claude: ToolsCheckRow;
  agyHooks: ToolsCheckRow;
  codexDetails: { drifts: string[]; errors: string[] };
} {
  const claudeBase = {
    tool: "Claude Code" as const,
    item: "hook links and ~/.claude/settings.json",
    through: "scripts/install-hooks.sh --check",
  };
  const agyBase = {
    tool: "agy" as const,
    item: "registrations in ~/.gemini/config/hooks.json",
    through: "scripts/install-hooks.sh --check",
  };
  const remediation = `bash ${join(repoDir, "scripts/install-hooks.sh")}`;

  if (result.spawnError) {
    const reason = `could not run ${claudeBase.through}: ${result.spawnError}`;
    return {
      claude: { ...claudeBase, outcome: "could-not-tell", details: [reason] },
      agyHooks: { ...agyBase, outcome: "could-not-tell", details: [reason] },
      codexDetails: { drifts: [], errors: [] },
    };
  }

  const stdoutLines = nonEmptyLines(result.stdout);
  const stderrLines = nonEmptyLines(result.stderr);

  if (
    result.code === 0 &&
    stdoutLines.some((line) => line.includes("install-hooks: check passed (no drift)"))
  ) {
    return {
      claude: {
        ...claudeBase,
        outcome: "ok",
        details: ["Claude hook links and ~/.claude/settings.json match the canonical clone"],
      },
      agyHooks: {
        ...agyBase,
        outcome: "ok",
        details: ["~/.gemini/config/hooks.json and agy hook links match the canonical clone"],
      },
      codexDetails: { drifts: [], errors: [] },
    };
  }

  const reachedSummary = stderrLines.some((line) => line === "error: drift detected") ||
    stdoutLines.some((line) => line.includes("install-hooks: check passed (no drift)"));
  const claudeSettingsOk = stdoutLines.some((line) =>
    line.startsWith("settings.json:") && line.includes("already up to date")
  );
  const agyHooksOk = stdoutLines.some((line) =>
    line.startsWith("hooks.json:") &&
    !line.includes("Codex REAPER") &&
    line.includes("already up to date")
  );

  const claudeDrifts: string[] = [];
  const claudeErrors: string[] = [];
  const agyDrifts: string[] = [];
  const agyErrors: string[] = [];
  const codexDrifts: string[] = [];
  const codexErrors: string[] = [];
  const unknownDrifts: string[] = [];
  const unknownErrors: string[] = [];

  type Category = "codex" | "agy" | "claude" | "unknown";
  const pushToCategory = (category: Category, isError: boolean, text: string) => {
    if (category === "codex") {
      if (isError) codexErrors.push(text);
      else codexDrifts.push(text);
    } else if (category === "agy") {
      if (isError) agyErrors.push(text);
      else agyDrifts.push(text);
    } else if (category === "claude") {
      if (isError) claudeErrors.push(text);
      else claudeDrifts.push(text);
    } else {
      if (isError) unknownErrors.push(text);
      else unknownDrifts.push(text);
    }
  };

  let lastCategory: Category | null = null;
  let lastWasError = false;

  for (const rawLine of result.stderr.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line === "error: drift detected") continue;
    const isIndented = rawLine !== rawLine.trimStart();
    if (isIndented && lastCategory !== null && !line.startsWith("error:")) {
      pushToCategory(lastCategory, lastWasError, line);
      continue;
    }

    const isError = line.startsWith("error:");
    const isCodex = line.includes("Codex REAPER") ||
      line.includes("codex safety rules") ||
      /\.codex\/hooks\.json/i.test(line);
    const isAgy = !isCodex && (
      line.includes("agy-skill-run") ||
      line.includes("agy-prompt-watch") ||
      line.includes("agy hooks file") ||
      line.includes("agy allow-list") ||
      line.includes("agy safety rules") ||
      line.includes("cannot read agy") ||
      line.includes(".gemini/") ||
      line.startsWith("hooks.json:") ||
      line.includes("--forbid-lifecycle-hooks")
    );
    const isClaude = !isCodex && !isAgy && (
      line.startsWith("settings.json:") ||
      line.includes("settings.json") ||
      line.includes("hook script") ||
      line.includes("orphaned symlink") ||
      line.includes("status-line") ||
      line.includes("agent-alert") ||
      line.includes("agents script") ||
      line.includes("update-scripts script") ||
      line.includes("rules pointer") ||
      line.includes("core.hooksPath") ||
      line.startsWith("drift:")
    );

    const category: Category = isCodex ? "codex" : isAgy ? "agy" : isClaude ? "claude" : "unknown";
    lastCategory = category;
    lastWasError = isError;
    pushToCategory(category, isError, line);
  }

  const decideRow = (
    base: typeof claudeBase | typeof agyBase,
    okConfirmed: boolean,
    drifts: string[],
    errors: string[],
    okMsg: string,
  ): ToolsCheckRow => {
    if (errors.length > 0 || unknownErrors.length > 0) {
      return { ...base, outcome: "could-not-tell", details: [...errors, ...unknownErrors] };
    }
    if (drifts.length > 0) {
      return { ...base, outcome: "drifted", details: drifts, remediation };
    }
    if (reachedSummary && okConfirmed && unknownDrifts.length === 0) {
      return { ...base, outcome: "ok", details: [okMsg] };
    }
    const fallbackDetails = unknownDrifts.length > 0
      ? unknownDrifts
      : stderrLines.length > 0
      ? stderrLines.filter((line) => line !== "error: drift detected")
      : [`install-hooks.sh --check exited ${result.code} without confirming this check`];
    return { ...base, outcome: "could-not-tell", details: fallbackDetails };
  };

  return {
    claude: decideRow(
      claudeBase,
      claudeSettingsOk,
      claudeDrifts,
      claudeErrors,
      "Claude hook links and ~/.claude/settings.json match the canonical clone",
    ),
    agyHooks: decideRow(
      agyBase,
      agyHooksOk,
      agyDrifts,
      agyErrors,
      "~/.gemini/config/hooks.json and agy hook links match the canonical clone",
    ),
    codexDetails: { drifts: codexDrifts, errors: codexErrors },
  };
}

/** Classifies `scripts/install-skills.ts --check --tool <claude|agy>` output. */
export function classifyInstallSkillsOutput(
  result: CommandOutput,
  targetTool: "claude" | "agy",
  repoDir: string,
): ToolsCheckRow {
  const isClaude = targetTool === "claude";
  const base = {
    tool: (isClaude ? "Claude Code" : "agy") as ToolName,
    item: isClaude
      ? "skill links in ~/.claude/skills/"
      : "skill links in ~/.gemini/config/plugins/webjam-tasks/skills/",
    through: `scripts/install-skills.ts --check --tool ${targetTool}`,
  };
  const remediation = `deno task --config ${join(repoDir, "deno.json")} install-skills`;

  if (result.spawnError) {
    return {
      ...base,
      outcome: "could-not-tell",
      details: [`could not run ${base.through}: ${result.spawnError}`],
    };
  }

  const stdoutLines = nonEmptyLines(result.stdout);
  const stderrLines = nonEmptyLines(result.stderr);
  const expectedPrefix = isClaude ? "Claude: skill links in" : "agy: skill links in";

  if (
    result.code === 0 && stdoutLines.some((l) => l.includes(expectedPrefix) && l.includes(": ok"))
  ) {
    return { ...base, outcome: "ok", details: stdoutLines };
  }

  const errors = stderrLines.filter((l) => !l.startsWith("drift:"));
  const drifts = stderrLines.filter((l) => l.startsWith("drift:"));

  if (errors.length > 0) {
    return { ...base, outcome: "could-not-tell", details: errors };
  }
  if (result.code !== 0 && drifts.length > 0) {
    return { ...base, outcome: "drifted", details: drifts, remediation };
  }

  return {
    ...base,
    outcome: "could-not-tell",
    details: stderrLines.length > 0
      ? stderrLines
      : stdoutLines.length > 0
      ? stdoutLines
      : [`${base.through} exited ${result.code} with no diagnostic output`],
  };
}

/** Classifies `scripts/install-agy-config.sh --check` output. */
export function classifyInstallAgyConfigOutput(
  result: CommandOutput,
  repoDir: string,
): ToolsCheckRow {
  const base = {
    tool: "agy" as const,
    item: "~/.gemini/config/mcp_config.json symlink",
    through: "scripts/install-agy-config.sh --check",
  };
  const remediation = `bash ${join(repoDir, "scripts/install-agy-config.sh")}`;

  if (result.spawnError) {
    return {
      ...base,
      outcome: "could-not-tell",
      details: [`could not run ${base.through}: ${result.spawnError}`],
    };
  }

  const stdoutLines = nonEmptyLines(result.stdout);
  const stderrLines = nonEmptyLines(result.stderr);

  if (result.code === 0 && stdoutLines.some((l) => l.includes("mcp_config.json: ok"))) {
    return { ...base, outcome: "ok", details: stdoutLines };
  }

  const errors = stderrLines.filter((l) => !l.startsWith("drift:"));
  const drifts = stderrLines.filter((l) => l.startsWith("drift:"));

  if (errors.length > 0) {
    return { ...base, outcome: "could-not-tell", details: errors };
  }
  if (result.code !== 0 && drifts.length > 0) {
    return { ...base, outcome: "drifted", details: drifts, remediation };
  }

  return {
    ...base,
    outcome: "could-not-tell",
    details: stderrLines.length > 0
      ? stderrLines
      : [`${base.through} exited ${result.code} with no diagnostic output`],
  };
}

/** Classifies `scripts/install-codex.ts --check` output (optionally merged with install-hooks Codex findings). */
export function classifyInstallCodexOutput(
  result: CommandOutput,
  repoDir: string,
  extraCodexDetails: { drifts: string[]; errors: string[] } = { drifts: [], errors: [] },
): ToolsCheckRow {
  const base = {
    tool: "Codex" as const,
    item: "hook registrations, rules file, skill links and sandbox setting",
    through: "deno task install-codex --check",
  };
  const codexCmd = `deno task --config ${join(repoDir, "deno.json")} install-codex`;
  const hooksCmd = `bash ${join(repoDir, "scripts/install-hooks.sh")}`;

  if (result.spawnError) {
    return {
      ...base,
      outcome: "could-not-tell",
      details: [`could not run ${base.through}: ${result.spawnError}`, ...extraCodexDetails.errors],
    };
  }

  const stdoutLines = nonEmptyLines(result.stdout);
  const stderrLines = nonEmptyLines(result.stderr);

  const errors: string[] = [...extraCodexDetails.errors];
  const drifts: string[] = [...extraCodexDetails.drifts];
  let needsHooksInstall = extraCodexDetails.drifts.length > 0;
  let needsCodexInstall = false;

  for (const line of stderrLines) {
    if (line.startsWith("DRIFT:") || line.startsWith("SKIPPED:")) {
      drifts.push(line);
      needsCodexInstall = true;
    } else if (line.startsWith("REFUSED: missing hook ")) {
      drifts.push(line);
      needsHooksInstall = true;
    } else if (line.startsWith("REFUSED:")) {
      errors.push(line);
    } else {
      errors.push(line);
    }
  }

  if (errors.length > 0) {
    return { ...base, outcome: "could-not-tell", details: errors };
  }

  if (drifts.length > 0) {
    const remediation = needsHooksInstall && needsCodexInstall
      ? `${hooksCmd} && ${codexCmd}`
      : needsHooksInstall && extraCodexDetails.drifts.length > 0 &&
          !result.stderr.includes("DRIFT:")
      ? hooksCmd
      : needsHooksInstall
      ? `${hooksCmd} && ${codexCmd}`
      : codexCmd;
    return { ...base, outcome: "drifted", details: drifts, remediation };
  }

  if (
    result.code === 0 &&
    stdoutLines.some((l) => l.includes("Codex installation is current"))
  ) {
    return { ...base, outcome: "ok", details: stdoutLines };
  }

  return {
    ...base,
    outcome: "could-not-tell",
    details: stdoutLines.length > 0
      ? stdoutLines
      : [`${base.through} exited ${result.code} without confirming Codex state`],
  };
}

function resolveDefaultRows(
  tool: ToolFilter,
): Array<{ tool: ToolName; item: string; through: string }> {
  const all: Array<{ tool: ToolName; item: string; through: string; key: ToolFilter }> = [
    {
      key: "claude",
      tool: "Claude Code",
      item: "hook links and ~/.claude/settings.json",
      through: "scripts/install-hooks.sh --check",
    },
    {
      key: "claude",
      tool: "Claude Code",
      item: "skill links in ~/.claude/skills/",
      through: "scripts/install-skills.ts --check --tool claude",
    },
    {
      key: "agy",
      tool: "agy",
      item: "registrations in ~/.gemini/config/hooks.json",
      through: "scripts/install-hooks.sh --check",
    },
    {
      key: "agy",
      tool: "agy",
      item: "~/.gemini/config/mcp_config.json symlink",
      through: "scripts/install-agy-config.sh --check",
    },
    {
      key: "agy",
      tool: "agy",
      item: "skill links in ~/.gemini/config/plugins/webjam-tasks/skills/",
      through: "scripts/install-skills.ts --check --tool agy",
    },
    {
      key: "codex",
      tool: "Codex",
      item: "hook registrations, rules file, skill links and sandbox setting",
      through: "deno task install-codex --check",
    },
  ];
  return (tool === "all" ? all : all.filter((r) => r.key === tool)).map((
    { tool: t, item, through },
  ) => ({
    tool: t,
    item,
    through,
  }));
}

function buildChildEnv(
  deps: ToolsCheckDeps,
  homeDir: string,
  extraEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  const pathVal = deps.getEnv("PATH");
  if (pathVal) env.PATH = pathVal;
  const tmpVal = deps.getEnv("TMPDIR");
  if (tmpVal) env.TMPDIR = tmpVal;
  const denoDirVal = deps.getEnv("DENO_DIR");
  if (denoDirVal) env.DENO_DIR = denoDirVal;
  env.HOME = homeDir;

  // Clear installer path overrides when not explicitly supplied so --home isolates cleanly.
  for (const key of OVERRIDE_ENV_KEYS) {
    if (extraEnv && key in extraEnv) continue;
    if (deps.getEnv(key) !== undefined) env[key] = "";
  }
  if (extraEnv) {
    for (const [k, v] of Object.entries(extraEnv)) {
      env[k] = v;
    }
  }
  return env;
}

/**
 * Runs each installer's read-only check mode against `homeDir` and `repoDir`, returning
 * one report row per tool/item with `ok`, `drifted`, or `could-not-tell`.
 */
export async function runToolsCheck(
  options: ToolsCheckOptions = {},
  deps: ToolsCheckDeps = defaultToolsCheckDeps,
): Promise<ToolsCheckReport> {
  const toolFilter = options.tool ?? "all";
  const resolvedHome = options.homeDir ?? deps.getEnv("HOME") ?? deps.getEnv("USERPROFILE") ?? "";
  const canonicalDefaultRepo = resolvedHome
    ? resolve(join(resolvedHome, "WebJamApps", "web-jam-tools"))
    : "";
  const resolvedRepo = options.repoDir ? resolve(options.repoDir) : canonicalDefaultRepo;

  if (!resolvedHome.trim()) {
    const rows = resolveDefaultRows(toolFilter).map((row) => ({
      ...row,
      outcome: "could-not-tell" as const,
      details: ["HOME is unset; provide --home <dir>"],
    }));
    return {
      ok: false,
      status: "could-not-tell",
      repoDir: resolvedRepo,
      homeDir: "",
      rows,
    };
  }

  const homeDir = resolve(resolvedHome);
  const repoDir = resolvedRepo;
  const isCustomHome = options.homeDir !== undefined;
  const isCustomRepo = options.repoDir !== undefined;

  // When running with default HOME and no custom overrides, inherit ambient env overrides if any.
  const childEnv = isCustomHome || options.env
    ? buildChildEnv(deps, homeDir, options.env)
    : undefined;

  // install-hooks.sh --check verifies Claude settings, agy hooks.json, AND Codex REAPER/safety-rules,
  // so run it for --tool codex as well to keep Codex outcomes identical across --tool all and --tool codex.
  const needHooks = toolFilter === "all" || toolFilter === "claude" || toolFilter === "agy" ||
    toolFilter === "codex";
  const needClaude = toolFilter === "all" || toolFilter === "claude";
  const needAgy = toolFilter === "all" || toolFilter === "agy";
  const needCodex = toolFilter === "all" || toolFilter === "codex";

  const hooksArgs = ["bash", join(repoDir, "scripts/install-hooks.sh"), "--check"];

  const buildSkillsArgs = (t: "claude" | "agy"): string[] => {
    const args = [
      deps.denoExecPath,
      "run",
      "--no-prompt",
      "--config",
      join(repoDir, "deno.json"),
      "--allow-env=HOME,CLAUDE_SKILLS_DEST,AGY_SKILLS_DEST,TMPDIR",
      "--allow-run=git",
      `--allow-read=${homeDir},${repoDir},/tmp`,
      join(repoDir, "scripts/install-skills.ts"),
      "--check",
      "--tool",
      t,
    ];
    if (isCustomRepo) {
      args.push("--repo-dir", repoDir, "--allow-unsafe-for-testing");
    }
    if (isCustomHome) {
      args.push(
        "--claude-dest",
        join(homeDir, ".claude/skills"),
        "--agy-dest",
        join(homeDir, ".gemini/config/plugins/webjam-tasks/skills"),
      );
    }
    return args;
  };

  const agyConfigArgs = [
    "bash",
    join(repoDir, "scripts/install-agy-config.sh"),
    "--check",
  ];
  if (isCustomRepo || isCustomHome) {
    agyConfigArgs.push(
      "--mcp-src-path",
      join(repoDir, "agy/config/mcp_config.json"),
      "--mcp-config-path",
      join(homeDir, ".gemini/config/mcp_config.json"),
    );
  }

  const codexArgs = [
    deps.denoExecPath,
    "run",
    "--no-prompt",
    "--config",
    join(repoDir, "deno.json"),
    "--allow-env=HOME,CODEX_HOME",
    `--allow-read=${homeDir},${repoDir},/tmp`,
    join(repoDir, "scripts/install-codex.ts"),
    "--check",
    "--home",
    homeDir,
  ];

  const [hooksOut, claudeSkillsOut, agyConfigOut, agySkillsOut, codexOut, pruneResult] =
    await Promise.all([
      needHooks ? deps.runCmd(hooksArgs, { cwd: repoDir, env: childEnv }) : Promise.resolve(null),
      needClaude
        ? deps.runCmd(buildSkillsArgs("claude"), { cwd: repoDir, env: childEnv })
        : Promise.resolve(null),
      needAgy ? deps.runCmd(agyConfigArgs, { cwd: repoDir, env: childEnv }) : Promise.resolve(null),
      needAgy
        ? deps.runCmd(buildSkillsArgs("agy"), { cwd: repoDir, env: childEnv })
        : Promise.resolve(null),
      needCodex ? deps.runCmd(codexArgs, { cwd: repoDir, env: childEnv }) : Promise.resolve(null),
      (deps.pruneApprovedCopies ?? defaultToolsCheckDeps.pruneApprovedCopies!)({
        homeDir,
        stateDir: options.stateDir ??
          (isCustomHome ? undefined : (options.env?.DESIGN_GATE1_STATE_DIR ??
            deps.getEnv("DESIGN_GATE1_STATE_DIR"))),
        dropboxDir: options.dropboxDir ??
          (options.env?.DESIGN_DOCS_ROOT ??
            (isCustomHome ? undefined : deps.getEnv("DESIGN_DOCS_ROOT"))),
      }),
    ]);

  const rows: ToolsCheckRow[] = [];
  const hooksClassified = hooksOut ? classifyInstallHooksOutput(hooksOut, repoDir) : null;

  if (needClaude) {
    if (hooksClassified) rows.push(hooksClassified.claude);
    if (claudeSkillsOut) rows.push(classifyInstallSkillsOutput(claudeSkillsOut, "claude", repoDir));
  }

  if (needAgy) {
    if (hooksClassified) rows.push(hooksClassified.agyHooks);
    if (agyConfigOut) rows.push(classifyInstallAgyConfigOutput(agyConfigOut, repoDir));
    if (agySkillsOut) rows.push(classifyInstallSkillsOutput(agySkillsOut, "agy", repoDir));
  }

  if (needCodex && codexOut) {
    rows.push(
      classifyInstallCodexOutput(
        codexOut,
        repoDir,
        hooksClassified?.codexDetails ?? { drifts: [], errors: [] },
      ),
    );
  }

  const hasCouldNotTell = rows.some((r) => r.outcome === "could-not-tell") ||
    pruneResult.errors.length > 0;
  const hasDrifted = rows.some((r) => r.outcome === "drifted");
  const status: CheckOutcome = hasCouldNotTell ? "could-not-tell" : hasDrifted ? "drifted" : "ok";

  const report: ToolsCheckReport = {
    ok: status === "ok",
    status,
    repoDir,
    homeDir,
    rows,
  };
  if (pruneResult.removed.length > 0) {
    report.prunedApprovedCopies = pruneResult.removed;
  }
  if (pruneResult.errors.length > 0) {
    report.approvedCopyErrors = pruneResult.errors;
  }
  return report;
}

/** Formats the report as human-readable rows showing status, diffs/reasons, and remediation commands. */
export function formatToolsCheckReport(report: ToolsCheckReport): string {
  const lines: string[] = [
    `tools:check (repo: ${report.repoDir}, home: ${report.homeDir || "<unset>"})`,
    "",
  ];

  const labels: Record<CheckOutcome, string> = {
    ok: "OK",
    drifted: "DRIFTED",
    "could-not-tell": "COULD NOT TELL",
  };

  for (const row of report.rows) {
    lines.push(`[${labels[row.outcome]}] ${row.tool} — ${row.item} (via ${row.through})`);
    if (row.outcome !== "ok") {
      for (const detail of row.details) {
        lines.push(`  - ${detail}`);
      }
      if (row.outcome === "drifted" && row.remediation) {
        lines.push(`  -> Fix: ${row.remediation}`);
      }
    }
  }

  if (report.prunedApprovedCopies && report.prunedApprovedCopies.length > 0) {
    lines.push(
      `[PRUNED] removed ${report.prunedApprovedCopies.length} orphaned Gate 1 approved cop${
        report.prunedApprovedCopies.length === 1 ? "y" : "ies"
      }:`,
    );
    for (const copyPath of report.prunedApprovedCopies) {
      lines.push(`  - ${copyPath}`);
    }
  }

  if (report.approvedCopyErrors && report.approvedCopyErrors.length > 0) {
    lines.push("[COULD NOT TELL] Gate 1 approved copy cleanup");
    for (const err of report.approvedCopyErrors) {
      lines.push(`  - ${err.path}: ${err.reason}`);
    }
  }

  const okCount = report.rows.filter((r) => r.outcome === "ok").length;
  const driftedCount = report.rows.filter((r) => r.outcome === "drifted").length;
  const couldNotTellCount = report.rows.filter((r) => r.outcome === "could-not-tell").length +
    (report.approvedCopyErrors?.length ?? 0);

  lines.push("");
  if (report.ok) {
    lines.push(`tools:check: OK (${okCount}/${report.rows.length} passed)`);
  } else {
    lines.push(
      `tools:check: FAILED (${okCount} ok, ${driftedCount} drifted, ${couldNotTellCount} could not tell)`,
    );
  }

  return lines.join("\n");
}
