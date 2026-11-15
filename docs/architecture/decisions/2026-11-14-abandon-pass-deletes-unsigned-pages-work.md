# Abandon Pass deletes the unsigned pages' work and removes the tasks the pass made

- **Date:** 2026-11-14
- **Supersedes:** `decisions/2026-11-09-abandon-pass-puts-unsigned-pages-back.md`
- **Amends:** `decisions/2026-11-09-a-turns-work-is-kept-at-a-ref.md`, for a take-out inside an Abandon

## Decision

Abandon Pass keeps the eight recorded steps, the take-outs inside it and every rule for finishing that
`decisions/2026-11-09-abandon-pass-puts-unsigned-pages-back.md` set: each unsigned page's files still go back to
their state before the pass, earlier dirt included, and signed-off pages stay as landed. What changes is what
becomes of the unsigned pages' work and tasks.

- **The work is deleted, not kept.** Inside an Abandon, a take-out's step 5 deletes the pass's kept ref for the
  page (`refs/10db/passes/<pass id>/<task id>`) and any `refs/10db/kept/<task id>` the task carried into the pass,
  then, in one write, records the task with no kept work (`kept_work_sha` and `kept_base_sha` null). The refs go
  before the row, so a restart between the two deletes nothing more and writes the same row. This holds with Your
  folder off the pass's branch too: the files the builder took along are the only copy left. A take-out asked for
  alone and one inside a close keep the work at `refs/10db/kept/<task id>` as before.
- **A task the pass made leaves the Board.** A task the pass made for one of its pages (`tasks.made_by_pass_id`)
  is retired in that same write by `retireTaskUnconditionally`: cancelled, its parked column cleared, its Shape
  questions detached, its dependency edges deleted both ways. It never refuses, so an Abandon still always
  finishes. A page task with no run is retired the same way at step 5.
- **A task that joined from the Board goes back to it** open, with no pass and no saved work, and its thread says
  "Abandoned with <pass name>; its changes were deleted." It loses saved work from an earlier pass that it
  carried in, not only this pass's changes.
- **The confirm and the card say so**, by page label: "Discards: Billing, People (their changes are deleted).
  Stays: Settings (signed off)." The Abandon's card, when it is raised, carries the same sentence.
- Board Remove retires, by `retireTaskUnconditionally`, a task whose every run is `CANCELLED` and that has no pass and no
  saved work, since nothing of it is left to lose.

## Why

The builder abandons a pass to be rid of it. Keeping each page's work with its task left saved work on Board tasks
the builder never made ("Settings: UI work"), which a later pass put back without being asked. Deleting it, and
removing the tasks the pass made, leaves nothing behind; the confirm names every page it discards first, and
signed-off work is never touched. Take Out stays the way to set a page aside with its work.

Turned down: keeping a joined task's earlier saved work while deleting only this pass's changes. Its put-back
already wrote that work into the pass's files, so the two are one kept commit by the time the pass is abandoned,
and telling them apart would need a second record per task for a case the confirm names anyway.
