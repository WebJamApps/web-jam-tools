import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkCanonicalCloneCommand,
  evaluatePayload,
} from "../hooks/lib/check_canonical_clone_change.ts";

const CANONICAL = "/home/joshua/WebJamApps/web-jam-tools";

interface AppendixRow {
  id: number;
  dir: string;
  command: string;
  outcome: "refuse" | "allow" | "allow-with-note";
  namedCommand?: string;
  noteSubstring?: string;
}

const APPENDIX_A_ROWS: AppendixRow[] = [
  {
    id: 1,
    dir: "/home/joshua",
    command:
      "cd /home/joshua/WebJamApps/web-jam-tools && git switch -c fix/sonnet-label-description dev && git branch --show-current",
    outcome: "refuse",
    namedCommand: "switch",
  },
  {
    id: 2,
    dir: CANONICAL,
    command:
      "git status --short && git switch -q dev && git switch -q -c fix/milestone-topic-designations",
    outcome: "refuse",
    namedCommand: "switch",
  },
  {
    id: 3,
    dir: CANONICAL,
    command:
      "git worktree add -b fix/sonnet-label-description-update /tmp/pr-1807-target origin/fix/sonnet-label-description && git cherry-pick 589bd1b",
    outcome: "refuse",
    namedCommand: "cherry-pick",
  },
  {
    id: 4,
    dir: CANONICAL,
    command:
      "git worktree add -b feat /tmp/wjt-x origin/dev && cd /tmp/wjt-x && git cherry-pick 589bd1b",
    outcome: "allow",
  },
  {
    id: 5,
    dir: "/home/joshua",
    command: "git -C /home/joshua/WebJamApps/web-jam-tools commit -m x",
    outcome: "refuse",
    namedCommand: "commit",
  },
  {
    id: 6,
    dir: CANONICAL,
    command: "git checkout 4870c27",
    outcome: "refuse",
    namedCommand: "checkout",
  },
  {
    id: 7,
    dir: CANONICAL,
    command: "git checkout -b feat",
    outcome: "refuse",
    namedCommand: "checkout",
  },
  {
    id: 8,
    dir: CANONICAL,
    command: "git merge origin/feat",
    outcome: "refuse",
    namedCommand: "merge",
  },
  {
    id: 9,
    dir: CANONICAL,
    command: "git rebase origin/dev",
    outcome: "refuse",
    namedCommand: "rebase",
  },
  {
    id: 10,
    dir: CANONICAL,
    command: "git reset --hard origin/dev",
    outcome: "refuse",
    namedCommand: "reset",
  },
  {
    id: 11,
    dir: CANONICAL,
    command: "git stash push -u -m wip",
    outcome: "refuse",
    namedCommand: "stash",
  },
  {
    id: 12,
    dir: CANONICAL,
    command: "git pull origin feat",
    outcome: "refuse",
    namedCommand: "pull",
  },
  {
    id: 13,
    dir: CANONICAL,
    command: "git pull origin dev",
    outcome: "allow",
  },
  {
    id: 14,
    dir: CANONICAL,
    command: "git pull --ff-only",
    outcome: "allow",
  },
  {
    id: 15,
    dir: CANONICAL,
    command: "git fetch --prune origin",
    outcome: "allow",
  },
  {
    id: 16,
    dir: CANONICAL,
    command: "git status -sb && git log --oneline -3 && git diff --stat",
    outcome: "allow",
  },
  {
    id: 17,
    dir: CANONICAL,
    command: "git worktree add -b feat /tmp/wjt-x origin/dev",
    outcome: "allow",
  },
  {
    id: 18,
    dir: CANONICAL,
    command: "git worktree remove /tmp/wjt-x && git branch -D feat",
    outcome: "allow",
  },
  {
    id: 19,
    dir: "/tmp/wjt-x",
    command: "git switch -c feat2 && git commit -m x && git cherry-pick 589bd1b",
    outcome: "allow",
  },
  {
    id: 20,
    dir: "/home/joshua/WebJamApps/JaMmusic",
    command: "git switch -c feat",
    outcome: "allow",
  },
  {
    id: 21,
    dir: CANONICAL,
    command: 'bash -c "$CMD"',
    outcome: "allow-with-note",
    noteSubstring: "could not be read",
  },
];

