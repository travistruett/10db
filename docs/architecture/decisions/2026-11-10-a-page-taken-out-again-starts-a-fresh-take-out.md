# A page taken out of the same pass again starts a fresh take-out row

- **Date:** 2026-11-10
- **Amends:** `decisions/2026-11-09-a-taken-out-tasks-workstream-is-cancelled.md`

## Decision

A task keeps one `pass_take_outs` row per pass, and that row describes its latest take-out from the pass. When
Add Page puts a taken-out task back into the same pass and the builder, a close or an Abandon takes it out
again, `insertTakeOut` deletes the finished row and writes a fresh one in the same write. While the task's
take-out has not finished, a second one is refused (`ConflictError`); the unfinished one goes on from its own
row, as before. A fresh take-out asked for alone that stops before it finishes (its stop or keep failed, or the
page's files kept changing) deletes its own row and writes the finished one it replaced back
(`deleteTakeOut(ctx, key, replaced)`), so the page stays in the pass with the row its put-back reads. Start-up puts back the saved work of a task the pass holds unless its take-out from this pass
is unfinished. A finished take-out from this pass no longer stops that, so a page added back whose put-back the
daemon cut short gets its work back.

## Why

Each later step reads the finished row only for the latest take-out. The next put-back compares each file with
what that take-out left in the folder. An Abandon names the files it left and refreshes the index for the files
it wrote. The task's saved work is not on the row: it stays on the task (`tasks.kept_work_sha`), and a later
take-out never writes over it. So once the put-back has run, the row of the earlier take-out holds nothing
anything still needs. Before this change, the second take-out failed on the table's primary key. The Take Out
route answered 500, a close stopped with SQLite's text, and an Abandon stayed `ABANDONING` across restarts,
breaking spec §5.4's "an Abandon always finishes".

Turned down: a sequence number in the key, keeping every take-out. Nothing reads the earlier rows, and an
Abandon reading them would name again files that a later take-out had already handled. Also turned down:
deleting the row when the task rejoins. The join's put-back, and its rerun at start-up, read that row to know
how the take-out left each file.
