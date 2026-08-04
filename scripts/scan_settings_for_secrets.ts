/**
 * scan_settings_for_secrets.ts — web-jam-tools#382
 */
import { findCredentialLiteral } from "../hooks/lib/detect_credential_literal.ts";

export function scanSettingsForSecrets(settingsPath: string): number {
  let text = "";
  try {
    text = Deno.readTextFileSync(settingsPath);
  } catch {
    console.log(`no settings.json at ${settingsPath} — nothing to scan`);
    return 0;
  }

  let data: Record<string, any> = {};
  try {
    data = JSON.parse(text);
  } catch {
    console.log(`no settings.json at ${settingsPath} — nothing to scan`);
    return 0;
  }

  const findings: Array<[string, number, string]> = [];
  const permissions = data.permissions || {};
  for (const section of ["allow", "deny", "ask"]) {
    const entries = permissions[section];
    if (!Array.isArray(entries)) continue;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (typeof entry !== "string") continue;
      const match = findCredentialLiteral(entry);
      if (match) {
        findings.push([section, i, match]);
      }
    }
  }

  if (findings.length > 0) {
    console.error(`CREDENTIAL-SHAPED LITERAL(S) FOUND in permissions of ${settingsPath}`);
    for (const [section, i, match] of findings) {
      console.error(`  permissions.${section}[${i}]: ${match}`);
    }
    console.error("These entries are also FUNCTIONALLY USELESS — allow/deny/ask match literally,");
    console.error("so a rule containing a secret only ever matched that one exact command with");
    console.error("that one exact secret value. Remove the entry and rotate the credential.");
    console.error("(rule: web-jam-tools#304)");
    return 1;
  }

  console.log(`no credential-shaped literals found in ${settingsPath}`);
  return 0;
}

if (import.meta.main) {
  const settingsPath = Deno.env.get("SETTINGS_PATH") || Deno.args[0] || "";
  Deno.exit(scanSettingsForSecrets(settingsPath));
}
