#!/usr/bin/env python3
"""Renumber a gemma-cli queue's task headers to step-multiples (Task 0, 5, 10, …).

Two-step workflow (Task 34 sub-item C, 2026-05-22):
  1. Run with --dry-run to see the proposed plan
  2. Run without --dry-run to apply

Use after deletions leave gaps in task numbers, or before inserting new tasks
between existing ones with room to spare.

Examples:
  scripts/renumber-queue.py --path ~/Dropbox/web-jam-llms/claude-opus-tasks.txt --dry-run
  scripts/renumber-queue.py --model gemma4:26b
  scripts/renumber-queue.py --path ~/Dropbox/web-jam-llms/claude-opus-tasks.txt --step 10
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Locate gemma_cli without requiring an editable install.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "gemma-cli"))

from gemma_cli.queue import renumber_tasks, renumber_tasks_in_file  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--model", help="Renumber the queue for this model tag (uses TASKS_FILE_PATHS).")
    group.add_argument("--path", help="Renumber the queue at this absolute path.")
    p.add_argument("--step", type=int, default=5, help="Spacing between task numbers (default 5).")
    p.add_argument("--start", type=int, default=0, help="Number for the first task (default 0).")
    p.add_argument("--dry-run", action="store_true", help="Print the plan without writing.")
    args = p.parse_args()

    if args.model:
        result = renumber_tasks(args.model, step=args.step, start=args.start, dry_run=args.dry_run)
    else:
        result = renumber_tasks_in_file(args.path, step=args.step, start=args.start, dry_run=args.dry_run)

    print(json.dumps(result, indent=2))

    if not result["written"] and result["before"] == result["after"]:
        print("(no-op — task numbers are already aligned)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
