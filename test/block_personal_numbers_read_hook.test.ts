// block_personal_numbers_read_hook.test.ts — web-jam-tools#1860
//
// One Deno test per row of the table of literal calls in "What an agent reads",
// ~/Dropbox/web-jam-llms/AI_Misbehaves/personal-information-guards-design.md.
// Each row runs through the real entry point on all three surfaces: the Claude
// Code payload, hooks/agy-hook-shim.sh with agy's own payload, and WJT_SURFACE=codex.
//
// HOME is a fixture folder, so `~/Downloads/...` and `/home/joshua/...` land
// there and no test touches the real home folder. Every number is made up.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "jsr:@std/path@^1.0.0";
import {
  checkPath,
  checkPayload,
  MAX_SWEEP_FILES,
  newSweep,
  refusalFor,
} from "../hooks/lib/check_personal_numbers_read.ts";

const SCRIPT = new URL("../hooks/block-personal-numbers-read.sh", import.meta.url).pathname;
const SHIM = new URL("../hooks/agy-hook-shim.sh", import.meta.url).pathname;
// The hook runs with a fixture HOME; keep Deno on its real cache so the hook's
// imports resolve exactly as they do on the laptop.
const DENO_DIR: string = JSON.parse(
  new TextDecoder().decode(
    new Deno.Command(Deno.execPath(), { args: ["info", "--json"], stdout: "piped" }).outputSync()
      .stdout,
  ),
).denoDir;
const IS_ROOT = new TextDecoder().decode(
  new Deno.Command("id", { args: ["-u"], stdout: "piped" }).outputSync().stdout,
)
  .trim() === "0";

const FIX = Deno.makeTempDirSync({ prefix: "personal-numbers-read-" });
const HOME = path.join(FIX, "home");
Deno.mkdirSync(HOME, { recursive: true });
globalThis.addEventListener("unload", () => {
  try {
    Deno.chmodSync(path.join(FIX, "root"), 0o755);
  } catch {
    // no locked folder
  }
  Deno.removeSync(FIX, { recursive: true });
});

function put(file: string, content: string | Uint8Array): void {
  Deno.mkdirSync(path.dirname(file), { recursive: true });
  if (typeof content === "string") Deno.writeTextFileSync(file, content);
  else Deno.writeFileSync(file, content);
}

