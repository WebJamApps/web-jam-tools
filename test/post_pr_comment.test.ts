// post_pr_comment.test.ts — web-jam-tools#685

import { assertEquals, assertMatch, assertNotMatch } from "@std/assert";
import { type Deps, run } from "../scripts/post-pr-comment.ts";
import { REVIEW_SUMMARY_HEADER } from "../scripts/gh-write/guard.ts";
import { variedFakeBody } from "./support/varied_fake_value.ts";
import { LUNA_SIGNATURE, withSigningFixture } from "./support/codex_signing_fixture.ts";

function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    signing: { env: () => undefined },
    readFileText: () => Promise.resolve("thanks, looks good"),
    runCmd: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}

const ARGS = [
  "--repo",
  "WebJamApps/JaMmusic",
  "--pr",
  "1324",
  "--body-file",
  "/tmp/example-comment.md",
];

for (
  const [name, body, expected] of [
    [
      "o: work footer",
      "Notes\r\n\r\n🤖 Work by Codex — GPT-6.1 Sol\r\n",
      `Notes\r\n\r\n🤖 Work by ${LUNA_SIGNATURE}\r\n`,
    ],
    [
      "p: off-roster name",
      "Notes\n\n🤖 Work by Codex — GPT-6\n",
      `Notes\n\n🤖 Work by ${LUNA_SIGNATURE}\n`,
    ],
    [
      "q: two work footers",
      "🤖 Work by Codex — GPT-6.1 Sol\nDetails\n  🤖 Work by Codex — GPT-6\n",
      `🤖 Work by ${LUNA_SIGNATURE}\nDetails\n  🤖 Work by ${LUNA_SIGNATURE}\n`,
    ],
    [
      "r: review summary",
      `${REVIEW_SUMMARY_HEADER}\n**Approved**\n\n🤖 Reviewed by Codex — GPT-6.1 Sol\n`,
      `${REVIEW_SUMMARY_HEADER}\n**Approved**\n\n🤖 Reviewed by ${LUNA_SIGNATURE}\n`,
    ],
  ] as const
) {
  Deno.test(`signing comment ${name}: rewrites before guards and sends the new body`, () =>
    withSigningFixture(async (signing) => {
      const calls: string[][] = [];
      const code = await run(
        ARGS,
        fakeDeps({
          signing,
          readFileText: () => Promise.resolve(body),
          runCmd: (cmd) => {
            calls.push(cmd);
            return Promise.resolve({ code: 0, stdout: "", stderr: "" });
          },
        }),
      );
      assertEquals(code, 0);
      const post = calls.find((cmd) => cmd[0] === "gh")!;
      assertEquals(post[post.indexOf("--body") + 1], expected);
      assertEquals(post.includes("--body-file"), false);
      for (const probe of calls.filter((cmd) => cmd[1] === "--check-author")) {
        assertEquals(probe[2], LUNA_SIGNATURE);
      }
    }));
}

Deno.test("signing comment s: unsigned text stays byte exact without consulting the session", async () => {
  const body = "Notes\r\nNo signature here.\r\n";
  const calls: string[][] = [];
  assertEquals(
    await run(
      ARGS,
      fakeDeps({
        signing: {
          env: () => {
            throw new Error("must not look up");
          },
          readRoster: () => {
            throw new Error("must not look up");
          },
        },
        readFileText: () => Promise.resolve(body),
        runCmd: (cmd) => {
          calls.push(cmd);
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        },
      }),
    ),
    0,
  );
  assertEquals(calls[0].slice(-2), ["--body-file", "/tmp/example-comment.md"]);
});

Deno.test("signing comment v: unset session preserves signature text and the file transport", async () => {
  const body = "Notes\n\n🤖 Work by Codex — GPT-6.1 Sol\n";
  const calls: string[][] = [];
  assertEquals(
    await run(
      ARGS,
      fakeDeps({
        readFileText: () => Promise.resolve(body),
        signing: {
          env: () => undefined,
          readRoster: () => {
            throw new Error("must not look up");
          },
        },
        runCmd: (cmd) => {
          calls.push(cmd);
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        },
      }),
    ),
    0,
  );
  assertEquals(calls.find((cmd) => cmd[0] === "gh")!.slice(-2), [
    "--body-file",
    "/tmp/example-comment.md",
  ]);
  assertEquals(calls.find((cmd) => cmd[1] === "--check-author")![2], "Codex — GPT-6.1 Sol");
});

