# The failure line reads whether a run was told of a revert from the run, and a left-out notice that names none overrides an old note

- **Date:** 2026-11-04
- **Amends:** decisions/2026-11-03-a-retried-left-out-run-counts-only-through-a-new-commit.md

## Decision

- `WorkstreamDto.revertTold` is true when a builder note among the run's evidence names a revert commit (the note a
  Retry or a joined start writes). `toDto` in `@10db/db` reads it; `revertCommitIn` in `@10db/contracts` is the one
  parser of the `Revert commit:` line.
- The desktop's failure line (`whatRetryDoes`) says Retry goes back to the build step, with the hedge "unless the
  run has committed since", for a run that holds no `left-out` notice and was told (`revertTold`) as well as for
  one that holds a `reverted-work` notice. A joined run holds no notice, and a wait can replace one, so the notice
  alone cannot say.
- `retryWorkstream` (`revertStillOn`) treats a `left-out` notice that names no revert (`nothingToRevert`) as the
  answer that the run has no revert on the branch. Ship without it wrote it after reading the branch (`prior`), so a
  note naming a revert that has since left the branch is not read. Only a revert the batch's open left-out card
  holds can apply. The run is no longer told of a revert the branch lacks, and gets no `reverted-work` notice.

## Why

Both rules were already how Retry behaved, except that the line read only the notice. The line must never promise
what Retry does not do. `revertStillOn` runs in a synchronous write and has no git, so it cannot ask the branch
itself; the notice that Ship without it wrote after asking is the stored answer. Reading the revert from git in
the desktop was not possible, and a `revertTold` flag is cheaper than copying the run's evidence into the DTO.
