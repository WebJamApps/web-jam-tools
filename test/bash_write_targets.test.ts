// bash_write_targets.test.ts — the files a Bash command writes, as hooks/opus-delegation-gate.sh
// judges them (hooks/lib/bash_write_targets.ts).

import { assertEquals } from "@std/assert";
import {
  analyzeBashWrites,
  bashWriteTargets,
  redirectTargets,
  resolvePath,
  scriptWriteTargets,
  withoutRedirections,
} from "../hooks/lib/bash_write_targets.ts";

const CWD = "/repo";
const HOME = "/home/j";
const targets = (command: string) => bashWriteTargets(command, { cwd: CWD, home: HOME });

Deno.test("subshell cd does not persist into the following command (web-jam-tools#1819)", () => {
  assertEquals(targets("(cd /tmp && echo a > f); echo b > g"), ["/tmp/f", "/repo/g"]);
});

Deno.test("cd || exit/return resolves following writes to cd target; non-exiting || goes unknown", () => {
  assertEquals(analyzeBashWrites("cd /repo || exit 1; echo x > f", { cwd: "/w", home: HOME }), {
    targets: ["/repo/f"],
    replacedEntries: [],
    unknownFiles: [],
    unknownDirectory: false,
  });
  assertEquals(
    analyzeBashWrites("cd /repo || { echo no; exit 1; }\necho x > f", { cwd: "/w", home: HOME }),
    {
      targets: ["/repo/f"],
      replacedEntries: [],
      unknownFiles: [],
      unknownDirectory: false,
    },
  );
  assertEquals(analyzeBashWrites("cd /repo || echo no; echo x > f", { cwd: "/w", home: HOME }), {
    targets: [],
    replacedEntries: [],
    unknownFiles: [],
    unknownDirectory: true,
  });
});

Deno.test("Root cause 2: a heredoc keeps its own unknown cwd despite a later repository cd", () => {
  const command =
    "S=/tmp/scratch/memsim; cd $S && python3 - <<'EOF'\np = 'out.txt'\nopen(p,'w').write('x')\nEOF\ncd /repo && deno task memory-index --dir $S";
  assertEquals(analyzeBashWrites(command, { cwd: "/tmp/scratch", home: HOME }), {
    targets: [],
    replacedEntries: [],
    unknownFiles: [],
    unknownDirectory: true,
  });
  assertEquals(bashWriteTargets(command, { cwd: "/tmp/scratch", home: HOME }), []);
});

Deno.test("third root cause: unresolved cd clears cwd; literal and function-body cd controls resolve", () => {
  assertEquals(
    analyzeBashWrites('S=/tmp/scratch; cd $S/mut; echo "// x" >> test/memory_index.test.ts', {
      cwd: CWD,
      home: HOME,
    }),
    {
      targets: [],
      replacedEntries: [],
      unknownFiles: [],
      unknownDirectory: true,
    },
  );
  for (
    const command of [
      'cd /tmp/scratch/mut; echo "// x" >> test/memory_index.test.ts',
      'f() { cd /tmp/scratch/mut; echo "// x" >> test/memory_index.test.ts; }; f',
    ]
  ) assertEquals(targets(command), ["/tmp/scratch/mut/test/memory_index.test.ts"]);
});

Deno.test("Case B: a once-assigned script variable names its scratch file", () => {
  assertEquals(
    targets(
      "python3 - <<'EOF'\np = '/tmp/claude-1000/s/scratchpad/1309-new.md'\nopen(p,'w').write('x')\nEOF",
    ),
    ["/tmp/claude-1000/s/scratchpad/1309-new.md"],
  );
});

Deno.test("a later cd on the marker line cannot move the heredoc; a child shell cd stays local", () => {
  assertEquals(targets("cd /tmp; python3 - <<'PY'; cd /repo\nopen('out','w')\nPY"), ["/tmp/out"]);
  assertEquals(targets("bash <<'SH'\ncd /tmp; echo x > child\nSH\necho y > parent"), [
    "/tmp/child",
    "/repo/parent",
  ]);
});

