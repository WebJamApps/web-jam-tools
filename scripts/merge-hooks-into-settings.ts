#!/usr/bin/env deno run --allow-read --allow-write
/**
 * merge-hooks-into-settings.ts — web-jam-tools#382
 *
 * Idempotently merges SessionStart, SessionEnd, Stop, and PreToolUse/PostToolUse (any
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
  let sessionEndCmds: string[] = [];
  const preToolUsePairs: Array<[string, string]> = [];
  const postToolUsePairs: Array<[string, string]> = [];
  let denyPatterns: string[] = [];
  let askPatterns: string[] = [];
  let allowPatterns: string[] = [];
  let statusLineArgs: string[] = [];
  let defaultModeArgs: string[] = [];
  let autoModeArgs: string[] = [];

  const isCheckMode = args.includes("--check");
  // web-jam-tools#432 finding 9: a SessionStart or SessionEnd entry in agy's
  // hooks.json silently disables the ENTIRE hooks config on that surface —
  // not just that event, every PreToolUse guard included. install-hooks.sh
  // passes --forbid-lifecycle-hooks on every invocation targeting agy's
  // hooks file, so a future change that accidentally adds a --session-end or
  // head/SessionStart argument to that call is refused here rather than
  // silently landing and disarming every guard on the Flash surface. Stop is
  // allowed on that target only in agy's flat shape (see mergeAgyFlatHooks).
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
      [
        "--stop",
        "--session-end",
        "--pre-tool-use",
        "--post-tool-use",
        "--deny",
        "--ask",
        "--allow",
        "--status-line",
        "--default-mode",
        "--auto-mode",
      ],
      rest,
    );
    sessionStartCmds = head;
    stopCmds = sections["--stop"] || [];
    sessionEndCmds = sections["--session-end"] || [];
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
    allowPatterns = sections["--allow"] || [];
    statusLineArgs = sections["--status-line"] || [];
    defaultModeArgs = sections["--default-mode"] || [];
    autoModeArgs = sections["--auto-mode"] || [];
  }

  const passedLifecycle = [
    sessionStartCmds.length > 0 ? "SessionStart" : "",
    sessionEndCmds.length > 0 ? "SessionEnd" : "",
  ].filter(Boolean).join(" or ");

  if (forbidLifecycleHooks && passedLifecycle) {
    console.error(
      `error: refusing to write ${path.basename(settingsPath)} — a ${passedLifecycle} ` +
        "entry was passed for a target invoked with --forbid-lifecycle-hooks. On agy, " +
        "registering SessionStart or SessionEnd silently disables the entire hooks config — not just " +
        "that event, every PreToolUse guard included (web-jam-tools#432 finding 9). " +
        "Stop is allowed there only as a flat { type, command } entry, which this " +
        "script writes (measured 2026-09-28, agy 1.2.12). Remove the --session-end/head " +
        "SessionStart args from this call.",
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

  for (const cmd of [...sessionStartCmds, ...stopCmds, ...sessionEndCmds]) {
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
    const desiredCmds = new Set(cmds);

    const added: string[] = [];
    const pruned: string[] = [];

    for (let i = bucket.length - 1; i >= 0; i--) {
      const entry = bucket[i];
      if (!entry || !Array.isArray(entry.hooks)) continue;
      const remainingHooks: Array<{ type: string; command: string }> = [];
      for (const h of entry.hooks) {
        if (h && h.command) {
          if (isManagedHook(h.command)) {
            if (desiredCmds.has(h.command)) {
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

  // agy rejects its WHOLE hooks file when a Stop entry uses Claude Code's nested
  // { hooks: [{ type, command }] } shape — "Failed to parse hooks file …: invalid
  // hook "hooks": command hook must specify 'command'" — so every PreToolUse guard
  // goes silent. A flat { type, command } Stop entry loads, fires, and leaves the
  // guards firing. Measured 2026-09-28 on agy 1.2.12 (web-jam-tools#1176); this is
  // what web-jam-tools#432 finding 9 observed. Any nested entry found is flattened.
  function mergeAgyFlatHooks(kind: string, cmds: string[]): [string[], string[], number] {
    const current: unknown[] = Array.isArray(hooks[kind]) ? hooks[kind] : [];
    const entries: Array<{ type: string; command: string }> = [];
    let reshaped = 0;
    for (const entry of current) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { command?: unknown; hooks?: unknown };
      if (Array.isArray(e.hooks)) {
        reshaped++;
        for (const h of e.hooks as Array<{ command?: unknown }>) {
          if (h && typeof h.command === "string") {
            entries.push({ type: "command", command: h.command });
          }
        }
      } else if (typeof e.command === "string") {
        entries.push({ type: "command", command: e.command });
      }
    }

    const desiredCmds = new Set(cmds);
    const pruned: string[] = [];
    const kept = entries.filter((e) => {
      if (!isManagedHook(e.command)) return true;
      if (desiredCmds.has(e.command)) {
        return true;
      }
      pruned.push(e.command);
      return false;
    });

    const existing = new Set(kept.map((e) => e.command));
    const added: string[] = [];
    for (const cmd of cmds) {
      if (!existing.has(cmd)) {
        kept.push({ type: "command", command: cmd });
        existing.add(cmd);
        added.push(cmd);
      }
    }
    hooks[kind] = kept;
    return [added, pruned, reshaped];
  }

  const [addedSession, prunedSession] = mergeFlatHooks("SessionStart", sessionStartCmds);
  const [addedStop, prunedStop, reshapedStop] = forbidLifecycleHooks
    ? mergeAgyFlatHooks("Stop", stopCmds)
    : [...mergeFlatHooks("Stop", stopCmds), 0];
  const [addedSessionEnd, prunedSessionEnd] = mergeFlatHooks("SessionEnd", sessionEndCmds);

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

  function mergePermissionsList(
    sectionName: "deny" | "ask" | "allow",
    patterns: string[],
  ): string[] {
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
  // permissions.allow (web-jam-tools#685, §3a) — purely additive, same shape
  // as deny/ask, but with no cross-listing check against the other two: an
  // allow pattern also present in permissions.deny is not a conflict to
  // resolve here (deny always wins over a matching allow), so unlike
  // deny/ask there is nothing to reconcile between allow and its siblings.
  const addedAllow = mergePermissionsList("allow", allowPatterns);

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

  // permissions.defaultMode merge (web-jam-tools#705). Same single-scalar
  // shape as statusLine above, but nested under permissions instead of
  // top-level — Claude Code's settings.json stores it as a plain string
  // (e.g. "acceptEdits"), not an object. Only touched when --default-mode
  // was actually passed, so a target invoked without it (agy's hooks.json —
  // agy has no permission-mode concept at all, docs/agy-hooks.md) is
  // completely unaffected: no key added, no drift ever reported,
  // byte-identical output.
  let defaultModeAdded = false;
  let defaultModeChanged = false;
  let defaultModePrevValue: string | undefined;
  if (defaultModeArgs.length > 0) {
    const desiredMode = defaultModeArgs[0];
    if (!data.permissions || typeof data.permissions !== "object") {
      data.permissions = {};
    }
    const current = data.permissions.defaultMode;
    if (current === undefined) {
      defaultModeAdded = true;
      data.permissions.defaultMode = desiredMode;
    } else if (current !== desiredMode) {
      defaultModeChanged = true;
      defaultModePrevValue = typeof current === "string" ? current : undefined;
      data.permissions.defaultMode = desiredMode;
    }
  }

  // autoMode merge: the whole object is owned by this installer. One JSON
  // string argument; installed when absent, replaced when it differs (key
  // order ignored, array order significant). Only touched when --auto-mode
  // was passed, so agy's hooks.json is unaffected.
  let autoModeAdded = false;
  let autoModeChanged = false;
  let autoModeDiff: string[] = [];
  if (autoModeArgs.length > 0) {
    let desiredAutoMode: unknown;
    try {
      desiredAutoMode = JSON.parse(autoModeArgs[0]);
    } catch (e) {
      console.error(`error: --auto-mode value is not valid JSON: ${e}`);
      return 1;
    }
    if (data.autoMode === undefined) {
      autoModeAdded = true;
      data.autoMode = desiredAutoMode;
    } else if (canonicalJson(data.autoMode) !== canonicalJson(desiredAutoMode)) {
      autoModeChanged = true;
      // Computed before the replace: a replace discards a hand edit, so the
      // output has to name it for it to be carried into AUTO_MODE_JSON.
      autoModeDiff = describeAutoModeDiff(data.autoMode, desiredAutoMode);
      data.autoMode = desiredAutoMode;
    }
  }

  // Secret-scan gate: check all strings in permissions, hooks and autoMode for credentials
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
          if (entry && typeof entry.command === "string") {
            // agy's flat Stop entry shape (see mergeAgyFlatHooks).
            const match = findCredentialLiteral(entry.command);
            if (match) {
              secretFindings.push(`hooks.${kind}[${b}]: ${match}`);
            }
          }
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

  forEachString(data.autoMode, "autoMode", (where, value) => {
    const match = findCredentialLiteral(value);
    if (match) {
      secretFindings.push(`${where}: ${match}`);
    }
  });

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
    reshapedStop > 0 ||
    addedSessionEnd.length > 0 ||
    prunedSessionEnd.length > 0 ||
    addedPreToolUse.length > 0 ||
    prunedPreToolUseStale.length > 0 ||
    prunedPreToolUseRetired.length > 0 ||
    addedPostToolUse.length > 0 ||
    prunedPostToolUseStale.length > 0 ||
    prunedPostToolUseRetired.length > 0 ||
    addedDeny.length > 0 ||
    addedAsk.length > 0 ||
    addedAllow.length > 0 ||
    denyOwnedInAsk.length > 0 ||
    askOwnedInDeny.length > 0 ||
    statusLineAdded ||
    statusLineChanged ||
    defaultModeAdded ||
    defaultModeChanged ||
    autoModeAdded ||
    autoModeChanged;

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
      if (reshapedStop > 0) {
        console.error(
          `${targetFilename}: has ${reshapedStop} nested Stop entr${
            reshapedStop === 1 ? "y" : "ies"
          } agy rejects — the whole hooks file fails to load`,
        );
      }
      for (const cmd of addedSessionEnd) {
        console.error(`${targetFilename}: missing SessionEnd hook ${cmd}`);
      }
      for (const cmd of prunedSessionEnd) {
        console.error(`${targetFilename}: has retired SessionEnd hook ${cmd}`);
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
      for (const pattern of addedAllow) {
        console.error(`${targetFilename}: missing permissions.allow rule ${pattern}`);
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
      if (defaultModeAdded) {
        console.error(`${targetFilename}: missing permissions.defaultMode ${defaultModeArgs[0]}`);
      }
      if (defaultModeChanged) {
        console.error(
          `${targetFilename}: permissions.defaultMode differs from desired (want ${
            defaultModeArgs[0]
          }${defaultModePrevValue ? `, has ${defaultModePrevValue}` : ""})`,
        );
      }
      if (autoModeAdded) {
        console.error(`${targetFilename}: missing autoMode section`);
      }
      if (autoModeChanged) {
        console.error(`${targetFilename}: autoMode differs from the versioned config`);
        for (const line of autoModeDiff) {
          console.error(`  ${line}`);
        }
      }
      return 1;
    }
    console.log(
      `${targetFilename}: SessionStart, SessionEnd, Stop, PreToolUse, PostToolUse hooks and permissions.deny / permissions.ask / permissions.allow already up to date (no-op)`,
    );
    return 0;
  }

  if (!hasDrift) {
    console.log(
      `${targetFilename}: SessionStart, SessionEnd, Stop, PreToolUse, PostToolUse hooks ` +
        "and permissions.deny / permissions.ask / permissions.allow already up to date (no-op)",
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
  if (reshapedStop > 0) {
    console.log(`${targetFilename}: flattened ${reshapedStop} nested Stop entries agy rejects`);
  }
  for (const cmd of addedSessionEnd) console.log(`${targetFilename}: added SessionEnd hook ${cmd}`);
  for (const cmd of prunedSessionEnd) {
    console.log(`${targetFilename}: removed retired SessionEnd hook ${cmd}`);
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
  for (const pattern of addedAllow) {
    console.log(`${targetFilename}: added permissions.allow rule ${pattern}`);
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
  if (defaultModeAdded) {
    console.log(`${targetFilename}: added permissions.defaultMode ${defaultModeArgs[0]}`);
  }
  if (defaultModeChanged) {
    console.log(
      `${targetFilename}: updated permissions.defaultMode to ${defaultModeArgs[0]}`,
    );
  }
  if (autoModeAdded) {
    console.log(`${targetFilename}: added autoMode section`);
  }
  if (autoModeChanged) {
    console.log(`${targetFilename}: updated autoMode to the versioned config`);
    for (const line of autoModeDiff) {
      console.log(`  ${line}`);
    }
  }

  return 0;
}

/** JSON.stringify with object keys sorted, so key order never counts as drift. */
function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One entry as JSON, cut to a length that keeps a drift report readable. */
function previewEntry(v: unknown): string {
  const text = JSON.stringify(v);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/**
 * Names what differs between the installed autoMode and the versioned one:
 * the top-level keys that differ and, for list values, the entries only one
 * side has. The installed value is replaced as a whole, so this is the only
 * record of a hand edit outside the backup file.
 */
function describeAutoModeDiff(installed: unknown, versioned: unknown): string[] {
  if (!isPlainObject(installed) || !isPlainObject(versioned)) {
    return ["autoMode: the installed value is not an object"];
  }
  const lines: string[] = [];
  const keys = [...new Set([...Object.keys(installed), ...Object.keys(versioned)])].sort();
  for (const key of keys) {
    if (!(key in versioned)) {
      lines.push(`autoMode.${key}: key is not in the versioned config`);
      continue;
    }
    if (!(key in installed)) {
      lines.push(`autoMode.${key}: key is missing`);
      continue;
    }
    const have = installed[key];
    const want = versioned[key];
    if (canonicalJson(have) === canonicalJson(want)) continue;
    if (!Array.isArray(have) || !Array.isArray(want)) {
      lines.push(`autoMode.${key}: value differs`);
      continue;
    }
    const haveSet = new Set(have.map(canonicalJson));
    const wantSet = new Set(want.map(canonicalJson));
    const extra = have.filter((e) => !wantSet.has(canonicalJson(e)));
    const missing = want.filter((e) => !haveSet.has(canonicalJson(e)));
    for (const e of extra) {
      lines.push(`autoMode.${key}: entry not in the versioned config: ${previewEntry(e)}`);
    }
    for (const e of missing) {
      lines.push(`autoMode.${key}: versioned entry missing: ${previewEntry(e)}`);
    }
    if (extra.length === 0 && missing.length === 0) {
      lines.push(`autoMode.${key}: same entries in a different order or count`);
    }
  }
  return lines;
}

/** Calls fn for every string inside v, with a path such as autoMode.allow[1]. */
function forEachString(
  v: unknown,
  where: string,
  fn: (where: string, value: string) => void,
): void {
  if (typeof v === "string") {
    fn(where, v);
  } else if (Array.isArray(v)) {
    v.forEach((e, i) => forEachString(e, `${where}[${i}]`, fn));
  } else if (isPlainObject(v)) {
    for (const [k, e] of Object.entries(v)) {
      forEachString(e, `${where}.${k}`, fn);
    }
  }
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
