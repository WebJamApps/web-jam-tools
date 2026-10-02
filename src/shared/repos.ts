// src/shared/repos.ts
// Shared definitions of the active WebJamApps repos and the `gh` command-runner types used by the
// design-issue and memory-cleanup tooling. (Moved here from the retired scanner's types module.)

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (args: string[]) => Promise<CommandResult>;

export const ACTIVE_REPOS = [
  "web-jam-tools",
  "JaMmusic",
  "CollegeLutheran",
  "AppersonAuto",
  "web-jam-back",
  "WebJamSocketCluster",
  "TimShermanMusic",
  "HenricksonForSalem",
] as const;

export const REPO_OWNER = "WebJamApps";
