# Task 1: prune session events nightly

Read the index's brief and Global Constraints first. Size: Core (deletes the builder's rows).

**Files:**
- `packages/db/src/store/events.ts` (the function; `store/index.ts` already re-exports this module).
- A new `packages/db/src/store/events.test.ts`.
- `apps/daemon/src/daemon/start.ts`: the constants, and the call in the nightly run after `pruneBackups`.
- `docs/architecture/db-storage.md`, if it exists: an entry for the retention rule (no migration).
- `apps/daemon/src/backups/AGENTS.md`: the nightly run then prunes session events, and a copy keeps free pages.

**Implements** (from the index's Interfaces, exactly): `deleteSessionEventsEndedBefore`,
`SESSION_EVENTS_RETENTION_MS` and `SESSION_EVENTS_PRUNE_BATCH`.

**Wiring.** After `pruneBackups` in the nightly run:
- compute the cutoff once from `clock.now()`;
- loop `state.write((ctx) => deleteSessionEventsEndedBefore(ctx, cutoff, SESSION_EVENTS_PRUNE_BATCH))` while a batch
  returns the full batch and the stop signal isn't set, with `await new Promise(setImmediate)` between batches;
- log the total and the elapsed time, and log a failure with `logger.warn`;
- the stop signal is an AbortController that `stop()` aborts beside `nightly.cancel()`, as `systemTempAbort` does.

If one batch on a copy of about 350,000 rows takes more than 50 ms, halve the batch size. Time it with a temp copy
of the builder's database only if that's cheap. Never write to the real one.

**State-table rows:** all of them.

**Test (one).** In `events.test.ts`, use `createTestStore` (a real temp file) with:
- a done task finished before the cutoff, with a session that ended before it, holding both types plus a
  `session.ended` row;
- an open task with an equally old session;
- a done task finished within the 14 days.

Run the delete with limit 1 in a loop. Assert that only the first session's two types are gone and every other row
remains. Show that it fails first, for example with the task-status condition dropped. Value card:
`Value: protects=retention deletes only finished sessions' context/activity rows; fails_when=the delete matches an
open task's session or another event type; why_new=data loss (deletes the builder's rows); no_claim=batch timing or
nightly wiring`.

**Spec:** none. The index's Brief holds the approved rule.
