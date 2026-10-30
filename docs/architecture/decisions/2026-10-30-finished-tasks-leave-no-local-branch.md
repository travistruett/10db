# A finished task's local branch is deleted when its pull request merges, and offered for deletion when it does not

- **Date:** 2026-10-30
- **Amends:** decisions/2026-10-29-pull-request-watch.md, decisions/2026-10-27-worktree-removal-and-sweep.md

## Decision

- **What 10db may delete.** Only a local branch whose name starts with `10db/` and which a batch row names
  (`removeBranch` in `apps/daemon/src/delivery/branch-cleanup.ts` is the one place a branch is deleted). Never
  a branch checked out in the main checkout or in any worktree (`git worktree list`), whatever the builder
  answered. The delete names the tip it read (`update-ref -d <ref> <sha>`), so a branch that moved in between
  stays.
- **Merged.** After every pull request watch round (also one that read nothing, and the first, at startup),
  `removeMergedBranches` looks at each pull request project's shipped batches whose recorded pull request is
  `merged` and which still have their local branch. For each it asks gh for the pull request's head commit
  (`headRefOid`, now part of `Gh.prStatus` as `headSha`) and deletes the branch only when its tip is that
  commit or an ancestor of it. A branch with a commit the pull request never carried, a checked-out branch, a
  head gh doesn't give and a gh failure all leave it for the next round (two minutes). That is the five
  minutes the builder was promised; no new schema.
- **Closed without merging.** The existing `pr-closed:<batch>` card offers Delete Branch and Keep. The branch
  stays until the builder answers; Keep leaves it and the card is not raised again, because the card is raised
  on the transition to closed only.
- **Abandoned.** When the worktree is gone (or, in the shared checkout, after the checkout is switched back),
  `settleBranch` deletes the branch if it is still at the commit it was cut from, as it already did for a
  closed batch. Otherwise it raises one card, `branch-offer:<batch>`, titled "Delete <branch>? It holds N
  commits", with Delete Branch and Keep. A closed batch whose branch moved is kept without a card, as before.
- **Answering.** Delete Branch queues the deletion in the project's ship queue and the card closes. A branch
  git won't delete because it is checked out raises a new `branch-offer:<batch>` card saying where, with the
  same two answers. The answer deletes whatever the branch holds: the card said so.
- **Startup.** `recoverBatches` lists in one card per project (`branches-without-batch`) every local `10db/`
  branch no batch row names, and withdraws it once none is left. Nothing records that 10db made those, so it
  deletes none of them. A crash during a cut can leave one.

## Why

- GitHub deletes the remote branch on merge, so the local one was the only thing left of every shipped task,
  and an abandoned task's branch with commits stayed without a word.
- A squash merge leaves the branch's commits outside the base, so "merged into the base" can't be checked
  with git. The pull request's head commit is what GitHub merged; comparing the tip with it is exact, and
  needs no new column, because the sweep asks gh again for the few merged batches that still have a branch.
- A deletion the builder didn't ask for must not lose work: a moved branch, a checked-out branch and a
  foreign name are all refused in one function, so no caller can forget a check.
- The unnamed branches are listed, not deleted: a name under `10db/` is not proof 10db made the branch.
