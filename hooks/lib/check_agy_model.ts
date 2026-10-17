/**
 * Helper logic for block-agy-non-flash-model.sh (web-jam-tools#382)
 */
import {
  MAX_WRAPPER_ITERATIONS,
  MAX_WRAPPER_RECURSION_DEPTH,
  resolveThroughWrappers,
  splitOnOperators,
  splitShellTokens,
  stripHeredocs,
} from "./normalize_command.ts";

export interface AgyModelSpec {
  slug: string;
  displayName: string;
}

const FLASH_MODEL: AgyModelSpec = {
  slug: "gemini-3.8-flash-high",
  displayName: "Gemini 3.8 Flash (High)",
};
const ARGON_MODEL: AgyModelSpec = {
  slug: "gemini-4-argon-high",
  displayName: "Gemini 4 Argon (High)",
};

/** Every model agy may run: Flash and Argon, both at high effort only (design 1.5.0). */
export const ALLOWED_AGY_MODELS: readonly AgyModelSpec[] = [FLASH_MODEL, ARGON_MODEL];

/**
 * The models agy dispatches on when nothing names one: Flash only. Argon runs only when a
 * dispatch names it (AGY_MODELS or --model), so it stays out of the default chain.
 */
export const DEFAULT_AGY_MODELS: readonly AgyModelSpec[] = [FLASH_MODEL];

/**
 * Derives the runtime session slugs by combining the explicit AGY models
 * with the corresponding -tiered variant derived from each model version,
 * keeping the tiered slug in lockstep whenever ALLOWED_AGY_MODELS migrates.
 */
export function deriveSessionSlugs(models: readonly AgyModelSpec[]): readonly string[] {
  const versions = Array.from(
    new Set(
      models
        .map((m) => m.slug.match(/^gemini-(\d+(?:\.\d+)*)-flash-/)?.[1])
        .filter((v): v is string => Boolean(v)),
    ),
  );
  const tieredSlugs = versions.map((v) => `gemini-${v}-flash-tiered`);
  return [
    ...models.map((m) => m.slug),
    ...tieredSlugs,
  ];
}

export const ALLOWED_SESSION_SLUGS: readonly string[] = deriveSessionSlugs(ALLOWED_AGY_MODELS);

export function isAllowedModelSlug(slug: string): boolean {
  if (ALLOWED_AGY_MODELS.some((m) => m.slug === slug)) return true;
  const match = slug.match(/^gemini-(\d+(?:\.\d+)*)-flash-(high|tiered)$/);
  if (!match) return false;
  const versionStr = match[1];
  const parts = versionStr.split(".").map((p) => parseInt(p, 10));
  if (parts.some((p) => isNaN(p))) return false;
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  if (major > 3) return true;
  if (major === 3 && minor >= 7) return true;
  return false;
}

const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const MODEL_FLAG = "--model";

/** True when `value` names an allowed model, as a session slug or as a display name. */
export function isAllowedAgyModel(value: string): boolean {
  return isAllowedModelSlug(value) || ALLOWED_AGY_MODELS.some((m) => m.displayName === value);
}

// Shell keywords and builtins that put another command in front of `agy` but that the shared
// wrapper resolver (resolveThroughWrappers) does not peel: `time`, `exec`, and the `!` negation.
const LEADING_KEYWORDS = new Set(["time", "exec", "!"]);

const AGY_WORD_RE = /(^|[^A-Za-z0-9_-])agy($|[^A-Za-z0-9_-])/;

// Returned when a command that mentions agy cannot be parsed, so the guard refuses (fails
// closed) rather than guess. A command that never mentions agy is not this guard's business.
function parseFailure(cmd: string, reason: string): string {
  return AGY_WORD_RE.test(cmd) ? "BLOCK_PARSE:" + reason : "OK";
}

class ParseFailure extends Error {}

