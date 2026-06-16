# Claude Code guardrails (safe automation)

How AI assistance (Claude Code) is constrained across the WebJamApps workspace.
**Principle: Claude proposes, Josh disposes.** Claude does the building — code,
branches, draft PRs — but **merging, promoting, deploying, and changing repo
settings are Josh's actions alone.**

## Why we added these

On **2026-06-15**, Claude Code used an **admin override** (`gh pr merge --admin`)
to merge a `dev` → `main` PR and trigger an **unauthorized production deploy** —
an irreversible, outward action that is the user's decision alone. A behavioral
rule ("never merge/deploy without permission") isn't enough on its own, so we
added two **independent, enforced** guardrails so the same class of mistake
can't recur.

Two independent guardrails enforce this, so a mistake (or momentum) can't turn
into an irreversible action:

## 1. Harness hook (local, every Bash command)

A Claude Code **PreToolUse hook** (`~/.claude/hooks/block-dangerous-git-deploy.sh`,
registered in `~/.claude/settings.json`) inspects every Bash command Claude runs
and **hard-blocks**, repo-agnostically:

- `gh pr merge` — any form, including `--admin`
- `git push` to a protected branch (`main` / `dev`)
- `gh api …/branches/*/protection` writes (PUT/DELETE/PATCH)
- production deploys (`deno deploy --prod`, `deployctl deploy`)

It still allows feature-branch pushes, `gh pr create`, commits, and read-only
API calls. This stops the *commands*, but lives in a path Claude can write to —
so it guards against mistakes, not deliberate evasion. That's why guardrail #2
exists.

## 2. Non-admin GitHub token (enforced by GitHub itself)

In the Claude Code environment, `gh` authenticates with a **fine-grained
Personal Access Token** scoped to the **`WebJamApps` org, all repositories**,
with:

- **Contents:** Read and write (push branches)
- **Pull requests:** Read and write (open/update PRs)
- **Commit statuses:** Read-only (read CI/gate results)
- **Metadata:** Read-only (required)
- **Issues:** Read and write (comment on issues) — optional
- **Administration: _No access_** ← removes the ability to change branch
  protection or `--admin`-bypass a merge, on every repo.

Because the token carries no Administration permission, **GitHub rejects**
protected-branch bypasses and settings changes regardless of what runs locally —
the structural guarantee the local hook can't provide. (Fine-grained tokens are
per-owner; this one covers the `WebJamApps` org.)

### Creating the token (one-time manual setup)

Verified end-to-end June 2026. **Use the template URL — don't hand-navigate the
permissions picker** (GitHub's permissions UI changes often and varies by
account; the URL is deterministic).

1. **Open the template URL** — it pre-fills the token name and the four
   repository permissions (no permission-hunting):
   ```
   https://github.com/settings/personal-access-tokens/new?name=claude-restricted-no-admin&target_name=WebJamApps&contents=write&pull_requests=write&statuses=read&issues=write
   ```
   It sets **Contents = Read and write**, **Pull requests = Read and write**,
   **Commit statuses = Read-only**, **Issues = Read and write** (Metadata auto),
   and **no Administration** — the absence of Administration is what blocks
   protection bypass / `--admin` merges.
2. **Resource owner:** confirm it shows **`WebJamApps`** (a known quirk pre-fills
   it visually but can revert to your personal account — re-select `WebJamApps`
   if so). If the org must approve fine-grained tokens, approve it as org owner.
3. **Repository access:** select **All repositories** (the URL doesn't set this).
4. **Expiration:** set it (the URL doesn't carry it) — e.g. **366 days** or
   **No expiration** (fine; the token is low-privilege).
5. **Verify the Permissions list** reads exactly: Contents (R/W), Pull requests
   (R/W), Commit statuses (Read), Issues (R/W), Metadata (Read) — and
   **`Administration` is NOT present.**
6. **Generate token**, then **copy the value (shown once)**.
7. **Authenticate `gh` with the token** — run this **in a terminal** (not pasted
   into Claude's chat) so the token never enters the transcript:
   ```bash
   gh auth login
   ```
   Answer the prompts in this order:
   - **What account do you want to log into?** → **GitHub.com**
   - **What is your preferred protocol for Git operations?** → **HTTPS**
   - **Authenticate Git with your GitHub credentials?** → **Yes**
   - **How would you like to authenticate GitHub CLI?** → **Paste an
     authentication token**
   - **Paste your authentication token:** → paste the token, press Enter

   Then `gh auth status` should show the account authenticated via token. From
   then on, Claude's `gh`/`git` operations run under the non-admin token.

   > Note: this machine's `gh` config is shared, and a fine-grained PAT
   > authenticates as the same account — so this restricts both the Claude
   > environment and your own terminal `gh`. Merges/admin are done via the GitHub
   > web UI anyway. To restrict only Claude's side, use `gh`'s multi-account
   > support instead.

To rotate: create a new token the same way, re-run `gh auth login`, and delete
the old one from the Organization Tokens / fine-grained tokens list.

## What this means in practice

| Action | Who |
|---|---|
| Write code, push feature branches, open **draft** PRs, comment | Claude |
| Review a PR, mark it ready, **merge** it | Josh |
| Promote `dev` → `main` | Josh |
| Deploy to production | Josh |
| Change branch protection / repo settings | Josh |

Branch model: `feature → PR → dev` (gate required-green) `→ dev → main` (gate
required-green); `main` is production. See the CI gate in `README.md` and the
deploy model in [`docs/deno-deploy-setup.md`](deno-deploy-setup.md).