/** A one-page PDF whose text is `text`, with a correct cross-reference table. */
function pdfWithText(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

// A real JPEG header: binary, and an image, so never read.
const JPEG = new Uint8Array([
  0xff,
  0xd8,
  0xff,
  0xe0,
  0x00,
  0x10,
  0x4a,
  0x46,
  0x49,
  0x46,
  0x00,
  0x01,
]);

/** Map the design's literal paths into the fixture home. */
function local(text: string): string {
  return text.replaceAll("/home/joshua", HOME).replaceAll("/root/", `${FIX}/root/`);
}

interface Row {
  /** The call exactly as the design's table writes it. */
  call: string;
  tool: "Read" | "Bash" | "view_file" | "read_file";
  /** Read/view_file/read_file: the file; Bash: the command. */
  arg: string;
  setup: () => void;
  refuse: false | string;
  ignore?: boolean;
}

const statement = `${HOME}/Downloads/statement.ofx`;
const stub = `${HOME}/Downloads/stub.txt`;
const financial = `${HOME}/Dropbox/web-jam-llms/financial`;
const designDir = `${HOME}/Dropbox/web-jam-llms/AI_Misbehaves`;
const mainRepo = `${HOME}/WebJamApps/web-jam-tools`;
const demoWorktree = `${FIX}/tmp/agy-worktrees/web-jam-tools-demo`;

function git(args: string[]): void {
  const out = new Deno.Command("git", {
    args: ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    env: { HOME, GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "null",
    stderr: "piped",
  }).outputSync();
  if (out.code !== 0) throw new Error(new TextDecoder().decode(out.stderr));
}

/** A real repository at `dir`, made by `git init`, with one commit. */
function gitRepo(dir: string): void {
  try {
    Deno.statSync(`${dir}/.git`);
    return;
  } catch {
    // not made yet
  }
  git(["init", "-q", dir]);
  git(["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"]);
}

/** A real linked worktree of `repo` at `dir`, made by `git worktree add`. */
function worktreeOf(repo: string, dir: string): void {
  gitRepo(repo);
  try {
    Deno.statSync(`${dir}/.git`);
    return;
  } catch {
    // not made yet
  }
  git(["-C", repo, "worktree", "add", "-q", "--detach", dir]);
}

const ROWS: Row[] = [
  {
    call:
      'Read {"file_path":"/home/joshua/Dropbox/web-jam-llms/financial/books/statements/2026/truist-2026-03.csv"}',
    tool: "Read",
    arg: "/home/joshua/Dropbox/web-jam-llms/financial/books/statements/2026/truist-2026-03.csv",
    setup: () =>
      put(
        `${financial}/books/statements/2026/truist-2026-03.csv`,
        "2026-03-14,PENN STATION,22.86,202603140001\n",
      ),
    refuse: false,
  },
  {
    call: 'Read {"file_path":"/home/joshua/Downloads/statement.ofx"}',
    tool: "Read",
    arg: "/home/joshua/Downloads/statement.ofx",
    setup: () => put(statement, "<ACCTID>1234567890\n"),
    refuse: "a bank account number",
  },
  {
    call: "cat /home/joshua/Downloads/stub.txt",
    tool: "Bash",
    arg: "cat /home/joshua/Downloads/stub.txt",
    setup: () => put(stub, "SSN: 123-45-6789\n"),
    refuse: "a Social Security number",
  },
  {
    call: "head -5 ~/Downloads/statement.ofx",
    tool: "Bash",
    arg: "head -5 ~/Downloads/statement.ofx",
    setup: () => put(statement, "<BANKID>021000021\n"),
    refuse: "a routing number",
  },
  {
    call: "grep -rn PENN ~/Dropbox/web-jam-llms/financial (one file holds an account number)",
    tool: "Bash",
    arg: "grep -rn PENN ~/Dropbox/web-jam-llms/financial",
    setup: () => {
      try {
        Deno.removeSync(financial, { recursive: true });
      } catch {
        // first use
      }
      put(`${financial}/books/clean.csv`, "2026-03-14,PENN STATION,22.86,202603140001\n");
      put(`${financial}/books/notes/leak.txt`, "Account Number: 1234567890\n");
    },
    refuse: "a bank account number",
  },
  {
    call: "grep -rn PENN ~/Dropbox/web-jam-llms/financial (no file holds anything)",
    tool: "Bash",
    arg: "grep -rn PENN ~/Dropbox/web-jam-llms/financial",
    setup: () => {
      Deno.removeSync(financial, { recursive: true });
      put(`${financial}/books/clean.csv`, "2026-03-14,PENN STATION,22.86,202603140001\n");
    },
    refuse: false,
  },
  {
    call: "rg -n Truist /home/joshua/Dropbox/web-jam-llms",
    tool: "Bash",
    arg: "rg -n Truist /home/joshua/Dropbox/web-jam-llms",
    setup: () => {
      Deno.removeSync(financial, { recursive: true });
      put(`${HOME}/Dropbox/web-jam-llms/notes/cards.md`, "Truist card 4539 1488 0343 6467\n");
    },
    refuse: "a card number",
  },
  {
    call: "cat /tmp/notes.txt",
    tool: "Bash",
    arg: `cat ${FIX}/tmp/notes.txt`,
    setup: () => put(`${FIX}/tmp/notes.txt`, "Account ending in 1234\n"),
    refuse: false,
  },
  {
    call: "cat ~/WebJamApps/JaMmusic/test/checkout.test.ts",
    tool: "Bash",
    arg: "cat ~/WebJamApps/JaMmusic/test/checkout.test.ts",
    setup: () => {
      gitRepo(`${HOME}/WebJamApps/JaMmusic`);
      put(
        `${HOME}/WebJamApps/JaMmusic/test/checkout.test.ts`,
        'const card = "4539 1488 0343 6467";\n',
      );
    },
    refuse: false,
  },
  {
    call: "sed -n 1,5p /tmp/ids.md",
    tool: "Bash",
    arg: `sed -n 1,5p ${FIX}/tmp/ids.md`,
    setup: () => put(`${FIX}/tmp/ids.md`, "media id 17841400008460056\n"),
    refuse: false,
  },
  {
    call: "pdftotext ~/Downloads/paystub.pdf -",
    tool: "Bash",
    arg: "pdftotext ~/Downloads/paystub.pdf -",
    setup: () => put(`${HOME}/Downloads/paystub.pdf`, pdfWithText("123-45-6789")),
    refuse: "a Social Security number",
  },
  {
    call: 'Read {"file_path":"/home/joshua/Downloads/receipt.jpg"}',
    tool: "Read",
    arg: "/home/joshua/Downloads/receipt.jpg",
    setup: () => put(`${HOME}/Downloads/receipt.jpg`, JPEG),
    refuse: false,
  },
  {
    call: "cat /root/secret.txt",
    tool: "Bash",
    arg: "cat /root/secret.txt",
    setup: () => {
      put(`${FIX}/root/secret.txt`, "nothing here\n");
      Deno.chmodSync(`${FIX}/root`, 0o000);
    },
    refuse: "could not read",
    // root opens any file, so the guard cannot be shown failing to.
    ignore: IS_ROOT,
  },
  {
    call: 'agy view_file {"AbsolutePath":"/home/joshua/Downloads/stub.txt"}',
    tool: "view_file",
    arg: "/home/joshua/Downloads/stub.txt",
    setup: () => put(stub, "SSN: 123-45-6789\n"),
    refuse: "a Social Security number",
  },
  {
    call: 'agy read_file {"Path":"/home/joshua/Downloads/stub.txt"}',
    tool: "read_file",
    arg: "/home/joshua/Downloads/stub.txt",
    setup: () => put(stub, "SSN: 123-45-6789\n"),
    refuse: "a Social Security number",
  },
  {
    call:
      'Read {"file_path":"/home/joshua/Dropbox/web-jam-llms/AI_Misbehaves/personal-information-guards-design.md"}',
    tool: "Read",
    arg: "/home/joshua/Dropbox/web-jam-llms/AI_Misbehaves/personal-information-guards-design.md",
    setup: () =>
      put(`${designDir}/personal-information-guards-design.md`, "| `SSN: 123-45-6789` |\n"),
    refuse: false,
  },
  {
    call:
      'Read {"file_path":"/home/joshua/Dropbox/web-jam-llms/AI_Misbehaves/personal-information-guards-design.html"}',
    tool: "Read",
    arg: "/home/joshua/Dropbox/web-jam-llms/AI_Misbehaves/personal-information-guards-design.html",
    setup: () =>
      put(
        `${designDir}/personal-information-guards-design.html`,
        "<td><code>SSN: 123-45-6789</code></td>\n",
      ),
    refuse: false,
  },
  {
    call:
      'Read {"file_path":"/tmp/agy-worktrees/web-jam-tools-demo/test/detect_personal_numbers.test.ts"}',
    tool: "Read",
    arg: `${demoWorktree}/test/detect_personal_numbers.test.ts`,
    setup: () => {
      worktreeOf(mainRepo, demoWorktree);
      put(`${demoWorktree}/test/detect_personal_numbers.test.ts`, '"SSN: 123-45-6789"\n');
    },
    refuse: false,
  },
  {
    call: 'Read {"file_path":"/tmp/not-a-worktree/stub.txt"}',
    tool: "Read",
    arg: `${FIX}/tmp/not-a-worktree/stub.txt`,
    setup: () => put(`${FIX}/tmp/not-a-worktree/stub.txt`, "SSN: 123-45-6789\n"),
    refuse: "a Social Security number",
  },
  {
    call: "awk '{print $1}' /tmp/notes.txt",
    tool: "Bash",
    arg: `awk '{print $1}' ${FIX}/tmp/notes.txt`,
    setup: () => put(`${FIX}/tmp/notes.txt`, "Account ending in 1234\n"),
    refuse: false,
  },
  {
    call: 'grep "$PATTERN" /tmp/stub.txt',
    tool: "Bash",
    arg: `grep "$PATTERN" ${FIX}/tmp/stub.txt`,
    setup: () => put(`${FIX}/tmp/stub.txt`, "SSN: 123-45-6789\n"),
    refuse: "a Social Security number",
  },
  {
    call: 'cat "$UNKNOWN_FILE"',
    tool: "Bash",
    arg: 'cat "$UNKNOWN_FILE"',
    setup: () => {},
    refuse: false,
  },
  {
    call: "grep -r foo /tmp/huge-dir",
    tool: "Bash",
    arg: `grep -r foo ${FIX}/tmp/huge-dir`,
    setup: () => {
      const dir = `${FIX}/tmp/huge-dir`;
      Deno.mkdirSync(dir, { recursive: true });
      for (let i = 0; i <= MAX_SWEEP_FILES; i++) Deno.writeTextFileSync(`${dir}/f${i}.txt`, "");
    },
    refuse: "more files under it than the guard can check in time",
  },
  {
    call: "ls -la ~/Downloads",
    tool: "Bash",
    arg: "ls -la ~/Downloads",
    setup: () => put(stub, "SSN: 123-45-6789\n"),
    refuse: false,
  },
];

type Surface = "claude" | "agy" | "codex";

function payloadFor(row: Row, surface: Surface): { args: string[]; payload: unknown } {
  const arg = local(row.arg);
  const cwd = FIX;
  if (surface === "agy") {
    // agy's own tool names: the shell is run_command (mapped to Bash by the
    // shim), the file readers are view_file and read_file. Read rows reach agy
    // as view_file.
    const call = row.tool === "Bash"
      ? { name: "run_command", args: { CommandLine: arg, Cwd: cwd } }
      : row.tool === "read_file"
      ? { name: "read_file", args: { Path: arg } }
      : { name: "view_file", args: { AbsolutePath: arg } };
    // The matchers scripts/install-hooks.sh registers for agy.
    const matcher = row.tool === "Bash" ? "Bash|Read" : "view_file|read_file";
    return { args: [SHIM, "PreToolUse", btoa(matcher), SCRIPT], payload: { toolCall: call } };
  }
  const toolName = row.tool === "view_file" || row.tool === "read_file" ? "Read" : row.tool;
  const input = row.tool === "Bash" ? { command: arg } : { file_path: arg };
  return { args: [SCRIPT], payload: { tool_name: toolName, tool_input: input, cwd } };
}

async function run(row: Row, surface: Surface): Promise<{ refused: boolean; reason: string }> {
  const { args, payload } = payloadFor(row, surface);
  const child = new Deno.Command("bash", {
    args,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME,
      DENO_DIR,
      AGY_HOOK_RECORD_PATH: "off",
      WJT_SURFACE: surface,
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
  await writer.close();
  const out = await child.output();
  const stdout = new TextDecoder().decode(out.stdout);
  const stderr = new TextDecoder().decode(out.stderr);
  if (surface === "agy") {
    assertEquals(out.code, 0, stderr);
    const decision = JSON.parse(stdout);
    return { refused: decision.decision === "deny", reason: decision.reason ?? "" };
  }
  assertEquals(stdout, "", "a refusal travels on stderr only");
  assert(out.code === 0 || out.code === 2, `unexpected exit ${out.code}: ${stderr}`);
  return { refused: out.code === 2, reason: stderr };
}

for (const row of ROWS) {
  Deno.test({
    name: `read guard literal call: ${row.call} -> ${
      row.refuse ? `refuse (${row.refuse})` : "allow"
    }`,
    ignore: row.ignore,
    fn: async () => {
      row.setup();
      for (const surface of ["claude", "agy", "codex"] as const) {
        const { refused, reason } = await run(row, surface);
        assertEquals(refused, row.refuse !== false, `${surface}: ${reason}`);
        if (row.refuse) {
          assertStringIncludes(reason, row.refuse, surface);
          assert(
            !/123-45-6789|4539 1488|021000021|1234567890/.test(reason),
            `${surface} leaked the number`,
          );
        }
      }
    },
  });
}

// --- Beyond the table: the refusal wording, folders, globs and failing closed ---

Deno.test("the refusal names the kind and the file in the design's words", () => {
  put(stub, "SSN: 123-45-6789\n");
  const verdict = checkPayload(
    JSON.stringify({ tool_name: "Read", tool_input: { file_path: stub } }),
  );
  assertEquals(
    refusalFor(verdict),
    `This file holds what looks like a Social Security number: ${stub}. Personal numbers never reach an AI. Move the file into ~/Dropbox/financial-private/ and, for a bank or card download, run the cleaning command on it.`,
  );
});

Deno.test("a shell command reaches readers behind pipes, wrappers, globs, redirects and bash -c", () => {
  put(stub, "SSN: 123-45-6789\n");
  for (
    const command of [
      `echo hi | sort ${stub}`,
      `sudo cat ${stub}`,
      `bash -c "tail -n 2 ${stub}"`,
      `cat ${HOME}/Downloads/*.txt`,
      `wc -l < ${stub}`,
      `cd ${HOME}/Downloads && cat stub.txt`,
      `grep -e foo -- ${stub}`,
      `cat ${HOME}/Downloads`,
    ]
  ) {
    const verdict = checkPayload(
      JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: FIX }),
    );
    assertEquals(verdict.kind, "found", command);
  }
});

Deno.test("a command that reads nothing, or reads through no listed reader, is allowed", () => {
  put(stub, "SSN: 123-45-6789\n");
  for (
    const command of [
      `ls ${HOME}/Downloads`,
      `echo ${stub}`,
      `cat /dev/null > ${stub}.copy`,
      `cat ${FIX}/does-not-exist.txt`,
      `python3 - <<'PY'\nopen("${stub}")\nPY`,
    ]
  ) {
    const verdict = checkPayload(
      JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: FIX }),
    );
    assertEquals(verdict.kind, "allow", command);
  }
});

