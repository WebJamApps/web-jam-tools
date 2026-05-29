"""Persistent task queue support — model-aware, thin wrapper over the Deno CLI.

Used by the REPL `/next` and `/done` commands. As of 2026-05-29 the actual
parse/renumber/dedupe/append/consume logic lives in the Deno `task-queue` tool
(web-jam-tools/src/task-queue) — the single source of truth, with the hard
invariants Josh set (never lose a task, no duplicate numbers, typo-tolerant
headers so a `talk 5` typo is recognized instead of silently eaten). This
module just shells out to that CLI and returns its JSON.

There is ONE queue per model:
  - gemma4:26b → gemma-tasks.txt (Coordinator on the OMEN)

Files live at /home/joshua/Dropbox/web-jam-llms/ (symlinked into WebJamApps).
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess

QUEUE_DIR = "/home/joshua/Dropbox/web-jam-llms"

TASKS_FILE_PATHS = {
    "gemma4:26b": f"{QUEUE_DIR}/gemma-tasks.txt",  # Coordinator (post-2026-05-20)
}
DEFAULT_FALLBACK_PATH = f"{QUEUE_DIR}/gemma-tasks.txt"

# The Deno task-queue CLI, resolved relative to this file (web-jam-tools/...).
_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_CLI_PATH = str(_REPO_ROOT / "src" / "task-queue" / "cli.ts")


def _path_for_model(model: str) -> str:
    return TASKS_FILE_PATHS.get(model, DEFAULT_FALLBACK_PATH)


def _deno_bin() -> str:
    home = os.path.expanduser("~/.deno/bin/deno")
    return home if os.path.exists(home) else (shutil.which("deno") or "deno")


def _run_cli(command: str, path: str, *extra: str) -> dict:
    """Run the Deno task-queue CLI and return its parsed JSON. Raises on failure."""
    proc = subprocess.run(
        [_deno_bin(), "run", "--allow-read", "--allow-write", _CLI_PATH, command, "--path", path, *extra],
        capture_output=True,
        text=True,
    )
    out = (proc.stdout or proc.stderr).strip()
    try:
        data = json.loads(out)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"task-queue CLI '{command}' returned non-JSON: {out[:300]}") from exc
    if not data.get("ok", False):
        raise RuntimeError(
            f"task-queue CLI '{command}' failed: {data.get('error') or data.get('errors')}"
        )
    return data


def get_next_task(model: str) -> tuple[str | None, int]:
    """Return (next_task_text_or_None, total_count_in_queue) for this model's queue."""
    data = _run_cli("next", _path_for_model(model))
    return data.get("task"), int(data.get("remaining", 0))


def delete_first_task(model: str) -> int:
    """Delete the first task from this model's queue. Return remaining count.

    A single CLI call: `complete` no-ops cleanly on an empty queue.
    """
    data = _run_cli("complete", _path_for_model(model))
    return len(data.get("after", []))


def renumber_tasks_in_file(
    path: str, step: int = 5, start: int = 0, dry_run: bool = False
) -> dict:
    """Renumber task headers in `path` to step-multiples via the Deno CLI.

    Returns {"path", "before", "after", "written"}. The CLI aborts (raises here)
    rather than write if renumbering would lose a task or create a duplicate.
    """
    extra = ["--step", str(step), "--start", str(start)]
    if dry_run:
        extra.append("--dry-run")
    data = _run_cli("renumber", path, *extra)
    return {
        "path": path,
        "before": data.get("before", []),
        "after": data.get("after", []),
        "written": data.get("written", False),
    }


def renumber_tasks(
    model: str, step: int = 5, start: int = 0, dry_run: bool = False
) -> dict:
    """Renumber the queue for `model`. See renumber_tasks_in_file."""
    return renumber_tasks_in_file(
        _path_for_model(model), step=step, start=start, dry_run=dry_run
    )
