/**
 * Master task-list core logic for the claude-opus-tasks queue.
 *
 * These files are Josh's hand-edited source of truth. Two hard invariants on
 * every write (Josh, 2026-05-29):
 *   1. No task is ever lost.
 *   2. No two tasks share a number — duplicates get bumped to the next free one.
 *
 * Loss historically happened because a header typo ("talk 5") wasn't recognized
 * as a task, so the line got folded into the previous task's block and deleted
 * on the next /next. So header recognition is typo-tolerant: any leading word
 * that starts with "ta" and is within Levenshtein distance 1 of "task" counts.
 */

const TASK_WORD = "task";
// Capture: (leading ws)(word)(gap)(number)(rest-of-line)
const HEADER_RE = /^(\s*)([A-Za-z]{2,6})(\s+)(\d+)(.*)$/;

export interface Task {
  /** Task number as parsed/assigned. */
  num: number;
  /** All raw lines of the block, including the header line at index 0 and any
   *  trailing blank lines that preceded the next header. Preserved verbatim
   *  except for the header's keyword + number when renumbered. */
  lines: string[];
}

export interface ParsedQueue {
  /** Lines before the first task header (instructions, blank lines). */
  preamble: string[];
  tasks: Task[];
  /** Whether the original file ended with a trailing newline. */
  trailingNewline: boolean;
}

/** True if `a` is within Levenshtein distance 1 of `b` (case-insensitive). */
export function editDistanceLe1(a: string, b: string): boolean {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let diffs = 0;
    for (let i = 0; i < la; i++) if (a[i] !== b[i]) diffs++;
    return diffs === 1;
  }
  // one insertion/deletion: align the shorter against the longer
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++;
      j++;
    } else if (skipped) {
      return false;
    } else {
      skipped = true;
      j++;
    }
  }
  return true;
}

interface HeaderMatch {
  lead: string;
  word: string;
  gap: string;
  num: number;
  rest: string;
}

/** Parse a single line as a task header (exact "task N" or a single-typo
 *  variant like "talk N"). Returns null if the line is not a header. */
export function matchHeader(line: string): HeaderMatch | null {
  const m = HEADER_RE.exec(line);
  if (!m) return null;
  const word = m[2];
  const lower = word.toLowerCase();
  const isHeader = lower === TASK_WORD ||
    (lower.startsWith("ta") && editDistanceLe1(word, TASK_WORD));
  if (!isHeader) return null;
  return { lead: m[1], word, gap: m[3], num: Number(m[4]), rest: m[5] };
}

export function isTaskHeader(line: string): boolean {
  return matchHeader(line) !== null;
}

/** Split file text into preamble + task blocks. Verbatim line preservation. */
export function parseQueue(text: string): ParsedQueue {
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  // split() on a trailing newline leaves a final "" element; drop it so we
  // don't fabricate a blank line, then re-add the newline on serialize.
  if (trailingNewline) lines.pop();

  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (isTaskHeader(line)) starts.push(i);
  });

  const preamble = starts.length ? lines.slice(0, starts[0]) : lines.slice();
  const tasks: Task[] = starts.map((start, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
    const block = lines.slice(start, end);
    return { num: matchHeader(block[0])!.num, lines: block };
  });
  return { preamble, tasks, trailingNewline };
}

/** Rewrite a task's header line to a new number, normalizing a typo'd keyword
 *  ("talk"/"taslk") to canonical "Task" while leaving a correctly-spelled
 *  keyword's casing untouched. */
function setHeaderNumber(task: Task, newNum: number): void {
  const h = matchHeader(task.lines[0]);
  if (!h) return; // unreachable for a parsed task
  const word = h.word.toLowerCase() === TASK_WORD ? h.word : "Task";
  task.lines[0] = `${h.lead}${word}${h.gap}${newNum}${h.rest}`;
  task.num = newNum;
}

/** Renumber all tasks to step-multiples (start, start+step, …) in file order. */
export function renumber(q: ParsedQueue, step = 5, start = 0): ParsedQueue {
  q.tasks.forEach((t, i) => setHeaderNumber(t, start + i * step));
  return q;
}

/** Ensure unique numbers without re-sequencing: any task whose number was
 *  already taken by an earlier task is bumped to the next free integer above
 *  its current number (two 5s → second becomes 6, or the next free slot). */
export function dedupe(q: ParsedQueue): ParsedQueue {
  const present = new Set<number>(q.tasks.map((t) => t.num));
  const seen = new Set<number>();
  for (const t of q.tasks) {
    if (!seen.has(t.num)) {
      seen.add(t.num);
      continue;
    }
    let cand = t.num + 1;
    while (seen.has(cand) || present.has(cand)) cand++;
    present.add(cand);
    seen.add(cand);
    setHeaderNumber(t, cand);
  }
  return q;
}

/** Append a new task block at the bottom with the next number (max + step). */
export function append(q: ParsedQueue, body: string, step = 5, start = 0): ParsedQueue {
  const max = q.tasks.length ? Math.max(...q.tasks.map((t) => t.num)) : null;
  const num = max === null ? start : max + step;
  const bodyLines = body.replace(/\s+$/, "").split("\n");
  // First body line becomes the header; if the caller already wrote a "Task:"
  // or "task <n>:" prefix, strip it so we control the number cleanly.
  const first = bodyLines[0].replace(/^\s*tas?k?\s*\d*\s*[:.-]?\s*/i, "").trimStart();
  bodyLines[0] = `Task ${num}: ${first}`;
  q.tasks.push({ num, lines: bodyLines });
  return q;
}

export function serialize(q: ParsedQueue): string {
  const out: string[] = [...q.preamble];
  for (const t of q.tasks) out.push(...t.lines);
  return out.join("\n") + (q.trailingNewline ? "\n" : "");
}

export interface Invariants {
  ok: boolean;
  taskCount: number;
  duplicates: number[];
  errors: string[];
}

/** Check the two hard invariants against a freshly-parsed queue. */
export function checkInvariants(q: ParsedQueue, expectedCount?: number): Invariants {
  const errors: string[] = [];
  const nums = q.tasks.map((t) => t.num);
  const seen = new Set<number>();
  const duplicates: number[] = [];
  for (const n of nums) {
    if (seen.has(n)) duplicates.push(n);
    seen.add(n);
  }
  if (duplicates.length) {
    errors.push(`duplicate task numbers: ${[...new Set(duplicates)].join(", ")}`);
  }
  if (expectedCount !== undefined && q.tasks.length !== expectedCount) {
    errors.push(`task count changed: expected ${expectedCount}, got ${q.tasks.length} (TASK LOSS)`);
  }
  return { ok: errors.length === 0, taskCount: q.tasks.length, duplicates, errors };
}
