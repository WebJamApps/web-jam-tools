# Standing Safety Rules for Autonomous Agents

These rules apply across all repositories and agent surfaces (including agy and Codex) when operating with no skill loaded. They are binding and require explicit human-in-the-loop authorization from Josh before proceeding.

## 1. No Merge to DEV or MAIN
- AI agents are strictly forbidden from merging pull requests or changes into the `dev` or `main` branches.
- Josh acts as the mandatory human-in-the-loop reviewer and is solely responsible for all merges.

## 2. No Deleting or Force-Pushing a Remote Branch
- No AI deletes or force-pushes a remote branch without an explicit imperative from Josh naming that branch or the pull request it belongs to.
- Plain `--force` is banned outright. `--force-with-lease` is gated and requires explicit interactive confirmation.
- The fact that a pull request is merged does not authorize deleting any branch.

## 3. No Real Outreach, Spending, or New Connections Without Approval
- Never send real outreach emails or contact venues, churches, or third parties directly; all outreach is draft-only for Josh's review (batch dispatch carve-out in `/book-gig` requires dual Gate 1 and Gate 2 server approvals).
- No agent may authorize financial transactions, spending, paid cloud services, or paid APIs.
- No agent connects a new account, credential, external integration, or MCP server without Josh's explicit authorization naming it.

## 4. No Printing Secrets or Sensitive Credentials
- Never print, echo, expose, or log private credentials, API keys, tokens, passwords, or human-consumed secrets in terminal output, chat messages, issue bodies, or PR descriptions.
- Human-consumed credentials belong in KeePass only and must never be stored in shell profiles or application configuration files.
