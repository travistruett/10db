# A turn's work is kept at a ref; a take-out keeps it and puts the page back in six recorded steps

- **Date:** 2026-11-09
- **Amends:** `decisions/2026-10-29-shared-checkout-switch-back.md`

## Decision

At the end of each turn of a pass page, the task's page files as they are on disk are kept as an unsigned commit
on the pass branch's tip at `refs/10db/passes/<pass id>/<task id>`, by compare-and-swap under the repo lock, with
a trailer naming the turn so a rerun finds it (`Git.keepWork`, `pass/kept-work.ts`). No file, index, HEAD or branch
moves. A page file is one under a page area the task holds; a hazard or another held area counts only outside the
pass's pages, as the guard's judge reads a pass. A link is kept as a link; a path beyond a link or a file is gone.
The commit tool of a pass lane keeps the named page paths the same way and never moves the branch.

A take-out (`pass/take-out.ts`) runs as a job under the project's delivery key and records each step on its
`pass_take_outs` row: 0 the lane is stopped; 1 hand edits are folded; 2 a last kept commit; 3 the page's files on
disk are hashed against it, 1 to 3 running up to three times (a take-out asked for alone then stops, the task
staying in the pass; inside an Abandon or a close the files are left and it goes on); 4 each page file is put back
as the pass's branch has it where something landed on it, else as it was before the pass, hashed again just
before it is written, a directory or a link in the way left; 5 one write cancels the run from any unfinished
state, releases its claims, takes the task out of the pass for the Board and records its kept work, which moves
to `refs/10db/kept/<task id>`. Sign-off landing one commit is designed (Workbench spec §9.2).

## Why

The builder's folder is the pass's working copy; committing per turn would fill the pass's branch with
half-done turns and move it under the builder's editor. A ref per task keeps each page's work apart and
survives a restart. Recording each step lets a restart go on without writing a file twice or losing one.

Turned down: stashes, which are one shared stack and lose ignored-file safety; committing to the pass's branch.
