# A taken-out task's workstream is cancelled; its kept work is put back by the next pass that takes it

- **Date:** 2026-11-09
- **Amends:** `decisions/2026-10-29-per-copy-hazards-and-waiting-claims.md`; sits beside the task-placement spec

## Decision

Taking a task out of its pass cancels its workstream from whatever state it is in, releases its claims and
leaves it open on the Board with its thread and its kept work (`tasks.kept_work_sha`, `kept_base_sha`; the
commit at `refs/10db/kept/<task id>`). A hazard's files ride the kept work of the task that holds the hazard.
The next pass that takes the task puts the work back file by file (`pass/put-back.ts`): a file still as the
take-out left it takes the kept version, any other merges three ways from the commit the work was kept on, and
one that does not merge is left and named on the thread. The task then records as saved only what did not go
back, as a commit holding just those files; a later take-out never writes over saved work still recorded, making
its kept commit on both. A put-back the daemon stopped in runs again at start-up. Until a Board start can put
kept work back too, starting such a task outside a pass is refused with 409. Putting it back from a Board start,
and discarding it, are designed (Workbench spec §5.4).

## Why

A queued run of a task leaving the pass would start an ordinary session in the folder the moment the pass let it
go. The work belongs to the task, not to the pass that was abandoned or closed around it, so the next start must
not lose it.

Turned down: keeping the workstream and resuming it later, which would carry a pass lane's session and claims
outside any pass.
