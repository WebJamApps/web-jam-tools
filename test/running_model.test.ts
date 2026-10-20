import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { runRunningModel } from "../scripts/running-model.ts";
import { readAuthorRoster, type RunningModelOptions } from "../src/shared/codex_running_model.ts";

const CODEX_ID = "01a10611-a947-7b00-87b3-414e9e2085eb";
const CLAUDE_ID = "xyz";
const FLASH_RECORD = {
  conversationId: "agy-conversation",
  modelName: "gemini-3.8-flash-high",
  transcriptPath: "/tmp/agy-conversation.jsonl",
};

interface Fixture {
  home: string;
  env: Record<string, string>;
  options: RunningModelOptions;
  codex: (model: string, folder?: string) => Promise<void>;
  claude: (text: string, project?: string) => Promise<void>;
  agy: (record?: unknown, setEnv?: boolean) => Promise<void>;
}

async function withFixture(test: (fixture: Fixture) => Promise<void>): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "running-model-" });
  const env: Record<string, string> = {
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    AGY_HOOK_RECORD_PATH: join(home, "agy.jsonl"),
  };
  await Deno.mkdir(join(env.CODEX_HOME, "sessions"), { recursive: true });
  await Deno.mkdir(join(home, ".claude", "projects"), { recursive: true });
  const fixture: Fixture = {
    home,
    env,
    options: { env: (name) => env[name], readRoster: readAuthorRoster },
    codex: async (model, folder = "one") => {
      const directory = join(env.CODEX_HOME, "sessions", folder);
      await Deno.mkdir(directory, { recursive: true });
      await Deno.writeTextFile(
        join(directory, `rollout-${CODEX_ID}.jsonl`),
        JSON.stringify({ type: "turn_context", payload: { model } }),
      );
    },
    claude: async (text, project = "one") => {
      const directory = join(home, ".claude", "projects", project);
      await Deno.mkdir(directory, { recursive: true });
      await Deno.writeTextFile(join(directory, `${CLAUDE_ID}.jsonl`), text);
    },
    agy: async (record: unknown = FLASH_RECORD, setEnv = true) => {
      await Deno.writeTextFile(env.AGY_HOOK_RECORD_PATH, JSON.stringify(record) + "\n");
      if (setEnv) {
        const r = (record && typeof record === "object" && !Array.isArray(record))
          ? (record as Record<string, unknown>)
          : {};
        env.AGY_CONVERSATION_ID = typeof r.conversationId === "string"
          ? r.conversationId
          : "agy-conversation";
        env.AGY_MODEL_NAME = typeof r.modelName === "string"
          ? r.modelName
          : "gemini-3.8-flash-high";
        if (typeof r.transcriptPath === "string") {
          env.AGY_TRANSCRIPT_PATH = r.transcriptPath;
        } else {
          delete env.AGY_TRANSCRIPT_PATH;
        }
      }
    },
  };
  try {
    await test(fixture);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
}

function assistant(model: string, flags: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "assistant", message: { model, content: [] }, ...flags });
}

async function invoke(options: RunningModelOptions) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runRunningModel(
    options,
    (text) => stdout.push(text),
    (text) => stderr.push(text),
  );
  return { code, stdout, stderr };
}

async function succeeds(fixture: Fixture, model: string): Promise<void> {
  assertEquals(await invoke(fixture.options), { code: 0, stdout: [model], stderr: [] });
}

async function refuses(fixture: Fixture, reason: string): Promise<void> {
  const result = await invoke(fixture.options);
  assertEquals(result.code, 1);
  assertEquals(result.stdout, []);
  assertEquals(result.stderr.length, 1);
  assertStringIncludes(result.stderr[0], "Cannot tell the running model");
  assertStringIncludes(result.stderr[0], reason);
}

for (
  const [slug, name] of [
    ["gpt-6-astra", "GPT-6 Astra"],
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ["gpt-6-luna", "GPT-6 Luna"],
  ]
) {
  Deno.test(`running-model reads Codex ${slug}`, () =>
    withFixture(async (fixture) => {
      fixture.env.CODEX_THREAD_ID = CODEX_ID;
      await fixture.codex(slug);
      await succeeds(fixture, name);
    }));
}

