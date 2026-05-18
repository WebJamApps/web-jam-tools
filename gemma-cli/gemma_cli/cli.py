"""`gemma` command entry point.

Usage:
    gemma                                # interactive REPL with full tool access
    gemma "draft a Floyd Country Store pitch and save to JoshMariaMusic"
    gemma --verbose "list files in MariaParty folder"
"""

from __future__ import annotations

import argparse
import re
import sys

from gemma_cli.llm import DEFAULT_MODEL, chat
from gemma_cli.memory import append_memory, load_memory
from gemma_cli.tools.calendar import TOOLS as CALENDAR_TOOLS
from gemma_cli.tools.drive import TOOLS as DRIVE_TOOLS
from gemma_cli.tools.gmail import TOOLS as GMAIL_TOOLS
from gemma_cli.tools.memory import TOOLS as MEMORY_TOOLS
from gemma_cli.tools.templates import TOOLS as TEMPLATE_TOOLS

ALL_TOOLS = DRIVE_TOOLS + CALENDAR_TOOLS + GMAIL_TOOLS + MEMORY_TOOLS + TEMPLATE_TOOLS

SYSTEM_PROMPT = (
    "You are the Coordinator for Josh Sherman's personal projects (JoshMariaMusic "
    "gig booking and MariaParty retirement party)."
    "\n\nTOOL-USE POLICY (most important rule):"
    "\n\nDEFAULT BEHAVIOR: do NOT call tools. Reply to Josh directly using language."
    "\n\nUSE A TOOL ONLY when ALL THREE of these are true:"
    "\n  (a) Josh asks about a SPECIFIC, IDENTIFIABLE resource — a named Drive file, a named calendar event, a specific Gmail thread or sender — OR he explicitly asks for an action like 'list my drive', 'read claude-opus-tasks.txt', 'show today's events', 'search emails for X', 'create a calendar event for Y'."
    "\n  (b) The answer depends on live data only the tool can retrieve — current Drive contents, the real calendar, actual email contents. Not just topics he's mentioned in conversation."
    "\n  (c) You can identify exactly which tool and exactly what arguments to pass."
    "\n\nIF ANY of (a)(b)(c) IS UNCLEAR — do NOT call a tool. Reply conversationally, or ask Josh a clarifying question."
    "\n\nEXAMPLES — USE a tool:"
    "\n- 'list the files in my drive' → drive_list_files"
    "\n- 'read claude-opus-tasks.txt' → drive_list_files (to find ID) then drive_read_text_file"
    "\n- 'what's on my calendar today?' → calendar_list_events"
    "\n- 'create an event for Maria's party at 5pm on May 30' → calendar_create_event"
    "\n- 'search my emails for Bobby at Mac n Bob's' → gmail_search"
    "\n\nEXAMPLES — do NOT use a tool, reply with language:"
    "\n- 'how do you feel today?' → conversational reply"
    "\n- 'hi' / 'good morning' / 'thanks' → conversational reply"
    "\n- 'what are your operating rules?' → answer from this system prompt"
    "\n- 'draft a pitch email to Floyd Country Store, my son lives in Rustburg' → write the draft directly (Josh gave you the facts)"
    "\n- 'what is the capital of Italy?' → answer from training (Rome)"
    "\n- 'help me think through whether to play Saturday or Sunday' → reasoning in text"
    "\n\nHOW TO CALL A TOOL (when you do):"
    "\n- Tool calls are emitted in the structured `tool_calls` field of your response, NOT as text in your reply."
    "\n- Writing a tool name in your reply text is NEVER a tool call. It is plain text and NOTHING will execute."
    "\n- Do NOT describe a tool call in your reply text instead of actually emitting one. Before any tool has actually run and returned a result, your reply should not claim that one did."
    "\n- If you cannot or will not emit a structured tool_call, say so plainly — do not fake the result."
    "\n- If a file is large, use drive_read_text_file_lines or drive_search_in_file (NOT the full-read tool)."
    "\n- If unsure which tool, call drive_list_files first to find the file ID."
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
    "\n\nRESPONSE FORMAT AFTER A TOOL ACTION (read carefully — this is how Josh sees your work):"
    "\n1. FIRST, report the actual content from the tool result. If drive_list_files returned 25 files, print all 25 file names. If drive_read_text_file returned a document body, paste the relevant content. If calendar_create_event returned an event ID, state the event details. The user must see the actual data, not a paraphrase."
    "\n2. THEN, on a new line at the bottom, write a one-line summary prefixed 'COORDINATOR REPORT:'. This footer is a FOOTER, not the entire response. A response that contains only a COORDINATOR REPORT line and no content above it is WRONG — Josh cannot use it."
)


