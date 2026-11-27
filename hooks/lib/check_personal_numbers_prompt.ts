/**
 * The prompt check of the personal information guards (web-jam-tools#1861).
 *
 * When Josh sends a message, this runs the checker (detect_personal_numbers.ts)
 * on the message's text before the message reaches the AI, and refuses the
 * message when the checker finds anything. The refusal names the kind of
 * number, never the number, and is never sent to the model.
 *
 * Design: ~/Dropbox/web-jam-llms/AI_Misbehaves/personal-information-guards-design.md,
 * "What Josh types" and "Both surfaces".
 *
 * Three outcomes:
 *   - Refuse: the checker finds a protected number in the message.
 *   - Allow: the checker finds nothing; the message is sent.
 *   - Refuse, failing closed: the payload carries no readable message.
 *
 * How each tool hands over the message and takes a refusal:
 *   - Claude Code (UserPromptSubmit): the payload's `prompt`; refuses by
 *     exiting 2 with the refusal on standard error.
 *   - Codex (UserPromptSubmit, WJT_SURFACE=codex): the payload's `prompt`;
 *     refuses by replying {"decision":"block","reason":"<the refusal>"}.
 *   - agy (PreInvocation, launched with --surface agy): the payload's
 *     `lastUserInput`; refuses by replying
 *     {"injectSteps":[{"errorMessage":{"userMessage":"<the refusal>"}}],"terminationBehavior":"terminate"}.
 */

import { describeKinds, detectPersonalNumbers } from "./detect_personal_numbers.ts";

export type Surface = "claude" | "codex" | "agy";

export type Verdict =
  | { kind: "allow" }
  | { kind: "found"; what: string }
  | { kind: "unreadable"; detail: string };

/** The tool that launched the check: `--surface agy`, else WJT_SURFACE=codex, else Claude Code. */
export function surfaceFrom(args: string[], env: string | undefined): Surface {
  if (args[0] === "--surface" && args[1] === "agy") return "agy";
  return env === "codex" ? "codex" : "claude";
}

/** The refusal wording; null when the message may be sent. */
export function refusalFor(verdict: Verdict): string | null {
  if (verdict.kind === "found") {
    return `Your message holds what looks like ${verdict.what}, so it was not sent. Take the number out and send it again.`;
  }
  if (verdict.kind === "unreadable") {
    return `The personal-numbers check could not read your message (${verdict.detail}), so it cannot tell whether it holds a personal number, and it was not sent. Send it again.`;
  }
  return null;
}

/** Reads the message from one tool's payload and runs the checker on it. */
export function checkPayload(raw: string, surface: Surface): Verdict {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: "unreadable", detail: "its payload is not JSON" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { kind: "unreadable", detail: "its payload is not an object" };
  }
  const field = surface === "agy" ? "lastUserInput" : "prompt";
  const message = (data as Record<string, unknown>)[field];
  if (typeof message !== "string") {
    return { kind: "unreadable", detail: `the payload holds no \`${field}\` text` };
  }
  const findings = detectPersonalNumbers(message);
  return findings.length ? { kind: "found", what: describeKinds(findings) } : { kind: "allow" };
}

/** What the hook prints and the exit code it ends with, for one tool. */
export function reply(
  verdict: Verdict,
  surface: Surface,
): { stdout: string; stderr: string; code: number } {
  const refusal = refusalFor(verdict);
  if (surface === "agy") {
    return {
      stdout: refusal === null ? "{}" : JSON.stringify({
        injectSteps: [{ errorMessage: { userMessage: refusal } }],
        terminationBehavior: "terminate",
      }),
      stderr: "",
      code: 0,
    };
  }
  if (refusal === null) return { stdout: "", stderr: "", code: 0 };
  if (surface === "codex") {
    return { stdout: JSON.stringify({ decision: "block", reason: refusal }), stderr: "", code: 0 };
  }
  return { stdout: "", stderr: refusal, code: 2 };
}

export async function main(): Promise<void> {
  const surface = surfaceFrom(Deno.args, Deno.env.get("WJT_SURFACE"));
  let verdict: Verdict;
  try {
    const raw = await new Response(Deno.stdin.readable).text();
    verdict = checkPayload(raw, surface);
  } catch (err) {
    verdict = {
      kind: "unreadable",
      detail: `the check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const out = reply(verdict, surface);
  if (out.stdout) console.log(out.stdout);
  if (out.stderr) console.error(out.stderr);
  Deno.exit(out.code);
}

if (import.meta.main) {
  await main();
}