Deno.test("script file naming: argument aliases, reassignment, comments and unrelated arguments", () => {
  for (
    const command of [
      `python3 -c 'import sys; p = sys.argv[1]; open(p,"w")' /tmp/a.md`,
      `node -e 'const p = process.argv[2]; fs.writeFileSync(p,"x")' - /tmp/a.md`,
      `deno eval 'const p = Deno.args[0]; Deno.writeTextFileSync(p,"x")' /tmp/a.md`,
    ]
  ) assertEquals(targets(command), ["/tmp/a.md"], command);
  assertEquals(targets(`python3 -c 'p = "/tmp/a"; p += "b"; open(p,"w")'`), [CWD]);
  assertEquals(targets(`python3 -c 'p = "/tmp/a"; p = "AGENTS.md"; open(p,"w")'`), [CWD]);
  assertEquals(targets(`python3 -c 'open(p,"w"); p = "/tmp/a"'`), [CWD]);
  assertEquals(targets(`python3 -c 'import sys; open(sys.argv[1],"w")' "$HOME/a"`), [CWD]);
  assertEquals(targets(`python3 -c 'p = "/tmp/a"; open(p,"w") # p = "AGENTS.md"'`), ["/tmp/a"]);
  assertEquals(targets(`python3 main.py -c 'open("AGENTS.md","w")'`), []);
  assertEquals(targets("cd $S; echo x > /tmp/a; cd /repo && echo x > b"), ["/tmp/a", "/repo/b"]);
});

Deno.test("shared script selection: only executed inline and stdin code names write targets", () => {
  assertEquals(targets(`python3 -W ignore -c "open('out', 'w')"`), ["/repo/out"]);
  assertEquals(targets(`node --title fixture --eval="fs.writeFileSync('out', 'x')"`), [
    "/repo/out",
  ]);
  assertEquals(targets(`deno eval --ext ts "Deno.writeTextFileSync('out', 'x')" data`), [
    "/repo/out",
  ]);
  for (
    const command of [
      `python3 main.py -c "open('data', 'w')"`,
      `node main.js -e "fs.writeFileSync('data','x')"`,
      `deno run --config deno.json main.ts -e "Deno.writeTextFileSync('data','x')"`,
      `python3 --help <<'PY'\nopen('data','w')\nPY`,
      `python3 main.py <<'PY'\nopen('data','w')\nPY`,
      `node -e 'console.log(1)' <<'JS'\nfs.writeFileSync('data','x')\nJS`,
    ]
  ) assertEquals(targets(command), [], command);
  assertEquals(targets(`python3 - data.md <<'PY'\nopen('out','w')\nPY`), ["/repo/out"]);
  assertEquals(targets(`node --input-type=module <<'JS'\nfs.writeFileSync('out','x')\nJS`), [
    "/repo/out",
  ]);
  assertEquals(targets(`deno <<'TS'\nDeno.writeTextFileSync('out','x')\nTS`), ["/repo/out"]);
  assertEquals(targets(`deno repl <<'TS'\nDeno.writeTextFileSync('out','x')\nTS`), ["/repo/out"]);
  assertEquals(targets(`python3 -m code <<'PY'\nopen('out','w')\nPY`), ["/repo/out"]);
});

Deno.test("resolvePath: relative, absolute, ~, $HOME, dot segments, and unknown variables", () => {
  assertEquals(resolvePath("src/a.ts", CWD, HOME), "/repo/src/a.ts");
  assertEquals(resolvePath("/tmp/x", CWD, HOME), "/tmp/x");
  assertEquals(resolvePath("~/notes.md", CWD, HOME), "/home/j/notes.md");
  assertEquals(resolvePath("${HOME}/a", CWD, HOME), "/home/j/a");
  assertEquals(resolvePath("$HOME", CWD, HOME), "/home/j");
  // A ".." is kept: the kernel resolves it after any symlink before it.
  assertEquals(resolvePath("./a/../b/./c", CWD, HOME), "/repo/a/../b/c");
  assertEquals(resolvePath("$TMPDIR/x", CWD, HOME), null);
  assertEquals(resolvePath("$(pwd)/x", CWD, HOME), null);
  assertEquals(resolvePath("", CWD, HOME), null);
});

