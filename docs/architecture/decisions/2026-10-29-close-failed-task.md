# A task whose run failed is closed with the same soft remove, and its branch and worktree stay

- **Date:** 2026-10-29
- **Amends:** decisions/2026-10-28-remove-unstarted-task.md

## Decision

- **Close.** `POST /tasks/:taskId/close` sets the task's `status` to `cancelled` and keeps its row, id and
  edges, exactly as Remove does (`retireTask` in `packages/db/src/store/tasks.ts` is the one write both end
  in). `listTasks`, so the Board and the picker, leaves it out; `getTask` by id still answers it. One
  `task.changed` event with `data: { status: 'cancelled' }`. No schema change, no migration, no new event.
- **Which tasks.** An `open` task whose latest workstream is `FAILED`. A task that never ran is still
  Remove's; a live, queued, waiting or cancelled run is refused with a 409 saying so (a live run is cancelled
  in Factory, a cancelled one can be started again). A `done` task is refused. Closing a closed task answers
  200 with the same task and emits nothing.
- **Dependents.** A task that open tasks wait on is refused with `TaskHasDependentsError` (409), whose
  message names the dependents and says "remove or close" them first, as Remove's does.
- **Workstreams are left alone.** The failed workstream stays `FAILED`, so Factory still lists it and its
  steps, and the failure reason stays on it. A failed run released its claims and lease when it failed, so
  there is nothing to release. `POST /workstreams/:id/retry` now refuses a run whose task was closed.
- **Branch and worktree.** Close touches neither. The batch the run belonged to stays in whatever state it
  was in, with its branch and worktree, and the builder ships, retries or abandons it as before. The Board
  says so in one line under Close, in the card menu and the drawer: "Close keeps the branch <branch> and its
  worktree as they are.", "Close keeps the branch <branch> as it is." in the shared checkout, and "Close
  leaves any branch or worktree the run made as it is." when there is no cut branch.
- **UI.** Close is in the card menu (after Retry, before Abandon) and, as "Close task", beside Retry in the
  drawer's state line, only for a task whose latest run is `FAILED`. A refusal shows in the Board's alert
  or under the drawer's buttons with the daemon's message.

## Why

- Remove refuses any task with a workstream, and the failed run has already ended, so there was nothing to
  cancel: "Edit a project's areas and hazards in Settings" sat in Blocked after its run failed and the
  feature was shipped by hand. The earlier decision named this as a separate decision.
- Reusing the soft remove keeps every Board reader working and keeps the append-only event log honest: no
  event names a task that has no row.
- Leaving the workstream and batch alone keeps the history that is the reason for keeping the row, and
  avoids Close deciding what happens to work on a branch, which only the builder can judge. Ending a batch
  stays Ship or Abandon.
- Failed only, not cancelled: a cancelled run's task goes back to Ready and can be started again, so it
  isn't stuck.
