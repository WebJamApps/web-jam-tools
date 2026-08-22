// cli.ts — CLI entrypoint for CircleCI project settings management (web-jam-tools#697)
import { getCircleCiToken } from "./api.ts";
import { applySettings, checkDrift } from "./sync.ts";
import { type EnvReader, type Logger, WEBJAMAPPS_CIRCLECI_PROJECTS } from "./types.ts";

export const HELP_TEXT = `CircleCI Project Settings Standard & Drift Checker

Usage:
  deno task circleci-settings [options]
  deno run --allow-net --allow-env scripts/circleci-settings.ts [options]

Options:
  --check       Check for configuration drift across all 8 WebJamApps projects (read-only)
  --help, -h    Show this help message

Standard:
  Enforces advanced.autocancel_builds: true across all 8 WebJamApps CircleCI projects:
  ${WEBJAMAPPS_CIRCLECI_PROJECTS.join(", ")}

Environment:
  CIRCLECI_TOKEN    Required CircleCI API personal access token
`;

export async function main(
  args: string[] = Deno.args,
  fetchFn: typeof fetch = fetch,
  env: EnvReader = Deno.env,
  logger: Logger = console,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    logger.log(HELP_TEXT);
    return 0;
  }

  let token: string;
  try {
    token = getCircleCiToken(env);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const isCheckMode = args.includes("--check");

  if (isCheckMode) {
    try {
      const statuses = await checkDrift(WEBJAMAPPS_CIRCLECI_PROJECTS, token, fetchFn);
      let driftCount = 0;

      for (const status of statuses) {
        if (status.autocancel_builds) {
          logger.log(`[${status.project}] autocancel_builds: true (in sync)`);
        } else {
          logger.log(`[${status.project}] autocancel_builds: false (DRIFT)`);
          driftCount++;
        }
      }

      if (driftCount > 0) {
        logger.error(
          `\nDrift detected: ${driftCount} of ${statuses.length} projects have autocancel_builds disabled. Run 'deno task circleci-settings' to sync.`,
        );
        return 1;
      }

      logger.log(
        `\nAll ${statuses.length} projects have autocancel_builds enabled (in sync).`,
      );
      return 0;
    } catch (err) {
      logger.error(
        `Error checking CircleCI settings: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

  // Apply mode (default)
  try {
    const results = await applySettings(WEBJAMAPPS_CIRCLECI_PROJECTS, token, fetchFn);

    for (const res of results) {
      if (res.updated) {
        logger.log(`[${res.project}] enabled autocancel_builds`);
      } else {
        logger.log(`[${res.project}] autocancel_builds is already true (in sync)`);
      }
    }

    const updatedCount = results.filter((r) => r.updated).length;
    if (updatedCount > 0) {
      logger.log(
        `\nSuccessfully enabled autocancel_builds on ${updatedCount} project(s). All ${results.length} projects are now in sync.`,
      );
    } else {
      logger.log(
        `\nAll ${results.length} projects are already in sync with autocancel_builds enabled.`,
      );
    }
    return 0;
  } catch (err) {
    logger.error(
      `Error applying CircleCI settings: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(await main());
}
