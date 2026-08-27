# Sample design doc for manual `deno task design:lint-plan` verification

## Phase 2 — The Issue Plan

| #  | Proposed title                                                        | Epic / child of | Model tier | Priority | Repo          | Tests                                     | Closes when                                                         |
| -- | --------------------------------------------------------------------- | --------------- | ---------- | -------- | ------------- | ----------------------------------------- | ------------------------------------------------------------------- |
| 1  | Fix plan-table validation gaps                                        | -               | Opus       | High     | web-jam-tools | Unit tests covering every validator rule  | all children close                                                  |
| 2  | Add cell validators for design:lint-plan                              | Epic #1         |            | High     | web-jam-tools | Unit tests, one per acceptance criterion  | PR merges                                                           |
| 3  | Add repo normalization                                                | Epic #1         | Flash-High | High     | web-jam-tools | Unit tests exercising repo normalization  | PR merges                                                           |
| 4  | Add tier normalization                                                | Epic #1         | Flash High | High     | NotARealRepo  | Unit tests exercising tier normalization  | PR merges                                                           |
| 5  | Josh: review the validator output                                     | Epic #1         | Flash High | High     | web-jam-tools | Unit tests exercising the review output   | PR merges                                                           |
| 6  | Add priority validation                                               | Epic #1         | Flash High | Critical | web-jam-tools | Unit tests exercising priority validation | PR merges                                                           |
| 7  | Manual verification: confirm output                                   | Epic #9         | Josh       | Medium   | web-jam-tools | none                                      | Josh confirms he ran it                                             |
| 8  | Manual verification: verify shoelace reference guide in Google Chrome | Epic #1         | Josh       | Medium   | web-jam-tools | none                                      | Josh confirms he reviewed and taught the shoelace-tying walkthrough |
| 9  | Add cross-repo child example                                          | Epic #1         | Flash High | High     | JaMmusic      | Unit tests exercising the cross-repo case | PR merges                                                           |
| 10 | Add Tests-cell validation                                             | Epic #1         | Flash High | High     | web-jam-tools | yes                                       | PR merges                                                           |
