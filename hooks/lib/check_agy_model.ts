/**
 * Helper logic for block-agy-non-flash-model.sh (web-jam-tools#382)
 */
import { splitShellTokens } from "./normalize_command.ts";

export interface AgyModelSpec {
  slug: string;
  displayName: string;
}

export const ALLOWED_AGY_MODELS: readonly AgyModelSpec[] = [
  { slug: "gemini-3.6-flash-medium", displayName: "Gemini 3.6 Flash (Medium)" },
  { slug: "gemini-3.6-flash-high", displayName: "Gemini 3.6 Flash (High)" },
];

export const ALLOWED = new Set(ALLOWED_AGY_MODELS.map((m) => m.slug));
const OPERATORS = new Set(["&&", "||", ";", "|", "(", ")"]);
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function checkAgyModel(cmd: string): string {
  let tokens: string[];
  try {
    tokens = splitShellTokens(cmd);
  } catch {
    return "OK";
  }

  const simpleCommands: string[][] = [[]];
  for (const tok of tokens) {
    if (OPERATORS.has(tok)) {
      simpleCommands.push([]);
    } else {
      simpleCommands[simpleCommands.length - 1].push(tok);
    }
  }

  for (const sc of simpleCommands) {
    if (sc.length === 0) continue;

    let i = 0;
    let envAgyModels: string | null = null;
    while (i < sc.length) {
      const m = sc[i].match(ASSIGN_RE);
      if (!m) break;
      if (m[1] === "AGY_MODELS") {
        envAgyModels = m[2];
      }
      i++;
    }
    if (i >= sc.length) continue;

    const commandName = sc[i].split("/").pop();
    if (commandName !== "agy") continue;

    const args = sc.slice(i + 1);

    if (envAgyModels !== null) {
      const values = envAgyModels.split("|").filter(Boolean);
      const bad = values.filter((v) => !ALLOWED.has(v));
      if (values.length === 0 || bad.length > 0) {
        return "BLOCK_ENV:" + envAgyModels;
      }
    }

    let j = 0;
    while (j < args.length) {
      const a = args[j];
      if (a === "--model") {
        if (j + 1 >= args.length) {
          return "BLOCK_MODEL:(missing value)";
        }
        const val = args[j + 1];
        if (!ALLOWED.has(val)) {
          return "BLOCK_MODEL:" + val;
        }
        j += 2;
        continue;
      }
      if (a.startsWith("--model=")) {
        const val = a.slice("--model=".length);
        if (!ALLOWED.has(val)) {
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

if (import.meta.main) {
  const arg = Deno.args[0] || "";
  if (arg === "--default-models") {
    console.log(ALLOWED_AGY_MODELS.map((m) => m.displayName).join("|"));
  } else {
    const cmd = Deno.env.get("CMD_FOR_PY") || arg;
    console.log(checkAgyModel(cmd));
  }
}
