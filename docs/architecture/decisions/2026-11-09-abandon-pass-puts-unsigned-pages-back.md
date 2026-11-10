# D23: Abandon Pass puts unsigned pages back, keeps their work, and always finishes

- **Date:** 2026-11-09
- **Amends:** the batch-delivery spec's Abandon

## Decision

A pass's Abandon (`pass/abandon.ts`, `POST /passes/:passId/abandon`) is its own sequence, not the built batch
Abandon, which refuses a pass's batch. It runs as a job under the project's delivery key and records each step in
`passes.abandon_step`, so a restart goes on from the next: 1 the pass is `ABANDONING`, so no message, take-out,
sign-off or close is taken; 2 a ship in flight is aborted; 3 every session of the pass is stopped, its last work
kept; 4 each shared change not landed is dropped; 5 each unsigned page is taken out by the take-out's own steps,
inside the Abandon, so its files go back to their state before the pass, earlier dirt included, and its work
stays with its task; 6 signed-off pages stay as landed; 7 the pass and its batch are `ABANDONED` in one write; 8
the folder's own index is refreshed for what step 5 wrote. Steps 2, 4 and 6 are recorded with nothing to do until
ships, shared changes and sign-off are built.

It always finishes: a file that keeps changing is left after three tries and named on its card with its page.
Where the folder ends is decided by the branch: if the pass's branch is still at `start_sha`, HEAD is pointed back
at the return branch, writing no file; otherwise it stays on the branch that holds the landed work, and one card
says so, offering Move to the return branch through the built switch, which keeps uncommitted changes and
refuses naming an overlapping file. A pull request the pass opened stays open, no longer watched. Nothing is
pushed or deleted.

## Why

An Abandon is the exit that must always work: a pass stuck in `ABANDONING` would hold the folder from the next
one. Putting unsigned pages back leaves no page file changed and unowned for an ordinary task to commit as its
own, and keeping their work with their tasks loses nothing.

Turned down: the built Abandon, which cancels every member and has no way out of `SHIPPING`; leaving the files
as they are, which strands unowned changes in the folder.
