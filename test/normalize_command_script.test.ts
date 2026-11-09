import { assertEquals } from "@std/assert";
import {
  findHeredocMarker,
  type InterpreterScript,
  readInterpreterHeredocs,
  readInterpreterScript,
  splitShellTokens,
} from "../hooks/lib/normalize_command.ts";

const file = (path: string): InterpreterScript => ({ kind: "file", path });
const code = (code: string): InterpreterScript => ({ kind: "inline", code });
const stdin: InterpreterScript = { kind: "heredoc" };
const designPath = "/home/joshua/Dropbox/web-jam-llms/AI_Misbehaves/hooks-design-2026-09-15.md";
const rows: Array<{
  command: string;
  script: InterpreterScript | null;
  args?: string[];
  preloads?: string[];
  language?: string;
}> = [
  { command: "python3 /tmp/s.py a.md", script: file("/tmp/s.py"), args: ["a.md"] },
  { command: "python3 -I -u /tmp/s.py", script: file("/tmp/s.py") },
  { command: "python3 -W ignore /tmp/s.py", script: file("/tmp/s.py") },
  { command: "python3 -X dev /tmp/s.py", script: file("/tmp/s.py") },
  { command: "python3 --check-hash-based-pycs never /tmp/s.py", script: file("/tmp/s.py") },
  { command: "/usr/bin/python3 /tmp/s.py", script: file("/tmp/s.py") },
  {
    command: `python3 - ${designPath} <<'EOF'\nprint(1)\nEOF`,
    script: stdin,
    args: [designPath],
    language: "python",
  },
  { command: "python3 <<'EOF'\nprint(1)\nEOF", script: stdin, language: "python" },
  { command: "python3 -c 'print(1)' a.md", script: code("print(1)"), args: ["a.md"] },
  { command: "python3 -m http.server 8000", script: null, args: ["8000"] },
  { command: "python3 --help", script: null },
  { command: "python3 --version", script: null },
  { command: "node /tmp/x.js a", script: file("/tmp/x.js"), args: ["a"] },
  { command: "node -r ./pre.js /tmp/x.js", script: file("/tmp/x.js"), preloads: ["./pre.js"] },
  {
    command: "node --require ./pre.js /tmp/x.js",
    script: file("/tmp/x.js"),
    preloads: ["./pre.js"],
  },
  {
    command: "node --import ./pre.mjs /tmp/x.js",
    script: file("/tmp/x.js"),
    preloads: ["./pre.mjs"],
  },
  { command: "node -r dotenv/config /tmp/x.js", script: file("/tmp/x.js") },
  { command: "node --env-file e.env /tmp/x.js", script: file("/tmp/x.js") },
  { command: "node -C dev /tmp/x.js", script: file("/tmp/x.js") },
  { command: "node -e 'console.log(1)'", script: code("console.log(1)") },
  { command: "node --eval='console.log(1)'", script: code("console.log(1)") },
  { command: "node -p '1+1'", script: code("1+1") },
  {
    command: "node --input-type=module <<'JS'\nconsole.log(1);\nJS",
    script: stdin,
    language: "javascript",
  },
  { command: "node - <<'JS'\nconsole.log(1);\nJS", script: stdin, language: "javascript" },
  { command: "node --version", script: null },
  { command: "deno run -A /tmp/s.ts a.md", script: file("/tmp/s.ts"), args: ["a.md"] },
  {
    command: "deno run --config deno.json --allow-read --allow-env /tmp/sim.ts",
    script: file("/tmp/sim.ts"),
  },
  { command: "deno run -c deno.json /tmp/sim.ts", script: file("/tmp/sim.ts") },
  { command: "deno run --lock lk.json main.ts", script: file("main.ts") },
  { command: "deno run --lock=lk.json main.ts", script: file("main.ts") },
  { command: "deno run --import-map map.json /tmp/s.ts", script: file("/tmp/s.ts") },
  { command: "deno run --preload pre.js main.js", script: file("main.js"), preloads: ["pre.js"] },
  { command: "deno run --allow-read=/tmp /tmp/s.ts", script: file("/tmp/s.ts") },
  { command: "deno run --check /tmp/s.ts", script: file("/tmp/s.ts") },
  { command: "deno run --env-file=.env.test /tmp/s.ts", script: file("/tmp/s.ts") },
  { command: "deno run --v8-flags=--max-old-space-size=8000 /tmp/s.ts", script: file("/tmp/s.ts") },
  { command: "deno run - <<'TS'\nconsole.log(1);\nTS", script: stdin, language: "typescript" },
  { command: "deno eval 'console.log(1)'", script: code("console.log(1)") },
  { command: "deno run --help", script: null },
  { command: "deno task design:lint-doc /tmp/x-design.md", script: null },
];

