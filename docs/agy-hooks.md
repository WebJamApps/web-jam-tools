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

- **`hooks/agy-model-guard.sh`** — matcher `.*` (every tool call). Denies a non-Flash model chosen
  **in-session**, using the `modelName` field agy's own payload carries (finding 7). Shares its
  allowed-slug 3.7 floor (`gemini-3.7-flash-*` or newer) with `hooks/block-agy-non-flash-model.sh`
  (which only sees a literal `agy --model ...` Bash invocation from Claude Code, not a running
  agy session's live model) via `hooks/lib/check_agy_model.ts`, so the two can't drift apart.
  Fails OPEN when `modelName` is missing (cost guard, not a leak guard).
- **`hooks/block-agy-gmail-send-delete.sh`** — matcher
  `send_email|delete_email|batch_delete_emails` (agy exposes Gmail MCP tool names unprefixed — no
  `mcp__gmail__` prefix; that convention is Claude Code-specific). Unconditionally denies once it
  runs. Read, label, and archive tooling (`search_emails`, `read_email`, `list_email_labels`,
  `modify_email`, ...) are not matched and stay available.

## 5. Haiku cost gate surface-awareness

`hooks/haiku-only-gmail-gate.sh` is **not edited**. On Claude Code it stays wired to its existing
matcher (`mcp__(gmail|claude_ai_Gmail)__.*`) and keeps gating Gmail tools to Haiku, exactly as
before. On agy it's still wrapped by the shim (it's in the shared hook list), but that matcher is
the Claude Code-specific `mcp__` prefix convention and never matches agy's raw, unprefixed Gmail
tool names — so it naturally never fires there. Instead, `hooks/agy-model-guard.sh` (§4, matcher
`.*`) is what gates the Antigravity surface: any tool call — Gmail included — is denied unless the
session is on an allowed Flash model. Net effect: Claude Code stays gated to Haiku, Antigravity is
gated to Flash, and neither hook needed to change.

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

`send_email`, `delete_email`, and `batch_delete_emails` are denied unconditionally on the
Antigravity surface by `hooks/block-agy-gmail-send-delete.sh` (§4) — Flash never gets outbound
mail identity or delete capability on Josh's personal inbox, independent of which model is active.
Read, label, and archive tooling remain available, gated only by the model guard (§4/§5). This
mirrors Claude Code's own draft-only Gmail policy in spirit, without touching Claude Code's
permissions at all (non-goal).

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

