---
name: file-issue
description: File a GitHub issue the WebJamApps way — deliverable-first body shape (`## What this builds`), a deliberately chosen model label, every referenced issue/PR cited as repo + number + title, a duplicate search first, epics closing when children close, native Priority set via MCP, and concrete closeable acceptance criteria (no perpetual trackers). Use this instead of calling `gh issue create` (or the GitHub MCP `issue_write` create path) directly. Triggered when the user says "file an issue", "open an issue", "draft an issue", or when a task needs a tracking issue instead of just being done inline.
metadata:
  version: v1
  publisher: josh
---

# file-issue — file a GitHub issue the WebJamApps way

**HARD GATE:** Do you have Josh's (or other human's) explicit approval to file THIS issue, in this session? If not, STOP and ask.

## Execution model

This is mechanical-with-light-judgment (search for duplicates, write acceptance criteria that
close cleanly, pick one label from the model-tier list in `skills/fix-labels/labels.yaml`) — run it
on **Sonnet**, the cheapest tier that
reliably gets the judgment calls right. It is not hard-gated to a single model the way `/fix-labels`
and `/handle-gmails` are (this skill is the quality layer, not the floor — see "Why a skill AND a
hook" below); if you're running on a pricier model because you're mid-conversation, finish the
issue rather than switching, but don't default to Opus/Fable for a fresh `/file-issue` invocation.

## Why a skill AND a hook

`hooks/require-model-label-on-issue-create.sh` (web-jam-tools#265) is a hard gate: it denies any
`gh issue create` or MCP `issue_write` create call that doesn't carry exactly one label from
`skills/fix-labels/labels.yaml`'s `modelTier: true` entries — read at runtime from the generated
sidecar `skills/fix-labels/model-labels.json` (not restated here; that list drifts every time a
model tier is added or retired, so `labels.yaml` is the only place it lives), since the hook is
bash/python and can't parse YAML in CI.
That hook closes the silent-omission hole — it cannot judge whether the
label is the *right* one, whether the body cites its references correctly, whether a duplicate
already exists, or whether the acceptance criteria actually let the issue close. This skill is the
quality layer on top of that floor. Skipping this skill still gets caught by the hook if you forget
the label entirely; it does NOT get caught if you pick the label carelessly or write a vague body —
that's what following this skill prevents.

## Before you file

1. **Search for a duplicate first.** Run `gh issue list --repo WebJamApps/<repo> --state all --search
   "<keywords>"` (or `mcp__*__search_issues`) with a couple of keyword variants before creating
   anything. If an OPEN issue matches, use or update that open issue. However, if a matching issue is CLOSED, do NOT modify, comment on, or attempt to reuse it — see the Closed Issues Are Immutable rule below.
2. **Choose the model label deliberately, not as an afterthought.** This is the thing
   web-jam-tools#265 exists because of: web-jam-tools#263 shipped with only a `bug` label and no
   model label, because the label was going to be "added later."    Decide the label as part of
    deciding what the issue IS — before you write the body — from:
    - `Flash Med` — genuinely trivial edits only: a one-line change, a single-field data or typo fix, a link update (an exception case; anything larger goes to `Flash High`).
    - `Flash High` — full-stack coding (FE, BE, APIs, tooling), contained refactoring, multi-file feature edits, and interactive work across all repos (Josh's default tier for interactive work; fast, cost-effective Sonnet alternative).
    - `Haiku` — mechanical/one-off: lookups, scans, single-file/one-field edits, typo/data fixes, running tests/builds and reporting the result.
    - `Sonnet` — major feature implementation, multi-file refactoring, complex backend/system coding, and deep reasoning across codebases (top-tier software engineering model; slightly higher capability than Flash High).
    - `Opus` — top-tier architectural design, complex tech-lead judgment, spec/requirements alignment, and reviewing complex subagent outputs.
    - `Fable` — retired/dormant; do not apply to new issues (kept in the schema for
      delete-protection only, per `skills/fix-labels/labels.yaml`).

   **Tier is not a function of diff size.** The bullets above describe the *kind* of thinking a
   task needs, not how many files it touches. A one-file, twenty-line change can be `Opus` work,
   and a ten-file change can be `Flash High` work. Before settling on a tier, ask what the task
   would **fail** on rather than how big it is. If the hard part is any of these, it is `Opus`
   work however small the diff:
    - **Coherence across a long document** — the change must stay consistent with rules stated
      elsewhere in the same artifact, and a contradiction is the defect.
    - **Adversarial correctness** — a guard, permission gate, parser, or matcher where a subtle
      miss fails *silently and open* rather than loudly.
    - **Alignment against a requirements document** — the artifact must agree with a spec that
      lives somewhere else.

   Both worked examples started small and grew: web-jam-tools#747 "Enforce the Gate 2 approval
   token on every filing path, not only the GitHub MCP one" looked like a guard/hook tweak at
   filing time but took three review rounds, each finding a real bypass; web-jam-tools#789
   "pr-review posts the content review immediately, then checks/polls CircleCI after, with two
   follow-up posts" was one markdown file but likewise took three review rounds — seven internal
   contradictions, then a leaked pre-post CircleCI fetch, then an invalid `gh` selector.
   See item 15 below for the three-outcome specification and model floor governing any guard, gate, or permission check.

   When genuinely unsure between two tiers, say so in the issue body rather than guessing — but
   still pick one label, since the hook requires exactly one. **`Sonnet` and `Opus` require an
   explicit escalation reason** — `--escalation-reason` on the CLI, `escalation_reason` in the
   MCP `issue_write` input — before `hooks/lib/check_model_label_on_issue_create.ts`
   (`ESCALATION_LABELS`, web-jam-tools#709 "Guard denies issue-create carrying Sonnet/Opus model
   label without an explicit escalation justification") lets the create through. The hook only
   checks that the field is non-empty and deliberately never judges what it says, so the reason
   must do the work the hook can't: say **why the tier above the one you chose is not needed**,
   not merely why the chosen tier is plausible.
3. **Draft acceptance criteria that let the issue CLOSE (Epics close when children close).**
   Concrete, checkable conditions — not a standing tracker that never resolves. A non-epic closes
   when its work is done; **an epic closes when its children close** (epics are not implementable
   themselves, but close when all child issues complete). Perpetual trackers remain banned. If the
   work is genuinely open-ended, scope the issue to one concrete step and file a follow-up for the next
   one rather than leaving it perpetually open.
4. **Executable Issue rule (Every non-Epic issue must stand alone).** Every issue body not typed
   `Epic` must stand alone without unresolvable pointer phrases (e.g., "see the comment", "see comment",
   "read the comment first", "read comment first", "as discussed above", "as discussed in",
   "per the discussion", "in the epic", "see the epic"). Anyone (human or AI model) picking up an
   issue must be able to execute it directly from the issue body without hunting through issue
   comments or parent epic threads for requirements. Sub-issues derived from an Epic must have their
   full requirements authored directly in the sub-issue body first before creation. Note: Native issue
   type `Epic` (which is orthogonal to model labels) is exempt from this check on edit paths (`gh issue edit`
   or MCP update), allowing Epics to reference comments or sub-issues as discussion evolves.
5. **Require Native Issue Type via MCP or `create-issue.ts`.** Every new issue creation MUST explicitly specify a
   valid native GitHub issue type (`Task`, `Bug`, `Feature`, `Epic`) using `scripts/create-issue.ts --type <Type>`
   or `"type": "<Type>"` in the GitHub MCP `issue_write` create path. Note: `gh issue create` in `gh` CLI 2.92.0 has no `--type` flag; do NOT attempt `gh issue create --type`. Native issue types are enforced by
   `hooks/require-model-label-on-issue-create.sh` (web-jam-tools#415).
6. **Apply `Needs Design` Label when Design is Required.** For Epics or sub-issues requiring design
   clarification before implementation, apply the canonical `Needs Design` status label alongside the chosen
   model label and native type.
7. **Closed Issues Are Immutable.** Never modify, reopen, add comments to, or add new requirements to a closed GitHub issue. Closed issues represent finished state. When new scope, follow-up findings, or modifications arise for a closed issue, file a net-new issue citing the closed issue (repo + number + title) instead.
8. **Prompt for a Milestone Before Filing.** Check the repo's open Milestones (`gh api repos/WebJamApps/<repo>/milestones` or `gh milestone list`) before creating the issue. Select one deliberately if a fitting Milestone exists. If no open Milestone fits the issue, explicitly note so in chat or in the issue body ("no fitting milestone — leaving unassigned") rather than silently omitting it. Note: This is a skill-level nudge, not a hook gate — `hooks/require-model-label-on-issue-create.sh` continues to enforce model label + native Type.
9. **Deliverable-First Body Shape (What this builds).** Open the issue body directly with a section
   titled `## What this builds` carrying a 1-2 sentence description of what is being built, immediately
   followed by a numbered list of what it does — no history preamble, conversation background, or past context.
10. **Set Native Priority Field via MCP, Never via `gh`.** Set the native `Priority` field (`Urgent`,
    `High`, `Medium`, `Low`) via GitHub MCP `issue_write` → `issue_fields` (or `set_issue_field`, or `scripts/create-issue.ts --priority <Level>`). `gh`
    CLI cannot set native GitHub project fields; never attempt to set native Priority via bare `gh`.
11. **Require a `## How to test locally` Section.** Every issue body filed must include a `## How to test locally` section sitting between `## What this builds` and `## Acceptance criteria`:
    - Carries the exact commands with their working directory and expected result, plus the one check that exercises the change itself rather than merely running the suite.
    - Pure documentation issues are exempt (a pure documentation issue changes prose and nothing else: `docs/`, a README, or a comment block; note that a `SKILL.md` change does NOT qualify as pure documentation because skill bodies are behaviour and tested in CI).
    - Issues labeled `Josh` carry no testing section at all, as no PR is opened for them.
12. **Name Files Changed & State Non-Goals.**
    - **Name files changed:** Every issue body must name the actual files it changes, verified to exist during the filing run rather than guessed, so the implementing agent starts at the edit instead of at an exploratory search. Where the exact file cannot be known ahead of time, say so plainly and name where to start looking.
    - **State non-goals:** Every issue body must state its non-goals — what is deliberately not touched, what is not refactored, and what is left alone to avoid scope widening.
13. **Carry Repo Dependency & Vulnerability Audit Report.**
    - Audit each target repo once during a design run (outdated packages, runtime version, known vulnerabilities) using the repo's own tooling (`scripts/audit.sh` and `scripts/sast.sh` where they exist).
    - Every issue body carries a short dated summary report of what the audit found for that repo (counts, vulnerabilities, and each major upgrade named).
    - Minor and patch fixes are encouraged to be done directly in the working pull request (`npm audit fix` in Node repos or minor/patch `deno outdated --update` in Deno repos).
    - Major upgrades are the exception and are NEVER done inline in a feature PR: each major upgrade must be flagged in the report as belonging in its own follow-on issue so it can be scheduled, labeled, and tested independently.
    - Runtime upgrades must be LTS only, without exception (e.g. Node/Deno LTS releases only).
    - Any vulnerability or upgrade implicated by the issue's own edited files is addressed directly in that work.
14. **Hook and Skill Issues Must Target Both Claude Code and agy/Antigravity.**
    - Any issue about a **hook** (a script under `hooks/`) or a **skill** (a directory under `skills/`) must declare it targets **both** agent surfaces — Claude Code and agy/Antigravity — unless Josh has explicitly approved a single-surface exception for that specific issue *in this filing session*, with approval recorded in the issue body.
    - **Surfaces must be named in `## What this builds`.** The section opening the body must state what is being built for each surface, not just once for both (e.g. not "updates the hook" but "updates the hook in Claude Code and adds the agy variant").
    - **Structural change: one acceptance criterion per surface, naming the installer.** A new, renamed, or deleted skill or hook, or an existing hook whose event or matcher registration changed, requires an installer to reach either surface. A brand-new `hooks/lib/*.ts` module consumed by an already-installed hook is **not** a new hook under this bullet — see the content-only bullet below. The `## Acceptance criteria` section must carry a separate, distinct criterion checking each surface: Claude Code (`scripts/install-hooks.sh` for hooks; `scripts/install-skills.ts` for skills) and agy (`scripts/install-hooks.sh` on agy side; same for skills). `## How to test locally` must name both `scripts/install-hooks.sh` and `scripts/install-skills.ts` as part of the verification steps, so the implementing agent installs and checks both surfaces rather than one.
    - **Content-only change: one acceptance criterion per surface, naming the resolution check, not an installer.** A content-only change to a file that is already installed — a skill body, a new or existing supporting file inside an already-installed skill directory (e.g. adding `skills/fix-labels/labels.yaml` to the already-installed `fix-labels` skill), a hook script's contents, or a new or existing shared `hooks/lib/*.ts` module consumed by an already-installed hook — needs no installer: `git pull` on `dev` makes it live on both surfaces (see `docs/scripts.md` for the mechanism; do not restate it here). For a **skill**, `~/.claude/skills/<skill>` and `~/.gemini/config/plugins/webjam-tasks/skills/<skill>` are two genuinely distinct symlinks, so the `## Acceptance criteria` section asserts, per surface, that the installed symlink still resolves into the canonical clone. For a **hook or a `hooks/lib/*.ts` module**, there is only one hook symlink (`~/.claude/hooks/<hook>.sh`) — agy reaches it through that same Claude Code symlink via `hooks/agy-hook-shim.sh`, not a second symlink of its own — so the two per-surface criteria must NOT be the same assertion written twice: the Claude Code criterion asserts `~/.claude/hooks/<hook>.sh` resolves into the canonical clone, and the agy criterion asserts that `~/.gemini/config/hooks.json`'s shim registration still targets that same `$HOME/.claude/hooks/` path — that registration, not a second symlink, is what makes the agy criterion distinct. `## How to test locally` names that resolution check rather than an installer.
    - **Never assert a `~/.claude/hooks/lib/` path.** `hooks/lib/` is never installed by `scripts/install-hooks.sh`, so that path does not exist and never has. No acceptance criterion, for either change kind, may claim a file resolves there.
15. **A Guard Has Three Outcomes, Not Two.**
    - Every issue that designs, modifies, or implements a guard, gate, permission check, or validation rule must explicitly specify all three outcomes:
      1. When the condition holds (e.g. valid, permitted, or matched).
      2. When the condition does not hold (e.g. invalid, denied, or unmatched).
      3. When the deliverable is unable to determine which of the first two applies because the lookup errors, the API times out, the file is missing, or the field is absent.
    - For that third case, the issue specification and acceptance criteria must explicitly use the vocabulary of whether the system **refuses** (fails closed) or **proceeds** (fails open).
    - **Model Tier Floor**: Any issue where a guarded condition is sourced from a network call, a filesystem read, or any source that can fail independently of the input being guarded has a `Sonnet` floor. This is a minimum floor, not a ceiling: if the guard requires adversarial correctness against subtle bypasses or complex tech-lead judgment, the `Opus` routing in item 2 continues to apply on its own terms.
16. **Guardrail and Rules Edits Must Be Purely Additive.**
    - Edits to shared guardrails, rules, or skill instructions in `AGENTS.md`, `docs/cross-ai-rules.md`, or a skill body (`skills/*/SKILL.md`) must be **purely additive** unless the issue explicitly specifies the retirement, replacement, or deletion of existing rules.
    - Pre-existing rule bullets, rationale, and instructions must never be silently removed, truncated, or clobbered when appending new guidelines.
    - The issue's `## Acceptance criteria` and `## How to test locally` sections must include a named check that proves it (e.g. running `git diff origin/dev -- <file>` to verify that the diff contains no removed lines other than explicitly targeted edits).

## Citation format (every reference, every time)

Every issue or PR the body mentions — first mention, tenth mention, a parenthetical, a "blocked by"
note, a "related to" aside — gets **repo + number + title**, no exceptions:

```
web-jam-tools#263 "/fix-labels reports success while leaving real drift behind — the schema diff is
eyeballed, not computed"
```

A bare `#263` or `wjt#263` is wrong even mid-sentence, even in a list where the previous line
already named it. If you don't know the title, look it up before writing the sentence:

```sh
gh issue view 263 --repo WebJamApps/<repo> --json title -q .title
gh pr view 263 --repo WebJamApps/<repo> --json title -q .title
```

## How to file it

Always use `scripts/create-issue.ts` (or `deno task create-issue`):

```sh
deno task create-issue \
  --repo WebJamApps/<repo> \
  --title "Short, specific title" \
  --body-file /path/to/body.md \
  --type Task \
  --label Sonnet \
  --milestone "v1.2" \
  --priority High \
  --parent 437 \
  --blocked-by 436
```

`scripts/create-issue.ts` standardizes issue creation across all repos:
- Sets labels, milestone, native issue Type (`Task`, `Bug`, `Feature`, `Epic`), native Priority (`Urgent`, `High`, `Medium`, `Low`), attaches the parent issue link (`--parent <num>`) via GraphQL `addSubIssue`, and registers native dependencies (`--blocked-by <num>`) via `dependencies/blocked_by`.
- Re-reads the created issue afterwards and verifies all requested attributes stick (exits non-zero if any attribute failed to stick).
- Prints the formatted issue on success as `repo#number "title"`.

- Require native type (`Task`, `Bug`, `Feature`, `Epic`) via `scripts/create-issue.ts --type <Type>` or GitHub MCP `issue_write` (`"type": "<Type>"`).
- Specify `--milestone "<name>"` when an open repo Milestone matches the scope. If no open Milestone fits, explicitly note "no fitting milestone — leaving unassigned" in chat or body.
- Exactly **one** label from the six model labels above — the hook denies zero or two-plus.
- For `Sonnet` or `Opus`, also supply `--escalation-reason "<why the tier above is not needed>"`
  (CLI) or `escalation_reason: "<...>"` (MCP `issue_write`) — on Claude Code,
  `hooks/lib/check_model_label_on_issue_create.ts` denies the create without it
  (`ESCALATION_LABELS`, web-jam-tools#709 "Guard denies issue-create carrying Sonnet/Opus model
  label without an explicit escalation justification"). On agy/Antigravity, `deno task
  create-issue` has no hook mechanism of its own — `src/create-issue/lib.ts`'s `parseArgs` only
  reads the flag into `options.escalationReason` and `createIssueAndVerify()` never validates it,
  so this field is unguarded on that path. Wherever it is checked, the reason must compare against
  the tier above, not just justify the tier chosen.
- Set dependencies natively: When an issue depends on another GitHub issue, set native GitHub `blocked_by` dependencies via `--blocked-by <issue>` (e.g. `scripts/create-issue.ts --blocked-by <issue_num>`) ONLY and do NOT add the `Blocked` label (native dependencies clear automatically on close). Note: A `--blocked-by` value that matches the issue's parent or ancestor is refused at parse time.
- Add non-model status labels (`Needs Design`, `Josh`, `parked`, ...) alongside the model label freely; the hook only checks that exactly one *model* label is present, not that it's the only label. Apply the `Blocked` label ONLY for external, non-GitHub blockers (credentials, vendor delays, assets from Josh, physical prerequisites; web-jam-tools#725).
- Set native `Priority` field (`Urgent`, `High`, `Medium`, `Low`) via `scripts/create-issue.ts --priority <Level>`.
- Attach parent issue link via `scripts/create-issue.ts --parent <parent_issue_number>`.

## If the hook denies the call

The denial message names what's wrong (missing/invalid native issue type, no model label,
multiple model labels, unresolvable pointer phrases, or unparseable command) and lists valid native
types or model labels straight from `skills/fix-labels/model-labels.json`. Fix the `--type` and
`--label` flags (or the MCP `type` and `labels` fields) per the message and retry — there is no
bypass, and there shouldn't be one: the hook exists to enforce executable, properly categorized issues.

## Consumed rules

### artifacts-must-be-traceable-to-decisions

**STRICT (Josh, 2026-07-29):** *"you must provide accurate issues, titles, PR descriptions everything must be tracable to the agreed upon requirements and decisions I make !"*

Every artifact Josh reads — issue **title AND body**, PR **title AND description**, issue comments — must accurately state the CURRENT agreed design, and every claim in it must be traceable to a requirement or decision he actually made.

**Why:** the issue body is what gets read as the spec — by Josh, and by every subagent dispatched off it. When a design changes and only the title (or only a trailing comment) is updated, the body silently keeps specifying the OLD design, and the next agent implements the wrong thing. A stale body is a live defect, not a cosmetic wart. It also breaks his ability to audit what he approved: if the artifact doesn't match his decision, he cannot tell whether the decision was misunderstood or the artifact is just old.

**How to apply:**
- When a design decision changes, **rewrite the issue BODY in the same turn** — not just the title, not just an appended comment. Same for the PR description. An amendment comment is a supplement, never the fix.
- Never leave a decision recorded only in chat. If Josh decides it, it goes into the issue/PR where the work happens.
- Don't state a design claim the requirements don't support. If something was never verified, label it unverified — see web-jam-tools#305 "cross-ai-rules.md: design claims must carry receipts, and a UI requirement can never be verified through an API".
- Cite every issue/PR as `repo#number "title"` so he can trace it — see the issue citation rule in docs/cross-ai-rules.md.
- Before handing an issue to a subagent, re-read its body and confirm it matches the current decision; if it doesn't, fix the body FIRST, then dispatch.

**Origin (2026-07-29, the milestone migration):** the design moved topics from a native `Area` issue field to Milestones. Opus amended the design via a comment and renamed WebJamApps/web-jam-tools#301, but left the issue BODY still specifying "read the native `Area` field" with `field.Area:` search qualifiers and an acceptance criterion "correctly derives Area from the native Area field". Josh: *"we decided on Milestone this is NOT ACCURATE !"* The body was then rewritten. Same session, same root defect: relying on a supplement instead of correcting the source.

