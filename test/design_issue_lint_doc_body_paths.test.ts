// test/design_issue_lint_doc_body_paths.test.ts — web-jam-tools#1447
//
// Unit tests for the body-path check ("Paths the design names") covering every Appendix D case
// for body paths missing from "Where Things Live".

import { assertEquals, assertStringIncludes } from "@std/assert";
import { lintDesignDoc } from "../src/design-issue/lint_doc.ts";

const TODAY = new Date().toISOString().slice(0, 10);

function buildDoc(options: {
  body?: string;
  whereThingsLive?: string | null;
  premises?: string;
  appendix?: string;
  revisionExtraRow?: string;
}): string {
  const premises = options.premises ??
    `| The runner exists | Verified | ${TODAY} |`;
  const whereSection = options.whereThingsLive === null
    ? ""
    : `\n## Where Things Live\n\n${options.whereThingsLive ?? ""}\n`;
  const appendixSection = options.appendix ? `\n## Appendix — Extra\n\n${options.appendix}\n` : "";
  const extraRevRow = options.revisionExtraRow ? `\n${options.revisionExtraRow}` : "";

  return `# Test Feature Design

## Revision History

| Version | Date | Summary |
|---|---|---|
| 1.0.0 | ${TODAY} | Initial design |${extraRevRow}

## What it is

${options.body ?? "A small test design."}

## Both surfaces

| Mechanism | Claude Code | agy | Codex |
|---|---|---|---|
| Check | lint_doc | identical | identical |

## Load-bearing premises

| Premise | Proof | Proved |
|---|---|---|
${premises}
${whereSection}${appendixSection}`;
}

