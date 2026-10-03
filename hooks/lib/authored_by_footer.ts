/**
 * Authored-by footer helpers (web-jam-tools#1205).
 *
 * Every issue body ends with one line, `🤖 Authored by <tool> — <model>`,
 * naming the model that wrote the issue's content. The roster of valid models
 * lives in exactly one place, scripts/create-draft-pr.sh, and is reached only
 * through its read-only `--check-author` probe; nothing here copies it.
 *
 * Shared by src/create-issue/lib.ts, scripts/edit-issue.ts and
 * hooks/lib/check_model_label_on_issue_create.ts. Deliberately has no imports
 * so the hook can run it with `deno run --no-config`.
 */

export const FOOTER_PREFIX = "🤖 Authored by";

export interface ProbeResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command and returns its result; throws when it cannot be started. */
export type ProbeRunner = (cmd: string[]) => Promise<ProbeResult>;

export type AuthorCheck =
  | { ok: true }
  | { ok: false; reason: "not-on-roster" | "could-not-run"; message: string };

const NOT_ON_ROSTER_MARKER = "does not name a model on the roster";

/** Absolute path of scripts/create-draft-pr.sh, resolved from this file, never from the cwd. */
export function defaultProbeScriptPath(): string {
  return decodeURIComponent(new URL("../../scripts/create-draft-pr.sh", import.meta.url).pathname);
}

/** The author named by the body's footer (its last non-empty line), or null when there is none. */
export function findFooter(body: string): { author: string; line: string } | null {
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    if (!line.startsWith(FOOTER_PREFIX)) return null;
    return { author: line.slice(FOOTER_PREFIX.length).trim(), line };
  }
  return null;
}

/** The body with any footer already at its end removed, trailing whitespace trimmed. */
export function stripFooter(body: string): string {
  return findFooter(body) === null
    ? body.trimEnd()
    : body.trimEnd().split("\n").slice(0, -1).join("\n").trimEnd();
}

/** The body ending with exactly one footer naming `author`. */
export function withFooter(body: string, author: string): string {
  const base = stripFooter(body);
  return `${base}${base === "" ? "" : "\n\n"}${FOOTER_PREFIX} ${author.trim()}\n`;
}

/**
 * Checks `author` against the roster through the probe. Three outcomes: on the
 * roster, not on the roster (including missing or empty), or could not be
 * determined (probe missing, not runnable, or failing without the roster
 * message). The last is never reported as the second.
 */
export async function checkAuthorOnRoster(
  author: string | undefined,
  runCmd: ProbeRunner,
  probeScriptPath: string = defaultProbeScriptPath(),
): Promise<AuthorCheck> {
  const given = (author ?? "").trim();
  let result: ProbeResult;
  try {
    result = await runCmd([probeScriptPath, "--check-author", given]);
  } catch (err) {
    return {
      ok: false,
      reason: "could-not-run",
      message: `the roster check could not run: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (result.code === 0) {
    return given === ""
      ? {
        ok: false,
        reason: "not-on-roster",
        message: "--author is required (it was missing or empty).",
      }
      : { ok: true };
  }
  if (result.stderr.includes(NOT_ON_ROSTER_MARKER)) {
    const head = given === ""
      ? "--author is required (it was missing or empty)."
      : `--author '${given}' does not name a model on the author roster.`;
    return { ok: false, reason: "not-on-roster", message: `${head}\n${result.stderr.trim()}` };
  }
  return {
    ok: false,
    reason: "could-not-run",
    message: `the roster check could not run (create-draft-pr.sh exited with code ${result.code}${
      result.stderr ? `: ${result.stderr.trim()}` : ""
    }).`,
  };
}

/** Real probe runner. Throws when the command cannot be started. */
export const realProbeRunner: ProbeRunner = async (cmd) => {
  const { code, stdout, stderr } = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
};