Deno.test("files over 5 MB and binary files are not read", () => {
  const big = `${FIX}/big/big.txt`;
  put(big, "SSN: 123-45-6789\n" + "x".repeat(5 * 1024 * 1024));
  const bin = `${FIX}/big/data.bin`;
  put(bin, new Uint8Array([0, 1, 2, ...new TextEncoder().encode("SSN: 123-45-6789")]));
  for (const file of [big, bin]) {
    const verdict = checkPayload(
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: file } }),
    );
    assertEquals(verdict.kind, "allow", file);
  }
});

Deno.test("a link inside a repository to a file outside it is checked where it points", () => {
  put(stub, "SSN: 123-45-6789\n");
  gitRepo(`${HOME}/WebJamApps/Linked`);
  const link = `${HOME}/WebJamApps/Linked/stub-link.txt`;
  try {
    Deno.removeSync(link);
  } catch {
    // first use
  }
  Deno.symlinkSync(stub, link);
  const verdict = checkPayload(
    JSON.stringify({ tool_name: "Bash", tool_input: { command: `cat ${link}` } }),
  );
  assertEquals(verdict.kind, "found");
});

Deno.test("an unreadable payload, a relative Read path or a missing command fails closed", () => {
  for (
    const raw of [
      "not json",
      "",
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: "relative.txt" } }),
      JSON.stringify({ tool_name: "Bash", tool_input: {} }),
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "cat x" }, cwd: "relative" }),
    ]
  ) {
    assertEquals(checkPayload(raw).kind, "unreadable", raw);
  }
});

