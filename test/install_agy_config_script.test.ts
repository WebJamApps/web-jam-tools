// install_agy_config_script.test.ts — web-jam-tools#604
//
// Tests for scripts/install-agy-config.sh symlink creation, idempotency,
// real-file backup preservation, and credential-literal guard.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { findCredentialLiteral } from "../hooks/lib/detect_credential_literal.ts";

const SCRIPT_PATH = new URL("../scripts/install-agy-config.sh", import.meta.url).pathname;
const REPO_DIR = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const MASTER_CONFIG_PATH = `${REPO_DIR}/agy/config/mcp_config.json`;

Deno.test("master agy/config/mcp_config.json is valid JSON, contains no credentials, and defines reaper, playwright, github, gmail", async () => {
  const content = await Deno.readTextFile(MASTER_CONFIG_PATH);
  const data = JSON.parse(content);
  assertEquals(typeof data.mcpServers, "object");
  assertEquals(typeof data.mcpServers.reaper, "object");
  assertEquals(typeof data.mcpServers.playwright, "object");
  assertEquals(typeof data.mcpServers.github, "object");
  assertEquals(typeof data.mcpServers.gmail, "object");

  // Credential guard: master file must contain NO credential literals
  const cred = findCredentialLiteral(content);
  assertEquals(cred, null, `Found credential literal in master config: ${cred}`);
});

