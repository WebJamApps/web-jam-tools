# agy (Antigravity/Flash) Hook Contract & Gmail Fence

*Created for [web-jam-tools#432](https://github.com/WebJamApps/web-jam-tools/issues/432). Last
updated 2026-08-15.*

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
2. **`matcher` is ignored.** Registered with matcher `"Bash"`, a probe hook still fired on every
   tool call — agy runs every registered `PreToolUse` hook on every tool, always. The shim (§3)
   enforces the matcher itself.
3. **agy's tool names are not Claude's.** The shell tool is `run_command`, with the command in
   `args.CommandLine` and the working directory in `args.Cwd`. There is no `Bash`, `Edit`, or
   `Write` tool name — this is the only tool/arg-name mapping independently verified against a
   live probe (agy is closed-source, so nothing else is verifiable from source). Best-effort
   fallback field names for an edit-like tool (`TargetFile`, `CodeContent`,
   `ReplacementContent`/`ReplacementChunks`) come from earlier work
   ([web-jam-tools#344](https://github.com/WebJamApps/web-jam-tools/issues/344)) and are honoured
   by the shim, but are NOT independently verified the same way `run_command` is.
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
   `modelName`, `stepIdx`, `transcriptPath` — no tool result. `PostToolHookResult` also carries no
   fields, so nothing a `PostToolUse` hook returns can influence anything on agy; a detector hook
   can only report (via `PreToolHookResult`-shaped stdout, which agy ignores for this event), not
   veto.
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
  allowed-slug floor (`gemini-3.7-flash-*` or newer) with `hooks/block-agy-non-flash-model.sh`
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

### 🟢 Gemini / Antigravity CLI (`~/.gemini/config/mcp_config.json`)

```json
{
  "mcpServers": {
    "reaper": {
      "command": "/home/joshua/opt/Reaper-MCP/.venv/bin/reaper-mcp",
      "args": []
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--headless"]
    },
    "gmail": {
      "command": "npx",
      "args": ["-y", "@gongrzhe/server-gmail-autoauth-mcp"]
    }
  }
}
```

### Applying it — reproducible from this repo, but Josh's action to take

**This change is deliberately NOT applied to any live config by this repo's automation.**
Connecting a new MCP server to a Flash surface requires Josh's explicit authorization naming that
connection — working this issue is not that authorization. `scripts/merge-agy-gmail-mcp.ts` /
`scripts/install-agy-gmail-mcp.sh` exist so the change is reproducible instead of a hand-applied,
untracked laptop edit, but neither script is wired into `scripts/install-hooks.sh` or run by any
agent session. When Josh is ready:

```sh
# 1. Install the hooks first (send/delete fence + model guard), if not already installed:
scripts/install-hooks.sh

# 2. Then add the gmail MCP server entry:
scripts/install-agy-gmail-mcp.sh

# 3. Restart agy — it reads hooks.json and mcp_config.json at startup.
```

`--mcp-config-path PATH` (or `AGY_MCP_CONFIG_PATH`) sandboxes the merge to a different path, for
testing. The merge is purely additive and idempotent — it never touches the `playwright`/`reaper`
entries or any other top-level key, and re-running it when the entry already matches is a no-op.

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

- **The `gmail` MCP server entry has not been applied to `~/.gemini/config/mcp_config.json`.**
  Building the reproducible mechanism (§6) is this issue's scope; applying it is Josh's.
- **Nothing here has been verified live on Antigravity after a restart.** All coverage above is
  end-to-end against the real payload SHAPE (`toolCall.name`/`args`, `transcriptPath`, `modelName`,
  ...) driven through `hooks/agy-hook-shim.sh` via `Deno.Command`, asserting the shim's emitted
  `{"decision":...}` matches agy's documented contract (§2, finding 6) — not against a live,
  interactive `agy` session actually attempting one of these tool calls. Confirming that a real
  agy session reports "denied by a system hook" for `send_email`/`delete_email`/
  `batch_delete_emails` and for a non-Flash model switch, and that Gmail read/label/archive still
  works, needs Josh to run it after applying §6 and restarting agy.