Deno.test("other tools are allowed without reading anything", () => {
  const verdict = checkPayload(
    JSON.stringify({ tool_name: "Edit", tool_input: { file_path: stub } }),
  );
  assertEquals(verdict.kind, "allow");
});

/** Run `fn` with HOME pointing at the fixture home, as the hook's own process sees it. */
function withFixtureHome(fn: () => void): () => void {
  return () => {
    const real = Deno.env.get("HOME");
    Deno.env.set("HOME", HOME);
    try {
      fn();
    } finally {
      if (real === undefined) Deno.env.delete("HOME");
      else Deno.env.set("HOME", real);
    }
  };
}

Deno.test(
  "only the design document's exact paths are exempt; a sibling in its folder is checked",
  withFixtureHome(() => {
    put(`${designDir}/personal-information-guards-design.md`, "SSN: 123-45-6789\n");
    for (
      const file of [
        `${designDir}/personal-information-guards-design.md.bak`,
        `${designDir}/notes.md`,
        `${HOME}/Downloads/personal-information-guards-design.md`,
      ]
    ) {
      put(file, "SSN: 123-45-6789\n");
      const verdict = checkPayload(
        JSON.stringify({ tool_name: "Read", tool_input: { file_path: file } }),
      );
      assertEquals(verdict.kind, "found", file);
    }
  }),
);

