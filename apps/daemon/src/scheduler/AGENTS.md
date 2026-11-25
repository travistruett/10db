# apps/daemon/src/scheduler

- Every `continue` in `launchQueued` that passes over a queued run records why in `opts.waits`
  (`queue-waits.ts`), with the words in `queueWait`. A new reason to pass over a run records a wait too, and a
  wait that can never end sets `endless`. A run whose runner is still unwinding keeps the wait it had. The
  existing notices stay as they were; the Board shows the wait only where there is no notice.

- The missing-worktree and wrong-branch checks and the per-tick branch snapshot run for every queued batch that has a worktree, on any delivery, read from the batch; a pull-request project's shared batch is checked in the project folder as before. So a local project's separate copy never launches in Your folder.
