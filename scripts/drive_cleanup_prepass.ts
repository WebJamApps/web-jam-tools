/**
 * drive_cleanup_prepass.ts — web-jam-tools#382
 */
export function runDriveCleanupPrepass(): void {
  const rootRaw = Deno.env.get("ROOT_JSON") || "[]";
  const jmmRaw = Deno.env.get("JMM_JSON") || "[]";
  const jmmLocal = Deno.env.get("JMM_LOCAL") || "";

  let root: any[] = [];
  let jmm: any[] = [];
  try {
    root = JSON.parse(rootRaw);
  } catch {
    root = [];
  }
  try {
    jmm = JSON.parse(jmmRaw);
  } catch {
    jmm = [];
  }

  const now = new Date();

  function ageDays(modtime?: string): number | null {
    if (!modtime) return null;
    try {
      const t = new Date(modtime);
      if (isNaN(t.getTime())) return null;
      return (now.getTime() - t.getTime()) / (86400 * 1000);
    } catch {
      return null;
    }
  }

  const CANONICAL = new Set(["claude-sonnet-tasks.txt", "SHARED.md"]);
  const KNOWN_FOLDERS = new Set(["CLAUDE", "JoshMariaMusic", "MariaParty", "CollegeLutheran", "Misc"]);
  const REPORT_FILE = "drive-cleanup-pending-report.md";
  const MIRROR = [
    "Pitch Email – MidRange Cafe Bar.txt",
    "Pitch Email – Originals Venues.txt",
    "Pitch Email – Pub Festival Brewery.txt",
    "Online Form Information Block.txt",
  ];

  const RE_FOR_OPUS = /^for-opus-.+\.txt$/;
  const RE_LEGACY_OPUS = /^claude-opus-tasks-\d{4}-\d{2}-\d{2}-\d{4}\.txt$/;
  const RE_SONNET_TS = /^claude-sonnet-tasks-\d{4}-\d{2}-\d{2}-\d{4}\.txt$/;
  const RE_DATEISH = /\d{4}-\d{2}-\d{2}/;

  const files = root.filter((it) => !it.IsDir);
  const dirs = root.filter((it) => it.IsDir);

  const nameCounts: Record<string, number> = {};
  for (const it of files) {
    nameCounts[it.Name] = (nameCounts[it.Name] || 0) + 1;
  }

  function trashCmd(it: any): string {
    return `deleteItem ${it.ID || ""}`;
  }

  const actions: Array<[string, any, string, string]> = [];
  const ambiguous: Array<[string, any]> = [];
  let nCanonical = 0;
  let nFolder = 0;

  for (const it of dirs) {
    if (KNOWN_FOLDERS.has(it.Name)) {
      nFolder++;
    } else {
      ambiguous.push(["unknown folder", it]);
    }
  }

  const reportItems = files
    .filter((it) => it.Name === REPORT_FILE)
    .sort((a, b) => String(b.ModTime || "").localeCompare(String(a.ModTime || "")));
  const reportExtraItems = new Set(reportItems.slice(1));

  const canonicalExtraItems = new Set<any>();
  for (const cname of CANONICAL) {
    const copies = files
      .filter((it) => it.Name === cname)
      .sort((a, b) => String(b.ModTime || "").localeCompare(String(a.ModTime || "")));
    if (copies.length > 1) {
      for (const extra of copies.slice(1)) {
        canonicalExtraItems.add(extra);
      }
    }
  }

  for (const it of files) {
    const name = it.Name;
    const fid = it.ID || "";

    if (name === REPORT_FILE) {
      if (reportExtraItems.has(it)) {
        actions.push([
          "report-retention",
          it,
          "older copy of the report file — keep latest only; trash this one",
          trashCmd(it),
        ]);
      } else {
        nCanonical++;
      }
      continue;
    }
    if (CANONICAL.has(name)) {
      if (canonicalExtraItems.has(it)) {
        actions.push([
          "duplicate-canonical",
          it,
          `canonical file appears ${nameCounts[name]}x — must be exactly one; keep latest only, trash this older copy`,
          trashCmd(it),
        ]);
      } else {
        nCanonical++;
      }
      continue;
    }
    if (name.startsWith("processed-")) {
      nCanonical++;
      continue;
    }
    if (RE_FOR_OPUS.test(name) || RE_LEGACY_OPUS.test(name)) {
      actions.push([
        "bridge->opus",
        it,
        "bridge into ~/Dropbox/web-jam-llms/claude-opus-tasks.txt (model: download id, append w/ 120-col wrap, verify), then trash",
        trashCmd(it),
      ]);
      continue;
    }
    if (RE_SONNET_TS.test(name)) {
      actions.push([
        "sonnet-queue-merge",
        it,
        "merge into canonical claude-sonnet-tasks.txt on Drive (model), then trash",
        trashCmd(it),
      ]);
      continue;
    }
    if (nameCounts[name] > 1) {
      actions.push([
        "duplicate",
        it,
        `same-name duplicate at root (${nameCounts[name]}x) — Josh/model picks which to keep, then trash the rest by ID (never by name)`,
        `deleteItem ${fid}  # only if this copy is NOT the keeper`,
      ]);
      continue;
    }
    const a = ageDays(it.ModTime);
    if (RE_DATEISH.test(name) && a !== null && a > 7) {
      actions.push([
        "stale-timestamped",
        it,
        `timestamped file older than 7 days (${Math.floor(a)}d) — trash candidate`,
        trashCmd(it),
      ]);
      continue;
    }
    ambiguous.push(["unrecognized root file", it]);
  }

  const jmmByName: Record<string, any> = {};
  for (const it of jmm) {
    if (!it.IsDir) jmmByName[it.Name] = it;
  }
  const staleMirror: string[] = [];
  for (const fn of MIRROR) {
    const lp = `${jmmLocal}/${fn}`;
    let lsize = -1;
    let lmtime: Date | null = null;
    try {
      const stat = Deno.statSync(lp);
      lsize = stat.size;
      lmtime = stat.mtime;
    } catch {
      continue; // local doesn't exist
    }

    const d = jmmByName[fn];
    if (!d) {
      staleMirror.push(`${fn} (missing on Drive)`);
      continue;
    }
    if (d.Size !== lsize) {
      staleMirror.push(`${fn} (size differs)`);
      continue;
    }
    const dmt = ageDays(d.ModTime);
    if (dmt !== null && lmtime) {
      const dtime = new Date(now.getTime() - dmt * 86400 * 1000);
      if (lmtime.getTime() > dtime.getTime() + 2000) {
        staleMirror.push(`${fn} (local newer)`);
      }
    }
  }

  const mirrorCmd =
    `rclone copy "${jmmLocal}/" gdrive:JoshMariaMusic/ ` +
    '--include "Pitch Email – MidRange Cafe Bar.txt" ' +
    '--include "Pitch Email – Originals Venues.txt" ' +
    '--include "Pitch Email – Pub Festival Brewery.txt" ' +
    '--include "Online Form Information Block.txt" --update';

  const out: string[] = [];
  out.push(`## drive-cleanup pre-pass (rclone, deterministic) — ${now.toISOString().replace(/\.\d{3}Z$/, "Z")}`);
  out.push("");
  const total = root.length;
  out.push(
    `Reconciliation: ${total} root items = ${nCanonical} canonical/allowed + ${nFolder} known folders + ${actions.length} findings + ${ambiguous.length} ambiguous.`,
  );
  out.push("");
  out.push("### Proposed actions");
  if (actions.length) {
    for (const [kind, it, desc, cmd] of actions) {
      out.push(`- **[${kind}]** \`${it.Name}\` (id \`${it.ID || "?"}\`) — ${desc}`);
      out.push(`  - \`${cmd}\``);
    }
  } else {
    out.push("none");
  }
  if (staleMirror.length) {
    out.push(`- **[mirror]** JoshMariaMusic mirror stale: ${staleMirror.join(", ")} — push Dropbox→Drive`);
    out.push(`  - \`${mirrorCmd}\``);
  }
  out.push("");
  out.push("### Ambiguous (model must classify)");
  if (ambiguous.length) {
    for (const [kind, it] of ambiguous) {
      out.push(
        `- \`${it.Name}\` (id \`${it.ID || "?"}\`) — ${it.IsDir ? "dir" : `${it.Size ?? -1} bytes`}, modified ${it.ModTime || "?"} [${kind}]`,
      );
    }
  } else {
    out.push("none");
  }
  out.push("");
  const isClean = actions.length === 0 && ambiguous.length === 0 && staleMirror.length === 0;
  out.push(`### Status: ${isClean ? "CLEAN" : "ACTIONS_PROPOSED"}`);

  console.log(out.join("\n"));
}

if (import.meta.main) {
  runDriveCleanupPrepass();
}