Deno.test("running-model reads the newest Codex turn instead of the first model", () =>
  withFixture(async (fixture) => {
    fixture.env.CODEX_THREAD_ID = CODEX_ID;
    await fixture.codex("gpt-6-astra");
    await Deno.writeTextFile(
      join(fixture.env.CODEX_HOME, "sessions", "one", `rollout-${CODEX_ID}.jsonl`),
      '\n{"type":"turn_context","payload":{"model":"gpt-6.1-sol"}}',
      { append: true },
    );
    await succeeds(fixture, "GPT-6.1 Sol");
  }));

Deno.test("running-model refuses a missing Codex record, even with a stale agy record", () =>
  withFixture(async (fixture) => {
    fixture.env.CODEX_THREAD_ID = CODEX_ID;
    await fixture.agy(FLASH_RECORD, false);
    await refuses(fixture, "No session file");
  }));

Deno.test("running-model refuses two matching Codex session files", () =>
  withFixture(async (fixture) => {
    fixture.env.CODEX_THREAD_ID = CODEX_ID;
    await fixture.codex("gpt-6.1-sol");
    await fixture.codex("gpt-6.1-sol", "two");
    await refuses(fixture, "Multiple session files");
  }));

Deno.test("running-model refuses a Codex model missing from the roster", () =>
  withFixture(async (fixture) => {
    fixture.env.CODEX_THREAD_ID = CODEX_ID;
    await fixture.codex("gpt-9");
    await refuses(fixture, "no author roster entry");
  }));

for (
  const [slug, name] of [
    ["claude-opus-5-5", "Claude Opus"],
    ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
    ["claude-haiku-5-5", "Claude Haiku 5.5"],
    ["claude-sonnet-5-5-20261001", "Claude Sonnet 5.5"],
  ]
) {
  Deno.test(`running-model reads Claude Code ${slug}`, () =>
    withFixture(async (fixture) => {
      fixture.env.CLAUDE_CODE_SESSION_ID = CLAUDE_ID;
      await fixture.claude(assistant(slug));
      await succeeds(fixture, name);
    }));
}

Deno.test("running-model refuses a missing Claude record, even with an agy record", () =>
  withFixture(async (fixture) => {
    fixture.env.CLAUDE_CODE_SESSION_ID = CLAUDE_ID;
    await fixture.agy(FLASH_RECORD, false);
    await refuses(fixture, "found 0");
  }));

Deno.test("running-model refuses the same Claude session in two project folders", () =>
  withFixture(async (fixture) => {
    fixture.env.CLAUDE_CODE_SESSION_ID = CLAUDE_ID;
    await fixture.claude(assistant("claude-sonnet-5-5"));
    await fixture.claude(assistant("claude-sonnet-5-5"), "two");
    await refuses(fixture, "found 2");
  }));

Deno.test("running-model refuses a Claude record without an assistant entry", () =>
  withFixture(async (fixture) => {
    fixture.env.CLAUDE_CODE_SESSION_ID = CLAUDE_ID;
    await fixture.claude(JSON.stringify({ type: "user", message: { content: "Claude Opus" } }));
    await refuses(fixture, "no recorded model");
  }));

Deno.test("running-model selects the newest main Claude assistant, ignoring helper and error entries", () =>
  withFixture(async (fixture) => {
    fixture.env.CLAUDE_CODE_SESSION_ID = CLAUDE_ID;
    await fixture.claude([
      assistant("claude-opus-5-5"),
      assistant("claude-sonnet-5-5"),
      assistant("claude-opus-5-5", { isSidechain: true }),
      assistant("claude-opus-5-5", { isApiErrorMessage: true }),
    ].join("\n"));
    await succeeds(fixture, "Claude Sonnet 5.5");
  }));

Deno.test("running-model refuses a newest Claude entry without a model instead of using older metadata", () =>
  withFixture(async (fixture) => {
    fixture.env.CLAUDE_CODE_SESSION_ID = CLAUDE_ID;
    await fixture.claude([
      assistant("claude-opus-5-5"),
      JSON.stringify({ type: "assistant", message: { content: "I am Claude Opus" } }),
    ].join("\n"));
    await refuses(fixture, "no recorded model");
  }));

