# A queued task that has not run can be held, as a HELD workstream state

- **Date:** 2026-10-29

## Decision

`HELD` is a workstream state with two edges in and two out: `QUEUED → HELD`, `HELD → QUEUED` and
`HELD → CANCELLED`. `POST /tasks/:taskId/hold` makes it, in one write, for a task whose latest run is
`QUEUED` and has not run: no session, no attempt, no recovery behind it. Anything else answers 409 naming
the task and the Factory cancel (`<task> is running: cancel it in Factory first` or `<task> has already
run: ...`). Holding a held task answers the same run and emits nothing.

`HELD` is not terminal, so the run keeps what it had: its batch stays `OPEN`, so a batch of which every
other task is done does not ship around it (the ship trigger fires on `DONE` and `CANCELLED` only); its
worktree, branch and pin stay; the scheduler lists only `QUEUED` runs, so it takes no lane; recovery keeps
it as it is. It counts as active everywhere `ACTIVE_STATES` is asked: the task can't be dragged, started
as new work, or have its project's delivery or workspace mode changed under it. The board derives
`blocked` for it, so a held card sits in Blocked and says `Held: not in the queue`.

`POST /tasks/:taskId/start` on a held task queues the same run again (`HELD → QUEUED`, 201 with the
workstream, in every delivery mode); it takes the next free lane like any queued run. `POST
/tasks/:taskId/remove` on a held task cancels the run and the task in one write. The cancel is the ship
trigger's event, so the batch is re-read like any cancel: with nothing else in it, it has no commit beyond
its base and closes, which removes the worktree and deletes the branch (`2026-10-27-worktree-removal-and-sweep.md`);
with sibling work done it ships that work, as it would after any cancel. A task whose run is any other
state is still refused by Remove, with the workstream's own cancel named.

The Board offers Hold in the card menu and the drawer for a task with a live run: enabled for a queued run
that has not run, disabled with the reason (`Hold (<task> is running: cancel it in Factory first)`) for
every other live run. A held task's menu and drawer offer Start and Remove instead.

## Why

Cancelling a queued run to get it out of the way ends the run, and a batch whose every member is done or
cancelled ships: cancelling a batch's only task is the known path to shipping nothing (feedback item
151). A hold leaves the run unsettled, so nothing ends until the builder starts or removes it.

Alternatives turned down:

- **Move the task to a human column.** `moveTask` parks only tasks that never started; a queued run
  already has a batch and a worktree that a parked task would leave behind with nothing to run in them.
- **A flag on the task or the workstream.** Every reader of the queue would have to learn to skip it. A
  state is what the scheduler, recovery, the board and the ship trigger already switch on, and the
  `state` column is plain text, so it needs no migration.
- **Let a run that has begun be held.** Its session, claims and lease would have to be stopped and kept;
  that is a pause, not a hold, and the builder already has Cancel for it.
