import { parseArgs } from "@std/cli/parse-args";
import { dirname } from "@std/path";
import type { CommandRunner } from "../shared/repos.ts";
import { collectSnapshot, snapshotPath } from "./snapshot.ts";

async function prepareDirectory(directory: string): Promise<void> {
  // Inspect each existing component before creating children: recursive mkdir could write
  // through a pre-existing symlink before a final realPath check noticed it.
  const parts = directory.slice("/tmp/backlog-groom".length).split("/").filter(Boolean);
  let current = "/tmp/backlog-groom";
  for (let index = 0; index <= parts.length; index++) {
    try {
      const info = await Deno.lstat(current);
      if (!info.isDirectory || info.isSymlink) {
        throw new Error("Snapshot directory must not contain symlinks");
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      await Deno.mkdir(current);
    }
    if (index < parts.length) current += `/${parts[index]}`;
  }
}

export async function runCollectCli(
  args: string[],
  options: {
    runner?: CommandRunner;
    log?: (line: string) => void;
    errorLog?: (line: string) => void;
  } = {},
): Promise<number> {
  const log = options.log ?? console.log;
  const errorLog = options.errorLog ?? console.error;
  let temporary: string | undefined;
  try {
    const flags = parseArgs(args, {
      string: ["output", "concurrency"],
      boolean: ["help"],
      unknown: (arg) => {
        throw new Error(`Unknown argument: ${arg}`);
      },
    });
    if (flags.help) {
      log(
        "Usage: deno task backlog-groom:collect --output /tmp/backlog-groom/run/snapshot.json [--concurrency 12]\nRead-only GitHub collection; publishes only a complete validated snapshot. No approval is recorded.",
      );
      return 0;
    }
    if (!flags.output || flags._.length) throw new Error("Provide --output; see --help");
    const output = snapshotPath(flags.output);
    const concurrency = flags.concurrency === undefined ? 12 : Number(flags.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
      throw new Error("Concurrency must be an integer from 1 to 16");
    }
    await prepareDirectory(dirname(output));
    if (await Deno.realPath(dirname(output)) !== dirname(output)) {
      throw new Error("Snapshot directory must not contain symlinks");
    }
    // Exclusive creation prevents replacing an earlier run or following a destination symlink.
    try {
      await Deno.lstat(output);
      throw new Error("Output already exists; select a new run path");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const snapshot = await collectSnapshot(options.runner, concurrency);
    temporary = await Deno.makeTempFile({ dir: dirname(output), prefix: ".collect-" });
    await Deno.writeTextFile(temporary, JSON.stringify(snapshot, null, 2) + "\n");
    // Hard-link is atomic and refuses an existing destination, including symlinks.
    await Deno.link(temporary, output);
    log(
      `${output}: ${snapshot.repositories.length} repos, ${
        snapshot.repositories.reduce((n, repo) => n + repo.issues.length, 0)
      } issues, ${snapshot.requests} gh requests, ${snapshot.startedAt}–${snapshot.completedAt}`,
    );
    return 0;
  } catch (error) {
    errorLog(
      `backlog-groom:collect refused: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  } finally {
    if (temporary) await Deno.remove(temporary);
  }
}

if (import.meta.main) Deno.exit(await runCollectCli(Deno.args));