Deno.test(
  "a link to the design document is judged on its resolved path",
  withFixtureHome(() => {
    put(`${designDir}/personal-information-guards-design.md`, "SSN: 123-45-6789\n");
    const link = `${FIX}/tmp/design-link.md`;
    Deno.mkdirSync(path.dirname(link), { recursive: true });
    try {
      Deno.removeSync(link);
    } catch {
      // first use
    }
    Deno.symlinkSync(`${designDir}/personal-information-guards-design.md`, link);
    const verdict = checkPayload(
      JSON.stringify({ tool_name: "Bash", tool_input: { command: `cat ${link}` }, cwd: FIX }),
    );
    assertEquals(verdict.kind, "allow");
  }),
);

Deno.test(
  "a folder outside ~/WebJamApps is exempt only as a worktree of a ~/WebJamApps repository",
  withFixtureHome(() => {
    const cases: Array<[string, () => void]> = [
      // a whole clone outside ~/WebJamApps: `.git` is a folder, not a worktree's file
      ["clone", () => gitRepo(`${FIX}/tmp/clone`)],
      // a worktree of a repository outside ~/WebJamApps
      ["elsewhere", () => worktreeOf(`${FIX}/other-repo`, `${FIX}/tmp/elsewhere`)],
      // a `.git` file whose gitdir does not exist
      [
        "dangling",
        () => put(`${FIX}/tmp/dangling/.git`, `gitdir: ${mainRepo}/.git/worktrees/missing\n`),
      ],
      // a gitdir inside ~/WebJamApps but not under <repo>/.git/worktrees/
      [
        "not-worktrees",
        () => {
          gitRepo(mainRepo);
          Deno.mkdirSync(`${mainRepo}/.git/modules/x`, { recursive: true });
          put(`${FIX}/tmp/not-worktrees/.git`, `gitdir: ${mainRepo}/.git/modules/x\n`);
        },
      ],
      // a real worktree's `.git` file copied into another folder: its
      // worktree's gitdir points back at the real worktree, not this folder
      [
        "copied",
        () => {
          worktreeOf(mainRepo, demoWorktree);
          put(`${FIX}/tmp/copied/.git`, Deno.readTextFileSync(`${demoWorktree}/.git`));
        },
      ],
      // a gitdir that climbs out of .git/worktrees/ with ..
      [
        "climbs",
        () => {
          Deno.mkdirSync(`${FIX}/outside`, { recursive: true });
          put(
            `${FIX}/tmp/climbs/.git`,
            `gitdir: ${mainRepo}/.git/worktrees/../../../../../outside\n`,
          );
        },
      ],
    ];
    for (const [name, setup] of cases) {
      setup();
      const file = `${FIX}/tmp/${name}/test/stub.txt`;
      put(file, "SSN: 123-45-6789\n");
      const verdict = checkPayload(
        JSON.stringify({ tool_name: "Read", tool_input: { file_path: file } }),
      );
      assertEquals(verdict.kind, "found", name);
    }
  }),
);