Deno.test("signing comment t: missing session prevents posting even with a roster name", () =>
  withSigningFixture(async (signing, _env, sessionPath) => {
    await Deno.remove(sessionPath);
    const calls: string[][] = [];
    assertEquals(
      await run(
        ARGS,
        fakeDeps({
          signing,
          readFileText: () => Promise.resolve(`Notes\n🤖 Work by ${LUNA_SIGNATURE}`),
          runCmd: (cmd) => {
            calls.push(cmd);
            return Promise.resolve({ code: 0, stdout: "", stderr: "" });
          },
        }),
      ),
      1,
    );
    assertEquals(calls, []);
  }));

Deno.test("post-pr-comment: missing required args prints usage and exits 1", async () => {
  const code = await run([], fakeDeps());
  assertEquals(code, 1);
});

Deno.test("post-pr-comment: an empty body file is REFUSED", async () => {
  const code = await run(ARGS, fakeDeps({ readFileText: () => Promise.resolve("   ") }));
  assertEquals(code, 1);
});

Deno.test("post-pr-comment: a body with no review header is still ALLOWED (header check binds the review verb only)", async () => {
  const code = await run(ARGS, fakeDeps());
  assertEquals(code, 0);
});

Deno.test("post-pr-comment: a body carrying a credential-shaped literal is REFUSED", async () => {
  const fake = "AIza" + variedFakeBody(35, 50);
  const code = await run(
    ARGS,
    fakeDeps({ readFileText: () => Promise.resolve(`leaked: ${fake}`) }),
  );
  assertEquals(code, 1);
});

