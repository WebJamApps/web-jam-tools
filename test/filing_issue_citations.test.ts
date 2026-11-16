import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { run as edit } from "../scripts/edit-issue.ts";
import { run as issueComment } from "../scripts/post-issue-comment.ts";
import { run as prComment } from "../scripts/post-pr-comment.ts";
import { run as review } from "../scripts/post-pr-review.ts";
import { createIssueAndVerify, type ExecDeps } from "../src/create-issue/lib.ts";
import { TEST_AUTHOR, withPassingProbe } from "./authored_by_test_helpers.ts";
import { findBareWriteRefs } from "../hooks/lib/detect_bare_issue_refs.ts";

const title = "Docs: document the outreach accidental-spam / dedup protection";
const url = "https://github.com/WebJamApps/JaMmusic/issues/1239";
// Body contents and arrival forms from the design's eight-row case table.
const cases = [
  { name: "literal file", body: "see #1239", offender: "#1239" },
  { name: "same-command variable file", body: "see #1239", offender: "#1239" },
  { name: "earlier-command variable file", body: "see #1239", offender: "#1239" },
  { name: "command substitution", body: "JaMmusic#1239", offender: "JaMmusic#1239" },
  { name: "bare address", body: url, offender: url },
  { name: "titled citation", body: `JaMmusic#1239 "${title}"` },
  { name: "code", body: "the regex `#(\\d+)` and `#1239`" },
  { name: "titled link", body: `[${title}](${url})` },
];

for (const row of cases) {
  for (
    const verb of ["edit-file", "edit-inline", "issue-comment", "pr-comment", "review", "create"]
  ) {
    Deno.test(`filing citations: ${verb}, ${row.name}`, async () => {
      const calls: string[][] = [];
      const body = verb === "review"
        ? `## PR Review Summary\n${row.body}\n\n🤖 Reviewed by ${TEST_AUTHOR}`
        : `## What this builds\n${row.body}`;
      const deps = withPassingProbe({
        readFileText: () => Promise.resolve(body),
        runCmd: (cmd: string[]) => {
          calls.push(cmd);
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify({ body: "Old body" }),
            stderr: "",
          });
        },
      });
      let code: number;
      const args = ["--repo", "WebJamApps/web-jam-tools", "--body-file", "/tmp/b.md"];
      if (verb === "create") {
        const execute = () =>
          createIssueAndVerify(
            {
              title: "Citation fixture",
              bodyFile: "/tmp/b.md",
              labels: ["Terra"],
              author: TEST_AUTHOR,
              dryRun: true,
            },
            deps as ExecDeps,
            () => ({ ok: true }),
          );
        if (row.offender) {
          const error = await assertRejects(execute, Error, row.offender);
          assertStringIncludes(error.message, 'repo#number "title"');
        } else assertStringIncludes(await execute(), row.body);
        assertEquals(calls, []);
        return;
      } else if (verb.startsWith("edit")) {
        code = await edit([
          "--repo",
          "WebJamApps/web-jam-tools",
          "--issue",
          "12",
          "--author",
          TEST_AUTHOR,
          ...(verb === "edit-inline" ? ["--body", body] : ["--body-file", "/tmp/b.md"]),
        ], deps);
      } else {
        const run = verb === "review" ? review : verb === "pr-comment" ? prComment : issueComment;
        code = await run([...args, verb === "issue-comment" ? "--issue" : "--pr", "7"], deps);
      }
      assertEquals(code, row.offender ? 1 : 0);
      if (row.offender) assertEquals(calls, []);
      else assertEquals(calls.some((cmd) => ["edit", "comment", "review"].includes(cmd[2])), true);
    });
  }
}

Deno.test("filing detector preserves code exemptions and reports all citations once", () => {
  assertEquals(findBareWriteRefs("#12 #12 JaMmusic#13 " + url), ["#12", "JaMmusic#13", url]);
  assertEquals(findBareWriteRefs("```\n#12\n" + url + "\n```"), []);
});

Deno.test("filing CLI reads shell-expanded files and command substitutions before GitHub writes", async () => {
  const dir = await Deno.makeTempDir();
  const bodyFile = `${dir}/body.md`;
  try {
    await Deno.writeTextFile(bodyFile, "see #1239");
    const editScript = new URL("../scripts/edit-issue.ts", import.meta.url).pathname;
    const commentScript = new URL("../scripts/post-issue-comment.ts", import.meta.url).pathname;
    const edit =
      '"$DENO_BIN" run --allow-read --allow-env --allow-run "$EDIT_SCRIPT" --repo WebJamApps/JaMmusic --issue 12';
    const commands = [
      `${edit} --body-file "$BODY_PATH"`,
      `B="$BODY_PATH"; ${edit} --body-file "$B"`,
      '"$DENO_BIN" run --allow-read --allow-env --allow-run "$COMMENT_SCRIPT" --repo WebJamApps/JaMmusic --issue 12 --body-file "$B"',
      `${edit} --body "$(cat "$BODY_PATH")"`,
    ];
    for (const command of commands) {
      const output = await new Deno.Command("bash", {
        args: ["--noprofile", "--norc", "-c", command],
        env: {
          DENO_BIN: Deno.execPath(),
          EDIT_SCRIPT: editScript,
          COMMENT_SCRIPT: commentScript,
          BODY_PATH: bodyFile,
          B: bodyFile,
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(output.code, 1);
      assertStringIncludes(
        new TextDecoder().decode(output.stderr),
        "bare issue/PR citation(s): #1239",
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
