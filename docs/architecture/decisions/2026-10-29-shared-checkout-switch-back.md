# In Your folder mode, 10db switches the checkout back when a batch ends, only when it is clean and still on the batch's branch

- **Date:** 2026-10-29
- **Amends:** decision 129, and the batch delivery spec's rule that a `SHIPPED` batch's checkout stays on the
  branch until the next batch cuts (`docs/superpowers/specs/2026-10-21-10db-batch-delivery-design.md` §4)

## Decision

A shared-mode batch's cut records where it found the builder's checkout, read under the same lock as the
switch: `batches.return_branch` (the branch HEAD named, or null when HEAD was detached) and
`batches.return_sha` (HEAD's commit). `Git.switchNewBranch` answers that place. A worktree batch never sets
them: it never touches the main checkout.

When the batch is `SHIPPED`, `CLOSED` or `ABANDONED`, `delivery/checkout-return.ts` (`returnCheckout`), in the
project's queue right after the end is recorded, switches the checkout back through `Git.switchBack`. It does so
only when all of these hold, the git ones read inside the checkout's lock:

- no workstream in the project has work in hand, counted as Abandon counts it (a lane state, `TAKEN_OVER`, or
  `WAITING_HUMAN` with a live session);
- HEAD still names the batch's branch;
- nothing in the checkout is uncommitted: the files match HEAD (the same private-index status as every other
  check) and so does the checkout's own index (`diff-index --cached HEAD`, read-only). An index that differs
  from HEAD counts as uncommitted whatever made it: staged work the files no longer show, or the entries a
  daemon commit leaves behind when another git held `index.lock`, which `git status` shows too;
- the branch or commit to go back to still exists;
- for a branch, no other worktree has it checked out (`worktree list`) or is rebasing or bisecting it
  (`rebase-merge/head-name`, `rebase-apply/head-name` or `BISECT_START` in that worktree's git dir, since such
  a worktree shows as detached), because `symbolic-ref` skips the check `git switch` makes;
- nothing git doesn't track lies where the switch writes: the same check `mergeIntoBranch` makes
  (`untrackedInTheWay`) over the paths `diff-tree` names between the two commits, read after the stat refresh.
  `read-tree -m -u` treats ignored files as disposable and would overwrite or delete them.

The switch refreshes the index's stat data (`update-index -q --ignore-submodules --refresh`, as
`mergeIntoBranch` does), then runs `read-tree -m -u` and `symbolic-ref HEAD` (or `update-ref --no-deref HEAD` for
a commit), exactly as the cut moved it, so nothing from the checkout runs (decision 129). If HEAD can't be moved
after the files were, `read-tree -m -u` puts the batch's files back and the switch back fails; if that fails
too, the card says the checkout may be half switched.

Otherwise the checkout is left as it is. Every reason but one raises one card per batch
(`checkout-return:<batch id>`) titled "Your checkout stays on `<branch>`: …" that says why and, where git would
accept it, gives the switch command, quoted for pasting the way the other git cards quote theirs. A git refusal
gets this card too, beside its own trust card. The one exception: a checkout the builder already moved off the
batch's branch raises no card and is only logged, because the builder moved it on purpose.

Done or declined, the place is cleared, so it is tried once. Startup recovery switches back every finished
batch whose place is still set, newest first, so a batch cut while the checkout was on an earlier one's
branch goes back there before the earlier one goes back to where it started. A batch that ended just before
the daemon stopped gets the same treatment its end would have given.

Settings › General ("Where tasks work") and the batch sheet say the checkout goes back when the batch ends,
unless it has uncommitted changes or the builder moved it.

## Why

The builder's answer to the question "In Your folder mode 10db switches the checkout to the task's branch and
never switches it back. Should it switch back when a batch ends?": yes, with the recommended condition. Left
on a finished batch's branch, the next thing the builder types lands on a branch that already has a pull
request, and the editor and dev server keep showing work that has left.

The conditions keep the switch back from taking anything from the builder. Uncommitted changes would move
with `read-tree -m -u` or block it halfway, and are often the builder's own follow-up; ignored files such as a
hand-made config would be overwritten without a word; a branch checked out in a second worktree would end up
checked out twice. A checkout on another branch means the builder has moved on. Checking inside the lock means
a commit or a switch the builder makes meanwhile is seen. Switching only while no work runs keeps the
invariant that the daemon switches branches only then.

A card when 10db left the checkout for a reason the builder can't see; none when the builder moved it, since
that card would be noise. Clearing the place once handled, a git refusal included, keeps a later restart from
moving a checkout days after the batch ended, when the builder may be back on that branch on purpose.

Rejected: switching back to the branch's commit at cut time (the branch may have moved since, and a branch is
what the builder was on); stashing uncommitted changes to switch anyway (10db never moves the builder's
uncommitted work); rebuilding the index from HEAD before the switch (it drops staged work the files no
longer show); keeping the place after a git refusal for the next start to retry; deleting a `CLOSED` batch's empty
branch after the switch back, which worktree mode does, left for a later decision.