Deno.test("redirectTargets and withoutRedirections: files, not fd duplication or quoted text", () => {
  assertEquals(redirectTargets("echo x > a.ts"), ["a.ts"]);
  assertEquals(redirectTargets("echo x >>a.ts 2>/dev/null"), ["a.ts"]);
  assertEquals(redirectTargets("cmd &> out.log"), ["out.log"]);
  assertEquals(redirectTargets("cmd >| forced"), ["forced"]);
  assertEquals(redirectTargets("echo hi 2>&1 >&2"), []);
  assertEquals(redirectTargets(`echo "a > b" 'c > d' \\> e`), []);
  assertEquals(redirectTargets("cat <> f"), []);
  assertEquals(redirectTargets(`echo "esc \\" > x"`), []);
  assertEquals(redirectTargets("ls > /dev/null > /dev/stderr"), []);
  assertEquals(withoutRedirections(["tee", "f", ">", "/dev/null", "2>&1", "<", "in", "<<EOF"]), [
    "tee",
    "f",
  ]);
});

Deno.test("scriptWriteTargets: literal paths, variable paths judged by cwd, and reads ignored", () => {
  assertEquals(scriptWriteTargets("open('a.ts', 'w')", CWD, HOME), ["/repo/a.ts"]);
  assertEquals(scriptWriteTargets("open(p, mode='a')", CWD, HOME), [CWD]);
  assertEquals(scriptWriteTargets("open('a.ts')\nopen('b', 'rb')", CWD, HOME), []);
  assertEquals(scriptWriteTargets("Path('x/y.md').write_text('z')", CWD, HOME), ["/repo/x/y.md"]);
  assertEquals(scriptWriteTargets("p.write_bytes(b)", CWD, HOME), [CWD]);
  assertEquals(scriptWriteTargets("shutil.move(a, b)", CWD, HOME), [CWD]);
  assertEquals(scriptWriteTargets("fs.writeFileSync('/tmp/o', s)", CWD, HOME), ["/tmp/o"]);
  assertEquals(scriptWriteTargets("await Deno.writeTextFile(`hooks/a`, s)", CWD, HOME), [
    "/repo/hooks/a",
  ]);
  assertEquals(scriptWriteTargets(`open(FH, ">out.txt")`, CWD, HOME), ["/repo/out.txt"]);
  assertEquals(scriptWriteTargets(`File.write("r.rb", s)`, CWD, HOME), ["/repo/r.rb"]);
  assertEquals(scriptWriteTargets(`File.open(f, "w")`, CWD, HOME), [CWD]);
  assertEquals(scriptWriteTargets("console.log(fs.readFileSync('a'))", CWD, HOME), []);
});

Deno.test("heredoc receivers: interpreter and shell writes are inspected; data bodies are ignored", () => {
  assertEquals(targets("python3.11 - <<EOF\nopen('a','w')\nEOF"), ["/repo/a"]);
  assertEquals(targets("nodejs <<EOF\nfs.writeFileSync('a','x')\nEOF"), ["/repo/a"]);
  assertEquals(targets("perl <<EOF\nopen(FH, '>a');\nEOF"), ["/repo/a"]);
  assertEquals(targets("ruby <<EOF\nFile.write('a','x')\nEOF"), ["/repo/a"]);
  assertEquals(targets("cat <<EOF | /usr/bin/node\nfs.writeFileSync('a', 'x')\nEOF"), ["/repo/a"]);
  assertEquals(targets("bash <<EOF\necho x > f\nEOF"), ["/repo/f"]);
  assertEquals(targets("cat > notes.md <<'EOF'\n> quoted\nEOF\necho done"), ["/repo/notes.md"]);
  assertEquals(targets("cat <<-EOF\n\tbody\n\tEOF"), []);
});

