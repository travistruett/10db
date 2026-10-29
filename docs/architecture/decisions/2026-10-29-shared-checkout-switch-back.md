# In Your folder mode, 10db switches the checkout back when a batch ends, only when it is clean and still on the batch's branch

- **Date:** 2026-10-29
- **Amends:** decision 129

## Decision

A shared-mode batch's cut records where it found the builder's checkout, read under the same lock as the
switch: `batches.return_branch` (the branch HEAD named, or null when HEAD was detached) and
`batches.return_sha` (HEAD's commit). `Git.switchNewBranch` answers that place. A worktree batch never sets
them: it never touches the main checkout.

When the batch is `SHIPPED`, `CLOSED` or `ABANDONED`, `delivery/checkout-return.ts` (`returnCheckout`), in the
project's queue right after the end is recorded, switches the checkout back through `Git.switchBack`:

- only while no lane runs in the project, HEAD still names the batch's branch and nothing in the checkout is
  uncommitted (the same private-index status as every other check), all read inside the checkout's lock;
- to the recorded branch at its current tip, or detached at the recorded commit, with `read-tree -m -u` and
  then `symbolic-ref HEAD` (or `update-ref --no-deref HEAD`), exactly as the cut moved it, so nothing from the
  checkout runs (decision 129);
- otherwise the checkout is left as it is. Uncommitted changes, a branch or commit that no longer exists, a
  running lane, or a git failure raise one card per batch (`checkout-return:<batch id>`) titled "Your checkout
  stays on `<branch>`: …" that says why and gives the `git -C <checkout> switch …` command. A checkout the
  builder already moved off the batch's branch raises no card: the builder did what the switch back would
  have, or chose otherwise.

Done or declined, the place is cleared, so it is tried once. A git refusal (a trust card) keeps it, and
startup recovery tries again. Recovery switches back every finished batch whose place is still set, after the
unfinished batches' branch checks, so a batch that ended just before the daemon stopped gets the same
treatment its end would have given.

Settings › General ("Where tasks work") and the batch sheet say the checkout goes back when the batch ends,
unless it has uncommitted changes or the builder moved it.

## Why

The builder's answer to the question "In Your folder mode 10db switches the checkout to the task's branch and
never switches it back. Should it switch back when a batch ends?": yes, with the recommended condition. Left
on a finished batch's branch, the next thing the builder types lands on a branch that already has a pull
request, and the editor and dev server keep showing work that has left.

The condition keeps the switch back from taking anything from the builder. Uncommitted changes would move
with `read-tree -m -u` or block it halfway, and are often the builder's own follow-up; a checkout on another
branch means the builder has moved on. Checking both inside the lock means a commit or a switch the builder
makes meanwhile is seen. Switching only while no lane runs keeps the invariant that the daemon switches
branches only then.

A card only when 10db left the checkout for a reason the builder can't see: the batch's visible state is
already final, and a card for a checkout the builder moved themselves would be noise. Clearing the place
once handled keeps a later restart from switching a checkout the builder has since put back on that branch on
purpose.

Rejected: switching back to the branch's commit at cut time (the branch may have moved since, and a
branch is what the builder was on); stashing uncommitted changes to switch anyway (10db never moves the
builder's uncommitted work); deleting a `CLOSED` batch's empty branch after the switch back, which worktree
mode does, left for a later decision.
