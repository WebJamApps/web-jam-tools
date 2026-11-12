/** Literal label-check cases from the approved design's Appendix D. */
export const MODEL_LABEL_NAMES = [
  "Astra",
  "Fable",
  "Flash",
  "Haiku",
  "Luna",
  "Opus",
  "Sol",
  "Sonnet",
];
export const ESCALATION_REASON = "Opus is not needed: the case list is closed";
export const MODEL_LABEL_CASES: Array<{
  labels: string[];
  reason?: string;
  error?: string;
}> = [
  { labels: ["Flash"] },
  { labels: ["Sol"] },
  { labels: ["Sonnet"], reason: ESCALATION_REASON },
  { labels: ["Sonnet"], error: "Sonnet needs an escalation reason" },
  { labels: ["Sonnet"], reason: "   ", error: "Sonnet needs an escalation reason" },
  { labels: ["Opus"], error: "Opus needs an escalation reason" },
  { labels: ["Sonnet", "Sol"], reason: ESCALATION_REASON },
  { labels: ["Sol", "Sonnet"], reason: ESCALATION_REASON },
  { labels: ["Sonnet", "Sol"], error: "Sonnet needs an escalation reason" },
  {
    labels: ["Sonnet", "Flash"],
    reason: "x",
    error: "a second model label outside the allowed pair",
  },
  { labels: ["Sol", "Opus"], reason: "x", error: "a second model label outside the allowed pair" },
  {
    labels: ["Sonnet", "Sol", "Opus"],
    reason: "x",
    error: "a second model label outside the allowed pair",
  },
  { labels: ["Sonnet", "Sonnet"], reason: "x" },
  { labels: [], error: "no model label" },
  { labels: ["Josh"] },
  { labels: ["Needs Design", "Opus"], reason: "x" },
  { labels: ["Sonnet / Sol"], reason: "x", error: "no model label" },
  { labels: ["sonnet"], reason: "x", error: "no model label" },
];
