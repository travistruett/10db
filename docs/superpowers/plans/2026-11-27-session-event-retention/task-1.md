# Task 1: prune session events nightly

Read the index's brief and Global Constraints first. Size: Core (deletes the builder's rows).

**Files:**
- `packages/db/src/store/events.ts` (the function; `store/index.ts` already re-exports this module).
- A new `packages/db/src/store/events.test.ts`.
- `apps/daemon/src/daemon/start.ts`: the constants; the call in the nightly run after `pruneBackups`; the abort at
  the top of `shutdown()`.
- `packages/db/AGENTS.md`: `events` is no longer immutable once written; finished sessions' two types are pruned.
- `docs/architecture/db-storage.md`: an entry for the retention rule (no migration).
- A new decision, `docs/architecture/decisions/2026-11-27-finished-sessions-lose-their-context-and-activity-events-after-14-days.md`,
  in the decisions README's format: the rule, why (85% of the event bytes, the readers checked), and the
  alternatives turned down (every type at 30 days; VACUUM).
- `apps/daemon/src/backups/AGENTS.md`: the nightly run then prunes session events; a copy keeps free pages.

**Implements**, exactly:

```ts
// packages/db/src/store/events.ts
/**
 * Deletes up to `limit` session.context and session.activity rows of sessions whose task was done or cancelled
 * before `cutoff` (ISO) and that ended before it or never ended; answers how many.
 */
export function deleteSessionEventsEndedBefore(ctx: WriteContext, cutoff: string, limit: number): number;

// apps/daemon/src/daemon/start.ts
const SESSION_EVENTS_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_EVENTS_PRUNE_BATCH = 2_000;
```

Shape: `DELETE FROM events WHERE seq IN (SELECT e.seq FROM sessions s JOIN workstreams w ON w.id = s.workstream_id
JOIN tasks t ON t.id = w.task_id JOIN events e ON e.entity_type = 'session' AND e.entity_id = s.id AND e.type IN (…)
WHERE t.status IN ('done','cancelled') AND t.updated_at < :cutoff AND (s.ended_at IS NULL OR s.ended_at < :cutoff)
AND e.at < :cutoff LIMIT :limit)`, with the joins written as `CROSS JOIN` from `tasks` (see Global Constraints).

**State-table rows** (all of them):

| Case | Result |
| --- | --- |
| Task done or cancelled before the cutoff, session ended before it | its two types deleted |
| The same session's other types (`session.started`, `session.ended`, …) | kept |
| Task open (waiting, paused, in review, reopened), any session age | kept |
| Task finished within the last 14 days | kept |
| Session ended after the cutoff, task finished before it | kept |
| Session never ended, task finished before the cutoff | deleted |
| Session of a conversation only (no workstream) | not matched; the runner writes neither type for it |
| More rows than one batch | loop until a batch returns fewer than the batch size |
| Daemon stops between batches | stop; resume the next night |
| Backup throws | nothing deleted |
| `turnLog` / `listTurnActivity` on a pruned turn | `[]` |
| `latestTurnActivity` | `undefined`; `activityOf` gives null, `turnFilesSoFar` gives `[]` |
| `listTaskToolCalls` | fewer calls. A done, pruned, reopened task put in a pass can now get a before picture where it was refused; benign, since its earlier PR closed unmerged and Codex runs are still caught by `codexStarts` |
| Task reopened after its rows were pruned | its earlier runs show empty logs while it is open |
| WebSocket replay `listEventsAfter` | skips the gaps; `seq` is AUTOINCREMENT and never reused |

**Wiring.** After `pruneBackups` in the nightly run:
- compute the cutoff once from `clock.now()`;
- loop: check the stop signal, then `state.write((ctx) => deleteSessionEventsEndedBefore(ctx, cutoff,
  SESSION_EVENTS_PRUNE_BATCH))`, while a batch returns the full batch, with `await new Promise(setImmediate)` between
  batches. The signal is checked before every write, the first included;
- log the total and the elapsed time, and log a failure with `logger.warn` as its own message;
- the stop signal is an AbortController aborted at the top of `shutdown()`.

Time one batch on a temp copy of a database of about 350,000 events. Copy the builder's file to a temp directory
with `sqlite3 ... ".backup"`, never touching the real one. If a batch takes more than 50 ms, halve the batch size.
Put the measured number in the PR, or say it is unverified.

**Test (one).** In `events.test.ts`, use `createTestStore` (a real temp file). All event rows except those marked
otherwise are older than the cutoff. Fixtures:
- (a) a done task finished before the cutoff, with:
  - a session that ended before the cutoff, holding both types plus a `session.ended` row;
  - a second session that ended after the cutoff (kept);
  - a third that never ended (its two types deleted).
- (b) a cancelled task finished before the cutoff, with an old ended session (deleted).
- (c) an open task with an equally old session (kept).
- (d) a done task finished within the 14 days whose session ended before the cutoff, as a task that sat in review
  would (kept).
- (e) on task (a)'s first session, one `session.activity` row newer than the cutoff (kept, by `e.at < :cutoff`).

Run the delete with limit 1 in a loop until it returns 0. Assert that exactly the expected rows are gone and every
other row remains. Show it fails first for each of three mutations: the task-status condition dropped, the
`t.updated_at` condition dropped, and the `e.at` condition dropped. Value card:
`Value: protects=retention deletes only finished sessions' context/activity rows older than 14 days;
fails_when=the delete matches an open or recent task's session, a young event, or another event type;
why_new=data loss (deletes the builder's rows); no_claim=batch timing or nightly wiring`.

**Spec:** none. The index's Brief holds the approved rule.
