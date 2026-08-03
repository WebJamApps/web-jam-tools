import { DEFAULT_TARGETS, runAllChecks, sendAlertEmail } from "./monitor.ts";

export async function main(): Promise<void> {
  const results = await runAllChecks(DEFAULT_TARGETS);
  const failed = results.filter((r) => !r.success);

  if (failed.length > 0) {
    console.error(`Uptime check failed: ${failed.length} check(s) failed.`);
    for (const failure of failed) {
      console.error(
        ` - ${failure.config.name} (${failure.config.url}): ${failure.error}`,
      );
    }

    try {
      await sendAlertEmail(failed);
      console.error("Alert email sent successfully.");
    } catch (err) {
      console.error(
        "Failed to send alert email:",
        err instanceof Error ? err.message : String(err),
      );
    }

    Deno.exit(1);
  }

  // Silent on success
  Deno.exit(0);
}

if (import.meta.main) {
  await main();
}
