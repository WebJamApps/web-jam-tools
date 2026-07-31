# Connector Authorization Audit (web-jam-tools#324)

**Date:** 2026-07-31  
**Scope:** web-jam-tools#324 "No agent connects a new account, credential, or MCP server without Josh's explicit authorization — add the rule and audit where it can be mechanically enforced"  
**Status:** 7 of 7 findings reviewed and approved by Josh

---

## Purpose

Audit where the standing rule — **"No agent adds a connector, account, credential, or MCP server without Josh's explicit authorization naming it"** — can be mechanically enforced. The rule was added to `docs/cross-ai-rules.md` (line 84) as part of web-jam-tools#325.

Trigger: the new account `webjab.claude@gmail.com` (for Dropbox verification and password-reset mail only) must never be reachable by any agent. Since non-access is the only enforcement available, mechanical guards are worth having.

---

## Audit Findings (7 Items)

### Item 1: `permissions.deny` in Claude Code settings ✅ APPROVED

**Finding:**  
MCP rules in `permissions.deny` match by tool name (`mcp__server__tool`), not by which account a server is authenticated as. Account-specific denies aren't possible at the MCP level — guards have to be server-level.

**Status:** Reviewed with Josh 2026-07-30  
**Outcome:** Accepted. No mechanical guard possible here; protection depends on not authenticating the new account to any MCP server in the first place.  
**Tracked in:** web-jam-tools#326

---

### Item 2: Hooks installed by `scripts/install-hooks.sh` ✅ APPROVED

**Finding:**  
`hooks/block-secret-dumps.sh` has a deliberate write-only exception for shell profiles (`~/.bashrc` / `~/.zshrc`), needed so ordinary `export FOO=...` is not blocked. Nothing stops a credential from being appended there as plaintext.

**Proposal:** Add a `PreToolUse` guard that hard-blocks with `exit 2` for any command/tool referencing `webjab.claude` or writing to `~/.claude.json` / `.mcp.json` / `settings.json`.

**Status:** Reviewed with Josh 2026-07-31 (Option 2 chosen)  
**Decision:** Deny rules for connector-adding command shapes (`claude mcp add`, etc.) PLUS ONE content-inspecting guard that hard-blocks via `exit 2` — because deny rules match command SHAPE while the thing being guarded (the literal `webjab.claude` string) is CONTENT that can appear in any command.

**Tracked in:** web-jam-tools#326 (implementation pending)

---

### Item 3: MCP server configuration ✅ APPROVED

**Finding:**  
8 MCP servers connected (all enumerated):
- `@piotr-agier/google-drive-mcp` (local, authenticated as josh.v.sherman@gmail.com)
- `claude.ai` Google Drive (hosted connector, read-only)
- Plus 6 others

None reference the new account. Need an ongoing check that fails if one ever does.

**Status:** Reviewed with Josh 2026-07-31  
**Outcome:** Accepted. Same guard as Item 2 above covers this. The content-inspecting `PreToolUse` hook will catch any command/tool call or file write that references `webjab.claude`.

**Tracked in:** web-jam-tools#326

---

### Item 4: Shell profile and environment ✅ APPROVED

**Finding:**  
No guard exists for new credentials in shell profiles. `hooks/block-secret-dumps.sh` exempts them (by design), and "new bashrc vars don't reach mid-session" is just incidental bash behavior, not a control.

**Decision (Josh, 2026-07-31):** Classify credentials by **consumer**:
- **Machine-consumed** (GitHub PAT, Gemini key, Heroku, CircleCI, dev API tokens) — automations need them, so they legitimately live in `~/.bashrc`. Guard must NOT touch these.
- **Human-consumed** (currently `webjab.claude@gmail.com`) — Josh types into a browser only, no automation needs it. **KeePass only**, never plaintext on laptop.

**What follows for the build:**
1. A runtime-read credential register (data file, not hardcoded) in web-jam-tools
2. Every new credential classified at creation — does automation need it, or only Josh?
3. Guard hard-blocks with `exit 2`, never advisory — human-only credential in plaintext is ALWAYS wrong
4. Scope = any `Bash` / `Edit` / `Write` writing a registered human-only credential to disk in plaintext
5. Exact patterns go to Josh before anything is applied