Deno.test("running-model refuses unknown Claude models", () =>
  withFixture(async (fixture) => {
    fixture.env.CLAUDE_CODE_SESSION_ID = CLAUDE_ID;
    await fixture.claude(assistant("claude-sonnet-99-99"));
    await refuses(fixture, "no author roster entry");
  }));

Deno.test("running-model rejects unsafe Claude session identifiers", () =>
  withFixture(async (fixture) => {
    fixture.env.CLAUDE_CODE_SESSION_ID = "../../other";
    await refuses(fixture, "not a safe session id");
  }));

for (
  const [modelName, expected] of [
    ["gemini-3.8-flash-high", "Gemini Flash"],
    ["gemini-3.8-flash-tiered", "Gemini Flash"],
    ["Gemini 3.8 Flash (High)", "Gemini Flash"],
    ["Gemini Flash", "Gemini Flash"],
    ["gemini-4-argon-high", "Gemini Argon"],
    ["Gemini 4 Argon (High)", "Gemini Argon"],
    ["Gemini Argon", "Gemini Argon"],
    ["claude-sonnet-5-5-high", "Claude Sonnet 5.5"],
    ["Claude Sonnet 5.5 (High)", "Claude Sonnet 5.5"],
    ["Claude Sonnet 5.5", "Claude Sonnet 5.5"],
  ] as const
) {
  Deno.test(`running-model reads agy's ${modelName} hook record with neither id set`, () =>
    withFixture(async (fixture) => {
      await fixture.agy({ ...FLASH_RECORD, modelName });
      await succeeds(fixture, expected);
    }));
}

Deno.test("running-model refuses when neither session id nor an agy hook record exists", () =>
  withFixture((fixture) => refuses(fixture, "No such file")));

for (
  const [record, reason] of [
    [null, "not an object"],
    [[], "not an object"],
    [{ modelName: "Gemini Flash" }, "no running conversation"],
    [{ conversationId: "agy-conversation" }, "no recorded model"],
    [{ ...FLASH_RECORD, modelName: "gemini-9-pro" }, "no author roster entry"],
    [{ ...FLASH_RECORD, modelName: "gemini-4-argon-low" }, "no author roster entry"],
    [{ ...FLASH_RECORD, modelName: "gemini-4-argon-medium" }, "no author roster entry"],
    [{ ...FLASH_RECORD, modelName: "Gemini 4 Argon (Low)" }, "no author roster entry"],
    [{ ...FLASH_RECORD, modelName: "Gemini 4 Argon (Medium)" }, "no author roster entry"],
    [{ ...FLASH_RECORD, modelName: "claude-sonnet-5-5-low" }, "no author roster entry"],
    [{ ...FLASH_RECORD, modelName: "claude-sonnet-5-5-medium" }, "no author roster entry"],
    [{ ...FLASH_RECORD, modelName: "Claude Sonnet 5.5 (Low)" }, "no author roster entry"],
    [{ ...FLASH_RECORD, modelName: "Claude Sonnet 5.5 (Medium)" }, "no author roster entry"],
    [{ ...FLASH_RECORD, modelName: "Totally Fake Model" }, "no author roster entry"],
  ] as const
) {
  Deno.test(`running-model refuses an agy record: ${reason} ${JSON.stringify(record)}`, () =>
    withFixture(async (fixture) => {
      await fixture.agy(record);
      await refuses(fixture, reason);
    }));
}

Deno.test("running-model refuses an empty agy hook record", () =>
  withFixture(async (fixture) => {
    await Deno.writeTextFile(fixture.env.AGY_HOOK_RECORD_PATH, "\n");
    await refuses(fixture, "empty");
  }));

Deno.test("running-model does not skip a malformed newest agy record to use an older model", () =>
  withFixture(async (fixture) => {
    await fixture.agy();
    await Deno.writeTextFile(fixture.env.AGY_HOOK_RECORD_PATH, "\n{broken", { append: true });
    await refuses(fixture, "JSON");
  }));

Deno.test("running-model refuses two claiming tools before reading the roster or any records", () =>
  withFixture(async (fixture) => {
    fixture.env.CODEX_THREAD_ID = CODEX_ID;
    fixture.env.CLAUDE_CODE_SESSION_ID = CLAUDE_ID;
    await fixture.agy(FLASH_RECORD, false);
    fixture.options.readRoster = () => Promise.reject(new Error("must not read"));
    await refuses(fixture, "Two tools claim the session");
  }));