Deno.test("bashWriteTargets: the shapes Josh's gate must refuse", () => {
  assertEquals(targets("python3 - <<'EOF'\nopen('hooks/x.ts','w')\nEOF"), ["/repo/hooks/x.ts"]);
  assertEquals(targets("sed -i 's/a/b/' src/a.ts"), ["/repo/src/a.ts"]);
  assertEquals(targets("echo x > src/a.ts"), ["/repo/src/a.ts"]);
  assertEquals(targets("cat foo | tee -a src/a.ts > /dev/null"), ["/repo/src/a.ts"]);
});

Deno.test("bashWriteTargets: in-place editors, copies, moves and patches", () => {
  assertEquals(targets("sed -i.bak -e 's/a/b/' a b"), ["/repo/a", "/repo/b"]);
  assertEquals(targets("sed --in-place 's/a/b/' a"), ["/repo/a"]);
  assertEquals(targets("sed -n 's/a/b/p' a"), []);
  assertEquals(targets("perl -pi -e 's/a/b/' a.ts"), ["/repo/a.ts"]);
  assertEquals(targets("perl -i script.pl a.ts"), ["/repo/a.ts"]);
  assertEquals(targets("perl -MFile::Spec -ne 'print' a.ts"), []);
  assertEquals(targets("perl -e 'open(F, \">o\")'"), ["/repo/o"]);
  assertEquals(targets("cp -r a b/c"), ["/repo/b/c"]);
  assertEquals(targets("mv -t dest a b"), ["/repo/dest/a", "/repo/dest/b", "/repo/a", "/repo/b"]);
  assertEquals(targets("install --target-directory=/tmp/d a"), ["/tmp/d/a"]);
  assertEquals(targets("install -m 755 a /usr/local/bin/a"), ["/usr/local/bin/a"]);
  assertEquals(targets("cp onlyone"), []);
  assertEquals(targets("truncate -s 0 log.txt"), ["/repo/log.txt"]);
  assertEquals(targets("dd if=/dev/zero of=disk.img bs=1M"), ["/repo/disk.img"]);
  assertEquals(targets("patch -p1 < fix.diff"), [CWD]);
  assertEquals(targets("patch -d sub -p1"), ["/repo/sub"]);
  assertEquals(targets("patch -o out.ts a.ts fix.diff"), ["/repo/out.ts"]);
  assertEquals(targets("patch --dry-run -p1"), []);
  assertEquals(targets("git apply fix.diff"), [CWD]);
  assertEquals(targets("git -c core.x=y -C /other apply fix.diff"), ["/other"]);
  assertEquals(targets("git apply --check fix.diff"), []);
});