Deno.test("install-agy-config.sh --mcp-config-path creates a symlink to repo master config", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wjt604-install-" });
  const destPath = `${dir}/mcp_config.json`;
  try {
    const cmd = new Deno.Command("bash", {
      args: [SCRIPT_PATH, "--mcp-config-path", destPath],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    const stdoutStr = new TextDecoder().decode(stdout);
    const stderrStr = new TextDecoder().decode(stderr);
    assertEquals(code, 0, stderrStr);
    assertStringIncludes(stdoutStr, "linked (new)");

    const lstat = await Deno.lstat(destPath);
    assertEquals(lstat.isSymlink, true, "Destination must be a symlink");
    const realTarget = await Deno.realPath(destPath);
    const expectedTarget = await Deno.realPath(MASTER_CONFIG_PATH);
    assertEquals(realTarget, expectedTarget);

    const parsed = JSON.parse(await Deno.readTextFile(destPath));
    assertEquals(Object.keys(parsed.mcpServers).sort(), [
      "github",
      "gmail",
      "playwright",
      "reaper",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-agy-config.sh is idempotent on second run (no-op, exit 0)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wjt604-idempotent-" });
  const destPath = `${dir}/mcp_config.json`;
  try {
    const first = new Deno.Command("bash", {
      args: [SCRIPT_PATH, "--mcp-config-path", destPath],
      stdout: "piped",
      stderr: "piped",
    });
    const firstRes = await first.output();
    assertEquals(firstRes.code, 0);

    const second = new Deno.Command("bash", {
      args: [SCRIPT_PATH, "--mcp-config-path", destPath],
      stdout: "piped",
      stderr: "piped",
    });
    const secondRes = await second.output();
    const secondStdout = new TextDecoder().decode(secondRes.stdout);
    assertEquals(secondRes.code, 0);
    assertStringIncludes(secondStdout, "ok (already linked)");

    // No backup files created
    const backups = [...Deno.readDirSync(dir)].filter((e) => e.name.includes(".bak-"));
    assertEquals(backups.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-agy-config.sh preserves pre-existing real file by reconciling entries into master and backing it up", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wjt604-realfile-" });
  const masterPath = `${dir}/master_mcp_config.json`;
  const destPath = `${dir}/mcp_config.json`;

  const initialMaster = {
    mcpServers: {
      reaper: { command: "reaper-mcp", args: [] },
      playwright: { command: "playwright-mcp", args: [] },
    },
  };
  const realDestContent = {
    mcpServers: {
      playwright: { command: "playwright-mcp", args: [] },
      customTool: { command: "custom-mcp", args: ["--flag"] },
    },
    customExtraField: "customValue",
  };

  try {
    await Deno.writeTextFile(masterPath, JSON.stringify(initialMaster, null, 2));
    await Deno.writeTextFile(destPath, JSON.stringify(realDestContent, null, 2));

    const cmd = new Deno.Command("bash", {
      args: [SCRIPT_PATH, "--mcp-src-path", masterPath, "--mcp-config-path", destPath],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    const stdoutStr = new TextDecoder().decode(stdout);
    const stderrStr = new TextDecoder().decode(stderr);
    assertEquals(code, 0, stderrStr);
    assertStringIncludes(stdoutStr, "linked (previous version backed up to mcp_config.json.bak-");

    const lstat = await Deno.lstat(destPath);
    assertEquals(lstat.isSymlink, true);

    // Verify backup file exists and matches the original real file
    const backups = [...Deno.readDirSync(dir)].filter((e) =>
      e.name.startsWith("mcp_config.json.bak-")
    );
    assertEquals(backups.length, 1);
    const backupContent = await Deno.readTextFile(`${dir}/${backups[0].name}`);
    assertEquals(JSON.parse(backupContent), realDestContent);

    // Verify the master copy in the repo was updated to include customTool and customExtraField
    const updatedMaster = JSON.parse(await Deno.readTextFile(masterPath));
    assertEquals(updatedMaster.mcpServers.reaper, initialMaster.mcpServers.reaper);
    assertEquals(updatedMaster.mcpServers.playwright, initialMaster.mcpServers.playwright);
    assertEquals(updatedMaster.mcpServers.customTool, realDestContent.mcpServers.customTool);
    assertEquals(updatedMaster.customExtraField, "customValue");

    // Reading through the symlink resolves to the updated master
    const resolvedFromSymlink = JSON.parse(await Deno.readTextFile(destPath));
    assertEquals(resolvedFromSymlink, updatedMaster);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-agy-config.sh replaces an incorrect symlink and backs it up", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wjt604-badsymlink-" });
  const destPath = `${dir}/mcp_config.json`;
  const wrongTarget = `${dir}/non-existent.json`;
  try {
    await Deno.symlink(wrongTarget, destPath);

    const cmd = new Deno.Command("bash", {
      args: [SCRIPT_PATH, "--mcp-config-path", destPath],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    const stdoutStr = new TextDecoder().decode(stdout);
    const stderrStr = new TextDecoder().decode(stderr);
    assertEquals(code, 0, stderrStr);
    assertStringIncludes(stdoutStr, "linked (previous version backed up to mcp_config.json.bak-");

    const lstat = await Deno.lstat(destPath);
    assertEquals(lstat.isSymlink, true);
    const realTarget = await Deno.realPath(destPath);
    const expectedTarget = await Deno.realPath(MASTER_CONFIG_PATH);
    assertEquals(realTarget, expectedTarget);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-agy-config.sh honors AGY_MCP_CONFIG_PATH env var", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wjt604-envvar-" });
  const destPath = `${dir}/mcp_config.json`;
  try {
    const cmd = new Deno.Command("bash", {
      args: [SCRIPT_PATH],
      stdout: "piped",
      stderr: "piped",
      env: {
        ...Deno.env.toObject(),
        AGY_MCP_CONFIG_PATH: destPath,
      },
    });
    const { code, stderr } = await cmd.output();
    assertEquals(code, 0, new TextDecoder().decode(stderr));

    const lstat = await Deno.lstat(destPath);
    assertEquals(lstat.isSymlink, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-agy-config.sh refuses to install and exits non-zero if master config contains credential literal", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wjt604-secret-" });
  const secretMasterPath = `${dir}/secret_mcp_config.json`;
  const destPath = `${dir}/mcp_config.json`;

  const secretConfig = {
    mcpServers: {
      github: {
        command: "docker",
        args: ["run", "-e", "GITHUB_TOKEN=ghp_1111222233334444555566667777888899990000"],
      },
    },
  };

  try {
    await Deno.writeTextFile(secretMasterPath, JSON.stringify(secretConfig, null, 2));

    const cmd = new Deno.Command("bash", {
      args: [SCRIPT_PATH, "--mcp-src-path", secretMasterPath, "--mcp-config-path", destPath],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    const stderrStr = new TextDecoder().decode(stderr);
    assert(code !== 0, `Expected non-zero exit code, got ${code}`);
    assertStringIncludes(stderrStr, "contains a credential-shaped literal (GitHub token)");
    assertStringIncludes(stderrStr, "Refusing to install symlink");

    let destExists = false;
    try {
      await Deno.lstat(destPath);
      destExists = true;
    } catch {
      destExists = false;
    }
    assertEquals(destExists, false, "No symlink or file should be created when secret detected");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-agy-config.sh refuses to install and leaves master config untouched when real dest contains credential literal", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wjt604-dest-secret-" });
  const masterPath = `${dir}/master_mcp_config.json`;
  const destPath = `${dir}/mcp_config.json`;

  const initialMasterContent = JSON.stringify(
    {
      mcpServers: {
        reaper: { command: "reaper-mcp", args: [] },
      },
    },
    null,
    2,
  ) + "\n";

  const secretDestConfig = {
    mcpServers: {
      leakyTool: {
        command: "docker",
        args: ["run", "-e", "TOKEN=ghp_1111222233334444555566667777888899990000"],
      },
    },
  };

  try {
    await Deno.writeTextFile(masterPath, initialMasterContent);
    await Deno.writeTextFile(destPath, JSON.stringify(secretDestConfig, null, 2));

    const cmd = new Deno.Command("bash", {
      args: [SCRIPT_PATH, "--mcp-src-path", masterPath, "--mcp-config-path", destPath],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    const stderrStr = new TextDecoder().decode(stderr);
    assert(code !== 0, `Expected non-zero exit code, got ${code}`);
    assertStringIncludes(stderrStr, "contains a credential-shaped literal (GitHub token)");
    assertStringIncludes(stderrStr, "Refusing to install symlink");

    // Assert destination was NOT converted to a symlink
    const lstat = await Deno.lstat(destPath);
    assertEquals(lstat.isSymlink, false, "Destination must not be symlinked on refusal");

    // Assert master config file on disk was NEVER modified
    const masterAfter = await Deno.readTextFile(masterPath);
    assertEquals(
      masterAfter,
      initialMasterContent,
      "Master config must remain byte-for-byte unchanged on refusal",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
