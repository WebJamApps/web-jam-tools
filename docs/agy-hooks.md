# agy (Antigravity/Flash) Hook Contract & Gmail Fence

*Created for [web-jam-tools#432](https://github.com/WebJamApps/web-jam-tools/issues/432).*

This document records the agy PreToolUse/PostToolUse hook contract as measured (2026-08-07,
against `gemini-3.6-flash-low`), the translation shim that makes hooks actually enforce on that
surface, and the Antigravity Gmail MCP setup + send/delete fence built on top of it.

---

## 1. Why this exists

`scripts/install-hooks.sh` mirrors every `PreToolUse`/`PostToolUse` hook into
`~/.gemini/config/hooks.json`, and agy does execute them — but before this shim existed, not one
of them could actually block a tool call there. They were installed, they fired, and they were
no-ops (see [problem statement in the issue](https://github.com/WebJamApps/web-jam-tools/issues/432)).

## 2. The agy hook contract, as measured

Verified directly against `agy` with a throwaway probe hook, since nothing in this repo had
confirmed agy hook behaviour before. Every result below was verified by a filesystem side-effect
under a control/test A/B, not by what the model said.

1. **Hooks execute.** A hook registered in `~/.gemini/config/hooks.json` fires on `run_command`,
   `view_file`, `send_message`, and any other tool call.
2. **`matcher` is evaluated against agy's own native tool names, not ignored.**
   *(Initial finding 2026-08-07 claimed matcher was ignored; corrected 2026-09-16 via
   [web-jam-tools#1036](https://github.com/WebJamApps/web-jam-tools/issues/1036) and design decision
   D-24).*
   agy tests the `matcher` field in `~/.gemini/config/hooks.json` against agy's *own native tool names*
   (`run_command`, `replace_file_content`, `write_to_file`, `call_mcp_tool`, etc.), never Claude Code's
   tool names. When a hook was registered with a Claude-shaped matcher like `"Bash"` or `"Edit|Write"`,
   agy tested `"Bash"` against `run_command`, found no match, and silently never invoked the hook.
   To solve this, `scripts/install-hooks.sh` registers every entry under `matcher: ".*"` so agy always
   invokes `agy-hook-shim.sh`. The shim then receives the real Claude matcher (base64-encoded) and
   enforces it against the normalized tool name (§3).
3. **agy's tool names are not Claude's.** The shell tool is `run_command`, with the command in
   `args.CommandLine` and the working directory in `args.Cwd`. There is no `Bash`, `Edit`, or
   `Write` tool name. Best-effort fallback field names for edit tools from earlier work
   ([web-jam-tools#344](https://github.com/WebJamApps/web-jam-tools/issues/344)) were formalized and
   independently measured live on 2026-10-12 ([web-jam-tools#1055](https://github.com/WebJamApps/web-jam-tools/issues/1055)) —
   see §9 for literal tool names and argument signatures.
4. **The payload schema is camelCase, not Claude's.** agy sends `toolCall.name`, `toolCall.args`,
   `transcriptPath`, `conversationId`, `stepIdx`, `artifactDirectoryPath`, `workspacePaths`. None
   of Claude's `tool_input`, `transcript_path`, `hook_event_name` exist, so an unmodified hook's
   `jq`/JSON extraction returns null and it silently allows everything.
5. **Neither Claude veto mechanism is honoured.** `exit 2` and
   `{"hookSpecificOutput":{"permissionDecision":"deny"}}` are both ignored — the tool call runs
   either way.
6. **agy has its own veto, and it works.** A hook that prints
   `{"decision":"deny","reason":"..."}` on stdout and exits 0 hard-blocks the call, and Flash
   reports *"The command was denied by a system hook"* with the reason text. Contract:
   `PreToolHookResult{decision, reason, overwrite, permissionOverrides, allowTool}`, decision enum
   `allow | deny | ask | force_ask | deny_unless_prior_grant`. Stop hooks take a separate enum,
   `stop | continue | block`.
7. **agy exposes `modelName` to hooks** (e.g. `gemini-3.6-flash-low`) directly in the payload —
   Claude Code does not expose the current model to hooks at all.
8. **`PostToolUse` fires, but cannot see tool output.** Its payload carries `toolCall`, `error`,
   `modelName`, `stepIdx`, `transcriptPath` — no tool result. `PostToolHookResult` carries no
   `decision`/veto field of any kind, so nothing a `PostToolUse` hook returns can veto anything on
   agy. **Correction (2026-09-16, decoded directly from the shipped agy binary — `strings
   "$(readlink -f "$(command -v agy)")"` — since agy is closed-source and this wasn't verifiable
   any other way):** `PostToolHookResult` is not fieldless — it carries exactly one optional field,
   `overwrite_result` (a string; protobuf tag `bytes,1,opt,name=overwrite_result,
   json=overwriteResult,proto3,oneof`), whose jsonschema description reads *"Optional. Replaces the
   result of the tool call that just ran with this string. The model is told that the result was
   replaced. Omit to leave the result untouched."* There is still no `decision` field on this
   message (that only exists on `PreToolHookResult`/`StopHookResult`), so a `PostToolUse` hook still
   cannot hard-block a call — but it CAN suppress/replace what the model sees of the tool's output,
   which is the closest available substitute for a post-hoc veto. Printing `{"decision":"allow"}`
   for this event (as the shim did before this correction) is invalid — agy's protojson unmarshal
   rejects the unknown field and replaces the tool's real output with its own unmarshal-error text
   instead (web-jam-tools#1038 "agy-hook-shim: agy rejects the shim's PostToolUse allow reply, so
   every allowed agy tool call returns an error instead of its output"). See `toAgyReply()` in
   `hooks/lib/agy_hook_shim.ts` for the corrected translation.
9. **🔴 Registering a `Stop` or `SessionStart` hook silently disables the ENTIRE hooks config.**
   Not just that event — with one `Stop` entry present, or one `SessionStart` entry, no hook fires
   at all, `PreToolUse` guards included. Verified by isolating one variable at a time: the same
   config minus the `Stop`/`SessionStart` entry fires normally; adding a `PostToolUse` entry
   instead is harmless. Both entry shapes fail, with and without a `matcher` field. agy appears to
   reject the whole file rather than skip the unsupported entry.
10. **Hook `command` strings do accept arguments** — a hook registered as `<path> ARG` runs and
    receives `ARG`.

## 3. The shim

A **single translation shim**, `hooks/agy-hook-shim.sh` (+ `hooks/lib/agy_hook_shim.ts`), not
twelve bilingual hooks. `scripts/install-hooks.sh` registers
`agy-hook-shim.sh <PreToolUse|PostToolUse> <base64-matcher> <target-hook-path>` per hook, on the
agy surface only. It:

1. normalizes agy's payload into the Claude shape the hooks already parse (`toolCall.name` ->
   `tool_name`, `toolCall.args` -> `tool_input` with `CommandLine`/`Cwd`/`TargetFile`/
   `CodeContent` aliased to `command`/`cwd`/`file_path`/`content`, `transcriptPath` ->
   `transcript_path`, and `run_command` -> `Bash`),
2. enforces the `matcher` itself (an anchored regex test against the mapped tool name) and exits
   with `{"decision":"allow"}` without running the target hook when it doesn't match,
3. runs the target hook **unmodified**, piping it the normalized payload on stdin — for
   `PostToolUse`, first recovering the tool's output from `transcriptPath` (best-effort:
   correlates a `stepIdx`-tagged transcript line, falling back to the whole transcript text so a
   detector never goes blind on a wrong structural guess) and attaching it as
   `tool_response.stdout`, and
4. converts the target hook's verdict (`exit 2`, or `hookSpecificOutput.permissionDecision`) into
   agy's own `{"decision":"deny"|"allow"|"ask","reason":"..."}` form.

None of the twelve existing hook scripts under `hooks/` were modified to build this — their
existing tests pass unchanged. The matcher is base64-encoded in the registered command string
(rather than embedded as literal shell text) because agy's exact invocation mechanism (a full
shell parse vs. a naive whitespace split) isn't independently verifiable, and several matchers
contain shell metacharacters (`mcp__(gmail|claude_ai_Gmail)__.*`) that would misparse or trigger
glob expansion under a naive/unquoted split either way.

`scripts/install-hooks.sh` refuses (exit 1, nothing written) to register a `Stop` or
`SessionStart` entry into the agy hooks file — see finding 9 above — via a
`--forbid-lifecycle-hooks` flag on `scripts/merge-hooks-into-settings.ts`, so a future change that
accidentally adds one there is blocked instead of silently disarming every guard on the surface.

## 4. agy-only hooks

Two hooks exist only on the agy surface (never wired into Claude Code's `settings.json` — they
depend on agy-native payload fields Claude Code's hook payload doesn't carry):

- **`hooks/agy-model-guard.sh`** — matcher `.*` (every tool call). Checks the selected model
  **in-session**, using the `modelName` field agy's own payload carries (finding 7). Shares its
  allowed-slug list (the 3.7 Flash floor, `gemini-3.7-flash-*` or newer, plus
  `gemini-4-argon-high` and `claude-sonnet-5-5-high`)
  with `hooks/block-agy-non-flash-model.sh` (which sees an `agy --model ...` Bash invocation from
  Claude Code, including one behind `timeout`, `sudo`, `bash -c` and the like, not a running
  agy session's live model) via `hooks/lib/check_agy_model.ts`, so the two can't drift apart.
  Fails OPEN when `modelName` is missing (cost guard, not a leak guard).

  Post-merge verification follows
  `~/Dropbox/web-jam-llms/Token_Savings/agy-model-guard-restore-manual-steps-2026-10-18.md`;
  Josh restores the installed guard himself in web-jam-tools#1483
  "Manual verification: restore the installed agy guard symlink".
- **`hooks/block-agy-gmail-send-delete.sh`** — matcher covers all nineteen raw and
  exact-server-prefixed Gmail MCP tool names (`mcp__gmail__.*|send_email|...`). Classifies tool calls
  via `hooks/lib/check_gmail_write.ts`: unconditionally denies the five irreversible tools (`send_email`,
  `delete_email`, `batch_delete_emails`, `delete_filter`, `delete_label`); refuses moving mail to Trash
  while agy's permission prompt remains unverified; allows removing Trash, archiving, reads, drafts,
  and ordinary labels.

## 5. Gmail model choice and the session guard

The session guard permits Flash, Argon and Sonnet at high; it supplies no Gmail-specific cost
confirmation or action approval. The chosen-model workflow and expensive-model question are owned
by `~/Dropbox/web-jam-llms/AI_Misbehaves/hooks-design-2026-09-15.md`, “Gmail model choice and
connections”. Their implementation is tracked separately by web-jam-tools#1225
"skills/handle-gmails: use the chosen model and ask the Astra or Opus cost question".
The Gmail fence remains separate from model selection. This guard change adds no Gmail connection.

## 6. Antigravity Gmail MCP setup

Mirrors Claude Code's existing entry (`npx -y @gongrzhe/server-gmail-autoauth-mcp`), reusing the
existing `~/.gmail-mcp/` credentials — no new OAuth grant, no new account. It authenticates as
`joshua.v.sherman@gmail.com`, the account `/handle-gmails` already processes.
`webjam.claude@gmail.com` is permanently excluded from every surface
([web-jam-tools#316](https://github.com/WebJamApps/web-jam-tools/issues/316)) and is not affected
by any of this.

### 🟢 Gemini / Antigravity CLI (`agy/config/mcp_config.json` → `~/.gemini/config/mcp_config.json`)

```json
{
  "mcpServers": {
    "reaper": {
      "command": "/home/joshua/opt/Reaper-MCP/.venv/bin/reaper-mcp",
      "args": []
    },
    "playwright": {
      "command": "npx",
      "args": [
        "-y",
        "@playwright/mcp@latest",
        "--headless"
      ]
    },
    "github": {
      "command": "bash",
      "args": [
        "-lc",
        "exec docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN=\"$GH_TOKEN\" ghcr.io/github/github-mcp-server stdio"
      ]
    },
    "gmail": {
      "command": "npx",
      "args": [
        "-y",
        "@gongrzhe/server-gmail-autoauth-mcp"
      ]
    }
  }
}
```

### Applying it — reproducible from this repo, but Josh's action to take

**This change is deliberately NOT applied to any live config by this repo's automation.**
Connecting a new MCP server to a Flash surface requires Josh's explicit authorization naming that
connection — working this issue is not that authorization. `scripts/install-agy-config.sh` exists
so the change is reproducible instead of a hand-applied, untracked laptop edit, but it is not wired
into `scripts/install-hooks.sh` or run by any agent session. When Josh is ready:

```sh
# 1. Install the hooks first (send/delete fence + model guard), if not already installed:
scripts/install-hooks.sh

# 2. Symlink Antigravity's mcp_config.json to the master copy in this repo:
scripts/install-agy-config.sh

# 3. Restart agy — it reads hooks.json and mcp_config.json at startup.
```

`--mcp-config-path PATH` (or `AGY_MCP_CONFIG_PATH`) sandboxes the install to a different path for
testing. The installer is idempotent — an already-correct symlink is left alone, and an existing real
file is backed up before being replaced by the symlink.

## 7. Send/delete fence

The five irreversible Gmail actions (`send_email`, `delete_email`, `batch_delete_emails`,
`delete_filter`, and `delete_label`) are denied unconditionally on the Antigravity surface by
`hooks/block-agy-gmail-send-delete.sh` (§4) — Flash never gets outbound mail identity or destructive
deletion capability on Josh's personal inbox, independent of which model is active. Moving mail to
Trash requires a real permission prompt; because agy's permission prompt is unverified, Trash additions
are also refused. Removing Trash, archiving, reads, drafts, and ordinary labels pass this fence and
remain subject to the separate Gmail permissions and skill workflow (§5). This mirrors Claude Code's
own draft-only Gmail policy in spirit, without touching Claude Code's permissions at all (non-goal).

## 8. What is NOT verified / NOT applied

Being explicit about the gap between "built and tested against sandboxed fixtures" and "confirmed
live," per this repo's honesty convention (see `agy/webjam-tasks/README.md`'s "Merge/deploy guard
hook" section for the same disclosure on a related agy-native hook):

- **The symlink has not been applied to `~/.gemini/config/mcp_config.json`.**
  Building the reproducible mechanism (`scripts/install-agy-config.sh`, §6) is this issue's scope; applying it is Josh's.
- **Nothing here has been verified live on Antigravity after a restart.** All coverage above is
  end-to-end against the real payload SHAPE (`toolCall.name`/`args`, `transcriptPath`, `modelName`,
  ...) driven through `hooks/agy-hook-shim.sh` via `Deno.Command`, asserting the shim's emitted
  `{"decision":...}` matches agy's documented contract (§2, finding 6) — not against a live,
  interactive `agy` session actually attempting one of these tool calls. Confirming that a real
  agy session reports "denied by a system hook" for `send_email`/`delete_email`/
  `batch_delete_emails` and for a non-Flash model switch, and that Gmail read/label/archive still
  works, needs Josh to run it after applying §6 and restarting agy.

## 9. Live Tool-Name & GitHub MCP Probe (2026-10-12, web-jam-tools#1055)

A live agy probe was conducted on 2026-10-12 to measure agy's native file-edit-shaped tool names,
its GitHub MCP tool-calling structure, and whether `PreToolUse` hooks registered under `.*` fire for each.

### File-Edit Tools

- **`replace_file_content`** (native block replacement tool):
  - Literal tool name: `replace_file_content`.
  - Arguments observed in `args`:
    - `TargetFile` (string, required path to file)
    - `Instruction` (string, description of edit)
    - `Description` (string, explanation of change)
    - `StartLine` (number, 1-indexed start line)
    - `EndLine` (number, 1-indexed end line)
    - `TargetContent` (string, exact text to match and replace)
    - `ReplacementContent` (string, replacement text)
    - `AllowMultiple` (boolean)
    - Optional: `TargetLintErrorIds` (array of lint error IDs)
    - Standard metadata: `toolAction`, `toolSummary`.
  - **PreToolUse hook firing:** Confirmed. A `PreToolUse` hook registered under `.*` fires on every invocation of `replace_file_content`.
- **`write_to_file`** (native file creation and overwrite tool):
  - Literal tool name: `write_to_file`.
  - Arguments observed in `args`:
    - `TargetFile` (string, required target file path)
    - `CodeContent` (string, full content to write)
    - `Overwrite` (boolean, overwrite permission flag)
    - `Description` (string, rationale)
    - Optional: `Append` (boolean), `ArtifactMetadata` (object)
    - Standard metadata: `toolAction`, `toolSummary`.
  - **PreToolUse hook firing:** Confirmed. A `PreToolUse` hook registered under `.*` fires on every invocation of `write_to_file`.
- **`multi_replace_file_content`**:
  - Identified directly in the agy binary (`strings "$(readlink -f "$(command -v agy)")"`) under Cortex deterministic vetting configs (`third_party/jetski/cortex/policyguardian/deterministic_vetting_configs/`) alongside `replace_file_content` and `write_to_file`.

### GitHub MCP Tools (`issue_write`, `sub_issue_write`)

- **Dispatch convention:** agy configures GitHub MCP tools lazily under `~/.gemini/antigravity-cli/mcp/github/`.
  When a GitHub MCP tool is invoked, agy calls the native lazy dispatcher `call_mcp_tool`.
- **Observed read-only call:** A live read-only `issue_read` call confirmed the literal hook payload shape:
  - `toolCall.name`: `"call_mcp_tool"`
  - `toolCall.args.ServerName`: `"github"`
  - `toolCall.args.ToolName`: `"issue_read"`
  - `toolCall.args.Arguments`: `{ "owner": "WebJamApps", "repo": "web-jam-tools", "issue_number": 1055, "method": "get" }`
  - **PreToolUse hook firing:** Confirmed. `PreToolUse` hooks registered under `.*` fire for `call_mcp_tool`.
- **Derived write tool names:** From the observed naming structure and the server schemas at `~/.gemini/antigravity-cli/mcp/github/` (`issue_write.json`, `sub_issue_write.json`):
  - `issue_write`: `method: "create" | "update"`, `owner`, `repo`, `title`, `body`, `labels`, `milestone`, etc.
  - `sub_issue_write`: `method: "add" | "remove" | "reprioritize"`, `owner`, `repo`, `issue_number`, `sub_issue_id`.
  - In agy hook payloads, lazy dispatch emits `toolCall.name: "call_mcp_tool"` with `args.ServerName: "github"` and `args.ToolName: "issue_write"` or `"sub_issue_write"`. Eager or direct naming exposes `mcp_github_issue_write` / `mcp_github_sub_issue_write` or bare `issue_write` / `sub_issue_write`.
  - Because guards like `require-model-label-on-issue-create` and `require-approval-token-on-issue-write` match against `mcp__.*__issue_write`, agy calls do not match without translation by `agy-hook-shim.sh`.
- **Safety invariant verified:** At no point during the probe was an `issue_write` or `sub_issue_write` call made against a live repository. Zero write calls exist in the invocation log.

### Verification Runbook and Probe Tooling

The live session tool-call log was recorded at `/tmp/agy-hook-invocations.jsonl` and preserved at the run's scratchpad path `/home/joshua/.gemini/antigravity-cli/brain/b4801061-7dd9-40ac-a0b3-585b30cca574/scratch/probe-log-2026-10-12.jsonl`.
The probe verification script `scripts/probe-agy-tools.sh` (runnable via `deno task probe:agy-tools`) analyzes the log, validates tool argument signatures, confirms `PreToolUse` firing, and verifies that zero write calls occurred:

An empty log, malformed JSON, or a record without a usable tool identity is refused with exit 1. The verifier reports the path and line for damaged records and emits no safety report for an unreadable log.

```bash
deno task probe:agy-tools --log /path/to/log.jsonl
```

## Helper ancestry rules (moved from AGENTS.md)

29. **Skill Discovery Test Directory Isolation & Strict Helper Ancestry Verification:**
    - **Isolated Installed-Skill Fixtures in Hook & Integration Tests:** When testing hooks,
      scripts, or CLIs that discover installed skills from default user or plugin directories (such
      as `~/.gemini/config/plugins/...` or `~/.gemini/skills`), test suites must never depend on the
      presence of skills in the ambient developer environment or host directories. The discovery
      mechanism must accept directory overrides via environment variables (e.g.
      `AGY_PLUGIN_SKILLS_DIR`, `AGY_USER_SKILLS_DIR`), and shell integration/E2E tests must
      construct isolated temporary skill fixture directories containing mocked `SKILL.md` files so
      that automated CI environments (such as CircleCI under `/home/circleci`) reliably discover
      skills without host dependency.
    - **Strict Helper Ancestry & Structured Creation Record Validation:** In multi-agent
      conversation hierarchies, permission inheritance or skill-run state propagation across helper
      agents must establish authentic creation ancestry rather than accepting arbitrary inter-agent
      traffic or incidental transcript mentions. The child agent's message inbox must strictly
      verify that the message is a genuine helper creation message (`invoke_subagent`) directed
      specifically to this helper's conversation ID, rejecting ordinary inter-agent messages
      (`send_message`), missing or non-string recipients, mismatched recipients, or competing
      messages claiming conflicting parent IDs. Reciprocally, the parent conversation record must be
      validated against structured helper-creation results (such as authentic `invoke_subagent` tool
      execution entries matching recognized creation header formats like
      `Created the following subagents:` declaring the `conversationId`), strictly refusing loose
      raw substring containment, generic model entries, assistant examples in planner responses, or
      unrelated JSON/status responses containing the ID.
    - **Helper Synthetic Launch Input & Ancestry Traversal:** Real helper transcripts contain the
      parent's synthetic launch prompt as `source: "USER_EXPLICIT", type: "USER_INPUT"`. Transcript
      parsers and hook permission evaluators must distinguish a helper's synthetic launch prompt
      from Josh's own input. When evaluating permission or skill-run inheritance, hooks must follow
      the verified helper ancestry to the authentic starting conversation rather than prematurely
      evaluating the helper's synthetic prompt as a direct user command and returning unapproved
      before consulting verified creation messages and parent ancestry. Test suites must cover the
      captured authentic helper launch format, including chained helper-of-a-helper ancestry.
    - **Keep Rejected Helper Ancestry from Authorizing Synthetic Launch Input:** When resolving
      helper ancestry, evaluators must strictly distinguish a genuine top-level starting
      conversation (where Josh typed) from rejected or indeterminate helper evidence (e.g. missing
      recipient, non-string recipient, mismatched recipient, competing senders, or parent records
      failing reciprocal verification). If helper ancestry is rejected, the evaluator must fail
      closed to `not_open` (allow without rewriting) and NEVER fall through to evaluate the helper's
      synthetic launch prompt as user input. Furthermore, helper transcripts must be read with
      helper mode active (isolating synthetic launch prompts into helper launch metadata and keeping
      `userMessages` empty). Test suites must include full-handler regressions where the helper's
      synthetic launch prompt contains a slash command (e.g. `/pr-review`) across every refusal
      case, verifying that rejected ancestry never rewrites or authorizes commands.
    - **Preserve Indeterminate Ancestry on Helper Message Read and Parse Failures:** When inspecting
      a helper's message inbox to discover its parent conversation, reading errors (such as
      permissions or I/O failures when reading the messages directory or individual message files)
      and parsing errors (such as malformed or truncated JSON in a message file) must never be
      silently ignored or collapsed into a genuine starting conversation (`outcome: "none"`). Doing
      so creates an approval bypass by allowing a helper whose creation message is malformed or
      unreadable to fall through to direct-user evaluation, where its synthetic launch prompt (e.g.
      `/pr-review`) would be treated as Josh's approval. Instead, read and parse failures must be
      preserved and propagated as indeterminate ancestry (`outcome: "indeterminate"` /
      `cannot_tell`), returning allow without rewriting (`overwrite: undefined`) while strictly
      preserving the legitimate top-level/no-messages case (where the messages directory does not
      exist or is empty). Test suites must include unit, full-handler, and E2E regressions covering
      unreadable message directories, unreadable files, and malformed JSON messages with slash-command
      launch prompts.
