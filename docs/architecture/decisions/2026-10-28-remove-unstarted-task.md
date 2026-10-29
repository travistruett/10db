# A task that hasn't started is removed by cancelling it, and the Board no longer lists it

- **Date:** 2026-10-28

## Decision

- **Soft remove.** `POST /tasks/:taskId/remove` sets the task's `status` to the existing `cancelled`
  value and keeps its row, id and edges. No schema change and no migration. `listTasks` (so
  `GET /projects/:projectId/tasks`, the picker's candidates and the Board) leaves cancelled tasks out;
  `getTask` by id still answers them. A cancelled task can't be edited, moved or started.
- **Which tasks.** Only an `open` task that has no workstream at all, whether running, finished or cancelled. A task
  that has run goes through `POST /workstreams/:id/cancel`; the route refuses it with `TaskStartedError`
  (409), whose message names that workstream and route. A `done` task is refused with the same error.
  The message names the cancel route only when the workstream is still live; a run that already ended
  leaves the task unremovable, and the message says so. A task that an open task waits on is refused with `TaskHasDependentsError` (409) naming the dependents:
  a cancelled dependency is never `done`, so the dependents would wait for ever. Remove them first.
- **Claims and areas.** Claims belong to a workstream (`claims.workstream_id`), so a task with no
  workstream holds none. There is nothing to release, and a store test pins that. A task is in a batch
  only through a workstream. A pull-request start inserts its workstreams after the batch is cut, so
  removal is refused (409) while the project has a CUTTING batch. A fix task joining an open batch has
  no persisted marker, so removing it during that short window makes the join fail with its usual card.
  A removed task also leaves its parked column and can't be a new task's dependency.
- **Answer and event.** 200 with the cancelled `TaskDto`. One `task.changed` event with
  `data: { status: 'cancelled' }`, written with the row in one transaction. The Board refetches on
  `task.changed` and no longer finds the task. No new event type, so no protocol change.
- **Idempotent.** Removing a cancelled task answers 200 with the same task and emits nothing. An unknown
  id is 404; an id that isn't a task id is 400.

## Why

- A hard delete would orphan nothing today for an unstarted task, but tasks are referenced by proposals,
  dependency edges and events (`entity_id`), and the event log is append-only: a delete leaves events
  naming a task no row backs. `cancelled` already exists in `TaskStatus`, and the Board's card already
  renders a Cancelled badge.
- Hiding in `listTasks` keeps every Board reader working with no change: a dependent's `dependsOn`
  never names a removed task, because dependents block the removal.
- Idempotence suits a double click and a retry after a lost response; a second 409 would tell the
  builder nothing they need.
- Refusing a task with terminal workstreams (a failed or cancelled run) keeps the rule to "never
  started". Removing a failed task is a separate decision, as its run has history worth keeping.
