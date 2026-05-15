"""`gemma` command entry point.

Usage:
    gemma                                # interactive REPL with full tool access
    gemma "draft a Floyd Country Store pitch and save to JoshMariaMusic"
    gemma --verbose "list files in MariaParty folder"
"""

from __future__ import annotations

import argparse
import sys

from gemma_cli.llm import DEFAULT_MODEL, chat
from gemma_cli.tools.calendar import TOOLS as CALENDAR_TOOLS
from gemma_cli.tools.drive import TOOLS as DRIVE_TOOLS
from gemma_cli.tools.gmail import TOOLS as GMAIL_TOOLS

ALL_TOOLS = DRIVE_TOOLS + CALENDAR_TOOLS + GMAIL_TOOLS

SYSTEM_PROMPT = (
    "You are the Coordinator for Josh Sherman's personal projects (JoshMariaMusic "
    "gig booking and MariaParty retirement party)."
    "\n\nTOOL-USE MANDATE (most important rule):"
    "\nWhen the user asks about ANY Drive file, calendar event, or email — you MUST call the "
    "appropriate tool. Never answer from memory or assumption. If a file is large, use "
    "drive_read_text_file_lines or drive_search_in_file (NOT the full-read tool). If unsure "
    "which tool, call drive_list_files first to find the file ID."
    "\n\nVOICE RULES (for any email/pitch drafting task):"
    "\n- Write as Josh in first person singular ('I', 'my wife Maria'). Never 'we are writing to' / 'we specialize in' / 'we are confident'."
    "\n- Open with 'Hi,' or 'Hi [name],' — NEVER 'Dear [title]' (e.g. 'Dear booking manager' is BANNED)."
    "\n- Banned words: exciting, opportunity, passionate, thrilled, reach out, circle back, truly admire, deep connection, great addition, perfect fit."
    "\n- Tone: like an email between two people who'd recognize each other in a coffee shop. Conversational. No marketing copy."
    "\n- ANTI-HALLUCINATION: If the user did NOT tell you a fact, do not invent it. In particular: do not invent musical genres, awards, past venues, follower counts, or experience claims. If you don't know, leave it out."
    "\n- USE any personal hook the user gives you (e.g. 'son lives in Rustburg'). Don't drop it."
    "\n- Avoid 'your spot'. Prefer 'your venue' / 'your stage' / the venue's actual name."
    "\n\nEXAMPLE PITCHES (match this style. Plain. Conversational. Only facts the user gave you.):"
    "\n  --- Example A (warm tone, returning-area venue) ---"
    "\n  Hi,"
    "\n  My wife Maria and I are an acoustic duo from Salem, VA. We're free the last two weeks"
    "\n  of June and would love to play a Saturday at your place. My son lives in Rustburg, so"
    "\n  we're in the area anyway and it would be a real treat to get on your stage."
    "\n  Let me know if any of those dates work."
    "\n  Thanks — Josh Sherman, joshandmariamusic.com"
    "\n  --- Example B (professional tone, new venue) ---"
    "\n  Hi,"
    "\n  I'm Josh Sherman — my wife and I play as Josh and Maria, an acoustic duo out of Salem,"
    "\n  VA. I came across your venue and wanted to ask about booking. We have Saturdays open"
    "\n  between June 14 and 28. Happy to send a short sample or talk through what we play."
    "\n  Thanks — Josh Sherman, joshandmariamusic.com"
    "\n  ---"
    "\nIf the user did NOT give you a fact (genre, style, prior venues, awards, follower counts), DO NOT mention it. Just leave it out. The examples above only mention facts that were given."
    "\n\nOPERATIONAL RULES (code-enforced — for reference):"
    "\n- CALENDAR CONFLICT: never schedule over an existing event without Josh's explicit override."
    "\n- EMAIL: always DRAFT, never send."
    "\n- FILES: never create a version-suffixed copy (V2, V3, -new, -copy) — edit the master."
    "\n- PROTECTED FILES (MariaParty RSVP MASTER, Master Plan v2, Banner Decision) cannot be modified without explicit Josh override."
    "\n\nSTANDARD EMAIL-DRAFTING FLOW (when the task is to draft an email):"
    "\n1. Compose the email and PRINT the full draft (To, Subject, Body) in your reply text. "
    "Format clearly so Josh can read it in the REPL."
    "\n2. Do NOT save the draft to Drive. Do NOT call gmail_draft_email yet. Just print and stop."
    "\n3. Josh will respond in chat — either approving (e.g. 'looks good, save as Gmail draft') "
    "or giving corrections ('change subject to X', 'make paragraph 2 shorter')."
    "\n4. If corrections, apply them and PRINT the updated draft again. Repeat as needed. "
    "Use session memory — remember what you wrote and apply Josh's edit on top, do not start from scratch."
    "\n5. ONLY when Josh explicitly approves with words like 'save as Gmail draft' or 'looks good, draft it', "
    "call gmail_draft_email ONCE with the final approved content. Then tell Josh: "
    "'Saved as Gmail draft — open Gmail Drafts to send.'"
    "\n\nAfter any tool action, end your response with a one-line summary prefixed 'COORDINATOR REPORT:'."
)