Deno.test("body paths case 1: exact path listed in Where Things Live passes", () => {
  const doc = buildDoc({
    body: "the log is `/var/log/ubuntu-health.log`.",
    whereThingsLive: "- `/var/log/ubuntu-health.log` — the weekly job's log",
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("body paths case 2: path missing from Where Things Live fails with line number and path", () => {
  const doc = buildDoc({
    body: "the log is `/var/log/ubuntu-health.log`.",
    whereThingsLive: "- `/etc/ubuntu-health/other.conf` — unrelated config",
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);
  const violations = result.violations.filter((v) =>
    v.rule === "body-path-missing-from-where-things-live"
  );
  assertEquals(violations.length, 1);
  const expectedLine = doc.split("\n").findIndex((l) => l.includes("/var/log/ubuntu-health.log")) +
    1;
  assertEquals(violations[0].line, expectedLine);
  assertStringIncludes(violations[0].message, String(expectedLine));
  assertStringIncludes(violations[0].message, "/var/log/ubuntu-health.log");
});

Deno.test("body paths case 3: directory with trailing slash covers child file", () => {
  const doc = buildDoc({
    body: "Runs `/usr/local/lib/ubuntu-health/weekly.sh` each week.",
    whereThingsLive: "- `/usr/local/lib/ubuntu-health/` — runtime scripts",
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("body paths case 4: trailing-slash normalization matches folder without trailing slash", () => {
  const doc = buildDoc({
    body: "Stored under `/usr/local/lib/ubuntu-health/`.",
    whereThingsLive: "- `/usr/local/lib/ubuntu-health` — script directory",
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("body paths case 5: home-relative directory with trailing slash passes", () => {
  const doc = buildDoc({
    body: "Designs live in `~/Dropbox/web-jam-llms/Operations/`.",
    whereThingsLive: "- `~/Dropbox/web-jam-llms/Operations/` — operations designs",
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("body paths case 6: path only in Load-bearing Premises table passes", () => {
  const doc = buildDoc({
    body: "No runtime path in the body.",
    premises: "| WSL settings exist in `/etc/wsl.conf` | Checked | " + TODAY + " |",
    whereThingsLive: "",
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("body paths case 7: path only inside fenced code block passes", () => {
  const doc = buildDoc({
    body: "```bash\ncat /etc/wsl.conf\n```\nAlso inline fence mention:\n```\n`/etc/wsl.conf`\n```",
    whereThingsLive: "",
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("body paths case 8: body path without Where Things Live heading fails", () => {
  const doc = buildDoc({
    body: "Reads `/etc/wsl.conf` on startup.",
    whereThingsLive: null,
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);
  const violations = result.violations.filter((v) =>
    v.rule === "body-path-missing-from-where-things-live"
  );
  assertEquals(violations.length, 1);
  const expectedLine = doc.split("\n").findIndex((l) => l.includes("/etc/wsl.conf")) + 1;
  assertEquals(violations[0].line, expectedLine);
  assertStringIncludes(violations[0].message, String(expectedLine));
  assertStringIncludes(violations[0].message, "/etc/wsl.conf");
});

Deno.test("body paths case 9: no Where Things Live heading and no body paths passes", () => {
  const doc = buildDoc({
    body: "Pure behavioral specification without file paths.",
    whereThingsLive: null,
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("body paths case 10: flags only uncovered path when another path is covered", () => {
  const doc = buildDoc({
    body: "Reads `/etc/a/x` and writes `/etc/b/y`.",
    whereThingsLive: "- `/etc/a/` — directory a",
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);
  const violations = result.violations.filter((v) =>
    v.rule === "body-path-missing-from-where-things-live"
  );
  assertEquals(violations.length, 1);
  assertStringIncludes(violations[0].message, "/etc/b/y");
});

Deno.test("body paths case 11: exact config file path in Where Things Live passes", () => {
  const doc = buildDoc({
    body: "Credentials live in `/etc/ubuntu-health/gmail-send.env`.",
    whereThingsLive: "- `/etc/ubuntu-health/gmail-send.env` — SMTP environment file",
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("body paths case 12: token containing space outside angle placeholder is ignored", () => {
  const doc = buildDoc({
    body: "Not a path token: `/etc/a b/c`.",
    whereThingsLive: null,
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("body paths case 13: single-segment slash command `/design-issue` is ignored", () => {
  const doc = buildDoc({
    body: "Invoked via `/design-issue` before filing.",
    whereThingsLive: null,
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("body paths case 14: single-segment directory `/etc` is ignored", () => {
  const doc = buildDoc({
    body: "System configuration under `/etc`.",
    whereThingsLive: null,
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("body paths case 15: placeholder pattern in Where Things Live covers nested path", () => {
  const doc = buildDoc({
    body: "Reads `~/Dropbox/web-jam-llms/Token_Savings/backlog-groom-design.md`.",
    whereThingsLive: "- `~/Dropbox/web-jam-llms/<Theme>/<topic>-design.md` — design documents",
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("body paths case 16: parent directory does not pass when only deeper placeholder path is listed", () => {
  const doc = buildDoc({
    body: "Looks in `~/.claude/state/`.",
    whereThingsLive:
      "- `~/.claude/state/design-gate1/<hash of the design document's absolute path>.json` — Gate 1 records",
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);
  const violations = result.violations.filter((v) =>
    v.rule === "body-path-missing-from-where-things-live"
  );
  assertEquals(violations.length, 1);
  assertStringIncludes(violations[0].message, "~/.claude/state/");
});

Deno.test("body paths case 17: token with spaces inside angle placeholder is read whole and checked", () => {
  const token = "`~/.claude/state/design-gate1/<hash of the design document's absolute path>.json`";
  const coveredDoc = buildDoc({
    body: `Writes ${token} at Gate 1.`,
    whereThingsLive: `- ${token} — Gate 1 record file`,
  });
  const coveredResult = lintDesignDoc(coveredDoc, "test.md");
  assertEquals(coveredResult.valid, true);
  assertEquals(coveredResult.violations.length, 0);

  const missingDoc = buildDoc({
    body: `Writes ${token} at Gate 1.`,
    whereThingsLive: "- `/var/log/other.log` — unrelated",
  });
  const missingResult = lintDesignDoc(missingDoc, "test.md");
  assertEquals(missingResult.valid, false);
  const violations = missingResult.violations.filter((v) =>
    v.rule === "body-path-missing-from-where-things-live"
  );
  assertEquals(violations.length, 1);
  assertStringIncludes(
    violations[0].message,
    "~/.claude/state/design-gate1/<hash of the design document's absolute path>.json",
  );
});

Deno.test("body paths case 18: folder prefix before first placeholder covers folder itself", () => {
  const doc = buildDoc({
    body: "Scans `~/Dropbox/web-jam-llms` for design files.",
    whereThingsLive: "- `~/Dropbox/web-jam-llms/<Theme>/<topic>-design.md` — design documents",
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("body paths case 19: bare tilde-slash `~/` is ignored", () => {
  const doc = buildDoc({
    body: "Relative to `~/` home directory.",
    whereThingsLive: null,
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("body paths skips revision table and Appendix sections", () => {
  const doc = buildDoc({
    body: "No runtime paths in body.",
    whereThingsLive: null,
    revisionExtraRow: "| 1.0.1 | " + TODAY + " | Documented `/var/log/rev-only.log` move |",
    appendix: "Case fixture mentions `/etc/appendix-only.conf`.",
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("body paths: single-segment directory in Where Things Live covers child files and respects directory boundaries", () => {
  const coveredDoc = buildDoc({
    body: "Reads `/etc/wsl.conf` on boot.",
    whereThingsLive: "- `/etc` — system config directory",
  });
  assertEquals(lintDesignDoc(coveredDoc, "test.md").valid, true);

  const siblingDoc = buildDoc({
    body: "Reads `/etcetera/wsl.conf` on boot.",
    whereThingsLive: "- `/etc` — system config directory",
  });
  const siblingResult = lintDesignDoc(siblingDoc, "test.md");
  assertEquals(siblingResult.valid, false);
  assertEquals(siblingResult.violations.length, 1);
  assertStringIncludes(siblingResult.violations[0].message, "/etcetera/wsl.conf");
});

Deno.test("body paths: placeholder prefix enforces directory boundary instead of raw prefix", () => {
  const doc = buildDoc({
    body: "Reads `/var/log/run-other/output.log`.",
    whereThingsLive: "- `/var/log/run-<id>/output.log` — per-run output",
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, false);
  const violations = result.violations.filter((v) =>
    v.rule === "body-path-missing-from-where-things-live"
  );
  assertEquals(violations.length, 1);
  assertStringIncludes(violations[0].message, "/var/log/run-other/output.log");
});

Deno.test("body paths: mid-name placeholder listed verbatim in Where Things Live covers exact body match", () => {
  const doc = buildDoc({
    body:
      "Writes `/var/log/run-<id>/output.log` and checks out `/tmp/fix-pr-<number>/` in `/tmp/agy-worktrees/<Repo>-<branch>`.",
    whereThingsLive: [
      "- `/var/log/run-<id>/output.log` — per-run output",
      "- `/tmp/fix-pr-<number>` — throwaway fix worktree",
      "- `/tmp/agy-worktrees/<Repo>-<branch>` — issue worktree",
    ].join("\n"),
  });
  const result = lintDesignDoc(doc, "test.md");
  assertEquals(result.valid, true);
  assertEquals(result.violations.length, 0);
});

Deno.test("body paths: paths in ordinary heading lines are checked while nested Where Things Live in Appendix cannot grant coverage or end Appendix exclusion", () => {
  const missingHeadingPath = buildDoc({
    body: "### Writing `~/.claude/state/run-state.json`\n\nNormal prose.",
    whereThingsLive: null,
    appendix:
      "### Where Things Live\n\n- `~/.claude/state/run-state.json` — example only\n\n### Later Subsection\n\nMentions `/etc/still-appendix.conf`.",
  });
  const res = lintDesignDoc(missingHeadingPath, "test.md");
  assertEquals(res.valid, false);
  const violations = res.violations.filter((v) =>
    v.rule === "body-path-missing-from-where-things-live"
  );
  assertEquals(violations.length, 1);
  assertStringIncludes(violations[0].message, "~/.claude/state/run-state.json");

  const coveredHeadingPath = buildDoc({
    body: "### Writing `~/.claude/state/run-state.json`\n\nNormal prose.",
    whereThingsLive: "- `~/.claude/state/run-state.json` — run state file",
    appendix: "### Subsection\n\nMentions `/etc/still-appendix.conf`.",
  });
  assertEquals(lintDesignDoc(coveredHeadingPath, "test.md").valid, true);
});

Deno.test("body paths: quoted fenced examples are excluded and CommonMark blockquote boundaries end the fence before ordinary prose", () => {
  const closedInQuote = buildDoc({
    body: "> ```bash\n> cat `/etc/inside-quoted-fence.conf`\n> ```\n\nClean body prose.",
    whereThingsLive: null,
  });
  assertEquals(lintDesignDoc(closedInQuote, "test.md").valid, true);

  const example128Like = buildDoc({
    body:
      "> ```\n> `/etc/inside-quoted-fence.conf`\n\nOrdinary prose after quote mentions `/etc/outside-quote-prose.conf`.",
    whereThingsLive: null,
  });
  const res = lintDesignDoc(example128Like, "test.md");
  assertEquals(res.valid, false);
  const violations = res.violations.filter((v) =>
    v.rule === "body-path-missing-from-where-things-live"
  );
  assertEquals(violations.length, 1);
  assertStringIncludes(violations[0].message, "/etc/outside-quote-prose.conf");
});

Deno.test("body paths: list-indented fenced blocks are excluded while following body prose is checked", () => {
  const doc = buildDoc({
    body:
      "- Example step:\n  ```bash\n  cat `/etc/in-list-fence.conf`\n  ```\n\nBody step reads `/etc/after-list.conf`.",
    whereThingsLive: "- `/etc/after-list.conf` — runtime config",
  });
  assertEquals(lintDesignDoc(doc, "test.md").valid, true);
});
