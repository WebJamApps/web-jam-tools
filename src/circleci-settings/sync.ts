// sync.ts — Core logic for checking and applying CircleCI project settings
// (web-jam-tools#697)
import { fetchProjectSettings, updateProjectSettings } from "./api.ts";
import {
  type ProjectSettingStatus,
  type SyncResult,
  WEBJAMAPPS_CIRCLECI_PROJECTS,
} from "./types.ts";

/**
 * Check autocancel_builds status across all specified projects.
 */
export async function checkDrift(
  projects: readonly string[] = WEBJAMAPPS_CIRCLECI_PROJECTS,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<ProjectSettingStatus[]> {
  const results: ProjectSettingStatus[] = [];
  for (const project of projects) {
    const settings = await fetchProjectSettings(project, token, fetchFn);
    results.push({
      project,
      autocancel_builds: settings.autocancel_builds,
    });
  }
  return results;
}

/**
 * Ensure autocancel_builds is enabled across all specified projects.
 * Idempotent: Skips PATCH when setting is already true.
 */
export async function applySettings(
  projects: readonly string[] = WEBJAMAPPS_CIRCLECI_PROJECTS,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const project of projects) {
    const current = await fetchProjectSettings(project, token, fetchFn);
    if (current.autocancel_builds) {
      results.push({
        project,
        updated: false,
        autocancel_builds: true,
      });
    } else {
      await updateProjectSettings(
        project,
        { advanced: { autocancel_builds: true } },
        token,
        fetchFn,
      );
      results.push({
        project,
        updated: true,
        autocancel_builds: true,
      });
    }
  }
  return results;
}