for (const row of APPENDIX_A_ROWS) {
  Deno.test(`Appendix A row ${row.id} (Claude Code shape): ${row.command}`, () => {
    const payload = JSON.stringify({
      cwd: row.dir,
      tool_name: "Bash",
      tool_input: { command: row.command },
    });
    const res = evaluatePayload(payload, { home: "/home/joshua" });
    assertEquals(res.outcome, row.outcome);
    if (res.outcome === "refuse") {
      assertStringIncludes(res.message, CANONICAL);
      assertStringIncludes(res.message, "scripts/new-agent-worktree.sh");
      if (row.namedCommand) {
        assertStringIncludes(res.message, row.namedCommand);
      }
    } else if (res.outcome === "allow-with-note" && row.noteSubstring) {
      assertStringIncludes(res.note, row.noteSubstring);
    }
  });

  Deno.test(`Appendix A row ${row.id} (Codex shape): ${row.command}`, () => {
    // Codex carries tool_input.workdir (which may differ from top-level cwd).
    const payload = JSON.stringify({
      cwd: "/tmp/other-session-cwd",
      tool_name: "Bash",
      tool_input: { command: row.command, workdir: row.dir },
    });
    const res = evaluatePayload(payload, { home: "/home/joshua" });
    assertEquals(res.outcome, row.outcome);
    if (res.outcome === "refuse") {
      assertStringIncludes(res.message, CANONICAL);
      assertStringIncludes(res.message, "scripts/new-agent-worktree.sh");
      if (row.namedCommand) {
        assertStringIncludes(res.message, row.namedCommand);
      }
    } else if (res.outcome === "allow-with-note" && row.noteSubstring) {
      assertStringIncludes(res.note, row.noteSubstring);
    }
  });
}

Deno.test("refuses revert, am, and remaining git mutators in canonical clone", () => {
  for (const [cmd, name] of [["git revert HEAD", "revert"], ["git am patch.mbox", "am"]]) {
    const res = checkCanonicalCloneCommand(cmd, CANONICAL, { home: "/home/joshua" });
    assertEquals(res.outcome, "refuse");
    if (res.outcome === "refuse") {
      assertEquals(res.command, name);
      assertStringIncludes(res.message, CANONICAL);
    }
  }
});

Deno.test("allows file-only git checkout -- <file> and .claude/worktrees paths", () => {
  assertEquals(
    checkCanonicalCloneCommand("git checkout -- README.md", CANONICAL, { home: "/home/joshua" }),
    { outcome: "allow" },
  );
  assertEquals(
    checkCanonicalCloneCommand(
      "git switch -c feat",
      `${CANONICAL}/.claude/worktrees/my-lane`,
      { home: "/home/joshua" },
    ),
    { outcome: "allow" },
  );
});

Deno.test("refuses git inside subdirectory of canonical clone, behind env/sudo/bash -c", () => {
  for (
    const cmd of [
      "sudo git commit -m x",
      "env FOO=1 git rebase origin/dev",
      'bash -c "git reset --hard origin/dev"',
      `env -C ${CANONICAL} git switch -c feat`,
    ]
  ) {
    const dir = cmd.startsWith("env -C") ? "/home/joshua" : `${CANONICAL}/hooks`;
    const res = checkCanonicalCloneCommand(cmd, dir, { home: "/home/joshua" });
    assertEquals(res.outcome, "refuse", cmd);
  }
});