**Status:** Decision recorded 2026-07-31  
**Tracked in:** web-jam-tools#326 (AWAITING Josh's approval of exact patterns before implementation)

---

### Item 5: Google OAuth project isolation ✅ APPROVED

**Finding:**  
The new account cannot authenticate its own GCP project (it's not a project admin). Only control is the KeePass credential + Josh's browser-session habit (never stay signed in where agents can drive Chrome).

**Status:** Reviewed with Josh 2026-07-31  
**Josh's acceptance:** "Yes, I accept item 5 and understand the risks."

**Note:** No mechanical enforcement possible (browser-only, no hook surface). Protection depends on the browser-session habit documented in `docs/josh-manual-controls.md` (to be created as part of web-jam-tools#326).

---

### Item 6: Existing Google connectors ✅ APPROVED

**Finding:**  
Two Drive connectors exist on claude.ai, both authenticated as josh.v.sherman@gmail.com:

1. **Google Drive (hosted on claude.ai)** — Anthropic built-in, read-only, no delete capability
2. **google-drive (local MCP)** — `@piotr-agier/google-drive-mcp`, full CRUD including deleteItem

In scope for this audit only to document what exists; any scope changes are a separate issue needing separate authorization.

**Status:** Reviewed with Josh 2026-07-31  
**Josh's acceptance:** "I accept item 6 and understand the risks. The local MCP has dangerous capabilities (deleteItem), but that's an existing configuration choice."

---

### Item 7: `docs/ai-team-playbook.md` cross-reference ✅ APPROVED (PARTIAL)

**Finding:**  
The new rule needs to be mentioned in the routing doc so both sources agree on the authorization requirement.

**Status:** Reviewed with Josh 2026-07-31  
**What's DONE:**
- ✅ Cross-reference IS in `ai-team-playbook.md` line 43
- ✅ Connector-authorization rule IS in `cross-ai-rules.md` line 84 with origin and issue reference
- ✅ Part 1 shipped via web-jam-tools#325

**What's STILL OWED (to web-jam-tools#326):**
- ❌ Create `docs/josh-manual-controls.md` with Josh-facing habits (browser-session guard, KeePass discipline, manual Dropbox steps)
- ❌ Document the shell profile credential-classification rule (Item 4's decision)
- ❌ Add browser-session rule to `docs/cross-ai-rules.md` as a HUMAN habit binding Josh (agents need to know agents cannot enforce it)

---

## Summary

| Item | Topic | Status | Approved | Notes |
|------|-------|--------|----------|-------|
| 1 | `permissions.deny` | ✅ Reviewed | ✅ Yes | No MCP-level guard possible |
| 2 | Hooks guard | ✅ Reviewed | ✅ Yes (Option 2) | Deny rules + 1 content-inspecting hook; awaiting exact patterns |
| 3 | MCP server config | ✅ Reviewed | ✅ Yes | Same guard as Item 2 |
| 4 | Shell profile / env | ✅ Reviewed | ✅ Yes | Credential register + classification; awaiting exact patterns |
| 5 | Google OAuth isolation | ✅ Reviewed | ✅ Yes | KeePass + browser-session habit only |
| 6 | Existing Google connectors | ✅ Reviewed | ✅ Yes | Two connectors documented; no changes needed |
| 7 | Playbook cross-reference | ✅ Reviewed | ✅ Partial | Cross-ref done; docs still owed to #326 |

**All 7 findings reviewed and approved by Josh (2026-07-31).** Implementation of the guards (Items 2, 3, 4) and documentation (Item 7's remaining work) tracked in web-jam-tools#326 "Implement the connector-authorization audit findings: state-changing commands must prompt, not just warn — wildcard gh allow rules make consent impossible".

---

## Next Steps (web-jam-tools#326)

1. **Exact pattern definitions** for the content-inspecting hook (Item 2) — go to Josh for approval before any implementation
2. **Credential register** for the shell profile guard (Item 4) — establish the data structure and initial entries
3. **Create `docs/josh-manual-controls.md`** (Item 7) — document browser-session habit, KeePass discipline, manual Dropbox steps
4. **Update `docs/cross-ai-rules.md`** with browser-session rule as a human habit (Item 7)

See web-jam-tools#324 for the rule definition and enforcement surfaces; this audit documents where each surface stands.
