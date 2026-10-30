# Where a task works is chosen per task, and the project's mode is only the default

- **Date:** 2026-10-29
- **Amends:** decisions/2026-10-27-worktree-mode-per-project.md (W1)

## Decision

A task works in Your folder (`shared`) or in a separate copy (`worktree`), and `tasks.workspace_mode` says which.
`projects.workspace_mode` becomes the default a new task takes, and it can change at any time. A separate copy
still needs `pull_request` delivery; in `local` delivery every task is `shared`.

A task is proposed a placement when it is made: a separate copy when one of its areas names an entry in the
project's `isolate` list or its risk tags include `migration` or `dependency`, otherwise the project default.
The stock `isolate` list is the hazards `migrations` and `deps`; other entries, such as `contracts`, are the
project's own. The builder can change a task's placement exactly when Start could start it: the task is open and
its latest workstream, if any, is not active.

A start partitions its tasks by placement and checks both parts before it writes either. A project holds one
unfinished shared batch and any number of worktree batches. The shared cut and the switch back count only the lanes working in the main checkout. The batch stays
the unit of delivery (W2): nothing about cut, ship, retry, abandon or recovery changes.

The design is `docs/superpowers/specs/2026-10-29-10db-task-placement-design.md`. It is designed, not built.

## Why

The builder works both ways inside one project: frontend tasks in their own checkout, where a dev server shows
every change as it is made, and backend tasks in separate copies. W1 gave three reasons for a per-project mode.
The shared cut refuses while any lane runs in the project, and would have to tell a shared lane from a copy's:
scoping that check to the main checkout answers it. One mode per project keeps each rule simple: the cost is now
a start that partitions and two kinds of batch in one project, and the rest of the delivery code already follows
the batch, not the project (`checkoutOf`, the launch rule, the watcher, claim scopes, ship, recovery and the
sweep); only `startBatch` and `jobKey` read the project's mode. A worktree without a pull request has no way to
land: that still holds, so a separate copy still needs `pull_request` delivery.

Rejected: two projects for one repository (they would share nothing: not the board, the dependencies or the
claims); choosing only at start (the builder could not see or change a task's placement while planning, and the
planner could not propose it).