Deno.test(
  "a folder sweep inside a worktree of a ~/WebJamApps repository is passed over",
  withFixtureHome(() => {
    worktreeOf(mainRepo, demoWorktree);
    put(`${demoWorktree}/test/detect_personal_numbers.test.ts`, '"SSN: 123-45-6789"\n');
    const verdict = checkPayload(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: `grep -rn SSN ${demoWorktree}` },
        cwd: FIX,
      }),
    );
    assertEquals(verdict.kind, "allow");
  }),
);

// --- Review of 2026-11-21: links, real working trees, search roots and the budget ---

function shell(command: string, cwd = FIX) {
  return checkPayload(JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }));
}

function relink(target: string, link: string): void {
  Deno.mkdirSync(path.dirname(link), { recursive: true });
  try {
    Deno.removeSync(link);
  } catch {
    // first use
  }
  Deno.symlinkSync(target, link);
}

Deno.test(
  "a reader that follows links has each link inside a working tree checked where it points",
  withFixtureHome(() => {
    put(stub, "SSN: 123-45-6789\n");
    const repo = `${HOME}/WebJamApps/LinkRepo`;
    gitRepo(repo);
    relink(stub, `${repo}/docs/stub-link.txt`);
    relink(`${HOME}/Downloads`, `${repo}/downloads-link`);
    for (
      const command of [
        `grep -R foo ${repo}`,
        `grep --dereference-recursive foo ${repo}`,
        `rg -L foo ${repo}`,
        `rg --follow foo ${repo}`,
      ]
    ) {
      assertEquals(shell(command).kind, "found", command);
    }
    // grep -r and rg do not follow a link they meet inside a folder, so they read
    // only the tree's own files, all inside the working tree.
    for (const command of [`grep -r foo ${repo}`, `rg foo ${repo}`]) {
      assertEquals(shell(command).kind, "allow", command);
    }
  }),
);

Deno.test(
  "a linked folder outside any working tree is walked only for a reader that follows links",
  withFixtureHome(() => {
    put(stub, "SSN: 123-45-6789\n");
    const dir = `${FIX}/tmp/linked-folder`;
    put(`${dir}/clean.txt`, "nothing here\n");
    relink(`${HOME}/Downloads`, `${dir}/downloads`);
    assertEquals(shell(`grep -R foo ${dir}`).kind, "found");
    assertEquals(shell(`grep -r foo ${dir}`).kind, "allow");
  }),
);

