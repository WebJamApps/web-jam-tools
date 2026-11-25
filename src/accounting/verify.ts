// src/accounting/verify.ts
// Check the Beancount books with `rledger check` (web-jam-tools#1865), and run rustledger for the
// import and month close (web-jam-tools#1866).

import * as path from "@std/path";
import { assertBeancountTarget } from "./entry.ts";
import { BooksCheckResult } from "./types.ts";

export interface CheckBooksOptions {
  /** The rustledger program to run; `rledger` on PATH unless a test names another. */
  rledger?: string;
}

/** What one rustledger run printed and how it exited. */
export interface RledgerRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** The run could not happen at all: `rledger` is missing or cannot be started. */
export class RledgerUnavailable extends Error {}

/** Runs `rledger <args>` with colour off and no input, and returns what it printed. */
export async function runRledger(program: string, args: string[]): Promise<RledgerRun> {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(program, {
      args,
      env: { NO_COLOR: "1" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (err) {
    throw new RledgerUnavailable(
      err instanceof Deno.errors.NotFound
        ? `${program} is not installed or not on PATH`
        : `${program} could not be run: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

/**
 * Runs `rledger check` on the year's Beancount books: `pass` when it exits 0, `fail` with its
 * diagnostic when it exits 1, and `refuse` when the books cannot be read, `rledger` cannot be run,
 * or it exits any other way. `--no-cache` keeps it from writing a cache file beside the books.
 */
export async function checkBooks(
  booksPath: string,
  options: CheckBooksOptions = {},
): Promise<BooksCheckResult> {
  assertBeancountTarget(booksPath, "accounting:verify");
  try {
    const info = await Deno.stat(booksPath);
    if (!info.isFile) {
      return { outcome: "refuse", message: `${booksPath} is not a file, so it cannot be checked.` };
    }
    await Deno.readTextFile(booksPath);
  } catch (err) {
    return {
      outcome: "refuse",
      message: `Cannot read the books at ${booksPath}, so they cannot be checked: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const program = options.rledger ?? "rledger";
  let run: RledgerRun;
  try {
    run = await runRledger(program, ["check", "--no-cache", booksPath]);
  } catch (err) {
    if (!(err instanceof RledgerUnavailable)) throw err;
    return { outcome: "refuse", message: `${err.message}, so the books cannot be checked.` };
  }

  const text = [run.stdout, run.stderr].map((s) => s.trim()).filter(Boolean).join("\n");
  if (run.code === 0) return { outcome: "pass", message: text };
  if (run.code === 1) return { outcome: "fail", message: text };
  return {
    outcome: "refuse",
    message: `${program} check exited ${run.code}, so the books could not be checked${
      text ? `:\n${text}` : "."
    }`,
  };
}

/**
 * Writes `content` beside the books as owner-only candidate books, runs `rledger check` on it, and
 * hands its path to `use` only when the check passes. A failing check, or a check that cannot run,
 * throws with the reason and the diagnostic, and the candidate is always removed afterwards, so the
 * caller publishes nothing it has not checked. The candidate sits beside the books so their
 * `include` lines resolve the same way.
 */
export async function withCheckedCandidate<T>(
  target: string,
  content: string,
  rledger: string,
  use: (candidatePath: string) => Promise<T>,
): Promise<T> {
  const candidate = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${crypto.randomUUID()}.candidate.beancount`,
  );
  try {
    await Deno.writeTextFile(candidate, content, { createNew: true, mode: 0o600 });
    const result = await checkBooks(candidate, { rledger });
    if (result.outcome === "fail") {
      throw new Error(
        `rledger check found errors in the books this would write, so nothing was written:\n${result.message}`,
      );
    }
    if (result.outcome === "refuse") {
      throw new Error(`${result.message} Nothing was written.`);
    }
    return await use(candidate);
  } finally {
    await Deno.remove(candidate).catch(() => {});
  }
}
