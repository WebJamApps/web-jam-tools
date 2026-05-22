"""Persistent task queue support — model-aware, local-FS backed.

Used by the REPL `/next` and `/done` commands. Reads/writes the right queue
file from the local Dropbox-mirrored folder so the model never has to (and
can't hallucinate) the contents of its own queue. Migrated 2026-05-21 from
the Drive REST API to local filesystem — see project-web-jam-llms-migration-plan
for rationale and the cross-store bridge that keeps Sonnet's Drive writes
flowing into these files.

As of 2026-05-20 (post-Coordinator-swap) there is ONE queue:
  - gemma-tasks.txt → Coordinator (gemma4:26b on the OMEN)

History: pre-2026-05-20 there were two queues — llama-tasks.txt for the
Llama 3.3 70B Coordinator and gemma-tasks.txt for the gemma4:e4b Media
Specialist. The Media Specialist role was retired and llama-tasks.txt was
renamed to gemma-tasks.txt. Pre-2026-05-21 these lived on Drive; now they
live at /home/joshua/Dropbox/web-jam-llms/ (symlinked into WebJamApps).

Lookup is by model tag. Unknown models default to gemma-tasks.txt for safety.
"""

from __future__ import annotations

import os
import re

# Local-FS queue store (migrated from Drive 2026-05-21). The Dropbox folder is
# symlinked into /home/joshua/WebJamApps/web-jam-llms for VSCode visibility;
# either path resolves to the same files via the Dropbox daemon's sync.
QUEUE_DIR = "/home/joshua/Dropbox/web-jam-llms"

TASKS_FILE_PATHS = {
    "gemma4:26b": f"{QUEUE_DIR}/gemma-tasks.txt",  # Coordinator (post-2026-05-20)
}
DEFAULT_FALLBACK_PATH = f"{QUEUE_DIR}/gemma-tasks.txt"
TASK_LINE_RE = re.compile(r"^task\s+\d+", re.IGNORECASE)


def _path_for_model(model: str) -> str:
    return TASKS_FILE_PATHS.get(model, DEFAULT_FALLBACK_PATH)


def _unmojibake(text: str, max_passes: int = 3) -> str:
    """Conservatively reverse UTF-8-as-Latin-1 mojibake (double or triple).

    Phone Sonnet's task uploads sometimes double- or triple-encode multi-byte
    UTF-8 chars (em-dashes, smart quotes), producing `Ã¢ÂÂ`-style mojibake in
    the file content. Each pass: encode as Latin-1, decode as UTF-8. Stop when
    the heuristic mojibake-marker count stops decreasing or when the round-trip
    fails — so clean text and legitimate single accented chars are never modified.

    Kept post-migration (2026-05-21) because the cross-store bridge still pulls
    phone-Sonnet-authored task entries from Drive into these files; mojibake
    introduced upstream still needs unwinding on the way out.
    """
    def score(s: str) -> int:
        # UTF-8 multi-byte chars decoded as Latin-1 always produce a RUN of
        # consecutive U+0080-U+00FF characters. Count adjacent-high-bit pairs:
        # clean text and a lone accented char (Café, Naïve) score 0; mojibake
        # of any length scores >= 1 and drops by at least 1 per unwind pass.
        count = 0
        prev_high = False
        for ch in s:
            is_high = 0x80 <= ord(ch) <= 0xFF
            if is_high and prev_high:
                count += 1
            prev_high = is_high
        return count

    for _ in range(max_passes):
        try:
            candidate = text.encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            break
        if score(candidate) >= score(text):
            break  # not making progress — stop before we damage clean text
        text = candidate
    return text


def _read_tasks_file(model: str) -> str:
    """Read the queue file for `model` and defensively unwind any mojibake."""
    path = _path_for_model(model)
    with open(path, encoding="utf-8") as f:
        return _unmojibake(f.read())