Deno.test(
  "a link back up the tree ends the walk instead of looping",
  withFixtureHome(() => {
    const dir = `${FIX}/tmp/cycle`;
    put(`${dir}/clean.txt`, "nothing here\n");
    relink(dir, `${dir}/sub/loop`);
    assertEquals(shell(`grep -R foo ${dir}`).kind, "allow");
    put(`${dir}/sub/leak.txt`, "SSN: 123-45-6789\n");
    assertEquals(shell(`grep -R foo ${dir}`).kind, "found");
  }),
);

Deno.test(
  "a folder walked without following links is walked again for a later reader that follows them",
  withFixtureHome(() => {
    put(stub, "SSN: 123-45-6789\n");
    const dir = `${FIX}/tmp/mixed-walk`;
    put(`${dir}/clean.txt`, "nothing here\n");
    relink(`${HOME}/Downloads`, `${dir}/downloads`);
    const repo = `${HOME}/WebJamApps/MixedRepo`;
    gitRepo(repo);
    relink(stub, `${repo}/docs/stub-link.txt`);
    for (
      const command of [
        `grep -r foo ${dir}; grep -R foo ${dir}`,
        `grep -r foo ${dir} && rg -L foo ${dir}`,
        `grep -r foo ${dir}; bash -c "grep -R foo ${dir}"`,
        `rg foo ${repo}; grep -R foo ${repo}`,
        `grep -R foo ${dir}; grep -r foo ${dir}`,
      ]
    ) {
      assertEquals(shell(command).kind, "found", command);
    }
    // A plain walk after another plain walk of the same folder still allows.
    assertEquals(shell(`grep -r foo ${dir}; grep -r bar ${dir}`).kind, "allow");
  }),
);

Deno.test(
  "under ~/WebJamApps only a real repository's .git makes a working tree",
  withFixtureHome(() => {
    const cases: Array<[string, () => void]> = [
      // an empty folder named .git
      ["EmptyGit", () => Deno.mkdirSync(`${HOME}/WebJamApps/EmptyGit/.git`, { recursive: true })],
      // a file named .git holding nothing git wrote
      ["FileGit", () => put(`${HOME}/WebJamApps/FileGit/.git`, "not git\n")],
      // a .git file pointing at a repository's own .git, not at a worktree of it
      [
        "PointsAtRepo",
        () => {
          gitRepo(mainRepo);
          put(`${HOME}/WebJamApps/PointsAtRepo/.git`, `gitdir: ${mainRepo}/.git\n`);
        },
      ],
      // a .git folder that is a link to a real repository's .git
      [
        "LinkedGit",
        () => {
          gitRepo(mainRepo);
          relink(`${mainRepo}/.git`, `${HOME}/WebJamApps/LinkedGit/.git`);
        },
      ],
    ];
    for (const [name, setup] of cases) {
      setup();
      const file = `${HOME}/WebJamApps/${name}/test/stub.txt`;
      put(file, "SSN: 123-45-6789\n");
      const verdict = checkPayload(
        JSON.stringify({ tool_name: "Read", tool_input: { file_path: file } }),
      );
      assertEquals(verdict.kind, "found", name);
    }
    // A real repository, and a real worktree under ~/WebJamApps (as .claude/worktrees/ is).
    gitRepo(`${HOME}/WebJamApps/RealRepo`);
    worktreeOf(mainRepo, `${mainRepo}/.claude/worktrees/inner`);
    for (
      const file of [
        `${HOME}/WebJamApps/RealRepo/test/stub.txt`,
        `${mainRepo}/.claude/worktrees/inner/test/stub.txt`,
      ]
    ) {
      put(file, "SSN: 123-45-6789\n");
      const verdict = checkPayload(
        JSON.stringify({ tool_name: "Read", tool_input: { file_path: file } }),
      );
      assertEquals(verdict.kind, "allow", file);
    }
  }),
);

