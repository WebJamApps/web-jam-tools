# Manual Verification Runbook: Verify Gate 1 Design Document Rendering and Task Wiring

This runbook verifies that Gate 1 helper tooling and task wiring in `web-jam-tools` correctly
renders markdown design documents to HTML, verifies layout via headless screenshot, and opens the
rendered HTML in Google Chrome.

## STEP 1: Verify render_design_doc Task

**Command:**

```sh
cd /home/joshua/WebJamApps/web-jam-tools
deno task render_design_doc --help
```

**What this proves:** Verifies that `render_design_doc` is registered as a runnable `deno task`
entry in `deno.json` and executes `scripts/render_design_doc.ts` with clean usage output.

**Expected result:** Prints `Usage: render_design_doc.ts <input_markdown_path> <output_html_path>`
to the console.

---

## STEP 2: Verify write_issue_approval_token Task

**Command:**

```sh
cd /home/joshua/WebJamApps/web-jam-tools
deno task write_issue_approval_token --help
```

**What this proves:** Verifies that `write_issue_approval_token` is registered as a runnable
`deno task` entry in `deno.json` and executes `scripts/write_issue_approval_token.ts` with clean
usage output from the repository root.

**Expected result:** Prints
`Usage: deno run --allow-env --allow-read --allow-write scripts/write_issue_approval_token.ts [options]`
and lists available CLI options.

---

## STEP 3: Execute Gate 1 Rendering, Verification, and Chrome Launch

**Command:**

```sh
cd /home/joshua/WebJamApps/web-jam-tools
deno task design:gate1 /home/joshua/Dropbox/web-jam-llms/Token_Savings/design-issue-enhancements-design-2026-08-23.md
```

**What this proves:** Verifies that `deno task design:gate1` executes the complete Gate 1 sequence:
renders the markdown design doc to HTML via `scripts/render_design_doc.ts`, confirms layout
integrity with a headless screenshot, and launches the rendered HTML in Google Chrome on the active
display.

**Expected result:** The command completes with exit code 0, outputs confirmation logs indicating
the rendered HTML path, headless screenshot size, and Google Chrome launch, and opens a new tab in
Google Chrome displaying the rendered design document.