def _atomic_write(path: str, content: str) -> None:
    """Write `content` to `path` atomically: write to `<path>.tmp`, fsync, rename.

    `os.replace` is atomic on POSIX within the same filesystem, so a crash
    mid-write leaves either the original file intact or the new file fully
    written — never a partial state. fsync ensures the data is durable on
    disk before the rename, so a power loss between rename and final flush
    can't surface a zero-byte file. Pattern recommended in the migration plan
    (project-web-jam-llms-migration-plan) for any future write paths too.
    """
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _parse_tasks(text: str) -> list[tuple[int, str]]:
    lines = text.splitlines(keepends=False)
    starts = [i for i, line in enumerate(lines) if TASK_LINE_RE.match(line.strip())]
    out: list[tuple[int, str]] = []
    for idx, start in enumerate(starts):
        end = starts[idx + 1] if idx + 1 < len(starts) else len(lines)
        out.append((start, "\n".join(lines[start:end]).rstrip()))
    return out


def get_next_task(model: str) -> tuple[str | None, int]:
    """Return (next_task_text_or_None, total_count_in_queue) for this model's queue."""
    text = _read_tasks_file(model)
    tasks = _parse_tasks(text)
    if not tasks:
        return None, 0
    return tasks[0][1], len(tasks)


def renumber_tasks_in_file(
    path: str, step: int = 5, start: int = 0, dry_run: bool = False
) -> dict:
    """Rewrite task headers in `path` to step-multiples (Task 0, Task 5, Task 10, …).

    Useful after deletions leave gaps (Task 5, 28, 36 …) or before inserting
    new tasks between existing ones. Only rewrites the HEADER line of each
    task block — task bodies that reference "Task N" elsewhere are untouched.

    Args:
        path: absolute path to the queue file.
        step: spacing between consecutive task numbers (default 5).
        start: number for the first task (default 0).
        dry_run: if True, return the plan without writing.

    Returns a dict:
        {
          "path": <path>,
          "before": [old numbers in file order],
          "after":  [new numbers in file order],
          "written": True if file was modified, False if no-op or dry-run,
        }

    No-op (returns written=False) when before == after (already step-multiples
    starting at `start`). Pause-for-approval semantics: callers should run
    once with dry_run=True, show the user the plan, then re-run with
    dry_run=False on approval.
    """
    with open(path, encoding="utf-8") as f:
        text = _unmojibake(f.read())
    lines = text.splitlines(keepends=False)
    task_starts = [i for i, line in enumerate(lines) if TASK_LINE_RE.match(line.strip())]

    before_nums: list[int] = []
    for idx in task_starts:
        m = re.match(r"^\s*task\s+(\d+)", lines[idx], re.IGNORECASE)
        if m:
            before_nums.append(int(m.group(1)))

    after_nums = [start + i * step for i in range(len(task_starts))]

    if before_nums == after_nums:
        return {"path": path, "before": before_nums, "after": after_nums, "written": False}
    if dry_run:
        return {"path": path, "before": before_nums, "after": after_nums, "written": False}

    new_lines = list(lines)
    for line_idx, new_num in zip(task_starts, after_nums):
        # Preserve leading whitespace, the original "Task" / "task" case, the
        # spacing between "Task" and the number, and everything after the number.
        m = re.match(r"^(\s*)(task)(\s+)\d+(.*)$", new_lines[line_idx], re.IGNORECASE)
        if m:
            new_lines[line_idx] = f"{m.group(1)}{m.group(2)}{m.group(3)}{new_num}{m.group(4)}"

    new_text = "\n".join(new_lines)
    if text.endswith("\n"):
        new_text += "\n"
    _atomic_write(path, new_text)
    return {"path": path, "before": before_nums, "after": after_nums, "written": True}


def renumber_tasks(
    model: str, step: int = 5, start: int = 0, dry_run: bool = False
) -> dict:
    """Renumber the queue for `model` to step-multiples. See renumber_tasks_in_file."""
    return renumber_tasks_in_file(
        _path_for_model(model), step=step, start=start, dry_run=dry_run
    )


def delete_first_task(model: str) -> int:
    """Delete the first task from this model's queue. Return remaining count."""
    text = _read_tasks_file(model)
    tasks = _parse_tasks(text)
    if not tasks:
        return 0
    lines = text.splitlines(keepends=False)
    start, _ = tasks[0]
    end = tasks[1][0] if len(tasks) > 1 else len(lines)
    while end < len(lines) and lines[end].strip() == "":
        end += 1
    new_lines = lines[:start] + lines[end:]
    while new_lines and new_lines[-1].strip() == "":
        new_lines.pop()
    new_text = "\n".join(new_lines) + "\n"
    _atomic_write(_path_for_model(model), new_text)
    return len(tasks) - 1
