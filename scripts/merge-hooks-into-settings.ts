#!/usr/bin/env deno run --allow-read --allow-write
/**
 * merge-hooks-into-settings.ts — web-jam-tools#382
 *
 * Idempotently merges SessionStart, Stop, and PreToolUse/PostToolUse (any
 * matcher) hook commands, plus a flat list of `permissions.deny` patterns,
 * into a Claude Code settings.json.
 */

import * as path from "jsr:@std/path@^1.0.0";
import { findCredentialLiteral } from "../hooks/lib/detect_credential_literal.ts";

export function extractScriptPath(cmd: string): string {
  return cmd ? cmd.trim().split(/\s+/)[0] : cmd;
}

export function merge(settingsPath: string, args: string[]): number {
  let sessionStartCmds: string[] = [];
  let stopCmds: string[] = [];
  const preToolUsePairs: Array<[string, string]> = [];
  const postToolUsePairs: Array<[string, string]> = [];
  let denyPatterns: string[] = [];
  let askPatterns: string[] = [];

  const isCheckMode = args.includes("--check");
  const filteredArgs = args.filter((a) => a !== "--check");

  if (filteredArgs.includes("--")) {
    const sepIdx = filteredArgs.indexOf("--");
    const rest = filteredArgs.slice(sepIdx + 1);

    function section(names: string[], src: string[]): [string[], Record<string, string[]>] {
      const idxs: Record<string, number> = {};
      for (const n of names) {
        const i = src.indexOf(n);
        if (i !== -1) idxs[n] = i;
      }
      const values = Object.values(idxs);
      const first = values.length ? Math.min(...values) : src.length;
      const head = src.slice(0, first);
      const sections: Record<string, string[]> = {};
      const ordered = Object.entries(idxs).sort((a, b) => a[1] - b[1]);
      for (let pos = 0; pos < ordered.length; pos++) {
        const [name, start] = ordered[pos];
        const end = pos + 1 < ordered.length ? ordered[pos + 1][1] : src.length;
        sections[name] = src.slice(start + 1, end);
      }
      return [head, sections];
    }

    const [head, sections] = section(
      ["--stop", "--pre-tool-use", "--post-tool-use", "--deny", "--ask"],
      rest,
    );
    sessionStartCmds = head;
    stopCmds = sections["--stop"] || [];
    for (const pair of sections["--pre-tool-use"] || []) {
      const sep = pair.indexOf("::");
      if (sep !== -1) {
        preToolUsePairs.push([pair.slice(0, sep), pair.slice(sep + 2)]);
      }
    }
    for (const pair of sections["--post-tool-use"] || []) {
      const sep = pair.indexOf("::");
      if (sep !== -1) {
        postToolUsePairs.push([pair.slice(0, sep), pair.slice(sep + 2)]);
      }
    }
    denyPatterns = sections["--deny"] || [];
    askPatterns = sections["--ask"] || [];
  }

  const fileExists = tryExistsSync(settingsPath);
  let data: Record<string, any> = {};
  if (fileExists) {
    try {
      const raw = Deno.readTextFileSync(settingsPath);
      data = raw.trim() ? JSON.parse(raw) : {};
    } catch (e) {
      console.error(`error: ${settingsPath} is not valid JSON, refusing to touch it: ${e}`);
      return 1;
    }
  }

  if (!data.hooks || typeof data.hooks !== "object") {
    data.hooks = {};
  }
  const hooks = data.hooks;

  function mergeFlatHooks(kind: string, cmds: string[]): string[] {
    if (!Array.isArray(hooks[kind])) {
      hooks[kind] = [];
    }
    const bucket: Array<{ hooks: Array<{ type: string; command: string }> }> = hooks[kind];
    const existing = new Set<string>();
    for (const entry of bucket) {
      for (const h of entry.hooks || []) {
        if (h && h.command) existing.add(h.command);
      }
    }
    const added: string[] = [];
    for (const cmd of cmds) {
      if (!existing.has(cmd)) {
        bucket.push({ hooks: [{ type: "command", command: cmd }] });
        existing.add(cmd);
        added.push(cmd);
      }
    }
    return added;
  }

  const addedSession = mergeFlatHooks("SessionStart", sessionStartCmds);
  const addedStop = mergeFlatHooks("Stop", stopCmds);

  function mergeMatcherHooks(
    kind: string,
    pairs: Array<[string, string]>,
  ): [Array<[string, string]>, Array<[string, string]>] {
    if (!Array.isArray(hooks[kind])) {
      hooks[kind] = [];
    }
    const bucket: Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }> =
      hooks[kind];
    const matcherEntries: Record<string, (typeof bucket)[0]> = {};
    for (const entry of bucket) {
      if (entry && entry.matcher !== undefined) {
        matcherEntries[entry.matcher] = entry;
      }
    }

    const added: Array<[string, string]> = [];
    const pruned: Array<[string, string]> = [];

    for (const [matcher, cmd] of pairs) {
      const scriptPath = extractScriptPath(cmd);
      let entry = matcherEntries[matcher];
      if (!entry) {
        entry = { matcher, hooks: [] };
        bucket.push(entry);
        matcherEntries[matcher] = entry;
      }

      const existing = new Set(
        (entry.hooks || []).map((h) => h?.command).filter((c): c is string => Boolean(c)),
      );
      if (!existing.has(cmd)) {
        entry.hooks.push({ type: "command", command: cmd });
        added.push([matcher, cmd]);
      }

      for (const [otherMatcher, otherEntry] of Object.entries(matcherEntries)) {
        if (otherMatcher === matcher) continue;
        const remaining: Array<{ type: string; command: string }> = [];
        for (const h of otherEntry.hooks || []) {
          if (h && h.command && extractScriptPath(h.command) === scriptPath) {
            pruned.push([scriptPath, otherMatcher]);
          } else if (h) {
            remaining.push(h);
          }
        }
        otherEntry.hooks = remaining;
        if (remaining.length === 0) {
          const idx = bucket.indexOf(otherEntry);
          if (idx !== -1) bucket.splice(idx, 1);
          delete matcherEntries[otherMatcher];
        }
      }
    }
    return [added, pruned];
  }

  const [addedPreToolUse, prunedPreToolUse] = mergeMatcherHooks("PreToolUse", preToolUsePairs);
  const [addedPostToolUse, prunedPostToolUse] = mergeMatcherHooks("PostToolUse", postToolUsePairs);

  function mergePermissionsList(sectionName: "deny" | "ask", patterns: string[]): string[] {
    if (patterns.length === 0) return [];
    if (!data.permissions || typeof data.permissions !== "object") {
      data.permissions = {};
    }
    if (!Array.isArray(data.permissions[sectionName])) {
      data.permissions[sectionName] = [];
    }
    const list: string[] = data.permissions[sectionName];
    const existing = new Set(list);
    const added: string[] = [];
    for (const pattern of patterns) {
      if (!existing.has(pattern)) {
        list.push(pattern);
        existing.add(pattern);
        added.push(pattern);
      }
    }
    return added;
  }

  const addedDeny = mergePermissionsList("deny", denyPatterns);
  const addedAsk = mergePermissionsList("ask", askPatterns);

  // Secret-scan gate: check all strings in permissions and hooks for credentials
  const secretFindings: string[] = [];
  if (data.permissions && typeof data.permissions === "object") {
    for (const section of ["allow", "deny", "ask"]) {
      const entries = data.permissions[section];
      if (Array.isArray(entries)) {
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          if (typeof entry === "string") {
            const match = findCredentialLiteral(entry);
            if (match) {
              secretFindings.push(`permissions.${section}[${i}]: ${match}`);
            }
          }
        }
      }
    }
  }
  if (data.hooks && typeof data.hooks === "object") {
    for (const [kind, bucket] of Object.entries(data.hooks)) {
      if (Array.isArray(bucket)) {
        for (let b = 0; b < bucket.length; b++) {
          const entry = bucket[b];
          if (entry && Array.isArray(entry.hooks)) {
            for (let h = 0; h < entry.hooks.length; h++) {
              const cmd = entry.hooks[h]?.command;
              if (typeof cmd === "string") {
                const match = findCredentialLiteral(cmd);
                if (match) {
                  secretFindings.push(`hooks.${kind}[${b}].hooks[${h}]: ${match}`);
                }
              }
            }
          }
        }
      }
    }
  }

  const targetFilename = path.basename(settingsPath);

  if (secretFindings.length > 0) {
    console.error(`SECRET DETECTED: refusing to write/distribute settings for ${targetFilename}`);
    for (const finding of secretFindings) {
      console.error(`  ${finding}`);
    }
    return 1;
  }

  const hasDrift = !fileExists ||
    addedSession.length > 0 ||
    addedStop.length > 0 ||
    addedPreToolUse.length > 0 ||
    addedPostToolUse.length > 0 ||
    prunedPreToolUse.length > 0 ||
    prunedPostToolUse.length > 0 ||
    addedDeny.length > 0 ||
    addedAsk.length > 0;

  if (isCheckMode) {
    if (hasDrift) {
      if (!fileExists) {
        console.error(`${targetFilename}: settings file does not exist`);
      }
      for (const cmd of addedSession) {
        console.error(`${targetFilename}: missing SessionStart hook ${cmd}`);
      }
      for (const cmd of addedStop) {
        console.error(`${targetFilename}: missing Stop hook ${cmd}`);
      }
      for (const [matcher, cmd] of addedPreToolUse) {
        console.error(`${targetFilename}: missing PreToolUse hook (${matcher}) ${cmd}`);
      }
      for (const [matcher, cmd] of addedPostToolUse) {
        console.error(`${targetFilename}: missing PostToolUse hook (${matcher}) ${cmd}`);
      }
      for (const [scriptPath, oldMatcher] of prunedPreToolUse) {
        console.error(
          `${targetFilename}: PreToolUse ${scriptPath}: has stale matcher (${oldMatcher})`,
        );
      }
      for (const [scriptPath, oldMatcher] of prunedPostToolUse) {
        console.error(
          `${targetFilename}: PostToolUse ${scriptPath}: has stale matcher (${oldMatcher})`,
        );
      }
      for (const pattern of addedDeny) {
        console.error(`${targetFilename}: missing permissions.deny rule ${pattern}`);
      }
      for (const pattern of addedAsk) {
        console.error(`${targetFilename}: missing permissions.ask rule ${pattern}`);
      }
      return 1;
    }
    console.log(
      `${targetFilename}: SessionStart, Stop, PreToolUse, PostToolUse hooks and permissions.deny / permissions.ask already up to date (no-op)`,
    );
    return 0;
  }

  if (!hasDrift) {
    console.log(
      `${targetFilename}: SessionStart, Stop, PreToolUse, PostToolUse hooks ` +
        "and permissions.deny / permissions.ask already up to date (no-op)",
    );
    return 0;
  }

  if (tryExistsSync(settingsPath)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const backup = `${settingsPath}.bak-${stamp}`;
    Deno.copyFileSync(settingsPath, backup);
    console.log(`${targetFilename}: backed up previous version to ${path.basename(backup)}`);
  }

  const parentDir = path.dirname(settingsPath);
  if (parentDir) {
    Deno.mkdirSync(parentDir, { recursive: true });
  }

  Deno.writeTextFileSync(settingsPath, JSON.stringify(data, null, 2) + "\n");

  for (const cmd of addedSession) {
    console.log(`${targetFilename}: added SessionStart hook ${cmd}`);
  }
  for (const cmd of addedStop) console.log(`${targetFilename}: added Stop hook ${cmd}`);
  for (const [matcher, cmd] of addedPreToolUse) {
    console.log(`${targetFilename}: added PreToolUse hook (${matcher}) ${cmd}`);
  }
  for (const [matcher, cmd] of addedPostToolUse) {
    console.log(`${targetFilename}: added PostToolUse hook (${matcher}) ${cmd}`);
  }
  for (const [scriptPath, oldMatcher] of prunedPreToolUse) {
    console.log(
      `${targetFilename}: PreToolUse ${scriptPath}: replaced stale matcher (${oldMatcher})`,
    );
  }
  for (const [scriptPath, oldMatcher] of prunedPostToolUse) {
    console.log(
      `${targetFilename}: PostToolUse ${scriptPath}: replaced stale matcher (${oldMatcher})`,
    );
  }
  for (const pattern of addedDeny) {
    console.log(`${targetFilename}: added permissions.deny rule ${pattern}`);
  }
  for (const pattern of addedAsk) {
    console.log(`${targetFilename}: added permissions.ask rule ${pattern}`);
  }

  return 0;
}

function tryExistsSync(p: string): boolean {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  if (Deno.args.length < 1) {
    console.error("usage: merge-hooks-into-settings.ts SETTINGS_PATH -- ...");
    Deno.exit(1);
  }
  Deno.exit(merge(Deno.args[0], Deno.args.slice(1)));
}
