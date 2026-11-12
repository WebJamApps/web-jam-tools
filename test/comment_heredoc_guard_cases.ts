/** Literal regression inputs from the canonical hooks design, shared with the safe probe. */
export type GuardOutcome = "allow" | "operation" | "unreadable";

export interface CommentHeredocCase {
  id: number;
  command: string;
  irreversible: GuardOutcome;
}

const rows: ReadonlyArray<readonly [string, GuardOutcome]> = [
  ["echo hi # don't", "allow"],
  ["python3 - x.md <<'EOF'\n# the Epic's row\nprint(1)\nEOF", "allow"],
  ["python3 - x.md <<'EOF'\nprint(1)  # the Epic's row\nEOF", "allow"],
  ["python3 - <<'EOF'\n# the Epic's row\nprint(1)\nEOF", "allow"],
  ["python3 - x.md <<'EOF'\n# the Epic row\nprint(1)\nEOF", "allow"],
  ["python3 - x.md <<'EOF'\nx = \"the Epic's row\"\nprint(1)\nEOF", "allow"],
  ["cat > /tmp/x.md <<'EOF'\n# the Epic's row\nEOF", "allow"],
  ["cat <<'EOF'\n# don't\nEOF", "allow"],
  [
    "node --input-type=module <<'JS'\n// Match ensureAuthenticated's existing token extraction and JWT verification.\nconsole.log(1);\nJS",
    "allow",
  ],
  ["node --input-type=module <<'JS'\nconsole.log(1); // don't\nJS", "allow"],
  ["node --input-type=module <<'JS'\n/* don't */\nconsole.log(1);\nJS", "allow"],
  [
    "node --input-type=module <<'JS'\n// Match the existing token extraction and JWT verification.\nconsole.log(1);\nJS",
    "allow",
  ],
  ["deno run - <<'TS'\n// the Epic's row\nconsole.log(1);\nTS", "allow"],
  ["deno run - <<'TS'\nconsole.log(1); // don't\nTS", "allow"],
  ["deno run - <<'TS'\n/* don't */\nconsole.log(1);\nTS", "allow"],
  ["node <<'JS'\nconsole.log(\"// don't\");\nJS", "allow"],
  ['echo "# don\'t"', "allow"],
  ["echo hello#world", "allow"],
  ["echo \\#hello", "allow"],
  ["echo hi # don't <<'FAKE'\necho done", "allow"],
  ["echo hi # don't; gh repo delete WebJamApps/example --yes", "allow"],
  ["echo hi # don't; git push origin dev", "allow"],
  ["echo hi # don't\ngh pr merge 123 --squash", "operation"],
  ["gh repo delete WebJamApps/example --yes # don't", "operation"],
  ["git push origin dev # don't", "allow"],
  ["gh pr merge 123 --squash # don't", "operation"],
  ["bash <<'EOF'\n# don't\ngh repo delete WebJamApps/example --yes\nEOF", "operation"],
  ["sh <<'EOF'\n# don't\ngit push origin dev\nEOF", "allow"],
  [
    "node <<'JS'\n// don't\nconsole.log(1);\nJS\ngh repo delete WebJamApps/example --yes",
    "operation",
  ],
  ["node <<'JS'\n// don't\nconsole.log(1);\nJS\ngit push origin dev", "allow"],
  ['echo "unclosed', "unreadable"],
  ["echo 'unclosed", "unreadable"],
  ["bash <<'EOF'\necho \"unclosed\nEOF", "unreadable"],
  ["node <<'JS'\nconsole.log(1);", "unreadable"],
  ["/usr/bin/python3 - <<'PY'\n# don't\nprint(1)\nPY", "allow"],
  ["cat <<'JS' | node\n// don't\nconsole.log(1);\nJS", "allow"],
];

export const COMMENT_HEREDOC_GUARD_CASES: readonly CommentHeredocCase[] = rows.map(
  ([command, irreversible], index) => ({ id: index + 1, command, irreversible }),
);