Deno.test("analyzeBashWrites: a write that replaces the entry is kept apart from one written through it", () => {
  const split = (command: string) => {
    const { targets, replacedEntries } = analyzeBashWrites(command, { cwd: CWD, home: HOME });
    return { targets, replacedEntries };
  };
  const through = (...targets: string[]) => ({ targets, replacedEntries: [] });
  const replaced = (...replacedEntries: string[]) => ({ targets: [], replacedEntries });
  const either = (path: string) => ({ targets: [path], replacedEntries: [path] });

  assertEquals(split("sed -i 's/a/b/' link.ts"), replaced("/repo/link.ts"));
  assertEquals(split("sed --follow-symlinks -i 's/a/b/' link.ts"), through("/repo/link.ts"));
  assertEquals(split("perl -pi -e 's/a/b/' a.ts"), replaced("/repo/a.ts"));
  assertEquals(split("perl -i -e 'open(F, \">o\")' a.ts"), {
    targets: ["/repo/o"],
    replacedEntries: ["/repo/a.ts"],
  });
  // A destination that is not a folder has its own entry replaced; a move removes its sources too.
  assertEquals(split("mv a b"), replaced("/repo/b", "/repo/a"));
  assertEquals(split("install -m 755 a b"), replaced("/repo/b"));
  assertEquals(split("cp --remove-destination a b"), replaced("/repo/b"));
  assertEquals(split("mv -T a b"), replaced("/repo/b", "/repo/a"));
  assertEquals(split("mv -fT a b"), replaced("/repo/b", "/repo/a"));
  assertEquals(split("cp --no-target-directory --remove-destination a b"), replaced("/repo/b"));
  assertEquals(split("mv -t dest a"), replaced("/repo/dest/a", "/repo/a"));
  assertEquals(split("cp a b"), through("/repo/b"));
  // Mode flags come from parsed options, never from an operand or an option's value.
  assertEquals(split("cp -S --remove-destination a b"), through("/repo/b"));
  assertEquals(split("cp --suffix=--remove-destination a b"), through("/repo/b"));
  assertEquals(split("cp -- a --remove-destination"), through("/repo/--remove-destination"));
  assertEquals(split("cp --remove-d a b"), replaced("/repo/b"));
  assertEquals(split("mv -S -T a b"), replaced("/repo/b", "/repo/a"));
  assertEquals(split("mv -- -T b"), replaced("/repo/b", "/repo/-T"));
  assertEquals(split("install -m -T a b"), replaced("/repo/b"));
  assertEquals(split("mv -fta dest"), replaced("/repo/a/dest", "/repo/dest"));
  assertEquals(split("mv --target=d a"), replaced("/repo/d/a", "/repo/a"));
  // A source whose name is not literal leaves only the folder known; a trailing slash is dropped.
  assertEquals(split("cp -t dest $F sub/x/"), through("/repo/dest", "/repo/dest/x"));
  assertEquals(
    split("printf x > link.ts; tee t < x; truncate -s 0 u"),
    through(
      "/repo/link.ts",
      "/repo/t",
      "/repo/u",
    ),
  );
  // A script rename replaces both entries; an unnamed one keeps its folder as unknown.
  assertEquals(split(`node -e "fs.renameSync('old', 'new')"`), replaced("/repo/old", "/repo/new"));
  assertEquals(
    split(`deno eval "Deno.renameSync('old', 'sub/new')"`),
    replaced("/repo/old", "/repo/sub/new"),
  );
  assertEquals(
    analyzeBashWrites(`node -e "fs.renameSync('old', x)"`, { cwd: CWD, home: HOME }),
    { targets: [], replacedEntries: ["/repo/old"], unknownFiles: [CWD], unknownDirectory: false },
  );
  assertEquals(split(`bash -c "sed -i s/a/b/ n.ts"`), replaced("/repo/n.ts"));
  // A path written through and replaced in one command is listed both ways.
  assertEquals(split("echo x > f; sed -i s/a/b/ f"), either("/repo/f"));
  assertEquals(targets("echo x > f; sed -i s/a/b/ g"), ["/repo/f", "/repo/g"]);
});