def _run_once(
    prompt: str,
    model: str,
    verbose: bool,
    history: list | None = None,
    system: str | None = None,
    tools: list | None = None,
):
    result = chat(
        user_prompt=prompt,
        tools=tools if tools is not None else ALL_TOOLS,
        system=system if system is not None else SYSTEM_PROMPT,
        model=model,
        verbose=verbose,
        history=history,
    )
    print(result.final_text)
    return result


def _resolve_system_prompt() -> str:
    """Load SHARED.md + LLAMA.md from Drive. Fall back to hardcoded SYSTEM_PROMPT on failure."""
    drive_memory = load_memory()
    if drive_memory is None:
        print("[memory] Could not load SHARED.md + LLAMA.md from Drive — using hardcoded SYSTEM_PROMPT fallback.")
        return SYSTEM_PROMPT
    print(f"[memory] Loaded SHARED.md + LLAMA.md from Drive ({len(drive_memory)} chars).")
    return drive_memory


# Smalltalk gate (added 2026-05-17). Llama 3.3 70B Q4 ignores prompt-level rules
# forbidding tool use on greetings — the tool schemas in the request body act as a
# strong attractor and the model fires drive_list_files({}) on "hi". Hardcoded
# prompt strengthening, temp 0.0, num_ctx 16384, and the NO-COORDINATOR-REPORT
# rule all failed to suppress it. Pragmatic fix: detect smalltalk client-side and
# call the model WITHOUT tools attached for those turns. Removes the attractor at
# the protocol layer instead of relying on the model to follow instructions.
_SMALLTALK_EXACT = frozenset({
    "hi", "hello", "hey", "yo", "sup", "howdy",
    "thanks", "thank you", "thx", "ty",
    "bye", "goodbye", "cya", "later",
    "ok", "okay", "k", "kk", "cool", "nice", "got it", "gotcha",
    "yes", "yeah", "yep", "no", "nope", "nah",
    "lol", "haha",
})

_SMALLTALK_PATTERNS = (
    re.compile(r"^good\s+(morning|afternoon|evening|night|day)[.! ]*$", re.IGNORECASE),
    re.compile(r"^how\s+(are|is|was)\s+(you|it|things|your\s+day)[?.! ]*$", re.IGNORECASE),
    re.compile(r"^(what'?s\s+up|whats?up|wassup)[?.! ]*$", re.IGNORECASE),
    re.compile(r"^(how'?s\s+it\s+going|hows\s+it\s+going)[?.! ]*$", re.IGNORECASE),
)


def _is_smalltalk(text: str) -> bool:
    """Return True for clear conversational openers that should NOT trigger tools.

    Conservative on purpose — only catches clean smalltalk. Anything ambiguous
    falls through to the normal tool-enabled path so the model can still use
    tools when there's actual work to do.
    """
    normalized = text.strip().rstrip(".!?").strip().lower()
    if not normalized:
        return False
    if normalized in _SMALLTALK_EXACT:
        return True
    return any(p.match(text.strip()) for p in _SMALLTALK_PATTERNS)


# Email-draft approval gate (added 2026-05-17). Same class of bug as the smalltalk
# gate: when /next dispatches a venue-email task, llama reaches for gmail_draft_email
# on turn 1 BEFORE Josh has reviewed the draft, violating the STANDARD EMAIL-DRAFTING
# FLOW (print draft → iterate with Josh → only call gmail_draft_email after explicit
# approval). Removing the tool from the request body on un-approved turns means the
# model physically cannot fire it.
_EMAIL_DRAFT_SAVE_TOOL_NAMES = frozenset({"gmail_draft_email"})

