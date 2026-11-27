// block_personal_numbers_prompt_hook.test.ts — web-jam-tools#1861
//
// One Deno test per row of the table of literal messages in "What Josh types",
// ~/Dropbox/web-jam-llms/AI_Misbehaves/personal-information-guards-design.md.
// Each row runs through the real entry point, hooks/block-personal-numbers-prompt.sh,
// on all three tools: Claude Code's UserPromptSubmit payload, Codex's
// UserPromptSubmit payload (WJT_SURFACE=codex) and agy's PreInvocation payload
// (--surface agy). Every number is made up.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkPayload,
  refusalFor,
  reply,
  surfaceFrom,
} from "../hooks/lib/check_personal_numbers_prompt.ts";

const SCRIPT = new URL("../hooks/block-personal-numbers-prompt.sh", import.meta.url).pathname;
const SESSION = "00000000-0000-0000-0000-000000000000";

type Tool = "claude" | "codex" | "agy";
const TOOLS: Tool[] = ["claude", "codex", "agy"];

/** Each tool's payload, with the keys the design's premises recorded. */
function payload(tool: Tool, message: string): string {
  if (tool === "agy") {
    return JSON.stringify({
      artifactDirectoryPath: "/tmp/agy-artifacts",
      conversationId: SESSION,
      cwd: "/tmp",
      hookEventName: "PreInvocation",
      initialNumSteps: 0,
      invocationNum: 0,
      lastUserInput: message,
      modelName: "Gemini 4 Hydrogen (High)",
      transcriptPath: "/tmp/agy-transcript.jsonl",
      workspacePaths: ["/tmp"],
    });
  }
  if (tool === "codex") {
    return JSON.stringify({
      cwd: "/tmp",
      hook_event_name: "UserPromptSubmit",
      model: "gpt-6-luna",
      permission_mode: "default",
      prompt: message,
      session_id: SESSION,
      transcript_path: "/tmp/codex-transcript.jsonl",
      turn_id: "turn-1",
    });
  }
  return JSON.stringify({
    session_id: SESSION,
    transcript_path: "/tmp/claude-transcript.jsonl",
    cwd: "/tmp",
    hook_event_name: "UserPromptSubmit",
    prompt: message,
  });
}

interface HookRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runHook(tool: Tool, input: string): Promise<HookRun> {
  const env = Deno.env.toObject();
  delete env.WJT_SURFACE;
  if (tool === "codex") env.WJT_SURFACE = "codex";
  const child = new Deno.Command("bash", {
    args: tool === "agy" ? [SCRIPT, "--surface", "agy"] : [SCRIPT],
    env,
    clearEnv: true,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout).trim(),
    stderr: new TextDecoder().decode(stderr).trim(),
  };
}

/** The refusal a tool showed, or null when the message was sent. */
function refusalShown(tool: Tool, run: HookRun): string | null {
  if (tool === "claude") {
    if (run.code === 0) {
      assertEquals(run.stdout, "");
      return null;
    }
    assertEquals(run.code, 2);
    return run.stderr;
  }
  assertEquals(run.code, 0, run.stderr);
  if (tool === "codex") {
    if (run.stdout === "") return null;
    const out = JSON.parse(run.stdout);
    assertEquals(out.decision, "block");
    return out.reason;
  }
  const out = JSON.parse(run.stdout);
  if (out.terminationBehavior === undefined && out.injectSteps === undefined) return null;
  assertEquals(out.terminationBehavior, "terminate");
  assertEquals(out.injectSteps.length, 1);
  return out.injectSteps[0].errorMessage.userMessage;
}

const wording = (what: string) =>
  `Your message holds what looks like ${what}, so it was not sent. Take the number out and send it again.`;

/** The digits of a message's protected number, which no refusal may carry. */
const NUMBERS: Record<string, string[]> = {
  "my card is 4539 1488 0343 6467, is that charge right?": ["4539 1488 0343 6467"],
  "SSN 123-45-6789": ["123-45-6789"],
  "routing number 021000021 account number 1234567890": ["021000021", "1234567890"],
};

