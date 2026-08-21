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
  let statusLineArgs: string[] = [];

  const isCheckMode = args.includes("--check");
  // web-jam-tools#432 finding 9: a Stop or SessionStart entry in agy's
  // hooks.json silently disables the ENTIRE hooks config on that surface —
  // not just that event, every PreToolUse guard included. install-hooks.sh
  // passes --forbid-lifecycle-hooks on every invocation targeting agy's
  // hooks file, so a future change that accidentally adds a --stop or
  // head/SessionStart argument to that call is refused here rather than
  // silently landing and disarming every guard on the Flash surface.
  const forbidLifecycleHooks = args.includes("--forbid-lifecycle-hooks");
  const filteredArgs = args.filter((a) => a !== "--check" && a !== "--forbid-lifecycle-hooks");

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
      ["--stop", "--pre-tool-use", "--post-tool-use", "--deny", "--ask", "--status-line"],
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
    statusLineArgs = sections["--status-line"] || [];
  }

  if (forbidLifecycleHooks && (sessionStartCmds.length > 0 || stopCmds.length > 0)) {
    console.error(
      `error: refusing to write ${path.basename(settingsPath)} — a SessionStart or Stop ` +
        "entry was passed for a target invoked with --forbid-lifecycle-hooks. On agy, " +
        "registering EITHER event silently disables the entire hooks config — not just " +
        "that event, every PreToolUse guard included (web-jam-tools#432 finding 9, " +
        "verified 2026-08-07). Remove the --stop/head SessionStart args from this call.",
    );
    return 1;
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

  const managedDirs = new Set<string>();
  managedDirs.add("$HOME/.claude/hooks");
  managedDirs.add("~/.claude/hooks");
  let homeEnv: string | undefined;
  try {
    homeEnv = Deno.env.get("HOME");
  } catch {
    // env permission not granted
  }
  if (homeEnv) {
    managedDirs.add(path.join(homeEnv, ".claude/hooks"));
  }

  for (const cmd of [...sessionStartCmds, ...stopCmds]) {
    const sp = extractScriptPath(cmd);
    const dir = path.dirname(sp);
    if (dir && dir !== ".") managedDirs.add(dir);
  }
  for (const [_, cmd] of [...preToolUsePairs, ...postToolUsePairs]) {
    const sp = extractScriptPath(cmd);
    const dir = path.dirname(sp);
    if (dir && dir !== ".") managedDirs.add(dir);
  }

  function isManagedHook(cmd: string): boolean {
    const scriptPath = extractScriptPath(cmd);
    if (!scriptPath) return false;
    if (
      scriptPath.startsWith("$HOME/.claude/hooks/") ||
      scriptPath.startsWith("~/.claude/hooks/")
    ) {
      return true;
    }
    if (scriptPath.includes("/.claude/hooks/")) {
      return true;
    }
    for (const dir of managedDirs) {
      if (scriptPath.startsWith(dir.endsWith("/") ? dir : dir + "/")) {
        return true;
      }
    }
    return false;
  }

  function mergeFlatHooks(kind: string, cmds: string[]): [string[], string[]] {
    if (!Array.isArray(hooks[kind])) {
      hooks[kind] = [];
    }
    const bucket: Array<{ hooks: Array<{ type: string; command: string }> }> = hooks[kind];
    const desiredScripts = new Set(cmds.map((c) => extractScriptPath(c)));
    const desiredCmds = new Set(cmds);

    const added: string[] = [];
    const pruned: string[] = [];

    for (let i = bucket.length - 1; i >= 0; i--) {
      const entry = bucket[i];
      if (!entry || !Array.isArray(entry.hooks)) continue;
      const remainingHooks: Array<{ type: string; command: string }> = [];
      for (const h of entry.hooks) {
        if (h && h.command) {
          const sp = extractScriptPath(h.command);
          if (isManagedHook(h.command)) {
            if (desiredCmds.has(h.command) || desiredScripts.has(sp)) {
              remainingHooks.push(h);
            } else {
              pruned.push(h.command);
            }
          } else {
            remainingHooks.push(h);
          }
        }
      }
      entry.hooks = remainingHooks;
      if (entry.hooks.length === 0) {
        bucket.splice(i, 1);
      }
    }

    const existing = new Set<string>();
    for (const entry of bucket) {
      for (const h of entry.hooks || []) {
        if (h && h.command) existing.add(h.command);
      }
    }

    for (const cmd of cmds) {
      if (!existing.has(cmd)) {
        bucket.push({ hooks: [{ type: "command", command: cmd }] });
        existing.add(cmd);
        added.push(cmd);
      }
    }
    return [added, pruned];
  }

  const [addedSession, prunedSession] = mergeFlatHooks("SessionStart", sessionStartCmds);
  const [addedStop, prunedStop] = mergeFlatHooks("Stop", stopCmds);

  function mergeMatcherHooks(
    kind: string,
    pairs: Array<[string, string]>,
  ): [Array<[string, string]>, Array<[string, string]>, Array<[string, string]>] {
    if (!Array.isArray(hooks[kind])) {
      hooks[kind] = [];
    }
    const bucket: Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }> =
      hooks[kind];

    // Identity for prune-vs-keep is the EXACT (matcher, full command) pair,
    // not (scriptPath, matcher) — web-jam-tools#432. A shim-wrapped agy
    // command (hooks/agy-hook-shim.sh <event> <matcher> <target-hook>) makes
    // extractScriptPath's first-whitespace-token identity collide across
    // every hook sharing that shim, so a stale (scriptPath, matcher) check
    // would treat a retired hook's shim-wrapped entry as still wanted
    // forever, as long as ANY other hook still used that matcher. Comparing
    // the full command instead keeps each wrapped hook's identity as
    // distinct as an unwrapped one's always was.
    const desiredFullCmds = new Set(pairs.map(([, cmd]) => cmd));
    const desiredPairKey = (matcher: string, cmd: string) => `${matcher} ${cmd}`;
    const desiredPairs = new Set(pairs.map(([matcher, cmd]) => desiredPairKey(matcher, cmd)));

    const added: Array<[string, string]> = [];
    const prunedStaleMatcher: Array<[string, string]> = [];
    const prunedRetired: Array<[string, string]> = [];

    for (let i = bucket.length - 1; i >= 0; i--) {
      const entry = bucket[i];
      if (!entry) continue;
      const entryMatcher = entry.matcher || "";
      const remainingHooks: Array<{ type: string; command: string }> = [];

      for (const h of entry.hooks || []) {
        if (!h || !h.command) continue;
        const sp = extractScriptPath(h.command);
        if (isManagedHook(h.command)) {
          if (desiredPairs.has(desiredPairKey(entryMatcher, h.command))) {
            remainingHooks.push(h);
          } else if (desiredFullCmds.has(h.command)) {
            prunedStaleMatcher.push([sp, entryMatcher]);
          } else {
            prunedRetired.push([sp, entryMatcher]);
          }
        } else {
          remainingHooks.push(h);
        }
      }
      entry.hooks = remainingHooks;
      if (entry.hooks.length === 0) {
        bucket.splice(i, 1);
      }
    }

    const matcherEntries: Record<string, (typeof bucket)[0]> = {};
    for (const entry of bucket) {
      if (entry && entry.matcher !== undefined) {
        matcherEntries[entry.matcher] = entry;
      }
    }

    for (const [matcher, cmd] of pairs) {
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
    }
    return [added, prunedStaleMatcher, prunedRetired];
  }

  const [addedPreToolUse, prunedPreToolUseStale, prunedPreToolUseRetired] = mergeMatcherHooks(
    "PreToolUse",
    preToolUsePairs,
  );
  const [addedPostToolUse, prunedPostToolUseStale, prunedPostToolUseRetired] = mergeMatcherHooks(
    "PostToolUse",
    postToolUsePairs,
  );

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

  // A pattern the installer owns via one versioned array (DENY_RULES /
  // ASK_RULES) must not remain in the OTHER permissions list — a stale copy
  // there silently overrides the owning array's classification, since a
  // pattern present in both permissions.deny and permissions.ask has deny
  // win (web-jam-tools#525). ownedPatterns is this run's version of the
  // owning array; otherSection is the list to scan for a stale copy.
  function findCrossListed(ownedPatterns: string[], otherSection: "deny" | "ask"): string[] {
    if (ownedPatterns.length === 0) return [];
    if (!data.permissions || typeof data.permissions !== "object") return [];
    if (!Array.isArray(data.permissions[otherSection])) return [];
    const ownedSet = new Set(ownedPatterns);
    return (data.permissions[otherSection] as string[]).filter((p) => ownedSet.has(p));
  }

  const denyOwnedInAsk = findCrossListed(denyPatterns, "ask");
  const askOwnedInDeny = findCrossListed(askPatterns, "deny");

  // statusLine merge (web-jam-tools#688). Unlike every other section above,
  // this is a single scalar value, not a list — data.statusLine in Claude
  // Code's settings.json is { type: "command", command: "<cmd>" }. Only
  // touched when --status-line was actually passed, so a target invoked
  // without it (agy's hooks.json) is completely unaffected: no key added,
  // no drift ever reported, byte-identical output.
  let statusLineAdded = false;
  let statusLineChanged = false;
  let statusLinePrevCommand: string | undefined;
  if (statusLineArgs.length > 0) {
    const desiredCommand = statusLineArgs[0];
    const current = data.statusLine;
    const currentIsWellFormed = current && typeof current === "object" &&
      current.type === "command" && typeof current.command === "string";
    if (!current) {
      statusLineAdded = true;
      data.statusLine = { type: "command", command: desiredCommand };
    } else if (!currentIsWellFormed || current.command !== desiredCommand) {
      statusLineChanged = true;
      statusLinePrevCommand = currentIsWellFormed ? current.command : undefined;
      data.statusLine = { type: "command", command: desiredCommand };
    }
  }

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
    prunedSession.length > 0 ||
    addedStop.length > 0 ||
    prunedStop.length > 0 ||
    addedPreToolUse.length > 0 ||
    prunedPreToolUseStale.length > 0 ||
    prunedPreToolUseRetired.length > 0 ||
    addedPostToolUse.length > 0 ||
    prunedPostToolUseStale.length > 0 ||
    prunedPostToolUseRetired.length > 0 ||
    addedDeny.length > 0 ||
    addedAsk.length > 0 ||
    denyOwnedInAsk.length > 0 ||
    askOwnedInDeny.length > 0 ||
    statusLineAdded ||
    statusLineChanged;

  if (isCheckMode) {
    if (hasDrift) {
      if (!fileExists) {
        console.error(`${targetFilename}: settings file does not exist`);
      }
      for (const cmd of addedSession) {
        console.error(`${targetFilename}: missing SessionStart hook ${cmd}`);
      }
      for (const cmd of prunedSession) {
        console.error(`${targetFilename}: has retired SessionStart hook ${cmd}`);
      }
      for (const cmd of addedStop) {
        console.error(`${targetFilename}: missing Stop hook ${cmd}`);
      }
      for (const cmd of prunedStop) {
        console.error(`${targetFilename}: has retired Stop hook ${cmd}`);
      }
      for (const [matcher, cmd] of addedPreToolUse) {
        console.error(`${targetFilename}: missing PreToolUse hook (${matcher}) ${cmd}`);
      }
      for (const [matcher, cmd] of addedPostToolUse) {
        console.error(`${targetFilename}: missing PostToolUse hook (${matcher}) ${cmd}`);
      }
      for (const [scriptPath, oldMatcher] of prunedPreToolUseStale) {
        console.error(
          `${targetFilename}: PreToolUse ${scriptPath}: has stale matcher (${oldMatcher})`,
        );
      }
      for (const [scriptPath, matcher] of prunedPreToolUseRetired) {
        console.error(
          `${targetFilename}: PreToolUse ${scriptPath}: has retired hook (${matcher})`,
        );
      }
      for (const [scriptPath, oldMatcher] of prunedPostToolUseStale) {
        console.error(
          `${targetFilename}: PostToolUse ${scriptPath}: has stale matcher (${oldMatcher})`,
        );
      }
      for (const [scriptPath, matcher] of prunedPostToolUseRetired) {
        console.error(
          `${targetFilename}: PostToolUse ${scriptPath}: has retired hook (${matcher})`,
        );
      }
      for (const pattern of addedDeny) {
        console.error(`${targetFilename}: missing permissions.deny rule ${pattern}`);
      }
      for (const pattern of addedAsk) {
        console.error(`${targetFilename}: missing permissions.ask rule ${pattern}`);
      }
      for (const pattern of denyOwnedInAsk) {
        console.error(
          `${targetFilename}: permissions.ask rule ${pattern} is also in permissions.deny (stale copy)`,
        );
      }
      for (const pattern of askOwnedInDeny) {
        console.error(
          `${targetFilename}: permissions.deny rule ${pattern} is also in permissions.ask (stale copy)`,
        );
      }
      if (statusLineAdded) {
        console.error(`${targetFilename}: missing statusLine ${statusLineArgs[0]}`);
      }
      if (statusLineChanged) {
        console.error(
          `${targetFilename}: statusLine differs from desired (want ${statusLineArgs[0]}${
            statusLinePrevCommand ? `, has ${statusLinePrevCommand}` : ""
          })`,
        );
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

  if (denyOwnedInAsk.length > 0) {
    const removeSet = new Set(denyOwnedInAsk);
    data.permissions.ask = (data.permissions.ask as string[]).filter((p) => !removeSet.has(p));
  }
  if (askOwnedInDeny.length > 0) {
    const removeSet = new Set(askOwnedInDeny);
    data.permissions.deny = (data.permissions.deny as string[]).filter((p) => !removeSet.has(p));
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
  for (const cmd of prunedSession) {
    console.log(`${targetFilename}: removed retired SessionStart hook ${cmd}`);
  }
  for (const cmd of addedStop) console.log(`${targetFilename}: added Stop hook ${cmd}`);
  for (const cmd of prunedStop) {
    console.log(`${targetFilename}: removed retired Stop hook ${cmd}`);
  }
  for (const [matcher, cmd] of addedPreToolUse) {
    console.log(`${targetFilename}: added PreToolUse hook (${matcher}) ${cmd}`);
  }
  for (const [matcher, cmd] of addedPostToolUse) {
    console.log(`${targetFilename}: added PostToolUse hook (${matcher}) ${cmd}`);
  }
  for (const [scriptPath, oldMatcher] of prunedPreToolUseStale) {
    console.log(
      `${targetFilename}: PreToolUse ${scriptPath}: replaced stale matcher (${oldMatcher})`,
    );
  }
  for (const [scriptPath, matcher] of prunedPreToolUseRetired) {
    console.log(
      `${targetFilename}: PreToolUse ${scriptPath}: removed retired hook (${matcher})`,
    );
  }
  for (const [scriptPath, oldMatcher] of prunedPostToolUseStale) {
    console.log(
      `${targetFilename}: PostToolUse ${scriptPath}: replaced stale matcher (${oldMatcher})`,
    );
  }
  for (const [scriptPath, matcher] of prunedPostToolUseRetired) {
    console.log(
      `${targetFilename}: PostToolUse ${scriptPath}: removed retired hook (${matcher})`,
    );
  }
  for (const pattern of addedDeny) {
    console.log(`${targetFilename}: added permissions.deny rule ${pattern}`);
  }
  for (const pattern of addedAsk) {
    console.log(`${targetFilename}: added permissions.ask rule ${pattern}`);
  }
  for (const pattern of denyOwnedInAsk) {
    console.log(
      `${targetFilename}: removed permissions.ask rule ${pattern} (now owned by permissions.deny)`,
    );
  }
  for (const pattern of askOwnedInDeny) {
    console.log(
      `${targetFilename}: removed permissions.deny rule ${pattern} (now owned by permissions.ask)`,
    );
  }
  if (statusLineAdded) {
    console.log(`${targetFilename}: added statusLine ${statusLineArgs[0]}`);
  }
  if (statusLineChanged) {
    console.log(`${targetFilename}: updated statusLine to ${statusLineArgs[0]}`);
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
