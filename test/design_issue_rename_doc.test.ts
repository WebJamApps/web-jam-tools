import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import {
  applyDocRename,
  planDocRename,
  RenameApplyError,
  runRenameDocCli,
} from "../src/design-issue/rename_doc.ts";
import {
  approveGate1Record,
  getGate1RecordPath,
  getGate1Status,
  loadGate1Record,
  openGate1Record,
} from "../src/design-issue/gate1_record.ts";

const OLD = "sample-design-2026-01-01.md";
const NEW = "sample-design.md";
const AUTHOR = "Codex — GPT-6.1 Sol";
const content = (name: string) =>
  `# Sample\n\n${name}\n\n## Load-bearing premises\n\n| Premise | Proof | Proved |\n|---|---|---|\n| Names ${name} | Read ${name} | 2026-01-01 |\n`;
async function fixture() {
  const root = await Deno.makeTempDir({ prefix: "rename-doc-" });
  const dropboxDir = path.join(root, "Dropbox");
  const reposDir = path.join(root, "repos");
  const stateDir = path.join(root, "state");
  await Deno.mkdir(dropboxDir);
  await Deno.mkdir(path.join(reposDir, "web-jam-tools"), { recursive: true });
  const source = path.join(dropboxDir, OLD);
  const target = path.join(dropboxDir, NEW);
  const pointer = path.join(reposDir, "web-jam-tools", "pointer.md");
  await Deno.writeTextFile(source, content(OLD));
  await Deno.writeTextFile(
    source.replace(".md", ".html"),
    `Link ${OLD} and ${OLD.replace(".md", ".html")}`,
  );
  await Deno.writeTextFile(pointer, `Use ${OLD}`);
  await openGate1Record(source, content(OLD), { stateDir });
  await approveGate1Record(source, "Approved verbatim", { stateDir });
  const issues = [
    { number: 10, title: "Open pointer", state: "open", body: `Read ${OLD}` },
    { number: 11, title: "Closed pointer", state: "closed", body: `Read ${OLD}` },
    { number: 12, title: "Empty issue", state: "open", body: null },
  ];
  const calls: string[][] = [];
  const edits: string[] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    let stdout = "";
    if (args[0] === "git") stdout = args.includes("rev-parse") ? args[2] : "pointer.md\0";
    if (args[0] === "gh") {
      stdout = args.includes("--slurp") ? JSON.stringify([issues]) : JSON.stringify(issues[0]);
    }
    if (args[0] === "deno") edits.push(await Deno.readTextFile(args.at(-1)!));
    return { code: 0, stdout, stderr: "" };
  };
  return {
    root,
    source,
    target,
    pointer,
    issues,
    calls,
    edits,
    options: { dropboxDir, reposDir, stateDir, repos: ["web-jam-tools"], author: AUTHOR, runner },
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

Deno.test("dry run is inert; apply carries renders, approval, pointers and guarded open issue edits", async () => {
  const f = await fixture();
  try {
    const beforeRecord = await loadGate1Record(f.source, f.options);
    const plan = await planDocRename(f.source, NEW, f.options);
    assertEquals(await Deno.readTextFile(f.source), content(OLD));
    assertEquals(f.edits, []);
    assertEquals(plan.closedIssues, ['WebJamApps/web-jam-tools#11 "Closed pointer"']);
    await applyDocRename(plan);
    assertEquals(await Deno.readTextFile(f.target), content(NEW));
    assertEquals(await Deno.readTextFile(f.pointer), `Use ${NEW}`);
    assertEquals(
      await Deno.readTextFile(f.target.replace(".md", ".html")),
      `Link ${NEW} and sample-design.html`,
    );
    const record = await loadGate1Record(f.target, f.options);
    assertEquals(record?.reply, beforeRecord?.reply);
    assertEquals(record?.approvedAt, beforeRecord?.approvedAt);
    assertEquals(record?.premiseRows?.[0].proved, "2026-01-01");
    assertStringIncludes(record!.premiseRows![0].proof, NEW);
    assertEquals((await getGate1Status(f.target, f.options)).status, "approved");
    assertEquals(await loadGate1Record(f.source, f.options), null);
    assertEquals(f.edits, [`Read ${NEW}`]);
    const edit = f.calls.find((args) => args[0] === "deno")!;
    assertEquals(edit.slice(1, 3), ["task", "--config"]);
    assert(edit.includes("edit-issue") && edit.includes("--author") && edit.includes(AUTHOR));
    assert(!f.calls.some((args) => args[0] === "gh" && args[1] !== "api"));
  } finally {
    await f.cleanup();
  }
});

Deno.test("only matching approved pointer documents carry their rows and fingerprints", async () => {
  const f = await fixture();
  try {
    const fresh = path.join(f.options.dropboxDir, "fresh-design.md");
    const stale = path.join(f.options.dropboxDir, "stale-design.md");
    for (const file of [fresh, stale]) {
      await Deno.writeTextFile(file, content(OLD));
      await openGate1Record(file, content(OLD), f.options);
      await approveGate1Record(file, "yes", f.options);
    }
    await Deno.writeTextFile(stale, content(OLD) + "Unapproved text\n");
    const original = await Deno.readTextFile(getGate1RecordPath(stale, f.options.stateDir));
    await applyDocRename(await planDocRename(f.source, NEW, f.options));
    assertEquals((await getGate1Status(fresh, f.options)).status, "approved");
    assertStringIncludes((await loadGate1Record(fresh, f.options))!.premiseRows![0].premise, NEW);
    assertEquals((await getGate1Status(stale, f.options)).status, "changed since approval");
    assertEquals(await Deno.readTextFile(getGate1RecordPath(stale, f.options.stateDir)), original);
  } finally {
    await f.cleanup();
  }
});

Deno.test("stale source approval stays stale; no-record and no-render sources also rename", async () => {
  const f = await fixture();
  try {
    const old = await loadGate1Record(f.source, f.options);
    await Deno.writeTextFile(f.source, content(OLD) + "Unapproved\n");
    await applyDocRename(await planDocRename(f.source, NEW, f.options));
    const record = await loadGate1Record(f.target, f.options);
    assertEquals(record?.approvedFingerprint, old?.approvedFingerprint);
    assertEquals(record?.premiseRows, old?.premiseRows);
    assertEquals((await getGate1Status(f.target, f.options)).status, "changed since approval");
    await Deno.remove(getGate1RecordPath(f.target, f.options.stateDir));
    await Deno.remove(f.target.replace(".md", ".html"));
    await applyDocRename(await planDocRename(f.target, "another-design.md", f.options));
    assertEquals(
      (await getGate1Status(path.join(f.options.dropboxDir, "another-design.md"), f.options))
        .status,
      "not presented",
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("preflight refuses invalid names, collisions, unreadable pointers/records and failed issue lookups without writes", async () => {
  const cases = [
    "date",
    "date-suffix",
    "compact-date",
    "exists",
    "html-exists",
    "record-exists",
    "missing",
    "record",
    "record-fields",
    "record-permission",
    "pointer",
    "ambiguous",
    "malformed-issues",
    "issue",
    "network",
    "scope",
    "symlink",
    "move",
  ];
  for (const test of cases) {
    const f = await fixture();
    try {
      let source = f.source;
      let newName = NEW;
      const options = { ...f.options };
      if (test === "date") newName = "new-design-2026-02-03.md";
      if (test === "date-suffix") newName = "new-design-2026-02-03copy.md";
      if (test === "compact-date") newName = "new-design-20260203.md";
      if (test === "exists") await Deno.writeTextFile(f.target, "keep");
      if (test === "html-exists") {
        await Deno.writeTextFile(f.target.replace(".md", ".html"), "keep");
      }
      if (test === "record-exists") {
        await Deno.writeTextFile(getGate1RecordPath(f.target, options.stateDir), "keep");
      }
      if (test === "missing") source = path.join(options.dropboxDir, "missing-design.md");
      if (test === "record") {
        await Deno.writeTextFile(getGate1RecordPath(f.source, options.stateDir), "not JSON");
      }
      if (test === "record-fields") {
        await Deno.writeTextFile(
          getGate1RecordPath(f.source, options.stateDir),
          JSON.stringify({ docPath: f.source, approvedAt: 123 }),
        );
      }
      if (test === "record-permission") {
        await Deno.chmod(getGate1RecordPath(f.source, options.stateDir), 0);
      }
      if (test === "pointer") await Deno.chmod(f.pointer, 0);
      if (test === "ambiguous") {
        const dir = path.join(options.dropboxDir, "Another-theme");
        await Deno.mkdir(dir);
        await Deno.writeTextFile(path.join(dir, OLD), content(OLD));
      }
      if (test === "malformed-issues") {
        options.runner = (args) =>
          args[0] === "gh"
            ? Promise.resolve({ code: 0, stdout: "[broken", stderr: "" })
            : f.options.runner(args);
      }
      if (test === "issue") delete (f.issues[0] as Partial<typeof f.issues[0]>).body;
      if (test === "network") {
        options.runner = () => Promise.resolve({ code: 2, stdout: "", stderr: "offline" });
      }
      if (test === "scope") options.repos = ["outside-repo"];
      if (test === "symlink") {
        source = path.join(options.dropboxDir, "linked-design.md");
        await Deno.symlink(f.source, source);
      }
      if (test === "move") newName = path.join(f.root, NEW);
      await assertRejects(() => planDocRename(source, newName, options), Error);
      assertEquals(await Deno.readTextFile(f.source), content(OLD));
      assertEquals(f.edits, []);
    } finally {
      await f.cleanup();
    }
  }
});

Deno.test("pagination duplicates are edited once and inconsistent pages fail closed", async () => {
  const f = await fixture();
  try {
    const options = {
      ...f.options,
      repos: ["web-jam-tools", "web-jam-tools"],
      runner: (args: string[]) =>
        args.includes("--slurp")
          ? Promise.resolve({
            code: 0,
            stdout: JSON.stringify([f.issues, [f.issues[0]]]),
            stderr: "",
          })
          : f.options.runner(args),
    };
    await applyDocRename(await planDocRename(f.source, NEW, options));
    assertEquals(f.edits.length, 1);
  } finally {
    await f.cleanup();
  }
  const inconsistent = await fixture();
  try {
    const options = {
      ...inconsistent.options,
      runner: (args: string[]) =>
        args.includes("--slurp")
          ? Promise.resolve({
            code: 0,
            stdout: JSON.stringify([inconsistent.issues, [{
              ...inconsistent.issues[0],
              body: "Changed",
            }]]),
            stderr: "",
          })
          : inconsistent.options.runner(args),
    };
    await assertRejects(
      () => planDocRename(inconsistent.source, NEW, options),
      Error,
      "changed between pages",
    );
    assertEquals(await Deno.readTextFile(inconsistent.source), content(OLD));
  } finally {
    await inconsistent.cleanup();
  }
});

Deno.test("open Gate 1 and adoption-only records retain their original status after a rename", async () => {
  for (const adopted of [false, true]) {
    const f = await fixture();
    try {
      const recordFile = getGate1RecordPath(f.source, f.options.stateDir);
      if (adopted) {
        const record = (await loadGate1Record(f.source, f.options))!;
        delete record.approvedAt;
        delete record.approvedFingerprint;
        delete record.reply;
        record.presentedFingerprint = "";
        record.presentedAt = "";
        record.premiseRowsSource = "adoption";
        await Deno.writeTextFile(recordFile, JSON.stringify(record));
      } else await openGate1Record(f.source, content(OLD), f.options);
      await applyDocRename(await planDocRename(f.source, NEW, f.options));
      assertEquals(
        (await getGate1Status(f.target, f.options)).status,
        adopted ? "not presented" : "open",
      );
    } finally {
      await f.cleanup();
    }
  }
});

Deno.test("changed snapshots, newly created destinations and closed issues refuse before the first write", async () => {
  for (const changed of ["pointer", "record", "target", "issue", "author"]) {
    const f = await fixture();
    try {
      const plan = await planDocRename(f.source, NEW, f.options);
      if (changed === "pointer") await Deno.writeTextFile(f.pointer, "Concurrent edit");
      if (changed === "record") {
        await Deno.writeTextFile(getGate1RecordPath(f.source, f.options.stateDir), "{}");
      }
      if (changed === "target") await Deno.writeTextFile(f.target, "Concurrent file");
      if (changed === "issue") f.issues[0].state = "closed";
      if (changed === "author") plan.options.author = "";
      await assertRejects(() => applyDocRename(plan), Error);
      assertEquals(await Deno.readTextFile(f.source), content(OLD));
      assertEquals(f.edits, []);
    } finally {
      await f.cleanup();
    }
  }
});

Deno.test("the first write failure stops the operation and reports completed and unattempted writes", async () => {
  const f = await fixture();
  try {
    const plan = await planDocRename(f.source, NEW, f.options);
    const error = await assertRejects(
      () =>
        applyDocRename(plan, async (file, text) => {
          if (file === f.pointer) throw new Error("disk full");
          await Deno.writeTextFile(file, text);
        }),
      RenameApplyError,
      "disk full",
    );
    assert(error.completed.some((item) => item.includes(f.target)));
    assertStringIncludes(error.failed, f.pointer);
    assert(error.pending.some((item) => item.includes("Open pointer")));
    assertEquals(f.edits, []);
    assertEquals(await Deno.readTextFile(f.pointer), `Use ${OLD}`);
  } finally {
    await f.cleanup();
  }
});

Deno.test("real CLI on a fixture tree: dry run leaves bytes intact, apply moves files and Gate 1 approval", async () => {
  const f = await fixture();
  try {
    const bin = path.join(f.root, "bin");
    await Deno.mkdir(bin);
    const gh = path.join(bin, "gh");
    await Deno.writeTextFile(gh, "#!/bin/sh\nprintf '[[]]\\n'\n");
    await Deno.chmod(gh, 0o700);
    const repo = path.join(f.options.reposDir, "web-jam-tools");
    for (const args of [["init", "-q", repo], ["-C", repo, "add", "pointer.md"]]) {
      assertEquals((await new Deno.Command("git", { args }).output()).code, 0);
    }
    const config = path.fromFileUrl(new URL("../deno.json", import.meta.url));
    const args = [
      "task",
      "--config",
      config,
      "design:rename-doc",
      f.source,
      NEW,
      "--dropbox-dir",
      f.options.dropboxDir,
      "--repos-dir",
      f.options.reposDir,
      "--repos",
      "web-jam-tools",
      "--state-dir",
      f.options.stateDir,
    ];
    for (const apply of [false, true]) {
      const output = await new Deno.Command(Deno.execPath(), {
        args: [...args, ...(apply ? ["--apply"] : [])],
        env: { PATH: `${bin}:${Deno.env.get("PATH")}` },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
      assertStringIncludes(new TextDecoder().decode(output.stdout), apply ? "APPLIED" : "DRY RUN");
      assertEquals(
        await Deno.readTextFile(apply ? f.target : f.source),
        content(apply ? NEW : OLD),
      );
    }
    assertEquals((await getGate1Status(f.target, f.options)).status, "approved");
  } finally {
    await f.cleanup();
  }
});

Deno.test("rename CLI help succeeds and unknown flags/missing operands refuse", async () => {
  assertEquals(await runRenameDocCli(["--help"]), 0);
  assertEquals(await runRenameDocCli([]), 1);
  assertEquals(await runRenameDocCli(["--surprise"]), 1);
});
