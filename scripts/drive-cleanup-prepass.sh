#!/usr/bin/env bash
# drive-cleanup-prepass.sh — web-jam-tools#51 (drive-cleanup Tier 2)
#
# Deterministic rclone pre-pass for /drive-cleanup. It inventories My Drive root
# and the JoshMariaMusic mirror with `rclone lsjson` (one call each — including
# Drive file IDs), mechanically classifies everything rule-shaped, and prints a
# compact report: proposed actions (exact rclone commands, files referenced by
# Drive ID), an ambiguous list for the model to classify, or `CLEAN`.
#
# READ-ONLY: it proposes, it never executes. Phase 2 (Josh's approval) and Phase 3
# (execute) happen in the skill, not here. On a CLEAN result the skill short-
# circuits with zero model analysis and zero MCP calls.
#
# Testability: if PREPASS_ROOT_JSON / PREPASS_JMM_JSON are set, they are used as the
# inventory instead of calling rclone (lets the classifier be unit-tested with a
# seeded set, no Drive access). Otherwise rclone provides the live inventory.
set -euo pipefail

RCLONE="$(command -v rclone || echo rclone)"

if [ -n "${PREPASS_ROOT_JSON:-}" ]; then
  ROOT_JSON="$PREPASS_ROOT_JSON"
else
  ROOT_JSON="$("$RCLONE" lsjson gdrive: --max-depth 1 2>/dev/null || echo '[]')"
fi
if [ -n "${PREPASS_JMM_JSON:-}" ]; then
  JMM_JSON="$PREPASS_JMM_JSON"
else
  JMM_JSON="$("$RCLONE" lsjson gdrive:JoshMariaMusic/ 2>/dev/null || echo '[]')"
fi

export ROOT_JSON JMM_JSON
export JMM_LOCAL="${JMM_LOCAL:-$HOME/Dropbox/joshandmariamusic/JoshMariaMusic}"

python3 - <<'PY'
import os, json, re, datetime

def load(name):
    try:
        return json.loads(os.environ.get(name, "[]") or "[]")
    except json.JSONDecodeError:
        return []

root = load("ROOT_JSON")
jmm = load("JMM_JSON")
jmm_local = os.environ["JMM_LOCAL"]

now = datetime.datetime.now(datetime.timezone.utc)

def age_days(modtime):
    if not modtime:
        return None
    try:
        t = datetime.datetime.fromisoformat(modtime.replace("Z", "+00:00"))
        return (now - t).total_seconds() / 86400.0
    except ValueError:
        return None

CANONICAL = {"claude-sonnet-tasks.txt", "SHARED.md"}
KNOWN_FOLDERS = {"CLAUDE", "GEMMA", "GEMINI", "JoshMariaMusic", "MariaParty",
                 "CollegeLutheran", "Misc"}
REPORT_FILE = "drive-cleanup-pending-report.md"
MIRROR = ["Pitch Email – MidRange Cafe Bar.txt",
          "Pitch Email – Originals Venues.txt",
          "Pitch Email – Pub Festival Brewery.txt",
          "Online Form Information Block.txt"]

TS = r"\d{4}-\d{2}-\d{2}-\d{4}"
RE_FOR_GEMMA = re.compile(r"^for-gemma-.+\.txt$")
RE_FOR_OPUS = re.compile(r"^for-opus-.+\.txt$")
RE_LEGACY_GEMMA = re.compile(r"^gemma-tasks-" + TS + r"\.txt$")
RE_LEGACY_OPUS = re.compile(r"^claude-opus-tasks-" + TS + r"\.txt$")
RE_SONNET_TS = re.compile(r"^claude-sonnet-tasks-" + TS + r"\.txt$")
RE_DATEISH = re.compile(r"\d{4}-\d{2}-\d{2}")

files = [it for it in root if not it.get("IsDir", False)]
dirs = [it for it in root if it.get("IsDir", False)]
name_counts = {}
for it in files:
    name_counts[it["Name"]] = name_counts.get(it["Name"], 0) + 1

def trash_cmd(name):
    return 'rclone delete --drive-use-trash "gdrive:%s"' % name

actions = []      # proposed actions (findings)
ambiguous = []    # model must classify
n_canonical = 0   # canonical / allowed / whitelisted
n_folder = 0

# folders
for it in dirs:
    if it["Name"] in KNOWN_FOLDERS:
        n_folder += 1
    else:
        ambiguous.append(("unknown folder", it))

# report-file retention: keep latest, propose trashing older copies
report_items = sorted([it for it in files if it["Name"] == REPORT_FILE],
                      key=lambda x: x.get("ModTime", ""), reverse=True)
report_extra_ids = set(id(it) for it in report_items[1:])

