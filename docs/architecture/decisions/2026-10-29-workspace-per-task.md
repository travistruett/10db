# Where a task works is chosen per task, and the project's mode is only the default

- **Date:** 2026-10-29
- **Amends:** decisions/2026-10-27-worktree-mode-per-project.md (W1)

## Decision

A task works in Your folder (`shared`) or in a separate copy (`worktree`), and `tasks.workspace_mode` says which.
`projects.workspace_mode` becomes the default a new task takes, and it can change at any time. A separate copy
still needs `pull_request` delivery; in `local` delivery every task is `shared`.

A task is proposed a placement when it is made: a separate copy when one of its areas names an entry in the
project's `isolate` list or its risk tags include `migration` or `dependency`, otherwise the project default. The
builder can change it until the task has a workstream in progress.

A start partitions its tasks by placement. A project holds one unfinished shared batch and any number of worktree
batches. The shared cut and the switch back count only the lanes working in the main checkout. The batch stays
the unit of delivery (W2): nothing about cut, ship, retry, abandon or recovery changes.

The design is `docs/superpowers/specs/2026-10-29-10db-task-placement-design.md`. It is designed, not built.

## Why

The builder works both ways inside one project: frontend tasks in their own checkout, where a dev server shows
every change as it is made, and backend tasks in separate copies. W1's only reason for a per-project mode was that
the shared cut refuses while any lane runs in the project, which would have to tell a shared lane from a copy's.
Scoping that check to the main checkout answers it, and the rest of the delivery code already follows the batch,
not the project: `checkoutOf`, the launch rule, the watcher, claim scopes, ship, recovery and the sweep. Only
`startBatch` and `jobKey` read the project's mode.

Rejected: two projects for one repository (they would share nothing: not the board, the dependencies or the
claims); choosing only at start (the builder could not see or change a task's placement while planning, and the
planner could not propose it).
