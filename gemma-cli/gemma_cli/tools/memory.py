"""Memory tool: autonomous save via remember_fact.

Llama calls remember_fact when Josh provides durable context (rules, decisions,
contact details, factual corrections) that should survive into future sessions.
The tool appends a timestamped line to LLAMA.md in Drive.

Manual saves use the /remember REPL command instead — see cli.py.
"""

from __future__ import annotations

from typing import Any

from gemma_cli.llm import Tool
from gemma_cli.memory import append_memory


def remember_fact(fact: str) -> dict[str, Any]:
    """Append a fact to LLAMA.md so it survives into future sessions.

    append_memory() performs code-level deduplication. If a near-match already
    exists, this returns {'saved': False, 'reason': 'already-saved', 'existing_entry': ...}
    so the model sees the result and can adapt — answer from the existing entry
    instead of trying again.
    """
    result = append_memory(fact)
    if not result.get("saved"):
        return {
            "saved": False,
            "fact": fact,
            "reason": result.get("reason", "skipped"),
            "existing_entry": result.get("existing_entry"),
            "note": "A near-duplicate is already saved in LLAMA.md. Answer Josh from the existing entry instead of saving again.",
        }
    return {
        "saved": True,
        "fact": fact,
        "file": result["name"],
        "modified": result["modifiedTime"],
    }


TOOLS: list[Tool] = [
    Tool(
        name="remember_fact",
        description=(
            "Append a single durable fact to your persistent memory (LLAMA.md in Drive). "
            "Call this when Josh gives you context that should survive past this session: "
            "rules ('from now on, always X'), factual corrections, decisions about how to proceed, "
            "names/contacts/dates you'll need next session. Do NOT save ephemeral chat state, "
            "in-progress task details, or things that are already in SHARED.md/LLAMA.md."
        ),
        parameters={
            "type": "object",
            "properties": {
                "fact": {
                    "type": "string",
                    "description": "A clear one-sentence statement of the fact to remember.",
                },
            },
            "required": ["fact"],
        },
        handler=remember_fact,
    ),
]
