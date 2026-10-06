import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  readAuthorRoster,
  resolveSigningAuthor,
  type RunningModelOptions,
} from "../src/shared/codex_running_model.ts";
import {
  LUNA_SIGNATURE,
  SIGNING_SESSION_ID,
  withSigningFixture,
} from "./support/codex_signing_fixture.ts";
import { runWhoami } from "../scripts/whoami.ts";

const SESSION_ID = "01a10611-a947-7b00-87b3-414e9e2085eb";
for (const author of ["Codex — GPT-6.1 Sol", undefined]) {
  Deno.test(`signing a/b: lookup replaces ${author ?? "missing author"}`, () =>
    withSigningFixture(async (options) => {
      assertEquals(await resolveSigningAuthor(author, options), LUNA_SIGNATURE);
    }));
}

for (const id of [undefined, ""]) {
  Deno.test(`signing c/i: ${id === undefined ? "unset" : "empty"} session preserves typed author`, async () => {
    const options = {
      env: () => id,
      readRoster: () => Promise.reject(new Error("must not look up")),
    };
    assertEquals(await resolveSigningAuthor("Claude Code — Opus", options), "Claude Code — Opus");
    assertEquals(await resolveSigningAuthor(undefined, options), undefined);
  });
}

for (const author of [undefined, "Codex — GPT-6.1 Sol"]) {
  Deno.test(`signing f/g: forced author with lookup refuses ${author ?? "no typed name"}`, () =>
    withSigningFixture(async (options, env) => {
      env.FORCED_PR_AUTHOR = "agy — Gemini Flash (High)";
      await assertRejects(
        () => resolveSigningAuthor(author, options),
        Error,
        "CODEX_THREAD_ID and FORCED_PR_AUTHOR",
      );
    }));
}

Deno.test("signing h: missing session refuses despite a valid typed name", () =>
  withSigningFixture(async (options, _env, sessionPath) => {
    await Deno.remove(sessionPath);
    await assertRejects(
      () => resolveSigningAuthor(LUNA_SIGNATURE, options),
      Error,
      SIGNING_SESSION_ID,
    );
  }));

Deno.test("whoami signing bridge supplies lookup with no typed author and reports conflicts", () =>
  withSigningFixture(async (options, env) => {
    const output: string[] = [];
    const errors: string[] = [];
    assertEquals(
      await runWhoami({ ...options, signing: true }, (s) => output.push(s), (s) => errors.push(s)),
      0,
    );
    assertEquals(output, [LUNA_SIGNATURE]);
    env.FORCED_PR_AUTHOR = "agy — Gemini Flash (High)";
    assertEquals(
      await runWhoami({ ...options, signing: true }, (s) => output.push(s), (s) => errors.push(s)),
      1,
    );
    assertEquals(output, [LUNA_SIGNATURE]);
    assertStringIncludes(errors[0], "CODEX_THREAD_ID and FORCED_PR_AUTHOR");
  }));
const FILE_NAME = `rollout-2026-10-04T04-39-43-${SESSION_ID}.jsonl`;
const LUNA_TURN = '{"type":"turn_context","payload":{"model":"gpt-6-luna"}}';

async function fixture(
  test: (options: RunningModelOptions, path: string, home: string) => Promise<void>,
  text = LUNA_TURN,
) {
  const home = await Deno.makeTempDir({ prefix: "codex-running-model-" });
  const path = join(home, "sessions", "2026", "10", "04", FILE_NAME);
  await Deno.mkdir(join(home, "sessions", "2026", "10", "04"), { recursive: true });
  await Deno.writeTextFile(path, text);
  const env: Record<string, string> = { CODEX_HOME: home, CODEX_THREAD_ID: SESSION_ID };
  try {
    await test({ env: (name) => env[name], readRoster: readAuthorRoster }, path, home);
  } finally {
    await Deno.chmod(path, 0o600).catch(() => {});
    await Deno.remove(home, { recursive: true });
  }
}

async function invoke(options: RunningModelOptions) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runWhoami(options, (text) => stdout.push(text), (text) => stderr.push(text));
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

async function refuses(options: RunningModelOptions, ...reasons: string[]) {
  const result = await invoke(options);
  assertEquals(result.code, 1);
  assertEquals(result.stdout, "");
  for (const reason of reasons) assertStringIncludes(result.stderr, reason);
}

const successfulCases = [
  { case: "a: one turn", text: LUNA_TURN, signature: "Codex — GPT-6 Luna" },
  {
    case: "b: switch to the newest turn",
    text: `${LUNA_TURN}\n{"type":"turn_context","payload":{"model":"gpt-6.1-sol"}}`,
    signature: "Codex — GPT-6.1 Sol",
  },
  {
    case: "c: Astra",
    text: '{"type":"turn_context","payload":{"model":"gpt-6-astra"}}',
    signature: "Codex — GPT-6 Astra",
  },
  {
    case: "d: torn last line",
    text: `${LUNA_TURN}\n{"type":"respon`,
    signature: "Codex — GPT-6 Luna",
  },
  {
    case: "e: response_item cannot change the model",
    text: `${LUNA_TURN}\n{"type":"response_item","payload":{"model":"gpt-6.1-sol"}}`,
    signature: "Codex — GPT-6 Luna",
  },
];

