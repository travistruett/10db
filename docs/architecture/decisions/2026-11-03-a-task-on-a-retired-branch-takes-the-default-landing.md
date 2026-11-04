# A task that lands on a branch gone from origin takes its project's default landing at startup

- **Date:** 2026-11-03
- **Amends:** `2026-10-29-where-a-pull-request-lands.md` (a task's landing is editable only until it has a workstream)

## Decision

- **At every daemon start**, after recovery, `moveRetiredLandings` (`delivery/retired-landings.ts`) looks at each
  pull-request project's open tasks whose landing is `{ kind: branch }` on a branch other than the project's base.
  For each such branch it asks origin once (`Git.branchOnOrigin`). A branch origin answers is missing, that no
  unfinished batch (`UNFINISHED_BATCH_STATES`) is based on, moves its tasks, started or not, to the landing the
  project gives a new task now (`taskLandingFor`), through `resetTaskLanding` in `@10db/db`, which `patchTask`'s
  "already started" refusal does not apply to. Running it again finds nothing.
- **It moves only on a clear answer.** An origin that can't be asked (offline, a timeout, a signal that aborts) leaves
  every task of that branch as it was and logs a warning; the next start tries again. A project whose own default
  names the same missing branch, or another branch origin lacks, moves nothing, since the task would only go from one
  dead branch to another. Finished and removed tasks, and local-delivery projects, are not touched.
- **A card says which tasks moved**, one per project per start: the Inbox flag "N tasks moved off `next`, which no
  longer exists", listing each task's title and id and where it lands now. It is a card, not a notice, because a task
  that never started has no run or batch to hold a notice (`2026-10-31-notices-not-cards.md`, "Start refusals"); the
  builder only reads and dismisses it.
- **It runs beside the start, not before it.** The daemon doesn't wait for origin: the pass is a background promise that
  shutdown aborts and awaits.

## Why

Main takes pull requests directly now, but tasks made while `next` was the integration branch kept
`{ kind: branch, branch: next }`. Joining one to a batch that merges into main is refused ("merges into main … but …
merges into next"), and once a task has started its landing can't be edited, so three tasks had to be copied by hand
on 2026-11-03. A one-off fix at start, keyed on origin and on batches, covers every project and every retired branch
without naming `next`.

Turned down: a SQL migration (it can't ask origin, and a branch that exists today must stay); loosening `patchTask` for
started tasks (the builder's edit of a started task's landing is still wrong once its batch exists); moving a task
whose batch is still based on the branch (its pull request targets it).
