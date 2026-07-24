---
name: fix-labels
description: Recurring GitHub issue-label drift-detector across the 8 active WebJamApps repos. Compares each repo's current labels against a fixed canonical schema baked into this file, reports drift (missing / misnamed / miscolored / wrong-repo / non-canonical) with blast radius per label, waits for Josh's per-item approval, then applies only what he approved. Manual only — `/fix-labels`, never auto-runs. Interactive, hard-gated to Haiku (same pattern as handle-gmails), does NOT dispatch a subagent. A clean workspace reports "no changes"; re-run anytime to catch drift that accumulates over time.
---

# fix-labels — canonical GitHub label drift-detector

Scaffold — full content lands in the next commit on this branch (issue #233).