Deno.test("post-pr-comment: --dry-run resolves without posting", async () => {
  let called = false;
  const code = await run(
    [...ARGS, "--dry-run"],
    fakeDeps({
      runCmd: () => {
        called = true;
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(called, false);
});

Deno.test("post-pr-comment: a transient failure is retried and succeeds", async () => {
  let attempts = 0;
  const code = await run(
    ARGS,
    fakeDeps({
      runCmd: () => {
        attempts++;
        if (attempts < 2) return Promise.resolve({ code: 1, stdout: "", stderr: "i/o timeout" });
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(attempts, 2);
});

Deno.test("post-pr-comment: builds gh argv with bare pr id and --repo flag (regression web-jam-tools#781)", async () => {
  let seenCommentArgs: string[] = [];
  const code = await run(
    ARGS,
    fakeDeps({
      runCmd: (cmd) => {
        seenCommentArgs = cmd;
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(seenCommentArgs, [
    "gh",
    "pr",
    "comment",
    "1324",
    "--repo",
    "WebJamApps/JaMmusic",
    "--body-file",
    "/tmp/example-comment.md",
  ]);
});

Deno.test("post-pr-comment: a body carrying the review header but no reviewer line is REFUSED", async () => {
  let called = false;
  const code = await run(
    ARGS,
    fakeDeps({
      readFileText: () => Promise.resolve(`${REVIEW_SUMMARY_HEADER}\n**Approved**\n`),
      runCmd: () => {
        called = true;
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 1);
  assertEquals(called, false);
});

Deno.test("post-pr-comment: a body carrying the review header and a reviewer line is ALLOWED", async () => {
  const code = await run(
    [...ARGS, "--dry-run"],
    fakeDeps({
      readFileText: () =>
        Promise.resolve(
          `${REVIEW_SUMMARY_HEADER}\n**Approved**\n\n🤖 Reviewed by Claude Code — Claude Opus 5.5\n`,
        ),
    }),
  );
  assertEquals(code, 0);
});

Deno.test("post-pr-comment: a plain comment (no review header) with no reviewer line is unchanged and ALLOWED", async () => {
  const code = await run(
    ARGS,
    fakeDeps({ readFileText: () => Promise.resolve("Fixed by someone: plain comment") }),
  );
  assertEquals(code, 0);
});

// --- Author roster check tests (web-jam-tools#1200) ---

Deno.test("post-pr-comment: exits 1 and posts nothing for a body whose footer line is 🤖 Work by Codex — GPT-6, naming footer line and listing roster", async () => {
  const origError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  let ghCalled = false;
  try {
    const code = await run(
      ARGS,
      fakeDeps({
        readFileText: () => Promise.resolve("All done.\n\n🤖 Work by Codex — GPT-6\n"),
        runCmd: (cmd) => {
          if (cmd.includes("--check-author")) {
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr:
                "ERROR: --author 'Codex — GPT-6' does not name a model on the roster (web-jam-tools#190).\n       Valid models:\n         - Gemini Flash (High)\n         - Claude Sonnet 5.5\n",
            });
          }
          if (cmd.includes("comment")) {
            ghCalled = true;
          }
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        },
      }),
    );
    assertEquals(code, 1);
    assertEquals(ghCalled, false);
    const errText = errors.join("\n");
    assertMatch(
      errText,
      /refusing to post: footer line '🤖 Work by Codex — GPT-6' names a model not on the author roster/,
    );
    assertMatch(errText, /ERROR: --author 'Codex — GPT-6' does not name a model on the roster/);
    assertMatch(errText, /Valid models:/);
  } finally {
    console.error = origError;
  }
});

Deno.test("post-pr-comment: exits 0 and posts for a body with Sol or Sonnet 5.5 footers", async () => {
  let probeCheckedAuthor = "";
  let ghCommentPosted = false;

  // Test Sol
  const codeSol = await run(
    ARGS,
    fakeDeps({
      readFileText: () => Promise.resolve("Done.\n\n🤖 Work by Codex — GPT-6.1 Sol (high)\n"),
      runCmd: (cmd) => {
        if (cmd.includes("--check-author")) {
          probeCheckedAuthor = cmd[cmd.length - 1];
          return Promise.resolve({ code: 0, stdout: "OK", stderr: "" });
        }
        if (cmd.includes("comment")) {
          ghCommentPosted = true;
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(codeSol, 0);
  assertEquals(probeCheckedAuthor, "Codex — GPT-6.1 Sol (high)");
  assertEquals(ghCommentPosted, true);

  // Test Sonnet 5.5
  probeCheckedAuthor = "";
  ghCommentPosted = false;
  const codeSonnet = await run(
    ARGS,
    fakeDeps({
      readFileText: () => Promise.resolve("Done.\n\n🤖 Work by Claude Code — Sonnet 5.5\n"),
      runCmd: (cmd) => {
        if (cmd.includes("--check-author")) {
          probeCheckedAuthor = cmd[cmd.length - 1];
          return Promise.resolve({ code: 0, stdout: "OK", stderr: "" });
        }
        if (cmd.includes("comment")) {
          ghCommentPosted = true;
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(codeSonnet, 0);
  assertEquals(probeCheckedAuthor, "Claude Code — Sonnet 5.5");
  assertEquals(ghCommentPosted, true);
});

Deno.test("post-pr-comment: posts a body whose footer line is 🤖 Work by Codex — GPT-6 Astra (high)", async () => {
  let probeCheckedAuthor = "";
  let ghCommentPosted = false;

  const code = await run(
    ARGS,
    fakeDeps({
      readFileText: () => Promise.resolve("Done.\n\n🤖 Work by Codex — GPT-6 Astra (high)\n"),
      runCmd: (cmd) => {
        if (cmd.includes("--check-author")) {
          probeCheckedAuthor = cmd[cmd.length - 1];
          return Promise.resolve({ code: 0, stdout: "OK", stderr: "" });
        }
        if (cmd.includes("comment")) {
          ghCommentPosted = true;
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(probeCheckedAuthor, "Codex — GPT-6 Astra (high)");
  assertEquals(ghCommentPosted, true);
});

Deno.test("post-pr-comment: a body with no footer line is posted and probe is not run", async () => {
  let probeCalled = false;
  let ghCommentPosted = false;

  const code = await run(
    ARGS,
    fakeDeps({
      readFileText: () => Promise.resolve("LGTM, no issues.\n"),
      runCmd: (cmd) => {
        if (cmd.includes("--check-author")) {
          probeCalled = true;
        }
        if (cmd.includes("comment")) {
          ghCommentPosted = true;
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(probeCalled, false);
  assertEquals(ghCommentPosted, true);
});

Deno.test("post-pr-comment: a body with two footer lines, one on the roster and one not, is refused", async () => {
  let ghCalled = false;
  const code = await run(
    ARGS,
    fakeDeps({
      readFileText: () =>
        Promise.resolve(
          "Initial:\n🤖 Work by Claude Code — Sonnet 5.5\nFollow-up:\n🤖 Work by Codex — GPT-6\n",
        ),
      runCmd: (cmd) => {
        if (cmd.includes("--check-author")) {
          const author = cmd[cmd.length - 1];
          if (author.includes("Sonnet 5.5")) {
            return Promise.resolve({ code: 0, stdout: "OK", stderr: "" });
          }
          return Promise.resolve({
            code: 1,
            stdout: "",
            stderr:
              "ERROR: --author 'Codex — GPT-6' does not name a model on the roster (web-jam-tools#190).\n",
          });
        }
        if (cmd.includes("comment")) {
          ghCalled = true;
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 1);
  assertEquals(ghCalled, false);
});

Deno.test("post-pr-comment: when probe cannot be started (runCmd rejects), refuses with exit 1 and 'roster check could not run' message, never calls gh", async () => {
  const origError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  let ghCalled = false;
  try {
    const code = await run(
      ARGS,
      fakeDeps({
        readFileText: () => Promise.resolve("All done.\n\n🤖 Work by Claude Code — Sonnet 5.5\n"),
        runCmd: (cmd) => {
          if (cmd.includes("--check-author")) {
            return Promise.reject(new Error("spawn failed: binary not executable"));
          }
          if (cmd.includes("comment")) {
            ghCalled = true;
          }
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        },
      }),
    );
    assertEquals(code, 1);
    assertEquals(ghCalled, false);
    const errText = errors.join("\n");
    assertMatch(errText, /roster check could not run/);
    assertNotMatch(errText, /names a model not on the author roster/);
  } finally {
    console.error = origError;
  }
});

Deno.test("post-pr-comment: when probe exits non-zero without roster message (faked exit code 127), refuses with exit 1 and message different from off-roster message", async () => {
  const origError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  let ghCalled = false;
  try {
    const code = await run(
      ARGS,
      fakeDeps({
        readFileText: () => Promise.resolve("All done.\n\n🤖 Work by Claude Code — Sonnet 5.5\n"),
        runCmd: (cmd) => {
          if (cmd.includes("--check-author")) {
            return Promise.resolve({
              code: 127,
              stdout: "",
              stderr: "bash: create-draft-pr.sh: command not found",
            });
          }
          if (cmd.includes("comment")) {
            ghCalled = true;
          }
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        },
      }),
    );
    assertEquals(code, 1);
    assertEquals(ghCalled, false);
    const errText = errors.join("\n");
    assertMatch(errText, /roster check could not run/);
    assertNotMatch(errText, /names a model not on the author roster/);
  } finally {
    console.error = origError;
  }
});

Deno.test("post-pr-comment: --dry-run with an off-roster footer exits 1 and prints no dry run line", async () => {
  const origLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    const code = await run(
      [...ARGS, "--dry-run"],
      fakeDeps({
        readFileText: () => Promise.resolve("All done.\n\n🤖 Work by Codex — GPT-6\n"),
        runCmd: (cmd) => {
          if (cmd.includes("--check-author")) {
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr:
                "ERROR: --author 'Codex — GPT-6' does not name a model on the roster (web-jam-tools#190).\n",
            });
          }
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        },
      }),
    );
    assertEquals(code, 1);
    const logText = logs.join("\n");
    assertNotMatch(logText, /dry run: would post comment/);
  } finally {
    console.log = origLog;
  }
});

Deno.test("post-pr-comment: quotes footer in inline backticks or > blockquote is posted", async () => {
  let probeCalled = false;
  let ghCalled = false;

  const code = await run(
    ARGS,
    fakeDeps({
      readFileText: () =>
        Promise.resolve(
          "Here is a quote:\n> 🤖 Work by Codex — GPT-6\nAnd inline:\n`🤖 Work by Codex — GPT-6`\n",
        ),
      runCmd: (cmd) => {
        if (cmd.includes("--check-author")) {
          probeCalled = true;
        }
        if (cmd.includes("comment")) {
          ghCalled = true;
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 0);
  assertEquals(probeCalled, false);
  assertEquals(ghCalled, true);
});

Deno.test("post-pr-comment: off-roster footer inside fenced code block is refused", async () => {
  let probeCalled = false;
  let ghCalled = false;

  const code = await run(
    ARGS,
    fakeDeps({
      readFileText: () =>
        Promise.resolve(
          "Fenced block:\n```sh\n🤖 Work by Codex — GPT-6\n```\n",
        ),
      runCmd: (cmd) => {
        if (cmd.includes("--check-author")) {
          probeCalled = true;
          return Promise.resolve({
            code: 1,
            stdout: "",
            stderr:
              "ERROR: --author 'Codex — GPT-6' does not name a model on the roster (web-jam-tools#190).\n",
          });
        }
        if (cmd.includes("comment")) {
          ghCalled = true;
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 1);
  assertEquals(probeCalled, true);
  assertEquals(ghCalled, false);
});

Deno.test("post-pr-comment: bare 🤖 Work by footer line is refused as not on roster", async () => {
  let probeCheckedAuthor: string | null = null;
  let ghCalled = false;

  const code = await run(
    ARGS,
    fakeDeps({
      readFileText: () => Promise.resolve("Almost done:\n\n🤖 Work by\n"),
      runCmd: (cmd) => {
        if (cmd.includes("--check-author")) {
          probeCheckedAuthor = cmd[cmd.length - 1];
          return Promise.resolve({
            code: 1,
            stdout: "",
            stderr: "ERROR: --author '' does not name a model on the roster (web-jam-tools#190).\n",
          });
        }
        if (cmd.includes("comment")) {
          ghCalled = true;
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    }),
  );
  assertEquals(code, 1);
  assertEquals(probeCheckedAuthor, "");
  assertEquals(ghCalled, false);
});
