# The failure line reads whether a run was told of a revert from the run, and a left-out notice that names none overrides an old note

- **Date:** 2026-11-04
- **Amends:** decisions/2026-11-03-a-retried-left-out-run-counts-only-through-a-new-commit.md

## Decision

- `WorkstreamDto.revertTold` is true when a builder note among the run's evidence names a revert commit (the note a
  Retry or a joined start writes) and that revert still stands. `toDto` in `@10db/db` reads it; `revertCommitIn` and
  `lastRevertTold` in `@10db/contracts` are the one parser of the `Revert commit:` line and of the notes.
- The desktop's failure line (`whatRetryDoes`) says Retry goes back to the build step, with the hedge "unless the
  run has committed since", for a run that holds no `left-out` notice and was told (`revertTold`) as well as for
  one that holds a `reverted-work` notice. A joined run holds no notice, and a wait can replace one, so the notice
  alone cannot say.
- A `left-out` notice that names no revert (`nothingToRevert`) is the answer that the run has no revert on the
  branch. Ship without it wrote it after reading the branch (`prior`), so a note naming a revert that has since left
  the branch is not read. `revertOfRun` returns null for such a run, so Retry, a joined start, the commit tool and
  the pull request all read the same answer, and `revertTold` is false. Only a revert the batch's open left-out card
  holds can apply: Retry then tells of that one.
- The Retry that clears that notice writes a `no_revert` evidence row (`EvidenceKind.NoRevert`), so the answer
  outlives the notice. `lastRevertTold` reads the notes oldest first and a `no_revert` row sets it back to none, so a
  later Retry, `actionEntering` and `revertTold` find no revert, and a later revert or note still overrides it.
  It is a row of its own kind rather than a builder note because a builder note is a fix a session is given.
- A task's runs are read through `revertOfRuns`: a later run that says none stands clears an older run's revert, so
  a start joining the batch is not told of it.
- That Retry drops a kept fix (`nextAction`) that is a note naming a revert, so the restarted session is not handed
  the old note. A kept gate failure stays.

## Limits

- The old notes stay in the run's evidence, and a session that continues from a handoff may read of the revert there:
  the handoff is its own words, and 10db does not rewrite it.
- A builder's own text in a dropped fix goes with it, when they wrote it in the same note as the revert.
- The answer is what Ship without it last read. A revert that leaves the branch after that answer (a history
  rewrite outside 10db) is not noticed until the next one, as before: Retry has no git.

## Why

Both rules were already how Retry behaved, except that the line read only the notice. The line must never promise
what Retry does not do. `revertStillOn` runs in a synchronous write and has no git, so it cannot ask the branch
itself; the notice that Ship without it wrote after asking is the stored answer.

Reading the revert from git in the desktop was not possible, and a `revertTold` flag is cheaper than copying the
run's evidence into the DTO.

The notice alone was not enough: Retry clears it, while the notes it overrides stay, so a second Retry, the step
entered after a plan, and a joined start would all read the gone revert again. An evidence row takes its place
without a migration, and it sits in the same oldest-first walk every reader of the notes already does, so its order
against later notes needs no timestamp comparison. A workstream column was rejected for those reasons.