Deno.test("allows with note when folder or command cannot be determined", () => {
  const missingCwd = evaluatePayload(
    JSON.stringify({ tool_name: "Bash", tool_input: { command: "git switch -c feat" } }),
    { home: "/home/joshua" },
  );
  assertEquals(missingCwd.outcome, "allow-with-note");

  const varCd = checkCanonicalCloneCommand(
    'cd "$TARGET" && git switch -c feat',
    CANONICAL,
    { home: "/home/joshua" },
  );
  assertEquals(varCd.outcome, "allow-with-note");

  const badJson = evaluatePayload("{not-json", { home: "/home/joshua" });
  assertEquals(badJson.outcome, "allow-with-note");

  const nonBash = evaluatePayload(
    JSON.stringify({
      cwd: CANONICAL,
      tool_name: "Read",
      tool_input: { file_path: `${CANONICAL}/README.md` },
    }),
    { home: "/home/joshua" },
  );
  assertEquals(nonBash.outcome, "allow");
});

Deno.test("allows prose in data heredocs and echo commands", () => {
  assertEquals(
    checkCanonicalCloneCommand(
      "cat <<'EOF' > /tmp/note.md\ngit switch -c x\nEOF",
      CANONICAL,
      { home: "/home/joshua" },
    ),
    { outcome: "allow" },
  );
  assertEquals(
    checkCanonicalCloneCommand('echo "git commit -m x"', CANONICAL, { home: "/home/joshua" }),
    { outcome: "allow" },
  );
});

Deno.test("git global flags and pull/checkout edge cases", () => {
  assertEquals(
    checkCanonicalCloneCommand(`git -C ${CANONICAL} --no-pager status -s`, "/tmp", {
      home: "/home/joshua",
    }),
    { outcome: "allow" },
  );
  assertEquals(
    checkCanonicalCloneCommand(`git -C${CANONICAL} commit -m x`, "/tmp", {
      home: "/home/joshua",
    }).outcome,
    "refuse",
  );
  assertEquals(
    checkCanonicalCloneCommand(`git --git-dir=${CANONICAL}/.git reset --hard`, "/tmp", {
      home: "/home/joshua",
    }).outcome,
    "refuse",
  );
  assertEquals(
    checkCanonicalCloneCommand("git pull origin refs/heads/dev", CANONICAL, {
      home: "/home/joshua",
    }),
    { outcome: "allow" },
  );
  assertEquals(
    checkCanonicalCloneCommand("git pull upstream dev", CANONICAL, {
      home: "/home/joshua",
    }).outcome,
    "refuse",
  );
  assertEquals(
    checkCanonicalCloneCommand("git --version", CANONICAL, { home: "/home/joshua" }),
    { outcome: "allow" },
  );
  assertEquals(
    checkCanonicalCloneCommand("git --unknown-flag switch -c x", CANONICAL, {
      home: "/home/joshua",
    }).outcome,
    "allow-with-note",
  );
});

Deno.test("subshell scoping: restores parent cwd in both directions on Claude Code and Codex shapes", () => {
  const worktree = "/tmp/wjt-x";
  const fromCanonical = "(cd /tmp/wjt-x && git status); git commit -m x";
  const fromWorktree = `(cd ${CANONICAL} && git status); git commit -m x`;

  for (
    const payload of [
      { cwd: CANONICAL, tool_name: "Bash", tool_input: { command: fromCanonical } },
      {
        cwd: worktree,
        tool_name: "Bash",
        tool_input: { command: fromCanonical, workdir: CANONICAL },
      },
    ]
  ) {
    const res = evaluatePayload(JSON.stringify(payload), { home: "/home/joshua" });
    assertEquals(res.outcome, "refuse");
    if (res.outcome === "refuse") {
      assertEquals(res.command, "commit");
      assertStringIncludes(res.message, CANONICAL);
    }
  }

  for (
    const payload of [
      { cwd: worktree, tool_name: "Bash", tool_input: { command: fromWorktree } },
      {
        cwd: CANONICAL,
        tool_name: "Bash",
        tool_input: { command: fromWorktree, workdir: worktree },
      },
    ]
  ) {
    assertEquals(
      evaluatePayload(JSON.stringify(payload), { home: "/home/joshua" }),
      { outcome: "allow" },
    );
  }
});

