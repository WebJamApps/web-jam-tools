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
import { checkPayload, refusalFor } from "../hooks/lib/check_personal_numbers_read.ts";

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
  tool: "Read" | "Bash" | "view_file";
  /** Read/view_file: the file; Bash: the command. */
  arg: string;
  setup: () => void;
  refuse: false | string;
  ignore?: boolean;
}

const statement = `${HOME}/Downloads/statement.ofx`;
const stub = `${HOME}/Downloads/stub.txt`;
const financial = `${HOME}/Dropbox/web-jam-llms/financial`;

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
      Deno.mkdirSync(`${HOME}/WebJamApps/JaMmusic/.git`, { recursive: true });
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
    // shim), the file reader is view_file. Read rows reach agy as view_file.
    const call = row.tool === "Bash"
      ? { name: "run_command", args: { CommandLine: arg, Cwd: cwd } }
      : { name: "view_file", args: { AbsolutePath: arg } };
    // The matchers scripts/install-hooks.sh registers for agy.
    const matcher = row.tool === "Bash" ? "Bash|Read" : "view_file";
    return { args: [SHIM, "PreToolUse", btoa(matcher), SCRIPT], payload: { toolCall: call } };
  }
  const toolName = row.tool === "view_file" ? "Read" : row.tool;
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
  Deno.mkdirSync(`${HOME}/WebJamApps/Linked/.git`, { recursive: true });
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
