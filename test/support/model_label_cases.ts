/** Literal cases from "Model-label cases" in the tier-order design. */
export const MODEL_LABEL_NAMES = [
  "Argon",
  "Astra",
  "Fable",
  "Haiku",
  "Hydrogen",
  "Luna",
  "Neon",
  "Opus",
  "Sol",
  "Sonnet",
  "Terra",
];
export const ESCALATION_REASON = "Josh chose Fable for the open case list";
export const MODEL_LABEL_CASES: Array<{
  labels: string[];
  reason?: string;
  error?: string;
}> = [
  { labels: ["Terra"] },
  { labels: ["Sol"] },
  { labels: ["Sonnet"] },
  { labels: ["Argon"] },
  { labels: ["Hydrogen"] },
  { labels: ["Terra", "Sonnet"] },
  { labels: ["Sonnet", "Terra"] },
  { labels: ["Sol", "Argon"], error: "forbidden model-label combination" },
  { labels: ["Sol", "Hydrogen"], error: "forbidden model-label combination" },
  { labels: ["Argon", "Hydrogen"] },
  { labels: ["Sol", "Argon", "Hydrogen"], error: "forbidden model-label combination" },
  { labels: ["Hydrogen", "Argon", "Sol"], error: "forbidden model-label combination" },
  { labels: ["Sonnet", "Sonnet"] },
  { labels: ["Sonnet"], reason: "   " },
  { labels: ["Flash"], error: "no model label" },
  { labels: ["Opus"] },
  { labels: ["Neon"] },
  { labels: ["Opus"], reason: "   " },
  { labels: ["Fable"], error: "Fable needs an escalation reason" },
  { labels: ["Fable"], reason: "x" },
  { labels: ["Opus", "Fable"], reason: "x" },
  { labels: ["Fable", "Opus"], error: "Fable needs an escalation reason" },
  { labels: ["Fable", "Sonnet"], reason: "x" },
  { labels: ["Fable", "Josh"], reason: "x" },
  { labels: ["fable"], reason: "x", error: "no model label" },
  { labels: ["Needs Design", "Opus"], reason: "closed case list is unavailable" },
  {
    labels: ["Sonnet", "Sol"],
    reason: "x",
    error: "forbidden model-label combination",
  },
  {
    labels: ["Terra", "Hydrogen"],
    reason: "x",
    error: "forbidden model-label combination",
  },
  { labels: ["Sol", "Opus"] },
  {
    labels: ["Argon", "Astra"],
    reason: "x",
    error: "forbidden model-label combination",
  },
  {
    labels: ["Sonnet", "Sol", "Opus"],
    reason: "x",
    error: "forbidden model-label combination",
  },
  { labels: [], error: "no model label" },
  { labels: ["Josh"] },
  { labels: ["Sonnet / Sol"], error: "no model label" },
  { labels: ["sonnet"], error: "no model label" },
  { labels: ["Bogus"], error: "no model label" },
];
