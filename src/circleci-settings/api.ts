// api.ts — CircleCI v2 API client for project settings (web-jam-tools#697)
import type { CircleCiProjectSettings, EnvReader } from "./types.ts";

export const CIRCLECI_API_BASE = "https://circleci.com/api/v2/project/gh/WebJamApps";

/**
 * Retrieve CIRCLECI_TOKEN from the environment.
 * Throws a clean error if unset or blank, never logging the token.
 */
export function getCircleCiToken(env: EnvReader = Deno.env): string {
  const token = env.get("CIRCLECI_TOKEN")?.trim();
  if (!token) {
    throw new Error("Missing CIRCLECI_TOKEN — export it before running this tool.");
  }
  return token;
}

/**
 * Fetch project settings from CircleCI API v2.
 */
export async function fetchProjectSettings(
  project: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<CircleCiProjectSettings> {
  const url = `${CIRCLECI_API_BASE}/${project}/settings`;
  const resp = await fetchFn(url, {
    method: "GET",
    headers: {
      "Circle-Token": token,
      "Accept": "application/json",
    },
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => "");
    throw new Error(
      `GET ${project}/settings failed with HTTP ${resp.status}${errorText ? `: ${errorText}` : ""}`,
    );
  }

  const data = await resp.json();
  return {
    autocancel_builds: Boolean(data?.advanced?.autocancel_builds),
    ...data,
  };
}

/**
 * Update project settings via CircleCI API v2 PATCH.
 */
export async function updateProjectSettings(
  project: string,
  settings: { advanced: { autocancel_builds: boolean } },
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<CircleCiProjectSettings> {
  const url = `${CIRCLECI_API_BASE}/${project}/settings`;
  const resp = await fetchFn(url, {
    method: "PATCH",
    headers: {
      "Circle-Token": token,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(settings),
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => "");
    throw new Error(
      `PATCH ${project}/settings failed with HTTP ${resp.status}${
        errorText ? `: ${errorText}` : ""
      }`,
    );
  }

  const data = await resp.json();
  return {
    autocancel_builds: Boolean(data?.advanced?.autocancel_builds),
    ...data,
  };
}
