/**
 * install-skills library (web-jam-tools#668, web-jam-tools#669)
 *
 * Safe skill installer, legacy backup migrator, backup retention pruner, and stale
 * symlink pruner for Claude Code and agy.
 *
 * Retention Policy:
 * Backups are saved outside scanned skill directories (e.g. ~/.claude/skills-backups
 * and ~/.gemini/config/plugins/webjam-tasks/skills-backups) with a retention window of 14 days
 * (1,209,600,000 ms = 14 * 24 * 60 * 60 * 1000 ms). Backups older than 14 days are automatically pruned.
 */

import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";

export const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export interface InstallSkillsOptions {
  repoDir?: string;
  claudeDest?: string;
  agyDest?: string;
  claudeBackupDest?: string;
  agyBackupDest?: string;
  retentionMs?: number;
  now?: Date;
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
    } else if (arg === "--claude-backup-dest" && i + 1 < args.length) {
      options.claudeBackupDest = args[++i];
    } else if (arg.startsWith("--claude-backup-dest=")) {
      options.claudeBackupDest = arg.slice("--claude-backup-dest=".length);
    } else if (arg === "--agy-backup-dest" && i + 1 < args.length) {
      options.agyBackupDest = args[++i];
    } else if (arg.startsWith("--agy-backup-dest=")) {
      options.agyBackupDest = arg.slice("--agy-backup-dest=".length);
    } else if (arg === "--retention-days" && i + 1 < args.length) {
      const days = Number(args[++i]);
      if (!isNaN(days)) options.retentionMs = days * 24 * 60 * 60 * 1000;
    } else if (arg.startsWith("--retention-days=")) {
      const days = Number(arg.slice("--retention-days=".length));
      if (!isNaN(days)) options.retentionMs = days * 24 * 60 * 60 * 1000;
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
  --repo-dir <path>           Explicit repository root path
  --claude-dest <path>        Destination directory for Claude skills (~/.claude/skills)
  --agy-dest <path>           Destination directory for agy skills (~/.gemini/config/plugins/webjam-tasks/skills)
  --claude-backup-dest <path> Directory for Claude skill backups (~/.claude/skills-backups)
  --agy-backup-dest <path>    Directory for agy skill backups (~/.gemini/config/plugins/webjam-tasks/skills-backups)
  --retention-days <num>      Backup retention window in days (default: 14)
  --force                     Bypass worktree refusal guard
  --dry-run                   Report actions without making filesystem changes
  --quiet, -q                 Suppress non-error output
  --help, -h                  Show this help message`);
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

export function parseBackupTimestamp(name: string): Date | null {
  const match = name.match(/\.bak-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (match) {
    const [_, y, m, d, hh, min, ss] = match;
    return new Date(
      Number(y),
      Number(m) - 1,
      Number(d),
      Number(hh),
      Number(min),
      Number(ss),
    );
  }
  return null;
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

/**
 * Migrates pre-existing *.bak-* entries sitting inside the skills directories
 * out into the designated backup directory.
 */
export async function migrateLegacyBackups(
  targetDest: string,
  backupDest: string,
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
    if (!name.includes(".bak-") && !name.endsWith(".bak")) {
      continue;
    }

    const legacyPath = join(targetDest, name);
    const newPath = join(backupDest, name);

    await Deno.mkdir(backupDest, { recursive: true });

    // If destination already exists, remove it first before moving
    try {
      await Deno.remove(newPath, { recursive: true });
    } catch {
      // ignore
    }

    await Deno.rename(legacyPath, newPath);
    messages.push(`${label}: migrated legacy backup ${name} to ${backupDest}`);
  }

  return messages;
}

/**
 * Prunes backups in backupDest older than the retention window (default: 14 days).
 */
export async function pruneOldBackups(
  backupDest: string,
  label: string,
  retentionMs: number = DEFAULT_RETENTION_MS,
  now: Date = new Date(),
): Promise<string[]> {
  const messages: string[] = [];
  let backupStat: Deno.FileInfo | null = null;
  try {
    backupStat = await Deno.stat(backupDest);
  } catch {
    return messages;
  }
  if (!backupStat.isDirectory) return messages;

  const entries: string[] = [];
  for await (const entry of Deno.readDir(backupDest)) {
    entries.push(entry.name);
  }
  entries.sort();

  const cutoffTime = now.getTime() - retentionMs;

  for (const name of entries) {
    if (!name.includes(".bak-") && !name.endsWith(".bak")) {
      continue;
    }

    const itemPath = join(backupDest, name);
    let itemDate = parseBackupTimestamp(name);
    if (!itemDate) {
      try {
        const stat = await Deno.stat(itemPath);
        if (stat.mtime) itemDate = stat.mtime;
      } catch {
        continue;
      }
    }

    if (itemDate && itemDate.getTime() < cutoffTime) {
      try {
        await Deno.remove(itemPath, { recursive: true });
        messages.push(`${label}: pruned expired backup ${name}`);
      } catch {
        // ignore removal error
      }
    }
  }

  return messages;
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
  backupDest: string,
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

      await Deno.mkdir(backupDest, { recursive: true });
      const backupPath = join(backupDest, `${name}.bak-${stamp}`);
      await Deno.rename(dest, backupPath);
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

      await Deno.mkdir(backupDest, { recursive: true });
      const backupPath = join(backupDest, `${name}.bak-${stamp}`);
      await Deno.rename(dest, backupPath);
      await Deno.symlink(src, dest, { type: "dir" });
      messages.push(
        `${label}: ${name}: linked (previous version backed up to ${name}.bak-${stamp})`,
      );
    } else if (destLstat !== null) {
      await Deno.mkdir(backupDest, { recursive: true });
      const backupPath = join(backupDest, `${name}.bak-${stamp}`);
      await Deno.rename(dest, backupPath);
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
  const defaultClaudeDest = Deno.env.get("CLAUDE_SKILLS_DEST") ||
    (home ? join(home, ".claude", "skills") : "");
  const defaultAgyDest = Deno.env.get("AGY_SKILLS_DEST") ||
    (home ? join(home, ".gemini", "config", "plugins", "webjam-tasks", "skills") : "");

  const claudeDest = options.claudeDest || defaultClaudeDest;
  const agyDest = options.agyDest || defaultAgyDest;

  if (!claudeDest || !agyDest) {
    throw new Error("Cannot determine destination directories (HOME is unset)");
  }

  const defaultClaudeBackupDest = Deno.env.get("CLAUDE_SKILLS_BACKUP_DEST") ||
    (home ? join(home, ".claude", "skills-backups") : join(dirname(claudeDest), "skills-backups"));
  const defaultAgyBackupDest = Deno.env.get("AGY_SKILLS_BACKUP_DEST") ||
    (home
      ? join(home, ".gemini", "config", "plugins", "webjam-tasks", "skills-backups")
      : join(dirname(agyDest), "skills-backups"));

  const claudeBackupDest = options.claudeBackupDest || defaultClaudeBackupDest;
  const agyBackupDest = options.agyBackupDest || defaultAgyBackupDest;

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

  const stamp = getTimestamp(options.now);
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const now = options.now ?? new Date();
  const messages: string[] = [];

  // 1. Migrate legacy backups out of skills directories
  const claudeMigrationMsgs = await migrateLegacyBackups(claudeDest, claudeBackupDest, "Claude");
  const agyMigrationMsgs = await migrateLegacyBackups(agyDest, agyBackupDest, "agy");
  messages.push(...claudeMigrationMsgs, ...agyMigrationMsgs);

  // 2. Prune old backups outside scanned directories
  const claudePruneBackupsMsgs = await pruneOldBackups(
    claudeBackupDest,
    "Claude",
    retentionMs,
    now,
  );
  const agyPruneBackupsMsgs = await pruneOldBackups(agyBackupDest, "agy", retentionMs, now);
  messages.push(...claudePruneBackupsMsgs, ...agyPruneBackupsMsgs);

  // 3. Prune dangling symlinks in skills directories
  const claudePruneMsgs = await pruneFromDest(claudeDest, "Claude");
  const agyPruneMsgs = await pruneFromDest(agyDest, "agy");
  messages.push(...claudePruneMsgs, ...agyPruneMsgs);

  // 4. Install skills
  const claudeInstallMsgs = await installToDest(
    skillsSrc,
    claudeDest,
    claudeBackupDest,
    "Claude",
    stamp,
  );
  const agyInstallMsgs = await installToDest(skillsSrc, agyDest, agyBackupDest, "agy", stamp);
  messages.push(...claudeInstallMsgs, ...agyInstallMsgs);

  let skillsCount = 0;
  for await (const entry of Deno.readDir(skillsSrc)) {
    if (entry.isDirectory) skillsCount++;
  }

  return { success: true, messages, skillsCount };
}
