import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { updateConfig } from "./config.ts";
import { readHookRegistrations } from "./hooks.ts";

export interface InstallOptions {
  home: string;
  repo?: string;
  check?: boolean;
}

function stat(path: string): Deno.FileInfo | undefined {
  try {
    return Deno.lstatSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

function textOrEmpty(path: string): string {
  try {
    return Deno.readTextFileSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "";
    throw new Error(`cannot read ${path}: ${error}`);
  }
}

function directory(path: string): void {
  const info = stat(path);
  if (info && !info.isDirectory) throw new Error(`refusing non-directory ${path}`);
}

function writeFile(path: string, contents: string): void {
  Deno.mkdirSync(dirname(path), { recursive: true });
  const temporary = Deno.makeTempFileSync({ dir: dirname(path), prefix: ".install-codex-" });
  try {
    Deno.writeTextFileSync(temporary, contents);
    Deno.renameSync(temporary, path);
  } finally {
    if (stat(temporary)) Deno.removeSync(temporary);
  }
}

export function installCodex(options: InstallOptions): number {
  const home = resolve(options.home);
  // A worktree's .git is a file pointing into the canonical clone. Skill links
  // must survive disposal of the worktree, so default to that clone's skills.
  const sourceRepo = resolve(options.repo ?? fromFileUrl(new URL("../../", import.meta.url)));
  try {
    const registrations = readHookRegistrations(
      Deno.readTextFileSync(join(sourceRepo, "scripts/install-hooks.sh")),
      home,
    );
    const missingHooks: string[] = [];
    for (const entries of Object.values(registrations)) {
      for (const entry of entries) {
        const command = entry.hooks[0].command;
        // Script names were validated by readHookRegistrations.
        const name = command.slice(command.lastIndexOf("/") + 1, -1);
        const path = join(home, ".claude/hooks", name);
        try {
          if (!Deno.statSync(path).isFile) throw new Error("not a file");
        } catch {
          missingHooks.push(`missing hook ${path}; run scripts/install-hooks.sh first`);
        }
      }
    }
    const rulesSource = join(sourceRepo, "codex/rules/web-jam-tools.rules");
    let rules: string;
    try {
      rules = Deno.readTextFileSync(rulesSource);
    } catch {
      throw new Error(`missing or unreadable rules file ${rulesSource}`);
    }
    const codex = join(home, ".codex");
    const configPath = join(codex, "config.toml");
    const rulesPath = join(codex, "rules/web-jam-tools.rules");
    for (const path of [codex, dirname(rulesPath), join(codex, "skills")]) directory(path);
    if (stat(configPath) && !stat(configPath)?.isFile) {
      throw new Error(`refusing non-regular config ${configPath}`);
    }
    if (stat(rulesPath)?.isDirectory) throw new Error(`refusing directory ${rulesPath}`);
    let config: ReturnType<typeof updateConfig>;
    try {
      config = updateConfig(textOrEmpty(configPath), registrations, home);
    } catch (error) {
      throw new Error(`refusing ${configPath}: ${error}`);
    }
    let canonical = sourceRepo;
    const gitFile = stat(join(sourceRepo, ".git"));
    if (gitFile?.isFile) {
      const gitdir = Deno.readTextFileSync(join(sourceRepo, ".git")).trim();
      if (!gitdir.startsWith("gitdir: ")) {
        throw new Error(`cannot resolve clone from ${sourceRepo}/.git`);
      }
      const metadata = resolve(sourceRepo, gitdir.slice(8));
      const common = Deno.readTextFileSync(join(metadata, "commondir")).trim();
      canonical = dirname(resolve(metadata, common));
    }
    const skills = [...Deno.readDirSync(join(sourceRepo, "skills"))]
      .filter((entry) =>
        entry.isDirectory && entry.name !== "handle-gmails" && entry.name !== ".system"
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => {
        const target = join(codex, "skills", entry.name);
        const source = join(canonical, "skills", entry.name);
        const info = stat(target);
        let matches = false;
        if (info?.isSymlink) {
          matches = resolve(dirname(target), Deno.readLinkSync(target)) === source;
        }
        return { target, source, matches, conflict: !!info && !matches };
      });
    const rulesMatch = stat(rulesPath)?.isFile && textOrEmpty(rulesPath) === rules;
    const drift = [...config.drift];
    if (!rulesMatch) drift.push(`rules file ${rulesPath}`);
    for (const skill of skills) {
      if (!skill.matches) {
        drift.push(`skill ${skill.target}${skill.conflict ? " (skipped: existing path)" : ""}`);
      }
    }
    if (options.check) {
      missingHooks.forEach((message) => console.error(`REFUSED: ${message}`));
      drift.forEach((item) => console.error(`DRIFT: ${item}`));
      if (!drift.length && !missingHooks.length) {
        console.log("Codex installation is current (no changes)");
      }
      return drift.length || missingHooks.length ? 1 : 0;
    }
    // All safety-set validation and reads precede the first filesystem write.
    if (missingHooks.length) throw new Error(missingHooks.join("\n"));
    if (config.drift.length) writeFile(configPath, config.text);
    if (!rulesMatch) writeFile(rulesPath, rules);
    let skipped = false;
    for (const skill of skills) {
      if (skill.matches) continue;
      if (skill.conflict) {
        console.error(`SKIPPED: ${skill.target}: existing path is not the canonical skill link`);
        skipped = true;
        continue;
      }
      try {
        Deno.mkdirSync(dirname(skill.target), { recursive: true });
        Deno.symlinkSync(skill.source, skill.target);
      } catch (error) {
        console.error(`SKIPPED: ${skill.target}: ${error}`);
        skipped = true;
      }
    }
    console.log(
      drift.length ? "Codex installation updated" : "Codex installation is current (no changes)",
    );
    return skipped ? 1 : 0;
  } catch (error) {
    console.error(`REFUSED: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}
