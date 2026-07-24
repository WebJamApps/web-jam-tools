# Local-testing recipes (shared, single-sourced)

**Status: SCAFFOLD.** This file currently holds **zero recipes**. It exists so
the *structure* and the *process* are settled before any content is added —
content accrues later, one dispatch at a time, per the design below. Do not
add a recipe here by guessing at commands; an invented recipe is worse than
no recipe (a developer who trusts a fabricated step wastes more time than one
told nothing exists yet).

## Why this file exists (web-jam-tools#235)

Each frontend repo's PRs include a "How to test locally" section. Flash (the
model that authors most of those PRs) used to write that section by
restating what it changed in the diff, because that's the only thing it
actually knew — it had neither the **operational run recipe** (start
WebJamSocketCluster, start the frontend, how they wire together) nor **how to
deliberately induce an error condition** (e.g. point a mongo env var at a bad
value, then restore it). That knowledge lives in Josh's head and the
runtime, not in any diff, and Flash cannot safely invent it.

The fix: bank that knowledge once, in a doc, and hand Flash the doc instead
of asking it to invent the recipe. This file is the **shared half** of that
doc split (see `docs/local-testing.md` convention below for the other half).
`scripts/handle-agy-tasks.sh` reads both and injects them into the composed
dispatch prompt so Flash writes real steps drawn from real material.

## The two-doc split (no duplication)

- **Per-repo doc** — `docs/local-testing.md` in each frontend repo (e.g.
  `JaMmusic/docs/local-testing.md`). Repo-specific *UI* run steps,
  discoverable where devs in that repo actually work. It **references** this
  shared doc for anything common instead of duplicating it — mention the
  filename `local-testing-recipes.md` somewhere in the per-repo doc (a plain
  markdown link is fine) so `handle-agy-tasks.sh`'s simple text-match can
  find the reference and pull this file's content in alongside it.
- **This file** — the common backend/error-induction recipes that are the
  same regardless of which frontend is being tested (starting
  WebJamSocketCluster, inducing a mongo error, inducing a socket error, and
  so on), single-sourced here so every per-repo doc stays in sync by
  reference instead of drifting copies.

## How a recipe gets added (Opus judgment, Flash's hands)

Per the locked design in web-jam-tools#235:

1. Before dispatching a Flash task (headless path), Opus checks whether this
   file (plus the target repo's `docs/local-testing.md`) already covers what
   the feature being dispatched needs to test.
2. If there's a gap, Opus fills it **at dispatch time** — pulling the
   operational trick from Josh when Opus doesn't already know it — and
   supplies the recipe text to `handle-agy-tasks.sh` (e.g. via the
   `AGY_EXTRA_RECIPE` env var) for that one run, so the run is never blocked
   waiting on a doc PR to land first.
3. Flash's dispatch prompt instructs it to commit that recipe text into this
   file as a **second, docs-only web-jam-tools PR** in the same run (the
   per-repo half, if any, rides inside its own frontend feature PR instead).
   Flash commits; it does not invent.
4. Once merged, the recipe is here for every future run to reuse — the
   expensive knowledge is banked once, not re-derived per PR.

Interactive agy runs (Josh launches agy himself) get no dispatch-time gate —
they free-ride on whatever has accumulated here already, and quietly improve
as this file grows.

## Recipe entry format

Each recipe added here should follow this shape so `handle-agy-tasks.sh`'s
injected material reads consistently:

```markdown
## <Recipe name, e.g. "Start WebJamSocketCluster locally">

**When to use:** <what a developer is trying to do that needs this recipe>

**Steps:**
1. ...
2. ...

**How to induce the error condition (if this recipe is for reproducing a
failure mode):**
1. ...

**How to restore normal operation:**
1. ...
```

Omit the induce/restore subsections for recipes that are just "how to run
X locally" with no error condition involved.

## Recipes

_(none yet — see "How a recipe gets added" above)_
