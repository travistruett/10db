# Card 3: events become rows; the drop rules

**Spec:** "Reporter" › "When"; "States" (the first, the drop and the task rows).
**Track:** A, after card 1.

## Files

- `apps/daemon/src/linear/reporter-events.ts` (new): `subscribeLinearEvents`, `linearRowOf`, `attemptOf` and
  `reporterBlockedBy`, quoted in the index.
  - The listener is synchronous. It writes in one `state.write`, then calls `reporter.poke(taskId)`. Copy the
    shape of `delivery/trigger.ts`.
  - `linearRowOf(event, read)` is pure. It maps one event, plus what was read from the rows, to zero or more
    `{ taskId, event, dedupeKey, detail, workstreamId }`. The listener does the reads and the write.
- `reporterBlockedBy(db, projectId)` returns a reason string or null. Cards 4 and 6 reuse it. The project reports
  only when all of these hold:
  - it has a binding (`linear.<projectId>`);
  - `LinearReporterSettings.on` (key `linear-reporter.<projectId>`; card 1's read rule: absent is off, and a link
    made by `link_linear_team` writes `{ on: true, note: '' }`);
  - `trustSwitchesFor(db, projectId, …).yourMcpServers`.

  The task reports only if its `external` is a Linear link. The reason is the Settings row's line.
- **The events.** Each carries a dedupe key and a `detail`. Read what the event doesn't carry from the rows: the
  workstream's `failureKind`, and the Inbox item's targets and title.
  - **RunStarted:** `workstream.changed` to STARTING. Key `run_started:<workstreamId>:<ends>`, where `<ends>` is
    the number of Ended rows already written for that workstream. A re-entry after a rate-limit pause, a crash
    recovery or a gate send-back has no end between, so it dedupes. A builder's Retry of a FAILED run comes after
    an end, so it posts. Detail `{ workstreamId, from, reason }`.
  - **Waiting:** `inbox.opened` whose item's targets name a workstream of a linked task (`targetTaskIds`). Key
    `waiting:<inboxItemId>`. Detail `{ workstreamId, title, kind }`.
  - **Verdict:** `step.changed` with a non-null `verdict`. Key `verdict:<workstreamId>:<stepIndex>:<at>`, where
    `at` is the step result's `at`. Detail `{ workstreamId, stepIndex, role, verdict }`.
  - **Ended:** `workstream.changed` to DONE, FAILED or CANCELLED. Key `ended:<workstreamId>:<ends>`, with the same
    count, so DONE after a Retry of a FAILED run posts. Detail `{ workstreamId, to, failureKind, reason }`.
  - **PrOpened:** `batch.updated` to SHIPPED. One row per linked task whose workstream is in the batch
    (`listWorkstreams(db, { batchId })`). Key `pr_opened:<batchId>`. Detail `{ workstreamId, prUrl }`.
  - **PrMerged:** `batch.updated` whose `changed` includes `pr` and whose `getBatch(...).pr?.state` is merged.
    Key `pr_merged:<batchId>`. Detail `{ workstreamId, prUrl }`.
- **Attempt:** `attemptOf(db, workstreamId)` is the workstream's position among the task's workstreams by
  creation, from 1. A Retry reuses its workstream, so it keeps that attempt number.
- **Due time:** `now + REPORT_DELAY_MS`. If the task already has a pending row due later (it is on backoff), use
  that later time, so a new event doesn't cut a backoff short.
- **Drops:** `LinearBindings.unlink` calls `dropPendingLinearPosts({ projectId })` in `linear/bindings.ts` (a
  setting write emits no event, so it is done in the unlink itself), and `submit` writes the reporter settings
  `{ on: true, note: <kept note> }` on a link. A task cancel drops nothing: its CANCELLED end is reported like
  any other. Reporter off and trust off are dropped by card 4 at pickup and by card 6's PUT.
- Wire it in `daemon/start.ts` beside `subscribeShipTrigger`, and unsubscribe at stop.

## Interfaces

Calls `enqueueLinearPost` and `dropPendingLinearPosts` (card 1), and `LinearReporter.poke` (card 4; until card 4
lands, pass a no-op `poke`).

## State-table rows

- idle / an event on a linked task, reporter on → pending.
- idle / unlinked, unbound, reporter off, trust off → nothing.
- idle / the same event again → nothing.
- failed / a later event → a new row at tries 0. That is the default: a new key means a new row.
- any / binding removed → pending dropped.

## Tests

One pure table test of `linearRowOf`, the rule that decides which event is a row and under which key. Each row is
one event, and an extra event read in place of the db. Cases:
- STARTING with no end yet → `run_started:<ws>:0`;
- STARTING again after a pause, with no end between → the same key, so no new row;
- FAILED, then STARTING and DONE on the same workstream (a Retry) → `ended:<ws>:0`, `run_started:<ws>:1` and
  `ended:<ws>:1`;
- a `step.changed` with `verdict: null` → nothing;
- `batch.updated { changed: ['pr'] }` with the PR open → nothing; with it merged → `pr_merged`.

## Done when

The checks in Global Constraints pass.