for (const surface of ["codex", "claude"] as const) {
  Deno.test(`running-model prefers the ${surface} id over agy's shared record`, () =>
    withFixture(async (fixture) => {
      await fixture.agy(FLASH_RECORD, false);
      if (surface === "codex") {
        fixture.env.CODEX_THREAD_ID = CODEX_ID;
        await fixture.codex("gpt-6.1-sol");
        await succeeds(fixture, "GPT-6.1 Sol");
      } else {
        fixture.env.CLAUDE_CODE_SESSION_ID = CLAUDE_ID;
        await fixture.claude(assistant("claude-opus-5-5"));
        await succeeds(fixture, "Claude Opus");
      }
    }));
}

for (const surface of ["codex", "claude", "agy"] as const) {
  Deno.test(`running-model refuses two matching roster entries for ${surface}`, () =>
    withFixture(async (fixture) => {
      let entries: string[];
      if (surface === "codex") {
        fixture.env.CODEX_THREAD_ID = CODEX_ID;
        await fixture.codex("gpt-6.1-sol");
        entries = ["GPT-6.1 Sol", "GPT-6.1 Sol"];
      } else if (surface === "claude") {
        fixture.env.CLAUDE_CODE_SESSION_ID = CLAUDE_ID;
        await fixture.claude(assistant("claude-opus-5-5"));
        entries = ["Claude Opus", "Claude Opus 5.5"];
      } else {
        await fixture.agy();
        entries = ["Gemini Flash", "Gemini Flash"];
      }
      fixture.options.readRoster = () => Promise.resolve(entries);
      await refuses(fixture, "Two author roster entries");
    }));
}

Deno.test("running-model refuses an unreadable roster", () =>
  withFixture(async (fixture) => {
    fixture.options.readRoster = () => Promise.reject(new Error("roster unreadable"));
    await refuses(fixture, "roster unreadable");
  }));

