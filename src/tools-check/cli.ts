/**
 * CLI entrypoint for `deno task tools:check`.
 * Reports read-only whether Claude Code, agy, and Codex match the canonical clone.
 */
import {
  defaultToolsCheckDeps,
  formatToolsCheckReport,
  runToolsCheck,
  type ToolFilter,
  type ToolsCheckDeps,
} from "./lib.ts";

export interface ParsedCliArgs {
  help: boolean;
  json: boolean;
  homeDir?: string;
  repoDir?: string;
  tool?: ToolFilter;
  error?: string;
}

export function parseCliArgs(args: string[]): ParsedCliArgs {
  const parsed: ParsedCliArgs = { help: false, json: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--home" || arg.startsWith("--home=")) {
      const value = arg === "--home" ? args[++i] : arg.slice("--home=".length);
      if (!value || value.startsWith("--")) {
        return { ...parsed, error: "Missing value for --home <dir>" };
      }
      parsed.homeDir = value;
    } else if (arg === "--repo-dir" || arg.startsWith("--repo-dir=")) {
      const value = arg === "--repo-dir" ? args[++i] : arg.slice("--repo-dir=".length);
      if (!value || value.startsWith("--")) {
        return { ...parsed, error: "Missing value for --repo-dir <dir>" };
      }
      parsed.repoDir = value;
    } else if (arg === "--tool" || arg.startsWith("--tool=")) {
      const value = arg === "--tool" ? args[++i] : arg.slice("--tool=".length);
      if (value !== "claude" && value !== "agy" && value !== "codex" && value !== "all") {
        return {
          ...parsed,
          error: `Invalid --tool value: '${
            value ?? ""
          }' (expected 'claude', 'agy', 'codex', or 'all')`,
        };
      }
      parsed.tool = value;
    } else {
      return { ...parsed, error: `Unknown argument: ${arg}; use --help` };
    }
  }

  return parsed;
}

export async function main(
  args: string[],
  deps: ToolsCheckDeps = defaultToolsCheckDeps,
  io: { out: (msg: string) => void; err: (msg: string) => void } = {
    out: console.log,
    err: console.error,
  },
): Promise<number> {
  const parsed = parseCliArgs(args);
  if (parsed.help) {
    io.out(
      "Usage: deno task tools:check [--tool <claude|agy|codex|all>] [--home <dir>] [--repo-dir <dir>] [--json]",
    );
    io.out("Report read-only whether Claude Code, agy, and Codex match the canonical clone.");
    io.out("Exits 0 only when every checked row passes; exits 1 on drift or unreadable checks.");
    return 0;
  }

  if (parsed.error) {
    io.err(`error: ${parsed.error}`);
    return 1;
  }

  const report = await runToolsCheck(
    {
      homeDir: parsed.homeDir,
      repoDir: parsed.repoDir,
      tool: parsed.tool,
    },
    deps,
  );

  if (parsed.json) {
    io.out(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    io.out(formatToolsCheckReport(report));
  } else {
    io.err(formatToolsCheckReport(report));
  }

  return report.ok ? 0 : 1;
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