for (const row of rows) {
  Deno.test(row.command.replaceAll("\n", "\\n"), () => {
    const header = row.command.split("\n")[0];
    const result = readInterpreterScript(
      splitShellTokens(header),
      findHeredocMarker(header) !== null,
    );
    assertEquals(result?.script ?? null, row.script);
    assertEquals(result?.preloads ?? [], row.preloads ?? []);
    assertEquals(result?.args ?? [], row.args ?? []);
    if (row.language) assertEquals(result?.language, row.language);
  });
}

Deno.test("Deno equals-only flags never consume the following script", () => {
  for (
    const flag of [
      "--check",
      "--watch",
      "--hmr",
      "--watch-exclude",
      "--env-file",
      "--coverage",
      "--no-check",
      "--node-modules-dir",
      "--vendor",
      "-r",
      "--reload",
      "--frozen-lockfile",
      "--unsafely-ignore-certificate-errors",
      "--inspect",
      "--inspect-brk",
      "--inspect-wait",
      "--v8-flags",
      "--allow-scripts",
      "-P",
      "--permission-set",
      "--allow-read",
      "--deny-write",
      "--ignore-certificate-errors",
    ]
  ) {
    assertEquals(
      readInterpreterScript(["deno", "run", flag, "e.env", "main.ts"])?.script,
      file("e.env"),
      flag,
    );
    assertEquals(
      readInterpreterScript(["deno", "run", `${flag}=value`, "main.ts"])?.script,
      file("main.ts"),
      flag,
    );
  }
});

Deno.test("script arguments never become options or preloads", () => {
  for (const prefix of [["python3"], ["node"], ["deno", "run"]]) {
    const result = readInterpreterScript([...prefix, "main", "-e", "data", "--require", "./data"]);
    assertEquals(result?.script, file("main"));
    assertEquals(result?.args, ["-e", "data", "--require", "./data"]);
    assertEquals(result?.preloads, []);
  }
});

Deno.test("value flags and preloads support detached, attached and equals spellings", () => {
  assertEquals(
    readInterpreterScript([
      "node",
      "--title",
      "fixture",
      "--require=./pre.js",
      "-r./other.js",
      "-e",
      "run()",
      "data",
    ])?.preloads,
    ["./pre.js", "./other.js"],
  );
  assertEquals(
    readInterpreterScript(["deno", "run", "--preload=pre.js", "--require", "other.js", "main.ts"])
      ?.preloads,
    ["pre.js", "other.js"],
  );
  assertEquals(
    readInterpreterScript(["python", "-Wignore", "-Xdev", "-Bc", "print(1)"])?.script,
    code("print(1)"),
  );
  assertEquals(
    readInterpreterScript(["node", "--loader", "./loader.mjs", "-pe", "1+1"])?.script,
    code("1+1"),
  );
  assertEquals(
    readInterpreterScript(["deno", "eval", "--ext", "ts", "console.log(1)", "data"])?.args,
    ["data"],
  );
});

Deno.test("heredoc selection keeps stdin code separate from scripts, modules, inline code and data", () => {
  for (
    const header of [
      "python3 file.py <<EOF",
      "node -e 'console.log(1)' <<EOF",
      "python3 -m http.server <<EOF",
      "python3 --help <<EOF",
      "deno task test <<EOF",
      "cat <<EOF",
    ]
  ) {
    assertEquals(readInterpreterHeredocs(header), [], header);
  }
  assertEquals(
    readInterpreterHeredocs("cat <<EOF | /usr/bin/node --input-type=module")[0]?.language,
    "javascript",
  );
  assertEquals(readInterpreterHeredocs("env FOO=bar python3 - <<EOF")[0]?.language, "python");
});
