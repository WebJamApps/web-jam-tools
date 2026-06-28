#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Master task-list CLI for the claude-opus-tasks queue. (Deno.)
 *
 * Every command reads the file FRESH from disk (never a cached snapshot —
 * Josh, 2026-05-29: the list is master). Every mutating command re-parses its
 * own output and aborts WITHOUT writing if the invariants fail (task lost, or
 * duplicate numbers). Writes are atomic (tmp + fsync + rename).
 *
 * Usage:
 *   deno task queue list      --path FILE
 *   deno task queue next      --path FILE
 *   deno task queue complete  --path FILE
 *   deno task queue renumber  --path FILE [--step 5] [--start 0] [--dry-run]
 *   deno task queue dedupe    --path FILE [--dry-run]
 *   deno task queue append    --path FILE --body "text" | --body-file FILE [--step 5] [--dry-run]
 *   deno task queue validate  --path FILE
 *
 * Output: JSON on stdout. On invariant failure or bad input: JSON on stderr, exit 1.
 */
import { parseArgs } from "@std/cli/parse-args";
import {
  append,
  checkInvariants,
  dedupe,
  editDistanceLe1,
  matchHeader,
  type ParsedQueue,
  parseQueue,
  renumber,
  serialize,
} from "./queue.ts";

function fail(message: string, extra: Record<string, unknown> = {}): never {
  console.error(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  Deno.exit(1);
}

function emit(obj: Record<string, unknown>): void {
  console.log(JSON.stringify({ ok: true, ...obj }, null, 2));
}

function readFresh(path: string): string {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return fail(`cannot read file: ${path}`);
  }
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  const f = Deno.openSync(tmp, { write: true, create: true, truncate: true });
  try {
    f.writeSync(new TextEncoder().encode(content));
    f.syncSync(); // fsync: durable before the rename
  } finally {
    f.close();
  }
  Deno.renameSync(tmp, path); // atomic on the same filesystem
}

/**
 * Run a mutating transform with the hard guard: re-parse the produced text and
 * confirm count == before + expectedDelta and no duplicate numbers. For ops
 * that don't add/remove tasks, also confirm the set of task bodies is
 * unchanged. Abort (no write) if the guard trips.
 */
function mutate(
  path: string,
  transform: (q: ParsedQueue) => ParsedQueue,
  expectedDelta: number,
  dryRun: boolean,
  label: string,
): void {
  const q = parseQueue(readFresh(path));
  const beforeNums = q.tasks.map((t) => t.num);
  const beforeBodies = q.tasks.map((t) => t.lines.slice(1).join("\n")).sort();

  const out = serialize(transform(q));
  const reparsed = parseQueue(out);
  const inv = checkInvariants(reparsed, beforeNums.length + expectedDelta);

  if (expectedDelta === 0) {
    const afterBodies = reparsed.tasks.map((t) => t.lines.slice(1).join("\n")).sort();
    if (JSON.stringify(afterBodies) !== JSON.stringify(beforeBodies)) {
      inv.ok = false;
      inv.errors.push("task body content changed (possible scramble)");
    }
  }

  if (!inv.ok) {
    fail(`${label} aborted — invariant violation, file left untouched`, {
      before: beforeNums,
      errors: inv.errors,
    });
  }

  if (!dryRun) atomicWrite(path, out);
  emit({
    op: label,
    path,
    before: beforeNums,
    after: reparsed.tasks.map((t) => t.num),
    written: !dryRun,
  });
}

function main(): void {
  const args = parseArgs(Deno.args, {
    boolean: ["dry-run"],
    string: ["path", "step", "start", "body", "body-file"],
    default: { step: "5", start: "0" },
  });

  const cmd = String(args._[0] ?? "");
  const path = args.path;
  const step = Number(args.step);
  const start = Number(args.start);
  const dryRun = args["dry-run"];

  if (!cmd) fail("missing command (list|next|complete|renumber|dedupe|append|validate)");
  if (!path) fail("--path is required");

  switch (cmd) {
    case "list": {
      const q = parseQueue(readFresh(path));
      emit({
        count: q.tasks.length,
        tasks: q.tasks.map((t) => ({ num: t.num, headline: t.lines[0] })),
      });
      break;
    }
    case "next": {
      const q = parseQueue(readFresh(path));
      if (q.tasks.length === 0) {
        emit({ task: null, remaining: 0 });
        break;
      }
      emit({
        task: q.tasks[0].lines.join("\n").trimEnd(),
        num: q.tasks[0].num,
        remaining: q.tasks.length,
      });
      break;
    }
    case "complete": {
      // Empty queue → clean no-op (so callers don't need a pre-check). A
      // non-empty queue removes the first task under the no-loss guard.
      if (parseQueue(readFresh(path)).tasks.length === 0) {
        emit({ op: "complete", path, before: [], after: [], written: false });
        break;
      }
      mutate(
        path,
        (q) => {
          q.tasks.shift();
          return q;
        },
        -1,
        dryRun,
        "complete",
      );
      break;
    }
    case "renumber":
      mutate(path, (q) => renumber(q, step, start), 0, dryRun, "renumber");
      break;
    case "dedupe":
      mutate(path, (q) => dedupe(q), 0, dryRun, "dedupe");
      break;
    case "append": {
      let body = args.body;
      if (args["body-file"]) body = Deno.readTextFileSync(args["body-file"]);
      if (!body || !body.trim()) fail("append requires --body or --body-file with content");
      mutate(path, (q) => append(q, body, step, start), 1, dryRun, "append");
      break;
    }
    case "validate": {
      const text = readFresh(path);
      const q = parseQueue(text);
      const inv = checkInvariants(q);
      // Surface lines that look like a header but weren't recognized (typos
      // beyond edit-distance 1) so Josh can fix them before they eat a task.
      const warnings: string[] = [];
      for (const line of text.split("\n")) {
        if (matchHeader(line)) continue;
        const m = /^\s*([A-Za-z]{2,6})\s+\d+/.exec(line);
        if (m) {
          const w = m[1].toLowerCase();
          if (
            w.startsWith("t") && w.length <= 5 &&
            !["the", "this", "to"].includes(w) &&
            !editDistanceLe1(w.slice(0, 4), "task")
          ) {
            warnings.push(`possible mistyped header not recognized: "${line.trim()}"`);
          }
        }
      }
      emit({
        valid: inv.ok && warnings.length === 0,
        count: inv.taskCount,
        duplicates: inv.duplicates,
        errors: inv.errors,
        warnings,
      });
      break;
    }
    default:
      fail(`unknown command: ${cmd}`);
  }
}

main();