Deno.test("nested subshells, heredoc subshells, brace groups, functions, pushd/popd, and unknown-dir syntax", () => {
  assertEquals(
    checkCanonicalCloneCommand(
      "((cd /tmp/wjt-x && git status); git status); git commit -m x",
      CANONICAL,
      {
        home: "/home/joshua",
      },
    ).outcome,
    "refuse",
  );
  assertEquals(
    checkCanonicalCloneCommand(
      "(cd /tmp/wjt-x && cat <<'EOF'\nhi\nEOF\n); git commit -m x",
      CANONICAL,
      { home: "/home/joshua" },
    ).outcome,
    "refuse",
  );
  assertEquals(
    checkCanonicalCloneCommand(
      `(cd ${CANONICAL} && git commit -m x); git status`,
      "/tmp/wjt-x",
      { home: "/home/joshua" },
    ).outcome,
    "refuse",
  );
  assertEquals(
    checkCanonicalCloneCommand("{ cd /tmp/wjt-x && git status; }; git commit -m x", CANONICAL, {
      home: "/home/joshua",
    }),
    { outcome: "allow" },
  );
  assertEquals(
    checkCanonicalCloneCommand("{ cd /tmp/wjt-x; } | cat; git commit -m x", CANONICAL, {
      home: "/home/joshua",
    }).outcome,
    "refuse",
  );
  assertEquals(
    checkCanonicalCloneCommand("f() { cd /tmp/wjt-x; }; git commit -m x", CANONICAL, {
      home: "/home/joshua",
    }).outcome,
    "refuse",
  );
  assertEquals(
    checkCanonicalCloneCommand("f() { cd /tmp/wjt-x; }; f; git commit -m x", CANONICAL, {
      home: "/home/joshua",
    }).outcome,
    "allow-with-note",
  );
  assertEquals(
    checkCanonicalCloneCommand(
      "pushd /tmp/wjt-x && git status && popd && git commit -m x",
      CANONICAL,
      {
        home: "/home/joshua",
      },
    ).outcome,
    "refuse",
  );
  assertEquals(
    checkCanonicalCloneCommand(
      `pushd ${CANONICAL} && git status && popd && git commit -m x`,
      "/tmp/wjt-x",
      { home: "/home/joshua" },
    ),
    { outcome: "allow" },
  );
  assertEquals(
    checkCanonicalCloneCommand("cd /tmp/wjt-x | git commit -m x", CANONICAL, {
      home: "/home/joshua",
    }).outcome,
    "refuse",
  );
  assertEquals(
    checkCanonicalCloneCommand("cd /tmp/wjt-x & git commit -m x", CANONICAL, {
      home: "/home/joshua",
    }).outcome,
    "refuse",
  );
  assertEquals(
    checkCanonicalCloneCommand("cd /tmp/wjt-x || git commit -m x", CANONICAL, {
      home: "/home/joshua",
    }).outcome,
    "refuse",
  );
  assertEquals(
    checkCanonicalCloneCommand(
      `if true; then cd ${CANONICAL} && git commit -m x; fi`,
      "/tmp/wjt-x",
      { home: "/home/joshua" },
    ).outcome,
    "refuse",
  );
  assertEquals(
    checkCanonicalCloneCommand(
      "if true; then (cd /tmp/wjt-x && git status); fi; git commit -m x",
      CANONICAL,
      { home: "/home/joshua" },
    ).outcome,
    "refuse",
  );

  for (
    const cmd of [
      "cat | cd /tmp/wjt-x; git commit -m x",
      "false && cd /tmp/wjt-x; git commit -m x",
      "true || cd /tmp/wjt-x; git commit -m x",
      "cd /tmp/wjt-x || echo err; git commit -m x",
      "if false; then cd /tmp/wjt-x; fi; git commit -m x",
      'case "$X" in a) cd /tmp/wjt-x ;; esac; git commit -m x',
      "pushd +1; git commit -m x",
      "popd; git commit -m x",
    ]
  ) {
    const res = checkCanonicalCloneCommand(cmd, CANONICAL, { home: "/home/joshua" });
    assertEquals(res.outcome, "allow-with-note", cmd);
    if (res.outcome === "allow-with-note") {
      assertStringIncludes(res.note, "folder");
    }
  }
});
