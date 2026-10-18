/**
 * Helper logic for hooks/agy-model-guard.sh (web-jam-tools#432 scope item 7).
 *
 * Reads a shim-normalized PreToolUse payload (hooks/lib/agy_hook_shim.ts)
 * from stdin and checks its `modelName` field — carried directly in agy's
 * own payload (finding 7, unlike Claude Code, which exposes no model field
 * to hooks at all) — against the same Flash/Argon/Sonnet high allowlist already used by
 * hooks/block-agy-non-flash-model.sh (hooks/lib/check_agy_model.ts), so the
 * two guards can never drift apart on what counts as an allowed model.
 *
 * Fail OPEN when `modelName` is missing/empty: this is a cost-control guard,
 * so an unparseable/absent field is let through with additionalContext
 * telling the agent to verify the session model.
 */
import { ALLOWED_SESSION_SLUGS, isAllowedModelSlug } from "./check_agy_model.ts";
import { checkAndConsumeWorkflowSwitch, type SwitchCheckResult } from "./workflow_switch.ts";

export interface SessionModelResult {
  allowed: boolean;
  reason?: string;
}

export function checkSessionModel(
  modelName: string | undefined | null,
  switchChecker?: (guardName: string) => SwitchCheckResult,
): SessionModelResult {
  if (!modelName?.trim()) {
    return {
      allowed: true,
      reason:
        "could not determine modelName; proceeding. Verify the agy session uses an allowed high model before continuing.",
    };
  }
  if (isAllowedModelSlug(modelName)) {
    return { allowed: true };
  }
  if (switchChecker) {
    const sw = switchChecker("agy-model-guard");
    if (sw.released) {
      return { allowed: true, reason: sw.reason };
    }
  }
  const allowedSlugs = ALLOWED_SESSION_SLUGS.join(" or ");
  return {
    allowed: false,
    reason:
      `agy session model '${modelName}' is not an allowed agy model slug (allowed: ${allowedSlugs}). ` +
      `(design: web-jam-tools#267, web-jam-tools#432)`,
  };
}

async function readAllStdin(): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const buf = new Uint8Array(65536);
  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;
    text += decoder.decode(buf.subarray(0, n), { stream: true });
  }
  text += decoder.decode();
  return text;
}

if (import.meta.main) {
  let modelName: string | undefined;
  try {
    const rawInput = await readAllStdin();
    const parsed = JSON.parse(rawInput);
    modelName = typeof parsed?.modelName === "string" ? parsed.modelName : undefined;
  } catch {
    modelName = undefined;
  }
  const result = checkSessionModel(modelName, (guard) => checkAndConsumeWorkflowSwitch(guard));
  if (!result.allowed) {
    console.error(`BLOCKED (agy-model guard): ${result.reason}`);
    Deno.exit(2);
  }
  if (result.reason) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `agy-model guard: ${result.reason}`,
      },
    }));
  }
  Deno.exit(0);
}
