# A task that gives up a claim in a shared checkout keeps its uncommitted edits there

- **Date:** 2026-11-27
- **Amends:** `2026-11-20-a-session-leaves-another-writers-edits-uncommitted.md` (a session may leave
  paths in a copy another task shares, not only in the builder's own checkout)

## Decision

When a claim wait takes a claim another task held while it waited (the builder made that task yield
it to end a deadlock, cancelled it, or it let go), and the two tasks work in the same checkout (the
builder's own, or a copy several tasks share), 10db records each uncommitted path under the claim in
the new holder's `task_start_dirt` record with `handedBy` set to the task that held it, and its
fingerprint then. `claimedChanges` leaves such a path out while the file is as it was, so the new
holder is never sent back to commit it; once it changes the file, the path is its own. A path the
giver's record already counts as not the giver's (the checkout's dirt at its launch, or one a session
named) is not handed, and a path the giver was itself handed, untouched since, stays with the task that
made it. One task's two workstreams, separate checkouts and a Workbench pass's pages hand nothing.

The grant's `instruction` names the handed paths (the first 20, then a count) and the task that
left them. The deadlock card's yield answer says the yielder's uncommitted edits stay as they are,
remain its own, and are committed by it once it gets the claim back; the cancel answer says they stay
in its folder. The yield refusal tells the yielder the same.

`report_deviation` now leaves the named paths in a copy whose batch holds another task's workstream,
as in the builder's own checkout. When it leaves none of the paths named, its `instruction` says why:
a Workbench page answers for every change in its pass's areas, and a copy that is one task's alone
holds only that task's changes.

## Why

On Ampsio's copy 6, a task yielded area ingest to end a deadlock while its edits there were still
uncommitted. The task that took ingest was charged with them at every step end, sent back three times,
and failed on its retry limit. Its agent named the files in `report_deviation`, but 10db left
paths only in the builder's own checkout, so it answered an empty `leftUncommitted` and said nothing
about why.

Turned down: committing the yielder's edits at the yield, which lands half-done work under the wrong
task's name and can fail its hooks; stashing or parking them, which takes files out from under a
session that may still be running and is a git operation agents are kept away from.

Trade-off: a file the new holder wrote in the area before its grant, and left uncommitted, is credited
to the previous holder. The grant lists every handed path, so the agent commits the ones that are its
own. A yielder that never asks for the claim again leaves its handed edits uncommitted; a later change
can count them at its step's end.
