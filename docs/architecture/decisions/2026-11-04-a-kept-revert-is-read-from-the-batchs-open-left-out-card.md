# A revert Ship without it left on the branch is read from the batch's open left-out card by Retry and by any other answer

- **Date:** 2026-11-04

## Decision

When Ship without it commits a revert and the write of its notices fails, the revert's id is on the batch's
open left-out card (`batchCard.revert`, with `batchCard.titles` naming the tasks the revert covers, or
`leftOutKept` while a ship runs). Two paths that do not hold that card's detail read it from there
(`keptRevertOf`, `delivery/left-out-settle.ts`):

- **Retry.** `starter.retry` passes the revert to `retryWorkstream` when the run is the one the card was
  answered on or its task is named in `titles` (`coversRun`). `retryWorkstream` uses it only for a run with no
  record of a revert of its own, and then writes the same `reverted-work` notice and builder note as a retry of
  a run that was left out, so the session is told its commits are gone.
- **Ship without it answered on another failed card.** `leaveOut` takes the revert the answered card names, and
  without one the revert on the batch's left-out card. Its commits are skipped, not reverted again, and the
  card a later stop raises keeps naming it, so the card that folds over the holder does not lose it.

Nothing is written to the run or batch: the database was not writable when the revert was made, and the card is
the one record that already exists.

## Why

- Recording the revert on the run or batch needs a write that may be the very one that failed, and a schema
  change; the card already carries it and is already withdrawn when the batch ships or is abandoned.
- Retry stays synchronous, so it cannot ask git whether the revert is still on the branch. A revert the
  builder removed by hand is therefore still told to the session; the session's `git show` of it then fails and
  it redoes the work, which is the safe direction. `leaveOut` does check the branch (`standing`).
- A task whose title the card does not name is not told: its commits are not in the revert.

Known limit: two tasks with the same title in one batch are not told apart.
