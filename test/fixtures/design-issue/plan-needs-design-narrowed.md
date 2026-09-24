# Sample Gate 2 plan for `deno task design:lint-plan` — a narrowed Needs Design removal

## Plan

| # | Proposed title                            | Epic / child of | Model tier | Priority | Repo          | Tests                                                 | Closes when   |
| - | ----------------------------------------- | --------------- | ---------- | -------- | ------------- | ----------------------------------------------------- | ------------- |
| 1 | record-song: build the REAPER setup skill | -               | Opus       | High     | web-jam-tools | A run against a saved session restores its track list | the PR merges |

## Needs Design label removals

1. web-jam-tools#485 "new skill record-song" — the design's REAPER control section defines the
   skill, and row 1 builds and proves it. Not resolved: "setup things based on previous recordings"
   is limited to the know-how list the design names (input indices, track layout, 48 kHz 24-bit
   takes, ffmpeg mixes). Remove the label?