const ROWS: Array<{ message: string; refusedNaming: string | null }> = [
  {
    message: "my card is 4539 1488 0343 6467, is that charge right?",
    refusedNaming: "a card number",
  },
  { message: "SSN 123-45-6789", refusedNaming: "a Social Security number" },
  {
    message: "routing number 021000021 account number 1234567890",
    refusedNaming: "a routing number and a bank account number",
  },
  { message: "penn station, 22.86", refusedNaming: null },
  { message: "the charge on the card ending in 1234", refusedNaming: null },
  { message: "2025 total tax 18,432 and AGI 151,220", refusedNaming: null },
  { message: "born 1975-04-02", refusedNaming: null },
];

for (const row of ROWS) {
  const result = row.refusedNaming === null ? "sent" : `refused, naming ${row.refusedNaming}`;
  Deno.test(`What Josh types: \`${row.message}\` — ${result}, on Claude Code, Codex and agy`, async () => {
    for (const tool of TOOLS) {
      const shown = refusalShown(tool, await runHook(tool, payload(tool, row.message)));
      if (row.refusedNaming === null) {
        assertEquals(shown, null, `${tool} refused a message the design sends`);
        continue;
      }
      assertEquals(shown, wording(row.refusedNaming), tool);
      for (const number of NUMBERS[row.message]) {
        assert(!shown!.includes(number), `${tool}'s refusal carries the number`);
      }
    }
  });
}

// --- Cannot tell: a payload with no readable message fails closed on every tool ---

for (const tool of TOOLS) {
  Deno.test(`Cannot tell: ${tool} refuses a payload that is not JSON, or holds no message`, async () => {
    const field = tool === "agy" ? "lastUserInput" : "prompt";
    const noMessage = JSON.parse(payload(tool, ""));
    delete noMessage[field];
    const notText = { ...JSON.parse(payload(tool, "")), [field]: 42 };
    for (const input of ["not json", "[]", JSON.stringify(noMessage), JSON.stringify(notText)]) {
      const shown = refusalShown(tool, await runHook(tool, input));
      assert(shown !== null, `${tool} sent an unreadable payload: ${input}`);
      assertStringIncludes(shown!, "it was not sent");
    }
  });
}

Deno.test("Each tool reads only its own message field", () => {
  // agy's message is lastUserInput; a `prompt` key on its payload is not read.
  assertEquals(
    checkPayload(JSON.stringify({ prompt: "SSN 123-45-6789" }), "agy").kind,
    "unreadable",
  );
  assertEquals(
    checkPayload(JSON.stringify({ lastUserInput: "SSN 123-45-6789" }), "claude").kind,
    "unreadable",
  );
  assertEquals(checkPayload(JSON.stringify({ prompt: "" }), "codex").kind, "allow");
});

Deno.test("The tool is agy only with --surface agy, Codex only with WJT_SURFACE=codex", () => {
  assertEquals(surfaceFrom(["--surface", "agy"], undefined), "agy");
  assertEquals(surfaceFrom(["--surface", "agy"], "codex"), "agy");
  assertEquals(surfaceFrom([], "codex"), "codex");
  assertEquals(surfaceFrom([], undefined), "claude");
  assertEquals(surfaceFrom([], "agy"), "claude");
});

Deno.test("A sent message prints nothing on Claude Code and Codex, and an empty reply on agy", () => {
  const allow = { kind: "allow" } as const;
  assertEquals(refusalFor(allow), null);
  assertEquals(reply(allow, "claude"), { stdout: "", stderr: "", code: 0 });
  assertEquals(reply(allow, "codex"), { stdout: "", stderr: "", code: 0 });
  assertEquals(reply(allow, "agy"), { stdout: "{}", stderr: "", code: 0 });
});
