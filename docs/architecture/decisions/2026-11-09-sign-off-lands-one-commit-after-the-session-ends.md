# Sign Off ends the page's session, then lands its shared changes and its files, one commit each

- **Date:** 2026-11-09

## Decision

Signing off a Workbench page (`pass/sign-off.ts`; `POST /passes/:passId/tasks/:taskId/sign-off`, 202, and Sign
Off on the page's `check` item) is the pass's own route, not the built Approve, which needs a run with no
session; the built Approve and Send Back stay refused for a page, so no attempt is ever spent on one. It runs as
a job under the project's delivery key, and each run checks the pass and the page again and reruns step 0, so a
job queued behind others, taken up again after a wait or rerun after a restart acts on the rows as they are.

0. The page's session ends through the runner (`stopPassLane`) and its turn's work and holds are kept. When a
   hold the page needs (`sharedNeeded`) is still open in another page's turn, the sign-off waits: a
   `pass_sign_offs` row, and the job ends. A closed hold (its `pass.changed`), start-up and the row's own rerun
   take it up again; a message to the page, its take-out, an Abandon, Close Pass and `DELETE .../sign-off` end
   the row. While it waits, a `request_claim` of the held page's turn for a claim the signing page holds is
   answered at once, refused, so neither page waits on the other.
1. The builder's hand edits fold into the page's kept work.
2. The shared changes the page needs land in number order (`landSharedChanges`), each its own commit; a change
   of a page still open that lands early says so on that page's thread.
3. The page's files and the files under hazards it holds land from its kept commit as one commit
   (`Git.landPaths`): the task's title, each turn's first line as the body, a `10db-task` trailer and an
   operation id of the run and the kept commit it lands (so a sign-off after the next turn of a run whose
   landing never finished lands that turn's files, and a rerun finds its own commit), signed as the project's config asks. A page with nothing to land lands no commit, and
   its thread says "Signed off · nothing to land".
4. The folder's own index follows for those paths; when another git held it, the thread says so (spec §18).
5. One write resolves the item, answers the turn, deletes the wait, and takes the run to DONE by edges that
   exist (`signOffPath`: WAITING_HUMAN through VERIFYING; QUEUED through STARTING and VERIFYING; HELD,
   PAUSED_LIMIT and RECOVERING through QUEUED first), which releases the page. A run that cannot follow step 0
   (RUNNING, HANDING_OFF, TAKEN_OVER) is refused and nothing is written.

A close's Sign Off Now takes the same steps for a page in any state; every turn of the pass has stopped by then,
so a hold the page needs is kept rather than waited for.

## Why

The spec's §9.2 and D17: a commit must not race an agent that could still write, and a page's commit must follow
the shared changes it was built with, so the branch only ever holds states the folder was in. Every commit
carries an operation id, so a crash between a commit and the write is recovered by finding it, never by making it
again. Turned down: landing through the built approval with the session still warm (it throws), and a sign-off
that holds the delivery key while it waits for another turn (it would hold every take-out and close of the
project too). The commit message is the spec's call 10: the title and what each turn said it did.
