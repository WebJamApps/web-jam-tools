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

export type RosterProbe =
  | { outcome: "on-roster" }
  | { outcome: "not-on-roster"; rosterMessage: string }
  | { outcome: "could-not-run"; message: string };

/**
 * The one place the `--check-author` probe is run and its result classified
 * (web-jam-tools#1200, web-jam-tools#1205). Three outcomes: on the roster, not
 * on the roster (the probe's own roster listing is returned), or could not be
 * determined (probe missing, not runnable, or failing without the roster
 * message). The last is never reported as the second. Used by
 * scripts/post-pr-comment.ts for Work-by footers and by checkAuthorOnRoster
 * below for Authored-by footers.
 */
export async function probeRoster(
  author: string,
  runCmd: ProbeRunner,
  probeScriptPath: string = defaultProbeScriptPath(),
): Promise<RosterProbe> {
  let result: ProbeResult;
  try {
    result = await runCmd([probeScriptPath, "--check-author", author]);
  } catch (err) {
    return {
      outcome: "could-not-run",
      message: `roster check could not run: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (result.code === 0) return { outcome: "on-roster" };
  if (result.stderr.includes(NOT_ON_ROSTER_MARKER)) {
    return { outcome: "not-on-roster", rosterMessage: result.stderr.trim() };
  }
  return {
    outcome: "could-not-run",
    message: `roster check could not run (create-draft-pr.sh exited with code ${result.code}${
      result.stderr ? `: ${result.stderr.trim()}` : ""
    }).`,
  };
}

/**
 * Checks `author` against the roster through probeRoster. A missing or empty
 * author is reported as not on the roster.
 */
export async function checkAuthorOnRoster(
  author: string | undefined,
  runCmd: ProbeRunner,
  probeScriptPath: string = defaultProbeScriptPath(),
): Promise<AuthorCheck> {
  const given = (author ?? "").trim();
  const probe = await probeRoster(given, runCmd, probeScriptPath);
  if (probe.outcome === "could-not-run") {
    return { ok: false, reason: "could-not-run", message: `the ${probe.message}` };
  }
  if (given === "") {
    const head = "--author is required (it was missing or empty).";
    return {
      ok: false,
      reason: "not-on-roster",
      message: probe.outcome === "not-on-roster" ? `${head}\n${probe.rosterMessage}` : head,
    };
  }
  if (probe.outcome === "on-roster") return { ok: true };
  return {
    ok: false,
    reason: "not-on-roster",
    message:
      `--author '${given}' does not name a model on the author roster.\n${probe.rosterMessage}`,
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
