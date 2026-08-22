// types.ts — CircleCI project settings standard and types for WebJamApps
// (web-jam-tools#697)

/** The 8 active WebJamApps CircleCI projects (excluding web-jam-llms). */
export const WEBJAMAPPS_CIRCLECI_PROJECTS = [
  "web-jam-tools",
  "JaMmusic",
  "CollegeLutheran",
  "AppersonAuto",
  "TimShermanMusic",
  "HenricksonForSalem",
  "WebJamSocketCluster",
  "web-jam-back",
] as const;

export type WebJamProject = typeof WEBJAMAPPS_CIRCLECI_PROJECTS[number];

export interface CircleCiProjectSettings {
  autocancel_builds: boolean;
  [key: string]: unknown;
}

export interface ProjectSettingStatus {
  project: string;
  autocancel_builds: boolean;
}

export interface SyncResult {
  project: string;
  updated: boolean;
  autocancel_builds: boolean;
}

export interface Logger {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface EnvReader {
  get(key: string): string | undefined;
}