function checkSegments(cmd: string, inheritedEnv: string | null, depth: number): string {
  if (depth > MAX_WRAPPER_RECURSION_DEPTH) throw new ParseFailure("wrappers nested too deeply");
  const { segments, unterminated } = splitOnOperators(stripHeredocs(cmd));
  if (unterminated) throw new ParseFailure("an unterminated quote");

  for (const segment of segments) {
    let argv = splitShellTokens(segment);
    let envAgyModels = inheritedEnv;
    let iterations = 0;
    let nested: string | null = null;

    while (true) {
      if (++iterations > MAX_WRAPPER_ITERATIONS) {
        throw new ParseFailure("wrappers nested too deeply");
      }
      let i = 0;
      while (i < argv.length) {
        const m = argv[i].match(ASSIGN_RE);
        if (!m) break;
        if (m[1] === "AGY_MODELS") envAgyModels = m[2];
        i++;
      }
      if (i < argv.length && LEADING_KEYWORDS.has(argv[i])) {
        argv = argv.slice(i + 1);
        continue;
      }
      const resolved = resolveThroughWrappers(argv);
      if (resolved.kind === "cap-exceeded") throw new ParseFailure("wrappers nested too deeply");
      if (resolved.kind === "nested") {
        nested = resolved.command;
        break;
      }
      // resolveThroughWrappers hands back the same array when no wrapper was peeled.
      if (resolved.argv === argv) break;
      argv = resolved.argv;
    }

    if (nested !== null) {
      const result = checkSegments(nested, envAgyModels, depth + 1);
      if (result !== "OK") return result;
      continue;
    }

    let i = 0;
    while (i < argv.length && ASSIGN_RE.test(argv[i])) i++;
    if (i >= argv.length) continue;
    if (argv[i].split("/").pop() !== "agy") continue;
    const args = argv.slice(i + 1);

    if (envAgyModels !== null) {
      const values = envAgyModels.split("|").filter(Boolean);
      const bad = values.filter((v) => !isAllowedAgyModel(v));
      if (values.length === 0 || bad.length > 0) {
        return "BLOCK_ENV:" + envAgyModels;
      }
    }

    let j = 0;
    while (j < args.length) {
      const a = args[j];
      if (a === MODEL_FLAG) {
        if (j + 1 >= args.length) {
          return "BLOCK_MODEL:(missing value)";
        }
        const val = args[j + 1];
        if (!isAllowedAgyModel(val)) {
          return "BLOCK_MODEL:" + val;
        }
        j += 2;
        continue;
      }
      if (a.startsWith(MODEL_FLAG + "=")) {
        const val = a.slice(MODEL_FLAG.length + 1);
        if (!isAllowedAgyModel(val)) {
          return "BLOCK_MODEL:" + val;
        }
        j += 1;
        continue;
      }
      j += 1;
    }
  }

  return "OK";
}

/**
 * Checks every command in `cmd` that runs agy, wherever it sits: first word, behind a prefix
 * wrapper (`timeout`, `nice`, `nohup`, `env`, `command`, `exec`, `time`, `sudo`, ...), after
 * `cd x &&`, or inside a `bash -c` / `sh -c` payload. Returns "OK", or a BLOCK_* code.
 * A command that mentions agy and cannot be parsed returns BLOCK_PARSE (fails closed).
 */
export function checkAgyModel(cmd: string): string {
  try {
    return checkSegments(cmd, null, 0);
  } catch (e) {
    return parseFailure(cmd, e instanceof ParseFailure ? e.message : "command could not be parsed");
  }
}

if (import.meta.main) {
  const arg = Deno.args[0] || "";
  if (arg === "--default-models") {
    console.log(DEFAULT_AGY_MODELS.map((m) => m.displayName).join("|"));
  } else if (arg === "--allowed-slugs") {
    console.log(ALLOWED_SESSION_SLUGS.join(" or "));
  } else {
    const cmd = Deno.env.get("CMD_FOR_PY") || arg;
    console.log(checkAgyModel(cmd));
  }
}
