/**
 * install-skills library (web-jam-tools#669)
 *
 * Safe skill installer and stale symlink pruner for Claude Code and agy.
 * Ensures the primary repository is the single source of truth for all skills,
 * refuses execution from unsafe /tmp or git worktree directories, prunes dangling
 * symlinks across both destinations, and preserves local-only runtime files.
 */

import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";

export interface InstallSkillsOptions {
  repoDir?: string;
  claudeDest?: string;
  agyDest?: string;
  force?: boolean;
  dryRun?: boolean;
  quiet?: boolean;
  allowUnsafeForTesting?: boolean;
}

export interface ExecDeps {
  runCmd: (
    cmd: string[],
    cwd?: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export const defaultExecDeps: ExecDeps = {
  async runCmd(cmd: string[], cwd?: string) {
    const command = new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      cwd,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  },
};

export function parseArgs(args: string[]): InstallSkillsOptions {
  const options: InstallSkillsOptions = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--repo-dir" && i + 1 < args.length) {
      options.repoDir = args[++i];
    } else if (arg.startsWith("--repo-dir=")) {
      options.repoDir = arg.slice("--repo-dir=".length);
    } else if (arg === "--claude-dest" && i + 1 < args.length) {
      options.claudeDest = args[++i];
    } else if (arg.startsWith("--claude-dest=")) {
      options.claudeDest = arg.slice("--claude-dest=".length);
    } else if (arg === "--agy-dest" && i + 1 < args.length) {
      options.agyDest = args[++i];
    } else if (arg.startsWith("--agy-dest=")) {
      options.agyDest = arg.slice("--agy-dest=".length);
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--quiet" || arg === "-q") {
      options.quiet = true;
    } else if (arg === "--allow-unsafe-for-testing") {
      options.allowUnsafeForTesting = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: deno task install-skills [options]

Options:
  --repo-dir <path>     Explicit repository root path
  --claude-dest <path>  Destination directory for Claude skills (~/.claude/skills)
  --agy-dest <path>     Destination directory for agy skills (~/.gemini/config/plugins/webjam-tasks/skills)
  --force               Bypass worktree refusal guard
  --dry-run             Report actions without making filesystem changes
  --quiet, -q           Suppress non-error output
  --help, -h            Show this help message`);
      Deno.exit(0);
    }
    i++;
  }
  return options;
}

export function getTimestamp(d: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

export function isUnsafeSourcePath(dirPath: string): boolean {
  const normalized = resolve(dirPath).replace(/\/+$/, "");
  const tmpEnv = Deno.env.get("TMPDIR")?.replace(/\/+$/, "");

  const unsafePrefixes = [
    "/tmp",
    "/private/tmp",
    "/var/tmp",
  ];
  if (tmpEnv && tmpEnv.length > 0) {
    unsafePrefixes.push(resolve(tmpEnv).replace(/\/+$/, ""));
  }

  for (const prefix of unsafePrefixes) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

export async function resolveAndValidateRepoDir(
  options: InstallSkillsOptions,
  deps: ExecDeps = defaultExecDeps,
): Promise<string> {
  const baseRepoDir = options.repoDir
    ? resolve(options.repoDir)
    : resolve(fromFileUrl(new URL("../../", import.meta.url)));

  if (!options.allowUnsafeForTesting && isUnsafeSourcePath(baseRepoDir)) {
    throw new Error(
      `${baseRepoDir} is an unsafe source directory (/tmp). Skills must be installed from the primary checkout.`,
    );
  }

  // Check git worktree status
  try {
    const gitDirRes = await deps.runCmd(
      ["git", "rev-parse", "--path-format=absolute", "--git-dir"],
      baseRepoDir,
    );
    const gitCommonDirRes = await deps.runCmd(
      ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
      baseRepoDir,
    );

    if (gitDirRes.code === 0 && gitCommonDirRes.code === 0) {
      const gitDir = gitDirRes.stdout.trim();
      const gitCommonDir = gitCommonDirRes.stdout.trim();

      if (gitDir && gitCommonDir && gitDir !== gitCommonDir) {
        if (!options.force && !options.allowUnsafeForTesting) {
          throw new Error(
            `${baseRepoDir} is a git worktree, not the primary checkout. Skills must be installed from the primary checkout.`,
          );
        }
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("primary checkout")) {
      throw err;
    }
    // If git command fails (e.g. not a git repo), proceed
  }

  return baseRepoDir;
}

async function getAllRegularFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory) {
        files.push(...(await getAllRegularFiles(full)));
      } else if (entry.isFile) {
        files.push(full);
      }
    }
  } catch {
    // Directory might not exist
  }
  return files;
}

export async function pruneFromDest(
  targetDest: string,
  label: string,
): Promise<string[]> {
  const messages: string[] = [];
  let destStat: Deno.FileInfo | null = null;
  try {
    destStat = await Deno.stat(targetDest);
  } catch {
    return messages;
  }
  if (!destStat.isDirectory) return messages;

  const entries: string[] = [];
  for await (const entry of Deno.readDir(targetDest)) {
    entries.push(entry.name);
  }
  entries.sort();

  for (const name of entries) {
    // Never touch *.bak-* directories/files
    if (name.includes(".bak-")) {
      continue;
    }

    const fullPath = join(targetDest, name);
    let lstat: Deno.FileInfo | null = null;
    try {
      lstat = await Deno.lstat(fullPath);
    } catch {
      continue;
    }

    if (lstat.isSymlink) {
      let targetExists = false;
      try {
        await Deno.stat(fullPath);
        targetExists = true;
      } catch {
        targetExists = false;
      }

      if (!targetExists) {
        await Deno.remove(fullPath);
        messages.push(`${label}: ${name}: pruned stale symlink (target deleted)`);
      }
    }
  }
  return messages;
}

export async function installToDest(
  skillsSrc: string,
  targetDest: string,
  label: string,
  stamp: string,
): Promise<string[]> {
  const messages: string[] = [];
  await Deno.mkdir(targetDest, { recursive: true });

  const skillEntries: string[] = [];
  for await (const entry of Deno.readDir(skillsSrc)) {
    if (entry.isDirectory) {
      skillEntries.push(entry.name);
    }
  }
  skillEntries.sort();

  for (const name of skillEntries) {
    const src = join(skillsSrc, name);
    const dest = join(targetDest, name);

    let destLstat: Deno.FileInfo | null = null;
    try {
      destLstat = await Deno.lstat(dest);
    } catch {
      destLstat = null;
    }

    if (destLstat?.isSymlink) {
      let isSameTarget = false;
      try {
        const currentTarget = await Deno.readLink(dest);
        const canonicalTarget = resolve(targetDest, currentTarget);
        const canonicalSrc = resolve(src);
        if (canonicalTarget === canonicalSrc) {
          isSameTarget = true;
        } else {
          const realTarget = await Deno.realPath(dest);
          const realSrc = await Deno.realPath(src);
          if (realTarget === realSrc) {
            isSameTarget = true;
          }
        }
      } catch {
        isSameTarget = false;
      }

      if (isSameTarget) {
        messages.push(`${label}: ${name}: ok (already linked)`);
        continue;
      }

      const backupDest = `${dest}.bak-${stamp}`;
      await Deno.rename(dest, backupDest);
      await Deno.symlink(src, dest, { type: "dir" });
      messages.push(
        `${label}: ${name}: linked (previous version backed up to ${name}.bak-${stamp})`,
      );
    } else if (destLstat?.isDirectory) {
      // Real directory: preserve local-only files before backup
      const allFiles = await getAllRegularFiles(dest);
      for (const f of allFiles) {
        const rel = relative(dest, f);
        const targetPath = join(src, rel);
        let targetExists = false;
        try {
          await Deno.lstat(targetPath);
          targetExists = true;
        } catch {
          targetExists = false;
        }
        if (!targetExists) {
          await Deno.mkdir(dirname(targetPath), { recursive: true });
          await Deno.copyFile(f, targetPath);
        }
      }

      const backupDest = `${dest}.bak-${stamp}`;
      await Deno.rename(dest, backupDest);
      await Deno.symlink(src, dest, { type: "dir" });
      messages.push(
        `${label}: ${name}: linked (previous version backed up to ${name}.bak-${stamp})`,
      );
    } else if (destLstat !== null) {
      const backupDest = `${dest}.bak-${stamp}`;
      await Deno.rename(dest, backupDest);
      await Deno.symlink(src, dest, { type: "dir" });
      messages.push(
        `${label}: ${name}: linked (previous version backed up to ${name}.bak-${stamp})`,
      );
    } else {
      await Deno.symlink(src, dest, { type: "dir" });
      messages.push(`${label}: ${name}: linked (new)`);
    }
  }

  return messages;
}

export async function installSkills(
  options: InstallSkillsOptions = {},
  deps: ExecDeps = defaultExecDeps,
): Promise<{ success: boolean; messages: string[]; skillsCount: number }> {
  const home = Deno.env.get("HOME") || "";
  const defaultClaudeDest = home ? join(home, ".claude", "skills") : "";
  const defaultAgyDest = home
    ? join(home, ".gemini", "config", "plugins", "webjam-tasks", "skills")
    : "";

  const claudeDest = options.claudeDest || defaultClaudeDest;
  const agyDest = options.agyDest || defaultAgyDest;

  if (!claudeDest || !agyDest) {
    throw new Error("Cannot determine destination directories (HOME is unset)");
  }

  const repoDir = await resolveAndValidateRepoDir(options, deps);
  const skillsSrc = join(repoDir, "skills");

  let skillsSrcStat: Deno.FileInfo | null = null;
  try {
    skillsSrcStat = await Deno.stat(skillsSrc);
  } catch {
    skillsSrcStat = null;
  }

  if (!skillsSrcStat || !skillsSrcStat.isDirectory) {
    throw new Error(`Skills source directory not found: ${skillsSrc}`);
  }

  const stamp = getTimestamp();
  const messages: string[] = [];

  // 1. Prune dangling symlinks
  const claudePruneMsgs = await pruneFromDest(claudeDest, "Claude");
  const agyPruneMsgs = await pruneFromDest(agyDest, "agy");
  messages.push(...claudePruneMsgs, ...agyPruneMsgs);

  // 2. Install skills
  const claudeInstallMsgs = await installToDest(skillsSrc, claudeDest, "Claude", stamp);
  const agyInstallMsgs = await installToDest(skillsSrc, agyDest, "agy", stamp);
  messages.push(...claudeInstallMsgs, ...agyInstallMsgs);

  let skillsCount = 0;
  for await (const entry of Deno.readDir(skillsSrc)) {
    if (entry.isDirectory) skillsCount++;
  }

  return { success: true, messages, skillsCount };
}
