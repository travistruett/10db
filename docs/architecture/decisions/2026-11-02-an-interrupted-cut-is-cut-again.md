# A batch whose cut a restart cut short is cut again by startup

- **Date:** 2026-11-02
- **Amends:** `decisions/2026-10-30-cards-close-when-their-cause-is-gone.md` (what recovery does with a `CUTTING` row)

## Decision

- **Startup cuts the same row again.** `recoverBatches` step 1 removes what the interrupted cut left in git (a
  worktree at the path), then, instead of deleting the `CUTTING` row, asks the starter to cut it again
  (`BatchStarter.recut`). The row, its id and its tasks' `QUEUED` workstreams stay as they are, so the tasks keep
  their place in line, and no card is raised. The cut is queued on the same delivery job as a first cut, so a
  refusal of a git or gh check raises its "Batch not started" card with the reason, as before.
- **When the row is deleted instead.** Startup still deletes the row, cancels its workstreams and raises the
  "10db stopped while cutting" card when something is left that only a person can settle: a directory with files
  at the worktree path (its own card), a local `10db/` branch with commits origin's base lacks or one checked out
  elsewhere, a shared checkout already switched onto the batch's branch (where it came from is lost), a row with
  no workstreams (an earlier daemon's), or git failing to read any of these. A leftover branch that is an ancestor
  of origin's base has nothing on it and is deleted so the cut can make it again under the same name.
- **A fix batch is never repeated as a plain start.** A CI fix batch cut again keeps `ciFixOf`, `ciFixHead` and
  the pull request's branch, so it is cut on that branch as a fix and the row stays the guard against a second
  fix for the pull request. When startup deletes one, it stops fixing the pull request (`ci_stopped = no_cut`),
  as a refused cut does, and the card offers Cancel task alone: the pull request's CI-stop card has the Retry.

## Why

A restart is the only thing wrong with such a batch, and an unattended machine (a CI fix started overnight)
waited for a person to press Retry. Cutting the same row keeps the work's identity and place without a second
code path for ordering. The card's Retry start used to start the fix task as a plain batch from main while 10db
cut a proper fix for the same pull request; with no Retry on a fix batch's card, and the row never deleted
without stopping the fix, a pull request has one fix at a time.
