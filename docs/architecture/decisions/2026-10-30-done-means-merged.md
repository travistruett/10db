# A task is Done on the Board only once its pull request has merged

- **Date:** 2026-10-30
- **Amends:** `decisions/2026-10-29-sandbox-is-the-boundary.md` (CI decides: done means CI green and merged)

## Decision

- `BoardStatus` gains `in_review`, labeled In review, between In progress and Blocked. A task whose latest
  run shipped in a SHIPPED batch with a pull request is placed by that pull request's tracked state
  (`deriveBoardStatus`): open, not yet read, or unknown is In review; merged is Done; closed without merging
  is Blocked. A shipped batch with no pull request (local delivery) stays Done.
- A run marked failed that the builder shipped anyway is judged by its pull request in the same way, and
  once that pull request merges it counts as done for `dependenciesDone` and the dependency check
  in `delivery/deps.ts`, so the tasks that depend on it can start. Its task row keeps status `open`.
- The card says the pull request's state in one line (`Pull request open · checks passing`, `pending`,
  `failing: <check>`, `closed without merging`, `status unknown: <reason>`), with the link beside it. A task
  moves to Done within the watcher's polling interval of the merge, with no action in 10db.
- A task whose pull request closed without merging is in Blocked and the builder chooses: Reopen
  (`POST /tasks/:id/reopen`, status back to `open`, so the task is Ready or Backlog and can be started
  again; its earlier run and batch stay as history) or Close (`POST /tasks/:id/close`, now also accepted for
  such a task). Both are refused while the pull request is open or merged.
- A run shipped anyway is held to the same rule. Close (`closeTask`) is refused while its pull request is
  open or merged, and the Board offers it only once that pull request closed. Retry is never offered on a
  run whose batch shipped, since a shipped batch does not reopen. Its task is still `open`, so Reopen has
  nothing to change. Once the pull request closed, the task stays in Blocked, where the card and the drawer
  offer Start ("Start again" in the drawer) and Close. Start begins a new run, and the closed pull
  request becomes history.
- Passing the gate no longer raises a `review` card. Its only answer, accept, did nothing; the builder
  reviews the pull request, and In review shows the task until it merges. The `review` inbox kind stays
  in the contract for cards already stored. The forward-only data migration `0014_withdraw_review_cards`
  withdraws (state `CANCELLED`) every `review` card still open when a database upgrades, so none is left
  in the Inbox with only an answer that closes it. Answered ones stay as history.
- A dependent may start once its dependency is done, even while that pull request is still In review,
  as before; the cut holds its batch until the dependency's pull request merges (`unmergedDependencies`).
  A run shipped anyway counts only once its pull request merged. The card says "Waits on" by this same
  rule.

## Why

Done used to mean "a pull request exists", although its checks may fail and nobody may merge it. The
builder agreed that done means CI green and merged. The tracked pull request state already reaches the
desktop on `BatchDto.pr`, so the column is derived from it with no new stored state and no schema
change. The one migration only withdraws stored `review` cards: it runs once, before the daemon serves,
and the desktop refetches the Inbox when it reconnects.

Reopen is a new run of the task rather than a re-follow of the old pull request, because 10db does not
follow a pull request that GitHub reopens (`decisions/2026-10-29-pull-request-watch.md`).

An unknown pull request read stays in In review: the task is not known to be merged or closed, and the
card says the status is unknown.

Turned down: keeping the `review` card and adding Send Back. A task that passed its gate and shipped has
nothing left to send back to a session; changes the builder wants go on the pull request or in a new task.
