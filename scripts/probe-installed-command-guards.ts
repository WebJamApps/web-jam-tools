/** Feed command strings to installed guards as JSON; never execute a fixture command. */
import { join, resolve } from "@std/path";
import { parse } from "@std/toml";
import { splitShellTokens } from "../hooks/lib/normalize_command.ts";
import {
  COMMENT_HEREDOC_GUARD_CASES,
  type CommentHeredocCase,
  type GuardOutcome,
} from "../test/comment_heredoc_guard_cases.ts";

export interface ProbeOptions {
  surface: "claude" | "agy" | "codex";
  home: string;
  repoDir: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function registrations(config: unknown): { matcher: string; command: string }[] {
  if (!object(config) || !object(config.hooks) || !Array.isArray(config.hooks.PreToolUse)) {
    throw new Error("configuration has no PreToolUse registrations");
  }
  return config.hooks.PreToolUse.flatMap((entry: unknown) => {
    if (!object(entry) || typeof entry.matcher !== "string" || !Array.isArray(entry.hooks)) {
      throw new Error("unreadable PreToolUse registration");
    }
    return entry.hooks.flatMap((handler: unknown) => {
      if (!object(handler) || handler.type !== "command") return [];
      if (typeof handler.command !== "string") throw new Error("unreadable hook command");
      return [{ matcher: entry.matcher as string, command: handler.command }];
    });
  });
}

async function installedInvocation(options: ProbeOptions): Promise<string[]> {
  const { surface, home, repoDir } = options;
  const installed = join(home, ".claude/hooks/block-irreversible-operations.sh");
  const expected = join(repoDir, "hooks/block-irreversible-operations.sh");
  if (
    !(await Deno.lstat(installed)).isSymlink ||
    await Deno.realPath(installed) !== await Deno.realPath(expected)
  ) {
    throw new Error("installed guard symlink does not resolve into the requested canonical clone");
  }
  const configPath = surface === "codex"
    ? join(home, ".codex/config.toml")
    : join(home, surface === "agy" ? ".gemini/config/hooks.json" : ".claude/settings.json");
  const source = await Deno.readTextFile(configPath);
  const entries = registrations(surface === "codex" ? parse(source) : JSON.parse(source));
  const candidates = entries.map((entry) => ({
    matcher: entry.matcher,
    tokens: splitShellTokens(entry.command).map((token) =>
      token.replaceAll("${HOME}", home).replaceAll("$HOME", home)
    ),
  })).filter((entry) => entry.tokens.includes(installed));
  if (candidates.length !== 1) throw new Error("expected exactly one installed guard registration");
  const { matcher, tokens } = candidates[0];
  const tool = surface === "agy" ? "run_command" : "Bash";
  if (!new RegExp(`^(?:${matcher})$`).test(tool)) {
    throw new Error("registration does not match shell calls");
  }
  if (surface === "agy") {
    const shim = join(home, ".claude/hooks/agy-hook-shim.sh");
    if (
      tokens.length !== 4 || tokens[0] !== shim || tokens[1] !== "PreToolUse" ||
      tokens[3] !== installed || !new RegExp(`^(?:${atob(tokens[2])})$`).test("Bash") ||
      await Deno.realPath(shim) !== await Deno.realPath(join(repoDir, "hooks/agy-hook-shim.sh"))
    ) {
      throw new Error("registration does not target the existing agy shim and guard");
    }
    return tokens;
  }
  const expectedTokens = surface === "codex" ? ["WJT_SURFACE=codex", installed] : [installed];
  if (JSON.stringify(tokens) !== JSON.stringify(expectedTokens)) {
    throw new Error("registration does not target the existing guard with the expected surface");
  }
  return [installed];
}

function refusalOutcome(message: string): GuardOutcome {
  if (
    message.includes("could not read the command") &&
    message.includes("no protected operation was identified")
  ) return "unreadable";
  if (message.includes("This operation is irreversible and hard-blocked")) return "operation";
  throw new Error(`unexpected refusal: ${message}`);
}

export async function probeInstalledGuard(
  options: ProbeOptions,
  cases: readonly CommentHeredocCase[] = COMMENT_HEREDOC_GUARD_CASES,
): Promise<{ passed: number; total: number }> {
  // Never run a configuration string through a shell. Validate its known argv shape, then
  // launch only the guard/shim; the fixture string travels exclusively on JSON stdin.
  const args = await installedInvocation(options);
  const scratch = await Deno.makeTempDir({ prefix: "command-guard-probe-" });
  try {
    for (const row of cases) {
      const payload = options.surface === "agy"
        ? {
          toolCall: { name: "run_command", args: { CommandLine: row.command } },
          conversationId: "command-guard-probe",
          workspacePaths: [options.repoDir],
        }
        : {
          tool_name: "Bash",
          hook_event_name: "PreToolUse",
          cwd: options.repoDir,
          tool_input: { command: row.command },
        };
      const child = new Deno.Command("bash", {
        args,
        cwd: options.repoDir,
        env: {
          HOME: options.home,
          BASH_ENV: "",
          AGY_HOOK_RECORD_PATH: join(scratch, "agy.jsonl"),
          ...(options.surface === "codex" ? { WJT_SURFACE: "codex" } : {}),
        },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
      await writer.close();
      const output = await child.output();
      const stdout = new TextDecoder().decode(output.stdout).trim();
      const stderr = new TextDecoder().decode(output.stderr).trim();
      let actual: GuardOutcome;
      if (options.surface === "agy") {
        if (output.code !== 0) throw new Error(`agy shim failed: ${stderr}`);
        const verdict = JSON.parse(stdout);
        if (verdict.decision === "allow") actual = "allow";
        else if (verdict.decision === "deny") actual = refusalOutcome(verdict.reason ?? "");
        else throw new Error("unexpected agy decision");
      } else if (output.code === 0 && !stdout && !stderr) actual = "allow";
      else if (output.code === 2) actual = refusalOutcome(stderr);
      else throw new Error(`unexpected hook exit ${output.code}: ${stderr}`);
      if (actual !== row.irreversible) {
        throw new Error(`literal case ${row.id}: expected ${row.irreversible}, received ${actual}`);
      }
    }
    return { passed: cases.length, total: cases.length };
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
}

const HELP =
  `Usage: deno run --allow-read --allow-write=/tmp --allow-env=HOME --allow-run=bash scripts/probe-installed-command-guards.ts --guard irreversible --surface claude|agy|codex [--home PATH] [--repo-dir PATH]

Checks the existing symlink and registration, then supplies all 36 literal cases as JSON to
the installed guard (through the existing shim on agy). No fixture command is executed.
--home selects an isolated fixture home or defaults to HOME.
--repo-dir selects the canonical clone or defaults to the parent of this script.
No installer or registration change is performed. A mismatch exits 1; success exits 0.`;

export async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === "--help") {
    console.log(HELP);
    return 0;
  }
  try {
    const flags = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i];
      const value = args[i + 1];
      if (
        !["--guard", "--surface", "--home", "--repo-dir"].includes(flag) ||
        !value || value.startsWith("--") || flags.has(flag)
      ) throw new Error(HELP);
      flags.set(flag, value);
    }
    const surface = flags.get("--surface");
    if (
      flags.get("--guard") !== "irreversible" ||
      (surface !== "claude" && surface !== "agy" && surface !== "codex")
    ) throw new Error(HELP);
    const home = flags.get("--home") ?? Deno.env.get("HOME");
    if (!home) throw new Error("HOME is required unless --home is supplied");
    const result = await probeInstalledGuard({
      surface,
      home: resolve(home),
      repoDir: resolve(flags.get("--repo-dir") ?? new URL("..", import.meta.url).pathname),
    });
    console.log(
      `${surface} irreversible: ${result.passed}/${result.total} literal cases passed; fixture commands were never executed.`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) Deno.exit(await main(Deno.args));
