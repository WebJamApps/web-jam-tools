import { join } from "@std/path";

export interface CandidateSkillScopeOptions {
  skillName: string;
  candidateSkillsDir: string;
  installedSkillsDir?: string;
}

/** Refuse a different installed version without modifying shared user links. */
export async function withCandidateSkill<T>(
  options: CandidateSkillScopeOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const { skillName, candidateSkillsDir, installedSkillsDir } = options;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(skillName)) {
    throw new Error(`Invalid skill name: '${skillName}'`);
  }
  if (!installedSkillsDir) {
    throw new Error("Cannot verify the loaded skill without its installed skills directory");
  }
  const candidateDir = join(candidateSkillsDir, skillName);
  const installedDir = join(installedSkillsDir, skillName);
  // Check SKILL.md first so missing or unreadable installations refuse before execution.
  const candidateBody = await Deno.readTextFile(join(candidateDir, "SKILL.md"));
  const installedBody = await Deno.readTextFile(join(installedDir, "SKILL.md"));
  if (candidateBody !== installedBody || !(await sameSkillFiles(candidateDir, installedDir))) {
    throw new Error(
      `Installed skill '${skillName}' differs from the candidate; refusing to test the installed copy`,
    );
  }
  return await fn();
}

async function sameSkillFiles(candidateDir: string, installedDir: string): Promise<boolean> {
  const candidateFiles = await skillFiles(candidateDir);
  const installedFiles = await skillFiles(installedDir);
  if (candidateFiles.length !== installedFiles.length) return false;
  for (let i = 0; i < candidateFiles.length; i++) {
    if (candidateFiles[i] !== installedFiles[i]) return false;
    const candidate = await Deno.readFile(join(candidateDir, candidateFiles[i]));
    const installed = await Deno.readFile(join(installedDir, installedFiles[i]));
    if (candidate.length !== installed.length || candidate.some((b, j) => b !== installed[j])) {
      return false;
    }
  }
  return true;
}

async function skillFiles(root: string, subdir = ""): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(join(root, subdir))) {
    const relative = join(subdir, entry.name);
    // These prompts belong to the harness, not the agent's loaded skill version.
    if (!subdir && entry.name === "start-check.json") continue;
    if (entry.isSymlink) {
      throw new Error(`Cannot verify a skill containing a nested symlink: ${relative}`);
    }
    if (entry.isDirectory) files.push(...await skillFiles(root, relative));
    else if (entry.isFile) files.push(relative);
    else throw new Error(`Cannot verify a non-file skill resource: ${relative}`);
  }
  return files.sort();
}
