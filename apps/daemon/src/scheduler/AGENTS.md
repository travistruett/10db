# apps/daemon/src/scheduler

- Every `continue` in `launchQueued` that passes over a queued run records why in `opts.waits`
  (`queue-waits.ts`), with the words in `queueWait`. A new reason to pass over a run records a wait too, and a
  wait that can never end sets `endless`. An endless wait wins over whichever check passed the run over first:
  `found` asks `endlessWait` (an ended or self-waiting dependency, an ended batch, a claim a finished run holds)
  before it records a wait that can end, so full lanes or a busy Mac never hide it. A new endless reason is
  added to `endlessWait` too. A run whose runner is still unwinding keeps the wait it had. The
  existing notices stay as they were; the Board shows the wait only where there is no notice.

- A checked run (10db's own: `selfStarted` or `autoRerun`) of a project at its daily ceiling stays Queued with
  `queueWait.ceiling()` each tick, after the account checks and before the lane room check, and is named on the project's one
  ceiling card. A run the builder started is never looked at. It launches once the day's allowance rises (Carry On Today wakes
  the scheduler) or the local day changes. See `accounts/auto-ceiling.ts`.
- The missing-worktree and wrong-branch checks and the per-tick branch snapshot run for every queued batch that has a worktree, on any delivery, read from the batch; a pull-request project's shared batch is checked in the project folder as before. So a local project's separate copy never launches in Your folder.
