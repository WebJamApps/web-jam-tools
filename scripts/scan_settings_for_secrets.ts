import * as path from "jsr:@std/path@^1.0.0";
import { findCredentialLiteral } from "../hooks/lib/detect_credential_literal.ts";

export function scanSettingsForSecrets(settingsPath: string): number {
  const candidatePaths: string[] = [];
  if (settingsPath) {
    candidatePaths.push(settingsPath);
    const dir = path.dirname(settingsPath);
    const base = path.basename(settingsPath);
    if (base === "settings.json") {
      candidatePaths.push(path.join(dir, "settings.local.json"));
    } else if (base === "settings.local.json") {
      candidatePaths.push(path.join(dir, "settings.json"));
    } else if (dir) {
      candidatePaths.push(path.join(dir, "settings.json"));
      candidatePaths.push(path.join(dir, "settings.local.json"));
    }
  }

  const uniquePaths = Array.from(new Set(candidatePaths));
  const findings: Array<[string, string, number, string]> = [];
  const scannedFiles: string[] = [];

  for (const filePath of uniquePaths) {
    let text = "";
    try {
      text = Deno.readTextFileSync(filePath);
    } catch {
      continue; // File does not exist
    }

    let data: Record<string, any> = {};
    try {
      data = JSON.parse(text);
    } catch {
      continue; // Invalid JSON or empty
    }

    scannedFiles.push(filePath);
    const permissions = data.permissions || {};
    for (const section of ["allow", "deny", "ask"]) {
      const entries = permissions[section];
      if (!Array.isArray(entries)) continue;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (typeof entry !== "string") continue;
        const match = findCredentialLiteral(entry);
        if (match) {
          findings.push([filePath, section, i, match]);
        }
      }
    }
  }

  if (scannedFiles.length === 0) {
    console.log(`no settings file found at ${settingsPath} — nothing to scan`);
    return 0;
  }

  if (findings.length > 0) {
    console.error("CREDENTIAL-SHAPED LITERAL(S) FOUND in permissions:");
    for (const [filePath, section, i, match] of findings) {
      console.error(`  ${filePath} -> permissions.${section}[${i}]: ${match}`);
    }
    console.error("These entries are also FUNCTIONALLY USELESS — allow/deny/ask match literally,");
    console.error("so a rule containing a secret only ever matched that one exact command with");
    console.error("that one exact secret value. Remove the entry and rotate the credential.");
    console.error("(rule: web-jam-tools#304 / #434)");
    return 1;
  }

  console.log(`no credential-shaped literals found in ${scannedFiles.join(", ")}`);
  return 0;
}

if (import.meta.main) {
  const settingsPath = Deno.env.get("SETTINGS_PATH") || Deno.args[0] || "";
  Deno.exit(scanSettingsForSecrets(settingsPath));
}