/** Supplemental review regressions; the canonical 36-row design matrix above stays unchanged. */
const reviewRows: ReadonlyArray<readonly [string, GuardOutcome]> = [
  ["node -v; bash <<'EOF'\necho hi //; gh repo delete WebJamApps/x --yes\nEOF", "operation"],
  ["node -v; bash <<'EOF'\ntrue /*\ngh repo delete WebJamApps/x --yes\n*/\nEOF", "operation"],
  ...["python3", "deno"].flatMap((name): [string, GuardOutcome][] => [
    [
      `${name} --version; bash <<'EOF'\necho hi //; gh repo delete WebJamApps/x --yes\nEOF`,
      "operation",
    ],
    [
      `${name} --version; sh <<'EOF'\ntrue /*\ngh repo delete WebJamApps/x --yes\n*/\nEOF`,
      "operation",
    ],
  ]),
  ...["node", "python3", "deno"].flatMap((name): [string, GuardOutcome][] => [
    [`bash -s ${name} <<'EOF'\necho hi //; gh repo delete WebJamApps/x --yes\nEOF`, "operation"],
    [
      `bash <<'EOF'; ${name} --version\necho hi //; gh repo delete WebJamApps/x --yes\nEOF`,
      "operation",
    ],
    [`${name} --version; bash <<'EOF'\necho \"unclosed\nEOF`, "unreadable"],
    [`${name} --version; cat <<'EOF'\ngh repo delete WebJamApps/x --yes\nEOF`, "allow"],
  ]),
  ["node -v | /bin/bash <<'EOF'\necho hi //; gh repo delete WebJamApps/x --yes\nEOF", "operation"],
  [
    "env FOO=node /bin/bash <<'EOF'\necho hi //; gh repo delete WebJamApps/x --yes\nEOF",
    "operation",
  ],
  [
    "</dev/null env FOO=node /bin/bash <<'EOF'\necho hi //; gh repo delete WebJamApps/x --yes\nEOF",
    "operation",
  ],
  [
    "cat <<'EOF' | env FOO=node /bin/bash\necho hi //; gh repo delete WebJamApps/x --yes\nEOF",
    "operation",
  ],
  ["bash $(node -v) <<'EOF'\ngh repo delete WebJamApps/x --yes\nEOF", "operation"],
  ["bash `node -v` <<'EOF'\ngh repo delete WebJamApps/x --yes\nEOF", "operation"],
  ["cat $(node -v) <<'EOF'\ngh repo delete WebJamApps/x --yes\nEOF", "allow"],
  ["node $(echo arg) <<'JS'\n// don't\nconsole.log(1);\nJS", "allow"],
  ...[
    "exec /bin/bash",
    "exec -a worker /bin/bash",
    "time -p bash",
    "! bash",
    "if bash",
    "then bash",
    "builtin source /dev/stdin",
  ].map(
    (
      receiver,
    ): [string, GuardOutcome] => [
      `${receiver} <<'EOF'\necho hi //; gh repo delete WebJamApps/x --yes\nEOF`,
      "operation",
    ],
  ),
  ["exec node <<'JS'\n// don't\nconsole.log(1);\nJS", "allow"],
  ["echo node <<'EOF'\ngh repo delete WebJamApps/x --yes\nEOF", "allow"],
  ["cat <<'EOF'; node --version\ngh repo delete WebJamApps/x --yes\nEOF", "allow"],
  [
    "node <<'JS'\nconst pattern = /\\/\\//; const regexTail = 1;\nJS\ngh repo delete WebJamApps/x --yes",
    "operation",
  ],
  [
    "node <<'JS'\nconst text = `text ${\"// don't\"}`; const templateTail = 1;\nJS\ngh repo delete WebJamApps/x --yes",
    "operation",
  ],
];

export const HEREDOC_REVIEW_CASES: readonly CommentHeredocCase[] = reviewRows.map(
  ([command, irreversible], index) => ({ id: 37 + index, command, irreversible }),
);
