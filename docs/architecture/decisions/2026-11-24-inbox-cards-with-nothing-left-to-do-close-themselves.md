# Inbox cards with nothing left to do close themselves

- **Date:** 2026-11-24
- **Amends:** `decisions/2026-10-30-cards-close-when-their-cause-is-gone.md`

## Decision

- **Write outside every claim.** The watcher's `resolveSettledStrays` resolves each open stray-write card
  whose checkout is gone, whose paths are committed and clean (`changedPaths` for the card's paths; for a bulk
  card that lists fewer than it counts, the whole checkout), or that no unfinished workstream could own (the
  workstreams it names, else any of its project's). A path that can change what runs (a sensitive path) is
  closed only when its checkout is gone: its card is a trust decision, whatever its workstream did. It runs at
  start and when a run ends.
- **Skipped while you were away.** `closeFinishedSkippedCards` resolves each open card carrying
  `detail.skippedRun` whose task is done or cancelled, at start and on every task status change.
- **Merged worktrees.** `closeGoneMergedWorktreeCards` resolves a merged-worktrees card none of whose
  worktrees exists on disk, at start and at each look at the hand-made folders. The card now carries its paths
  in `detail.paths`; an older card's are read from its body, and one whose list was cut stays.
- **One card for a failed run.** A failed run's skipped calls, config and "Run these now" go on its open
  "Workstream failed" card (`raiseSkippedCard`); only a failed run with no such card gets the skipped card of
  its own.
- **Update failed.** A successful install (`SelfUpdate.settle`) resolves every open update-failed card,
  whichever build it was raised for; `closeInstalled` still handles a card whose build GitHub says is behind.

## Why

- On 2026-11-24 115 of 125 open cards had nothing left to do: 54 stray writes of finished tasks, 26 skipped
  items of tasks that had finished, 31 merged-worktree offers for worktrees already gone, and an update-failed
  card that outlived later installs. Each was a card the builder had to dismiss by hand.
- A failed run raised two cards for one event, so the builder read the failure twice.
- Every closer runs at start so an existing backlog clears without the builder.
- Each closer has one test through the real watcher, delivery or self-update code, because a card that
  closes wrongly hides a trust decision or a failure from the builder.
- Sensitive paths keep their card because "nothing could own it" does not make an edited hook, config or
  `.env` safe.