def _run_once(
    prompt: str,
    model: str,
    verbose: bool,
    history: list | None = None,
):
    result = chat(
        user_prompt=prompt,
        tools=ALL_TOOLS,
        system=SYSTEM_PROMPT,
        model=model,
        verbose=verbose,
        history=history,
    )
    print(result.final_text)
    return result


_NEXT_TASK_PREFIX = (
    "You have ONE specific task. Do not look for other tasks; this is your only scope. "
    "The task may have multiple numbered steps (STEP 1, STEP 2, ...). You MUST complete "
    "EVERY step before finishing — DO NOT stop after one tool call. After each tool call, "
    "re-read the task and continue with whatever step still needs work. "
    "Only write a final 'COORDINATOR REPORT' when EVERY step is genuinely done; do NOT "
    "write COORDINATOR REPORT after intermediate tool calls — the report is a finale, "
    "not a per-step status. "
    "Do NOT fabricate any data — if a tool returns nothing, say 'not found' rather than "
    "making up plausible-looking results. "
    "Here is the task:\n\n"
)


def _wrapper_name_for_model(model: str) -> str:
    """Derive the conventional wrapper command name from the model tag.

    Matches the names of the wrappers under ~/.local/bin/ on the maintainer's
    machine: `llama` for Llama models, `gemma` for everything else.
    """
    return "llama" if model.startswith("llama") else "gemma"


def _role_for_model(model: str) -> str:
    """Map a model tag to its team role per CLAUDE.md AI TEAM STRUCTURE."""
    if model.startswith("gemma"):
        return "Media Specialist"
    return "Coordinator"


def _repl(model: str, verbose: bool) -> None:
    name = _wrapper_name_for_model(model)
    role = _role_for_model(model)
    print(f"{name} ({role} REPL — {model}). Tools: Drive, Calendar, Gmail.")
    print("Commands: /next (run next queued task), /done (remove first queued task),")
    print("          /reset (clear session memory), verbose (toggle tool logging),")
    print("          exit / Ctrl-D (quit).\n")
    prompt = f"{name}> "
    history: list = []
    while True:
        try:
            line = input(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not line:
            continue
        if line.lower() in {"exit", "quit", "/bye"}:
            return
        if line.lower() == "verbose":
            verbose = not verbose
            print(f"(verbose = {verbose})")
            continue
        if line.lower() in {"/reset", "reset"}:
            history = []
            print("(session memory cleared)")
            print()
            continue
        if line.lower() in {"/next", "next"}:
            try:
                from gemma_cli.queue import get_next_task

                task, total = get_next_task(model)
                if not task:
                    print("(queue empty)")
                    print()
                    continue
                print(f"=== Next task (of {total} in queue) ===")
                print(task)
                print()
                result = _run_once(
                    _NEXT_TASK_PREFIX + task,
                    model=model,
                    verbose=verbose,
                    history=history,
                )
                history = result.history
            except Exception as exc:
                print(f"[error] {type(exc).__name__}: {exc}")
            print()
            continue
        if line.lower() in {"/done", "done"}:
            try:
                from gemma_cli.queue import delete_first_task

                remaining = delete_first_task(model)
                print(f"Removed first task. {remaining} remaining in queue.")
            except Exception as exc:
                print(f"[error] {type(exc).__name__}: {exc}")
            print()
            continue
        try:
            result = _run_once(line, model=model, verbose=verbose, history=history)
            history = result.history
        except Exception as exc:
            print(f"[error] {type(exc).__name__}: {exc}")
        print()


def main() -> int:
    parser = argparse.ArgumentParser(prog="gemma", description="Local Gemma with Drive/Calendar/Gmail tools")
    parser.add_argument("prompt", nargs="*", help="What to do (natural language). Omit for interactive REPL.")
    parser.add_argument("--verbose", "-v", action="store_true", help="Show tool calls")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Ollama model tag")
    args = parser.parse_args()

    if not args.prompt:
        _repl(model=args.model, verbose=args.verbose)
        return 0

    _run_once(" ".join(args.prompt), model=args.model, verbose=args.verbose)
    return 0


if __name__ == "__main__":
    sys.exit(main())
