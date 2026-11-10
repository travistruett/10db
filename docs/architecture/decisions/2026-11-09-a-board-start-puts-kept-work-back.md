# A Board start of a taken-out task puts its kept work back first

- **Date:** 2026-11-09
- **Amends:** `decisions/2026-11-09-a-taken-out-tasks-workstream-is-cancelled.md`

## Decision

Starting a task with saved Workbench work outside a pass is no longer refused. Its run never launches before
the work is back in the checkout it runs in: the scheduler asks a kept-work gate last, just before the claim,
of a run every other check would launch now (`delivery/kept-work-start.ts`, `createKeptWorkGate`), and while
the run's task has saved work the gate answers no and queues one put-back, by the same file-by-file put-back a
later pass uses (`pass/put-back.ts`, injected into delivery as `DeliveryContext.putBack`), into the run's
checkout (its batch's copy, or Your folder) in the project's queue; the run launches on the tick after. A run
of a batch that is not open, of a pass, or held by W9 passes the gate, and its work goes back once it could
launch. The put-back's job asks again as it runs, and writes nothing for a run no longer queued, a batch no
longer open, or a task or Your folder a pass has taken since.
A file that does not merge stays as it is, is named on the task's thread, and alone stays saved. The saved
work's ref, `refs/10db/kept/<task id>`, is deleted once a batch holding the task's finished run ships or
lands, or, in a project with no batches, once the run is done.

## Why

Workbench spec §5.4 and call 33: otherwise the work waits for a pass the builder may never open, or a start
drops it without a word. One rule at the launch covers every way a run comes to launch: a start, a second
Start, a join, a run found queued after a restart. Nothing of the saved work's record changes before the run
exists and could launch, so a start refused at its cut leaves the work saved as it was.

Turned down: refusing the start (what the amended record did until now), which strands the work; putting the
work back in the cut, which a start refused afterwards leaves half recorded, and which a local start, with no
cut, has no place for (holding its run instead let a second Start or a restart launch it first); putting the
work back from the session's first turn, which runs code before the builder's work is in place.
