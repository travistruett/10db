# Start on a task whose run failed in an open batch reruns it there

- **Date:** 2026-11-02

## Decision

`POST /tasks/:taskId/start` (the card's Start, `tendb start`) on a task whose current workstream is
FAILED, in a batch that is OPEN or FAILED, does what the failure card's Retry does: the same
workstream is queued again in the same batch and a FAILED worktree batch reopens through the cut queue.
The commits its earlier attempt made stay on the batch branch. The answer is the workstream (201).

- The body may be `{ "fresh": true }` (`StartTaskInput`). Then the task starts over from the base
  branch: the batch is abandoned first when it holds only that task's workstreams, and the start goes on
  as for a task that never ran. Abandoning keeps the branch, cancels the batch's unfinished work and
  refuses while a run in it is live. A batch that holds other tasks' work stays as it is.
- Abandoning can't be undone, so before it the starter runs the start's own checks as a dry run
  (`BatchStarter.refuseStart`): the task is open, not parked and not joining, and the placement's
  checks (dependencies, landing, the shared batch's state) pass as if the old batch had already ended.
  A start those checks refuse answers 409 and leaves the old batch OPEN or FAILED, so Retry still works.
  Only the background cut's git and gh checks come after the abandon; their refusal is a card, and the
  old branch is kept.
- An empty body, whatever its content type, is a plain start; a body that is not JSON, or not a
  `StartTaskInput`, is a 400.
- The task drawer offers Start over beside Retry for a failed run in an OPEN or FAILED batch, unless
  the task is parked.
- A failed run in a batch that shipped, was abandoned or is otherwise ended is not continued: Start cuts
  a new batch as before.

`createFailedRestarts` (`apps/daemon/src/delivery/restart.ts`) holds both halves, and the daemon's
`startTask` service calls it before the placement-specific start.

## Why

Start cut a new batch with a new copy at the base's head, so the run redid the work and left the old
batch OPEN with nothing to finish it; `join` into that batch was then refused because the task was
running. Continuing is the safe default since it loses nothing, and the one path that discards the
attempt is explicit. Ending the batch that holds only the superseded attempt means no OPEN batch is left
for nothing to finish.
