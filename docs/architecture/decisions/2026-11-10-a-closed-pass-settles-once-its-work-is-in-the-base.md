# On a pull request project a closed pass holds Your folder until its work is in the base

- **Date:** 2026-11-10
- **Amends:** `decisions/2026-10-29-shared-checkout-switch-back.md`

## Decision

A pass closed on a pull request project is `CLOSED`, not `SETTLED`: D8 left the folder's branch ahead of
the base by the pass's work, so an ordinary task that would run in Your folder still runs in a copy or
waits, its notice "Waits for the Workbench pass's pull request to merge" (`PASS_PR_WAIT_LINE`). As it
closes, the pass gets one card, Move `<branch>` to `origin/<base>` (`delivery/pass-settle.ts`, fold
`pass-move:<pass>`). After each read of its pull request: merged with the fetched base's tree equal to the
pass's tip, the return branch moves to the base by compare-and-swap, only while it is at the tip, HEAD names
it and no other worktree uses it, and the pass settles with no file changed; drift, a CI fix or a close
unmerged reword the card instead. Move is the built switch (`Git.moveCheckedOutBranch`), refused while an
uncommitted change lies where it writes or the branch holds a commit on neither the base nor the pushed
branch (call 29); a move settles. While the pass is open its pull request is watched for merged and closed
only, with failing checks one header notice and no fix (`delivery/pass-watch.ts`). A `local` project settles
at the close.

## Why

Workbench spec §5.3, D22: an ordinary shared batch is cut from the fetched base with a clean checkout, so
cutting one before the merge takes the pass's work off the screen and builds on a base that lacks it.
Settling by itself only when no file changes keeps the builder's screen as it was; every other case is the
builder's call. Turned down: moving the branch at once after a merge whatever the trees (drops a CI fix or
drift from the screen without a word), and leaving the folder free at the close (the next cut takes the
work away).
