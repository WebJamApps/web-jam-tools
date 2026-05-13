"""Ollama HTTP client with function-calling support.

Runs a multi-turn chat loop: send user message + tool schemas, dispatch tool calls
the model emits, feed results back, repeat until the model returns a plain reply.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable

import requests

OLLAMA_URL = "http://localhost:11434/api/chat"
DEFAULT_MODEL = "gemma4:e4b"
MAX_TURNS = 8
# Lower temperature = less creative filling-in = less hallucination on drafting tasks.
DEFAULT_TEMPERATURE = 0.2


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

    for turn in range(MAX_TURNS):
        body = {
            "model": model,
            "stream": False,
            "messages": messages,
            "tools": [t.schema() for t in tools],
            "options": {"temperature": DEFAULT_TEMPERATURE},
        }
        resp = requests.post(OLLAMA_URL, json=body, timeout=300)
        resp.raise_for_status()
        data = resp.json()
        msg = data["message"]
        messages.append(msg)

        tool_calls = msg.get("tool_calls") or []
        if not tool_calls:
            text = msg.get("content", "")
            if not text and invocations:
                last = invocations[-1]
                text = (
                    f"COORDINATOR REPORT: Called {last['name']}; "
                    f"result: {json.dumps(last['result'], default=str)[:200]}"
                )
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

    return ChatResult(
        final_text="(max tool-call turns reached without a final answer)",
        tool_invocations=invocations,
        history=[m for m in messages if m.get("role") != "system"],
    )
