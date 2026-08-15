// merge_agy_gmail_mcp_script.test.ts — web-jam-tools#432 scope item 2
//
// scripts/merge-agy-gmail-mcp.ts / scripts/install-agy-gmail-mcp.sh are NOT
// run against any real path by this suite (or by any agent session) — they
// are exercised only against sandboxed temp files, same pattern as
// scripts/install-hooks.sh's own tests. Connecting the `gmail` MCP server to
// a live Antigravity config is Josh's action to take, not this repo's to
// perform automatically.

import { assert, assertEquals } from "@std/assert";
import { GMAIL_MCP_ENTRY, merge } from "../scripts/merge-agy-gmail-mcp.ts";

Deno.test("merge: creates a nonexistent mcp_config.json with the gmail entry", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/mcp_config.json`;
  try {
    const res = merge(path);
    assert(res.changed);
    const data = JSON.parse(await Deno.readTextFile(path));
    assertEquals(data.mcpServers.gmail, GMAIL_MCP_ENTRY);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("merge: is purely additive — existing mcpServers (playwright, reaper) survive untouched", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/mcp_config.json`;
  const initial = {
    mcpServers: {
      reaper: { command: "/home/joshua/opt/Reaper-MCP/.venv/bin/reaper-mcp", args: [] },
      playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless"] },
    },
  };
  try {
    await Deno.writeTextFile(path, JSON.stringify(initial, null, 2));
    const res = merge(path);
    assert(res.changed);
    const data = JSON.parse(await Deno.readTextFile(path));
    assertEquals(data.mcpServers.reaper, initial.mcpServers.reaper);
    assertEquals(data.mcpServers.playwright, initial.mcpServers.playwright);
    assertEquals(data.mcpServers.gmail, GMAIL_MCP_ENTRY);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("merge: re-running is idempotent (no-op, no duplicate backup)", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/mcp_config.json`;
  try {
    const first = merge(path);
    assert(first.changed);
    const second = merge(path);
    assert(!second.changed);
    assert(second.message.includes("already up to date"), second.message);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("merge: a write backs up the previous file", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/mcp_config.json`;
  try {
    await Deno.writeTextFile(path, JSON.stringify({ mcpServers: {} }, null, 2));
    merge(path);
    const backups = [...Deno.readDirSync(dir)].filter((e) =>
      e.name.startsWith("mcp_config.json.bak-")
    );
    assertEquals(backups.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("merge: invalid JSON in an existing file is refused, not overwritten", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/mcp_config.json`;
  try {
    await Deno.writeTextFile(path, "{not valid json");
    const res = merge(path);
    assert(!res.changed);
    assert(res.message.startsWith("error:"), res.message);
    const stillInvalid = await Deno.readTextFile(path);
    assertEquals(stillInvalid, "{not valid json");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- install-agy-gmail-mcp.sh: the thin wrapper, sandboxed via --mcp-config-path ---

Deno.test("install-agy-gmail-mcp.sh --mcp-config-path writes only to the given path", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/mcp_config.json`;
  const scriptPath = new URL("../scripts/install-agy-gmail-mcp.sh", import.meta.url).pathname;
  try {
    const cmd = new Deno.Command("bash", {
      args: [scriptPath, "--mcp-config-path", path],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    assertEquals(code, 0, new TextDecoder().decode(stderr));
    assert(new TextDecoder().decode(stdout).includes("Restart agy"));
    const data = JSON.parse(await Deno.readTextFile(path));
    assertEquals(data.mcpServers.gmail, GMAIL_MCP_ENTRY);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-agy-gmail-mcp.sh honors AGY_MCP_CONFIG_PATH env var", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/mcp_config.json`;
  const scriptPath = new URL("../scripts/install-agy-gmail-mcp.sh", import.meta.url).pathname;
  try {
    const cmd = new Deno.Command("bash", {
      args: [scriptPath],
      stdout: "piped",
      stderr: "piped",
      env: { ...Deno.env.toObject(), AGY_MCP_CONFIG_PATH: path },
    });
    const { code, stderr } = await cmd.output();
    assertEquals(code, 0, new TextDecoder().decode(stderr));
    const data = JSON.parse(await Deno.readTextFile(path));
    assertEquals(data.mcpServers.gmail, GMAIL_MCP_ENTRY);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