for (const surface of ["codex", "claude", "agy", "none"] as const) {
  Deno.test(`running-model task uses scoped permissions and exits correctly for ${surface}`, () =>
    withFixture(async (fixture) => {
      const models = { codex: "GPT-6.1 Sol", claude: "Claude Opus", agy: "Gemini Flash", none: "" };
      if (surface === "codex") {
        fixture.env.CODEX_THREAD_ID = CODEX_ID;
        await fixture.codex("gpt-6.1-sol");
      } else if (surface === "claude") {
        fixture.env.CLAUDE_CODE_SESSION_ID = CLAUDE_ID;
        await fixture.claude(assistant("claude-opus-5-5"));
      } else if (surface === "agy") {
        await fixture.agy();
      }
      const result = await new Deno.Command(Deno.execPath(), {
        args: ["task", "running-model"],
        cwd: new URL("..", import.meta.url).pathname,
        clearEnv: true,
        env: { ...fixture.env, PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(result.code, surface === "none" ? 1 : 0);
      assertEquals(
        new TextDecoder().decode(result.stdout),
        models[surface] ? `${models[surface]}\n` : "",
      );
      if (surface === "none") {
        assertStringIncludes(
          new TextDecoder().decode(result.stderr),
          "Cannot tell the running model",
        );
      }
    }));
}

Deno.test("running-model resolves alpha Gemini Argon when newer beta Sonnet row is present", () =>
  withFixture(async (fixture) => {
    const alphaRecord = {
      conversationId: "alpha",
      modelName: "gemini-4-argon-high",
      transcriptPath: "/tmp/alpha.jsonl",
    };
    const betaRecord = {
      conversationId: "beta",
      modelName: "claude-sonnet-5-5-high",
      transcriptPath: "/tmp/beta.jsonl",
    };
    await Deno.writeTextFile(
      fixture.env.AGY_HOOK_RECORD_PATH,
      `${JSON.stringify(alphaRecord)}\n${JSON.stringify(betaRecord)}\n`,
    );
    fixture.env.AGY_CONVERSATION_ID = "alpha";
    fixture.env.AGY_MODEL_NAME = "gemini-4-argon-high";
    fixture.env.AGY_TRANSCRIPT_PATH = "/tmp/alpha.jsonl";
    await succeeds(fixture, "Gemini Argon");
  }));

Deno.test("running-model resolves beta Claude Sonnet 5.5 when newer alpha Argon row is present", () =>
  withFixture(async (fixture) => {
    const betaRecord = {
      conversationId: "beta",
      modelName: "claude-sonnet-5-5-high",
      transcriptPath: "/tmp/beta.jsonl",
    };
    const alphaRecord = {
      conversationId: "alpha",
      modelName: "gemini-4-argon-high",
      transcriptPath: "/tmp/alpha.jsonl",
    };
    await Deno.writeTextFile(
      fixture.env.AGY_HOOK_RECORD_PATH,
      `${JSON.stringify(betaRecord)}\n${JSON.stringify(alphaRecord)}\n`,
    );
    fixture.env.AGY_CONVERSATION_ID = "beta";
    fixture.env.AGY_MODEL_NAME = "claude-sonnet-5-5-high";
    fixture.env.AGY_TRANSCRIPT_PATH = "/tmp/beta.jsonl";
    await succeeds(fixture, "Claude Sonnet 5.5");
  }));

Deno.test("running-model resolves Gemini Flash via flash invocationContext", () =>
  withFixture(async (fixture) => {
    const record = {
      conversationId: "flash",
      modelName: "gemini-3.8-flash-high",
      transcriptPath: "/tmp/flash.jsonl",
    };
    await fixture.agy(record, false);
    fixture.options.invocationContext = {
      conversationId: "flash",
      modelName: "gemini-3.8-flash-high",
      transcriptPath: "/tmp/flash.jsonl",
    };
    await succeeds(fixture, "Gemini Flash");
  }));

Deno.test("running-model resolves existing Flash compatibility form gemini-3.8-flash-tiered via invocationContext", () =>
  withFixture(async (fixture) => {
    const record = {
      conversationId: "flash",
      modelName: "gemini-3.8-flash-tiered",
      transcriptPath: "/tmp/flash.jsonl",
    };
    await fixture.agy(record, false);
    fixture.options.invocationContext = {
      conversationId: "flash",
      modelName: "gemini-3.8-flash-tiered",
      transcriptPath: "/tmp/flash.jsonl",
    };
    await succeeds(fixture, "Gemini Flash");
  }));

Deno.test("running-model refuses contradictory context (transcript mismatch)", () =>
  withFixture(async (fixture) => {
    const record = {
      conversationId: "alpha",
      modelName: "gemini-4-argon-high",
      transcriptPath: "/tmp/alpha.jsonl",
    };
    await fixture.agy(record, false);
    fixture.options.invocationContext = {
      conversationId: "alpha",
      modelName: "gemini-4-argon-high",
      transcriptPath: "/tmp/beta.jsonl",
    };
    await refuses(fixture, "Contradictory context");
  }));

Deno.test("running-model refuses missing identity (empty conversationId)", () =>
  withFixture(async (fixture) => {
    const record = {
      conversationId: "alpha",
      modelName: "gemini-4-argon-high",
      transcriptPath: "/tmp/alpha.jsonl",
    };
    await fixture.agy(record, false);
    fixture.options.invocationContext = {
      conversationId: "",
      modelName: "gemini-4-argon-high",
      transcriptPath: "/tmp/alpha.jsonl",
    };
    await refuses(fixture, "Missing calling conversation identity");
  }));

Deno.test("running-model refuses missing model (empty modelName)", () =>
  withFixture(async (fixture) => {
    const record = {
      conversationId: "alpha",
      modelName: "gemini-4-argon-high",
      transcriptPath: "/tmp/alpha.jsonl",
    };
    await fixture.agy(record, false);
    fixture.options.invocationContext = {
      conversationId: "alpha",
      modelName: "",
      transcriptPath: "/tmp/alpha.jsonl",
    };
    await refuses(fixture, "Invocation context has missing model");
  }));

Deno.test("running-model refuses unknown model (Totally Fake Model)", () =>
  withFixture(async (fixture) => {
    const record = {
      conversationId: "alpha",
      modelName: "Totally Fake Model",
      transcriptPath: "/tmp/alpha.jsonl",
    };
    await fixture.agy(record, false);
    fixture.options.invocationContext = {
      conversationId: "alpha",
      modelName: "Totally Fake Model",
      transcriptPath: "/tmp/alpha.jsonl",
    };
    await refuses(fixture, "no author roster entry");
  }));

Deno.test("running-model refuses missing trusted context (invocationContext is null)", () =>
  withFixture(async (fixture) => {
    await fixture.agy(FLASH_RECORD, false);
    fixture.options.invocationContext = null;
    await refuses(fixture, "Missing trusted invocation context");
  }));

Deno.test("running-model refuses competing surface identities: CODEX_THREAD_ID and AGY_CONVERSATION_ID", () =>
  withFixture(async (fixture) => {
    fixture.env.CODEX_THREAD_ID = "codex-alpha";
    fixture.env.AGY_CONVERSATION_ID = "alpha";
    await fixture.agy(
      {
        conversationId: "alpha",
        modelName: "gemini-4-argon-high",
        transcriptPath: "/tmp/alpha.jsonl",
      },
      false,
    );
    await refuses(fixture, "Two tools claim the session: Codex and agy");
  }));

Deno.test("running-model refuses competing surface identities: CLAUDE_CODE_SESSION_ID and AGY_CONVERSATION_ID", () =>
  withFixture(async (fixture) => {
    fixture.env.CLAUDE_CODE_SESSION_ID = "claude-alpha";
    fixture.env.AGY_CONVERSATION_ID = "alpha";
    await fixture.agy(
      {
        conversationId: "alpha",
        modelName: "gemini-4-argon-high",
        transcriptPath: "/tmp/alpha.jsonl",
      },
      false,
    );
    await refuses(fixture, "Two tools claim the session: Claude Code and agy");
  }));

Deno.test("running-model refuses ambiguous roster match for Gemini Argon", () =>
  withFixture(async (fixture) => {
    await fixture.agy({
      conversationId: "alpha",
      modelName: "gemini-4-argon-high",
      transcriptPath: "/tmp/alpha.jsonl",
    });
    fixture.options.readRoster = () => Promise.resolve(["Gemini Argon", "Gemini Argon"]);
    await refuses(fixture, "Two author roster entries stand for gemini-4-argon-high");
  }));

Deno.test("running-model refuses unreadable record file", () =>
  withFixture(async (fixture) => {
    fixture.env.AGY_CONVERSATION_ID = "alpha";
    fixture.env.AGY_HOOK_RECORD_PATH = join(fixture.home, "non-existent-agy.jsonl");
    await refuses(fixture, "Cannot read the agy model record");
  }));

Deno.test("running-model selects newest turn for the same conversation as ordinary history", () =>
  withFixture(async (fixture) => {
    const turn1 = {
      conversationId: "alpha",
      modelName: "gemini-3.8-flash-high",
      transcriptPath: "/tmp/alpha.jsonl",
    };
    const turn2 = {
      conversationId: "alpha",
      modelName: "gemini-4-argon-high",
      transcriptPath: "/tmp/alpha.jsonl",
    };
    await Deno.writeTextFile(
      fixture.env.AGY_HOOK_RECORD_PATH,
      `${JSON.stringify(turn1)}\n${JSON.stringify(turn2)}\n`,
    );
    fixture.env.AGY_CONVERSATION_ID = "alpha";
    fixture.env.AGY_MODEL_NAME = "gemini-4-argon-high";
    fixture.env.AGY_TRANSCRIPT_PATH = "/tmp/alpha.jsonl";
    await succeeds(fixture, "Gemini Argon");
  }));

Deno.test("running-model refuses an unmatched conversation identity without selecting newest global row", () =>
  withFixture(async (fixture) => {
    const alphaRecord = {
      conversationId: "alpha",
      modelName: "gemini-4-argon-high",
      transcriptPath: "/tmp/alpha.jsonl",
    };
    await Deno.writeTextFile(
      fixture.env.AGY_HOOK_RECORD_PATH,
      `${JSON.stringify(alphaRecord)}\n`,
    );
    fixture.env.AGY_CONVERSATION_ID = "gamma";
    fixture.env.AGY_MODEL_NAME = "gemini-4-argon-high";
    fixture.env.AGY_TRANSCRIPT_PATH = "/tmp/gamma.jsonl";
    await refuses(fixture, "No agy hook record matches conversation gamma");
  }));