for (const example of successfulCases) {
  Deno.test(example.case, () =>
    fixture(async (options) => {
      assertEquals(await invoke(options), { code: 0, stdout: example.signature, stderr: "" });
    }, example.text));
}

Deno.test("f: unrostered model refuses", () =>
  fixture(async (options) => {
    await refuses(options, "gpt-6-sol", "no author roster entry");
  }, '{"type":"turn_context","payload":{"model":"gpt-6-sol"}}'));

Deno.test("g: missing file names the session id", () =>
  fixture(async (options, path) => {
    await Deno.remove(path);
    await refuses(options, SESSION_ID);
  }));

Deno.test("h: duplicate files name both paths", () =>
  fixture(async (options, path, home) => {
    const secondDirectory = join(home, "sessions", "2026", "10", "03");
    await Deno.mkdir(secondDirectory);
    const second = join(secondDirectory, FILE_NAME);
    await Deno.writeTextFile(second, LUNA_TURN);
    await refuses(options, path, second);
  }));

Deno.test("i: no turn_context names the file", () =>
  fixture(async (options, path) => {
    await refuses(options, "No turn_context", path);
  }, '{"type":"response_item","payload":{"model":"gpt-6-luna"}}'));

Deno.test("j: newest turn has no model; no fallback to an earlier turn", () =>
  fixture(async (options, path) => {
    await refuses(options, "newest turn_context has no model", path);
  }, `${LUNA_TURN}\n{"type":"turn_context","payload":{}}`));

Deno.test("k: unreadable mode 000 file names the path", () =>
  fixture(async (options, path) => {
    await Deno.chmod(path, 0o000);
    await refuses(options, "Could not read session file", path);
  }));

for (const id of ["*", "../../x"]) {
  Deno.test(`l: invalid session id ${id} refuses before any file search`, () =>
    fixture(async (options) => {
      // Searching this nonexistent home would report a search failure instead.
      await refuses(
        {
          ...options,
          env: (name) => name === "CODEX_THREAD_ID" ? id : "/does-not-exist",
        },
        "not a session id",
        id,
      );
    }));
}

Deno.test("m: roster probe exits nonzero", () =>
  fixture(async (options) => {
    await refuses(
      {
        ...options,
        readRoster: async () => {
          const result = await new Deno.Command("bash", { args: ["-c", "exit 1"] }).output();
          throw new Error(`exit ${result.code}`);
        },
      },
      "roster could not be read",
      "exit 1",
    );
  }));

Deno.test("n: duplicate normalized roster entries refuse", () =>
  fixture(async (options) => {
    await refuses(
      {
        ...options,
        readRoster: async () => [...await readAuthorRoster(), "gpt-6 luna"],
      },
      "Two author roster entries",
      "gpt-6-luna",
    );
  }));

for (const id of [undefined, ""]) {
  Deno.test(`o: ${id === undefined ? "unset" : "empty"} session id is not Codex`, () =>
    fixture(async (options) => {
      await refuses({ ...options, env: () => id }, "Not a Codex session");
    }));
}

Deno.test("p: real roster probe supplies the normalized model names", async () => {
  const names = (await readAuthorRoster()).map((entry) => entry.toLowerCase().replaceAll(" ", "-"));
  for (const model of ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]) {
    assertEquals(names.filter((name) => name === model).length, 1);
  }
});

Deno.test("whoami task uses scoped permissions with a custom CODEX_HOME", () =>
  fixture(async (_options, _path, home) => {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["task", "--quiet", "whoami"],
      cwd: new URL("../", import.meta.url).pathname,
      env: { CODEX_HOME: home, CODEX_THREAD_ID: SESSION_ID },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 0);
    assertEquals(new TextDecoder().decode(result.stdout), "Codex — GPT-6 Luna\n");
    assertEquals(new TextDecoder().decode(result.stderr), "");
  }));

Deno.test("HOME fallback locates the session when CODEX_HOME is empty", () =>
  fixture(async (options, _path, home) => {
    const userHome = await Deno.makeTempDir({ prefix: "codex-home-fallback-" });
    try {
      await Deno.rename(home, join(userHome, ".codex"));
      const result = await invoke({
        ...options,
        env: (name) => name === "HOME" ? userHome : name === "CODEX_HOME" ? "" : SESSION_ID,
      });
      assertEquals(result, { code: 0, stdout: "Codex — GPT-6 Luna", stderr: "" });
      await Deno.rename(join(userHome, ".codex"), home);
    } finally {
      await Deno.remove(userHome, { recursive: true });
    }
  }));

Deno.test("missing HOME and CODEX_HOME refuses", () =>
  fixture(async (options) => {
    await refuses({
      ...options,
      env: (name) => name === "CODEX_THREAD_ID" ? SESSION_ID : undefined,
    }, "CODEX_HOME and HOME are unset");
  }));

Deno.test("unreadable sessions directory names the search path", () =>
  fixture(async (options, _path, home) => {
    const sessions = join(home, "sessions");
    await Deno.chmod(sessions, 0o000);
    try {
      await refuses(options, "Could not search", sessions);
    } finally {
      await Deno.chmod(sessions, 0o700);
    }
  }));