# Substrings that count as Josh authorizing the draft to be saved as a Gmail draft.
# Compared against `line.lower()` so any casing matches. Conservative — must contain
# an explicit "save / draft / send / ship / approve" word; a passive "looks fine" is
# not enough.
_APPROVAL_PHRASES = (
    "save as gmail draft",
    "save it as a gmail draft",
    "save the draft",
    "save it as gmail draft",
    "save as draft",
    "save it as draft",
    "save the email",
    "save to gmail",
    "save the gmail draft",
    "draft it",
    "draft this",
    "save it",
    "go ahead and save",
    "go ahead and draft",
    "go ahead, save",
    "go ahead, draft",
    "ship it",
    "send it",
    "looks good, save",
    "looks good, draft",
    "looks good draft",
    "looks good save",
    "approve",
    "approved",
    "i approve",
)


def _has_email_draft_approval(text: str) -> bool:
    """Return True if Josh's input authorizes calling gmail_draft_email.

    Conservative on purpose — without an explicit approval signal, the gate
    keeps gmail_draft_email out of the request body. Josh can always re-prompt
    with a clear "save as Gmail draft" to release the gate.
    """
    lower = text.lower().strip()
    if not lower:
        return False
    return any(phrase in lower for phrase in _APPROVAL_PHRASES)


def _strip_email_draft_save(tools: list) -> list:
    """Remove gmail_draft_email (and any other approval-gated save tools)."""
    return [t for t in tools if t.name not in _EMAIL_DRAFT_SAVE_TOOL_NAMES]


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


_VERIFICATION_TASK_PREFIX = (
    "VERIFICATION REQUEST (this is NOT an execution request).\n\n"
    "Josh already attempted this task earlier in this session. He wants to know "
    "whether it actually completed successfully. Your job is to CHECK, not to redo.\n\n"
    "What to do:\n"
    "1. Use ONLY the read-only tools available to you (the runtime has filtered the "
    "tool set — write tools are NOT present in this turn). Inspect the relevant Drive "
    "file, calendar event, or email to determine current state.\n"
    "2. Decide whether the task's intended outcome is already in place.\n"
    "3. Report in this exact format on three lines:\n"
    "   STATUS: COMPLETE | INCOMPLETE | UNCERTAIN\n"
    "   EVIDENCE: which resource you checked and what you found.\n"
    "   NEXT STEP: either 'Josh can run /done to mark this complete' (if COMPLETE) "
    "or 'requires re-execution because <reason>' (if INCOMPLETE/UNCERTAIN).\n\n"
    "Do NOT attempt to execute the task. Do NOT call any tool that writes, creates, "
    "updates, or saves anything (those tools are not available to you in this turn).\n"
    "Do NOT call remember_fact — this verification is session-scoped.\n\n"
    "Here is the task you previously attempted:\n\n"
)


