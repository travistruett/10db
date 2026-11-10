# A Board start of a taken-out task puts its kept work back first

- **Date:** 2026-11-09
- **Amends:** `decisions/2026-11-09-a-taken-out-tasks-workstream-is-cancelled.md`

## Decision

Starting a task with saved Workbench work outside a pass is no longer refused. The start puts the work back
in the checkout the run will use, by the same file-by-file put-back a later pass uses (`pass/put-back.ts`,
injected into delivery as `DeliveryContext.putBack`), before any lane can launch: in a shared cut after the
batch's branch is cut and before the batch opens, in a separate copy's cut before it opens, in a join before
the joined runs are written, and in a local project by holding the new run (`HELD`) until a job in the
project's queue has put the work back, then queuing it (`delivery/kept-work-start.ts`). A file that does not
merge stays as it is, is named on the task's thread, and alone stays saved. The saved work's ref,
`refs/10db/kept/<task id>`, is deleted once a batch holding the task's finished run ships or lands.

## Why

Workbench spec §5.4 and call 33: otherwise the work waits for a pass the builder may never open, or a start
drops it without a word. Putting it back before the batch opens, rather than in the session, keeps the rule
that nothing launches before its checkout is ready, and the hold keeps a local start, which has no cut, under
the same rule.

Turned down: refusing the start (what the amended record did until now), which strands the work; putting the
work back from the session's first turn, which runs code before the builder's work is in place.