Deno.test("analyzeBashWrites: a destination is a folder only when the filesystem says so (symlink to a file, to a folder)", async () => {
  const root = await Deno.makeTempDir({ prefix: "bash-write-dest-" });
  try {
    await Deno.mkdir(`${root}/dir`);
    await Deno.writeTextFile(`${root}/file`, "");
    await Deno.symlink(`${root}/file`, `${root}/to-file`);
    await Deno.symlink(`${root}/dir`, `${root}/to-dir`);
    const split = (command: string) => {
      const { targets, replacedEntries } = analyzeBashWrites(command, { cwd: root, home: HOME });
      return { targets, replacedEntries };
    };
    for (const name of ["mv", "install", "cp --remove-destination"]) {
      const moved = name === "mv" ? [`${root}/a`] : [];
      // A link to a file is itself replaced, never written through.
      assertEquals(split(`${name} a to-file`), {
        targets: [],
        replacedEntries: [`${root}/to-file`, ...moved],
      }, name);
      // Into a link to a folder (or the folder) the source replaces its own child entry there.
      assertEquals(split(`${name} a to-dir`), {
        targets: [],
        replacedEntries: [`${root}/to-dir/a`, ...moved],
      }, name);
      assertEquals(split(`${name} a dir`), {
        targets: [],
        replacedEntries: [`${root}/dir/a`, ...moved],
      }, name);
      // -T names the link's own entry even when it points to a folder.
      assertEquals(split(`${name} -T a to-dir`), {
        targets: [],
        replacedEntries: [`${root}/to-dir`, ...moved],
      }, name);
    }
    // Plain cp writes through the link to a file, and through the child entry inside a folder.
    assertEquals(split("cp a to-file"), { targets: [`${root}/to-file`], replacedEntries: [] });
    assertEquals(split("cp a to-dir"), { targets: [`${root}/to-dir/a`], replacedEntries: [] });
    // An exchange swaps the destination entry, a folder included.
    assertEquals(split("mv --exchange a to-dir"), {
      targets: [],
      replacedEntries: [`${root}/to-dir/a`, `${root}/to-dir`, `${root}/a`],
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("bashWriteTargets: interpreters, nesting, wrappers and cd", () => {
  assertEquals(targets(`python3 -c "open('a','w')"`), ["/repo/a"]);
  assertEquals(targets(`node -e "fs.appendFileSync('n.log', s)"`), ["/repo/n.log"]);
  assertEquals(targets(`ruby -e 'File.write("r", s)'`), ["/repo/r"]);
  assertEquals(targets(`deno eval "Deno.writeTextFileSync('d.ts', s)"`), ["/repo/d.ts"]);
  assertEquals(targets(`bash -c "echo x > b.ts"`), ["/repo/b.ts"]);
  assertEquals(targets(`sh -x -c "echo x > b.ts"`), ["/repo/b.ts"]);
  assertEquals(targets(`sudo tee /etc/hosts`), ["/etc/hosts"]);
  assertEquals(targets(`eval "echo x > e.ts"`), ["/repo/e.ts"]);
  assertEquals(targets("cd sub && echo x > f && cd - && echo y > g"), [
    "/repo/sub/f",
    "/repo/g",
  ]);
  assertEquals(targets("cd && echo x > f"), ["/home/j/f"]);
  assertEquals(targets("cd /work\npython3 - <<EOF\nPath(p).write_text(s)\nEOF"), ["/work"]);
  assertEquals(targets("echo x > $OUT"), []);
  assertEquals(targets("FOO=1 echo x"), []);
  assertEquals(targets("FOO=1"), []);
  assertEquals(bashWriteTargets("echo x > f", { cwd: CWD, home: HOME }, 99), []);
  assertEquals(targets("sudo ".repeat(40) + "tee f"), []);
});

Deno.test("bashWriteTargets: ordinary work writes nothing", () => {
  for (
    const command of [
      "git commit -m x",
      "git push origin HEAD",
      "deno task test",
      "deno task coverage:check",
      "grep -n foo src/a.ts",
      "echo hi 2>&1",
      "ls > /dev/null",
      "gh pr view 1 --json title",
      "npm install --ignore-scripts",
      "python3 fix.py",
      'node -e "console.log(1)"',
      "git commit -m \"$(cat <<'EOF'\nfix > things\nEOF\n)\"",
    ]
  ) {
    assertEquals(targets(command), [], command);
  }
});

Deno.test("CLI: prints one target per line and nothing for an unreadable payload", async () => {
  const run = async (stdin: string) => {
    const child = new Deno.Command("deno", {
      args: [
        "run",
        "--no-config",
        "--allow-read",
        "--allow-env=HOME",
        new URL("../hooks/lib/bash_write_targets.ts", import.meta.url).pathname,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
    return new TextDecoder().decode((await child.output()).stdout);
  };
  assertEquals(
    await run(JSON.stringify({ tool_input: { command: "echo x > a; tee b" }, cwd: "/w" })),
    "/w/a\n/w/b\n",
  );
  assertEquals(await run("not json"), "");
});
