export const OUTCOME_WORDING_DESIGN_DOC = `
# Outcome Wording Design Fixture

### Priority Levels

Priority levels requirements here.

### Waiting on someone outside GitHub

Waiting requirements here.
`;

export interface OutcomeWordingCase {
  name: string;
  criterion: string;
  labels: string[];
  isEpic?: boolean;
  namesDesign?: boolean;
  unreadableDesign?: boolean;
  expectedOutcomeWord?: string;
}

/**
 * All 15 rows from "Appendix D — Case Lists" -> "Outcome wording in a criterion"
 * (design-issue-file-issue-design-2026-08-23.md, revision 2.22.0).
 */
export const OUTCOME_WORDING_CASES: OutcomeWordingCase[] = [
  {
    name: 'case 01: builds "Priority Levels" as written -> pass',
    criterion: '- [ ] builds "Priority Levels" as written',
    labels: ["Sol"],
  },
  {
    name: 'case 02: builds "Waiting on someone outside GitHub" + backtick command -> pass',
    criterion:
      '- [ ] builds "Waiting on someone outside GitHub" as written; `deno task test` passes',
    labels: ["Sol"],
  },
  {
    name: "case 03: three outcomes + missing section is refused -> refused",
    criterion:
      "- [ ] the check has all three outcomes: a section reading none passes; a missing section is refused",
    labels: ["Sol"],
    expectedOutcomeWord: "outcomes",
  },
  {
    name: "case 04: outcomes + cannot tell + refuses -> refused",
    criterion:
      "- [ ] the ranking has all three outcomes: when the snapshot cannot tell an issue's level the check refuses to propose a move for it",
    labels: ["Sol"],
    expectedOutcomeWord: "outcomes",
  },
  {
    name: 'case 05: refuse outside quotes in "Priority Levels" criterion -> refused',
    criterion:
      '- [ ] One test per row of the table in "Priority Levels" asserts that row\'s result (allow, or refuse by the named guard)',
    labels: ["Sol"],
    expectedOutcomeWord: "refuse",
  },
  {
    name: 'case 06: One test per row of "Priority Levels" asserts result -> pass',
    criterion:
      '- [ ] One test per row of the table in "Priority Levels" asserts that row\'s result',
    labels: ["Sol"],
  },
  {
    name: "case 07: refuses sits outside the backticks -> refused",
    criterion: "- [ ] `deno task design:lint-plan plan.md` refuses the plan",
    labels: ["Sol"],
    expectedOutcomeWord: "refuses",
  },
  {
    name: "case 08: --refuse-empty inside backticks -> pass",
    criterion: "- [ ] `deno task design:lint-plan --refuse-empty plan.md` exits 0",
    labels: ["Sol"],
  },
  {
    name: "case 09: Fails Closed in any capitalisation -> refused",
    criterion: "- [ ] The check Fails Closed when the design cannot be read",
    labels: ["Sol"],
    expectedOutcomeWord: "Fails Closed",
  },
  {
    name: "case 10: Proceeding begins with proceed -> refused",
    criterion: '- [ ] Proceeding with "Priority Levels" is tested',
    labels: ["Sol"],
    expectedOutcomeWord: "Proceeding",
  },
  {
    name: "case 11: unrefused does not begin with refuse -> pass",
    criterion: '- [ ] the unrefused rows keep their level, per "Priority Levels"',
    labels: ["Sol"],
  },
  {
    name: "case 12: Josh confirms the reminder proceeds on Josh-labeled item -> pass (not checked)",
    criterion: "- [ ] Josh confirms the reminder proceeds",
    labels: ["Josh"],
  },
  {
    name: "case 13: Closes when all child sub-issues close on epic item -> pass (not checked)",
    criterion: "- [ ] Closes when all child sub-issues close",
    labels: ["Opus"],
    isEpic: true,
  },
  {
    name:
      "case 14: the guard refuses a missing section in body naming no design -> pass for this check",
    criterion: "- [ ] the guard refuses a missing section",
    labels: ["Sol"],
    namesDesign: false,
  },
  {
    name: "case 15: A body whose design cannot be read -> refused before first issue, naming path",
    criterion: '- [ ] builds "Priority Levels" as written',
    labels: ["Sol"],
    unreadableDesign: true,
  },
];
