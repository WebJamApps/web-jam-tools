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
# emitted a structured tool_call. Pattern: `{"name": "X", "parameters": {...}}`
# or with "arguments" instead of "parameters". Llama 3.3 70B regresses to this
# pattern on the 2nd/3rd tool call in a multi-step task — prompt-only fixes
# don't reliably prevent it, so we detect + re-prompt at the protocol layer.
_INLINE_TOOL_CALL_RE = re.compile(
    r'\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"(?:parameters|arguments)"\s*:\s*\{',
    re.DOTALL,
)

# Cap retries so a model that keeps emitting inline JSON doesn't burn the whole
# MAX_TURNS budget on corrections.
MAX_INLINE_CORRECTIONS = 2


def _detect_inline_tool_call(content: str) -> str | None:
    """Return the attempted tool name if `content` contains an inline-JSON tool call."""
    if not content:
        return None
    match = _INLINE_TOOL_CALL_RE.search(content)
    return match.group(1) if match else None


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
) -> ChatResult:
    tool_by_name = {t.name: t for t in tools}
    messages: list[dict[str, Any]] = []
    if system:
        messages.append({"role": "system", "content": system})
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": user_prompt})

    invocations: list[dict[str, Any]] = []
    inline_corrections = 0

    for turn in range(MAX_TURNS):
        body = {
            "model": model,
            "stream": True,
            "messages": messages,
            "tools": [t.schema() for t in tools],
            "options": {
                "temperature": DEFAULT_TEMPERATURE,
                "num_predict": 2048,
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

        for call in tool_calls:
            fn = call["function"]
            name = fn["name"]
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                args = json.loads(args)
            if verbose:
                print(f"[tool] {name}({json.dumps(args)})")
            if name not in tool_by_name:
                result: Any = {"error": f"Unknown tool: {name}"}
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

    fallback_text = "(max tool-call turns reached without a final answer)"
    print(fallback_text)
    return ChatResult(
        final_text=fallback_text,
        tool_invocations=invocations,
        history=[m for m in messages if m.get("role") != "system"],
    )
