# D8: a pass's close fast-forwards the folder's branch to the pass's tip and returns the folder to it

- **Date:** 2026-11-09

## Decision

A close (`pass/close.ts`) runs, by recorded step (`passes.close_step`): 2 the pages set to Sign Off Now in the
plan's order, the placements, and every shared change kept (a change chosen Drop is passed over for its page's
take-out); 3 the batch `OPEN → SHIPPING` and, where the project allows copies, the gate in a scratch worktree
on the tip; 4 the other unfinished pages taken out inside the close; 5 the gate in the folder, where the project
gates there; 6 the push and the pull request made ready for review, never set to merge itself; 7 D8; 8 one write:
the batch `SHIPPED` and the pass `CLOSED`, or `SETTLED` on a `local` project or with no `origin`, after the
signed-off pages' kept refs go. Each write holds only while the pass is closing. A failed gate moves the batch
`SHIPPING → FAILED → OPEN` and the pass back to `OPEN`, and raises one card with no Retry: the next Close Pass
runs the gate again. While Your folder is off the pass's branch the close waits, and the pass's folder card says
so. A restart goes on from `close_step`.

D8 (`pass/fast-forward.ts`), each step checked first: a return branch checked out, rebased or bisected in
another worktree stops it; the return branch moves from the pass's start to its tip by compare-and-swap
(`moveBranchCas`); HEAD is pointed at it, writing no file; the folder's index is refreshed for the paths the pass
landed. A return branch that moved since the pass opened, or HEAD on the return branch away from the tip (the
builder's own switch), is never forced: the folder stays where it is and one card gives the command that merges
the pass's branch.

## Why

The design review's D8: the builder's app goes on showing every signed-off page after the close, and ordinary
folder tasks build on them. The fast-forward is always possible from the pass's start, because nothing else
commits in the folder while the pass holds it (W9); the compare-and-swap catches a hand-typed git that did. The
order puts the scratch gate before any take-out, so its failure undoes nothing (call 17). Turned down: the built
switch-back, which would take the work off the screen; and a forced move, which could drop the builder's commit.
