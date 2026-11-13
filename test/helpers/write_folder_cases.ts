// The 17 folder-table rows in hooks design revision 2.27.0. Commands are hook input, never run.
import { assert, assertEquals } from "@std/assert";
import { analyzeBashWrites } from "../../hooks/lib/bash_write_targets.ts";

export interface FolderCase {
  name: string;
  cwd: string;
  command: string;
  targets: string[];
  unknownFiles?: string[];
  unknownDirectory?: boolean;
  repositoryWrite?: boolean;
}

export function folderCases(repo: string, scratch: string, home: string): FolderCase[] {
  const doc = `${home}/Dropbox/web-jam-llms/Token_Savings`;
  const file = `${scratch}/1309-new.md`;
  const python = (body: string, args = "") => `python3 - ${args}<<'EOF'\n${body}\nEOF`;
  return [
    {
      name: "01 heredoc before later repository cd",
      cwd: doc,
      command: `cd ${doc} && ${
        python(
          "import sys\np = sys.argv[1]\nopen(p,'w').write('x')",
          "model-tier-order-design-2026-10-02.md ",
        )
          .replace("python3 - ", "python3 -I - ")
      }\ncd ${repo} && deno task design:lint-doc ${doc}/model-tier-order-design-2026-10-02.md`,
      targets: [`${doc}/model-tier-order-design-2026-10-02.md`],
    },
    {
      name: "02 variable cd before heredoc and later literal cd",
      cwd: scratch,
      command: `S=${scratch}/memsim; cd $S && ${
        python("p = 'out.txt'\nopen(p,'w').write('x')")
      }\ncd ${repo} && deno task memory-index --dir $S`,
      targets: [],
      unknownDirectory: true,
    },
    {
      name: "03 variable cd before redirect",
      cwd: repo,
      command: `S=${scratch}; cd $S/mut; echo "// x" >> test/memory_index.test.ts`,
      targets: [],
      unknownDirectory: true,
    },
    {
      name: "04 literal cd before redirect",
      cwd: repo,
      command: `cd ${scratch}/mut; echo "// x" >> test/memory_index.test.ts`,
      targets: [`${scratch}/mut/test/memory_index.test.ts`],
    },
    {
      name: "05 repository path held in script variable",
      cwd: scratch,
      command: `cd ${repo} && ${python("p = 'AGENTS.md'\nopen(p,'w').write('x')")}`,
      targets: [`${repo}/AGENTS.md`],
      repositoryWrite: true,
    },
    {
      name: "06 redirect before later cd",
      cwd: scratch,
      command: `cd ${repo} && echo x > AGENTS.md; cd ${scratch}`,
      targets: [`${repo}/AGENTS.md`],
      repositoryWrite: true,
    },
    {
      name: "07 Case B scratch path held in variable",
      cwd: repo,
      command: python(`p = '${file}'\nopen(p,'w').write('x')`),
      targets: [file],
    },
    {
      name: "08 redirect and variable-named heredoc file",
      cwd: repo,
      command:
        `gh issue view 1309 --repo WebJamApps/web-jam-tools --json body -q .body > ${scratch}/1309-old.md && ${
          python(`p = '${file}'\nopen(p,'w').write('x')`)
        }\ndiff ${scratch}/1309-old.md ${file}`,
      targets: [`${scratch}/1309-old.md`, file],
    },
    {
      name: "09 document path held in variable",
      cwd: repo,
      command: python(`p = '${doc}/x-design.md'\nopen(p,'w').write('x')`),
      targets: [`${doc}/x-design.md`],
    },
    {
      name: "10 Path variable names repository file",
      cwd: repo,
      command: python("from pathlib import Path\np = Path('AGENTS.md')\np.write_text('x')"),
      targets: [`${repo}/AGENTS.md`],
      repositoryWrite: true,
    },
    {
      name: "11 Python script argument",
      cwd: repo,
      command: python("import sys\nopen(sys.argv[1],'w').write('x')", `${scratch}/a.md `),
      targets: [`${scratch}/a.md`],
    },
    {
      name: "12 Node script argument",
      cwd: repo,
      command:
        `node - ${scratch}/a.md <<'JS'\nrequire('fs').writeFileSync(process.argv[2], 'x');\nJS`,
      targets: [`${scratch}/a.md`],
    },
    {
      name: "13 Deno script argument",
      cwd: repo,
      command:
        `deno run -A - ${scratch}/a.md <<'TS'\nDeno.writeTextFileSync(Deno.args[0], 'x');\nTS`,
      targets: [`${scratch}/a.md`],
    },
    {
      name: "14 repository file in script argument",
      cwd: repo,
      command: python("import sys\nopen(sys.argv[1],'w').write('x')", "AGENTS.md "),
      targets: [`${repo}/AGENTS.md`],
      repositoryWrite: true,
    },
    {
      name: "15 shell-variable script argument",
      cwd: repo,
      command: `S=${scratch}; ${
        python("import sys\nopen(sys.argv[1],'w').write('x')", '"$S/1309-new.md" ')
      }`,
      targets: [],
      unknownFiles: [repo],
    },
    {
      name: "16 computed script variable",
      cwd: repo,
      command: python("import os\np = os.path.join('/tmp', 'a.md')\nopen(p,'w').write('x')"),
      targets: [],
      unknownFiles: [repo],
    },
    {
      name: "17 reassigned script variable",
      cwd: repo,
      command: python("p = '/tmp/a.md'\np = 'AGENTS.md'\nopen(p,'w').write('x')"),
      targets: [],
      unknownFiles: [repo],
    },
  ];
}

