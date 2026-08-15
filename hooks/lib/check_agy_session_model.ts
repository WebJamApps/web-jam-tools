/**
 * Helper logic for hooks/agy-model-guard.sh (web-jam-tools#432 scope item 7).
 *
 * Reads a shim-normalized PreToolUse payload (hooks/lib/agy_hook_shim.ts)
 * from stdin and checks its `modelName` field — carried directly in agy's
 * own payload (finding 7, unlike Claude Code, which exposes no model field
 * to hooks at all) — against the same Flash allowlist/floor already used by
 * hooks/block-agy-non-flash-model.sh (hooks/lib/check_agy_model.ts), so the
 * two guards can never drift apart on what counts as an allowed model.
 *
 * Fail OPEN when `modelName` is missing/empty: this is a cost-control guard,
 * not a secret-leak guard, so an unparseable/absent field is let through
 * rather than guessed at — same fail-open convention as
 * hooks/block-agy-non-flash-model.sh.
 */
import { ALLOWED_AGY_MODELS, isAllowedModelSlug } from "./check_agy_model.ts";

export interface SessionModelResult {
  allowed: boolean;
  reason?: string;
}

export function checkSessionModel(modelName: string | undefined | null): SessionModelResult {
  if (!modelName) {
    return { allowed: true };
  }
  if (isAllowedModelSlug(modelName)) {
    return { allowed: true };
  }
  const allowedSlugs = ALLOWED_AGY_MODELS.map((m) => m.slug).join(" or ");
  return {
    allowed: false,
    reason:
      `agy session model '${modelName}' is not an allowed Flash slug (allowed: ${allowedSlugs}). ` +
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
  const rawInput = await readAllStdin();
  let modelName: string | undefined;
  try {
    const parsed = JSON.parse(rawInput);
    modelName = typeof parsed?.modelName === "string" ? parsed.modelName : undefined;
  } catch {
    modelName = undefined;
  }
  const result = checkSessionModel(modelName);
  if (!result.allowed) {
    console.error(`BLOCKED (agy-model guard): ${result.reason}`);
    Deno.exit(2);
  }
  Deno.exit(0);
}
