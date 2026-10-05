import { join } from "@std/path";

export interface CandidateSkillScopeOptions {
  skillName: string;
  candidateSkillsDir: string;
  installedSkillsDir?: string;
}

/**
 * Ensures that the isolated agent session loads the candidate skill files
 * from `candidateSkillsDir` rather than an unchanged installed copy on dev,
 * while preserving the user's installed symlinks before and after execution.
 *
 * If the loaded skill differs from the candidate, or the installed path
 * cannot be safely managed (e.g. is a non-symlink regular directory),
 * it refuses (fails closed).
 */
export async function withCandidateSkill<T>(
  options: CandidateSkillScopeOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const { skillName, candidateSkillsDir, installedSkillsDir } = options;
  if (!installedSkillsDir) {
    return await fn();
  }

  const candidateDir = join(candidateSkillsDir, skillName);
  try {
    const stat = await Deno.stat(candidateDir);
    if (!stat.isDirectory) {
      throw new Error(`Candidate skill path '${candidateDir}' is not a directory`);
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(`Candidate skill directory not found: ${candidateDir}`);
    }
    throw err;
  }

  const candidateSkillFile = join(candidateDir, "SKILL.md");
  try {
    await Deno.stat(candidateSkillFile);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(`Candidate SKILL.md not found at ${candidateSkillFile}`);
    }
    throw err;
  }

  const installedLink = join(installedSkillsDir, skillName);
  let originalTarget: string | null = null;
  let swapped = false;
  let createdNew = false;

  try {
    const lstat = await Deno.lstat(installedLink);
    if (!lstat.isSymlink) {
      throw new Error(
        `Installed skill path '${installedLink}' is not a symlink; cannot safely point to candidate`,
      );
    }
    originalTarget = await Deno.readLink(installedLink);
    const resolvedInstalled = await Deno.realPath(installedLink).catch(() => originalTarget);
    const resolvedCandidate = await Deno.realPath(candidateDir);
    if (resolvedInstalled !== resolvedCandidate) {
      await Deno.remove(installedLink);
      await Deno.symlink(candidateDir, installedLink);
      swapped = true;
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      await Deno.mkdir(installedSkillsDir, { recursive: true });
      await Deno.symlink(candidateDir, installedLink);
      createdNew = true;
    } else {
      throw err;
    }
  }

  // Refuse if the loaded version differs from the candidate version
  try {
    const finalResolved = await Deno.realPath(installedLink);
    const candidateResolved = await Deno.realPath(candidateDir);
    if (finalResolved !== candidateResolved) {
      throw new Error(
        `Loaded skill version at '${finalResolved}' differs from candidate '${candidateResolved}'`,
      );
    }
  } catch (err) {
    throw new Error(
      `Failed to verify loaded candidate skill: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  try {
    return await fn();
  } finally {
    if (swapped && originalTarget !== null) {
      try {
        await Deno.remove(installedLink);
        await Deno.symlink(originalTarget, installedLink);
      } catch {
        // Best-effort cleanup
      }
    } else if (createdNew) {
      try {
        await Deno.remove(installedLink);
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