# Tools that only read state. Used to build the verify-mode tool subset so a model
# in VERIFICATION mode can't accidentally execute the task.
_READ_ONLY_TOOL_NAMES = frozenset({
    "drive_list_files",
    "drive_read_text_file",
    "drive_read_text_file_lines",
    "drive_search_in_file",
    "calendar_list_events",
    "gmail_search",
})


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
    system_prompt = _resolve_system_prompt()
    print(f"{name} ({role} REPL — {model}). Tools: Drive, Calendar, Gmail.")
    print("Commands: /next [--force] (run next queued task; re-runs auto-switch to read-only verify mode unless --force),")
    print("          /done (remove first queued task),")
    print("          /remember <text> (append fact to LLAMA.md), /memory (show current memory),")
    print("          /reset (clear session memory), verbose (toggle tool logging),")
    print("          exit / Ctrl-D (quit).\n")
    prompt = f"{name}> "
    history: list = []
    # Tracks the first ~80 chars of the most recently /next-ed task so we can
    # warn Josh if he runs /next twice without /done in between. In-session
    # only; doesn't survive REPL restart.
    last_next_task: str | None = None
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
            last_next_task = None
            print("(session memory cleared)")
            print()
            continue
        if line.lower().startswith("/remember"):
            text = line[len("/remember"):].strip()
            if not text:
                print("Usage: /remember <fact text>")
                print()
                continue
            try:
                result = append_memory(text)
                if result.get("saved"):
                    print(f"(remembered → {result['name']})")
                else:
                    existing = (result.get("existing_entry") or "").strip()
                    if len(existing) > 100:
                        existing = existing[:97] + "..."
                    print(f"(already saved — {existing or 'duplicate'})")
            except Exception as exc:
                print(f"[error] {type(exc).__name__}: {exc}")
            print()
            continue
        if line.lower() in {"/memory", "memory"}:
            try:
                m = load_memory()
                if m is None:
                    print("(could not load memory from Drive — check auth)")
                else:
                    print(m)
            except Exception as exc:
                print(f"[error] {type(exc).__name__}: {exc}")
            print()
            continue
        parts = line.lower().split()
        if parts and parts[0] in {"/next", "next"}:
            force = any(p in {"--force", "force"} for p in parts[1:])
            try:
                from gemma_cli.queue import get_next_task

                task, total = get_next_task(model)
                if not task:
                    print("(queue empty)")
                    print()
                    continue
                # Normalize for re-run detection: collapse whitespace, take first 80 chars.
                signature = " ".join(task.split())[:80]
                matches_last = (signature == last_next_task)
                is_rerun = matches_last and not force
                last_next_task = signature

                print(f"=== Next task (of {total} in queue) ===")
                print(task)
                print()

                if is_rerun:
                    print(
                        "(reminder: this task was already attempted in this session — "
                        "running VERIFICATION mode with read-only tools. To force a "
                        "real re-execute, type: /next --force)"
                    )
                    print()
                    verify_tools = [t for t in ALL_TOOLS if t.name in _READ_ONLY_TOOL_NAMES]
                    result = _run_once(
                        _VERIFICATION_TASK_PREFIX + task,
                        model=model,
                        verbose=verbose,
                        history=history,
                        system=system_prompt,
                        tools=verify_tools,
                    )
                else:
                    if matches_last and force:
                        print("(forced re-execute — bypassing verify mode)")
                        print()
                    # Email-draft approval gate: strip gmail_draft_email from the
                    # tool set on /next dispatch. The user CANNOT have approved a
                    # draft on the same turn they ran /next — gmail_draft_email
                    # belongs to the next turn (after Josh reviews + approves).
                    # See _has_email_draft_approval docstring.
                    next_tools = _strip_email_draft_save(ALL_TOOLS)
                    result = _run_once(
                        _NEXT_TASK_PREFIX + task,
                        model=model,
                        verbose=verbose,
                        history=history,
                        system=system_prompt,
                        tools=next_tools,
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
                last_next_task = None
                print(f"Removed first task. {remaining} remaining in queue.")
            except Exception as exc:
                print(f"[error] {type(exc).__name__}: {exc}")
            print()
            continue
        try:
            # Smalltalk gate: strip tool schemas for clear conversational openers
            # so the model can't fire drive_list_files({}) on "hi". See _is_smalltalk
            # docstring for rationale.
            #
            # Email-draft approval gate: independently, strip gmail_draft_email
            # from the tool set unless the user's input contains an approval phrase.
            # Prevents llama from saving a draft to Gmail before Josh reviews it.
            # See _has_email_draft_approval docstring.
            if _is_smalltalk(line):
                turn_tools: list | None = []
            elif _has_email_draft_approval(line):
                turn_tools = None  # full tool set; gmail_draft_email is allowed
            else:
                turn_tools = _strip_email_draft_save(ALL_TOOLS)
            result = _run_once(
                line,
                model=model,
                verbose=verbose,
                history=history,
                system=system_prompt,
                tools=turn_tools,
            )
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

    _run_once(
        " ".join(args.prompt),
        model=args.model,
        verbose=args.verbose,
        system=_resolve_system_prompt(),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
