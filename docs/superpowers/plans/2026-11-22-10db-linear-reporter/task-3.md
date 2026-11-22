# Card 3: events become rows; the drop rules

**Spec:** "Reporter" › "When"; "States" (the first, the drop and the task rows).
**Track:** A, after card 1.

## Files

- `apps/daemon/src/linear/reporter-events.ts` (new): `subscribeLinearEvents` and `attemptOf`, quoted in the index.
  The listener is synchronous and writes in one `state.write`, then calls `reporter.poke(taskId)`. Copy the shape
  of `delivery/trigger.ts`.
- A task is reported only when all of these hold. Put the check in one function that cards 4 and 6 reuse
  (`reporterBlockedBy(db, projectId, taskId?) => string | null`):
  - its `external` is a Linear link;
  - its project has a binding (`linear.<projectId>`);
  - `LinearReporterSettings.on` (key `linear-reporter.<projectId>`, absent = on);
  - `trustSwitchesFor(db, projectId, …).yourMcpServers`.

  The reason it returns is the Settings row's line.
- The events, each with its dedupe key (`<kind>:<id>`) and its `detail`:
  - **RunStarted:** `workstream.changed` from QUEUED to STARTING. Key `run_started:<workstreamId>`. Detail
    `{ workstreamId }`.
  - **Waiting:** `inbox.opened` whose item's targets name a workstream of a linked task (`targetTaskIds`). Key
    `waiting:<inboxItemId>`. Detail `{ workstreamId, title, kind }`.
  - **Verdict:** `step.changed` with a non-null `verdict`. Key `verdict:<workstreamId>:<stepIndex>:<at>`, where
    `at` is the step result's `at`. Detail `{ workstreamId, stepIndex, role, verdict }`.
  - **Ended:** `workstream.changed` to DONE, FAILED or CANCELLED. Key `ended:<workstreamId>`. Detail
    `{ workstreamId, to, failureKind, reason }`.
  - **PrOpened:** `batch.updated` to SHIPPED. One row per linked task of the batch (`listWorkstreams(db,
    { batchId })`). Key `pr_opened:<batchId>`. Detail `{ workstreamId, prUrl }`.
  - **PrMerged:** `batch.updated` whose `changed` includes `pr` and whose `getBatch(...).pr?.state` is merged. Key
    `pr_merged:<batchId>`. Detail `{ workstreamId, prUrl }`.
- Due time: `now + REPORT_DELAY_MS`. If the task already has a pending row due later (it is on backoff), use that
  later time, so a new event doesn't cut a backoff short.
- Drops:
  - `task.changed` with status cancelled → `dropPendingLinearPosts({ taskId })`;
  - `LinearBindings.unlink` → `dropPendingLinearPosts({ projectId })`, called from `linear/bindings.ts` (a setting
    write emits no event, so do it in the unlink itself).
  - Reporter off and trust off are dropped by card 4 at pickup and by card 6's PUT.
- Wire it in `daemon/start.ts` beside `subscribeShipTrigger`, and unsubscribe at stop.

## Interfaces

Calls `enqueueLinearPost` and `dropPendingLinearPosts` (card 1), `LinearReporter.poke` (card 4; until card 4
lands, pass a no-op `poke`).

## State-table rows

- idle / an event on a linked task, reporter on → pending.
- idle / unlinked, unbound, reporter off, trust off → nothing.
- idle / the same event again → nothing.
- failed / a later event → a new row at tries 0. That is the default: a new key means a new row.
- any / task cancelled → pending dropped.
- any / binding removed → pending dropped.

## Tests

Extend card 1's file with one case on a real store and the real bus, core (the queue's inputs). A run's events
(STARTING, a verdict, DONE) on a linked task write three rows, and the same STARTING event again writes none. An
unlinked task's events write none. No test per event kind.

## Done when

The checks in Global Constraints pass.
