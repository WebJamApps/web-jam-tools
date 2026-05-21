"""Ollama HTTP client with function-calling support.

Runs a multi-turn chat loop: send user message + tool schemas, dispatch tool calls
the model emits, feed results back, repeat until the model returns a plain reply.
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass, field
from typing import Any, Callable

import requests


# Detects inline JSON that the model wrote in reply text when it should have
# emitted a structured tool_call. Llama 3.3 70B (and to a lesser extent
# gemma4:26b) regresses to writing tool calls as text on 2nd/3rd turns of a
# multi-step task — prompt-only fixes don't reliably prevent it, so we detect
# + re-prompt at the protocol layer.
#
# Task 36 Phase 2 P2-4 (2026-05-21): broadened from a single bare-shape regex
# to three patterns so we catch more inline-JSON shapes:
#   - bare:    {"name": "X", "parameters": {...}} or arguments
#   - wrapped: "function": {"name": "X", ...}  (OpenAI / Ollama wrap)
#   - list:    "tool_calls": [{"function": {"name": "X", ...}}]
# The 2026-05-20 live test caught add_gig_booking via the bare pattern but
# missed a drive_list_files emission that used the wrapped shape; this catches
# both. ANY tool name is matched (no whitelist); the detector returns the
# attempted name for the corrective re-prompt.
_INLINE_TOOL_CALL_BARE_RE = re.compile(
    r'\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"(?:parameters|arguments)"\s*:\s*\{',
    re.DOTALL,
)
_INLINE_TOOL_CALL_WRAPPED_RE = re.compile(
    r'"function"\s*:\s*\{\s*"name"\s*:\s*"(\w+)"',
    re.DOTALL,
)
_INLINE_TOOL_CALLS_LIST_RE = re.compile(
    r'"tool_calls"\s*:\s*\[\s*\{[^}]*?"name"\s*:\s*"(\w+)"',
    re.DOTALL,
)

# Cap retries so a model that keeps emitting inline JSON doesn't burn the whole
# MAX_TURNS budget on corrections. Bumped from 2 → 4 on 2026-05-21 (Task 36
# Phase 2 P2-4) — the broader detector triggers more often, and 2 corrections
# was tight when a single task hit two different inline-JSON shapes in a row.
MAX_INLINE_CORRECTIONS = 4

# Identical-call loop guard: if the model emits the same (name, args) tool call
# this many times in a row, abort the chat() loop with an error result instead
# of letting it spin. Added 2026-05-21 after the Olde Salem run: gemma4:26b
# emitted `drive:list_files` 80+ times in a row (the MCP-style name doesn't
# match the actual `drive_list_files` registration, so every call returned
# "Unknown tool", and the model didn't notice). Without a guard, only MAX_TURNS
# bounds the damage — and the model can fit many tool calls per turn.
MAX_CONSECUTIVE_IDENTICAL_CALLS = 3

# Text-output line-repetition guard: if the model emits the same non-empty
# line this many times consecutively during streaming, abort the current
# response. Added 2026-05-21 after the 419 West run: gemma4:26b printed
# `To: info@419west.com` (a corrupted version of the dispatcher's email)
# 100+ times before Josh Ctrl-C'd. Tool-call loops are caught by
# MAX_CONSECUTIVE_IDENTICAL_CALLS; this is the text-output analog.
MAX_CONSECUTIVE_IDENTICAL_LINES = 5


def _detect_inline_tool_call(content: str) -> str | None:
    """Return the attempted tool name if `content` contains an inline-JSON tool call.

    Checks three JSON shapes (bare, wrapped, tool_calls-list); returns the
    first match's name. Returns None if no shape matched.
    """
    if not content:
        return None
    for pattern in (
        _INLINE_TOOL_CALL_BARE_RE,
        _INLINE_TOOL_CALL_WRAPPED_RE,
        _INLINE_TOOL_CALLS_LIST_RE,
    ):
        match = pattern.search(content)
        if match:
            return match.group(1)
    return None


def _normalize_tool_name(name: str, known: set[str]) -> str:
    """Coerce model-emitted tool names to a registered tool name when possible.

    gemma4:26b sometimes emits MCP-style names with a colon separator
    (`drive:list_files`) instead of the underscored form we register
    (`drive_list_files`). Without this coercion every call returns
    "Unknown tool" and the model can spin retrying the same broken name.

    Returns the original name unchanged if no safe normalization yields a hit.
    """
    if name in known:
        return name
    # MCP-style colon → underscore (full string)
    candidate = name.replace(":", "_")
    if candidate in known:
        return candidate
    return name


def _ollama_chat_url() -> str:
    host = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
    if not host.startswith(("http://", "https://")):
        host = f"http://{host}"
    return f"{host}/api/chat"


OLLAMA_URL = _ollama_chat_url()
DEFAULT_MODEL = "gemma4:26b"
MAX_TURNS = 8
# Lower temperature = less creative filling-in = less hallucination on drafting tasks.
# 0.0 enforces deterministic sampling. Tried 0.1 on 2026-05-16 to fix ambiguous
# over-trigger ("what's going on?") — instead it caused clear smalltalk like "how
# do you feel today?" to over-fire too. Reverted to 0.0. The over-trigger on truly
# ambiguous input is an accepted cost; clear smalltalk handling is more important.
DEFAULT_TEMPERATURE = 0.0
# Ollama's default num_ctx is often 4096 or 8192 depending on the model. SHARED.md
# + GEMMA.md is ~15K chars (~3700 tokens) before tool schemas and history, so the
# default silently truncates the EARLY parts of the system prompt. 8192 keeps the
# full prompt + room for tool schemas, history, and a short reply.
#
# 2026-05-17: Tried 16384 to fit comfortably, but KV cache at 70B × 16384 ctx
# was approaching OMEN's 80GB system RAM ceiling and causing /next dispatch to
# hang for many minutes on first allocation per REPL session. Dialed back to
# 8192. The client-side smalltalk and email-approval gates do not depend on the
# larger context — they work at protocol layer, not prompt layer.
DEFAULT_NUM_CTX = 8192


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[..., Any]

    def schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


@dataclass
class ChatResult:
    final_text: str
    tool_invocations: list[dict[str, Any]] = field(default_factory=list)
    history: list[dict[str, Any]] = field(default_factory=list)


def chat(
    user_prompt: str,
    tools: list[Tool],
    system: str | None = None,
    model: str = DEFAULT_MODEL,
    verbose: bool = False,
    history: list[dict[str, Any]] | None = None,
    max_turns: int | None = None,
    num_predict: int | None = None,
) -> ChatResult:
    # Task 36 Phase 2 P2-2 (2026-05-21): callers can pass `max_turns` to override
    # the module default. cli.py uses this to cap gig-tracking dispatches at 3
    # turns (down from 8) — today's drift consumed ~6 of 8 turns wandering;
    # 3 forces convergence or a clean stop.
    effective_max_turns = MAX_TURNS if max_turns is None else max_turns
    # Phase 2 follow-up (2026-05-21): callers can also override num_predict.
    # cli.py raises it for email-reply dispatches so the marker block fits
    # even when gemma includes preamble before printing the markers.
    effective_num_predict = 2048 if num_predict is None else num_predict

    tool_by_name = {t.name: t for t in tools}
    messages: list[dict[str, Any]] = []
    if system:
        messages.append({"role": "system", "content": system})
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": user_prompt})

    invocations: list[dict[str, Any]] = []
    inline_corrections = 0
    # Task 36 Phase 2 P2-1 (2026-05-21): post-task mode. Once the model emits a
    # COORDINATOR REPORT, subsequent tool-call rounds are capped to 1 to prevent
    # post-task wandering (the 2026-05-20 Solstice destructive write happened
    # 3+ turns AFTER the Apocalypse task had been declared done). Tracked per
    # chat() call — fresh for each /next dispatch.
    coordinator_report_emitted = False

    for turn in range(effective_max_turns):
        if coordinator_report_emitted:
            # Post-task mode: hard stop immediately after the turn that emitted
            # the COORDINATOR REPORT. Without this, a model that reported done
            # but kept tool-calling (e.g. trivial `remember_fact` follow-ups,
            # or — far worse — a destructive write to an unrelated venue, as
            # seen 2026-05-20 with Solstice) could drift 4-5 turns later.
            if verbose:
                print(
                    "[runtime] post-task mode — COORDINATOR REPORT already emitted; "
                    "stopping the iteration loop to prevent drift."
                )
            return ChatResult(
                final_text="",  # already streamed; no synthesis needed
                tool_invocations=invocations,
                history=[m for m in messages if m.get("role") != "system"],
            )
        body = {
            "model": model,
            "stream": True,
            "messages": messages,
            "tools": [t.schema() for t in tools],
            "options": {
                "temperature": DEFAULT_TEMPERATURE,
                "num_predict": effective_num_predict,
                "num_ctx": DEFAULT_NUM_CTX,
            },
        }
        # Streaming: print model content to stdout as it arrives so Josh sees
        # progress in real time. Tool calls and final message-state are
        # accumulated from the stream and used downstream as if a single
        # non-streaming response had arrived. Each NDJSON chunk has a partial
        # `message` (with `content` and/or `tool_calls`) and a `done` flag on
        # the terminating chunk.
        resp = requests.post(OLLAMA_URL, json=body, timeout=1200, stream=True)
        resp.raise_for_status()
        collected_content = ""
        collected_tool_calls: list[dict[str, Any]] = []
        any_content_printed = False
        line_repetition_aborted = False
        for raw_line in resp.iter_lines():
            if not raw_line:
                continue
            try:
                chunk = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            msg_chunk = chunk.get("message") or {}
            piece = msg_chunk.get("content") or ""
            if piece:
                sys.stdout.write(piece)
                sys.stdout.flush()
                collected_content += piece
                any_content_printed = True
                # Output-line repetition guard: when piece contains a newline,
                # check the last N completed lines. If the last
                # MAX_CONSECUTIVE_IDENTICAL_LINES non-empty lines are all
                # identical, abort — gemma is in a text-emission loop. See
                # MAX_CONSECUTIVE_IDENTICAL_LINES docstring for context.
                if "\n" in piece:
                    completed = collected_content.split("\n")
                    if len(completed) > MAX_CONSECUTIVE_IDENTICAL_LINES:
                        # Last MAX_CONSECUTIVE_IDENTICAL_LINES lines, excluding
                        # any in-progress trailing line. Use lines that end with
                        # \n only (i.e. all but the last fragment).
                        finished_lines = completed[:-1]
                        tail = [l.rstrip() for l in finished_lines[-MAX_CONSECUTIVE_IDENTICAL_LINES:]]
                        non_empty_tail = [l for l in tail if l]
                        if (len(non_empty_tail) == MAX_CONSECUTIVE_IDENTICAL_LINES
                                and len(set(non_empty_tail)) == 1):
                            sys.stdout.write("\n")
                            sys.stdout.flush()
                            print(
                                f"[runtime] output line repeated "
                                f"{MAX_CONSECUTIVE_IDENTICAL_LINES}× consecutively "
                                f"({non_empty_tail[-1][:60]!r}) — aborting stream"
                            )
                            line_repetition_aborted = True
                            break
            tc_piece = msg_chunk.get("tool_calls") or []
            if tc_piece:
                collected_tool_calls.extend(tc_piece)
            if chunk.get("done"):
                break
        if any_content_printed:
            sys.stdout.write("\n")
            sys.stdout.flush()
        msg = {
            "role": "assistant",
            "content": collected_content,
            "tool_calls": collected_tool_calls,
        }
        messages.append(msg)

        # P2-1: if the model emitted a COORDINATOR REPORT this turn (regardless
        # of whether it also emitted tool calls), arm post-task mode so the
        # NEXT iteration of this loop is the last. A text-only COORDINATOR
        # REPORT will fall through to the return below anyway; this only
        # matters when the model both reported AND tool-called in the same
        # turn (the 2026-05-20 Apocalypse → Solstice drift pattern).
        if "COORDINATOR REPORT:" in collected_content:
            coordinator_report_emitted = True

        tool_calls = msg.get("tool_calls") or []
        if not tool_calls:
            text = msg.get("content", "")
            # Detect inline-JSON tool calls (Llama 3.3 70B regresses to this on
            # 2nd/3rd turns in multi-step tasks). If found, re-prompt the model
            # with a corrective note instead of returning. Capped to prevent
            # infinite loops if the model keeps regressing.
            attempted = _detect_inline_tool_call(text)
            if attempted is not None and inline_corrections < MAX_INLINE_CORRECTIONS:
                inline_corrections += 1
                if verbose:
                    print(
                        f"[runtime] detected inline JSON tool-call attempt for "
                        f"`{attempted}` — re-prompting for structured emission "
                        f"(correction {inline_corrections}/{MAX_INLINE_CORRECTIONS})"
                    )
                messages.append({
                    "role": "user",
                    "content": (
                        "[Runtime note — not from Josh]: Your last reply contained "
                        f"`{{\"name\": \"{attempted}\", ...}}` as TEXT in your reply. "
                        "That is NOT a tool call — plain text JSON does not execute. "
                        "To actually call a tool, emit it in the structured `tool_calls` "
                        "field of your response, not as JSON in your reply body. "
                        "Please try again — either emit a real structured tool_call, or "
                        "say plainly that you don't know what to do next."
                    ),
                })
                continue

            if not text and invocations:
                # Model returned no content (only tool_calls in earlier turns).
                # Synthesize a one-line COORDINATOR REPORT so Josh sees something
                # — and print it explicitly since streaming had nothing to show.
                last = invocations[-1]
                text = (
                    f"COORDINATOR REPORT: Called {last['name']}; "
                    f"result: {json.dumps(last['result'], default=str)[:200]}"
                )
                print(text)
            return ChatResult(
                final_text=text,
                tool_invocations=invocations,
                history=[m for m in messages if m.get("role") != "system"],
            )

        known_tool_names = set(tool_by_name.keys())
        loop_aborted = False
        for call in tool_calls:
            fn = call["function"]
            raw_name = fn["name"]
            name = _normalize_tool_name(raw_name, known_tool_names)
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                args = json.loads(args)
            if verbose:
                if name != raw_name:
                    print(f"[tool] {raw_name} → normalized to {name}({json.dumps(args)})")
                else:
                    print(f"[tool] {name}({json.dumps(args)})")
            if name not in tool_by_name:
                result: Any = {"error": f"Unknown tool: {raw_name}"}
            else:
                try:
                    result = tool_by_name[name].handler(**args)
                except Exception as exc:
                    result = {"error": f"{type(exc).__name__}: {exc}"}
            invocations.append({"name": name, "args": args, "result": result})
            messages.append(
                {
                    "role": "tool",
                    "content": json.dumps(result, default=str),
                }
            )
            # Identical-call loop guard: if the last N invocations are the same
            # (name + args), the model is spinning. Abort so it can't burn the
            # MAX_TURNS budget on a single broken call. See
            # MAX_CONSECUTIVE_IDENTICAL_CALLS docstring for context.
            if len(invocations) >= MAX_CONSECUTIVE_IDENTICAL_CALLS:
                tail = invocations[-MAX_CONSECUTIVE_IDENTICAL_CALLS:]
                first = tail[0]
                if all(
                    inv["name"] == first["name"] and inv["args"] == first["args"]
                    for inv in tail
                ):
                    loop_aborted = True
                    if verbose:
                        print(
                            f"[runtime] identical tool call repeated "
                            f"{MAX_CONSECUTIVE_IDENTICAL_CALLS}× in a row "
                            f"({first['name']}) — aborting to prevent spin"
                        )
                    break
        if loop_aborted:
            err_text = (
                f"(aborted: tool call `{invocations[-1]['name']}` was repeated "
                f"{MAX_CONSECUTIVE_IDENTICAL_CALLS} times in a row with the same "
                f"arguments — the model is stuck. Last result: "
                f"{json.dumps(invocations[-1]['result'], default=str)[:200]})"
            )
            print(err_text)
            return ChatResult(
                final_text=err_text,
                tool_invocations=invocations,
                history=[m for m in messages if m.get("role") != "system"],
            )

    fallback_text = "(max tool-call turns reached without a final answer)"
    print(fallback_text)
    return ChatResult(
        final_text=fallback_text,
        tool_invocations=invocations,
        history=[m for m in messages if m.get("role") != "system"],
    )
