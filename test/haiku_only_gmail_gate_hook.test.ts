// The historical hook filename now supplies context; the mail fence is independent.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { gmailModelNote, UNKNOWN_GMAIL_MODEL_NOTE } from "../hooks/lib/gmail_model_note.ts";
import { selectSessionModel } from "../hooks/lib/select_transcript_entry.ts";

const script = new URL("../hooks/haiku-only-gmail-gate.sh", import.meta.url).pathname;
const id = "12345678-1234-1234-1234-123456789abc";

async function probe(surface: string, model: string, tool: string, unknown = false) {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/sessions`);
    await Deno.writeTextFile(
      `${dir}/sessions/rollout-${id}.jsonl`,
      JSON.stringify({ type: "turn_context", payload: { model } }),
    );
    const transcript = `${dir}/transcript.jsonl`;
    await Deno.writeTextFile(
      transcript,
      [
        { type: "assistant", message: { role: "assistant", model, content: "hello" } },
        { type: "assistant", isSidechain: true, message: { model: "claude-opus-5-5" } },
        { type: "assistant", isApiErrorMessage: true, message: { model: "claude-opus-5-5" } },
        { type: "api-request-blob", message: { role: "assistant", content: [] } },
      ].map((row) => JSON.stringify(row)).join("\n"),
    );
    const child = new Deno.Command("bash", {
      args: [script],
      cwd: dir,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: {
        WJT_SURFACE: surface,
        CODEX_THREAD_ID: surface === "codex" && !unknown ? id : "",
        CODEX_HOME: dir,
        CLAUDE_CODE_SESSION_ID: "",
        FORCED_PR_AUTHOR: "",
        AGY_CONVERSATION_ID: "",
        AGY_MODEL_NAME: "",
        AGY_TRANSCRIPT_PATH: "",
      },
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(
      new TextEncoder().encode(
        JSON.stringify({
          tool_name: tool,
          transcript_path: unknown ? `${dir}/missing` : transcript,
        }),
      ),
    );
    await writer.close();
    const result = await child.output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    const stdout = new TextDecoder().decode(result.stdout).trim();
    const output = stdout ? JSON.parse(stdout).hookSpecificOutput : {};
    assertEquals(output.permissionDecision, undefined);
    return output.additionalContext as string | undefined;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

for (const surface of ["claude", "codex"]) {
  for (
    const model of [
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-fable-5-2",
      "gpt-6-luna",
      "gpt-6.2-sol",
      "gpt-6.2-astra",
      "gemini-4-argon-high",
      "gemini-4-hydrogen-high",
    ]
  ) {
    // Codex only has GPT models; the Claude payload fixtures also prove no model allowlist.
    if (surface === "codex" && !model.startsWith("gpt-")) continue;
    Deno.test(`${surface}: ${model} gives search, read and modify the same allowing answer`, async () => {
      const prefix = surface === "codex" ? "mcp__codex_apps__gmail_" : "mcp__gmail__";
      for (const tool of ["search_emails", "read_email", "modify_email"]) {
        const note = await probe(surface, model, prefix + tool);
        const expensive = surface === "codex"
          ? model === "gpt-6.2-astra"
          : /opus|fable/.test(model);
        if (expensive) {
          assertStringIncludes(note!, "Gmail model note: this session runs on");
          assertStringIncludes(note!, "A one-off lookup needs no question.");
        } else assertEquals(note, undefined);
      }
    });
  }
  Deno.test(`${surface}: records with no readable model allow with the specified note`, async () => {
    assertEquals(await probe(surface, "", "search_emails"), UNKNOWN_GMAIL_MODEL_NOTE);
  });
  Deno.test(`${surface}: unreadable identity allows with the specified note`, async () => {
    assertEquals(await probe(surface, "", "search_emails", true), UNKNOWN_GMAIL_MODEL_NOTE);
  });
}

Deno.test("model CLI selector skips model-less api-request-blob and sidechain/error entries", () => {
  assertEquals(
    selectSessionModel([
      { type: "assistant", message: { model: "claude-sonnet-5-5", content: "hello" } },
      { type: "api-request-blob", message: { role: "assistant", content: [] } },
      { type: "assistant", isSidechain: true, message: { model: "claude-opus-5-5" } },
      { type: "assistant", isApiErrorMessage: true, message: { model: "claude-opus-5-5" } },
    ]),
    "claude-sonnet-5-5",
  );
  assertEquals(
    selectSessionModel([{ type: "api-request-blob", message: { role: "assistant" } }]),
    "",
  );
  assertEquals(gmailModelNote("", "claude"), UNKNOWN_GMAIL_MODEL_NOTE);
  assertEquals(
    selectSessionModel([
      { type: "assistant", message: { model: "claude-haiku-5-5", content: "older" } },
      { type: "assistant", message: { model: "claude-sonnet-5-5" } },
      { type: "api-request-blob", message: { role: "assistant" } },
    ]),
    "claude-sonnet-5-5",
  );
});

const costCases = [
  ["Claude Code Opus", "**Claude Code on Opus:**", "This is Opus."],
  ["Claude Code Fable", "**Claude Code on Fable:**", "This is Fable."],
  ["Claude Code Sonnet", "Haiku and Sonnet on Claude Code", "ask nothing"],
  ["Claude Code Haiku", "Haiku and Sonnet on Claude Code", "ask nothing"],
  ["Claude Code unreadable", "If identity cannot be read", "proceed with that visible note"],
  [
    "agy Opus",
    "**agy on Opus (`Claude Opus 5.5 (High)`, which `deno task running-model` returns as `Claude Opus`):**",
    "“This is Opus. Are you sure you want to do this? Opus is expensive; you should probably use Sonnet or Hydrogen.”",
  ],
  ["agy other allowed model", "every other allowed agy model", "ask nothing"],
  [
    "agy unreadable",
    "On Claude Code, agy and Codex",
    "“the model could not be read” and proceed with that visible note",
  ],
  [
    "Codex Astra",
    "**Codex on Astra:**",
    "Astra is expensive you should probably choose a cheaper model.",
  ],
  ["Codex Sol or Luna", "Sol and Luna on Codex", "ask nothing"],
  ["Codex unreadable", "If identity cannot be read", "proceed with that visible note"],
];

const readSkill = () =>
  Deno.readTextFile(new URL("../skills/handle-gmails/SKILL.md", import.meta.url));

// One paragraph or one model bullet, so a case cannot pass on text belonging to another row.
function instructionBlock(skill: string, condition: string): string {
  const matches = skill.split(/\n\n|\n(?=- \*\*)/).filter((block) => block.includes(condition));
  assertEquals(matches.length, 1, `expected one block containing ${condition}`);
  return matches[0];
}

for (const [name, condition, action] of costCases) {
  Deno.test(`cost-question instruction case: ${name}`, async () => {
    const skill = await readSkill();
    assertStringIncludes(instructionBlock(skill, condition), action);
    assertStringIncludes(skill, "Wait for Josh’s affirmative reply before any mailbox work");
    assertStringIncludes(skill, "A refusal\nstops that invocation.");
    assertStringIncludes(skill, "Silence is not approval.");
    assertStringIncludes(skill, "A one-off mailbox read outside this skill asks no cost question");
  });
}

Deno.test("agy models that ask nothing are pointed to, never restated", async () => {
  const block = instructionBlock(await readSkill(), "every other allowed agy model");
  assertStringIncludes(block, "model-tier-order-design-2026-10-02.md`, “The agy model guard”");
  for (const name of ["Argon", "Hydrogen", "Neon", "Carbon"]) {
    assert(!block.includes(name), `the no-question bullet restates ${name}`);
  }
});

Deno.test("model selector CLI skips model-less records after a readable main entry", async () => {
  const file = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(
      file,
      [
        { type: "assistant", message: { model: "claude-sonnet-5-5", content: "hello" } },
        { type: "api-request-blob", message: { role: "assistant", content: [] } },
      ].map((row) => JSON.stringify(row)).join("\n"),
    );
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        new URL("../hooks/lib/select_transcript_entry.ts", import.meta.url).pathname,
        "--model",
        file,
      ],
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).output();
    assertEquals(result.code, 0);
    assertEquals(new TextDecoder().decode(result.stdout).trim(), "claude-sonnet-5-5");
  } finally {
    await Deno.remove(file);
  }
});
