// src/prune-local-permission-allows/cli.ts — web-jam-tools#341

import {
  checkSettingsBackup,
  generateTimestamp,
  getDefaultTargetFiles,
  processTargetFile,
} from "./prune.ts";

export function runCli(args: string[]): number {
  let apply = false;
  let check = false;
  const customTargetFiles: string[] = [];
  let customBackupDstDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--check") {
      check = true;
    } else if ((arg === "--target-file" || arg === "--file") && i + 1 < args.length) {
      customTargetFiles.push(args[++i]);
    } else if (arg === "--backup-dst-dir" && i + 1 < args.length) {
      customBackupDstDir = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: cli.ts [--apply] [--check] [--target-file <path>] [--backup-dst-dir <dir>]",
      );
      return 0;
    }
  }

  const targetFiles = customTargetFiles.length > 0 ? customTargetFiles : getDefaultTargetFiles();
  const stamp = generateTimestamp();

  if (check) {
    let totalOffenders = 0;
    const reports: Array<{ filePath: string; offenders: Array<{ rule: string; reason: string }> }> =
      [];

    for (const filePath of targetFiles) {
      let result;
      try {
        result = processTargetFile(filePath, false, stamp);
      } catch (err) {
        console.error(`ERROR processing ${filePath}: ${(err as Error).message}`);
        return 1;
      }

      if (!result.exists) {
        continue;
      }

      const wildcardOffenders = result.removedEntries.filter(
        (e) => e.reason === "NON-TRAILING-WILDCARD",
      );

      if (wildcardOffenders.length > 0) {
        totalOffenders += wildcardOffenders.length;
        reports.push({ filePath, offenders: wildcardOffenders });
      }
    }

    if (totalOffenders === 0) {
      return 0;
    }

    for (const report of reports) {
      console.log(`File: ${report.filePath}`);
      for (const entry of report.offenders) {
        console.log(`  - [${entry.reason}] ${entry.rule}`);
      }
    }
    return 1;
  }

  const backupInfo = checkSettingsBackup(customBackupDstDir);

  console.log("=== Claude Local Permissions Prune Tool ===");
  console.log(
    `Mode: ${
      apply
        ? "APPLY (modifying target files)"
        : "DRY RUN (no files modified, pass --apply to execute)"
    }`,
  );
  console.log("");
  console.log("Settings Backup Check (web-jam-tools#339):");
  console.log(`  Path: ${backupInfo.path}`);
  if (backupInfo.present) {
    console.log(`  Backup present: Yes (last modified: ${backupInfo.timestamp})`);
  } else {
    console.log(`  Backup present: No (not found at path)`);
  }
  console.log("");
  console.log("Target Files Audit:");
  console.log("");

  let totalRemoved = 0;
  let filesProcessed = 0;
  let filesSkipped = 0;

  for (const filePath of targetFiles) {
    let result;
    try {
      result = processTargetFile(filePath, apply, stamp);
    } catch (err) {
      console.error(`ERROR processing ${filePath}: ${(err as Error).message}`);
      return 1;
    }

    if (!result.exists) {
      filesSkipped++;
      console.log(`File: ${filePath}`);
      console.log(`  Status: Skipped (file does not exist)`);
      console.log("");
      continue;
    }

    filesProcessed++;
    totalRemoved += result.removedEntries.length;

    console.log(`File: ${filePath}`);
    if (apply && result.backedUpTo) {
      console.log(`  Status: Updated`);
      console.log(`  Backup created: ${result.backedUpTo}`);
    } else if (apply) {
      console.log(`  Status: Checked (no entries to prune)`);
    } else {
      console.log(`  Status: Examined (dry run)`);
    }
    console.log(
      `  Rules count: ${result.beforeCount} → ${result.afterCount} (${result.removedEntries.length} entries removed)`,
    );

    if (result.removedEntries.length > 0) {
      console.log(`  Removed entries:`);
      for (const entry of result.removedEntries) {
        console.log(`    - [${entry.reason}] ${entry.rule}`);
      }
    }
    console.log("");
  }

  console.log("Summary:");
  console.log(
    `  Files: ${filesProcessed} examined, ${filesSkipped} skipped`,
  );
  console.log(`  Total entries removed: ${totalRemoved}`);
  console.log(
    `  Result: ${
      apply
        ? "APPLY completed successfully."
        : "DRY RUN complete — no changes written. Run with --apply to write changes."
    }`,
  );

  return 0;
}

if (import.meta.main) {
  const code = runCli(Deno.args);
  Deno.exit(code);
}