for it in files:
    name = it["Name"]
    fid = it.get("ID", "")
    if name == REPORT_FILE:
        if id(it) in report_extra_ids:
            actions.append(("report-retention", it,
                            "older copy of the report file — keep latest only; trash this one",
                            trash_cmd(name)))
        else:
            n_canonical += 1  # latest report copy is allowed
        continue
    if name in CANONICAL:
        if name_counts[name] > 1:
            actions.append(("duplicate-canonical", it,
                            "canonical file appears %dx — must be exactly one; trash the extra(s)"
                            % name_counts[name], trash_cmd(name)))
        else:
            n_canonical += 1
        continue
    if name.startswith("processed-"):
        n_canonical += 1  # whitelisted legacy audit leftover — do not flag
        continue
    if RE_FOR_GEMMA.match(name) or RE_LEGACY_GEMMA.match(name):
        actions.append(("bridge->gemma", it,
                        "bridge into ~/Dropbox/web-jam-llms/gemma-tasks.txt "
                        "(model: download id, append w/ 120-col wrap, verify), then trash",
                        trash_cmd(name)))
        continue
    if RE_FOR_OPUS.match(name) or RE_LEGACY_OPUS.match(name):
        actions.append(("bridge->opus", it,
                        "bridge into ~/Dropbox/web-jam-llms/claude-opus-tasks.txt "
                        "(model: download id, append w/ 120-col wrap, verify), then trash",
                        trash_cmd(name)))
        continue
    if RE_SONNET_TS.match(name):
        actions.append(("sonnet-queue-merge", it,
                        "merge into canonical claude-sonnet-tasks.txt on Drive (model), then trash",
                        trash_cmd(name)))
        continue
    if name_counts[name] > 1:
        actions.append(("duplicate", it,
                        "same-name duplicate at root (%dx) — Josh/model picks which to keep (use IDs)"
                        % name_counts[name], "(resolve by ID — names collide)"))
        continue
    a = age_days(it.get("ModTime", ""))
    if RE_DATEISH.search(name) and a is not None and a > 7:
        actions.append(("stale-timestamped", it,
                        "timestamped file older than 7 days (%.0fd) — trash candidate" % a,
                        trash_cmd(name)))
        continue
    ambiguous.append(("unrecognized root file", it))

# JoshMariaMusic mirror freshness
jmm_by_name = {it["Name"]: it for it in jmm if not it.get("IsDir", False)}
stale_mirror = []
for fn in MIRROR:
    lp = os.path.join(jmm_local, fn)
    if not os.path.exists(lp):
        continue  # nothing local to push
    lsize = os.path.getsize(lp)
    lmtime = datetime.datetime.fromtimestamp(os.path.getmtime(lp), datetime.timezone.utc)
    d = jmm_by_name.get(fn)
    if d is None:
        stale_mirror.append(fn + " (missing on Drive)")
        continue
    if d.get("Size", -1) != lsize:
        stale_mirror.append(fn + " (size differs)")
        continue
    dmt = age_days(d.get("ModTime", ""))
    if dmt is not None:
        dtime = now - datetime.timedelta(days=dmt)
        if lmtime > dtime + datetime.timedelta(seconds=2):
            stale_mirror.append(fn + " (local newer)")

mirror_cmd = ('rclone copy "%s/" gdrive:JoshMariaMusic/ '
              '--include "Pitch Email – MidRange Cafe Bar.txt" '
              '--include "Pitch Email – Originals Venues.txt" '
              '--include "Pitch Email – Pub Festival Brewery.txt" '
              '--include "Online Form Information Block.txt" --update') % jmm_local

# ---- report ----
out = []
out.append("## drive-cleanup pre-pass (rclone, deterministic) — %s"
           % now.strftime("%Y-%m-%dT%H:%M:%SZ"))
out.append("")
total = len(root)
out.append("Reconciliation: %d root items = %d canonical/allowed + %d known folders "
           "+ %d findings + %d ambiguous."
           % (total, n_canonical, n_folder, len(actions), len(ambiguous)))
out.append("")

out.append("### Proposed actions")
if actions:
    for kind, it, desc, cmd in actions:
        out.append("- **[%s]** `%s` (id `%s`) — %s"
                   % (kind, it["Name"], it.get("ID", "?"), desc))
        out.append("  - `%s`" % cmd)
else:
    out.append("none")
if stale_mirror:
    out.append("- **[mirror]** JoshMariaMusic mirror stale: %s — push Dropbox→Drive"
               % ", ".join(stale_mirror))
    out.append("  - `%s`" % mirror_cmd)
out.append("")

out.append("### Ambiguous (model must classify)")
if ambiguous:
    for kind, it in ambiguous:
        out.append("- `%s` (id `%s`) — %s, modified %s [%s]"
                   % (it["Name"], it.get("ID", "?"), "dir" if it.get("IsDir") else
                      ("%d bytes" % it.get("Size", -1)), it.get("ModTime", "?"), kind))
else:
    out.append("none")
out.append("")

is_clean = not actions and not ambiguous and not stale_mirror
out.append("### Status: %s" % ("CLEAN" if is_clean else "ACTIONS_PROPOSED"))

print("\n".join(out))
PY
