import { join } from "@std/path";
import type { SkillStartCheckPrompts } from "./types.ts";

/**
 * Loads and validates `start-check.json` for a given skill.
 * Fails closed if the file is missing, invalid JSON, or missing either prompt.
 */
export async function loadStartCheckPrompts(
  skillsDir: string,
  skillName: string,
): Promise<SkillStartCheckPrompts> {
  const filePath = join(skillsDir, skillName, "start-check.json");
  try {
    const raw = await Deno.readTextFile(filePath);
    const parsed = JSON.parse(raw);
    const byName = parsed.by_name ?? parsed.byName;
    const onItsOwn = parsed.on_its_own ?? parsed.onItsOwn;

    if (!byName || typeof byName !== "string" || !byName.trim()) {
      throw new Error(`Missing or empty 'by_name' prompt in ${filePath}`);
    }
    if (!onItsOwn || typeof onItsOwn !== "string" || !onItsOwn.trim()) {
      throw new Error(`Missing or empty 'on_its_own' prompt in ${filePath}`);
    }

    return {
      by_name: byName.trim(),
      on_its_own: onItsOwn.trim(),
    };
  } catch (err) {
    throw new Error(
      `Cannot read start-check.json for skill '${skillName}' at ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Reads the first `# ` heading line of a skill's `SKILL.md`.
 * Fails closed if the file cannot be read or no `# ` heading exists.
 */
export async function readSkillFirstHeading(
  skillsDir: string,
  skillName: string,
): Promise<string> {
  const filePath = join(skillsDir, skillName, "SKILL.md");
  try {
    const raw = await Deno.readTextFile(filePath);
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith("# ")) {
        return line.trim();
      }
    }
    throw new Error(`No '# ' heading line found in ${filePath}`);
  } catch (err) {
    throw new Error(
      `Cannot read SKILL.md for skill '${skillName}' at ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
