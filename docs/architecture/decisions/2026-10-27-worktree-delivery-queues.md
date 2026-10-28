# A worktree project runs delivery jobs in two queues, and reopens through one path

- **Date:** 2026-10-27

## Decision

Delivery jobs of a worktree project run in two queues, keyed `<project id>:cut` and `<project id>:ship`, each
one job at a time: the cut queue takes cuts, joins and reopens, the ship queue takes ships, Abandon's cleanup
and removals. A shared project keeps its single queue, keyed by its id (`delivery/jobs.ts`). Lanes run in
parallel.

A `FAILED` worktree batch is reopened by one path, `reopenWorktreeBatch`, a cut-queue job that makes the
worktree whole and then moves `FAILED -> OPEN`. The strip's Retry with unfinished work, a fix-task join and a
workstream Retry all use it; a workstream Retry leaves the batch `FAILED` and re-queues only the workstream,
and work waits (the launch rule needs `OPEN`) until the reopen lands.

## Why

A cut must not wait behind a 30-minute shipping gate, while three gates at once overload one machine. The
shared cut switches the checkout a ship reads, so a shared project keeps one queue. Parallel ships can come
later behind a limit. One reopen path means the launch rule never sees a missing worktree.
