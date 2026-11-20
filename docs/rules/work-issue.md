# Carry an invoked task through to completion

Josh's first explicit skill invocation authorizes the work in that skill's scope. Do not make him
repeat it to authorize routine, reversible preparation needed to finish that same task.

When setup refuses stale issue-body blocker wording, verify every named prerequisite through fresh
GitHub reads and check for external prerequisites. If all are closed and no unmet external
prerequisite remains, update only the obsolete blocker wording through `deno task edit-issue`, keep
the dependency citations and rationale, and retry setup. Report the correction while continuing;
do not ask Josh to authorize it again. An unreadable prerequisite, an open blocker, a real design
conflict, or a separate human approval gate still stops dependent work. Never bypass or weaken a
guard to get past its refusal.

A status question does not cancel the active task. Answer it briefly and continue the authorized
work. State plainly whether a PR exists and link it when it does; never imply a PR was created when
setup stopped before implementation. If Josh explicitly redirects work, state what is unfinished
and continue the task he named.

When `handle-agy-tasks.sh` or `running-model` refuses because lines in the temporary log
`/tmp/agy-hook-invocations.jsonl` lack a `conversationId` (`The agy hook record names no running
conversation in /tmp/agy-hook-invocations.jsonl`), delete `/tmp/agy-hook-invocations.jsonl` yourself
(`rm -f /tmp/agy-hook-invocations.jsonl`) and retry — it is a disposable `/tmp` runtime log that
agy's next `PreToolUse` hook call recreates cleanly.

Recorded from Josh's correction on 2026-11-16: "i should not have to repeat when I invoke the skill!"
Recorded from Josh's correction on 2026-11-17: "please add this to your rules to DELETE this tmp file next time yourself, it is not needed it is tmp log only so delete it next time yourself!"