Deno.test(
  "grep -r and rg search the folder they run in when given no input, whatever the pattern names",
  withFixtureHome(() => {
    const cwd = `${FIX}/tmp/search-cwd`;
    put(`${cwd}/leak.txt`, "SSN: 123-45-6789\n");
    // A file named like the pattern must not stand in for an input.
    put(`${cwd}/PENN`, "nothing here\n");
    for (
      const command of [
        "grep -r PENN",
        "grep -rn PENN",
        "grep -r -e PENN",
        "grep -r --regexp=PENN",
        "grep -rA 3 PENN",
        "grep -r --include '*.txt' PENN",
        "rg PENN",
        "rg -g '*.txt' PENN",
        "rg -e PENN",
      ]
    ) {
      assertEquals(shell(command, cwd).kind, "found", command);
    }
  }),
);

Deno.test(
  "an input given to grep -r or rg is searched instead of the folder they run in",
  withFixtureHome(() => {
    const cwd = `${FIX}/tmp/search-cwd`;
    put(`${cwd}/leak.txt`, "SSN: 123-45-6789\n");
    const clean = `${FIX}/tmp/search-clean`;
    put(`${clean}/notes.txt`, "PENN STATION 22.86\n");
    for (
      const command of [
        `grep -r PENN ${clean}`,
        `grep -rA 3 PENN ${clean}`,
        `grep -r -e PENN ${clean}`,
        `rg -g '*.md' PENN ${clean}`,
        `rg PENN ${clean}`,
      ]
    ) {
      assertEquals(shell(command, cwd).kind, "allow", command);
    }
  }),
);

Deno.test(
  "a pattern or ignore file grep or rg reads is checked",
  withFixtureHome(() => {
    const patterns = `${FIX}/tmp/patterns.txt`;
    put(patterns, "123-45-6789\n");
    const clean = `${FIX}/tmp/search-clean`;
    put(`${clean}/notes.txt`, "PENN STATION 22.86\n");
    for (
      const command of [
        `grep -f ${patterns} ${clean}/notes.txt`,
        `grep -rf ${patterns} ${clean}`,
        `grep --file=${patterns} ${clean}/notes.txt`,
        `rg -f ${patterns} ${clean}`,
        `rg --ignore-file ${patterns} PENN ${clean}`,
      ]
    ) {
      assertEquals(shell(command).kind, "found", command);
    }
  }),
);

Deno.test("a check that runs past the budget on the last file refuses rather than allows", () => {
  const file = `${FIX}/tmp/budget/clean.txt`;
  put(file, "nothing here\n");
  // Within the budget for the sweep's start and checkPath's own check; past it
  // when checkFile finishes.
  let calls = 0;
  const sweep = newSweep(8_000, () => (++calls >= 3 ? 10_000 : 0));
  const verdict = checkPath(file, sweep);
  assertEquals(verdict.kind, "unreadable");
  assertStringIncludes(refusalFor(verdict) ?? "", "could not finish checking it in time");
  // The same file with time to spare is allowed.
  assertEquals(checkPath(file, newSweep()).kind, "allow");
});

Deno.test("a folder walk that runs past the budget refuses, naming the folder", () => {
  const dir = `${FIX}/tmp/budget-dir`;
  Deno.mkdirSync(`${dir}/a`, { recursive: true });
  let calls = 0;
  // Within the budget for the sweep's start, checkPath and the walk's one entry;
  // past it when the empty subfolder's walk ends.
  const sweep = newSweep(8_000, () => (++calls >= 4 ? 10_000 : 0));
  const verdict = checkPath(dir, sweep);
  assertEquals(verdict.kind, "unreadable");
  assertStringIncludes(refusalFor(verdict) ?? "", dir);
  assertStringIncludes(refusalFor(verdict) ?? "", "than the guard can check in time");
});

Deno.test("a PDF conversion is stopped at the end of the budget and refuses", () => {
  const bin = `${FIX}/slow-bin`;
  put(`${bin}/pdftotext`, "#!/bin/sh\nsleep 5\n");
  Deno.chmodSync(`${bin}/pdftotext`, 0o755);
  const pdf = `${FIX}/tmp/slow.pdf`;
  put(pdf, pdfWithText("nothing here"));
  const realPath = Deno.env.get("PATH") ?? "/usr/bin:/bin";
  Deno.env.set("PATH", `${bin}:${realPath}`);
  try {
    const started = Date.now();
    const verdict = checkPath(pdf, newSweep(300));
    assertEquals(verdict.kind, "unreadable");
    assertStringIncludes(refusalFor(verdict) ?? "", "could not finish checking it in time");
    assert(Date.now() - started < 3_000, "the slow conversion was not cut off");
  } finally {
    Deno.env.set("PATH", realPath);
  }
});
