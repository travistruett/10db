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
  then, in one write, records the task with no kept work (`kept_work_sha` and `kept_base_sha` null) and marks its
  take-out row `discarded`. The refs go before the row, so a restart between the two deletes nothing more and
  writes the same row; nothing after the put-back reads the deleted commit, which git may prune, and step 8
  refreshes the index only for the files of commits still there. This holds with Your
  folder off the pass's branch too: the files the builder took along are the only copy left. A take-out asked for
  alone and one inside a close keep the work at `refs/10db/kept/<task id>` as before.
- **A task the pass made leaves the Board.** A task the pass made for one of its pages (`tasks.made_by_pass_id`)
  is retired in that same write by `retireTaskUnconditionally`: cancelled, its parked column cleared, its Shape
  questions detached, its dependency edges deleted both ways. It never refuses, so an Abandon still always
  finishes. A task in the pass with no run has no take-out: step 5 deletes its kept refs and leaves it the same
  way, retired if the pass made it, else open on the Board with no saved work.
- **A task that joined from the Board goes back to it** open, with no pass and no saved work, and its thread says
  "Abandoned with <pass name>; its changes were deleted." It loses saved work from an earlier pass that it
  carried in, not only this pass's changes.
- **The confirm and the card say so**, by page label: "Discards: Billing, People (their changes are deleted).
  Stays: Settings (signed off)." The Abandon's card, when it is raised, carries the same sentence, naming only
  the pages whose take-out row is `discarded`: a page taken out before the Abandon keeps its work and is not
  named.
- Board Remove, and the builder's `remove_task` tool (`removeTaskFromBoard`), also remove a task whose every run
  is `CANCELLED` and that has no pass and no saved work, since nothing of it is left to lose. Every other refusal
  of Remove holds: a task not open, an open task waiting on it, a batch being cut. The Board offers Remove for
  such a task. Only the Abandon's retire never refuses.

## Why

The builder abandons a pass to be rid of it. Keeping each page's work with its task left saved work on Board tasks
the builder never made ("Settings: UI work"), which a later pass put back without being asked. Deleting it, and
removing the tasks the pass made, leaves nothing behind; the confirm names every page it discards first, and
signed-off work is never touched. Take Out stays the way to set a page aside with its work.

Turned down: keeping a joined task's earlier saved work while deleting only this pass's changes. Its put-back
wrote that work into the pass's files, where the next keep folds it into this pass's kept commit; the files the
put-back recorded as not going back exist only at `refs/10db/kept/<task id>`, and the Abandon deletes those too.
Telling the earlier work apart would need a second record per task for a case the confirm names anyway.
