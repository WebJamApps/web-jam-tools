const first = "~/Dropbox/web-jam-llms/promote-gigs/promote-gigs-design-2026-10-11.md";
const second = "~/Dropbox/web-jam-llms/Operations/nodejs-deno-upgrades-design-2026-08-15.md";
export const DESIGN_BODY_CASES = [
  { name: "one path", body: first, refused: false },
  { name: "same path twice", body: `${first}\n${first}`, refused: false },
  { name: "bare filename", body: `${first} hooks-design-2026-09-15.md`, refused: false },
  { name: "no design path", body: "No design behind this issue.", refused: false },
  { name: "two paths", body: `${first}\n${second}`, refused: true },
  {
    name: "tilde and home paths",
    body: `${first}\n${second.replace("~", Deno.env.get("HOME") || "/home/joshua")}`,
    refused: true,
  },
  {
    name: "runbook",
    body: `${first}\n~/Dropbox/web-jam-llms/promote-gigs/a-runbook.md`,
    refused: false,
  },
];
export const DESIGN_EDIT_CASES = [
  { name: "same two", old: `${first}\n${second}`, body: `${first}\n${second}`, refused: false },
  { name: "two to one", old: `${first}\n${second}`, body: first, refused: false },
  { name: "one to two", old: first, body: `${first}\n${second}`, refused: true },
  {
    name: "two to three",
    old: `${first}\n${second}`,
    body: `${first}\n${second}\n~/Dropbox/web-jam-llms/Hooks/hooks-design.md`,
    refused: true,
  },
];
