"""Regression tests for the chat() tool-call loop guards in gemma_cli.llm.

No pytest in this venv — run directly:  .venv/bin/python -m tests.test_loop_guard

Covers:
- Cyclic-call loop (added 2026-05-28): gemma rotates through a handful of
  distinct queries forever (Gig→Booking→Venue→Sheet→…). The consecutive guard
  can't see it; MAX_TOTAL_IDENTICAL_CALLS must.
- Consecutive-identical loop: the original guard still fires.
"""

from __future__ import annotations

import json
from unittest import mock

from gemma_cli import llm
from gemma_cli.llm import Tool, chat, MAX_TOTAL_IDENTICAL_CALLS


class _FakeStream:
    """Mimics requests' streamed response: raise_for_status() + iter_lines()."""

    def __init__(self, chunks: list[dict]):
        self._lines = [json.dumps(c).encode() for c in chunks]

    def raise_for_status(self):
        pass

    def iter_lines(self):
        return iter(self._lines)


def _tool_call(name: str, args: dict) -> dict:
    return {"function": {"name": name, "arguments": args}}


def _make_drive_tool() -> Tool:
    return Tool(
        name="drive_list_files",
        description="List Drive files",
        parameters={"type": "object", "properties": {"q": {"type": "string"}}},
        handler=lambda **kw: {"files": []},  # always empty -> model keeps trying
    )


def test_cyclic_calls_abort():
    """Four distinct queries rotating should trip MAX_TOTAL_IDENTICAL_CALLS."""
    cycle = ["Gig", "Booking", "Venue", "Sheet"]
    # One turn emitting the cycle repeated 4× = 16 tool calls in a single message.
    calls = [
        _tool_call("drive_list_files", {"q": f"name contains '{q}'"})
        for _ in range(4)
        for q in cycle
    ]
    chunks = [{"message": {"content": "", "tool_calls": calls}}, {"done": True}]

    with mock.patch.object(llm.requests, "post", return_value=_FakeStream(chunks)):
        result = chat("find the gig sheet", tools=[_make_drive_tool()], system="x")

    assert "looping" in result.final_text, result.final_text
    # 'Gig' is the first query, so it reaches the threshold first. Invocations
    # processed: (Gig,Book,Venue,Sheet)×3 = 12, then the 13th (Gig→4) aborts.
    gig_count = sum(
        1
        for inv in result.tool_invocations
        if inv["name"] == "drive_list_files"
        and inv["args"] == {"q": "name contains 'Gig'"}
    )
    assert gig_count == MAX_TOTAL_IDENTICAL_CALLS, gig_count
    assert len(result.tool_invocations) == 13, len(result.tool_invocations)
    print("✓ cyclic-call loop aborted at", len(result.tool_invocations), "invocations")


def test_consecutive_identical_still_aborts():
    """The original back-to-back guard must still fire (regression)."""
    same = [_tool_call("drive_list_files", {"q": "name contains 'Gig'"}) for _ in range(5)]
    chunks = [{"message": {"content": "", "tool_calls": same}}, {"done": True}]

    with mock.patch.object(llm.requests, "post", return_value=_FakeStream(chunks)):
        result = chat("find it", tools=[_make_drive_tool()], system="x")

    assert "aborted" in result.final_text, result.final_text
    # Either guard may fire first; both cap well under 5. Just assert bounded.
    assert len(result.tool_invocations) <= MAX_TOTAL_IDENTICAL_CALLS, len(
        result.tool_invocations
    )
    print("✓ consecutive-identical loop aborted at", len(result.tool_invocations))


if __name__ == "__main__":
    test_cyclic_calls_abort()
    test_consecutive_identical_still_aborts()
    print("\nALL PASSED")
