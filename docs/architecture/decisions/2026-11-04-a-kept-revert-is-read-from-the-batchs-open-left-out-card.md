# A revert Ship without it left on the branch is read from the batch's open left-out card by Retry and by any other answer

- **Date:** 2026-11-04

## Decision

When Ship without it commits a revert and the write of its notices fails, the revert's id is on the batch's
open left-out card (`batchCard.revert`, or `leftOutKept` while a ship runs), with `covers`: the runs whose
commits are undone there. An answer that made a revert sets `covers` to each failed run with commits undone on
the branch, including commits an earlier revert undid. An answer that makes no revert keeps it unchanged, so a
stop on a run the revert does not cover names that run in `workstreamId` and `titles` without saying its commits
are gone. The one exception is an answer on a card with no revert that finds, on the branch, a revert no run's
record names: its stop card takes that revert, with the runs it undid as `covers`
(`decisions/2026-11-04-what-a-left-out-revert-undid-is-read-from-the-branch.md`). A revert no longer on the branch
covers nothing.

Two paths that do not hold that card's detail read it from there (`keptRevertOf`,
`delivery/left-out-settle.ts`):

- **Retry.** `starter.retry` passes the revert to `retryWorkstream` when `covers` names the run.
  `retryWorkstream` tells the run of it unless the run has a left-out notice, which already names its revert, or
  was told of this same revert, when the usual check holds: a commit since the note means the work is back. It
  writes the same `reverted-work` notice and builder note as a retry of a run that was left out, so the session
  is told its commits are gone and the pull request reads the newer revert.
- **Ship without it answered on another failed card.** `leaveOut` takes the revert the answered card names, and
  without one the revert on the batch's left-out card, so the card a later stop raises keeps naming it and the
  card that folds over the holder does not lose it. Which commits to skip is no longer read from this card:
  that part is superseded by `decisions/2026-11-04-what-a-left-out-revert-undid-is-read-from-the-branch.md`.

The answer that writes the notices closes the left-out card in the same write. The notices hold the revert from
then on, and a card left open until the batch shipped could name an older revert than a run's own record.

Nothing is written to the run or batch: the database was not writable when the revert was made, and the card is
the one record that already exists.

## Why

- Recording the revert on the run or batch needs a write that may be the very one that failed, and a schema
  change; the card already carries it and is already withdrawn when the batch ships or is abandoned.
- Retry stays synchronous, so it cannot ask git whether the revert is still on the branch. A revert the
  builder removed by hand is therefore still told to the session; the session's `git show` of it then fails and
  it redoes the work, which is the safe direction. `leaveOut` does check the branch (`standing`).
- Runs, not titles: a task's title says what an answer tried, not whose commits went. Titles named a run whose
  own revert stopped, a failed run with no commits, and a run started over in the batch.
- A run `covers` does not name is not told: its commits are not in the revert.

Known limit: a card with a revert raised before `covers` existed covers no run, so Retry tells no one from it, as
before this change. Ship without it still skips the commits that revert undid, because that reads the branch.
