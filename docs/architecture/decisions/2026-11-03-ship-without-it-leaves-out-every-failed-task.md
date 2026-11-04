# Ship without it leaves out every failed task of the batch

- **Date:** 2026-11-03

## Decision

Ship without it, answered on one failed member's card, reverts the commits of every member that failed in the
batch, in one commit that names them all (`revert: leave out "Alpha", "Beta"`), and ships the finished tasks.
The option's text says so. Each failed run gets its own `left-out` notice, and the other runs' failed cards
close in the write that moves the batch to `SHIPPING`.

A task's commits are those of every run of that task in the batch, so a failed merge run takes the task's
earlier work with it. A revert that would put conflict markers back ships nothing and raises the same kind of
card as a conflict.

A run that is left out stays `FAILED` and no longer holds the batch up. Only a `FAILED` run counts as left out,
and Retry clears the notice in the write that queues the run.

## Why

A failed task's commits passed no gate or review, and on a shared branch they sit beside the finished work. If
Ship without it reverted only the run it was answered on, a second failed task's rejected commits would go in
the pull request, which is the incident this choice exists to stop (batch `bat_01a1a2df`, pull request #468).

Refusing while another member is failed was turned down. Each failed card would refuse because of the other,
so a batch with two failed tasks could not ship its finished work without hand-written reverts, and the
builder would reach for Ship anyway, which includes the commits. Reverting on one answer loses nothing: the
commits stay in the branch's history, and the task runs again from a new start. A builder who wants the other
task's work retries it first, and Ship without it is refused while that run is unfinished.

One revert commit for all of them keeps a stopped revert simple: `Git.revertCommits` writes nothing until the
whole result is known, so a conflict in the second task never leaves the first task's revert on the branch.
