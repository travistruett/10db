# A batch's gates run in turn, and only files at paths the base adds stop its merge

- **Date:** 2026-10-29
- **Amends:** `decisions/2026-10-29-gate-with-base.md`

## Decision

- **One gate of a batch at a time.** The verify gates of a batch's tasks and its shipping gate share the
  batch's checkout, so they run in turn whatever the number of gate slots: `BaseUpdates.gate` serializes them
  per batch, and the runner and the shipper share the daemon's one `BaseUpdates`. A gate waits for its batch's
  turn before it asks for a slot, so a waiting gate holds none. Gates of other batches run beside it, up to the
  slots. Only then does "no other gate's merge changes the tree under a running gate" hold at more than one
  slot.
- **The base update's time is the slot's.** The fetch, the merge and the install before a gate run inside its
  slot (`beforeStart`), so every gate waiting for a slot waits for them too. None of it counts against the
  gate's own timeout, which starts when its command does: the fetch has the network timeout and the install
  the install's.
- **Only files at paths the base adds stop the merge.** Besides uncommitted changes and untracked files git
  reports at paths the merge writes, the merge is stopped by anything git doesn't track at a path the base adds
  (an ignored file, a link, or a directory holding anything untracked, shown with its `/`), and by a
  non-directory where an added path needs a directory. A path the merge itself deletes is git's to replace. An
  ignored file under a directory the base only adds to (a build directory, a seeded `node_modules` beside a
  newly tracked `package.json`) stops nothing.
- **Files git doesn't track in the way are the builder's to judge.** They raise one card per batch, folded by
  `base-kept:<batch id>`, naming them and the worktree, withdrawn with the conflict card once the branch holds
  the base. The gate's note tells a fix session not to remove or move them.
- **A task's kept start goes with its worktree.** Retiring a batch's worktree deletes `refs/10db/starts/<id>`
  for every workstream it ever held, and the startup sweep deletes any whose workstream is gone or whose batch
  no longer has a worktree.
- **A merge whose base can't be recorded still counts.** When moving the batch's base or a task's start fails
  after the branch took the base, the note says the branch holds the base but its base did not move, and the
  install still runs.

## Why

Serializing only the base updates would still let one gate of a batch merge under another that is running.
Serializing a batch's gates is a lock keyed by batch around the gate it already runs, and a batch's gates write
the same files, so running two at once could never be trusted anyway.

Listing every ignored entry with `--directory` blocked every base that added a file anywhere under a directory
holding ignored files: a seeded `node_modules` makes its package directory one, so a base adding that package's
`package.json` could never merge. `read-tree -m -u` only overwrites or removes what is at a path it writes, so
those paths, and the parents it must create, are the only ones to look at.
