/** Apply the protected-branch rule to Edit/Write, apply_patch, and known Bash write targets. */
import { dirname, isAbsolute, resolve } from "jsr:@std/path@^1.0.0";
import { bashWriteTargets } from "./bash_write_targets.ts";
import { parseApplyPatchFilePaths } from "./parse_apply_patch.ts";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function allowWithNote(reason: string): void {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        `feature-branch guard: ${reason}; proceeding. Verify that any repository write targets a feature branch.`,
    },
  }));
}

/** Start at a directory target itself, or the nearest existing parent of a file target. */
function targetDirectory(target: string): string {
  let dir = target;
  while (true) {
    try {
      if (Deno.statSync(dir).isDirectory) return dir;
    } catch (error) {
      if (
        !(error instanceof Deno.errors.NotFound) && !(error instanceof Deno.errors.NotADirectory)
      ) {
        throw error;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

function git(dir: string, args: string[]): { code: number; text: string } {
  const result = new Deno.Command("git", {
    args: ["-C", dir, ...args],
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  return { code: result.code, text: new TextDecoder().decode(result.stdout).trim() };
}

export function checkFeatureBranch(raw: unknown): void {
  const payload = record(raw);
  const input = record(payload.tool_input);
  const cwd = typeof payload.cwd === "string" && isAbsolute(payload.cwd) ? payload.cwd : Deno.cwd();
  let targets: string[];
  if (payload.tool_name === "Bash") {
    if (typeof input.command !== "string") {
      allowWithNote("the Bash command could not be read");
      return;
    }
    targets = bashWriteTargets(input.command, { cwd, home: Deno.env.get("HOME") ?? "" });
  } else if (payload.tool_name === "apply_patch") {
    targets = parseApplyPatchFilePaths(typeof input.command === "string" ? input.command : "");
    if (targets.length === 0) {
      console.error(
        "BLOCKED: apply_patch contains no parseable file path (malformed or unrecognized patch text).",
      );
      Deno.exit(2);
    }
  } else {
    targets = typeof input.file_path === "string" && input.file_path ? [input.file_path] : [];
  }

  for (const target of targets) {
    const file = resolve(cwd, target);
    const dir = targetDirectory(file);
    const top = git(dir, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0 || !top.text) continue; // Outside a git working tree, as before.
    const branch = git(dir, ["branch", "--show-current"]);
    if (branch.code !== 0) {
      allowWithNote("a target repository's branch could not be read");
      continue;
    }
    if (["dev", "main", "master"].includes(branch.text)) {
      console.error(
        `BLOCKED: ${top.text} is on protected branch '${branch.text}'. Create a feature branch before editing code (file: '${file}'):\n  git -C '${top.text}' checkout -b <feat-name> origin/dev\n(rule: git-feature-branch-and-semver)`,
      );
      Deno.exit(2);
    }
  }
}

if (import.meta.main) {
  try {
    checkFeatureBranch(JSON.parse(await new Response(Deno.stdin.readable).text()));
  } catch {
    allowWithNote("the payload or write targets could not be evaluated");
  }
}
