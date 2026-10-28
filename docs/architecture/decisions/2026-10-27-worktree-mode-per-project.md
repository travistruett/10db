# Worktree mode is a per-project choice, and a batch stays the delivery unit

- **Date:** 2026-10-27
- **Amends:** decision 13 (its "worktrees come later, per task"), and decision 122 for worktree-mode projects

## Decision

`projects.workspace_mode` is `shared` (the default) or `worktree`. `worktree` requires `pull_request`
delivery, and the mode changes only while the project has no unfinished batch. `tasks.workspace_mode` stays
unused.

In worktree mode a `batches` row is one task, or one dependency-linked group of tasks, in one worktree on one
branch with one pull request. The partial unique index `batches_one_unfinished` covers batches without a
`worktree_path` only, so a project holds one unfinished shared batch or any number of worktree batches.

A start of several tasks makes one batch per task. Tasks of the set linked by a dependency, directly or through
others in the set, share one batch, titled after the first task of the set (in the set's order) that has no
dependency inside it. A task start always makes a new batch; only a fix task, sent with `batchId`, joins an
`OPEN` or `FAILED` batch. The sheet therefore always offers a new start in a worktree-mode project, which
amends 122's rule that the sheet joins the current batch.

## Why

A per-task mode would let a shared batch and worktrees live in one project, and the shared cut's "no lane runs
in the project" check would have to tell them apart. One mode per project keeps each rule simple. A worktree
without a pull request has no way to land. The `batches` row already carries cut, ship, Retry, Abandon,
recovery, cards and the strip, so a worktree batch reuses all of them and only "where the checkout is"
changes. A dependent task can't start until its dependency is on the base branch, so a chain starts together
and ships as one pull request instead of being refused. Rejected: a mode per task, and a separate table for
worktrees.