/** Exercise both public shell entry points, including agy's real payload translation. */
export async function verifyFolderRow(
  index: number,
  hook: "feature-branch-guard" | "opus-delegation-gate",
) {
  const root = await Deno.makeTempDir({ prefix: "write-folder-table-" });
  try {
    const repo = `${root}/repo`, scratch = `${root}/scratch`, home = `${root}/home`;
    for (const dir of [repo, scratch, `${home}/Dropbox/web-jam-llms/Token_Savings`]) {
      await Deno.mkdir(dir, { recursive: true });
    }
    const init = await new Deno.Command("git", { args: ["-C", repo, "init", "-q", "-b", "dev"] })
      .output();
    assertEquals(init.code, 0);
    const transcript = `${root}/session.jsonl`;
    await Deno.writeTextFile(
      transcript,
      [
        {
          type: "user",
          origin: { kind: "human" },
          message: { role: "user", content: "inspect only" },
        },
        {
          type: "assistant",
          message: { role: "assistant", model: "claude-opus-5", content: "ok" },
        },
      ].map((entry) => JSON.stringify(entry)).join("\n"),
    );
    const row = folderCases(repo, scratch, home)[index];
    assertEquals(analyzeBashWrites(row.command, { cwd: row.cwd, home }), {
      targets: row.targets,
      unknownFiles: row.unknownFiles ?? [],
      unknownDirectory: row.unknownDirectory ?? false,
    }, row.name);
    const script = new URL(`../../hooks/${hook}.sh`, import.meta.url).pathname;
    const shim = new URL("../../hooks/agy-hook-shim.sh", import.meta.url).pathname;
    for (const surface of ["claude-code", "agy", "codex"]) {
      const payload = surface === "agy"
        ? {
          transcriptPath: transcript,
          modelName: "claude-opus-5",
          toolCall: { name: "run_command", args: { CommandLine: row.command, Cwd: row.cwd } },
        }
        : {
          transcript_path: transcript,
          cwd: row.cwd,
          tool_name: "Bash",
          tool_input: { command: row.command },
        };
      const process = new Deno.Command("bash", {
        args: surface === "agy" ? [shim, "PreToolUse", btoa("Bash"), script] : [script],
        env: { HOME: home, BASH_ENV: "", WJT_SURFACE: surface, AGY_HOOK_RECORD_PATH: "off" },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const writer = process.stdin.getWriter();
      await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
      await writer.close();
      const output = await process.output();
      const stdout = new TextDecoder().decode(output.stdout);
      const stderr = new TextDecoder().decode(output.stderr);
      const denied = row.repositoryWrite ||
        (hook === "opus-delegation-gate" && !!row.unknownFiles?.length);
      const result = stdout.trim() ? JSON.parse(stdout) : {};
      if (surface === "agy") {
        assertEquals(output.code, 0, stderr);
        assertEquals(result.decision, denied ? "deny" : "allow", row.name + stdout);
      } else if (hook === "feature-branch-guard") {
        assertEquals(output.code, denied ? 2 : 0, row.name + stderr);
      } else {
        assertEquals(output.code, 0, stderr);
        assertEquals(
          result.hookSpecificOutput?.permissionDecision,
          denied ? "deny" : undefined,
          row.name + stdout,
        );
      }
      if (!denied && (row.unknownDirectory || row.unknownFiles?.length)) {
        const note = result.hookSpecificOutput?.additionalContext;
        assert(
          typeof note === "string" && note.includes("could not be determined"),
          row.name + stdout,
        );
      }
      if (denied && row.unknownFiles?.length) {
        assert(stdout.includes("file cannot be named"), stdout);
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
