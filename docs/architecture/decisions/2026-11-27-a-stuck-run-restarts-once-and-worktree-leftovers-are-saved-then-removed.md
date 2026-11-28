# A stuck run restarts once, and worktree leftovers are saved and then removed

- **Date:** 2026-11-27
- **Amends:** `decisions/2026-11-17-hand-made-worktrees-are-offered-for-removal-and-kept-out-of-spotlight.md`
  (a merged hand-made worktree is removed by a rule; the card is raised only when the rule is set to ask)

## Decision

Designed, not built; the plan is `docs/superpowers/plans/2026-11-27-stuck-run-restart-and-worktree-leftovers.md`.

- An active run (starting, running or verifying) that the watchdog finds stuck is stopped and requeued once from
  its latest handoff, keeping its claims, with no card. The restart spends one of the run's recovery attempts.
  Queued runs and batches that are stuck keep the Stuck card.
- The stop has 2 minutes. A stop that takes longer is itself a stall and raises the card; the runner stops a run
  once at a time, whether the watchdog or a card's answer asked.
- A second stall of the same step, or a first one with no recovery attempt left, always raises the Out of Moves
  card, which says which it was. When 10db's own part stalled (the run never
  started, it has no lane, its gate ran past its limit, or its stop hung), a defect task is filed in 10db's
  project first, by the signature `stall:<fault>:<state>`, and the card names it. The spec's "unless the diagnosis
  names a 10db defect" is met this way, not by filing the defect and staying silent.
- A hand-made worktree is removed when its pull request merged, the branch holds nothing the pull request lacks,
  it is unlocked and clean, nothing in its git admin files, root or top-level entries changed for 24 hours, and no
  process has its working directory there. The branch is never deleted. Its ignored files that are not build
  output and have no identical copy in the checkout (a hand-made `.env`) are saved to the kept folder first, as
  below. The Activity row's Undo makes the worktree again from the branch, copies those files back, and refuses
  when the path is taken or the branch is gone.
- Only the rule removes a worktree that holds such a file, because only it saves first. The merged card (raised
  when the rule is set to ask) and its Remove answer still leave such a worktree out, as before.
- A finished 10db worktree's files that have no identical copy in the project's checkout and that no tool writes
  again are copied to `~/.10db/kept/<name>/<time>/` (folders 0700, each file's mode kept, links kept as links),
  each copy checked by size and SHA-256, and only then is the worktree removed. A failed copy removes nothing and
  raises today's card. 10db does not prune the kept folder.
- Each restart, save and removal is an Activity row under the rules `stuck-run`, `worktree-leftovers` and
  `merged-worktree`. Ask Me Next Time brings back the card.

## Why

- All 30 Stuck cards in the spec's 7-day count moved again by themselves, and a restart loses nothing: committed
  work, the handoff and the claims stay. So a rule decides it.
- A stuck run holds a lane, its claims and sometimes a gate slot. Waiting for a defect fix with no card would hold
  them for days with nothing in the Inbox, so the builder is told at once and the defect is the report.
- The stop is bounded because a stop is where a stuck run is most likely to hang, and an unbounded one would leave
  a stall that ends in neither a notice nor a card.
- Removing a hand-made worktree was a one-way door only because of what it might alone hold. With the branch kept,
  the only-here files saved and an Undo that re-adds it, it is two-way, so it needs no card (48 in the count).
- Size and hash are checked before removal because the copy is the only thing standing between a hand-made `.env`
  and its loss.
- "Idle" reads a handful of files, not the tree: walking every `node_modules` of every worktree four times a day
  is the load the removal exists to end. "Clean" already catches an edit the mtimes miss.
- Turned down: a second automatic restart (the same stall twice is not a hiccup); waiting on the defect fix before
  any card (holds the lane silently); an Undo that re-makes a 10db-made worktree (its batch is finished, and the
  files are in the kept folder); saving uncommitted changes as a patch (the files themselves need no tool to read).
