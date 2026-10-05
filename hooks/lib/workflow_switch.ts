/**
 * Workflow guard off-switch reader, matcher, and release logger (web-jam-tools#1046).
 *
 * Design reference: ~/Dropbox/web-jam-llms/AI_Misbehaves/hooks-design-2026-09-15.md (v2.1.0),
 * sections "Turning a guard off when it is wrong" and "How a hook gets into force",
 * decisions D-17 and D-18.
 *
 * Provides a time-boxed off-switch under ~/.claude/state/workflow-switch.json that allows
 * releasing a wrongly-refusing workflow guard without a merge or a restart.
 *
 * When an unexpired switch names the target guard (or "all" / "all workflow guards"), the
 * workflow guard allows the call and appends an entry with its timestamp and guard name to
 * ~/.claude/state/workflow-switch.log.
 *
 * If the switch file is absent, names a different guard, is expired, carries an unparseable
 * expiry, or contains malformed JSON, the guard's own default applies unchanged (fails open
 * on the switch read itself by proceeding as if absent).
 */

export interface WorkflowSwitch {
  guard?: string;
  guards?: string[] | string;
  expires_at: string;
}

export interface SwitchCheckResult {
  released: boolean;
  reason?: string;
}

export function defaultWorkflowSwitchPath(): string {
  const override = Deno.env.get("WORKFLOW_SWITCH_PATH");
  if (override) return override;
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "/home/joshua";
  return `${home}/.claude/state/workflow-switch.json`;
}

export function defaultWorkflowSwitchLogPath(): string {
  const override = Deno.env.get("WORKFLOW_SWITCH_LOG_PATH");
  if (override) return override;
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "/home/joshua";
  return `${home}/.claude/state/workflow-switch.log`;
}

/**
 * Loads the workflow switch from disk.
 * Returns null if the file is missing, unreadable, or not valid JSON (proceeds as absent).
 */
export function loadWorkflowSwitch(
  switchPath: string = defaultWorkflowSwitchPath(),
): WorkflowSwitch | null {
  let text: string;
  try {
    text = Deno.readTextFileSync(switchPath);
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") return null;
    return data as WorkflowSwitch;
  } catch {
    // Malformed JSON: proceeds as if absent (fails open on switch read)
    return null;
  }
}

export function normalizeGuardName(name: string): string {
  return name.trim().toLowerCase().replace(/\.sh$/, "");
}

/**
 * Determines whether the switch configuration names the target guard.
 * Supports individual guard names, arrays of names, or wildcards ("all", "all workflow guards").
 */
export function isGuardNamedBySwitch(switchData: WorkflowSwitch, guardName: string): boolean {
  const target = normalizeGuardName(guardName);
  const candidates: string[] = [];

  if (typeof switchData.guard === "string") {
    candidates.push(switchData.guard);
  }
  if (Array.isArray(switchData.guards)) {
    for (const g of switchData.guards) {
      if (typeof g === "string") candidates.push(g);
    }
  } else if (typeof switchData.guards === "string") {
    candidates.push(switchData.guards);
  }

  for (const raw of candidates) {
    const norm = normalizeGuardName(raw);
    if (norm === "all" || norm === "all workflow guards" || norm === "*") {
      return true;
    }
    if (norm === target) {
      return true;
    }
  }
  return false;
}

/**
 * Checks whether the switch is unexpired.
 * Missing, blank, or unparseable expires_at counts as expired.
 */
export function isSwitchUnexpired(switchData: WorkflowSwitch, now: Date = new Date()): boolean {
  if (typeof switchData.expires_at !== "string" || !switchData.expires_at.trim()) {
    return false;
  }
  const expiryTime = new Date(switchData.expires_at).getTime();
  if (Number.isNaN(expiryTime)) {
    return false;
  }
  return expiryTime > now.getTime();
}

/**
 * Appends a log line to the workflow switch log recording the release.
 * Creates the parent directory if necessary.
 */
export function logWorkflowSwitchRelease(
  guardName: string,
  timestamp: Date = new Date(),
  logPath: string = defaultWorkflowSwitchLogPath(),
): void {
  try {
    const lastSlash = logPath.lastIndexOf("/");
    if (lastSlash > 0) {
      const parentDir = logPath.slice(0, lastSlash);
      try {
        Deno.mkdirSync(parentDir, { recursive: true });
      } catch {
        // ignore directory creation error
      }
    }
    const iso = timestamp.toISOString();
    const line = `${iso} released guard: ${guardName}\n`;
    Deno.writeTextFileSync(logPath, line, { append: true });
  } catch (err) {
    // Non-fatal: failing to log does not block allowed work
    console.error(
      `Warning: failed to append to workflow switch log (${logPath}): ${(err as Error).message}`,
    );
  }
}

/**
 * Evaluates whether the workflow switch is active for `guardName`.
 * If active and unexpired, logs the release and returns `{ released: true }`.
 * Otherwise returns `{ released: false }`.
 */
export function checkAndConsumeWorkflowSwitch(
  guardName: string,
  now: Date = new Date(),
  switchPath: string = defaultWorkflowSwitchPath(),
  logPath: string = defaultWorkflowSwitchLogPath(),
): SwitchCheckResult {
  const switchData = loadWorkflowSwitch(switchPath);
  if (!switchData) {
    return { released: false };
  }
  if (!isGuardNamedBySwitch(switchData, guardName)) {
    return { released: false };
  }
  if (!isSwitchUnexpired(switchData, now)) {
    return { released: false };
  }
  logWorkflowSwitchRelease(guardName, now, logPath);
  return {
    released: true,
    reason: `Released by workflow switch (${guardName}) at ${now.toISOString()}.`,
  };
}
